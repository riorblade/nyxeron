import {
  fireStaff,
  hireStaff,
  ids,
  levels,
  staffRoles,
  type GameState,
} from "@nyxeron/core";
import { Lock, Minus, Plus, Users } from "lucide-react";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { TiltCard } from "@/components/TiltCard";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

export function StaffTab({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const hint = {
    security: en.staff.securityHint(levels[s.level].capacity),
    bartender: en.staff.bartenderHint,
  };
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-4">
      {ids(staffRoles).map((r) => {
        const role = staffRoles[r];
        const locked = role.minLevel > s.level;
        return (
          <li key={r}>
            <TiltCard className={cn(locked && "opacity-50")}>
              <div className="grid grid-cols-[9rem_1fr]">
                <div className="relative aspect-[3/4]">
                  <Img
                    src={art.staff(r)}
                    alt={role.name}
                    className={cn(
                      "absolute inset-0 size-full object-cover",
                      locked && "brightness-50",
                    )}
                    fallback={
                      <Users className="absolute inset-0 m-auto size-8 text-white/30" />
                    }
                  />
                  {locked && (
                    <Lock className="absolute inset-0 m-auto size-6" />
                  )}
                </div>
                <div className="flex flex-col p-4">
                  <div className="text-lg font-semibold">{role.name}</div>
                  <div className="font-mono text-xs text-white/50">
                    {en.staff.wage(role.wagePerDay)}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-white/65">
                    {locked ? en.office.lockedTab(role.minLevel) : hint[r]}
                  </p>
                  <div className="mt-auto flex items-center justify-between pt-3">
                    <button
                      aria-label={en.staff.fire}
                      disabled={locked || s.staff[r] === 0}
                      onClick={() => act((g) => fireStaff(g, r))}
                      className="flex size-9 items-center justify-center rounded-lg border border-white/20 hover:bg-white/10 disabled:opacity-30"
                    >
                      <Minus className="size-4" />
                    </button>
                    <span className="font-mono text-3xl tabular-nums">
                      {s.staff[r]}
                    </span>
                    <button
                      aria-label={en.staff.hire}
                      disabled={locked}
                      onClick={() => act((g) => hireStaff(g, r))}
                      className="flex size-9 items-center justify-center rounded-lg bg-white text-black disabled:opacity-30"
                    >
                      <Plus className="size-4" />
                    </button>
                  </div>
                </div>
              </div>
            </TiltCard>
          </li>
        );
      })}
    </ul>
  );
}
