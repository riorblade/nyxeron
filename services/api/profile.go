package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Player endpoints. Every one needs a verified Privy access token; the player is always the token's subject,
// never an id from the request.
//
//	GET   /api/profile          → Profile (created with the starter wallet on first call)
//	POST  /api/profile/import   Profile → Profile (once: this device's pre-account data)
//	PATCH /api/profile          {name?, avatar?} → Profile
//	POST  /api/wallet/refill    → Profile (only when the wallet is nearly empty)
//	POST  /api/nights           {cash, bought, pnl, room?} → Profile (a night out as a guest)
//	POST  /api/gigs             {fee} → Profile (a DJ gig played to the end)
type players struct {
	auth  *privy
	db    *store
	q     *quoter
	chain *bsc // BNB Smart Chain (BSC_RPC_1 + BSC_RPC_2); nil: top-ups off
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errBad):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request"})
	case errors.Is(err, errRejected):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "rejected"})
	case errors.Is(err, errSoldOut):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "sold_out"})
	case errors.Is(err, errConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "conflict"})
	case errors.Is(err, errStarted):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "started"})
	default:
		slog.Error("players", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
	}
}

// who returns the verified player, or answers 401/503 itself.
func (pl *players) who(w http.ResponseWriter, r *http.Request) (string, bool) {
	if pl.db == nil || !pl.auth.configured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not_configured"})
		return "", false
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing_token"})
		return "", false
	}
	id, err := pl.auth.verify(strings.TrimSpace(token), time.Now())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_token"})
		return "", false
	}
	// A banned player can still sign in and see why, but changes nothing.
	if r.Method != http.MethodGet && pl.db.Banned(r.Context(), id) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "banned"})
		return "", false
	}
	return id, true
}

// body decodes a small JSON request (16 KB is plenty for a profile).
func body(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(v); err != nil {
		fail(w, errBad)
		return false
	}
	return true
}

func (pl *players) route(mux *http.ServeMux) {
	reply := func(w http.ResponseWriter, p Profile, err error) {
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, p)
	}
	mux.HandleFunc("GET /api/profile", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			p, err := pl.db.Get(r.Context(), id)
			if err == nil {
				// Keep the email and wallet the back office searches by (Privy lookups are cached for minutes).
				me, _ := pl.auth.user(id, time.Now())
				_ = pl.db.SetIdentity(r.Context(), id, me.Email, me.Wallet, time.Now())
			}
			reply(w, p, err)
		}
	})
	mux.HandleFunc("POST /api/profile/import", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in Profile
		if ok && body(w, r, &in) {
			p, err := pl.db.Import(r.Context(), id, in)
			reply(w, p, err)
		}
	})
	mux.HandleFunc("PATCH /api/profile", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct {
			Name   *string `json:"name"`
			Avatar *int    `json:"avatar"`
		}
		if ok && body(w, r, &in) {
			p, err := pl.db.Update(r.Context(), id, in.Name, in.Avatar)
			reply(w, p, err)
		}
	})
	mux.HandleFunc("POST /api/wallet/refill", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			p, err := pl.db.Refill(r.Context(), id)
			reply(w, p, err)
		}
	})
	mux.HandleFunc("POST /api/nights", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct {
			Cash   int64              `json:"cash"`
			Bought map[string]Holding `json:"bought"`
			Pnl    int64              `json:"pnl"`
			Room   string             `json:"room"` // a live party at a rented venue: its tenant gets the spend
		}
		if ok && body(w, r, &in) {
			p, err := pl.db.Night(r.Context(), id, in.Cash, in.Bought, in.Pnl, in.Room)
			reply(w, p, err)
		}
	})
	mux.HandleFunc("POST /api/gigs", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct {
			Fee int64 `json:"fee"`
		}
		if ok && body(w, r, &in) {
			p, err := pl.db.Gig(r.Context(), id, in.Fee, time.Now())
			reply(w, p, err)
		}
	})
}
