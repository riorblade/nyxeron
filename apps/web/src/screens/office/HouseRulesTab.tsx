import {
  coverPrice,
  expectedGuests,
  femaleShare,
  priceScale,
  setPolicy,
  standardCover,
  strategy,
  tablesFor,
  type DressCode,
  type GameState,
  type HappyHourSlot,
} from "@nyxeron/core";
import { Minus, Plus } from "lucide-react";
import { en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

const t = en.rules;
const CODES: DressCode[] = ["none", "smart", "strict"];
const SLOTS: HappyHourSlot[] = ["off", "early", "late"];

/** Door policy: ladies' night and dress code, with tonight's forecast so the trade-off is visible. */
export function HouseRulesTab({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const p = s.policy;
  const cover = coverPrice(s);
  const std = standardCover(s);
  // Round steps of about 10% of a typical cover at this level (1, 2 or 5 × 10ⁿ).
  const raw = (strategy.cover.reference * priceScale(s.level)) / 10;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= raw * 0.75)!;
  const setCover = (c: number | null) => act((g) => setPolicy(g, { cover: c }));
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium">{t.cover}</h3>
            <p className="mt-1 text-sm leading-relaxed text-white/65">
              {t.coverDesc}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              aria-label="Lower cover"
              disabled={cover <= 0}
              onClick={() => setCover(Math.max(0, cover - step))}
              className="flex size-9 items-center justify-center rounded-lg border border-white/20 hover:bg-white/10 disabled:opacity-30"
            >
              <Minus className="size-4" />
            </button>
            <span className="w-24 text-center font-mono text-xl tabular-nums">
              {fmt(cover)} C
            </span>
            <button
              aria-label="Raise cover"
              onClick={() => setCover(cover + step)}
              className="flex size-9 items-center justify-center rounded-lg border border-white/20 hover:bg-white/10"
            >
              <Plus className="size-4" />
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-white/60">
          {t.coverStandard(fmt(std))}
          {p.cover != null && p.cover !== std && (
            <button
              className="underline underline-offset-2 hover:text-white"
              onClick={() => setCover(null)}
            >
              {t.coverReset}
            </button>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="font-medium">{t.happy}</h3>
        <p className="mt-1 text-sm leading-relaxed text-white/65">
          {t.happyDesc}
        </p>
        <div
          className="mt-3 grid gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t.happy}
        >
          {SLOTS.map((h) => (
            <button
              key={h}
              role="radio"
              aria-checked={p.happyHour === h}
              onClick={() => act((g) => setPolicy(g, { happyHour: h }))}
              className={cn(
                "rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                p.happyHour === h
                  ? "border-white bg-white font-medium text-black"
                  : "border-white/12 hover:bg-white/[0.06]",
              )}
            >
              {t.happySlots[h]}
            </button>
          ))}
        </div>
      </section>

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
