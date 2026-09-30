import {
  marketOf,
  marketPrice,
  orderCost,
  tokens,
  type GameState,
  type TokenId,
} from "@nyxeron/core";
import { Package, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { en, fmt } from "@/i18n/en";
import { trapFocus } from "@/lib/utils";

/** Full-screen card for one token: live price against list, tonight's chart, and what it tracks. */
export function TokenDetail({
  s,
  id,
  onClose,
}: {
  s: GameState;
  id: TokenId;
  onClose: () => void;
}) {
  const info = en.tokenInfo[id]!;
  const t = en.tokenDetail;
  const tk = tokens[id];
  const cost = orderCost(id, 1, "corner", s.level);
  const list = s.prices[id];
  const live = marketPrice(s, id);
  const change = Math.round((marketOf(s.night, id) - 1) * 1000) / 10;
  const margin = live > 0 ? Math.round(((live - cost) / live) * 100) : 0;
  const hist = s.night?.marketHist?.[id] ?? [];

  useEffect(() => {
    // Capture phase, so Esc closes the card instead of opening the pause menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Portal: glass panels use backdrop-filter, which would otherwise trap a fixed overlay inside them.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        onKeyDown={trapFocus}
        aria-label={`${t.title}: ${tk.name}`}
        className="glass glow enter grid max-h-[92dvh] w-full max-w-4xl grid-cols-1 overflow-y-auto rounded-2xl md:grid-cols-[17rem_1fr] md:overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="flex flex-col gap-4 border-b border-white/10 p-5 md:max-h-[85vh] md:overflow-y-auto md:border-r md:border-b-0">
          <div className="hidden aspect-video overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] sm:flex items-center justify-center">
            <Img
              src={art.token(id)}
              alt=""
              className={
                tk.kind === "basket"
                  ? "size-full object-cover"
                  : "size-[60%] object-contain"
              }
              fallback={<Package className="size-10 text-white/30" />}
            />
          </div>
          <div>
            <div className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
              {tk.kind === "basket" ? t.basket : t.stock} · {tk.ticker}
            </div>
            <h2 className="mt-1 text-2xl font-medium tracking-[-0.02em]">
              {tk.name}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/70">
              {info.about}
            </p>
          </div>
          <dl className="space-y-1.5 text-sm">
            <Stat label={t.inStock}>
              {tk.minLevel > s.level ? t.unlock(tk.minLevel) : s.stock[id]}
            </Stat>
            <Stat label={t.cost}>{fmt(cost)} C</Stat>
            <Stat label={t.list}>{fmt(list)} C</Stat>
            <Stat label={t.live}>{fmt(live)} C</Stat>
            <Stat label={t.change}>
              {change > 0 ? "▲ +" : change < 0 ? "▼ " : ""}
              {change}%
            </Stat>
            <Stat label={t.margin}>{margin}%</Stat>
            <Stat label={t.fomo}>+{tk.fomo}</Stat>
          </dl>
        </aside>

        <section className="flex min-h-0 flex-col">
          <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <h3 className="text-[10px] tracking-[0.3em] text-white/55 uppercase">
              {t.chart}
            </h3>
            <button
              className="flex size-8 items-center justify-center rounded-md hover:bg-white/10"
              onClick={onClose}
              aria-label={t.close}
              autoFocus
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="space-y-5 p-5 md:max-h-[70vh] md:overflow-y-auto">
            {hist.length > 1 ? (
              <Sparkline points={hist} className="h-40 w-full" />
            ) : (
              <p className="text-sm text-white/60">{t.chartIdle}</p>
            )}
            {info.legs.length > 0 && (
              <div>
                <h4 className="mb-2 text-[10px] tracking-[0.3em] text-white/55 uppercase">
                  {t.legs}
                </h4>
                <ul className="space-y-1.5">
                  {info.legs.map(([ticker, w]) => (
                    <li
                      key={ticker}
                      className="grid grid-cols-[4rem_1fr_2.5rem] items-center gap-3 text-sm"
                    >
                      <span className="font-mono">{ticker}</span>
                      <span className="h-1.5 overflow-hidden rounded-full bg-white/10">
                        <span
                          className="block h-full bg-white"
                          style={{ width: `${w}%` }}
                        />
                      </span>
                      <span className="text-right font-mono text-xs text-white/60">
                        {w}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3.5">
              <h4 className="text-[10px] tracking-[0.3em] text-white/55 uppercase">
                {t.rails}
              </h4>
              <p className="mt-1 text-sm text-white/70">{t.railsNote}</p>
              <div className="mt-3 flex items-center gap-4 opacity-80 grayscale">
                {["xstocks.webp", "ondo.webp", "bstocks.svg", "bnb.webp"].map(
                  (f) => (
                    <img
                      key={f}
                      src={`/logos/${f}`}
                      alt=""
                      loading="lazy"
                      className="h-6 w-auto"
                    />
                  ),
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

/** What a token sells for right now, with its move against list price. */
export function LivePrice({ s, id }: { s: GameState; id: TokenId }) {
  const change = Math.round((marketOf(s.night, id) - 1) * 1000) / 10;
  return (
    <span className="tabular-nums">
      {fmt(marketPrice(s, id))} C
      {change !== 0 && (
        <span className="ml-1 text-white/55">
          {change > 0 ? "▲" : "▼"}
          {Math.abs(change)}%
        </span>
      )}
    </span>
  );
}

/** Tonight's price line; the dashed line is list price. */
export function Sparkline({
  points,
  className,
}: {
  points: number[];
  className?: string;
}) {
  const lo = Math.min(1, ...points);
  const hi = Math.max(1, ...points);
  const span = hi - lo || 1;
  const y = (v: number) => 100 - ((v - lo) / span) * 100;
  const d = points
    .map((v, i) => `${(i / (points.length - 1)) * 100},${y(v).toFixed(2)}`)
    .join(" ");
  return (
    <svg
      viewBox="0 -2 100 104"
      preserveAspectRatio="none"
      className={className}
      aria-hidden
    >
      <line
        x1="0"
        x2="100"
        y1={y(1)}
        y2={y(1)}
        stroke="rgba(255,255,255,.25)"
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={d}
        fill="none"
        stroke="white"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/50">{label}</dt>
      <dd className="font-mono text-[13px]">{children}</dd>
    </div>
  );
}

/** Wraps a token's name/thumbnail so clicking it opens the detail card. */
export function TokenLink({
  s,
  id,
  children,
  className,
}: {
  s: GameState;
  id: TokenId;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={
          className ??
          "flex min-w-0 items-center gap-3 text-left hover:underline"
        }
        onClick={() => setOpen(true)}
        title={en.tokenDetail.open}
      >
        {children}
      </button>
      {open && <TokenDetail s={s} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}
