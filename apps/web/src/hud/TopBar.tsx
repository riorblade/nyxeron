import {
  economy,
  legal,
  levels,
  missingPermits,
  type GameState,
} from "@nyxeron/core";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Brand, HomeButton } from "@/components/Brand";
import { SettingsButton } from "@/components/SettingsDialog";
import { clock, en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { statIcon } from "./icons";
import { StatInfo, type InfoKey } from "./StatInfo";

/** Which stat's explanation is open (one at a time); clicking anywhere else or Escape closes it. */
function useOpenStat() {
  const [open, setOpen] = useState<InfoKey | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return [open, setOpen] as const;
}

function Stat({
  label,
  icon: Icon,
  children,
  warn,
  dense,
  tier = 0,
  hue = 300,
  roomy,
  info,
  s,
  open,
  setOpen,
}: {
  info: InfoKey;
  s: GameState;
  open: InfoKey | null;
  setOpen: (k: InfoKey | null) => void;
  label: string;
  icon: LucideIcon;
  children: ReactNode;
  warn?: boolean;
  dense?: boolean;
  /** 0 = always shown; 1 = from xl; 2 = from 2xl. A stat in warning always shows. */
  tier?: 0 | 1 | 2;
  /** Night HUD shares the bar with the controls, so its secondary stats need more room before they show. */
  roomy?: boolean;
  /** The stat's neon colour (oklch hue) for its icon chip and meter. */
  hue?: number;
}) {
  const shown = open === info;
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center border-l border-violet/25 pl-4 first-of-type:border-0 first-of-type:pl-0",
        !warn && tier === 1 && (roomy ? "hidden 2xl:flex" : "hidden xl:flex"),
        !warn &&
          tier === 2 &&
          (roomy ? "hidden min-[1800px]:flex" : "hidden 2xl:flex"),
      )}
    >
      <button
        type="button"
        aria-expanded={shown}
        title={en.hud.infoHint}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(shown ? null : info);
        }}
        className={cn(
          "-my-1 -ml-1.5 flex items-center gap-2.5 rounded-lg py-1 pr-2 pl-1.5 text-left transition hover:bg-white/[0.07]",
          shown && "bg-white/10",
        )}
      >
        {!dense && (
          <span
            className={cn(
              "chip flex size-9 shrink-0 items-center justify-center rounded-xl",
              warn && "animate-pulse",
            )}
            style={{ "--hue": warn ? 25 : hue } as CSSProperties}
          >
            <Icon className="size-[18px]" strokeWidth={2} />
          </span>
        )}
        <div className="flex flex-col gap-0.5 leading-tight">
          <span className="text-[10px] font-semibold tracking-[0.2em] whitespace-nowrap text-white/70 uppercase">
            {label}
          </span>
          <span
            className={cn(
              "font-mono text-[15px] font-semibold tabular-nums",
              warn &&
                "animate-pulse underline decoration-dotted underline-offset-4",
            )}
          >
            {children}
          </span>
        </div>
      </button>
      {shown && <StatInfo s={s} stat={info} label={label} />}
    </div>
  );
}

/** 0–100 as a thin neon meter; the number stays readable next to it. */
function Meter({
  value,
  warn,
  hue = 210,
}: {
  value: number;
  warn?: boolean;
  hue?: number;
}) {
  const h = warn ? 25 : hue;
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-white/10">
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: `linear-gradient(90deg, oklch(0.6 0.2 ${h}), oklch(0.85 0.15 ${h}))`,
            boxShadow: `0 0 8px oklch(0.75 0.2 ${h} / 0.7)`,
          }}
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
  const [open, setOpen] = useOpenStat();
  const stat = { s, open, setOpen };
  return (
    <header
      className={cn(
        "glass enter relative z-40 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-3 py-2.5 sm:px-5 lg:flex-nowrap",
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
        info="coin"
        hue={75}
        {...stat}
        warn={s.coin < 0}
      >
        {fmt(s.coin)}
      </Stat>
      <Stat
        roomy={dense}
        dense={dense}
        icon={statIcon.rep}
        label={en.hud.rep}
        info="rep"
        hue={85}
        {...stat}
      >
        <span className="text-gold tracking-tighter">
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
        info="hype"
        hue={330}
        {...stat}
      >
        <Meter value={s.hype} hue={330} />
      </Stat>
      <Stat
        roomy={dense}
        dense={dense}
        tier={1}
        icon={statIcon.safety}
        label={en.hud.safety}
        info="safety"
        hue={210}
        {...stat}
        warn={s.safety < 40}
      >
        <Meter value={s.safety} warn={s.safety < 40} hue={210} />
      </Stat>
      <Stat
        roomy={dense}
        dense={dense}
        tier={2}
        icon={statIcon.energy}
        label={en.hud.energy}
        info="energy"
        hue={150}
        {...stat}
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
        info="violations"
        hue={45}
        {...stat}
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
        info="permits"
        hue={160}
        {...stat}
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
