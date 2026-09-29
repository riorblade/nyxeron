import { LOUNGE, nightTrack, useMusic } from "@/audio";
import {
  djs,
  expectedGuests,
  legal,
  levels,
  missingPermits,
  permitActive,
  permits,
  startNight,
  type GameState,
  capacityOf,
} from "@nyxeron/core";
import { Building2, DoorOpen, Lock, Moon, Target } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { EventFeed } from "@/hud/EventFeed";
import { tabIcon } from "@/hud/icons";
import { Objectives } from "@/hud/Objectives";
import { TopBar } from "@/hud/TopBar";
import { clock, en, genres } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";
import { introEnabled } from "./IntroVideo";
import { BuildTab } from "./office/BuildTab";
import { HouseRulesTab } from "./office/HouseRulesTab";
import { PermitsTab } from "./office/PermitsTab";
import { PromoTab } from "./office/PromoTab";
import { StaffTab } from "./office/StaffTab";
import { StockTab } from "./office/StockTab";
import { TalentTab } from "./office/TalentTab";

const TABS = [
  { id: "stock", minLevel: 1, C: StockTab },
  { id: "talent", minLevel: 4, C: TalentTab },
  { id: "promo", minLevel: 1, C: PromoTab },
  { id: "staff", minLevel: 2, C: StaffTab },
  { id: "rules", minLevel: 3, C: HouseRulesTab },
  { id: "permits", minLevel: 1, C: PermitsTab },
  { id: "build", minLevel: 1, C: BuildTab },
] as const;
type TabId = (typeof TABS)[number]["id"];
const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

function tutorial(s: GameState): string | null {
  if (s.mode === "basement") return s.day === 1 ? en.tutorial.basement1 : null;
  if (s.mode === "sandbox") return s.day === 1 ? en.tutorial.sandbox1 : null;
  return s.day === 1
    ? en.tutorial.career1
    : s.day === 2
      ? en.tutorial.career2
      : null;
}

function Card({
  title,
  icon: Icon,
  children,
  className,
  delay = 0,
}: {
  title: string;
  icon: typeof Target;
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <section
      className={cn("glass enter rounded-xl p-4", className)}
      style={d(delay)}
    >
      <h3 className="mb-3 flex items-center gap-2 text-[10px] tracking-[0.22em] text-white/55 uppercase">
        <Icon className="size-3.5" strokeWidth={1.75} />
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Office({ s }: { s: GameState }) {
  const atNight = s.phase === "night";
  // The club, heard through the wall: the lounge by day, whatever is playing downstairs at night.
  useMusic(atNight ? nightTrack(s) : LOUNGE, true, atNight ? "venue" : "menu");
  const { set, setIntro, setView } = useGame();
  const [tab, setTab] = useState<TabId>("stock");
  const expected = expectedGuests(s);
  const dj = s.bookedTalent[0];
  const hint = atNight ? null : tutorial(s);
  const crowdRisk =
    s.level >= 4 &&
    expected > legal.crowdPermitThreshold &&
    !permitActive(s, "crowd");
  const missing = missingPermits(s);
  const active = TABS.find((t) => t.id === tab)!;
  const info = en.office.tabInfo[tab]!;
  const openClub = () => {
    if (atNight) return setView("venue");
    set(startNight(s));
    if (introEnabled()) setIntro(true);
  };
  /** Tabs that only make sense by day: the DJ is already on the schedule, and building waits for daylight. */
  const nightLock = (id: TabId) =>
    atNight && (id === "talent" || id === "build" || id === "rules");

  return (
    <div className="fixed inset-0 overflow-x-hidden overflow-y-auto bg-black lg:overflow-hidden">
      {/* The office itself, dimmed, behind every panel. */}
      <Img
        src={art.office}
        className="absolute inset-0 size-full scale-105 object-cover opacity-30 blur-[3px]"
      />
      <div className="absolute inset-0 bg-black/55" />
      <div className="grain" />

      <div className="relative flex min-h-full flex-col gap-3 p-3 lg:h-full">
        <TopBar s={s} />
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[12rem_1fr_18rem] xl:grid-cols-[13.5rem_1fr_22rem]">
          {/* Sidebar */}
          <nav
            className="glass enter flex min-h-0 gap-1 overflow-x-auto rounded-xl p-2 lg:flex-col lg:overflow-x-visible"
            style={d(60)}
            aria-label="Office"
            role="tablist"
            aria-orientation="vertical"
            onKeyDown={(e) => {
              // Arrow keys move between the unlocked tabs.
              const step =
                e.key === "ArrowDown" || e.key === "ArrowRight"
                  ? 1
                  : e.key === "ArrowUp" || e.key === "ArrowLeft"
                    ? -1
                    : 0;
              if (!step) return;
              e.preventDefault();
              const open = TABS.filter(
                (t) => t.minLevel <= s.level && !nightLock(t.id),
              );
              const i = open.findIndex((t) => t.id === tab);
              const next = open[(i + step + open.length) % open.length]!;
              setTab(next.id);
              e.currentTarget
                .querySelector<HTMLElement>(`[data-tab="${next.id}"]`)
                ?.focus();
            }}
          >
            {TABS.map((t) => {
              const Icon = tabIcon[t.id];
              const locked = t.minLevel > s.level || nightLock(t.id);
              const on = t.id === tab;
              return (
                <button
                  key={t.id}
                  disabled={locked}
                  onClick={() => setTab(t.id)}
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  data-tab={t.id}
                  className={cn(
                    "group flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                    on
                      ? "bg-white text-black shadow-[0_0_24px_rgba(255,255,255,.18)]"
                      : "text-white/75 hover:bg-white/8 hover:text-white",
                    locked && "opacity-40",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg border",
                      on
                        ? "border-black/15 bg-black/5"
                        : "border-white/12 bg-white/[0.04]",
                    )}
                  >
                    <Icon className="size-[18px]" strokeWidth={1.75} />
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="text-sm font-medium">
                      {en.office.tabs[t.id]}
                    </span>
                    <span
                      className={cn(
                        "truncate text-[11px]",
                        on ? "text-black/55" : "text-white/60",
                      )}
                    >
                      {nightLock(t.id)
                        ? en.office.dayOnly
                        : locked
                          ? en.office.lockedTab(t.minLevel)
                          : en.office.tabInfo[t.id]!.title}
                    </span>
                  </span>
                  {locked && <Lock className="ml-auto size-3.5" />}
                </button>
              );
            })}

            <div className="mt-auto hidden overflow-hidden rounded-lg border border-white/10 lg:block">
              <div className="relative aspect-[16/9]">
                <Img
                  src={art.venue(s.level)}
                  className="absolute inset-0 size-full object-cover"
                  fallback={
                    <Building2 className="absolute inset-0 m-auto size-7 text-white/25" />
                  }
                />
                <div className="absolute inset-0 bg-black/35" />
                <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px]">
                  LV {s.level}
                </span>
              </div>
              <div className="p-2.5">
                <div className="text-sm font-medium">
                  {levels[s.level].name}
                </div>
                <div className="text-[11px] text-white/60">
                  {en.office.capacity(capacityOf(s))}
                </div>
              </div>
            </div>
          </nav>

          {/* Main */}
          <main
            className="glass enter flex min-h-[60dvh] flex-col overflow-hidden rounded-xl lg:min-h-0"
            style={d(100)}
          >
            <header className="relative h-28 shrink-0 overflow-hidden border-b border-white/10 xl:h-36">
              <Img
                src={art.office}
                className="absolute inset-0 size-full object-cover object-[50%_65%]"
              />
              <div className="absolute inset-0 bg-black/50" />
              <div
                key={tab}
                className="relative flex h-full items-end justify-between gap-6 p-4 sm:p-6"
              >
                <div className="enter">
                  <div className="text-[10px] tracking-[0.3em] text-white/60 uppercase">
                    {en.hud.day(s.day)} ·{" "}
                    {atNight
                      ? `${en.office.nightTime} · ${clock(s.night!.minute)}`
                      : en.office.daytime}
                  </div>
                  <h1 className="mt-1 text-2xl font-medium tracking-[-0.03em] sm:text-4xl">
                    {info.title}
                  </h1>
                  <p className="mt-1 text-sm text-white/70">{info.desc}</p>
                </div>
                {(() => {
                  const Icon = tabIcon[tab];
                  return (
                    <Icon
                      className="enter size-16 text-white/15"
                      strokeWidth={1}
                      style={d(80)}
                    />
                  );
                })()}
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
              {hint && <Banner badge="CEO">{hint}</Banner>}
              {atNight && <Banner badge="OPEN">{en.office.nightBanner}</Banner>}
              {crowdRisk && (
                <Banner warn>{en.office.crowdWarning(expected)}</Banner>
              )}
              {missing.length > 0 && (
                <Banner warn>
                  {en.office.permitWarning(
                    missing.map((p) => permits[p].name).join(", "),
                  )}
                </Banner>
              )}
              <div key={tab} className="enter">
                <active.C s={s} />
              </div>
            </div>
          </main>

          {/* Right column */}
          <aside className="flex min-h-0 flex-col gap-3">
            <Card title={en.night.objectives} icon={Target} delay={140}>
              <Objectives s={s} bare />
            </Card>
            <Card title={en.office.tonight} icon={Moon} delay={180}>
              <div className="space-y-1.5 text-sm">
                <Row label="DJ">
                  {dj
                    ? `${djs[dj].name} · ${genres[djs[dj].genre]}`
                    : en.office.noDj}
                </Row>
                <Row label="Promo">{s.activePromos.length}</Row>
                <Row label="Security">{s.staff.security}</Row>
                {s.level >= 4 && (
                  <Row label="Crowd permit">
                    {permitActive(s, "crowd") ? "✓" : "missing"}
                  </Row>
                )}
                <Row label="Expected guests">
                  {Math.round(expected * 0.9)}–{Math.round(expected * 1.1)}
                </Row>
                {s.sealedNights > 0 && (
                  <p className="pt-1 font-medium">⚠ {en.office.sealed}</p>
                )}
              </div>
            </Card>
            <div
              className="glass enter min-h-0 flex-1 overflow-hidden rounded-xl p-4"
              style={d(220)}
            >
              <EventFeed s={s} max={6} cards />
            </div>
            <button
              onClick={openClub}
              className="glow enter group relative h-28 shrink-0 overflow-hidden rounded-xl border border-white/25 text-left"
              style={d(260)}
            >
              <Img
                src={art.door}
                className="absolute inset-0 size-full object-cover opacity-70 transition-transform duration-700 ease-(--ease-out-expo) group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-black/35" />
              <div className="relative flex h-full items-end justify-between p-4">
                <div>
                  <div className="text-[10px] tracking-[0.3em] text-white/70 uppercase">
                    {atNight ? en.office.backKicker : en.office.openKicker}
                  </div>
                  <div
                    className={cn(
                      "font-semibold whitespace-nowrap uppercase",
                      atNight
                        ? "text-xl tracking-[0.1em]"
                        : "text-2xl tracking-[0.14em]",
                    )}
                  >
                    {atNight ? en.office.back : en.office.open}
                  </div>
                </div>
                <span className="flex size-11 items-center justify-center rounded-lg bg-white text-black transition-transform group-hover:translate-x-0.5">
                  <DoorOpen className="size-5" />
                </span>
              </div>
            </button>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Banner({
  children,
  warn,
  badge,
}: {
  children: ReactNode;
  warn?: boolean;
  badge?: string;
}) {
  return (
    <p
      className={cn(
        "enter mb-3 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed",
        warn
          ? "border-white/40 bg-white/[0.07]"
          : "border-white/15 bg-white/[0.03] text-white/85",
      )}
    >
      {badge && (
        <span className="shrink-0 rounded-full border border-white/30 px-2 py-0.5 text-[10px] font-semibold tracking-[0.2em]">
          {badge}
        </span>
      )}
      {warn && <span className="shrink-0 font-semibold">!</span>}
      <span>{children}</span>
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-white/50">{label}</span>
      <span className="truncate font-mono text-[13px]">{children}</span>
    </div>
  );
}
