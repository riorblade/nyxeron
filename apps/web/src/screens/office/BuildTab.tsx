import {
  buyUpgrade,
  levels,
  strategy,
  upgradeTiers,
  upgradeCost,
  permitActive,
  permits,
  r18_upgradeLevel,
  requiredPermits,
  type GameState,
  type Level,
  capacityOf,
  storageOf,
} from "@nyxeron/core";
import {
  Building2,
  Crown,
  Lightbulb,
  Lock,
  Speaker,
  Users,
  Warehouse,
} from "lucide-react";
import { art } from "@/lib/art";
import { Img } from "@/components/Img";
import { en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/state/store";

/** Permits the next level requires that the player doesn't hold: upgrading without them invites inspections. */
const missingAfter = (s: GameState, lv: Level) =>
  requiredPermits(lv).filter((p) => !permitActive(s, p));

export function BuildTab({ s }: { s: GameState }) {
  const { act, notify } = useGame();
  const upgrade = () => {
    if (act(r18_upgradeLevel))
      notify(en.build.levelUp(levels[(s.level + 1) as Level].name));
  };
  return (
    <div className="space-y-6">
      <Rig s={s} />
      <ol className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
        {([1, 2, 3, 4, 5] as const).map((lv) => {
          const l = levels[lv];
          const current = lv === s.level;
          const next = lv === s.level + 1;
          const done = lv < s.level;
          const far = lv > s.level + 1;
          return (
            <li
              key={lv}
              className={cn(
                "overflow-hidden rounded-xl border bg-white/[0.03]",
                current
                  ? "border-white shadow-[0_0_32px_rgba(255,255,255,.14)]"
                  : "border-white/10",
                far && "opacity-45",
              )}
            >
              <div className="relative aspect-[16/9]">
                <Img
                  src={art.venue(lv)}
                  alt={l.name}
                  className={cn(
                    "absolute inset-0 size-full object-cover",
                    (far || done) && "grayscale brightness-50",
                  )}
                  fallback={
                    <Building2 className="absolute inset-0 m-auto size-8 text-white/30" />
                  }
                />
                <span className="absolute top-2 left-2 rounded-md bg-black/65 px-2 py-0.5 font-mono text-xs">
                  LV {lv}
                </span>
                {current && (
                  <span className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-white px-2 py-0.5 text-[10px] font-semibold tracking-[0.15em] text-black uppercase">
                    <Crown className="size-3" /> {en.build.current}
                  </span>
                )}
                {far && <Lock className="absolute inset-0 m-auto size-6" />}
              </div>
              <div className="space-y-2 p-4">
                <div className="text-lg font-semibold">{l.name}</div>
                <p className="text-xs leading-relaxed text-white/60">
                  {en.build.unlocks[lv - 1]}
                </p>
                {!current && !done && (
                  <div className="font-mono text-xs text-white/75">
                    {fmt(l.cost)} {en.unit} · Rep {l.repRequired}
                  </div>
                )}
                {next && missingAfter(s, lv).length > 0 && (
                  <div className="text-xs">
                    ⚠{" "}
                    {en.build.permitsNeeded(
                      missingAfter(s, lv)
                        .map((p) => permits[p].name)
                        .join(", "),
                    )}
                  </div>
                )}
                {next && (
                  <button
                    disabled={s.phase !== "day"}
                    title={s.phase !== "day" ? en.office.dayOnly : undefined}
                    onClick={upgrade}
                    className="mt-1 h-9 w-full rounded-lg bg-white text-xs font-semibold tracking-[0.14em] text-black uppercase shadow-[0_0_24px_rgba(255,255,255,.18)] disabled:opacity-40"
                  >
                    {en.build.upgrade}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Sound system and lighting rig tiers (by day). */
function Rig({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const t = en.rig;
  const items = [
    {
      id: "capacity",
      icon: Users,
      name: t.capacity,
      desc: t.capacityDesc(capacityOf(s)),
    },
    {
      id: "storage",
      icon: Warehouse,
      name: t.storage,
      desc: t.storageDesc(storageOf(s)),
    },
    { id: "sound", icon: Speaker, name: t.sound, desc: t.soundDesc },
    { id: "lighting", icon: Lightbulb, name: t.lighting, desc: t.lightingDesc },
    {
      id: "vip",
      icon: Crown,
      name: t.vip,
      desc: t.vipDesc(levels[s.level].vipTables),
    },
  ] as const;
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium">{t.title}</h3>
        <p className="mt-1 text-sm text-white/65">{t.desc}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map(({ id, icon: Icon, name, desc }) => {
          const tier = s.upgrades[id] ?? 0;
          const cost = upgradeCost(s, id);
          const tiers = upgradeTiers(id);
          const locked = s.level < strategy.upgrades[id].minLevel;
          return (
            <li
              key={id}
              className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4"
            >
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-white/15">
                  <Icon className="size-5" strokeWidth={1.75} />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">{name}</div>
                  <div className="text-xs text-white/60">{desc}</div>
                </div>
              </div>
              <div
                className="flex items-center gap-1.5"
                aria-label={t.tier(tier)}
              >
                {Array.from({ length: tiers }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1.5 flex-1 rounded-full",
                      i < tier ? "bg-white" : "bg-white/15",
                    )}
                  />
                ))}
                <span className="ml-2 font-mono text-xs text-white/70">
                  {tiers > 1 ? t.tier(tier) : tier ? t.built : t.notBuilt}
                </span>
              </div>
              <button
                disabled={cost === null || locked || s.phase !== "day"}
                onClick={() => act((g) => buyUpgrade(g, id))}
                className="h-9 rounded-lg border border-white/25 text-xs font-semibold tracking-[0.12em] uppercase enabled:hover:bg-white enabled:hover:text-black disabled:opacity-40"
              >
                {locked
                  ? en.office.lockedTab(strategy.upgrades[id].minLevel)
                  : cost === null
                    ? tiers > 1
                      ? t.maxed
                      : t.built
                    : tiers > 1
                      ? t.buy(fmt(cost))
                      : t.build(fmt(cost))}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
