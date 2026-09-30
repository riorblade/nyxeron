package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Binance Web3 RWA prices (tokenized stocks on BNB Chain). The API wants an HMAC-signed key, so the secret stays
// in this service and browsers only see GET /api/quotes → {"quotes":{"TSLA":412.3,…}}.
// Docs: https://web3.binance.com/en/dev-docs/authentication and …/rest-api/rwa-data
const (
	binanceBase = "https://web3.binance.com"
	tokensPath  = "/build/api/v1/dex/market/rwa/tokens?binanceChainId=56"
	quotesTTL   = 60 * time.Second
)

type quotesResponse struct {
	Quotes map[string]float64 `json:"quotes"`
	Source string             `json:"source"`
	At     int64              `json:"at"`
	Error  string             `json:"error,omitempty"`
}

// sign: base64(HMAC-SHA256(timestamp + METHOD + /build/path?query + body, secret)).
func sign(secret, ts, method, path, body string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(ts + strings.ToUpper(method) + path + body))
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

// num reads a price that may come as a JSON string or number.
func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	}
	return 0
}

// rows finds the token list: data[], data.list[] or data.tokens[] (the first array).
func rows(raw map[string]any) []map[string]any {
	var d any = raw
	if v, ok := raw["data"]; ok {
		d = v
	}
	var arr []any
	switch x := d.(type) {
	case []any:
		arr = x
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if a, ok := x[k].([]any); ok {
				arr = a
				break
			}
		}
	}
	out := make([]map[string]any, 0, len(arr))
	for _, r := range arr {
		if m, ok := r.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// toQuotes: one price per underlying ticker. The underlying's reference price, else the token price. Sorted by
// issuer so a ticker with several tokens is stable (later wins: ondo over bstock).
func toQuotes(raw map[string]any) map[string]float64 {
	list := rows(raw)
	sort.SliceStable(list, func(i, j int) bool {
		return fmt.Sprint(list[i]["platformId"]) < fmt.Sprint(list[j]["platformId"])
	})
	out := map[string]float64{}
	for _, r := range list {
		ticker := strings.ToUpper(fmt.Sprint(r["underlyingTicker"]))
		price := num(r["referencePrice"])
		if price <= 0 {
			price = num(r["tokenPrice"])
		}
		if ticker != "" && ticker != "<NIL>" && price > 0 {
			out[ticker] = price
		}
	}
	return out
}

// quoter caches the last good answer for quotesTTL; concurrent requests share one upstream call.
type quoter struct {
	key, secret string
	client      *http.Client
	mu          sync.Mutex
	cache       *quotesResponse
}

func (q *quoter) get() quotesResponse {
	now := time.Now()
	if q.key == "" || q.secret == "" {
		return quotesResponse{Quotes: map[string]float64{}, Source: "none", At: now.UnixMilli(), Error: "no API key"}
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.cache != nil && now.Sub(time.UnixMilli(q.cache.At)) < quotesTTL {
		return *q.cache
	}
	quotes, err := q.fetch()
	if err != nil {
		if q.cache != nil {
			return *q.cache // serve the last good prices
		}
		return quotesResponse{Quotes: map[string]float64{}, Source: "none", At: now.UnixMilli(), Error: err.Error()}
	}
	q.cache = &quotesResponse{Quotes: quotes, Source: "binance", At: now.UnixMilli()}
	return *q.cache
}

func (q *quoter) fetch() (map[string]float64, error) {
	ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	req, _ := http.NewRequest(http.MethodGet, binanceBase+tokensPath, nil)
	req.Header.Set("X-OC-APIKEY", q.key)
	req.Header.Set("X-OC-TIMESTAMP", ts)
	req.Header.Set("X-OC-SIGN", sign(q.secret, ts, "GET", tokensPath, ""))
	res, err := q.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("binance %d", res.StatusCode)
	}
	var raw map[string]any
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&raw); err != nil {
		return nil, err
	}
	return toQuotes(raw), nil
}
