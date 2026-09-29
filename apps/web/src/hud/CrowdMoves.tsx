import {
  active,
  crowdMove,
  strategy,
  tacticBlock,
  type GameState,
  type TacticId,
} from "@nyxeron/core";
import { Disc3, Mic, Users } from "lucide-react";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

const t = en.moves;
const MOVES: { id: TacticId; icon: typeof Mic }[] = [
  { id: "mcHype", icon: Mic },
  { id: "hostsFloor", icon: Users },
  { id: "djAnthem", icon: Disc3 },
];
const need = { mcHype: t.needMc, hostsFloor: t.needHost, djAnthem: t.needDj };

/** Room energy 0–100; below the leave threshold it pulses as a warning. */
export function EnergyMeter({ s }: { s: GameState }) {
  const e = Math.round(s.night?.energy ?? 0);
  const flat = e < strategy.energy.leaveBelowEnergy;
  return (
    <div title={t.energyHint}>
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-[10px] tracking-[0.2em] text-white/60 uppercase">
          {t.energy}
        </h3>
        <span className="font-mono text-sm tabular-nums">{e}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={cn(
            "h-full rounded-full bg-white transition-[width] duration-700",
            flat && "animate-pulse bg-white/50",
          )}
          style={{ width: `${e}%` }}
        />
      </div>
    </div>
  );
}

/** MC hype, hosts to the floor, DJ anthem: timed moves with cooldowns. */
export function CrowdMoves({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const n = s.night;
  if (!n) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] tracking-widest text-white/60 uppercase">
        {t.title}
      </h3>
      <EnergyMeter s={s} />
      <div className="grid gap-1.5 pt-1">
        {MOVES.map(({ id, icon: Icon }) => {
          const block = tacticBlock(s, id);
          const st = n.tactics[id];
          const live = active(n, id);
          const status = live
            ? t.active(st!.until - n.minute)
            : block === "cooldown"
              ? id === "djAnthem"
                ? t.used
                : t.cooldown(st!.readyAt - n.minute)
              : block
                ? need[id]
                : t.ready;
          return (
            <button
              key={id}
              disabled={!!block}
              onClick={() => act((g) => crowdMove(g, id))}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed",
                live
                  ? "border-white bg-white/15 shadow-[0_0_18px_rgba(255,255,255,.18)]"
                  : "border-white/15 hover:bg-white/8 disabled:opacity-50",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-sm">{t[id]}</span>
                <span className="block truncate text-[11px] text-white/60">
                  {t[`${id}Desc`]}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-white/70">
                {status}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
