# relay (Go)

The multiplayer connector: rooms, presence and frame routing between a host (the CEO's browser), guests and a
DJ. No game logic, no database. ~5 MB RAM idle, ~24 MB at 300 players. Protocol:
[docs/multiplayer.md](../../docs/multiplayer.md).

```sh
go run .                    # :8787, WebSocket at /ws, internal /healthz and /stats
go test -race ./...
go run ./cmd/loadtest -url ws://127.0.0.1:8787/ws -rooms 10 -peers 30
```

| File           | What                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| `protocol.go`  | frame kinds and control messages                                          |
| `hub.go`       | rooms, peers, host resume, per-IP limits, kick ban, eviction              |
| `conn.go`      | per-connection read/write loops, bounded queues, rate limits              |
| `main.go`      | config (`ADDR`, `ORIGINS`, limits, `TRUST_PROXY`), HTTP wiring, client IP |
| `cmd/loadtest` | load generator                                                            |
