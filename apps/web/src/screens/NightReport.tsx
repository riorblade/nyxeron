import { LOUNGE, useMusic } from "@/audio";
import { nextDay, type GameState } from "@nyxeron/core";
import type { CSSProperties, ReactNode } from "react";
import { Backdrop } from "@/components/Backdrop";
import { Brand, HomeButton } from "@/components/Brand";
import { Cta } from "@/components/Cta";
import { en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/state/store";

const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;
const signed = (n: number) =>
  n === 0 ? "0" : `${n > 0 ? "+" : "−"}${fmt(Math.abs(n))}`;

const Row = ({
  label,
  children,
  strong,
}: {
  label: string;
  children: ReactNode;
  strong?: boolean;
}) => (
  <div
    className={cn(
      "flex justify-between py-1.5",
      strong && "mt-1 border-t border-white/10 pt-3 text-base font-medium",
    )}
  >
    <span className={strong ? "" : "text-white/55"}>{label}</span>
    <span className="font-mono tabular-nums">{children}</span>
  </div>
);

/** Qualitative guest reviews: every stat change should be explained. */
function reviews(s: GameState): string[] {
  const r = s.lastReport!;
  const today = s.log.filter((e) => e.day === s.day);
  const out: string[] = [];
  if (r.djMatch !== null)
    out.push(r.djMatch ? en.reviews.djMatch : en.reviews.djMiss);
  if (r.outOfStockHits) out.push(en.reviews.outOfStock);
  if (r.slowServiceHits > r.guests / 4) out.push(en.reviews.slow);
  if (r.fights) out.push(en.reviews.fight);
  if (today.some((e) => e.kind === "doorClosed")) out.push(en.reviews.packed);
  out.push(
    r.avgSatisfaction >= 70
      ? en.reviews.great
      : r.avgSatisfaction >= 40
        ? en.reviews.meh
        : en.reviews.bad,
  );
  return out;
}

function factors(s: GameState): string[] {
  const r = s.lastReport!;
  const out: string[] = [];
  if (r.outOfStockHits) out.push(en.report.factorStock(r.outOfStockHits));
  if (r.slowServiceHits) out.push(en.report.factorSlow(r.slowServiceHits));
  if (s.level >= 4)
    out.push(
      r.djMatch === null
        ? en.report.factorNoDj
        : r.djMatch
          ? en.report.factorDjMatch
          : en.report.factorDjMiss,
    );
  if (r.fights) out.push(en.report.factorFights(r.fights));
  // Crowd energy only matters from Level 3 (reports from older saves may lack it).
  if (s.level >= 3 && r.avgEnergy !== undefined) {
    if (r.avgEnergy >= 65) out.push(en.report.factorEnergyHigh(r.avgEnergy));
    else if (r.avgEnergy < 45) out.push(en.report.factorEnergyLow(r.avgEnergy));
    if (r.tacticsUsed?.length)
      out.push(en.report.factorMoves(r.tacticsUsed.length));
  }
  return out.length ? out : [en.report.factorClean];
}

export function NightReport({ s }: { s: GameState }) {
  useMusic(LOUNGE, true); // the club, heard through the wall
  const { set, go } = useGame();
  const r = s.lastReport!;
  return (
    <div className="fixed inset-0 overflow-y-auto">
      <Backdrop />
      <Brand className="enter absolute top-6 left-4 z-10 sm:left-10" />
      <HomeButton className="enter absolute top-6 right-4 z-10 sm:right-10" />
      <div className="relative mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-8 px-4 pt-24 pb-12 sm:px-8 sm:py-12">
        <header className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-end">
          <h1 className="text-[clamp(44px,7vh,76px)] leading-[0.98] font-medium tracking-[-0.035em]">
            <span className="line">
              <span className="line-reveal" style={d(100)}>
                {en.report.heading}
              </span>
            </span>
            <span className="line text-white/55">
              <span className="line-reveal" style={d(220)}>
                {en.report.subtitle(r.day)}
              </span>
            </span>
          </h1>
          <div className="enter sm:text-right" style={d(420)}>
            <div className="text-[10px] tracking-[0.2em] text-white/60 uppercase">
              {en.report.profit}
            </div>
            <div className="font-mono text-4xl tabular-nums">
              {signed(r.profit)} {en.unit}
            </div>
            <div className="text-sm text-white/55">
              {en.report.rep} {signed(r.repDelta)} → {s.reputation}
            </div>
          </div>
        </header>

        {(r.shutDown || r.sealed) && (
          <p
            className="glass enter rounded-lg border-white/40 px-4 py-3 text-sm font-medium"
            style={d(480)}
          >
            !{" "}
            {r.shutDown
              ? en.event({ day: 0, kind: "crowdShutdown" }, {} as never)
              : en.office.sealed}
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <section
            className="glass enter rounded-2xl p-5 text-sm"
            style={d(520)}
          >
            <Row label={en.report.bar}>{fmt(r.revenue.bar)}</Row>
            <Row label={en.report.cover}>{fmt(r.revenue.cover)}</Row>
            <Row label={en.report.table}>{fmt(r.revenue.table)}</Row>
            <Row label={en.report.tax}>{signed(-r.tax)}</Row>
            {!!r.revenue.platformFee && (
              <Row label={en.report.platformFee}>
                {signed(-r.revenue.platformFee)}
              </Row>
            )}
            <Row label={en.report.fines}>{signed(-r.fines)}</Row>
            <Row label={en.report.profit} strong>
              {signed(r.profit)}
            </Row>
            <p className="mt-2 text-xs text-white/60">{en.report.upkeepNote}</p>
          </section>
          <section
            className="glass enter rounded-2xl p-5 text-sm"
            style={d(600)}
          >
            <Row label={en.report.guests}>{r.guests}</Row>
            <Row label={en.report.rejected}>{r.rejectedUnderage}</Row>
            <Row label={en.report.fights}>{r.fights}</Row>
            {(r.escorted ?? 0) > 0 && (
              <Row label={en.report.escorted}>{r.escorted}</Row>
            )}
            {s.level >= 3 && r.avgEnergy !== undefined && (
              <>
                <Row label={en.report.energy}>
                  {en.report.energyValue(r.avgEnergy, r.peakEnergy)}
                </Row>
                <Row label={en.report.rounds}>{r.rounds}</Row>
                {r.tables > 0 && <Row label={en.report.tables}>{r.tables}</Row>}
                {(r.vipTables ?? 0) > 0 && (
                  <Row label={en.report.vipTables}>{r.vipTables}</Row>
                )}
                {(r.barSeats ?? 0) > 0 && (
                  <Row label={en.report.barSeats}>{r.barSeats}</Row>
                )}
                {r.rejectedDress > 0 && (
                  <Row label={en.report.rejectedDress}>{r.rejectedDress}</Row>
                )}
                {r.guestListIn > 0 && (
                  <Row label={en.report.guestList}>{r.guestListIn}</Row>
                )}
                {r.commission > 0 && (
                  <Row label={en.report.commission}>
                    {signed(-r.commission)}
                  </Row>
                )}
                {r.bottles > 0 && (
                  <Row label={en.report.bottles}>{r.bottles}</Row>
                )}
              </>
            )}
            <Row label={en.report.violations}>{r.violations}</Row>
            <Row label={en.report.satisfaction} strong>
              {r.avgSatisfaction}%
            </Row>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-white"
                style={{ width: `${r.avgSatisfaction}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-white/60">
              <span>{en.report.repLow}</span>
              <span>{en.report.repHigh}</span>
            </div>
          </section>
          <section
            className="glass enter rounded-2xl p-5 text-sm"
            style={d(680)}
          >
            <h3 className="mb-2 text-[10px] tracking-[0.2em] text-white/60 uppercase">
              {en.report.why}
            </h3>
            <ul className="space-y-2">
              {factors(s).map((f) => (
                <li key={f} className="flex gap-2 leading-snug">
                  <span className="text-white/60">•</span>
                  {f}
                </li>
              ))}
            </ul>
            <h3 className="mt-5 mb-2 text-[10px] tracking-[0.2em] text-white/60 uppercase">
              {en.report.reviews}
            </h3>
            <ul className="space-y-1 text-white/80 italic">
              {reviews(s).map((t) => (
                <li key={t}>“{t}”</li>
              ))}
            </ul>
          </section>
        </div>

        <Cta
          className="enter glow w-64 self-end"
          style={d(820)}
          onClick={() => (s.outcome ? go("over") : set(nextDay(s)))}
        >
          {s.outcome ? en.report.results : en.report.next}
        </Cta>
      </div>
    </div>
  );
}
