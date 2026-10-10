import { objectives, type GameState } from "@nyxeron/core";
import { Check } from "lucide-react";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";

/** Today's objectives as a checklist. `bare` drops the heading when a parent card already has one. */
export function Objectives({ s, bare }: { s: GameState; bare?: boolean }) {
  const list = objectives(s);
  if (!list.length) return null;
  return (
    <section>
      {!bare && (
        <h3 className="mb-2 text-[10px] tracking-[0.2em] text-white/60">
          {en.night.objectives}
        </h3>
      )}
      <ul className="space-y-2 text-sm">
        {list.map((o) => (
          <li
            key={o.id}
            className={cn(
              "flex items-start gap-2.5 text-[15px]",
              o.done ? "text-white/60" : "text-white/95",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                o.done
                  ? "border-emerald-300 bg-emerald-400 text-night shadow-[0_0_10px_#34d399]"
                  : "border-violet/60 bg-violet/10",
              )}
            >
              {o.done && <Check className="size-3" strokeWidth={3} />}
            </span>
            <span className={cn(o.done && "line-through decoration-white/30")}>
              {en.objectives(o)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
