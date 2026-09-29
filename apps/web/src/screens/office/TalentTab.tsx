import {
  djs,
  genreForecast,
  ids,
  r03_bookDj,
  type GameState,
} from "@nyxeron/core";
import { Check, Headphones, Lock, Users } from "lucide-react";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { TiltCard } from "@/components/TiltCard";
import { en, fmt, genres } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

export function TalentTab({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const forecast = Object.entries(genreForecast(s)).sort((a, b) => b[1] - a[1]);
  const top = forecast[0]?.[0];

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_15rem]">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] gap-4">
        {ids(djs).map((id) => {
          const d = djs[id];
          const locked = d.minLevel > s.level;
          const booked = s.bookedTalent.includes(id);
          const match = d.genre === top;
          return (
            <li key={id}>
              <TiltCard className={cn(locked && "opacity-55")}>
                <div className="relative aspect-[3/4] overflow-hidden">
                  <Img
                    src={art.dj(id)}
                    alt={d.name}
                    className={cn(
                      "absolute inset-0 size-full object-cover transition-transform duration-700 group-hover/tilt:scale-105",
                      locked && "blur-[2px] brightness-50",
                    )}
                    fallback={
                      <Headphones className="absolute inset-0 m-auto size-10 text-white/30" />
                    }
                  />
                  <div className="absolute inset-x-0 bottom-0 h-1/2 bg-black/55 [mask-image:linear-gradient(to_top,black,transparent)]" />
                  <span className="absolute top-2 left-2 rounded-full border border-white/25 bg-black/55 px-2 py-0.5 text-[10px] tracking-[0.15em] uppercase backdrop-blur">
                    {genres[d.genre]}
                  </span>
                  {match && !locked && (
                    <span className="absolute top-2 right-2 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold tracking-[0.1em] text-black uppercase">
                      {en.talent.match}
                    </span>
                  )}
                  {locked && (
                    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs tracking-[0.15em] uppercase">
                      <Lock className="size-5" />
                      {en.talent.locked(d.minLevel)}
                    </span>
                  )}
                  <div className="absolute inset-x-3 bottom-2.5">
                    <div className="text-lg leading-tight font-semibold">
                      {d.name}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-white/70">
                      <Users className="size-3" />
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
                        <span
                          className="block h-full rounded-full bg-white"
                          style={{ width: `${d.fanbase}%` }}
                        />
                      </span>
                      <span className="font-mono">{d.fanbase}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-white/10 p-2.5">
                  <span className="font-mono text-sm">{fmt(d.fee)} C</span>
                  <button
                    disabled={locked || booked}
                    onClick={() => act((g) => r03_bookDj(g, id))}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold tracking-[0.12em] uppercase",
                      booked
                        ? "bg-white text-black"
                        : "border border-white/25 hover:bg-white hover:text-black",
                      locked && "pointer-events-none border-white/10",
                    )}
                  >
                    {booked && <Check className="size-3.5" />}
                    {booked ? en.talent.booked : en.talent.book}
                  </button>
                </div>
              </TiltCard>
            </li>
          );
        })}
      </ul>

      <aside className="h-fit rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <h4 className="mb-3 text-[10px] tracking-[0.2em] text-white/45 uppercase">
          {en.talent.forecast}
        </h4>
        <div className="flex h-40 gap-2">
          {forecast.map(([g, share]) => (
            <div key={g} className="flex flex-1 flex-col items-center gap-1.5">
              <span className="font-mono text-[10px] text-white/60">
                {Math.round(share * 100)}%
              </span>
              {/* Bars are relative to the leading genre so the chart always uses its full height. */}
              <div className="relative w-full flex-1">
                <div
                  className={cn(
                    "absolute inset-x-0 bottom-0 rounded-t-md transition-[height] duration-500",
                    g === top ? "bg-white" : "bg-white/25",
                  )}
                  style={{ height: `${(share / forecast[0]![1]) * 100}%` }}
                />
              </div>
              <span className="text-[10px] text-white/60">
                {genres[g] ?? g}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-white/55">
          {en.talent.forecastHint}
        </p>
      </aside>
    </div>
  );
}
