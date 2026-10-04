package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// Receipts recorded from BSC mainnet (2026-10-04), identical from two providers: a plain USDC transfer and a
// failed transaction. No network in tests: each fake rpc answers from these.
const (
	usdcTx   = "0x4e61adfff4ba89e29f081d5e5aba4865e58073a2ec7cf4b35d805707808bc286"
	failedTx = "0xb2c7f94aa42dea1c19bfa720f31622fb304f73e9a62ced18afe98326aab30b0a"
	usdcAt   = 125522251 // usdcTx's block
)

type fakeRPC struct {
	chainID  string
	head     uint64
	receipts map[string]string // tx → receipt JSON
	balance  string
	down     bool // answers HTTP 503, like a provider having an outage
	mu       sync.Mutex
	methods  []string
	callTags []string // the block tag of each eth_call
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/bsc/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func newFakeRPC(t *testing.T, head uint64) *fakeRPC {
	return &fakeRPC{chainID: "0x38", head: head, balance: "0x" + strings.Repeat("0", 63) + "5",
		receipts: map[string]string{usdcTx: fixture(t, "receipt-usdc-transfer"), failedTx: fixture(t, "receipt-failed")}}
}

func (f *fakeRPC) serve(t *testing.T) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.methods = append(f.methods, req.Method)
		f.mu.Unlock()
		if f.down {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		result := "null"
		switch req.Method {
		case "eth_chainId":
			result = strconv.Quote(f.chainID)
		case "eth_blockNumber":
			result = strconv.Quote("0x" + strconv.FormatUint(f.head, 16))
		case "eth_getTransactionReceipt":
			var tx string
			_ = json.Unmarshal(req.Params[0], &tx)
			if rc, ok := f.receipts[tx]; ok {
				result = rc
			}
		case "eth_getLogs": // the logs of the known receipts that match the filter (address, recipient, blocks)
			var q struct {
				Address   string    `json:"address"`
				FromBlock string    `json:"fromBlock"`
				ToBlock   string    `json:"toBlock"`
				Topics    []*string `json:"topics"`
			}
			_ = json.Unmarshal(req.Params[0], &q)
			lo, _ := hexUint(q.FromBlock)
			hi, _ := hexUint(q.ToBlock)
			var out []json.RawMessage
			for _, rc := range f.receipts {
				var r struct{ Logs []json.RawMessage }
				_ = json.Unmarshal([]byte(rc), &r)
				for _, raw := range r.Logs {
					var l rpcLog
					_ = json.Unmarshal(raw, &l)
					lower(&l)
					b, _ := hexUint(l.BlockNumber)
					if l.Address == q.Address && len(l.Topics) == 3 && len(q.Topics) == 3 && q.Topics[2] != nil &&
						l.Topics[2] == *q.Topics[2] && b >= lo && b <= hi {
						out = append(out, raw)
					}
				}
			}
			if out == nil {
				out = []json.RawMessage{}
			}
			b, _ := json.Marshal(out)
			result = string(b)
		case "eth_call":
			var tag string
			_ = json.Unmarshal(req.Params[1], &tag)
			f.mu.Lock()
			f.callTags = append(f.callTags, tag)
			f.mu.Unlock()
			result = strconv.Quote(f.balance)
		}
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":` + result + `}`))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func twoRPCs(t *testing.T, a, b *fakeRPC) *bsc { return newBSC(a.serve(t), b.serve(t)) }

func TestBSCReadsAUSDCTransfer(t *testing.T) {
	ctx := context.Background()
	c := twoRPCs(t, newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+25))
	got, err := c.Transfers(ctx, usdcTx, game.payments.Topup.Tokens["USDC"])
	if err != nil || len(got) != 1 {
		t.Fatalf("transfers %v %v", got, err)
	}
	tr := got[0]
	if tr.From != "0x11713482f2fb3f5d17e33969bc402339e41abe36" || tr.To != "0x8ec07697ea678ed029787f7d01dcccc3a0b07f9b" ||
		tr.Amount.String() != "906764245532653653482" || tr.LogIndex != 24 {
		t.Fatalf("decoded %+v", tr)
	}
	// The cautious head (the lower one) counts: usdcAt+20 → 21 confirmations.
	if n, err := c.Confirmations(ctx, usdcTx); err != nil || n != 21 {
		t.Fatalf("confirmations %d %v", n, err)
	}
	if r, err := c.Final(ctx, usdcTx); err != nil || !r.OK || r.Block != usdcAt {
		t.Fatalf("final %+v %v", r, err)
	}
	// The same transaction holds no USDT transfer.
	if got, err := c.Transfers(ctx, usdcTx, game.payments.Topup.Tokens["USDT"]); err != nil || len(got) != 0 {
		t.Fatalf("usdt %v %v", got, err)
	}
}

func TestBSCFailedTransaction(t *testing.T) {
	ctx := context.Background()
	c := twoRPCs(t, newFakeRPC(t, usdcAt+100), newFakeRPC(t, usdcAt+100))
	if _, err := c.Final(ctx, failedTx); !errors.Is(err, errTxFailed) {
		t.Fatalf("final %v", err)
	}
	if _, err := c.Transfers(ctx, failedTx, game.payments.Topup.Tokens["USDC"]); !errors.Is(err, errTxFailed) {
		t.Fatalf("transfers %v", err)
	}
}

func TestBSCRPCsDisagree(t *testing.T) {
	ctx := context.Background()
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	// The second provider reports a different amount (a lying or broken node): nothing is returned.
	b.receipts[usdcTx] = strings.Replace(b.receipts[usdcTx], "0x00000000000000000000000000000000000000000000003127e1bd11aee80dea",
		"0x00000000000000000000000000000000000000000000006127e1bd11aee80dea", 1)
	if b.receipts[usdcTx] == a.receipts[usdcTx] {
		t.Fatal("fixture amount not found")
	}
	c := twoRPCs(t, a, b)
	if _, err := c.Transfers(ctx, usdcTx, game.payments.Topup.Tokens["USDC"]); !errors.Is(err, errMismatch) {
		t.Fatalf("transfers %v", err)
	}
	if _, err := c.Final(ctx, usdcTx); !errors.Is(err, errMismatch) {
		t.Fatalf("final %v", err)
	}
	// One provider can't find it, the other can: still no answer.
	delete(b.receipts, usdcTx)
	if _, err := c.Receipt(ctx, usdcTx); !errors.Is(err, errMismatch) {
		t.Fatalf("half found %v", err)
	}
}

func TestBSCTooFewConfirmations(t *testing.T) {
	ctx := context.Background()
	need := game.payments.Confirmations
	c := twoRPCs(t, newFakeRPC(t, usdcAt+need-2), newFakeRPC(t, usdcAt+50))
	if n, _ := c.Confirmations(ctx, usdcTx); n != need-1 {
		t.Fatalf("confirmations %d, want %d", n, need-1)
	}
	if _, err := c.Final(ctx, usdcTx); !errors.Is(err, errUnconfirmed) {
		t.Fatalf("final %v", err)
	}
	// Both heads behind the receipt's block (a node that hasn't caught up): 0, not an underflow.
	if n, err := twoRPCs(t, newFakeRPC(t, usdcAt-1), newFakeRPC(t, usdcAt-1)).Confirmations(ctx, usdcTx); err != nil || n != 0 {
		t.Fatalf("behind %d %v", n, err)
	}
}

func TestBSCOnlyChain56(t *testing.T) {
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	b.chainID = "0x1" // Ethereum
	if _, err := twoRPCs(t, a, b).Receipt(context.Background(), usdcTx); !errors.Is(err, errChain) {
		t.Fatalf("receipt %v", err)
	}
}

func TestBSCOnlyLockedTokens(t *testing.T) {
	ctx := context.Background()
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	c := twoRPCs(t, a, b)
	other := "0x0000000000000000000000000000000000000001"
	if _, err := c.Transfers(ctx, usdcTx, other); !errors.Is(err, errNotLocked) {
		t.Fatalf("transfers %v", err)
	}
	if _, err := c.BalanceOf(ctx, other, game.payments.AgenticWallet); !errors.Is(err, errNotLocked) {
		t.Fatalf("balance %v", err)
	}
	if len(a.methods)+len(b.methods) != 0 {
		t.Fatalf("an unlocked token still reached the rpcs: %v %v", a.methods, b.methods)
	}
	// Locked: the whitelisted bStock, in any letter case.
	if !lockedToken("0x" + strings.ToUpper(game.payments.Tokens["tsla"].Contract[2:])) {
		t.Fatal("the TSLAB contract is not locked")
	}
}

func TestBSCBalanceOfAtTheSameBlock(t *testing.T) {
	ctx := context.Background()
	a, b := newFakeRPC(t, 1000), newFakeRPC(t, 1003)
	c := twoRPCs(t, a, b)
	v, err := c.BalanceOf(ctx, game.payments.Topup.Tokens["USDC"], game.payments.AgenticWallet)
	if err != nil || v.Int64() != 5 {
		t.Fatalf("balance %v %v", v, err)
	}
	if a.callTags[0] != "0x3e8" || b.callTags[0] != "0x3e8" { // block 1000, the lower head
		t.Fatalf("block tags %v %v", a.callTags, b.callTags)
	}
	b.balance = "0x" + strings.Repeat("0", 63) + "6"
	if _, err := c.BalanceOf(ctx, game.payments.Topup.Tokens["USDC"], game.payments.AgenticWallet); !errors.Is(err, errMismatch) {
		t.Fatalf("mismatch %v", err)
	}
	if _, err := c.BalanceOf(ctx, game.payments.Topup.Tokens["USDC"], "not-an-address"); !errors.Is(err, errBad) {
		t.Fatalf("bad address %v", err)
	}
}

func TestBSCInputs(t *testing.T) {
	ctx := context.Background()
	c := twoRPCs(t, newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20))
	if _, err := c.Receipt(ctx, "0x123"); !errors.Is(err, errBad) {
		t.Fatalf("short hash %v", err)
	}
	unknown := "0x" + strings.Repeat("ab", 32)
	if _, err := c.Receipt(ctx, unknown); !errors.Is(err, errNoTx) {
		t.Fatalf("unknown tx %v", err)
	}
	if newBSC("http://one", "") != nil || newBSC("", "http://two") != nil || newBSC("http://one", "http://one") != nil {
		t.Fatal("one rpc alone must not be trusted")
	}
}

func TestBSCOneRPCDown(t *testing.T) {
	ctx := context.Background()
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	c := twoRPCs(t, a, b)
	b.down = true
	if _, err := c.Final(ctx, usdcTx); err == nil {
		t.Fatal("one provider down still gave an answer")
	}
	// The other says "not found" while this one is down: that is not a "no", the caller must retry.
	if _, err := c.Receipt(ctx, "0x"+strings.Repeat("cd", 32)); err == nil || errors.Is(err, errNoTx) {
		t.Fatalf("not found + down = %v", err)
	}
}

func TestBSCChainCheckedOncePerRPC(t *testing.T) {
	ctx := context.Background()
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	c := twoRPCs(t, a, b)
	for range 3 {
		if _, err := c.Final(ctx, usdcTx); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []*fakeRPC{a, b} {
		n := 0
		for _, m := range f.methods {
			if m == "eth_chainId" {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("eth_chainId asked %d times", n)
		}
	}
}

func TestBSCRejectsOddReceipts(t *testing.T) {
	ctx := context.Background()
	usdc := game.payments.Topup.Tokens["USDC"]
	odd := func(name, from, to string) *bsc {
		a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
		for _, f := range []*fakeRPC{a, b} { // both lie the same way
			f.receipts[usdcTx] = strings.ReplaceAll(f.receipts[usdcTx], from, to)
			if f.receipts[usdcTx] == fixture(t, "receipt-usdc-transfer") {
				t.Fatalf("%s: fixture text not found", name)
			}
		}
		return twoRPCs(t, a, b)
	}
	amount := "0x00000000000000000000000000000000000000000000003127e1bd11aee80dea"
	sender := "0x00000000000000000000000011713482f2fb3f5d17e33969bc402339e41abe36"
	for name, c := range map[string]*bsc{
		"negative amount": odd("negative amount", amount, "0x-0000000000000000000000000000000000000000000003127e1bd11aee80dea"),
		"no 0x on amount": odd("no 0x on amount", amount, "0000000000000000000000000000000000000000000003127e1bd11aee80deaff"),
		"dirty padding":   odd("dirty padding", sender, "0x00000000000000000000ff0011713482f2fb3f5d17e33969bc402339e41abe36"),
	} {
		if _, err := c.Transfers(ctx, usdcTx, usdc); err == nil || !strings.Contains(err.Error(), "malformed") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// Still pending (no block yet), or the receipt of another transaction: never an answer.
	pending := odd("pending", `"blockNumber": "0x77b514b"`, `"blockNumber": null`)
	if _, err := pending.Receipt(ctx, usdcTx); err == nil {
		t.Fatal("pending receipt accepted")
	}
	other := odd("other tx", `"transactionHash": "`+usdcTx, `"transactionHash": "`+failedTx)
	if _, err := other.Receipt(ctx, usdcTx); err == nil {
		t.Fatal("receipt of another tx accepted")
	}
}
