import {
  spotFactor,
  spotUnitCost,
  standardPrice,
  strategy,
  tokens,
  ids,
  orderCost,
  r01_orderStock,
  setPrice,
  stockForecast,
  stockHeld,
  storageOf,
  suppliers,
  type TokenId,
  type GameState,
  type SupplierId,
} from "@nyxeron/core";
import {
  ArrowDown,
  Check,
  Lock,
  Package,
  RefreshCw,
  Ship,
  Store,
  Truck,
} from "lucide-react";
import { useState, type CSSProperties } from "react";
import { art } from "@/lib/art";
import { Img } from "@/components/Img";
import { LivePrice, TokenLink } from "@/hud/TokenDetail";
import { useQuotes } from "@/api/quotes";
import { en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/state/store";

const supplierIcon = { corner: Store, wholesale: Truck, import: Ship } as const;

function Thumb({ id, size = "size-11" }: { id: TokenId; size?: string }) {
  return (
    <span
      className={cn(
        "border-violet/40 flex shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-gradient-to-br from-violet/25 to-night shadow-[0_0_12px_oklch(0.6_0.25_300/0.25)]",
        size,
      )}
    >
      <Img
        src={art.token(id)}
        alt=""
        className={
          tokens[id].kind === "basket"
            ? "size-full object-cover"
            : "size-[85%] object-contain"
        }
        fallback={<Package className="size-4 text-white/50" />}
      />
    </span>
  );
}

const orderBtn =
  "h-9 rounded-lg border border-violet/45 bg-violet/15 px-3 font-mono text-xs font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,.08)] hover:border-gold/70 hover:bg-gold/15 hover:text-gold disabled:opacity-40";

export function StockTab({ s, compact }: { s: GameState; compact?: boolean }) {
  const act = useGame((x) => x.act);
  // Instant supplier by default: tonight's needs must arrive tonight. Cheaper, slower ones are an informed choice.
  const [supplier, setSupplier] = useState<SupplierId>("corner");
  const order = (d: TokenId, qty: number) =>
    act((g) => r01_orderStock(g, d, qty, supplier));
  const need = stockForecast(s);
  const shortfall = (d: TokenId) => Math.max(0, (need[d] ?? 0) - s.stock[d]);
  const fill = () => {
    for (const d of ids(tokens))
      if (shortfall(d) > 0 && !order(d, shortfall(d))) break;
  };
  const menu = ids(tokens);

  // Night side panel: compact list, instant supplier only.
  if (compact)
    return (
      <ul className="space-y-1.5">
        {menu
          .filter((d) => tokens[d].minLevel <= s.level)
          .map((d) => (
            <li key={d} className="flex items-center gap-2.5">
              <TokenLink
                s={s}
                id={d}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:[&_.nm]:underline"
              >
                <Thumb id={d} size="size-8" />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="nm truncate text-sm">{tokens[d].name}</div>
                  <div className="font-mono text-[11px] text-white/60">
                    {s.stock[d]} · <LivePrice s={s} id={d} />
                  </div>
                </div>
              </TokenLink>
              {[10, 50].map((q) => (
                <button
                  key={q}
                  className={orderBtn}
                  onClick={() => order(d, q)}
                >
                  +{q}
                </button>
              ))}
            </li>
          ))}
      </ul>
    );

  return (
    // Container query: the table drops columns as the panel narrows (need, cost, then the stock bar).
    <div className="space-y-5 @container">
      <StorageMeter s={s} />
      <SpotSource />
      <div className="grid grid-cols-1 gap-2.5 @xl:grid-cols-[repeat(3,1fr)_auto]">
        {ids(suppliers).map((id) => {
          const sp = suppliers[id];
          const Icon = supplierIcon[id];
          const locked = sp.minLevel > s.level;
          const on = supplier === id;
          return (
            <button
              key={id}
              disabled={locked}
              onClick={() => setSupplier(id)}
              className={cn(
                "group relative flex min-h-24 flex-col justify-end overflow-hidden rounded-xl border text-left transition @xl:min-h-36",
                on
                  ? "border-gold shadow-[0_0_24px_oklch(0.8_0.16_75/0.45)]"
                  : "border-violet/35 hover:border-violet/70",
                locked && "opacity-40",
              )}
            >
              <Img
                src={art.ui.supplier(id)}
                alt=""
                className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              <span className="from-night via-night/60 absolute inset-0 bg-gradient-to-t to-transparent" />
              <span className="relative flex items-center gap-2.5 p-2.5">
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    on ? "gold" : "chip",
                  )}
                  style={{ "--hue": 300 } as CSSProperties}
                >
                  {locked ? (
                    <Lock className="size-4" />
                  ) : (
                    <Icon className="size-[18px]" strokeWidth={1.75} />
                  )}
                </span>
                <span className="leading-tight">
                  <span className="block text-sm font-semibold">{sp.name}</span>
                  <span className="text-gold/90 block text-[11px]">
                    {locked
                      ? en.office.lockedTab(sp.minLevel)
                      : `${en.stock.lead(sp.leadDays)} · ×${sp.costMultiplier}`}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
        <button
          onClick={fill}
          disabled={
            !menu.some((d) => tokens[d].minLevel <= s.level && shortfall(d) > 0)
          }
          className="group relative flex h-14 items-center justify-center gap-2 overflow-hidden rounded-xl border border-violet/60 bg-gradient-to-br from-violet/45 via-neon/25 to-night px-4 text-sm font-semibold shadow-[0_0_24px_oklch(0.6_0.25_300/0.4)] @xl:h-auto @xl:min-w-40 @xl:flex-col disabled:opacity-50"
        >
          <Img
            src={art.ui.crate}
            alt=""
            className="pointer-events-none hidden w-24 drop-shadow-[0_0_18px_oklch(0.7_0.2_300/0.7)] transition-transform group-hover:scale-110 @xl:block"
            fallback={<RefreshCw className="size-6" />}
          />
          <span className="flex items-center gap-2">
            <RefreshCw className="size-4 @xl:hidden" />
            {en.stock.fill}
          </span>
        </button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-y-2 @xl:gap-y-0 @xl:grid-cols-[minmax(8rem,1.2fr)_minmax(4rem,1fr)_7.5rem_auto] @2xl:grid-cols-[minmax(10rem,1.4fr)_minmax(0,1fr)_5rem_7.5rem_auto] @3xl:grid-cols-[minmax(12rem,1.4fr)_1fr_6rem_5.5rem_8rem_auto] items-center gap-x-4 px-3 text-[10px] tracking-[0.2em] text-white/60 uppercase">
        <span>{en.stock.drink}</span>
        <span className="hidden @xl:block">{en.stock.inStock}</span>
        <span className="hidden @2xl:block" title={en.stock.needHint}>
          {en.stock.need}
        </span>
        <span className="hidden @3xl:block">{en.stock.cost}</span>
        <span className="hidden @xl:block">{en.stock.price}</span>
        <span className="text-right">{en.stock.order}</span>
      </div>
      <ul className="space-y-1.5">
        {menu.map((d) => {
          const dr = tokens[d];
          const locked = dr.minLevel > s.level;
          const n = need[d] ?? 0;
          const short = shortfall(d);
          return (
            <li
              key={d}
              className={cn(
                "tile grid grid-cols-[minmax(0,1fr)_auto] gap-y-2 @xl:gap-y-0 @xl:grid-cols-[minmax(8rem,1.2fr)_minmax(4rem,1fr)_7.5rem_auto] @2xl:grid-cols-[minmax(10rem,1.4fr)_minmax(0,1fr)_5rem_7.5rem_auto] @3xl:grid-cols-[minmax(12rem,1.4fr)_1fr_6rem_5.5rem_8rem_auto] items-center gap-x-4 rounded-xl px-3 py-2.5 transition hover:border-violet/60 hover:shadow-[0_0_18px_oklch(0.6_0.25_300/0.25)]",
                locked && "opacity-40",
              )}
            >
              <TokenLink s={s} id={d}>
                <Thumb id={d} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{dr.name}</span>
                  <span className="block font-mono text-[11px] text-white/55">
                    {dr.ticker}
                  </span>
                  {!locked && (
                    <span className="block font-mono text-xs @xl:hidden">
                      <StockCount have={s.stock[d]} need={n} />
                    </span>
                  )}
                </span>
              </TokenLink>
              <span className="hidden font-mono text-sm tabular-nums @xl:block">
                {locked ? "—" : <StockCount have={s.stock[d]} need={n} />}
              </span>
              <span
                className={cn(
                  "hidden items-center gap-1 font-mono text-sm font-semibold @2xl:flex",
                  short ? "text-gold" : "text-cyan/80",
                )}
              >
                {!locked &&
                  (short ? (
                    <>
                      <ArrowDown className="size-3.5" />
                      {short}
                    </>
                  ) : (
                    <>
                      {n} <Check className="size-3.5" />
                    </>
                  ))}
              </span>
              <span className="hidden font-mono text-sm text-white/70 tabular-nums @3xl:block">
                {fmt(orderCost(d, 1, supplier, s.level, spotFactor(s, d)))}
              </span>
              {/* Phones: the price stepper gets its own row under the token. */}
              <span className="order-last col-span-2 flex items-center gap-1 @xl:order-none @xl:col-span-1">
                {!locked && <PriceSlider s={s} d={d} />}
              </span>
              <span className="flex justify-end gap-1.5">
                {locked ? (
                  <span className="flex items-center gap-1 text-xs">
                    <Lock className="size-3" />{" "}
                    {en.office.lockedTab(dr.minLevel)}
                  </span>
                ) : (
                  [10, 50].map((q) => (
                    <button
                      key={q}
                      className={orderBtn}
                      onClick={() => order(d, q)}
                    >
                      +{q}
                    </button>
                  ))
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {s.pendingOrders.length > 0 && (
        <div className="rounded-xl border border-dashed border-white/15 p-3">
          <h4 className="mb-2 flex items-center gap-2 text-[10px] tracking-[0.2em] text-white/60 uppercase">
            <Truck className="size-3.5" /> {en.stock.pending}
          </h4>
          <ul className="flex flex-wrap gap-2 text-sm">
            {s.pendingOrders.map((o, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-lg bg-white/[0.05] py-1 pr-3 pl-1"
              >
                <Thumb id={o.drink} size="size-7" />
                {o.qty} {tokens[o.drink].name} ·{" "}
                {en.stock.arrives(o.arrivesDay)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Stock room fill: on hand + on order against the room's size. */
function StorageMeter({ s }: { s: GameState }) {
  const used = stockHeld(s);
  const max = storageOf(s);
  const pct = Math.min(100, (used / max) * 100);
  return (
    <div className="flex items-center gap-3" title={en.storage.hint}>
      <span className="text-gold text-[10px] font-semibold tracking-[0.2em] whitespace-nowrap uppercase">
        {en.storage.label}
      </span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
        <span
          className={cn(
            "from-gold-deep to-gold block h-full rounded-full bg-gradient-to-r shadow-[0_0_10px_oklch(0.8_0.16_75/0.7)]",
            pct > 90 && "animate-pulse",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="font-mono text-xs text-white/70 tabular-nums">
        {en.storage.value(used, max)}
      </span>
    </div>
  );
}

/** "20 / 50": in stock against tonight's forecast (dim when short). */
function StockCount({ have, need }: { have: number; need: number }) {
  return (
    <>
      <span
        className={cn(need && have < need ? "text-white/60" : "text-white")}
      >
        {fmt(have)}
      </span>
      {need > 0 && <span className="text-white/45"> / {fmt(need)}</span>}
    </>
  );
}

/** Drag to set a token's sale price (50%–300% of the standard, which follows spot); shows the markup over spot. */
function PriceSlider({ s, d }: { s: GameState; d: TokenId }) {
  const act = useGame((x) => x.act);
  const std = standardPrice(s, d);
  const markup = Math.round((s.prices[d] / spotUnitCost(s, d) - 1) * 100);
  const min = Math.max(1, Math.round(std * 0.5));
  const max = Math.round(std * 3);
  const price = s.prices[d];
  return (
    <span className="flex w-full flex-col gap-1">
      <span className="flex items-baseline justify-between font-mono text-xs tabular-nums">
        <span>{fmt(price)}</span>
        <span className="text-emerald-300/90" title={en.spot.markupHint}>
          {en.spot.markup(markup)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={Math.max(1, Math.round(std * 0.01))}
        value={Math.min(max, Math.max(min, price))}
        onChange={(e) => act((g) => setPrice(g, d, Number(e.target.value)))}
        aria-label={`${tokens[d].name} price`}
        className="accent-cyan w-full"
      />
    </span>
  );
}

/** Where the CEO's costs come from: live spot (Binance RWA) or the game's own numbers, and the platform's cut. */
function SpotSource() {
  const { live, at } = useQuotes();
  return (
    <p className="tile flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-xs text-white/75">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 rounded-full",
            live
              ? "animate-pulse bg-emerald-400 shadow-[0_0_8px_#34d399]"
              : "bg-gold/70",
          )}
        />
        {live ? en.spot.live(new Date(at)) : en.spot.offline}
      </span>
      <span className="text-white/50">
        {en.spot.fee(Math.round(strategy.platform.feeShare * 100))}
      </span>
    </p>
  );
}
