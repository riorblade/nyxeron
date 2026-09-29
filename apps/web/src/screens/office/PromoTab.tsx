import {
  channels,
  ids,
  legal,
  r05_promote,
  r17_controversialPromo,
  type ChannelId,
  type GameState,
} from "@nyxeron/core";
import {
  AtSign,
  Camera,
  Check,
  Flame,
  Lock,
  Music2,
  Newspaper,
  Sparkles,
  Zap,
} from "lucide-react";
import { en, fmt, segmentNames } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

const channelIcon: Record<ChannelId, typeof Camera> = {
  posters: Newspaper,
  x: AtSign,
  instagram: Camera,
  tiktok: Music2,
  influencer: Sparkles,
};

export function PromoTab({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  return (
    <div className="space-y-5">
      <p className="flex items-center gap-2 text-xs text-white/55">
        <Zap className="size-3.5" /> {en.promo.energyNote}
      </p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
        {ids(channels).map((id) => {
          const c = channels[id];
          const Icon = channelIcon[id];
          const locked = c.minLevel > s.level;
          const posted = s.activePromos.includes(id);
          return (
            <li
              key={id}
              className={cn(
                "flex flex-col gap-4 rounded-xl border p-4 transition-colors",
                posted
                  ? "border-white bg-white/[0.08] shadow-[0_0_24px_rgba(255,255,255,.1)]"
                  : "border-white/10 bg-white/[0.03]",
                locked && "opacity-40",
              )}
            >
              <div className="flex items-start justify-between">
                <span
                  className={cn(
                    "flex size-11 items-center justify-center rounded-xl",
                    posted ? "bg-white text-black" : "bg-white/8",
                  )}
                >
                  <Icon className="size-5" strokeWidth={1.75} />
                </span>
                <span className="font-mono text-2xl">+{c.hype}</span>
              </div>
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-white/50">
                  {segmentNames[c.segment]} · {fmt(c.cost)} C
                </div>
              </div>
              <button
                disabled={locked || posted}
                onClick={() => act((g) => r05_promote(g, id))}
                className={cn(
                  "flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold tracking-[0.14em] uppercase",
                  posted
                    ? "bg-white text-black"
                    : "border border-white/20 hover:bg-white hover:text-black",
                )}
              >
                {locked ? (
                  <Lock className="size-3.5" />
                ) : (
                  posted && <Check className="size-3.5" />
                )}
                {locked
                  ? en.office.lockedTab(c.minLevel)
                  : posted
                    ? en.promo.posted
                    : en.promo.post}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-4 rounded-xl border border-dashed border-white/25 bg-white/[0.02] p-4">
        <span className="flex size-11 items-center justify-center rounded-xl border border-white/30">
          <Flame className="size-5" />
        </span>
        <div className="flex-1">
          <div className="font-medium">{en.promo.controversial}</div>
          <div className="text-xs text-white/55">
            {en.promo.controversialDesc} · {fmt(legal.controversialPromo.cost)}{" "}
            C
          </div>
        </div>
        <button
          className="h-9 rounded-lg border border-white/30 px-4 text-xs font-semibold tracking-[0.14em] uppercase hover:bg-white hover:text-black"
          onClick={() => act(r17_controversialPromo)}
        >
          {en.promo.risk}
        </button>
      </div>
    </div>
  );
}
