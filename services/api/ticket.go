package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"
)

// Relay tickets: the api vouches for a signed-in, unbanned player so the multiplayer relay (which has no accounts)
// can key its limits and kick bans by account instead of by IP, and refuse anyone who isn't signed in. The relay
// checks the HMAC with the same RELAY_TICKET_SECRET (services/relay/ticket.go keeps the format in step).
//
//	POST /api/relay/ticket → {ticket, exp} (signed in; 403 banned; 503 when no secret is set)
//
// Format: "v1.<base64url {"sub":id,"exp":unix}>.<base64url HMAC-SHA256(secret, "v1."+payload)>".
const ticketTTL = 10 * time.Minute

type ticketClaims struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
}

func signTicket(secret []byte, sub string, exp time.Time) string {
	b, _ := json.Marshal(ticketClaims{sub, exp.Unix()})
	head := "v1." + base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(head))
	return head + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (pl *players) routeTicket(mux *http.ServeMux) {
	secret := []byte(os.Getenv("RELAY_TICKET_SECRET"))
	if n := len(secret); n > 0 && n < 32 {
		// The relay refuses to start with it; here: no tickets until it's fixed.
		slog.Error("RELAY_TICKET_SECRET too short: use at least 32 bytes (openssl rand -hex 32)", "len", n)
		secret = nil
	}
	mux.HandleFunc("POST /api/relay/ticket", func(w http.ResponseWriter, r *http.Request) {
		if len(secret) == 0 {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not_configured"})
			return
		}
		id, ok := pl.who(w, r) // a banned player gets 403 here: no ticket, no live clubs
		if !ok {
			return
		}
		exp := time.Now().Add(ticketTTL)
		writeJSON(w, http.StatusOK, map[string]any{"ticket": signTicket(secret, id, exp), "exp": exp.Unix()})
	})
}
