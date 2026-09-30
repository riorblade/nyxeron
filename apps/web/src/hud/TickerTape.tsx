import {
  ids,
  marketOf,
  marketPrice,
  tokens,
  type GameState,
} from "@nyxeron/core";
import { en, fmt } from "@/i18n/en";
import { TokenLink } from "./TokenDetail";

/** Scrolling strip of tonight's token prices. Two copies back to back so the loop is seamless. */
export function TickerTape({ s }: { s: GameState }) {
  const menu = ids(tokens).filter((t) => tokens[t].minLevel <= s.level);
  const index =
    menu.reduce((a, t) => a + marketOf(s.night, t), 0) / (menu.length || 1);
  const pct = (m: number) => {
    const c = Math.round((m - 1) * 1000) / 10;
    return `${c > 0 ? "▲" : c < 0 ? "▼" : "·"} ${Math.abs(c)}%`;
  };
  const items = (copy: string) =>
    menu.map((t) => (
      <TokenLink
        key={copy + t}
        s={s}
        id={t}
        className="flex shrink-0 items-baseline gap-2 px-4 hover:underline"
      >
        <span className="font-semibold">{tokens[t].ticker}</span>
        <span className="tabular-nums">{fmt(marketPrice(s, t))}</span>
        <span className="text-white/60 tabular-nums">
          {pct(marketOf(s.night, t))}
        </span>
      </TokenLink>
    ));
  return (
    <div
      className="glass flex h-8 items-center overflow-hidden rounded-lg font-mono text-xs"
      aria-label={en.ticker.label}
    >
      <span className="z-10 flex h-full shrink-0 items-center gap-2 border-r border-white/15 bg-black/60 px-3 text-[10px] tracking-[0.2em] uppercase">
        {en.ticker.index}
        <span className="text-xs tracking-normal">{pct(index)}</span>
      </span>
      <div className="flex min-w-0 flex-1 overflow-hidden hover:[&>div]:[animation-play-state:paused]">
        <div className="animate-ticker flex w-max">
          {items("a")}
          <div aria-hidden inert className="flex">
            {items("b")}
          </div>
        </div>
      </div>
    </div>
  );
}
