package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSign(t *testing.T) {
	// Vector: printf '%s' "<preHash>" | openssl dgst -sha256 -hmac test-secret -binary | base64
	got := sign("test-secret", "2026-05-11T10:08:57.715Z", "get", "/build/api/v1/dex/market/rwa/tokens?binanceChainId=56", "")
	if got != "qi1JDOb/5OKUF6/NYwQ5LwfEpg8dSqgKFIODFA/Srfs=" {
		t.Fatal(got)
	}
}

func TestToQuotes(t *testing.T) {
	var raw map[string]any
	_ = json.Unmarshal([]byte(`{"data":{"list":[
		{"platformId":"ondo","underlyingTicker":"nvda","referencePrice":"180.5"},
		{"platformId":"bstock","underlyingTicker":"NVDA","referencePrice":"999"},
		{"platformId":"ondo","underlyingTicker":"TSLA","tokenPrice":61.89},
		{"platformId":"ondo","underlyingTicker":"BAD","tokenPrice":"0"}]}}`), &raw)
	q := toQuotes(raw)
	if len(q) != 2 || q["NVDA"] != 180.5 || q["TSLA"] != 61.89 {
		t.Fatal(q)
	}
}

func TestQuotesWithoutKey(t *testing.T) {
	srv := httptest.NewServer(routes(&quoter{}, []string{"https://nyxeron.xyz"}, newPrivy("", "", http.DefaultClient), nil))
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/quotes", nil)
	req.Header.Set("Origin", "https://nyxeron.xyz")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "https://nyxeron.xyz" {
		t.Fatalf("CORS for the game site: %q", got)
	}
	req.Header.Set("Origin", "https://evil.example")
	if res2, _ := http.DefaultClient.Do(req); res2.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS granted to a foreign site")
	}
	var body quotesResponse
	_ = json.NewDecoder(res.Body).Decode(&body)
	if body.Source != "none" || len(body.Quotes) != 0 {
		t.Fatalf("%+v", body)
	}
}
