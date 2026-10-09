package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
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

// clientIP: with trustProxy (the relay only reachable through the edge proxy, deploy/Caddyfile) the last
// X-Forwarded-For hop, which the proxy wrote itself; otherwise the socket's address.
func clientIP(r *http.Request, trustProxy bool) string {
	if xff := r.Header.Get("X-Forwarded-For"); trustProxy && xff != "" {
		return strings.TrimSpace(xff[strings.LastIndex(xff, ",")+1:])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// server wires HTTP: /ws (the relay), /healthz and /stats (internal; the edge proxy only exposes /ws).
func server(h *hub, origins []string) http.Handler { return serverWith(h, origins, false) }

func serverWith(h *hub, origins []string, trustProxy bool) http.Handler {
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
		ip := clientIP(r, trustProxy)
		if !h.admit(ip) {
			// Told why (the client shows it and backs off), then closed: no goroutines, no queue.
			ctx, cancel := context.WithTimeout(r.Context(), time.Second)
			_ = ws.Write(ctx, websocket.MessageText, []byte(`{"t":"error","code":"too_many_connections"}`))
			cancel()
			_ = ws.Close(websocket.StatusTryAgainLater, "too_many_connections")
			return
		}
		defer h.gone(ip)
		c := newConn(ws, h)
		c.ip = ip
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
	h.maxConns = envInt("MAX_CONNS", h.maxConns)
	h.maxConnsPerIP = envInt("MAX_CONNS_PER_IP", h.maxConnsPerIP)
	h.maxRoomsPerIP = envInt("MAX_ROOMS_PER_IP", 8)
	h.kickBan = time.Duration(envInt("KICK_BAN_SEC", int(h.kickBan.Seconds()))) * time.Second
	h.queueBudget = int64(envInt("QUEUE_BUDGET_MB", int(h.queueBudget>>20))) << 20
	trustProxy := env("TRUST_PROXY", "") == "1"
	go func() {
		for now := range time.Tick(10 * time.Second) {
			h.sweep(now)
		}
	}()

	srv := &http.Server{
		Addr:              addr,
		Handler:           serverWith(h, origins, trustProxy),
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
	slog.Info("relay listening", "addr", addr, "origins", origins, "max_conns", h.maxConns,
		"max_conns_per_ip", h.maxConnsPerIP, "max_rooms_per_ip", h.maxRoomsPerIP, "trust_proxy", trustProxy)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("relay stopped", "err", err)
		os.Exit(1)
	}
}
