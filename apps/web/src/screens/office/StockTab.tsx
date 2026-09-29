import {
  defaultPrice,
  drinks,
  ids,
  orderCost,
  r01_orderStock,
  setPrice,
  stockForecast,
  stockHeld,
  storageOf,
  suppliers,
  type DrinkId,
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
import { useState } from "react";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { DrinkLink } from "@/hud/DrinkDetail";
import { en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

const supplierIcon = { corner: Store, wholesale: Truck, import: Ship } as const;

function Thumb({ id, size = "size-11" }: { id: DrinkId; size?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]",
        size,
      )}
    >
      <Img
        src={art.drink(id)}
        alt=""
        className="size-[85%] object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,.8)]"
        fallback={<Package className="size-4 text-white/50" />}
      />
    </span>
  );
}

const orderBtn =
  "h-8 rounded-md border border-white/15 bg-white/[0.04] px-2.5 font-mono text-xs hover:bg-white/12 disabled:opacity-40";

export function StockTab({ s, compact }: { s: GameState; compact?: boolean }) {
  const act = useGame((x) => x.act);
  // Instant supplier by default: tonight's needs must arrive tonight. Cheaper, slower ones are an informed choice.
  const [supplier, setSupplier] = useState<SupplierId>("corner");
  const order = (d: DrinkId, qty: number) =>
    act((g) => r01_orderStock(g, d, qty, supplier));
  const need = stockForecast(s);
  const shortfall = (d: DrinkId) => Math.max(0, (need[d] ?? 0) - s.stock[d]);
  const fill = () => {
    for (const d of ids(drinks))
      if (shortfall(d) > 0 && !order(d, shortfall(d))) break;
  };
  const menu = ids(drinks);

  // Night side panel: compact list, instant supplier only.
  if (compact)
    return (
      <ul className="space-y-1.5">
        {menu
          .filter((d) => drinks[d].minLevel <= s.level)
          .map((d) => (
            <li key={d} className="flex items-center gap-2.5">
              <DrinkLink
                s={s}
                id={d}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:[&_.nm]:underline"
              >
                <Thumb id={d} size="size-8" />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="nm truncate text-sm">{drinks[d].name}</div>
                  <div className="font-mono text-[11px] text-white/60">
                    {s.stock[d]} · {fmt(orderCost(d, 1, supplier, s.level))} C
                  </div>
                </div>
              </DrinkLink>
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
                "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                on
                  ? "border-white bg-white/[0.09] shadow-[0_0_24px_rgba(255,255,255,.1)]"
                  : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]",
                locked && "opacity-40",
              )}
            >
              <span
                className={cn(
                  "flex size-10 items-center justify-center rounded-lg",
                  on ? "bg-white text-black" : "bg-white/8",
                )}
              >
                {locked ? (
                  <Lock className="size-4" />
                ) : (
                  <Icon className="size-5" strokeWidth={1.75} />
                )}
              </span>
              <span className="leading-tight">
                <span className="block text-sm font-medium">{sp.name}</span>
                <span className="block text-[11px] text-white/50">
                  {locked
                    ? en.office.lockedTab(sp.minLevel)
                    : `${en.stock.lead(sp.leadDays)} · ×${sp.costMultiplier}`}
                </span>
              </span>
            </button>
          );
        })}
        <button
          onClick={fill}
          disabled={
            !menu.some((d) => drinks[d].minLevel <= s.level && shortfall(d) > 0)
          }
          className="flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-medium @xl:h-auto text-black shadow-[0_0_24px_rgba(255,255,255,.18)] disabled:bg-white/10 disabled:text-white/60 disabled:shadow-none"
        >
          <RefreshCw className="size-4" />
          {en.stock.fill}
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
          const dr = drinks[d];
          const locked = dr.minLevel > s.level;
          const n = need[d] ?? 0;
          const short = shortfall(d);
          return (
            <li
              key={d}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] gap-y-2 @xl:gap-y-0 @xl:grid-cols-[minmax(8rem,1.2fr)_minmax(4rem,1fr)_7.5rem_auto] @2xl:grid-cols-[minmax(10rem,1.4fr)_minmax(0,1fr)_5rem_7.5rem_auto] @3xl:grid-cols-[minmax(12rem,1.4fr)_1fr_6rem_5.5rem_8rem_auto] items-center gap-x-4 rounded-xl border border-white/8 bg-white/[0.025] px-3 py-2 transition-colors hover:bg-white/[0.05]",
                locked && "opacity-40",
              )}
            >
              <DrinkLink s={s} id={d}>
                <Thumb id={d} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{dr.name}</span>
                  {!locked && (
                    <span className="block font-mono text-xs @xl:hidden">
                      <StockCount have={s.stock[d]} need={n} />
                    </span>
                  )}
                </span>
              </DrinkLink>
              <span className="hidden font-mono text-sm tabular-nums @xl:block">
                {locked ? "—" : <StockCount have={s.stock[d]} need={n} />}
              </span>
              <span
                className={cn(
                  "hidden items-center gap-1 font-mono text-sm @2xl:flex",
                  short ? "text-white" : "text-white/55",
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
                {fmt(orderCost(d, 1, supplier, s.level))}
              </span>
              {/* Phones: the price stepper gets its own row under the drink. */}
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
                {o.qty} {drinks[o.drink].name} ·{" "}
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
      <span className="text-[10px] tracking-[0.2em] whitespace-nowrap text-white/60 uppercase">
        {en.storage.label}
      </span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <span
          className={cn(
            "block h-full rounded-full bg-white",
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

/** Drag to set a drink's price: 50%–300% of this venue's standard price. */
function PriceSlider({ s, d }: { s: GameState; d: DrinkId }) {
  const act = useGame((x) => x.act);
  const std = defaultPrice(d, s.level);
  const min = Math.max(1, Math.round(std * 0.5));
  const max = Math.round(std * 3);
  const price = s.prices[d];
  return (
    <span className="flex w-full flex-col gap-1">
      <span className="flex items-baseline justify-between font-mono text-xs tabular-nums">
        <span>{fmt(price)}</span>
        <span className="text-white/50">
          {Math.round((price / std) * 100)}%
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={Math.max(1, Math.round(std * 0.01))}
        value={Math.min(max, Math.max(min, price))}
        onChange={(e) => act((g) => setPrice(g, d, Number(e.target.value)))}
        aria-label={`${drinks[d].name} price`}
        className="w-full accent-white"
      />
    </span>
  );
}
