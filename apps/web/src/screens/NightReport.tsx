import { LOUNGE, useMusic } from "@/audio";
import { nextDay, type GameState } from "@nyxeron/core";
import type { CSSProperties, ReactNode } from "react";
import { Backdrop } from "@/components/Backdrop";
import { Brand, HomeButton } from "@/components/Brand";
import { Cta } from "@/components/Cta";
import { en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

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

/** Qualitative guest reviews: every stat change should be explained (GDD 8, information clarity). */
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
  return out.length ? out : [en.report.factorClean];
}

export function NightReport({ s }: { s: GameState }) {
  useMusic(LOUNGE, true); // the club, heard through the wall
  const { set, go } = useGame();
  const r = s.lastReport!;
  return (
    <div className="fixed inset-0 overflow-y-auto">
      <Backdrop />
      <Brand className="enter absolute top-6 left-10 z-10" />
      <HomeButton className="enter absolute top-6 right-10 z-10" />
      <div className="relative mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-8 px-8 py-12">
        <header className="flex items-end justify-between gap-6">
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
          <div className="enter text-right" style={d(420)}>
            <div className="text-[10px] tracking-[0.2em] text-white/45 uppercase">
              {en.report.profit}
            </div>
            <div className="font-mono text-4xl tabular-nums">
              {signed(r.profit)}
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
            <Row label={en.report.fines}>{signed(-r.fines)}</Row>
            <Row label={en.report.profit} strong>
              {signed(r.profit)}
            </Row>
            <p className="mt-2 text-xs text-white/45">{en.report.upkeepNote}</p>
          </section>
          <section
            className="glass enter rounded-2xl p-5 text-sm"
            style={d(600)}
          >
            <Row label={en.report.guests}>{r.guests}</Row>
            <Row label={en.report.rejected}>{r.rejectedUnderage}</Row>
            <Row label={en.report.fights}>{r.fights}</Row>
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
            <div className="mt-1 flex justify-between text-[10px] text-white/40">
              <span>{en.report.repLow}</span>
              <span>{en.report.repHigh}</span>
            </div>
          </section>
          <section
            className="glass enter rounded-2xl p-5 text-sm"
            style={d(680)}
          >
            <h3 className="mb-2 text-[10px] tracking-[0.2em] text-white/45 uppercase">
              {en.report.why}
            </h3>
            <ul className="space-y-2">
              {factors(s).map((f) => (
                <li key={f} className="flex gap-2 leading-snug">
                  <span className="text-white/40">•</span>
                  {f}
                </li>
              ))}
            </ul>
            <h3 className="mt-5 mb-2 text-[10px] tracking-[0.2em] text-white/45 uppercase">
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
