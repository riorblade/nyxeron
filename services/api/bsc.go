package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// BNB Smart Chain, read twice. The api never takes an amount, a sender or a recipient on anyone's word: it reads
// the chain itself through two independent RPC providers (BSC_RPC_1, BSC_RPC_2) and only answers when both say
// the same thing. Tokens are the contracts locked in payments.json, never looked up by name or symbol.
// Standard library only; JSON-RPC spec: https://ethereum.org/en/developers/docs/apis/json-rpc/

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" // Transfer(address,address,uint256)

var (
	errMismatch    = errors.New("bsc: the two rpcs disagree")
	errChain       = errors.New("bsc: rpc is not BNB Smart Chain")
	errNoTx        = errors.New("bsc: transaction not found")
	errTxFailed    = errors.New("bsc: transaction failed")
	errUnconfirmed = errors.New("bsc: not enough confirmations yet")
	errNotLocked   = errors.New("bsc: token is not locked in payments.json")
	// errUnreadable: an answer too big to read (over rpcMaxBytes) or not valid JSON. Returned by both() only when
	// both rpcs say so: then it is the transaction itself (e.g. a receipt padded with logs), not a provider that is
	// down, and asking again won't help.
	errUnreadable = errors.New("bsc: answer too big or malformed")
	// errRefused: both rpcs answered the request with a JSON-RPC error, or one with that and the other unreadable
	// (e.g. one block's logs: "response size exceeded" from one, over rpcMaxBytes from the other). Both are up and
	// answering, but that is not proof the question is the problem: providers throttle (-32005 "limit exceeded") and
	// time out upstream with the same kind of answer. Before moving past what got it, ask a question that can't be
	// too big (LogsServed, ReceiptsServed). Returned by both() only when both rpcs say so.
	errRefused = errors.New("bsc: both rpcs refused the request")
	// errNotServing: both rpcs refused a question that can't be too big either: they are throttling, timing out
	// upstream, or don't serve the method. Like a provider that is down: the scanner stops, it doesn't move on.
	errNotServing = errors.New("bsc: both rpcs refuse even a probe (throttled, timing out, or not serving the method)")

	hashRe  = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
	addrRe  = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	topicRe = regexp.MustCompile(`^0x0{24}[0-9a-fA-F]{40}$`) // an address, left-padded to 32 bytes
)

// Receipt: what both rpcs agree a transaction did (the block's hash too, so both saw the same chain).
type Receipt struct {
	Tx        string   `json:"tx"`
	OK        bool     `json:"ok"`
	Block     uint64   `json:"block"`
	BlockHash string   `json:"blockHash"`
	GasUsed   uint64   `json:"gasUsed"`
	Logs      []rpcLog `json:"logs"`
}

type rpcLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	LogIndex    string   `json:"logIndex"`
	TxHash      string   `json:"transactionHash"`
	BlockNumber string   `json:"blockNumber"`
	Removed     bool     `json:"removed"`
}

// Transfer: one decoded ERC-20 Transfer log. Addresses are lower-case; Amount is in the token's base units
// (every locked token, USDC, USDT and the bStocks, has 18 decimals).
type Transfer struct {
	Tx       string   `json:"tx"`
	Block    uint64   `json:"block"`
	Token    string   `json:"token"`
	From     string   `json:"from"`
	To       string   `json:"to"`
	Amount   *big.Int `json:"amount"`
	LogIndex uint64   `json:"logIndex"`
}

type bsc struct {
	rpcs   [2]string
	client *http.Client
	mu     sync.Mutex
	chain  [2]bool // eth_chainId checked once per rpc
}

// newBSC: nil unless two different rpcs are configured (one provider alone is never trusted).
func newBSC(rpc1, rpc2 string) *bsc {
	if rpc1 == "" || rpc2 == "" || rpc1 == rpc2 {
		return nil
	}
	return &bsc{rpcs: [2]string{rpc1, rpc2}, client: &http.Client{Timeout: 10 * time.Second}}
}

// lockedToken: a top-up token or a whitelisted bStock from payments.json, lower-case.
func lockedToken(addr string) bool {
	a := strings.ToLower(addr)
	for _, t := range game.payments.Topup.Tokens {
		if strings.ToLower(t) == a {
			return true
		}
	}
	for _, t := range game.payments.Tokens {
		if strings.ToLower(t.Contract) == a {
			return true
		}
	}
	return false
}

// Receipt reads a transaction's receipt from both rpcs.
func (b *bsc) Receipt(ctx context.Context, tx string) (Receipt, error) {
	if !hashRe.MatchString(tx) {
		return Receipt{}, errBad
	}
	tx = strings.ToLower(tx)
	return both(ctx, b, "eth_getTransactionReceipt", []any{tx}, func(raw json.RawMessage) (Receipt, error) {
		var r struct {
			TransactionHash string   `json:"transactionHash"`
			Status          string   `json:"status"`
			BlockNumber     string   `json:"blockNumber"`
			BlockHash       string   `json:"blockHash"`
			GasUsed         string   `json:"gasUsed"`
			Logs            []rpcLog `json:"logs"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return Receipt{}, fmt.Errorf("%w: %w", errUnreadable, err)
		}
		gas, _ := hexUint(r.GasUsed)
		if !strings.EqualFold(r.TransactionHash, tx) {
			return Receipt{}, fmt.Errorf("bsc: asked for %s, got the receipt of %s", tx, r.TransactionHash)
		}
		block, err := hexUint(r.BlockNumber)
		if err != nil {
			return Receipt{}, fmt.Errorf("bsc: receipt of %s has no block: %w", tx, err)
		}
		for i := range r.Logs {
			lower(&r.Logs[i])
		}
		return Receipt{Tx: strings.ToLower(r.TransactionHash), OK: r.Status == "0x1", Block: block,
			BlockHash: strings.ToLower(r.BlockHash), GasUsed: gas, Logs: r.Logs}, nil
	})
}

func lower(l *rpcLog) {
	l.Address, l.Data, l.TxHash = strings.ToLower(l.Address), strings.ToLower(l.Data), strings.ToLower(l.TxHash)
	for j := range l.Topics {
		l.Topics[j] = strings.ToLower(l.Topics[j])
	}
}

// Transfers: the token's Transfer logs in a successful transaction. The token must be locked in payments.json.
func (b *bsc) Transfers(ctx context.Context, tx, token string) ([]Transfer, error) {
	if !lockedToken(token) {
		return nil, errNotLocked
	}
	r, err := b.Receipt(ctx, tx)
	if err != nil {
		return nil, err
	}
	return transfersIn(r, token)
}

// transfersIn: the token's Transfer logs in a receipt both rpcs agreed on (a failed transaction moved nothing).
func transfersIn(r Receipt, token string) ([]Transfer, error) {
	if !r.OK {
		return nil, errTxFailed
	}
	out := []Transfer{}
	for _, l := range r.Logs {
		tr, ok, err := decodeTransfer(l, token)
		if err != nil {
			return nil, fmt.Errorf("bsc: malformed Transfer log in %s", r.Tx)
		}
		if ok {
			tr.Tx, tr.Block = r.Tx, r.Block
			out = append(out, tr)
		}
	}
	return out, nil
}

// decodeTransfer: the log as a Transfer of token (ok false: another token or event). Strict shapes only:
// 32-byte padded addresses, one unsigned 256-bit amount (no sign, no extra bytes).
func decodeTransfer(l rpcLog, token string) (Transfer, bool, error) {
	token = strings.ToLower(token)
	if l.Address != token || len(l.Topics) != 3 || l.Topics[0] != transferTopic {
		return Transfer{}, false, nil
	}
	if !topicRe.MatchString(l.Topics[1]) || !topicRe.MatchString(l.Topics[2]) || !hashRe.MatchString(l.Data) {
		return Transfer{}, false, errors.New("malformed")
	}
	amount, _ := new(big.Int).SetString(l.Data[2:], 16)
	idx, err := hexUint(l.LogIndex)
	if err != nil {
		return Transfer{}, false, err
	}
	return Transfer{Token: token, From: topicAddr(l.Topics[1]), To: topicAddr(l.Topics[2]), Amount: amount,
		LogIndex: idx}, true, nil
}

// TransfersTo: every Transfer of a locked token to addr in blocks [from, to], as both rpcs report them.
// What the top-up scanner reads to find transfers nobody reported.
func (b *bsc) TransfersTo(ctx context.Context, token, addr string, from, to uint64) ([]Transfer, error) {
	return b.transferLogs(ctx, token, addr, from, to, false)
}

// TransfersFrom: every Transfer of a locked token from addr in blocks [from, to], as both rpcs report them. One
// read per range, whatever the number of transfers or the size of their transactions' receipts.
func (b *bsc) TransfersFrom(ctx context.Context, token, addr string, from, to uint64) ([]Transfer, error) {
	return b.transferLogs(ctx, token, addr, from, to, true)
}

// transferLogs: eth_getLogs for a locked token's Transfers to addr (or from it, sent) in blocks [from, to].
func (b *bsc) transferLogs(ctx context.Context, token, addr string, from, to uint64, sent bool) ([]Transfer, error) {
	if !lockedToken(token) {
		return nil, errNotLocked
	}
	if !addrRe.MatchString(addr) || to < from {
		return nil, errBad
	}
	filter := map[string]any{"address": strings.ToLower(token),
		"fromBlock": "0x" + strconv.FormatUint(from, 16), "toBlock": "0x" + strconv.FormatUint(to, 16),
		"topics": []any{transferTopic, nil, "0x" + strings.Repeat("0", 24) + strings.ToLower(addr[2:])}}
	if sent {
		filter["topics"] = []any{transferTopic, "0x" + strings.Repeat("0", 24) + strings.ToLower(addr[2:])}
	}
	return both(ctx, b, "eth_getLogs", []any{filter}, func(raw json.RawMessage) ([]Transfer, error) {
		var logs []rpcLog
		if err := json.Unmarshal(raw, &logs); err != nil {
			return nil, err
		}
		out := []Transfer{}
		for _, l := range logs {
			lower(&l)
			if l.Removed {
				continue
			}
			tr, ok, err := decodeTransfer(l, token)
			block, berr := hexUint(l.BlockNumber)
			if err != nil || berr != nil || !hashRe.MatchString(l.TxHash) || block < from || block > to {
				return nil, fmt.Errorf("bsc: malformed log in blocks %d-%d", from, to)
			}
			if ok && (!sent && tr.To == strings.ToLower(addr) || sent && tr.From == strings.ToLower(addr)) {
				tr.Tx, tr.Block = l.TxHash, block
				out = append(out, tr)
			}
		}
		return out, nil
	})
}

// noLogs: an address no log can come from (no contract lives at the zero address): a filter on it matches nothing.
const noLogs = "0x0000000000000000000000000000000000000000"

// noTx: a hash no transaction has: its receipt is null on any working provider.
const noTx = "0x0000000000000000000000000000000000000000000000000000000000000000"

// LogsServed: both rpcs answer eth_getLogs over block with a filter that matches nothing (an answer that can't be
// too big). nil when they do; else errNotServing. Tells "this block's logs are too many" from "eth_getLogs is
// throttled or not served".
func (b *bsc) LogsServed(ctx context.Context, block uint64) error {
	n := "0x" + strconv.FormatUint(block, 16)
	_, err := both(ctx, b, "eth_getLogs", []any{map[string]any{"address": noLogs, "fromBlock": n, "toBlock": n}},
		func(raw json.RawMessage) (int, error) {
			var logs []json.RawMessage
			err := json.Unmarshal(raw, &logs)
			return len(logs), err
		})
	return served(err)
}

// ReceiptsServed: both rpcs answer eth_getTransactionReceipt for a hash no transaction has (null). nil when they do;
// else errNotServing. Tells "this receipt is too big or malformed" from "receipts are throttled or not served".
func (b *bsc) ReceiptsServed(ctx context.Context) error {
	_, err := b.Receipt(ctx, noTx)
	if errors.Is(err, errNoTx) {
		return nil
	}
	return served(err)
}

func served(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %s", errNotServing, strings.ReplaceAll(err.Error(), "\n", "; "))
}

// SafeHead: the newest block with payments.json's confirmations on both rpcs (0 when the chain is too short).
func (b *bsc) SafeHead(ctx context.Context) (uint64, error) {
	head, err := b.head(ctx)
	if err != nil || head < game.payments.Confirmations {
		return 0, err
	}
	return head - game.payments.Confirmations + 1, nil
}

// Confirmations: blocks since the transaction's, counted from the lower of the two rpcs' heads (they are rarely
// at the same height, so the cautious one wins). 0 while the transaction is not yet in a block either rpc sees.
func (b *bsc) Confirmations(ctx context.Context, tx string) (uint64, error) {
	r, err := b.Receipt(ctx, tx)
	if err != nil {
		return 0, err
	}
	return b.confirmations(ctx, r)
}

func (b *bsc) confirmations(ctx context.Context, r Receipt) (uint64, error) {
	head, err := b.head(ctx)
	if err != nil || head < r.Block {
		return 0, err
	}
	return head - r.Block + 1, nil
}

// Final: a successful transaction with at least payments.json's confirmations. What top-ups and restocks wait for.
func (b *bsc) Final(ctx context.Context, tx string) (Receipt, error) {
	r, err := b.Receipt(ctx, tx)
	if err != nil {
		return r, err
	}
	if !r.OK {
		return r, errTxFailed
	}
	n, err := b.confirmations(ctx, r)
	if err != nil {
		return r, err
	}
	if n < game.payments.Confirmations {
		return r, errUnconfirmed
	}
	return r, nil
}

// BalanceOf: a locked token's balance, read by both rpcs at the same block (the lower head).
func (b *bsc) BalanceOf(ctx context.Context, token, addr string) (*big.Int, error) {
	if !lockedToken(token) {
		return nil, errNotLocked
	}
	if !addrRe.MatchString(addr) {
		return nil, errBad
	}
	head, err := b.head(ctx)
	if err != nil {
		return nil, err
	}
	call := map[string]string{"to": strings.ToLower(token),
		"data": "0x70a08231" + strings.Repeat("0", 24) + strings.ToLower(addr[2:])} // balanceOf(address)
	return both(ctx, b, "eth_call", []any{call, "0x" + strconv.FormatUint(head, 16)}, func(raw json.RawMessage) (*big.Int, error) {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, err
		}
		v, ok := new(big.Int).SetString(strings.TrimPrefix(s, "0x"), 16)
		if !ok {
			return nil, fmt.Errorf("bsc: balanceOf answered %q", s)
		}
		return v, nil
	})
}

// head: the lower of the two rpcs' latest block numbers.
func (b *bsc) head(ctx context.Context) (uint64, error) {
	var h [2]uint64
	var errs [2]error
	var wg sync.WaitGroup
	for i := range b.rpcs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var s string
			if errs[i] = b.call(ctx, i, "eth_blockNumber", []any{}, &s); errs[i] == nil {
				h[i], errs[i] = hexUint(s)
			}
		}()
	}
	wg.Wait()
	if err := errors.Join(errs[0], errs[1]); err != nil {
		return 0, err
	}
	return min(h[0], h[1]), nil
}

// both asks the two rpcs the same question and returns the answer only when they agree (compared as JSON).
func both[T any](ctx context.Context, b *bsc, method string, params []any, parse func(json.RawMessage) (T, error)) (T, error) {
	var got [2]T
	var keys [2][]byte
	var errs [2]error
	var wg sync.WaitGroup
	for i := range b.rpcs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var raw json.RawMessage
			if errs[i] = b.call(ctx, i, method, params, &raw); errs[i] != nil {
				return
			}
			if len(raw) == 0 || string(raw) == "null" {
				errs[i] = errNoTx
				return
			}
			if got[i], errs[i] = parse(raw); errs[i] == nil {
				keys[i], errs[i] = json.Marshal(got[i])
			}
		}()
	}
	wg.Wait()
	var zero T
	// "Not found" only when BOTH rpcs say so; a provider that is down never turns into a "no".
	switch a, b := errors.Is(errs[0], errNoTx), errors.Is(errs[1], errNoTx); {
	case a && b:
		return zero, errNoTx
	case (a && errs[1] == nil) || (b && errs[0] == nil): // one provider has it, the other doesn't (yet)
		return zero, errMismatch
	}
	if errors.Is(errs[0], errUnreadable) && errors.Is(errs[1], errUnreadable) {
		return zero, fmt.Errorf("%w: %w", errUnreadable, errors.Join(errs[0], errs[1]))
	}
	answered := func(err error) bool { return errors.Is(err, errUnreadable) || errors.Is(err, errRefused) }
	if answered(errs[0]) && answered(errs[1]) {
		return zero, fmt.Errorf("%w: %w", errRefused, errors.Join(errs[0], errs[1]))
	}
	var down []error
	for _, err := range errs {
		if err != nil && !errors.Is(err, errNoTx) {
			if answered(err) { // one provider alone: maybe it is the broken one, not the request
				err = errors.New(err.Error())
			}
			down = append(down, err)
		}
	}
	if len(down) > 0 {
		return zero, errors.Join(down...)
	}
	if !bytes.Equal(keys[0], keys[1]) {
		return zero, errMismatch
	}
	return got[0], nil
}

// call: one JSON-RPC request to rpc i, after checking once that it serves chain 56.
func (b *bsc) call(ctx context.Context, i int, method string, params []any, out any) error {
	b.mu.Lock()
	checked := b.chain[i]
	b.mu.Unlock()
	if !checked {
		var id string
		if err := b.post(ctx, i, "eth_chainId", []any{}, &id); err != nil {
			return err
		}
		if n, err := hexUint(id); err != nil || n != uint64(game.payments.ChainID) {
			return errChain
		}
		b.mu.Lock()
		b.chain[i] = true
		b.mu.Unlock()
	}
	return b.post(ctx, i, method, params, out)
}

func (b *bsc) post(ctx context.Context, i int, method string, params []any, out any) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.rpcs[i], bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := b.client.Do(req)
	if err != nil {
		return fmt.Errorf("bsc rpc %d: %w", i+1, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("bsc rpc %d: http %d", i+1, res.StatusCode)
	}
	var reply struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, rpcMaxBytes+1))
	if err != nil {
		return fmt.Errorf("bsc rpc %d: %w", i+1, err) // the connection broke: try again later
	}
	if len(data) > rpcMaxBytes {
		return fmt.Errorf("bsc rpc %d: over %d bytes: %w", i+1, rpcMaxBytes, errUnreadable)
	}
	if err := json.Unmarshal(data, &reply); err != nil {
		return fmt.Errorf("bsc rpc %d: %w: %w", i+1, errUnreadable, err)
	}
	if reply.Error != nil {
		return fmt.Errorf("bsc rpc %d: %w", i+1, rpcRefusal(reply.Error.Message))
	}
	if raw, ok := out.(*json.RawMessage); ok {
		*raw = reply.Result
		return nil
	}
	return json.Unmarshal(reply.Result, out)
}

// rpcRefusal: a JSON-RPC error answer (its message); errors.Is(it, errRefused).
type rpcRefusal string

func (e rpcRefusal) Error() string        { return string(e) }
func (e rpcRefusal) Is(target error) bool { return target == errRefused }

// rpcMaxBytes: the largest rpc answer read (a receipt or a block range of logs).
const rpcMaxBytes = 4 << 20

func hexUint(s string) (uint64, error) { return strconv.ParseUint(strings.TrimPrefix(s, "0x"), 16, 64) }

// topicAddr: the address in an indexed topic (the last 20 of its 32 bytes).
func topicAddr(topic string) string { return "0x" + strings.ToLower(topic[len(topic)-40:]) }
