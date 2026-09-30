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
	"strings"
	"syscall"
	"time"
)

// The NYXERON API: game backend services that are not the multiplayer relay. Today: spot quotes.
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func routes(q *quoter) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/quotes", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=30")
		_ = json.NewEncoder(w).Encode(q.get())
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	return mux
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
	srv := &http.Server{Addr: addr, Handler: routes(q), ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 8 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	slog.Info("api listening", "addr", addr, "binance_key", q.key != "")
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("api stopped", "err", err)
		os.Exit(1)
	}
}
