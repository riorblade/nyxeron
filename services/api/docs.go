package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Player documents: everything else that belongs to an account and must follow it to another device. The game
// runs in the browser, so these are stored as the browser wrote them, but each kind has a whitelist of slots, a
// size cap and a shape check, and is kept gzipped.
//
//	GET /api/docs/{kind}          → [{slot, updatedAt, meta}]
//	GET /api/docs/{kind}/{slot}   → the document (JSON)
//	PUT /api/docs/{kind}/{slot}   JSON → {slot, updatedAt, meta}
//	DELETE /api/docs/{kind}/{slot} (e.g. a layout reset to the default)
//
// ponytail: the CEO career is client-simulated, so a save is the player's word; nothing that pays out real value
// may trust it (that needs a server-side replay of the night).
type docKind struct {
	slot     *regexp.Regexp
	maxBytes int
	maxSlots int
	// check validates the document and returns the metadata listed with it.
	check func(raw []byte) (meta map[string]any, ok bool)
}

var docKinds = map[string]docKind{
	// CEO career saves: {v, savedAt, state: GameState}.
	"saves": {regexp.MustCompile(`^(auto|[1-3])$`), 600 << 10, 4, checkSave},
	// Planned DJ sets: {sets: [...], tonight, bpmFix}.
	"djsets": {regexp.MustCompile(`^main$`), 64 << 10, 1, checkObject("sets")},
	// Furniture arrangement per venue layout: [{kind, x, z, rot}, ...].
	"layouts": {regexp.MustCompile(`^[a-z0-9-]{1,32}$`), 32 << 10, 10, checkArray},
	// Videotron shoutouts: up to 8 short messages.
	"shoutouts": {regexp.MustCompile(`^main$`), 2 << 10, 1, checkShoutouts},
}

func checkSave(raw []byte) (map[string]any, bool) {
	var f struct {
		V       float64 `json:"v"`
		SavedAt float64 `json:"savedAt"`
		State   struct {
			Day      *float64 `json:"day"`
			Level    float64  `json:"level"`
			ClubName string   `json:"clubName"`
			Coin     float64  `json:"coin"`
			Outcome  *string  `json:"outcome"`
		} `json:"state"`
	}
	if json.Unmarshal(raw, &f) != nil || f.V < 1 || f.SavedAt <= 0 || f.State.Day == nil ||
		f.State.Level < 1 || f.State.Level > 5 || utf8.RuneCountInString(f.State.ClubName) > 40 {
		return nil, false
	}
	meta := map[string]any{
		"savedAt": f.SavedAt, "day": *f.State.Day, "level": f.State.Level,
		"clubName": f.State.ClubName, "coin": f.State.Coin,
	}
	if f.State.Outcome != nil {
		meta["outcome"] = *f.State.Outcome
	}
	return meta, true
}

func checkObject(required string) func([]byte) (map[string]any, bool) {
	return func(raw []byte) (map[string]any, bool) {
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			return nil, false
		}
		_, ok := m[required]
		return map[string]any{}, ok
	}
}

func checkArray(raw []byte) (map[string]any, bool) {
	var a []json.RawMessage
	if json.Unmarshal(raw, &a) != nil || len(a) > 200 {
		return nil, false
	}
	return map[string]any{"items": len(a)}, true
}

func checkShoutouts(raw []byte) (map[string]any, bool) {
	var a []string
	if json.Unmarshal(raw, &a) != nil || len(a) > 8 {
		return nil, false
	}
	for _, s := range a {
		if utf8.RuneCountInString(s) > 80 {
			return nil, false
		}
	}
	return map[string]any{"count": len(a)}, true
}

const docsSchema = `
CREATE TABLE IF NOT EXISTS docs (
	user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind       TEXT    NOT NULL,
	slot       TEXT    NOT NULL,
	data       BLOB    NOT NULL,
	meta       TEXT    NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, kind, slot)
);`

type DocInfo struct {
	Slot      string         `json:"slot"`
	UpdatedAt int64          `json:"updatedAt"`
	Meta      map[string]any `json:"meta"`
}

func gz(b []byte) []byte {
	var out bytes.Buffer
	w := gzip.NewWriter(&out)
	w.Write(b)
	w.Close()
	return out.Bytes()
}

func gunzip(b []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, 1<<20))
}

// PutDoc stores a validated document (replacing that slot).
func (s *store) PutDoc(ctx context.Context, id, kind, slot string, raw []byte, now time.Time) (DocInfo, error) {
	k, ok := docKinds[kind]
	if !ok || !k.slot.MatchString(slot) || len(raw) > k.maxBytes {
		return DocInfo{}, errBad
	}
	meta, ok := k.check(raw)
	if !ok {
		return DocInfo{}, errBad
	}
	mj, _ := json.Marshal(meta)
	err := s.tx(ctx, id, func(t *sql.Tx) error {
		var n int
		if e := t.QueryRow(`SELECT COUNT(*) FROM docs WHERE user_id = ? AND kind = ? AND slot != ?`, id, kind, slot).Scan(&n); e != nil {
			return e
		}
		if n >= k.maxSlots {
			return errRejected
		}
		_, e := t.Exec(`INSERT INTO docs (user_id, kind, slot, data, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (user_id, kind, slot) DO UPDATE SET data = excluded.data, meta = excluded.meta, updated_at = excluded.updated_at`,
			id, kind, slot, gz(raw), string(mj), now.UnixMilli())
		return e
	})
	return DocInfo{Slot: slot, UpdatedAt: now.UnixMilli(), Meta: meta}, err
}

func (s *store) GetDoc(ctx context.Context, id, kind, slot string) ([]byte, error) {
	if _, ok := docKinds[kind]; !ok {
		return nil, errBad
	}
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT data FROM docs WHERE user_id = ? AND kind = ? AND slot = ?`, id, kind, slot).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	return gunzip(data)
}

func (s *store) ListDocs(ctx context.Context, id, kind string) ([]DocInfo, error) {
	if _, ok := docKinds[kind]; !ok {
		return nil, errBad
	}
	rows, err := s.db.QueryContext(ctx, `SELECT slot, updated_at, meta FROM docs WHERE user_id = ? AND kind = ? ORDER BY slot`, id, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocInfo{}
	for rows.Next() {
		var d DocInfo
		var mj string
		if err := rows.Scan(&d.Slot, &d.UpdatedAt, &mj); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(mj), &d.Meta)
		out = append(out, d)
	}
	return out, rows.Err()
}

var errNotFound = errors.New("not found")

func (s *store) DeleteDoc(ctx context.Context, id, kind, slot string) error {
	if k, ok := docKinds[kind]; !ok || !k.slot.MatchString(slot) {
		return errBad
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM docs WHERE user_id = ? AND kind = ? AND slot = ?`, id, kind, slot)
	return err
}

func (pl *players) routeDocs(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/docs/{kind}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			list, err := pl.db.ListDocs(r.Context(), id, r.PathValue("kind"))
			if err != nil {
				fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, list)
		}
	})
	mux.HandleFunc("GET /api/docs/{kind}/{slot}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			raw, err := pl.db.GetDoc(r.Context(), id, r.PathValue("kind"), r.PathValue("slot"))
			if errors.Is(err, errNotFound) {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
				return
			}
			if err != nil {
				fail(w, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(raw)
		}
	})
	mux.HandleFunc("DELETE /api/docs/{kind}/{slot}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			if err := pl.db.DeleteDoc(r.Context(), id, r.PathValue("kind"), r.PathValue("slot")); err != nil {
				fail(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		}
	})
	mux.HandleFunc("PUT /api/docs/{kind}/{slot}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		if !ok {
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 700<<10))
		if err != nil || !json.Valid(raw) {
			fail(w, errBad)
			return
		}
		info, err := pl.db.PutDoc(r.Context(), id, r.PathValue("kind"), strings.TrimSpace(r.PathValue("slot")), raw, time.Now())
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, info)
	})
}
