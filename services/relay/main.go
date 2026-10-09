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
	"sync"
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

// proxies are the hosts whose X-Forwarded-For is believed (TRUST_PROXY: hostnames, IPs or CIDRs, comma-separated).
// Hostnames (a proxy container's name) are resolved outside the lock with a 1 s timeout: every 30 s in the
// background, and at once (at most every 2 s) when a socket isn't recognised, so a proxy back on a new IP is picked
// up. A failed lookup keeps the last good list.
type proxies struct {
	entries []string
	mu      sync.Mutex
	nets    []*net.IPNet
	at      time.Time // last resolve attempt
}

func newProxies(list string) *proxies {
	p := &proxies{}
	for _, e := range strings.Split(list, ",") {
		if e = strings.TrimSpace(e); e != "" {
			p.entries = append(p.entries, e)
		}
	}
	return p
}

func (p *proxies) match(ip net.IP) (ok, stale bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, n := range p.nets {
		if n.Contains(ip) {
			ok = true
			break
		}
	}
	return ok, time.Since(p.at) > 30*time.Second
}

func (p *proxies) refresh() {
	p.mu.Lock()
	if time.Since(p.at) < 2*time.Second {
		p.mu.Unlock()
		return
	}
	p.at = time.Now()
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var nets []*net.IPNet
	for _, e := range p.entries {
		if _, n, err := net.ParseCIDR(e); err == nil {
			nets = append(nets, n)
			continue
		}
		addrs := []string{e}
		if net.ParseIP(e) == nil {
			addrs, _ = net.DefaultResolver.LookupHost(ctx, e)
		}
		for _, a := range addrs {
			if x := net.ParseIP(a); x != nil {
				nets = append(nets, &net.IPNet{IP: x, Mask: net.CIDRMask(len(x)*8, len(x)*8)})
			}
		}
	}
	if len(nets) > 0 {
		p.mu.Lock()
		p.nets = nets
		p.mu.Unlock()
	}
}

func (p *proxies) trusts(ip net.IP) bool {
	if p == nil || len(p.entries) == 0 || ip == nil {
		return false
	}
	if ok, stale := p.match(ip); ok {
		if stale {
			go p.refresh()
		}
		return true
	}
	p.refresh()
	ok, _ := p.match(ip)
	return ok
}

// clientIP: the socket's address, or the last X-Forwarded-For hop when the socket is a trusted proxy (that hop is
// the one the proxy wrote; anything before it the client could have made up). IPv6 is keyed by its /64, the block
// one subscriber gets, so per-IP limits can't be dodged by rotating addresses.
func clientIP(r *http.Request, p *proxies) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" && p.trusts(net.ParseIP(host)) {
		host = strings.TrimSpace(xff[strings.LastIndex(xff, ",")+1:])
	}
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
	}
	return host
}

// server wires HTTP: /ws (the relay), /healthz and /stats (internal; the edge proxy only exposes /ws).
func server(h *hub, origins []string) http.Handler { return serverWith(h, origins, nil) }

func serverWith(h *hub, origins []string, trusted *proxies) http.Handler {
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
		ip := clientIP(r, trusted)
		if !h.admit(ip) {
			// Told why (the client shows it and backs off), then dropped at once: no close handshake to wait on.
			ctx, cancel := context.WithTimeout(r.Context(), 200*time.Millisecond)
			_ = ws.Write(ctx, websocket.MessageText, []byte(`{"t":"error","code":"too_many_connections"}`))
			cancel()
			_ = ws.CloseNow()
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
	trusted := newProxies(env("TRUST_PROXY", ""))
	go func() {
		for now := range time.Tick(10 * time.Second) {
			h.sweep(now)
		}
	}()

	srv := &http.Server{
		Addr:              addr,
		Handler:           serverWith(h, origins, trusted),
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
		"max_conns_per_ip", h.maxConnsPerIP, "max_rooms_per_ip", h.maxRoomsPerIP, "trust_proxy", trusted.entries)
	if len(trusted.entries) == 0 {
		slog.Warn("TRUST_PROXY empty: behind a proxy every player shares its IP and the per-IP limits apply to all")
	}
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("relay stopped", "err", err)
		os.Exit(1)
	}
}
