import { strategy } from "@nyxeron/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The player's account on this device: name, guest wallet and party record. Play money for now; the wallet
 * moves on-chain later (never trusted from the client for real rewards).
 */
export interface Profile {
  name: string;
  wallet: number;
  nights: number;
  totalPnl: number;
  bestPnl: number;
  setName(name: string): void;
  /** Back from a night out: the wallet becomes what the player walked out with. */
  settle(value: number, pnl: number): void;
  /** A broke guest can claim the starter wallet again. */
  refill(): void;
}

const START = strategy.visitor.startWallet;
export const canRefill = (wallet: number) => wallet < START / 10;

export const useProfile = create<Profile>()(
  persist(
    (set) => ({
      name: "",
      wallet: START,
      nights: 0,
      totalPnl: 0,
      bestPnl: 0,
      setName: (name) => set({ name: name.slice(0, 20) }),
      settle: (value, pnl) =>
        set((p) => ({
          wallet: value,
          nights: p.nights + 1,
          totalPnl: p.totalPnl + pnl,
          bestPnl: p.nights ? Math.max(p.bestPnl, pnl) : pnl,
        })),
      refill: () => set((p) => (canRefill(p.wallet) ? { wallet: START } : {})),
    }),
    { name: "nyxeron:profile" },
  ),
);
