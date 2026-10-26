package main

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// The item shop: wardrobe items with a price (wardrobe.json) are bought once with Coin and kept; the others are
// free. A saved look may only wear what is free or owned. Cosmetic only: nothing here touches credits or tokens.
//
//	POST  /api/items     {item} → Profile (buy it)
//	PATCH /api/profile   {look} → Profile (save an outfit)

const maxLook = 400

func ownedItems(t *sql.Tx, id string) ([]string, error) {
	rows, err := t.Query(`SELECT item FROM owned_items WHERE user_id = ? ORDER BY at, item`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var it string
		if err := rows.Scan(&it); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// BuyItem debits the price and records the item. The wallet keeps at least the refill floor after paying, so
// spending on items never makes a player eligible for a free refill (no buy → refill → buy loop).
func (s *store) BuyItem(ctx context.Context, id, item string) (p Profile, err error) {
	it, ok := game.wardrobe.Items[item]
	if !ok || it.Price <= 0 {
		return p, errBad
	}
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		var n int
		if e := t.QueryRow(`SELECT COUNT(*) FROM owned_items WHERE user_id = ? AND item = ?`, id, item).Scan(&n); e != nil {
			return e
		}
		if n > 0 {
			return errConflict
		}
		res, e := t.Exec(`UPDATE users SET wallet = wallet - ? WHERE id = ? AND wallet - ? >= ?`,
			it.Price, id, it.Price, refillBelow)
		if e != nil {
			return e
		}
		if k, _ := res.RowsAffected(); k == 0 {
			return errRejected
		}
		if e := ledger(t, id, -it.Price, "item", "", item); e != nil {
			return e
		}
		if _, e := t.Exec(`INSERT INTO owned_items (user_id, item, price, at) VALUES (?, ?, ?, ?)`,
			id, item, it.Price, time.Now().Unix()); e != nil {
			return e
		}
		if e := touch(t, id); e != nil {
			return e
		}
		p, e = read(t, id)
		return e
	})
	return
}

// SetLook saves an outfit: "" (back to the default), or `skin:item,item,…` (core's encodeAvatar) with a known skin,
// known items at most one per slot, the required slots filled, and every shop item owned.
func (s *store) SetLook(ctx context.Context, id, look string) (p Profile, err error) {
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		owned, e := ownedItems(t, id)
		if e != nil {
			return e
		}
		if !validLook(look, owned) {
			return errBad
		}
		if _, e := t.Exec(`UPDATE users SET look = ? WHERE id = ?`, look, id); e != nil {
			return e
		}
		if e := touch(t, id); e != nil {
			return e
		}
		p, e = read(t, id)
		return e
	})
	return
}

func validLook(look string, owned []string) bool {
	if look == "" {
		return true
	}
	skin, list, ok := strings.Cut(look, ":")
	if !ok || len(look) > maxLook {
		return false
	}
	if _, ok := game.wardrobe.Skins[skin]; !ok {
		return false
	}
	has := map[string]bool{}
	for _, o := range owned {
		has[o] = true
	}
	slots := map[string]bool{}
	for _, item := range strings.Split(list, ",") {
		it, ok := game.wardrobe.Items[item]
		if !ok || slots[it.Slot] || (it.Price > 0 && !has[item]) {
			return false
		}
		slots[it.Slot] = true
	}
	for _, r := range game.wardrobe.Required {
		if !slots[r] {
			return false
		}
	}
	return true
}
