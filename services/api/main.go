package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// The NYXERON API: game backend services that are not the multiplayer relay: spot quotes, players, back office.
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// cors lets the game's own sites (CORS_ORIGINS, e.g. https://nyxeron.xyz) call the API from the browser.
func cors(origins []string, w http.ResponseWriter, r *http.Request) {
	o := r.Header.Get("Origin")
	for _, allowed := range origins {
		if o != "" && o == allowed {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Add("Vary", "Origin")
			return
		}
	}
}

func routes(q *quoter, origins []string, auth *privy, db *store, adm *admin) http.Handler {
	mux := http.NewServeMux()
	if adm == nil {
		adm = &admin{owners: map[string]bool{}}
	}
	adm.auth, adm.db, adm.quotes = auth, db, q
	adm.route(mux)
	mux.HandleFunc("GET /api/me", auth.handleMe)
	pl := &players{auth: auth, db: db, q: q}
	pl.route(mux)
	pl.routeDocs(mux)
	pl.routeCity(mux)
	// Preflight: the browser asks before sending Authorization / JSON cross-site.
	mux.HandleFunc("OPTIONS /api/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/quotes", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=30")
		_ = json.NewEncoder(w).Encode(q.get())
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	// CORS for every route: only the game's own sites may call the API from a browser.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cors(origins, w, r)
		mux.ServeHTTP(w, r)
	})
}

func main() {
	addr := env("ADDR", ":8788")
	health := flag.Bool("healthcheck", false, "probe /healthz and exit (Docker HEALTHCHECK on a scratch image)")
	flag.Parse()
	if *health {
		res, err := http.Get("http://127.0.0.1" + addr[strings.LastIndex(addr, ":"):] + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	q := &quoter{
		key:    os.Getenv("BINANCE_WEB3_API_KEY"),
		secret: os.Getenv("BINANCE_WEB3_SECRET_KEY"),
		client: &http.Client{Timeout: 8 * time.Second},
	}
	var origins []string
	for _, o := range strings.Split(os.Getenv("CORS_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins = append(origins, o)
		}
	}
	auth := newPrivy(os.Getenv("PRIVY_APP_ID"), os.Getenv("PRIVY_APP_SECRET"), &http.Client{Timeout: 8 * time.Second})
	db, err := openStore(env("DB_PATH", "nyxeron.db"))
	if err != nil {
		slog.Error("database", "err", err)
		os.Exit(1)
	}
	defer db.close()
	// Daily backup of the players' data, 7 kept.
	go func() {
		dir := filepath.Dir(env("DB_PATH", "nyxeron.db"))
		for {
			if err := db.backup(dir, time.Now(), 7); err != nil {
				slog.Error("backup", "err", err)
			}
			time.Sleep(24 * time.Hour)
		}
	}()
	srv := &http.Server{Addr: addr, Handler: routes(q, origins, auth, db, &admin{
		owners:   parseOwners(os.Getenv("ADMIN_EMAILS")),
		relayURL: os.Getenv("RELAY_URL"),
		dbPath:   env("DB_PATH", "nyxeron.db"),
		client:   &http.Client{Timeout: 2 * time.Second},
	}), ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 8 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	slog.Info("api listening", "addr", addr, "binance_key", q.key != "", "privy", auth.configured())
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("api stopped", "err", err)
		os.Exit(1)
	}
}
