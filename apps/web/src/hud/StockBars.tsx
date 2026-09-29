import { drinks, ids, type GameState } from "@nyxeron/core";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { DrinkLink } from "./DrinkDetail";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";

/** Bars are relative to 150 units; below 20% the bar blinks (GDD 12: alert when stock < 20%). */
const FULL = 150;

export function StockBars({ s }: { s: GameState }) {
  const menu = ids(drinks).filter((d) => drinks[d].minLevel <= s.level);
  const low = menu.filter((d) => s.stock[d] < FULL * 0.2);
  return (
    <section>
      <h3 className="mb-2 text-[10px] tracking-widest text-muted-foreground">
        {en.night.stock}
      </h3>
      <ul className="space-y-1.5">
        {menu.map((d) => {
          const pct = Math.min(100, (s.stock[d] / FULL) * 100);
          return (
            <li
              key={d}
              className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-2 text-xs"
            >
              <DrinkLink
                s={s}
                id={d}
                className="flex items-center gap-2 text-left hover:underline"
              >
                <Img
                  src={art.drink(d)}
                  alt=""
                  className="size-6 object-contain"
                  fallback={<span className="size-6" />}
                />
                <span>{drinks[d].name}</span>
              </DrinkLink>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-foreground transition-all",
                    pct < 20 && "animate-pulse bg-muted-foreground",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-right font-mono tabular-nums">
                {s.stock[d]}
              </span>
            </li>
          );
        })}
      </ul>
      {low.length > 0 && (
        <p className="mt-2 text-xs">
          ⚠ {en.stock.low(low.map((d) => drinks[d].name).join(", "))}
        </p>
      )}
    </section>
  );
}
