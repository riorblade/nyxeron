import {
  ceoCall,
  djs,
  endNight,
  isInside,
  levels,
  night as nightData,
  nightOver,
  r10_forceDoorOpen,
  tickNight,
  type GameState,
} from "@nyxeron/core";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { Briefcase, Sofa, Volume2, VolumeX } from "lucide-react";
import { Office } from "./Office";
import { audio, nightTrack, TRACKS, useMusic } from "@/audio";
import { isAlert } from "@/hud/eventText";
import { Button } from "@/components/ui/button";
import { EventFeed } from "@/hud/EventFeed";
import { Objectives } from "@/hud/Objectives";
import { StockBars } from "@/hud/StockBars";
import { TopBar } from "@/hud/TopBar";
import { clock, duration, en, fmt, genres } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";
import { VenueView } from "@/venue/VenueView";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { StockTab } from "./office/StockTab";
import { getShoutouts, MAX_SHOUTOUTS, setShoutouts } from "@/venue/videotron";

/** 1 tick = 1 in-game minute; 1× = 1 tick per real second (a night ≈ 6 minutes). */
function useNightLoop() {
  const { paused, running, speed, intro, view } = useGame();
  useEffect(() => {
    // The clock waits while the CEO is in the office.
    if (paused || !running || intro || view !== "venue") return;
    const id = setInterval(() => {
      const { game, set } = useGame.getState();
      if (!game || game.phase !== "night") return;
      const next = tickNight(game);
      set(nightOver(next) ? endNight(next) : next);
    }, 1000 / speed);
    return () => clearInterval(id);
  }, [paused, running, speed, intro, view]);
}

function skipToEnd() {
  const { game, set } = useGame.getState();
  if (!game) return;
  let g = game;
  while (g.phase === "night" && !nightOver(g)) g = tickNight(g);
  set(endNight(g));
}

function CeoCall({ s, onDone }: { s: GameState; onDone?: () => void }) {
  const act = useGame((x) => x.act);
  const call = (c: "happyHour" | "closeDoor") => {
    act((g) => ceoCall(g, c));
    onDone?.();
  };
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] tracking-widest text-muted-foreground">
        {en.night.ceoCall}{" "}
        <span className="opacity-60">{en.night.ceoCallHint}</span>
      </h3>
      {(["happyHour", "closeDoor"] as const).map((c) => (
        <Button
          key={c}
          variant="outline"
          className="h-auto w-full flex-col items-start py-2"
          disabled={s.ceoCallUsed}
          onClick={() => call(c)}
        >
          <span>{en.night[c]}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {en.night[`${c}Desc`]}
          </span>
        </Button>
      ))}
    </section>
  );
}

/** Messages for the LED board above the DJ (birthday wishes and the like). */
function VideotronPanel() {
  const [list, setList] = useState(getShoutouts);
  const [text, setText] = useState("");
  const save = (next: string[]) => {
    setShoutouts(next);
    setList(next);
  };
  const add = () => {
    const t = text.trim();
    if (!t || list.length >= MAX_SHOUTOUTS) return;
    save([...list, t]);
    setText("");
  };
  return (
    <section>
      <h3 className="mb-1 text-[10px] tracking-[0.2em] text-white/45 uppercase">
        {en.videotron.title}
      </h3>
      <p className="mb-2 text-[11px] text-white/40">{en.videotron.hint}</p>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={text}
          maxLength={80}
          onChange={(e) => setText(e.target.value)}
          placeholder={en.videotron.placeholder}
          className="h-8 min-w-0 flex-1 rounded-md border border-white/15 bg-black/40 px-2 text-xs outline-none focus:border-white/50"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!text.trim() || list.length >= MAX_SHOUTOUTS}
        >
          {en.videotron.add}
        </Button>
      </form>
      <ul className="mt-2 space-y-1">
        {list.map((m, i) => (
          <li
            key={i}
            className="flex items-center gap-2 rounded-md bg-white/[0.04] px-2 py-1 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">{m}</span>
            <button
              className="text-white/45 hover:text-white"
              aria-label={en.videotron.remove}
              onClick={() => save(list.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Night soundtrack + alert tones. */
function useNightAudio(s: GameState, intro: boolean, paused: boolean) {
  // House warm-up until the set starts, then the booked DJ (the landing track never plays inside). The cutscene and the pause menu
  // muffle it rather than stopping it, so the music never cuts out.
  useMusic(nightTrack(s), intro || paused, "venue");

  // A short alert tone whenever something needs the CEO's attention.
  const seen = useRef(s.log.length);
  useEffect(() => {
    const fresh = s.log.slice(seen.current);
    seen.current = s.log.length;
    if (fresh.some(isAlert)) audio.alert();
  }, [s.log]);
}

function MuteButton({ className }: { className?: string }) {
  const muted = useSyncExternalStore(
    (cb) => audio.subscribe(cb),
    () => audio.muted,
  );
  const Icon = muted ? VolumeX : Volume2;
  return (
    <button
      className={className}
      onClick={() => audio.toggleMute()}
      aria-label={muted ? en.night.unmute : en.night.mute}
      title={`${muted ? en.night.unmute : en.night.mute} [M]`}
    >
      <Icon className="mx-auto size-4" />
    </button>
  );
}

export function Night({ s }: { s: GameState }) {
  const {
    running,
    speed,
    setRunning,
    setSpeed,
    act,
    intro,
    paused,
    view,
    setView,
  } = useGame();
  const [panel, setPanel] = useState(true);
  const [ceoOpen, setCeoOpen] = useState(false);
  useNightLoop();
  useNightAudio(s, intro, paused);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { paused, intro, view: v } = useGame.getState();
      if (
        e.target instanceof HTMLInputElement ||
        paused ||
        intro ||
        v !== "venue"
      )
        return;
      if (e.key.toLowerCase() === "o") return setView("office");
      if (e.key.toLowerCase() === "l") return setView("edit");
      if (e.key === " ") {
        e.preventDefault();
        setRunning(!useGame.getState().running);
      } else if (e.key === "1" || e.key === "2" || e.key === "3")
        setSpeed(Number(e.key) as 1 | 2 | 3);
      else if (e.key === "Tab") {
        e.preventDefault();
        setPanel((p) => !p);
      } else if (e.key.toLowerCase() === "q") setCeoOpen((o) => !o);
      else if (e.key.toLowerCase() === "m") audio.toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRunning, setSpeed, setView]);

  const n = s.night!;
  const inside = n.guests.filter(isInside);
  const queue = n.guests.filter((g) => g.state === "queue").length;
  const cap = levels[s.level].capacity;
  const mood = inside.length
    ? inside.reduce((a, g) => a + g.satisfaction, 0) / inside.length
    : 0;
  const dj = s.bookedTalent[0];
  const setStart = nightData.djSetStartMinute;
  const revenue =
    s.nightRevenue.bar + s.nightRevenue.cover + s.nightRevenue.table;

  const seg = (on: boolean) =>
    cn(
      "h-8 min-w-9 rounded-md px-2.5 font-mono text-xs",
      on ? "bg-white text-black" : "text-white/70 hover:bg-white/10",
    );

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <VenueView
        s={s}
        editing={view === "edit"}
        onDone={() => setView("venue")}
      />
      {/* HUD floats over the full-bleed venue; the layer ignores clicks except on panels. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 flex flex-col gap-3 p-3 [&>*]:pointer-events-auto",
          view === "edit" && "hidden",
        )}
      >
        <TopBar
          s={s}
          dense
          right={
            <>
              <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-1">
                <button
                  className={seg(!running)}
                  onClick={() => setRunning(!running)}
                  aria-label={running ? "Pause" : "Play"}
                >
                  {running ? "❚❚" : "▶"}
                </button>
                {([1, 2, 3] as const).map((x) => (
                  <button
                    key={x}
                    className={seg(speed === x && running)}
                    onClick={() => setSpeed(x)}
                  >
                    {x}×
                  </button>
                ))}
                <button
                  className={cn(seg(false), "tracking-wide")}
                  onClick={skipToEnd}
                >
                  {en.night.skip} ⏭
                </button>
                <MuteButton className={seg(false)} />
              </div>
              <button
                className="flex h-10 items-center gap-2 rounded-lg border border-white/25 bg-black/30 px-3.5 text-xs font-semibold tracking-[0.12em] uppercase hover:bg-white/10"
                onClick={() => setView("edit")}
                title={`${en.night.editLayout} [L]`}
              >
                <Sofa className="size-4" />
                {en.night.editLayout}
              </button>
              <button
                className="flex h-10 items-center gap-2 rounded-lg bg-white px-3.5 text-xs font-semibold tracking-[0.12em] text-black uppercase shadow-[0_0_20px_rgba(255,255,255,.2)]"
                onClick={() => setView("office")}
                title={`${en.night.toOffice} [O]`}
              >
                <Briefcase className="size-4" />
                {en.night.toOffice}
              </button>
            </>
          }
        />
        <div className="flex min-h-0 flex-1 gap-3 pointer-events-none! [&>*]:pointer-events-auto">
          {panel && (
            <aside
              className="glass enter w-80 space-y-6 overflow-y-auto rounded-xl p-4"
              style={{ "--d": "80ms" } as CSSProperties}
            >
              <CeoCall s={s} />
              <VideotronPanel />
              <section>
                <h3 className="mb-2 text-[10px] tracking-[0.2em] text-white/45 uppercase">
                  {en.stock.emergency}
                </h3>
                <StockTab s={s} compact />
              </section>
              {queue > 0 && inside.length >= cap && !n.doorForced && (
                <Button
                  variant="outline"
                  className="h-auto w-full flex-col items-start py-2"
                  onClick={() => act(r10_forceDoorOpen)}
                >
                  <span>{en.night.forceDoor}</span>
                  <span className="text-xs font-normal text-white/55">
                    {en.night.forceDoorDesc}
                  </span>
                </Button>
              )}
            </aside>
          )}
          {/* pointer-events-none! beats the row's [&>*]:pointer-events-auto, so the 3D canvas underneath gets orbit/pan/zoom/clicks. */}
          <div className="relative flex-1 pointer-events-none!">
            {!running && (
              <div className="glass absolute top-2 left-1/2 -translate-x-1/2 rounded-md px-4 py-1.5 text-xs tracking-[0.3em]">
                {en.night.paused}
              </div>
            )}
            {inside.some((g) => g.drunk >= nightData.fightDrunkThreshold) && (
              <div className="glass enter absolute top-2 right-2 rounded-md border-white/40 px-3 py-1.5 text-xs">
                <span className="mr-1 font-bold">!</span> {en.night.drunkAlert}
              </div>
            )}
            {ceoOpen && (
              <div className="pointer-events-auto absolute inset-0 flex items-center justify-center">
                <div className="glass glow enter w-80 rounded-2xl p-5">
                  <CeoCall s={s} onDone={() => setCeoOpen(false)} />
                </div>
              </div>
            )}
            <span className="absolute bottom-1 left-1 text-[10px] text-white/40">
              {en.night.panel}
            </span>
          </div>
          <aside
            className="glass enter w-72 space-y-6 overflow-y-auto rounded-xl p-4"
            style={{ "--d": "140ms" } as CSSProperties}
          >
            <Objectives s={s} />
            <section>
              <h3 className="mb-1 text-[10px] tracking-[0.2em] text-white/45">
                {en.night.capacity}
              </h3>
              <p
                className={cn(
                  "font-mono text-2xl tabular-nums",
                  inside.length >= cap && "animate-pulse",
                )}
              >
                {inside.length}
                <span className="text-white/40"> / {cap}</span>
              </p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-500"
                  style={{
                    width: `${Math.min(100, (inside.length / cap) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-white/55">
                {en.night.queue(queue)}
              </p>
            </section>
            <StockBars s={s} />
          </aside>
        </div>
        <footer
          className="glass enter grid grid-cols-[1fr_18rem_16rem] gap-6 rounded-xl px-5 py-3"
          style={{ "--d": "200ms" } as CSSProperties}
        >
          <EventFeed s={s} max={5} />
          <section className="flex gap-3 text-sm">
            {dj && (
              <Img
                src={art.dj(dj)}
                alt=""
                className={cn(
                  "size-14 shrink-0 rounded-lg border border-white/15 object-cover object-top",
                  n.minute >= setStart &&
                    "shadow-[0_0_20px_rgba(255,255,255,.25)]",
                )}
              />
            )}
            <div className="min-w-0">
              <h3 className="mb-1 text-[10px] tracking-[0.2em] text-white/45">
                {en.night.nowPlaying}
              </h3>
              <p>
                {dj && n.minute >= setStart
                  ? en.night.djLeft(
                      djs[dj].name,
                      genres[djs[dj].genre] ?? "",
                      duration(nightData.minutes - n.minute),
                    )
                  : dj
                    ? `${djs[dj].name} · ${clock(setStart)}`
                    : en.night.noDj}
              </p>
              {dj && n.minute >= setStart && TRACKS[dj]?.title && (
                <p className="mt-0.5 truncate text-xs text-white/60">
                  ♪ {TRACKS[dj]!.title}
                </p>
              )}
              <p className="mt-2 flex items-center gap-2 text-xs text-white/55">
                {en.night.mood}
                <span className="flex h-3 items-end gap-0.5">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span
                      key={i}
                      className={cn(
                        "w-1.5 rounded-sm",
                        i < Math.round(mood / 20) ? "bg-white" : "bg-white/15",
                      )}
                      style={{ height: `${40 + i * 15}%` }}
                    />
                  ))}
                </span>
              </p>
            </div>
          </section>
          <section className="text-sm">
            <h3 className="mb-1 text-[10px] tracking-[0.2em] text-white/45">
              {en.night.tonight}
            </h3>
            <p className="font-mono text-lg tabular-nums">{fmt(revenue)} C</p>
            <p className="text-xs text-white/55">
              {en.night.guestsTonight(
                n.guests.filter((g) => g.admitted).length,
              )}
            </p>
          </section>
        </footer>
      </div>
      {/* The office opens over the club; the venue scene stays alive underneath, so coming back is seamless. */}
      {view === "office" && (
        <div className="fixed inset-0 z-30">
          <Office s={s} />
        </div>
      )}
    </div>
  );
}
