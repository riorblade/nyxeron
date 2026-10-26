import { Lock, Shirt, Shuffle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  CELEBRATION_IDS,
  celebrationOf,
  decodeAvatar,
  encodeAvatar,
  equip,
  itemOf,
  itemsFor,
  legacyAvatar,
  priceOf,
  randomAvatar,
  SLOTS,
  unowned,
  wardrobe,
  type Avatar,
  type Slot,
  type SkinId,
} from "@nyxeron/core";
import { AvatarPreview } from "@/avatar/AvatarPreview";
import { DANCES, isCelebration, type Move } from "@/avatar/moves";
import { en } from "@/i18n/en";
import { cn, trapFocus } from "@/lib/utils";
import { player } from "@/api/player";
import { SHOP_FLOOR, useProfile } from "@/state/profile";

const t = en.wardrobe;
type Tab = "skin" | Slot | "celebrations";
const REQUIRED = wardrobe.required as Slot[];

/** The player's current outfit (an old sprite pick until they save one). */
export const useLook = (): Avatar => {
  const look = useProfile((p) => p.look);
  const avatar = useProfile((p) => p.avatar);
  return useMemo(
    () => decodeAvatar(look, legacyAvatar(avatar)),
    [look, avatar],
  );
};

/** Mix and match skin and items on a dancing preview; saves to the profile (the clubs show it). */
export function Wardrobe({ onClose }: { onClose(): void }) {
  const saved = useLook();
  const [draft, setDraft] = useState<Avatar>(saved);
  const [tab, setTab] = useState<Tab>("shirt");
  const [move, setMove] = useState<Move | "auto">("auto");
  const owned = useProfile((p) => p.owned);
  const wallet = useProfile((p) => p.wallet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const missing = unowned(draft, owned);
  const total = missing.reduce((n, id) => n + priceOf(id), 0);
  const short = total > 0 && wallet - total < SHOP_FLOOR;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = async () => {
    setError("");
    if (missing.length) {
      setBusy(true);
      const ok = await player.buy(
        missing.map((id) => ({ id, price: priceOf(id) })),
      );
      setBusy(false);
      if (!ok) return setError(t.buyFailed);
    }
    player.setLook(encodeAvatar(draft));
    onClose();
  };
  const tabs: Tab[] = ["skin", ...SLOTS, "celebrations"];

  // A portal: the glass panels it opens from use backdrop-filter, which would trap a fixed overlay inside them.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={t.title}
        onKeyDown={trapFocus}
        onClick={(e) => e.stopPropagation()}
        className="glass glow enter flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <Shirt className="size-4" /> {t.title}
          </h2>
          <button
            className="flex size-8 items-center justify-center rounded-md hover:bg-white/10"
            onClick={onClose}
            aria-label={t.close}
            autoFocus
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 md:grid-cols-[300px_1fr]">
          <div className="flex flex-col gap-3">
            <AvatarPreview
              look={draft}
              move={move}
              className="tile aspect-[3/4] w-full overflow-hidden rounded-xl"
            />
            <div className="flex flex-wrap gap-1.5">
              {(["auto", ...DANCES] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMove(m)}
                  aria-pressed={move === m}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px]",
                    move === m
                      ? "gold"
                      : "border-white/15 text-white/70 hover:bg-white/10",
                  )}
                >
                  {t.moves[m]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap gap-1.5" role="tablist">
              {tabs.map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs",
                    tab === k
                      ? "gold"
                      : "border-white/15 text-white/75 hover:bg-white/10",
                  )}
                >
                  {t.tabs[k]}
                </button>
              ))}
            </div>

            {tab === "celebrations" ? (
              <Celebrations
                move={move}
                setMove={setMove}
                owned={owned}
                wallet={wallet}
              />
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {tab === "skin"
                  ? (Object.entries(wardrobe.skins) as [SkinId, string][]).map(
                      ([id, color]) => (
                        <Swatch
                          key={id}
                          label={id}
                          colors={[color]}
                          on={draft.skin === id}
                          pick={() => setDraft({ ...draft, skin: id })}
                        />
                      ),
                    )
                  : [
                      ...(REQUIRED.includes(tab)
                        ? []
                        : [
                            <Swatch
                              key="none"
                              label={t.none}
                              colors={[]}
                              on={!draft.items[tab]}
                              pick={() => setDraft(equip(draft, tab, null))}
                            />,
                          ]),
                      ...itemsFor(tab).map((id) => {
                        const it = itemOf(id);
                        const price = priceOf(id);
                        return (
                          <Swatch
                            key={id}
                            label={it.name}
                            tag={
                              price
                                ? owned.includes(id)
                                  ? t.owned
                                  : t.price(price)
                                : undefined
                            }
                            locked={price > 0 && !owned.includes(id)}
                            colors={
                              it.accent ? [it.color, it.accent] : [it.color]
                            }
                            on={draft.items[tab] === id}
                            pick={() => setDraft(equip(draft, tab, id))}
                          />
                        );
                      }),
                    ]}
              </div>
            )}
            <p className="text-[11px] text-white/50">{t.beta}</p>
            <p className="text-xs text-white/70">{t.wallet(wallet)}</p>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-5 py-3">
          <button
            className="flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
            onClick={() =>
              setDraft(
                randomAvatar(
                  (Math.random() * 2 ** 31) | 0,
                  Math.random() < 0.5,
                ),
              )
            }
          >
            <Shuffle className="size-4" /> {t.random}
          </button>
          {(error || short) && (
            <p
              role="alert"
              className="order-first basis-full text-xs sm:order-none sm:basis-0 sm:flex-1 text-rose-300"
            >
              {error || t.floor(SHOP_FLOOR)}
            </p>
          )}
          <div className="ml-auto flex shrink-0 gap-2">
            <button
              className="rounded-lg px-3 py-2 text-sm text-white/70 hover:bg-white/10"
              onClick={onClose}
            >
              {t.cancel}
            </button>
            <button
              className="gold rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
              onClick={save}
              disabled={busy || short}
            >
              {total ? t.buySave(total) : t.save}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** Shop moves: try one on the preview, buy it here (it isn't part of the look, so it doesn't wait for Save). */
function Celebrations({
  move,
  setMove,
  owned,
  wallet,
}: {
  move: Move | "auto";
  setMove(m: Move | "auto"): void;
  owned: string[];
  wallet: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pick = move !== "auto" && isCelebration(move) ? move : null;
  const price = pick ? celebrationOf(pick).price : 0;
  const has = pick ? owned.includes(pick) : false;
  const short = !!pick && !has && wallet - price < SHOP_FLOOR;
  const buy = async () => {
    if (!pick) return;
    setError("");
    setBusy(true);
    const ok = await player.buy([{ id: pick, price }]);
    setBusy(false);
    if (!ok) setError(t.buyFailed);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {CELEBRATION_IDS.map((id) => (
          <Swatch
            key={id}
            label={t.moves[id]}
            colors={
              id === "makeItRain"
                ? ["#3fae5a", "#d9f99d"]
                : ["#f5b301", "#76b900"]
            }
            on={pick === id}
            pick={() => setMove(id)}
            tag={
              owned.includes(id) ? t.owned : t.price(celebrationOf(id).price)
            }
            locked={!owned.includes(id)}
          />
        ))}
      </div>
      <p className="text-xs text-white/70">
        {pick ? t.celebrationHint[pick] : t.celebrationsNote}
      </p>
      {pick && !has && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="gold rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            onClick={buy}
            disabled={busy || short}
          >
            {t.buy(price)}
          </button>
          {(error || short) && (
            <p role="alert" className="text-xs text-rose-300">
              {error || t.floor(SHOP_FLOOR)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Swatch({
  label,
  colors,
  on,
  pick,
  tag,
  locked,
}: {
  label: string;
  colors: string[];
  on: boolean;
  pick(): void;
  /** A shop item: its price, or "Owned". */
  tag?: string;
  locked?: boolean;
}) {
  return (
    <button
      onClick={pick}
      aria-pressed={on}
      className={cn(
        "tile flex flex-col items-center gap-2 rounded-xl px-2 py-3 text-center text-[11px] capitalize transition",
        on
          ? "border-[oklch(0.92_0.1_85)] shadow-[0_0_16px_oklch(0.8_0.16_75/0.45)]"
          : "opacity-80 hover:opacity-100",
      )}
    >
      <span className="flex size-9 overflow-hidden rounded-full border border-white/25">
        {colors.length ? (
          colors.map((c) => (
            <span key={c} className="h-full flex-1" style={{ background: c }} />
          ))
        ) : (
          <X className="m-auto size-4 text-white/50" />
        )}
      </span>
      <span className="leading-tight text-white/85">{label}</span>
      {tag && (
        <span
          className={cn(
            "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] normal-case",
            locked ? "gold" : "bg-white/10 text-white/70",
          )}
        >
          {locked && <Lock className="size-2.5" />}
          {tag}
        </span>
      )}
    </button>
  );
}
