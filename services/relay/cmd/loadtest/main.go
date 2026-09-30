// Load test for the relay: R rooms, each with a host broadcasting snapshots and P peers sending input.
// go run ./cmd/loadtest -url wss://localhost/ws -rooms 10 -peers 30 -secs 15
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

func main() {
	url := flag.String("url", "ws://127.0.0.1:8787/ws", "relay URL")
	rooms := flag.Int("rooms", 10, "rooms (clubs open at once)")
	peers := flag.Int("peers", 30, "players per room")
	secs := flag.Int("secs", 15, "duration")
	size := flag.Int("size", 2048, "snapshot bytes")
	hz := flag.Int("hz", 10, "snapshots per second")
	flag.Parse()
	opts := &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}},
		HTTPHeader: http.Header{"Origin": {"https://localhost"}},
	}
	ctx := context.Background()
	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, *url, opts)
		if err != nil {
			panic(err)
		}
		c.SetReadLimit(1 << 20)
		return c
	}
	ctl := func(c *websocket.Conn, m map[string]any) {
		b, _ := json.Marshal(m)
		_ = c.Write(ctx, websocket.MessageText, b)
	}
	read := func(c *websocket.Conn) map[string]any {
		_, b, _ := c.Read(ctx)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		return m
	}

	type club struct {
		host  *websocket.Conn
		peers []*websocket.Conn
	}
	clubs := make([]club, *rooms)
	for r := range clubs {
		host := dial()
		ctl(host, map[string]any{"t": "create", "name": "load"})
		code := read(host)["room"].(string)
		clubs[r].host = host
		for i := 0; i < *peers; i++ {
			c := dial()
			ctl(c, map[string]any{"t": "join", "room": code, "name": fmt.Sprint("p", i), "role": "guest"})
			if m := read(c); m["t"] != "joined" {
				panic(fmt.Sprint("join failed: ", m))
			}
			read(host) // "peer joined"
			clubs[r].peers = append(clubs[r].peers, c)
		}
	}
	fmt.Printf("%d rooms × %d players joined (%d sockets)\n", *rooms, *peers, *rooms*(*peers+1))

	var got, sent, fromPeers atomic.Int64
	var wg sync.WaitGroup
	stop := time.Now().Add(time.Duration(*secs) * time.Second)
	for _, cl := range clubs {
		for _, c := range cl.peers {
			wg.Add(2)
			go func() { // reader
				defer wg.Done()
				for {
					rctx, cancel := context.WithDeadline(ctx, stop.Add(2*time.Second))
					t, _, err := c.Read(rctx)
					cancel()
					if err != nil {
						return
					}
					if t == websocket.MessageBinary {
						got.Add(1)
					}
				}
			}()
			go func() { // 2 inputs a second
				defer wg.Done()
				for time.Now().Before(stop) {
					_ = c.Write(ctx, websocket.MessageBinary, []byte{4, 0, 0, 'b', 'u', 'y'})
					time.Sleep(500 * time.Millisecond)
				}
			}()
		}
		go func() {
			for {
				rctx, cancel := context.WithDeadline(ctx, stop.Add(2*time.Second))
				_, _, err := cl.host.Read(rctx)
				cancel()
				if err != nil {
					return
				}
				fromPeers.Add(1)
			}
		}()
		wg.Add(1)
		go func() { // host: snapshots at hz
			defer wg.Done()
			snap := make([]byte, *size)
			snap[0] = 1
			tick := time.NewTicker(time.Second / time.Duration(*hz))
			defer tick.Stop()
			for time.Now().Before(stop) {
				<-tick.C
				_ = cl.host.Write(ctx, websocket.MessageBinary, snap)
				sent.Add(1)
			}
		}()
	}
	wg.Wait()
	want := sent.Load() * int64(*peers)
	inputs := int64(*rooms * *peers * *secs * 2)
	fmt.Printf("snapshots: %d sent, %d of %d delivered (%.1f%%)\n", sent.Load(), got.Load(), want, 100*float64(got.Load())/float64(want))
	fmt.Printf("player inputs to hosts: %d of ~%d\n", fromPeers.Load(), inputs)
}
