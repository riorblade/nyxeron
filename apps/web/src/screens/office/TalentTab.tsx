import {
  bands,
  bookBand,
  djs,
  genreForecast,
  ids,
  night,
  r03_bookDj,
  type GameState,
} from "@nyxeron/core";
import { Check, Disc3, Headphones, Lock, Music2, Users } from "lucide-react";
import { art } from "@/lib/art";
import { Img } from "@/components/Img";
import { TiltCard } from "@/components/TiltCard";
import { useSets } from "@/dj/sets";
import { clock, en, fmt, genres } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/state/store";

export function TalentTab({ s }: { s: GameState }) {
  const act = useGame((x) => x.act);
  const forecast = Object.entries(genreForecast(s)).sort((a, b) => b[1] - a[1]);
  const top = forecast[0]?.[0];

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_15rem]">
      <div className="space-y-8">
        <MySet />
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
                    <span className="font-mono text-sm">
                      {fmt(d.fee)} {en.unit}
                    </span>
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
        <Bands s={s} top={top} />
      </div>

      <aside className="h-fit rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <h4 className="mb-3 text-[10px] tracking-[0.2em] text-white/60 uppercase">
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

/** Live bands: one a night on the stage (main act without a DJ, opening act before one). */
function Bands({ s, top }: { s: GameState; top?: string }) {
  const act = useGame((x) => x.act);
  const t = en.bands;
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium">{t.title}</h3>
        <p className="mt-1 text-sm text-white/65">
          {s.bookedTalent.length ? t.opener : t.main}
        </p>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] gap-4">
        {ids(bands).map((id) => {
          const b = bands[id];
          const locked = b.minLevel > s.level;
          const booked = s.bookedBand === id;
          const taken = !!s.bookedBand && !booked;
          return (
            <li key={id}>
              <TiltCard className={cn(locked && "opacity-55")}>
                <div className="relative aspect-[3/4] overflow-hidden">
                  <Img
                    src={art.band(id)}
                    alt={b.name}
                    className={cn(
                      "absolute inset-0 size-full object-cover transition-transform duration-700 group-hover/tilt:scale-105",
                      locked && "blur-[2px] brightness-50",
                    )}
                    fallback={
                      <Music2 className="absolute inset-0 m-auto size-8 text-white/30" />
                    }
                  />
                  <div className="absolute inset-x-0 bottom-0 h-1/2 bg-black/55 [mask-image:linear-gradient(to_top,black,transparent)]" />
                  {b.genre === top && !locked && (
                    <span className="absolute top-2 right-2 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-black">
                      {en.talent.match}
                    </span>
                  )}
                  <div className="absolute inset-x-0 bottom-0 p-3">
                    <div className="font-semibold">{b.name}</div>
                    <div className="text-xs text-white/70">
                      {genres[b.genre] ?? b.genre} · {t.fans(b.fanbase)}
                    </div>
                  </div>
                </div>
                <div className="p-3">
                  <button
                    disabled={locked || taken || booked || s.phase !== "day"}
                    onClick={() => act((g) => bookBand(g, id))}
                    className={cn(
                      "flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-semibold tracking-[0.12em] uppercase disabled:opacity-50",
                      booked
                        ? "bg-white text-black"
                        : "border border-white/25 enabled:hover:bg-white enabled:hover:text-black",
                    )}
                  >
                    {locked ? (
                      <>
                        <Lock className="size-3.5" />
                        {en.office.lockedTab(b.minLevel)}
                      </>
                    ) : booked ? (
                      <>
                        <Check className="size-3.5" /> {t.booked}
                      </>
                    ) : (
                      t.book(fmt(b.fee))
                    )}
                  </button>
                </div>
              </TiltCard>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The CEO's own planned set (DJ Studio → Sets): it plays from the DJ slot instead of the booked DJ's music. */
function MySet() {
  const { sets, tonight, setTonight } = useSets();
  const t = en.dj.mySet;
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <Disc3 className="size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">{t.title}</h3>
        <p className="mt-0.5 text-xs text-white/60">
          {t.desc(clock(night.djSetStartMinute))}
        </p>
      </div>
      <select
        className="h-9 rounded-md border border-white/15 bg-black/50 px-2 text-sm"
        value={tonight ?? ""}
        onChange={(e) => setTonight(e.target.value || null)}
        aria-label={t.title}
      >
        <option value="">{t.none}</option>
        {sets.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name} · {x.items.length}
          </option>
        ))}
      </select>
    </section>
  );
}
