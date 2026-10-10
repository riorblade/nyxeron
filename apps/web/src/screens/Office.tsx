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
  setQuotes,
} from "@nyxeron/core";
import { Building2, DoorOpen, Lock, Moon, Target } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { art } from "@/lib/art";
import { Img } from "@/components/Img";
import { EventFeed } from "@/hud/EventFeed";
import { tabIcon } from "@/hud/icons";
import { Objectives } from "@/hud/Objectives";
import { TopBar } from "@/hud/TopBar";
import { clock, en, genres } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { fetchQuotes } from "@/api/quotes";
import { useGame } from "@/state/store";
import { introEnabled } from "./IntroVideo";
import { BuildTab } from "./office/BuildTab";
import { EventsTab } from "./office/EventsTab";
import { HouseRulesTab } from "./office/HouseRulesTab";
import { PermitsTab } from "./office/PermitsTab";
import { PromoTab } from "./office/PromoTab";
import { StaffTab } from "./office/StaffTab";
import { StockTab } from "./office/StockTab";
import { TalentTab } from "./office/TalentTab";

const TABS = [
  { id: "stock", minLevel: 1, C: StockTab },
  { id: "talent", minLevel: 3, C: TalentTab },
  { id: "promo", minLevel: 1, C: PromoTab },
  { id: "staff", minLevel: 2, C: StaffTab },
  { id: "rules", minLevel: 3, C: HouseRulesTab },
  { id: "permits", minLevel: 1, C: PermitsTab },
  { id: "build", minLevel: 1, C: BuildTab },
  { id: "events", minLevel: 1, C: EventsTab },
] as const;
type TabId = (typeof TABS)[number]["id"];
/** Each tab's neon colour (an oklch hue) for its icon chip. */
const tabHue: Record<TabId, number> = {
  stock: 75,
  talent: 300,
  promo: 330,
  staff: 265,
  rules: 210,
  permits: 160,
  build: 45,
  events: 15,
};
const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

function tutorial(s: GameState): string | null {
  if (s.mode === "basement") return s.day === 1 ? en.tutorial.basement1 : null;
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
  deco,
}: {
  title: string;
  icon: typeof Target;
  children: ReactNode;
  className?: string;
  delay?: number;
  /** Game art in the card: an icon in the top-right corner (the reward chest), or a portrait behind the right side. */
  deco?: { src: string; as: "icon" | "portrait" };
}) {
  return (
    <section
      className={cn(
        "glass enter relative overflow-hidden rounded-xl p-4",
        className,
      )}
      style={d(delay)}
    >
      {deco?.as === "icon" && (
        <Img
          src={deco.src}
          alt=""
          className="pointer-events-none absolute -top-1 -right-1 w-24 drop-shadow-[0_0_16px_oklch(0.8_0.16_75/0.5)]"
        />
      )}
      {deco?.as === "portrait" && (
        <Img
          src={deco.src}
          alt=""
          className="pointer-events-none absolute inset-y-0 right-0 h-full w-1/2 object-cover object-top opacity-45 [mask-image:linear-gradient(to_left,black_30%,transparent)]"
        />
      )}
      <h3 className="mb-3 flex items-center gap-2.5 text-[11px] font-semibold tracking-[0.22em] text-white/85 uppercase">
        <span
          className="chip flex size-7 items-center justify-center rounded-full"
          style={{ "--hue": 75 } as CSSProperties}
        >
          <Icon className="size-3.5" strokeWidth={2} />
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Warm the night screen (3D venue) and the Open Club cutscene while the player is in the office. */
function usePrefetchNight() {
  useEffect(() => {
    const id = setTimeout(() => {
      void import("@/screens/Night");
      if (!document.querySelector('link[href="/intro.mp4"]')) {
        const l = document.createElement("link");
        l.rel = "prefetch";
        l.href = "/intro.mp4";
        document.head.appendChild(l);
      }
    }, 1500);
    return () => clearTimeout(id);
  }, []);
}

export function Office({ s }: { s: GameState }) {
  usePrefetchNight();
  const atNight = s.phase === "night";
  // The club, heard through the wall: the lounge by day, whatever is playing downstairs at night.
  useMusic(atNight ? nightTrack(s) : LOUNGE, true, atNight ? "venue" : "menu");
  const { set, setIntro, setView } = useGame();
  const [tab, setTab] = useState<TabId>("stock");
  // Each morning the CEO restocks at today's real spot prices (Binance RWA via /api/quotes).
  useEffect(() => {
    if (atNight) return;
    void fetchQuotes().then((q) => {
      const g = useGame.getState().game;
      if (g && g.phase === "day" && Object.keys(q).length)
        useGame.getState().set(setQuotes(g, q));
    });
  }, [s.day, atNight]);
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
    <div className="bg-night fixed inset-0 overflow-x-hidden overflow-y-auto lg:overflow-hidden">
      {/* The club itself, blurred, behind every panel. */}
      <Img
        src={art.ui.hero}
        className="absolute inset-0 size-full scale-110 object-cover opacity-45 blur-[10px]"
      />
      <div className="from-night/40 via-night/70 to-night absolute inset-0 bg-gradient-to-b" />
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
                      ? "gold"
                      : "border border-transparent text-white/80 hover:border-violet/40 hover:bg-violet/15 hover:text-white",
                    locked && "opacity-40",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg",
                      on ? "border border-black/15 bg-black/10" : "chip",
                    )}
                    style={{ "--hue": tabHue[t.id] } as CSSProperties}
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
                        on ? "text-black/60" : "text-white/55",
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

            <div className="tile mt-auto hidden overflow-hidden rounded-lg lg:block">
              <div className="relative aspect-[16/9]">
                <Img
                  src={art.venue(s.level)}
                  className="absolute inset-0 size-full object-cover"
                  fallback={
                    <Building2 className="absolute inset-0 m-auto size-7 text-white/25" />
                  }
                />
                <div className="from-night/80 absolute inset-0 bg-gradient-to-t to-transparent" />
                <span className="gold absolute top-2 left-2 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold">
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
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-gold-deep to-gold"
                    style={{ width: `${(s.level / 5) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </nav>

          {/* Main */}
          <main
            className="glass enter flex min-h-[60dvh] flex-col overflow-hidden rounded-xl lg:min-h-0"
            style={d(100)}
          >
            <header className="relative h-28 shrink-0 overflow-hidden border-b border-violet/30 xl:h-40">
              <Img
                src={art.ui.hero}
                className="absolute inset-0 size-full object-cover object-[60%_50%]"
              />
              <div className="from-night/95 via-night/55 absolute inset-0 bg-gradient-to-r to-transparent" />
              <div
                key={tab}
                className="relative flex h-full items-end justify-between gap-6 p-4 sm:p-6"
              >
                <div className="enter">
                  <div className="text-cyan text-[10px] font-semibold tracking-[0.3em] uppercase">
                    {en.hud.day(s.day)} ·{" "}
                    {atNight
                      ? `${en.office.nightTime} · ${clock(s.night!.minute)}`
                      : en.office.daytime}
                  </div>
                  <h1 className="mt-1 text-2xl font-bold tracking-[-0.03em] drop-shadow-[0_2px_12px_rgba(0,0,0,.6)] sm:text-4xl xl:text-5xl">
                    {info.title}
                  </h1>
                  <p className="mt-1 text-sm text-white/80">{info.desc}</p>
                </div>
                {(() => {
                  const Icon = tabIcon[tab];
                  return (
                    <Icon
                      className="enter text-neon/40 size-16 drop-shadow-[0_0_18px_currentColor]"
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
            <Card
              title={en.night.objectives}
              icon={Target}
              delay={140}
              deco={{ src: art.ui.chest, as: "icon" }}
            >
              <div className="relative pr-16">
                <Objectives s={s} bare />
              </div>
            </Card>
            <Card
              title={en.office.tonight}
              icon={Moon}
              delay={180}
              deco={dj ? { src: art.dj(dj), as: "portrait" } : undefined}
            >
              <div className="relative space-y-1.5 text-sm">
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
              className="glow enter group border-gold/50 relative h-36 shrink-0 overflow-hidden rounded-xl border text-left shadow-[0_0_30px_oklch(0.65_0.27_315/0.35)] xl:h-44"
              style={d(260)}
            >
              <Img
                src={art.ui.openClub}
                className="absolute inset-0 size-full object-cover object-[50%_30%] transition-transform duration-700 ease-(--ease-out-expo) group-hover:scale-105"
              />
              <div className="from-night via-night/40 absolute inset-0 bg-gradient-to-t to-transparent" />
              <div className="relative flex h-full flex-col items-center justify-end gap-2 p-3 text-center">
                <div className="text-[10px] font-semibold tracking-[0.3em] text-white/80 uppercase">
                  {atNight ? en.office.backKicker : en.office.openKicker}
                </div>
                <span className="gold flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-lg font-extrabold tracking-[0.12em] uppercase transition-transform group-hover:scale-[1.02]">
                  <DoorOpen className="size-5" />
                  {atNight ? en.office.back : en.office.open}
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
        "enter mb-3 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm leading-relaxed",
        warn
          ? "border-gold/45 bg-gold/[0.08] text-white"
          : "tile text-white/90",
      )}
    >
      {badge === "CEO" && (
        <Img
          src={art.ui.ceo}
          alt=""
          className="border-neon/60 size-11 shrink-0 rounded-full border object-cover shadow-[0_0_14px_oklch(0.65_0.27_315/0.5)]"
        />
      )}
      {badge && (
        <span className="border-gold/60 text-gold shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-bold tracking-[0.2em]">
          {badge}
        </span>
      )}
      {warn && (
        <span
          className="chip flex size-8 shrink-0 items-center justify-center rounded-full font-bold"
          style={{ "--hue": 75 } as CSSProperties}
        >
          !
        </span>
      )}
      <span>{children}</span>
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-white/60">{label}</span>
      <span className="truncate font-mono text-[13px]">{children}</span>
    </div>
  );
}
