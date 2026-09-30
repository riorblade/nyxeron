import { strategy, type TokenId } from "@nyxeron/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The player's account on this device: name, guest wallet and party record. Play money for now; the wallet
 * moves on-chain later (never trusted from the client for real rewards).
 */
export interface Profile {
  name: string;
  /** Guest sprite 1–10 (1–5 men, 6–10 women). */
  avatar: number;
  wallet: number;
  /** Tokens bought on nights out (guests only buy, so they keep them): units and total paid. */
  portfolio: Partial<Record<TokenId, { qty: number; cost: number }>>;
  nights: number;
  totalPnl: number;
  bestPnl: number;
  setName(name: string): void;
  setAvatar(avatar: number): void;
  /** Back from a night out: the cash left becomes the wallet and the tokens bought join the portfolio. */
  settle(
    cash: number,
    bought: Partial<Record<TokenId, { qty: number; cost: number }>>,
    pnl: number,
  ): void;
  /** A broke guest can claim the starter wallet again. */
  refill(): void;
}

const START = strategy.visitor.startWallet;
export const canRefill = (wallet: number) => wallet < START / 10;

export const useProfile = create<Profile>()(
  persist(
    (set) => ({
      name: "",
      avatar: 1,
      wallet: START,
      portfolio: {},
      nights: 0,
      totalPnl: 0,
      bestPnl: 0,
      setName: (name) => set({ name: name.slice(0, 20) }),
      setAvatar: (avatar) => set({ avatar }),
      settle: (cash, bought, pnl) =>
        set((p) => {
          const portfolio = { ...p.portfolio };
          for (const [t, b] of Object.entries(bought)) {
            const had = portfolio[t as TokenId] ?? { qty: 0, cost: 0 };
            portfolio[t as TokenId] = {
              qty: had.qty + b!.qty,
              cost: had.cost + b!.cost,
            };
          }
          return {
            wallet: cash,
            portfolio,
            nights: p.nights + 1,
            totalPnl: p.totalPnl + pnl,
            bestPnl: p.nights ? Math.max(p.bestPnl, pnl) : pnl,
          };
        }),
      refill: () => set((p) => (canRefill(p.wallet) ? { wallet: START } : {})),
    }),
    { name: "nyxeron:profile" },
  ),
);
