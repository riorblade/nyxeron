import {
  bookPromoter,
  channels,
  commissionOf,
  ids,
  promoters,
  legal,
  nightPromote,
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
import { art } from "@/lib/art";
import { Img } from "@/components/Img";
import { en, fmt, segmentNames } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/state/store";

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
        <Zap className="size-3.5" />{" "}
        {s.phase === "night" ? en.promo.nightNote : en.promo.energyNote}
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
                onClick={() => act((g) => nightPromote(g, id))}
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
          className="h-9 rounded-lg border border-white/30 px-4 text-xs font-semibold tracking-[0.14em] uppercase enabled:hover:bg-white enabled:hover:text-black disabled:opacity-35"
          disabled={s.phase === "night"}
          title={s.phase === "night" ? en.office.dayOnly : undefined}
          onClick={() => act(r17_controversialPromo)}
        >
          {en.promo.risk}
        </button>
      </div>
      <Promoters s={s} />
    </div>
  );
}

/** Guest-list promoters: booked by day, paid per head who gets in. */
function Promoters({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const t = en.promoters;
  return (
    <section className="space-y-3 pt-2">
      <div>
        <h3 className="font-medium">{t.title}</h3>
        <p className="mt-1 text-sm text-white/65">{t.desc}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-3">
        {ids(promoters).map((id) => {
          const p = promoters[id];
          const locked = p.minLevel > s.level;
          const booked = s.promoters.includes(id);
          return (
            <li
              key={id}
              className={cn(
                "overflow-hidden rounded-xl border bg-white/[0.03]",
                booked ? "border-white" : "border-white/10",
                locked && "opacity-50",
              )}
            >
              <div className="relative h-28">
                <Img
                  src={art.staff("promoter")}
                  alt=""
                  className="absolute inset-0 size-full object-cover object-top"
                />
                <div className="absolute inset-0 bg-black/30" />
              </div>
              <div className="space-y-0.5 p-3">
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-white/60">
                  {t.segment(segmentNames[p.segment] ?? p.segment)} ·{" "}
                  {t.heads(p.heads)}
                </div>
                <div className="font-mono text-xs text-white/70">
                  {t.perHead(fmt(commissionOf(s, id)))}
                </div>
                <button
                  disabled={locked || s.phase === "night"}
                  onClick={() => act((g) => bookPromoter(g, id))}
                  className={cn(
                    "mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-semibold tracking-[0.14em] uppercase disabled:opacity-40",
                    booked
                      ? "bg-white text-black"
                      : "border border-white/25 hover:bg-white/10",
                  )}
                >
                  {locked ? (
                    <>
                      <Lock className="size-3.5" />
                      {en.office.lockedTab(p.minLevel)}
                    </>
                  ) : booked ? (
                    <>
                      <Check className="size-3.5" /> {t.booked}
                    </>
                  ) : (
                    t.book
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
