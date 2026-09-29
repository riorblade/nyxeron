import {
  expectedGuests,
  femaleShare,
  setPolicy,
  tablesFor,
  type DressCode,
  type GameState,
} from "@nyxeron/core";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

const t = en.rules;
const CODES: DressCode[] = ["none", "smart", "strict"];

/** Door policy: ladies' night and dress code, with tonight's forecast so the trade-off is visible. */
export function HouseRulesTab({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const p = s.policy;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium">{t.ladies}</h3>
            <p className="mt-1 text-sm leading-relaxed text-white/65">
              {t.ladiesDesc}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={p.ladiesNight}
            aria-label={t.ladies}
            onClick={() =>
              act((g) => setPolicy(g, { ladiesNight: !p.ladiesNight }))
            }
            className={cn(
              "relative h-7 w-12 shrink-0 rounded-full border transition-colors",
              p.ladiesNight
                ? "border-white bg-white"
                : "border-white/25 bg-white/5",
            )}
          >
            <span
              className={cn(
                "absolute top-[3px] size-5 rounded-full transition-all",
                p.ladiesNight
                  ? "left-[1.45rem] bg-black"
                  : "left-1 bg-white/70",
              )}
            />
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="font-medium">{t.dress}</h3>
        <p className="mt-1 text-sm leading-relaxed text-white/65">
          {t.dressDesc}
        </p>
        <div
          className="mt-3 grid gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t.dress}
        >
          {CODES.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={p.dressCode === c}
              onClick={() => act((g) => setPolicy(g, { dressCode: c }))}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                p.dressCode === c
                  ? "border-white bg-white text-black"
                  : "border-white/12 hover:bg-white/[0.06]",
              )}
            >
              <div className="font-medium">{t.dressCodes[c]}</div>
              <div
                className={cn(
                  "mt-0.5 text-xs",
                  p.dressCode === c ? "text-black/60" : "text-white/60",
                )}
              >
                {t.dressDetail[c]}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-dashed border-white/15 p-4">
        <h3 className="mb-2 text-[10px] tracking-[0.2em] text-white/60 uppercase">
          {t.forecast}
        </h3>
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <Stat label={t.expected}>{expectedGuests(s)}</Stat>
          <Stat label={t.women}>{Math.round(femaleShare(s) * 100)}%</Stat>
          <Stat label={t.tables}>{tablesFor(s)}</Stat>
        </dl>
      </section>
    </div>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-white/60">{label}</dt>
      <dd className="font-mono text-xl tabular-nums">{children}</dd>
    </div>
  );
}
