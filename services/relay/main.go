package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	n, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return n
}

// server wires HTTP: /ws (the relay), /healthz and /stats (internal; the edge proxy only exposes /ws).
func server(h *hub, origins []string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: origins,
			// Snapshots are already compact; per-message deflate costs CPU and ~32 KB RAM per socket.
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			return
		}
		c := newConn(ws, h)
		ctx, cancel := context.WithCancel(r.Context())
		c.cancel = cancel
		go c.writeLoop(ctx)
		c.readLoop(ctx)
		h.leave(c)
		<-c.flushed
		reason, _ := c.reason.Load().(string)
		_ = ws.Close(websocket.StatusNormalClosure, reason)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /stats", func(w http.ResponseWriter, _ *http.Request) {
		rooms, peers := h.stats()
		fmt.Fprintf(w, `{"rooms":%d,"conns":%d}`, rooms, peers)
	})
	return mux
}

func main() {
	addr := env("ADDR", ":8787")
	health := flag.Bool("healthcheck", false, "probe /healthz and exit (for Docker HEALTHCHECK on a scratch image)")
	flag.Parse()
	if *health {
		res, err := http.Get("http://127.0.0.1" + addr[strings.LastIndex(addr, ":"):] + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}

	origins := strings.Split(env("ORIGINS", "localhost,localhost:*,127.0.0.1,127.0.0.1:*"), ",")
	h := newHub(envInt("MAX_ROOMS", 2000), envInt("MAX_PEERS", 64), time.Duration(envInt("GRACE_SEC", 60))*time.Second)
	go func() {
		for now := range time.Tick(10 * time.Second) {
			h.sweep(now)
		}
	}()

	srv := &http.Server{
		Addr:              addr,
		Handler:           server(h, origins),
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	slog.Info("relay listening", "addr", addr, "origins", origins)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("relay stopped", "err", err)
		os.Exit(1)
	}
}
