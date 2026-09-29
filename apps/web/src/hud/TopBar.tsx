import {
  economy,
  legal,
  levels,
  missingPermits,
  type GameState,
} from "@nyxeron/core";
import type { ReactNode } from "react";
import { Brand, HomeButton } from "@/components/Brand";
import { SettingsButton } from "@/components/SettingsDialog";
import { clock, en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { statIcon } from "./icons";

function Stat({
  label,
  icon: Icon,
  children,
  warn,
  dense,
  tier = 0,
  roomy,
}: {
  label: string;
  icon: LucideIcon;
  children: ReactNode;
  warn?: boolean;
  dense?: boolean;
  /** 0 = always shown; 1 = from xl; 2 = from 2xl. A stat in warning always shows. */
  tier?: 0 | 1 | 2;
  /** Night HUD shares the bar with the controls, so its secondary stats need more room before they show. */
  roomy?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2.5 border-l border-white/10 pl-4 first-of-type:border-0 first-of-type:pl-0",
        !warn && tier === 1 && (roomy ? "hidden 2xl:flex" : "hidden xl:flex"),
        !warn &&
          tier === 2 &&
          (roomy ? "hidden min-[1800px]:flex" : "hidden 2xl:flex"),
      )}
    >
      {!dense && (
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/12 bg-white/[0.04]",
            warn && "border-white/50 bg-white/10",
          )}
        >
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
      )}
      <div className="flex flex-col gap-0.5 leading-tight">
        <span className="text-[10px] tracking-[0.2em] whitespace-nowrap text-white/60 uppercase">
          {label}
        </span>
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            warn &&
              "animate-pulse underline decoration-dotted underline-offset-4",
          )}
        >
          {children}
        </span>
      </div>
    </div>
  );
}

/** 0–100 as a thin meter; the number stays readable next to it. */
function Meter({ value, warn }: { value: number; warn?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1 w-12 overflow-hidden rounded-full bg-white/10">
        <span
          className={cn(
            "block h-full rounded-full bg-white transition-[width] duration-500",
            warn && "bg-white/50",
          )}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </span>
      {value}
    </span>
  );
}

const stars = (rep: number) => "★".repeat(Math.round(rep / 20)).padEnd(5, "☆");

export function TopBar({
  s,
  right,
  className,
  dense,
}: {
  s: GameState;
  right?: ReactNode;
  className?: string;
  /** Night HUD: no icon tiles, so the speed controls fit. */
  dense?: boolean;
}) {
  const missing = missingPermits(s);
  const night = s.night && s.phase === "night";
  return (
    <header
      className={cn(
        "glass enter flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-3 py-2.5 sm:px-5 lg:flex-nowrap",
        className,
      )}
    >
      <Brand compact />
      <div className="flex max-w-52 min-w-28 shrink-0 flex-col leading-tight">
        <span className="truncate text-sm font-medium tracking-[0.22em] uppercase">
          {s.clubName}
        </span>
        <span className="text-xs text-white/55">
          {en.hud.day(s.day)}
          {night ? ` · ${clock(s.night!.minute)}` : ""} ·{" "}
          {en.hud.level(s.level, levels[s.level].name)}
        </span>
      </div>
      <Stat
        roomy={dense}
        dense={dense}
        icon={statIcon.coin}
        label={en.hud.coin}
        warn={s.coin < 0}
      >
        {fmt(s.coin)}
      </Stat>
      <Stat roomy={dense} dense={dense} icon={statIcon.rep} label={en.hud.rep}>
        <span className="tracking-tighter text-white/80">
          {stars(s.reputation)}
        </span>{" "}
        {s.reputation}
      </Stat>
      <Stat
        roomy={dense}
        dense={dense}
        tier={2}
        icon={statIcon.hype}
        label={en.hud.hype}
      >
        <Meter value={s.hype} />
      </Stat>
      <Stat
        roomy={dense}
        dense={dense}
        tier={1}
        icon={statIcon.safety}
        label={en.hud.safety}
        warn={s.safety < 40}
      >
        <Meter value={s.safety} warn={s.safety < 40} />
      </Stat>
      <Stat
        roomy={dense}
        dense={dense}
        tier={2}
        icon={statIcon.energy}
        label={en.hud.energy}
      >
        {"●".repeat(s.ceoEnergy)}
        <span className="text-white/25">
          {"●".repeat(Math.max(0, economy.ceoEnergyPerDay - s.ceoEnergy))}
        </span>
      </Stat>
      <Stat
        roomy={dense}
        dense={dense}
        tier={1}
        icon={statIcon.violations}
        label={en.hud.violations}
        warn={s.violations > 0}
      >
        {s.violations}/{legal.maxViolations}
      </Stat>
      <Stat
        roomy={dense}
        dense={dense}
        tier={2}
        icon={statIcon.permits}
        label={en.hud.permits}
        warn={missing.length > 0}
      >
        {missing.length ? `! ${missing.length}` : "✓"}
      </Stat>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2 lg:shrink-0 lg:flex-nowrap">
        {right}
        <SettingsButton />
        <HomeButton />
      </div>
    </header>
  );
}
