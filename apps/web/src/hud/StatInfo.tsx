import {
  economy,
  legal,
  levels,
  night,
  statHistory,
  type GameState,
  type Stat,
} from "@nyxeron/core";
import { en, fmt } from "@/i18n/en";
import { clock } from "@/i18n/en";
import { eventText } from "./eventText";

export type InfoKey =
  "coin" | "rep" | "hype" | "safety" | "energy" | "violations" | "permits";

const historyOf: Partial<Record<InfoKey, Stat>> = {
  coin: "coin",
  rep: "reputation",
  hype: "hype",
  safety: "safety",
  violations: "violations",
};
/** The numbers behind the explanations, straight from the game data (so the text never drifts from the rules). */
const facts = (s: GameState) =>
  en.statInfo({
    bankruptDays: economy.bankruptAfterNegativeDays,
    nextRep:
      s.level < 5 ? levels[(s.level + 1) as 2 | 3 | 4 | 5].repRequired : null,
    victoryRep: economy.victoryReputation,
    good: night.goodNightSatisfaction,
    bad: night.badNightSatisfaction,
    repGain: night.repGainRange as [number, number],
    repLoss: night.repLossBadNight,
    fightRep: night.fightRepPenalty,
    fightSafety: night.fightSafetyPenalty,
    promoRep: legal.controversialPromo.repPenalty,
    shutdownRep: legal.shutdownRepPenalty,
    hypeDecay: economy.hypeDecayPerDay,
    safetyRecovery: economy.safetyRecoveryPerDay,
    safetyLossPct: Math.round((1 - night.safety.demandFloor) * 100),
    riskyBelow: night.safety.riskyBelow,
    riskyPct: Math.round(night.safety.riskyInspectionChance * 100),
    perGuard: night.guestsPerSecurity,
    energyPerDay: economy.ceoEnergyPerDay,
    maxViolations: legal.maxViolations,
    fine: legal.inspectionFine,
    missingPct: Math.round(legal.inspectionChanceMissingPermit * 100),
  });

const t = en.hud;

/** The panel under a top-bar stat: what it is, what it does, how it moves, and what moved it lately. */
export function StatInfo({
  s,
  stat,
  label,
}: {
  s: GameState;
  stat: InfoKey;
  label: string;
}) {
  const info = facts(s)[stat];
  const key = historyOf[stat];
  const recent = key ? statHistory(s, key, 6) : [];
  const report = stat === "coin" ? s.lastReport : null;
  return (
    <div
      role="dialog"
      aria-label={label}
      className="absolute top-full left-0 z-50 mt-3 border border-white/15 bg-neutral-950 w-[min(22rem,calc(100vw-2rem))] rounded-xl p-4 text-left text-sm shadow-[0_0_30px_rgba(255,255,255,.08)]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-[10px] tracking-[0.25em] text-white/50 uppercase">
        {label}
      </div>
      <p className="mt-1 leading-relaxed text-white/85">{info.what}</p>
      <Block title={t.whatItDoes} items={info.does} />
      <Block title={t.howItMoves} items={info.moves} />
      {report && (
        <p className="mt-3 text-xs text-white/70">
          {t.lastNight(
            report.day,
            report.revenue.bar + report.revenue.cover + report.revenue.table,
            report.profit,
          )}
        </p>
      )}
      {key && (
        <>
          <h4 className="mt-3 mb-1 text-[10px] tracking-[0.2em] text-white/50 uppercase">
            {t.recently}
          </h4>
          {recent.length === 0 ? (
            <p className="text-xs text-white/45">{t.nothingYet}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {recent.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs">
                  <span
                    className="w-14 shrink-0 text-right font-mono tabular-nums"
                    aria-label={String(c.delta)}
                  >
                    {c.delta > 0 ? "+" : "−"}
                    {fmt(Math.abs(c.delta))}
                  </span>
                  <span className="min-w-0 text-white/70">
                    <span className="text-white/45">
                      {t.when(
                        c.day,
                        c.minute != null ? clock(c.minute) : undefined,
                      )}{" "}
                      ·{" "}
                    </span>
                    {eventText(c.event)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Block({ title, items }: { title: string; items: string[] }) {
  return (
    <>
      <h4 className="mt-3 mb-1 text-[10px] tracking-[0.2em] text-white/50 uppercase">
        {title}
      </h4>
      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs leading-relaxed text-white/75">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </>
  );
}
