package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// Tickets from the api (services/api/ticket.go, POST /api/relay/ticket): a signed-in, unbanned player's account id,
// HMAC-signed with RELAY_TICKET_SECRET and valid for minutes. With a secret set, every create/join/resume needs
// one: limits and kick bans then follow the account, not the IP, and only signed-in players get in.
//
// Format: "v1.<base64url {"sub":id,"exp":unix}>.<base64url HMAC-SHA256(secret, "v1."+payload)>".
func verifyTicket(secret []byte, ticket string, now time.Time) (string, bool) {
	i := strings.LastIndexByte(ticket, '.')
	if len(ticket) > 1024 || i < 0 || !strings.HasPrefix(ticket, "v1.") {
		return "", false
	}
	head, sig := ticket[:i], ticket[i+1:]
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return "", false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(head))
	if !hmac.Equal(got, mac.Sum(nil)) {
		return "", false
	}
	b, err := base64.RawURLEncoding.DecodeString(head[len("v1."):])
	if err != nil {
		return "", false
	}
	var c struct {
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
	}
	if json.Unmarshal(b, &c) != nil || c.Sub == "" || now.Unix() >= c.Exp {
		return "", false
	}
	return c.Sub, true
}
