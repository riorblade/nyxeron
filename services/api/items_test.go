package main

import (
	"errors"
	"strings"
	"sync"
	"testing"
)

func TestBuyItem(t *testing.T) {
	s := testStore(t)
	p, err := s.BuyItem(ctx, "u", "tophat-gold")
	price := game.wardrobe.Items["tophat-gold"].Price
	if err != nil || p.Wallet != startWallet-price || len(p.Items) != 1 || p.Items[0] != "tophat-gold" {
		t.Fatalf("bought: %+v %v", p, err)
	}
	var kind, reason string
	var delta int64
	s.db.QueryRow(`SELECT kind, delta, reason FROM ledger WHERE user_id = 'u' ORDER BY id DESC`).Scan(&kind, &delta, &reason)
	if kind != "item" || delta != -price || reason != "tophat-gold" {
		t.Fatalf("ledger row: %s %d %s", kind, delta, reason)
	}
	if _, err := s.BuyItem(ctx, "u", "tophat-gold"); !errors.Is(err, errConflict) {
		t.Fatalf("bought twice: %v", err)
	}
	for _, bad := range []string{"", "tee-white", "nope", "tophat-gold ", "TOPHAT-GOLD"} {
		if _, err := s.BuyItem(ctx, "u", bad); !errors.Is(err, errBad) {
			t.Fatalf("%q: free or unknown items aren't for sale: %v", bad, err)
		}
	}
	if w := wallet(t, s, "u"); w != startWallet-price {
		t.Fatalf("failed buys moved Coin: %d", w)
	}
}

// Spending on items stops at the refill floor, so buy → broke → free refill → buy can't farm the shop.
func TestBuyItemKeepsTheRefillFloor(t *testing.T) {
	s := testStore(t)
	bought := 0
	for item, it := range game.wardrobe.Items {
		if it.Price == 0 {
			continue
		}
		if _, err := s.BuyItem(ctx, "u", item); err == nil {
			bought++
		} else if !errors.Is(err, errRejected) {
			t.Fatal(err)
		}
		if w := wallet(t, s, "u"); w < refillBelow {
			t.Fatalf("below the refill floor: %d", w)
		}
	}
	if bought == 0 {
		t.Fatal("nothing affordable")
	}
	if _, err := s.Refill(ctx, "u"); !errors.Is(err, errRejected) {
		t.Fatalf("shopping made a refill possible: %v", err)
	}
}

func TestBuyItemRace(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "u")
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.BuyItem(ctx, "u", "chain-diamond"); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if ok != 1 || wallet(t, s, "u") != startWallet-game.wardrobe.Items["chain-diamond"].Price {
		t.Fatalf("paid %d times", ok)
	}
}

func TestSetLook(t *testing.T) {
	s := testStore(t)
	base := "sand:tee-white,jeans-blue,sneakers-white"
	if p, err := s.SetLook(ctx, "u", base+",hair-afro"); err != nil || p.Look != base+",hair-afro" {
		t.Fatalf("free look: %+v %v", p, err)
	}
	for _, bad := range []string{
		base + ",tophat-gold",                      // not owned
		"sand:tee-white,jeans-blue",                // no shoes
		"pink:tee-white,jeans-blue,sneakers-white", // unknown skin
		base + ",tee-black",                        // two shirts
		base + ",",                                 // empty item
		base + ",nope",
		"sand" + base,
		"tee-white,jeans-blue,sneakers-white",
		base + "," + strings.Repeat("x", 400),
	} {
		if _, err := s.SetLook(ctx, "u", bad); !errors.Is(err, errBad) {
			t.Fatalf("%q saved: %v", bad, err)
		}
	}
	if p, _ := s.Get(ctx, "u"); p.Look != base+",hair-afro" {
		t.Fatalf("a refused look changed the saved one: %q", p.Look)
	}
	s.BuyItem(ctx, "u", "tophat-gold")
	if p, err := s.SetLook(ctx, "u", base+",tophat-gold"); err != nil || p.Look != base+",tophat-gold" {
		t.Fatalf("owned look: %+v %v", p, err)
	}
	if p, err := s.SetLook(ctx, "u", ""); err != nil || p.Look != "" {
		t.Fatalf("reset: %+v %v", p, err)
	}
	// Someone else's purchase doesn't count.
	if _, err := s.SetLook(ctx, "other", base+",tophat-gold"); !errors.Is(err, errBad) {
		t.Fatalf("wore another player's item: %v", err)
	}
}

func TestBuyCelebration(t *testing.T) {
	s := testStore(t)
	price := game.wardrobe.Celebrations["makeItRain"].Price
	p, err := s.BuyItem(ctx, "u", "makeItRain")
	if err != nil || price <= 0 || p.Wallet != startWallet-price || len(p.Items) != 1 || p.Items[0] != "makeItRain" {
		t.Fatalf("bought a celebration: %+v %v", p, err)
	}
	if _, err := s.BuyItem(ctx, "u", "makeItRain"); !errors.Is(err, errConflict) {
		t.Fatalf("twice: %v", err)
	}
	// A move isn't something to wear.
	if _, err := s.SetLook(ctx, "u", "sand:tee-white,jeans-blue,sneakers-white,makeItRain"); !errors.Is(err, errBad) {
		t.Fatalf("wore a celebration: %v", err)
	}
}
