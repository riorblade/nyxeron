import {
  applyPermit,
  expectedGuests,
  legal,
  ids,
  permitActive,
  permits,
  requiredPermits,
  type GameState,
} from "@nyxeron/core";
import { FileText } from "lucide-react";
import { en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

export function PermitsTab({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const required = requiredPermits(s.level);
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-4">
      {ids(permits).map((p) => {
        const pm = permits[p];
        const locked = pm.minLevel > s.level;
        const active = permitActive(s, p);
        const soon = active && s.permits[p].expiresDay - s.day <= 2;
        // Needs action now: required and missing/expiring, or the crowd permit on a big night.
        const urgent =
          !locked &&
          (required.includes(p) || p === "crowd") &&
          (!active || soon) &&
          (p !== "crowd" || expectedGuests(s) > legal.crowdPermitThreshold);
        const stamp = locked
          ? "LOCKED"
          : active
            ? soon
              ? "EXPIRING"
              : "VALID"
            : s.permits[p].valid
              ? "EXPIRED"
              : "NOT HELD";
        return (
          <li
            key={p}
            className={cn(
              "relative overflow-hidden rounded-xl border bg-[#141414] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,.06)]",
              urgent ? "border-white/60" : "border-white/10",
              locked && "opacity-40",
            )}
          >
            {/* Rubber stamp: the permit status at a glance. */}
            <span
              className={cn(
                "absolute top-4 right-4 rotate-[-8deg] rounded-md border-2 px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.2em]",
                active && !soon
                  ? "border-white/70 text-white/80"
                  : "border-white text-white",
              )}
            >
              {stamp}
            </span>
            <FileText className="size-6 text-white/60" strokeWidth={1.5} />
            <div className="mt-3 pr-24 text-base font-medium">{pm.name}</div>
            <div className="mt-0.5 text-[10px] tracking-[0.2em] text-white/60 uppercase">
              {required.includes(p) ? en.permits.required : en.permits.optional}
            </div>
            <div className="mt-6 space-y-1 text-xs text-white/60">
              <div>
                {locked
                  ? en.office.lockedTab(pm.minLevel)
                  : active
                    ? en.permits.active(s.permits[p].expiresDay)
                    : "—"}
              </div>
              {p === "crowd" && <div>{en.permits.crowdNote}</div>}
              <div className="font-mono">
                {fmt(pm.cost)} C / {pm.durationDays} days
              </div>
            </div>
            <button
              disabled={locked}
              aria-label={`${active ? en.permits.renew : en.permits.apply}: ${pm.name}`}
              onClick={() => act((g) => applyPermit(g, p))}
              className={cn(
                "mt-4 h-9 w-full rounded-lg text-xs font-semibold tracking-[0.14em] uppercase",
                urgent
                  ? "bg-white text-black"
                  : "border border-white/20 hover:bg-white hover:text-black",
              )}
            >
              {urgent
                ? active
                  ? en.permits.renewNow
                  : en.permits.applyNow
                : active
                  ? en.permits.renew
                  : en.permits.apply}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
