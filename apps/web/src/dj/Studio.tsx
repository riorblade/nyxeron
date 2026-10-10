import {
  ChevronsLeft,
  ChevronsRight,
  Disc3,
  Pause,
  Play,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type PointerEvent,
  type ReactNode,
} from "react";
import { CRATE_TRACKS } from "@/audio";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { EQ_MAX, EQ_MIN, type Deck, type Mix } from "./deck";
import type { DjEngine } from "./engine";
import { acquireEngine, getEngine, releaseEngine } from "./session";
import { PADS } from "./sampler";
import { AutoStatus, SetPlanner } from "./SetPlanner";
import { useSets } from "./sets";

const t = en.dj;
/** Seconds of audio per platter turn (a 33⅓ rpm record). */
const TURN = 1.8;
/** Seconds either side of the playhead in the scrolling waveform. */
const SPAN = 6;

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The shared studio engine, held while the studio is open; re-renders on its changes. */
function useEngine() {
  const [engine] = useState(getEngine);
  useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.version,
  );
  useEffect(() => {
    acquireEngine();
    return releaseEngine;
  }, []);
  return engine.ready ? engine : null;
}

/**
 * The DJ studio: two decks, a mixer and the sampler. `live` = over the club at night (the crowd hears it);
 * otherwise a practice room reached from the dashboard.
 */
export function DjStudio({
  live,
  crateOnly,
  hotkeys = true,
  onClose,
}: {
  live?: boolean;
  /** Live DJ in someone else's club: only crate tracks (the other players can't play a file from this computer). */
  crateOnly?: boolean;
  /** Off while a dialog sits over the studio, so its keys (Esc, pads) go to the dialog. */
  hotkeys?: boolean;
  onClose: () => void;
}) {
  const engine = useEngine();
  const [tab, setTab] = useState<"crate" | "sets">("crate");

  useEffect(() => {
    // Capture phase: the studio's keys win over the night screen's (1–3 speed, Esc menu…).
    const onKey = (e: KeyboardEvent) => {
      if (!engine || !hotkeys || e.target instanceof HTMLInputElement) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 8) {
        e.stopImmediatePropagation();
        engine.pad(PADS[n - 1]!);
      } else if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [engine, hotkeys, onClose]);

  return (
    <section
      aria-label={t.title}
      className={cn(
        "glass enter flex flex-col gap-3 overflow-y-auto p-3 text-sm sm:p-4",
        live ? "rounded-t-2xl" : "rounded-2xl",
      )}
    >
      <header className="flex items-center gap-3">
        <Disc3 className="size-5" />
        <h2 className="text-[11px] tracking-[0.3em] uppercase">{t.title}</h2>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] tracking-[0.2em] uppercase",
            live
              ? "bg-white text-black"
              : "border border-white/25 text-white/70",
          )}
        >
          {live ? t.live : t.practice}
        </span>
        <span className="hidden text-[11px] text-white/50 md:inline">
          {t.hint}
        </span>
        <button
          className="ml-auto flex size-8 items-center justify-center rounded-md hover:bg-white/10"
          onClick={onClose}
          aria-label={t.close}
          title={`${t.close} [Esc]`}
        >
          <X className="size-4" />
        </button>
      </header>
      {engine ? (
        <>
          <AutoStatus engine={engine} />
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_17rem_1fr]">
            <DeckPanel
              engine={engine}
              deck={engine.a}
              other={engine.b}
              name="A"
            />
            <Mixer engine={engine} />
            <DeckPanel
              engine={engine}
              deck={engine.b}
              other={engine.a}
              name="B"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="mb-2 flex gap-1" role="tablist">
                {(["crate", "sets"] as const).map((k) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={tab === k}
                    onClick={() => setTab(k)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[10px] tracking-[0.25em] uppercase",
                      tab === k
                        ? "bg-white text-black"
                        : "text-white/60 hover:bg-white/10",
                    )}
                  >
                    {t.tabs[k]}
                  </button>
                ))}
              </div>
              {tab === "crate" ? (
                <Browser engine={engine} crateOnly={crateOnly} />
              ) : (
                <SetPlanner engine={engine} />
              )}
            </div>
            <Pads engine={engine} />
          </div>
        </>
      ) : null}
    </section>
  );
}

// ---------- deck ----------

function DeckPanel({
  engine,
  deck,
  other,
  name,
}: {
  engine: DjEngine;
  deck: Deck;
  other: Deck;
  name: "A" | "B";
}) {
  const act = (fn: () => void) => () => {
    fn();
    engine.emit();
  };
  const tr = deck.track;
  const pitch = Math.round((deck.tempo - 1) * 1000) / 10;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="flex items-baseline gap-2">
        <span className="flex size-6 items-center justify-center rounded bg-white font-mono text-xs font-bold text-black">
          {name}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {tr?.title ?? t.empty}
        </span>
        {tr && (
          <>
            <span className="font-mono text-xs text-white/70 tabular-nums">
              {deck.liveBpm.toFixed(1)} BPM
            </span>
            <Btn
              small
              onClick={act(() => {
                deck.scaleBpm(0.5);
                useSets.getState().fixBpm(tr.id, 0.5);
              })}
              title={t.bpmHint}
            >
              ÷2
            </Btn>
            <Btn
              small
              onClick={act(() => {
                deck.scaleBpm(2);
                useSets.getState().fixBpm(tr.id, 2);
              })}
              title={t.bpmHint}
            >
              ×2
            </Btn>
          </>
        )}
      </div>
      <Waveform deck={deck} />
      <div className="flex gap-3">
        <Platter engine={engine} deck={deck} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="grid grid-cols-4 gap-1">
            <Btn onClick={act(() => deck.cueButton())} disabled={!tr}>
              {t.cue}
            </Btn>
            <Btn
              onClick={act(() => deck.toggle())}
              disabled={!tr}
              on={deck.playing}
            >
              {deck.playing ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
            </Btn>
            <Btn
              onClick={act(() => {
                deck.syncTo(other);
                engine.syncEcho();
              })}
              disabled={!tr || !other.track}
              title={t.syncHint}
            >
              {t.sync}
            </Btn>
            <Btn
              onClick={act(() => deck.setReverse(!deck.reverse))}
              disabled={!tr}
              on={deck.reverse}
              title={t.reverseHint}
            >
              {t.reverse}
            </Btn>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {deck.hotCues.map((c, i) => (
              <Btn
                key={i}
                disabled={!tr}
                on={c != null}
                onClick={act(() => deck.hotCue(i))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  deck.hotCue(i, true);
                  engine.emit();
                }}
                title={t.hotCueHint}
              >
                {String.fromCharCode(65 + i)}
              </Btn>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {[1, 2, 4, 8].map((b) => (
              <Btn
                key={b}
                disabled={!tr}
                on={deck.loop?.beats === b}
                onClick={act(() => deck.setLoop(b))}
                title={t.loopHint}
              >
                ⟲{b}
              </Btn>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-1">
            <Btn
              onClick={act(() => deck.jump(-4))}
              disabled={!tr}
              title={t.jumpHint}
            >
              <ChevronsLeft className="size-4" />4
            </Btn>
            <Btn
              onClick={act(() => deck.jump(4))}
              disabled={!tr}
              title={t.jumpHint}
            >
              4<ChevronsRight className="size-4" />
            </Btn>
            <Btn
              onClick={act(() => engine.brake(deck))}
              disabled={!deck.playing}
              title={t.brakeHint}
            >
              {t.brake}
            </Btn>
            <Btn
              onClick={act(() => engine.backspin(deck))}
              disabled={!tr}
              title={t.spinHint}
            >
              <RotateCcw className="size-3.5" />
              {t.spin}
            </Btn>
          </div>
        </div>
        <label className="flex w-10 flex-col items-center gap-1 text-[10px] text-white/60">
          {t.pitch}
          <input
            type="range"
            min={1 - deck.range}
            max={1 + deck.range}
            step={0.001}
            value={deck.tempo}
            onChange={(e) => {
              deck.setTempo(Number(e.target.value));
              engine.syncEcho();
              engine.emit();
            }}
            onDoubleClick={act(() => deck.setTempo(1))}
            aria-label={`${t.pitch} ${name}`}
            className="h-28 accent-white [direction:rtl] [writing-mode:vertical-lr]"
          />
          <span className="font-mono tabular-nums">
            {pitch > 0 ? "+" : ""}
            {pitch}%
          </span>
          <button
            className="rounded border border-white/15 px-1 font-mono text-[9px] hover:bg-white/10"
            onClick={act(() => deck.toggleRange())}
            title={t.rangeHint}
          >
            ±{Math.round(deck.range * 100)}
          </button>
        </label>
      </div>
      <div className="flex justify-between gap-2 text-[11px] text-white/55">
        <span>{t.nudge}</span>
        <span className="flex gap-1">
          <Btn small onClick={() => deck.nudge(-0.08)} disabled={!deck.playing}>
            −
          </Btn>
          <Btn small onClick={() => deck.nudge(0.08)} disabled={!deck.playing}>
            +
          </Btn>
        </span>
      </div>
    </div>
  );
}

/** Scrolling waveform around the playhead (beat grid, cues, loop), with a whole-track overview underneath. */
function Waveform({ deck }: { deck: Deck }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      const tr = deck.track;
      if (!c) return;
      const dpr = Math.min(2, devicePixelRatio);
      const w = (c.width = c.clientWidth * dpr);
      const h = (c.height = c.clientHeight * dpr);
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, w, h);
      if (!tr) return;
      const p = deck.position();
      const dur = tr.buffer.duration;
      const main = h * 0.72;
      const x = (sec: number) => ((sec - (p - SPAN)) / (2 * SPAN)) * w;
      // Loop region.
      if (deck.loop) {
        g.fillStyle = "rgba(255,255,255,.12)";
        g.fillRect(
          x(deck.loop.start),
          0,
          x(deck.loop.end) - x(deck.loop.start),
          main,
        );
      }
      // Waveform (peaks per column).
      g.fillStyle = "rgba(255,255,255,.75)";
      const n = tr.peaks.length;
      for (let px = 0; px < w; px += 2 * dpr) {
        const sec = p - SPAN + (px / w) * 2 * SPAN;
        if (sec < 0 || sec > dur) continue;
        const v = tr.peaks[Math.floor((sec / dur) * (n - 1))]!;
        const bh = v * main * 0.9;
        g.fillRect(px, (main - bh) / 2, dpr, bh);
      }
      // Beat grid (bars brighter).
      const beat = deck.beat;
      const first = Math.ceil((p - SPAN - tr.offset) / beat);
      for (let b = first; ; b++) {
        const sec = tr.offset + b * beat;
        if (sec > p + SPAN) break;
        g.fillStyle =
          b % 4 === 0 ? "rgba(255,255,255,.45)" : "rgba(255,255,255,.14)";
        g.fillRect(x(sec), 0, dpr, main);
      }
      // Cue markers.
      const mark = (sec: number, label: string) => {
        const mx = x(sec);
        if (mx < 0 || mx > w) return;
        g.fillStyle = "#fff";
        g.fillRect(mx, 0, dpr, main);
        g.font = `${10 * dpr}px ui-monospace, monospace`;
        g.fillText(label, mx + 3 * dpr, 11 * dpr);
      };
      mark(deck.cue, "CUE");
      deck.hotCues.forEach(
        (c, i) => c != null && mark(c, String.fromCharCode(65 + i)),
      );
      // Playhead.
      g.fillStyle = "#fff";
      g.fillRect(w / 2 - dpr, 0, 2 * dpr, main);
      // Overview strip.
      const oy = main + 4 * dpr;
      const oh = h - oy;
      g.fillStyle = "rgba(255,255,255,.35)";
      for (let px = 0; px < w; px += dpr) {
        const v = tr.peaks[Math.floor((px / w) * (n - 1))]!;
        g.fillRect(px, oy + (oh - v * oh) / 2, dpr, v * oh);
      }
      g.fillStyle = "rgba(255,255,255,.18)";
      g.fillRect(0, oy, (p / dur) * w, oh);
      g.fillStyle = "#fff";
      g.fillRect((p / dur) * w, oy, dpr, oh);
      if (time.current)
        time.current.textContent = `${mmss(p)} / −${mmss(dur - p)}`;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck]);
  return (
    <div className="relative">
      <canvas
        ref={ref}
        className="h-24 w-full cursor-pointer rounded-md bg-black/50"
        onClick={(e) => {
          // Click the overview strip to jump there.
          const r = e.currentTarget.getBoundingClientRect();
          if (!deck.track || e.clientY - r.top < r.height * 0.72) return;
          deck.seek(((e.clientX - r.left) / r.width) * deck.duration);
        }}
      />
      <span
        ref={time}
        className="absolute top-1 right-1.5 font-mono text-[10px] text-white/70 tabular-nums"
      />
    </div>
  );
}

/**
 * The platter: turns with the music; grab it to scratch (drag round, either way) or hold it still. One turn is
 * 1.8 s of audio, like a 33⅓ record.
 */
function Platter({ engine, deck }: { engine: DjEngine; deck: Deck }) {
  const disc = useRef<HTMLDivElement>(null);
  const grab = useRef<{ a: number; t: number; was: boolean } | null>(null);
  useEffect(() => {
    let raf = 0;
    const spin = () => {
      raf = requestAnimationFrame(spin);
      if (disc.current)
        disc.current.style.transform = `rotate(${(deck.position() / TURN) * 360}deg)`;
    };
    raf = requestAnimationFrame(spin);
    return () => cancelAnimationFrame(raf);
  }, [deck]);
  const angle = (e: PointerEvent) => {
    const r = disc.current!.getBoundingClientRect();
    return Math.atan2(
      e.clientY - (r.top + r.height / 2),
      e.clientX - (r.left + r.width / 2),
    );
  };
  return (
    <div
      ref={disc}
      role="slider"
      aria-label={t.platter}
      aria-valuenow={0}
      title={t.platterHint}
      className={cn(
        "relative size-28 shrink-0 cursor-grab touch-none rounded-full border border-white/20 bg-neutral-950 active:cursor-grabbing",
        !deck.track && "opacity-40",
      )}
      onPointerDown={(e) => {
        if (!deck.track) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        grab.current = { a: angle(e), t: performance.now(), was: deck.playing };
        deck.scratch(0);
      }}
      onPointerMove={(e) => {
        const g = grab.current;
        if (!g) return;
        const a = angle(e);
        let d = a - g.a;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        const now = performance.now();
        const dt = Math.max(8, now - g.t) / 1000;
        // Radians per second → seconds of audio per second.
        deck.scratch(((d / (2 * Math.PI)) * TURN) / dt);
        g.a = a;
        g.t = now;
      }}
      onPointerUp={() => {
        const g = grab.current;
        grab.current = null;
        if (g) deck.release(g.was);
        engine.emit();
      }}
    >
      {/* Grooves: concentric rings, then the label. */}
      {[8, 16, 24].map((i) => (
        <span
          key={i}
          className="absolute rounded-full border border-white/10"
          style={{ inset: `${i}%` }}
        />
      ))}
      <span className="absolute inset-[38%] rounded-full bg-white/90" />
      <span className="absolute top-1 left-1/2 h-4 w-0.5 -translate-x-1/2 rounded bg-white" />
    </div>
  );
}

// ---------- mixer ----------

function Mixer({ engine }: { engine: DjEngine }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="grid grid-cols-2 gap-3">
        <Channel engine={engine} deck={engine.a} name="A" />
        <Channel engine={engine} deck={engine.b} name="B" />
      </div>
      <label className="text-[10px] tracking-[0.2em] text-white/60 uppercase">
        {t.crossfader}
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={engine.crossfader}
          onChange={(e) => {
            engine.setCrossfader(Number(e.target.value));
            engine.syncEcho();
            engine.emit();
          }}
          onDoubleClick={() => {
            engine.setCrossfader(0);
            engine.emit();
          }}
          className="mt-1 w-full accent-white"
        />
        <span className="flex justify-between font-mono text-[10px] normal-case">
          <span>A</span>
          <span>B</span>
        </span>
      </label>
    </div>
  );
}

function Channel({
  engine,
  deck,
  name,
}: {
  engine: DjEngine;
  deck: Deck;
  name: string;
}) {
  const v = deck.mix;
  const set = (k: keyof Mix, x: number) => {
    deck.setMix(k, x);
    if (k === "echo") engine.syncEcho();
    engine.emit();
  };
  const row = (
    k: keyof Mix,
    label: string,
    min: number,
    max: number,
    reset: number,
    fmt?: (x: number) => string,
  ) => (
    <label className="grid grid-cols-[2.6rem_1fr] items-center gap-1 text-[10px] text-white/60">
      <span title={fmt?.(v[k])}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={(max - min) / 100}
        value={v[k]}
        onChange={(e) => set(k, Number(e.target.value))}
        onDoubleClick={() => set(k, reset)}
        aria-label={`${label} ${name}`}
        className="w-full accent-white"
      />
    </label>
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-bold">{name}</span>
        <Meter deck={deck} />
      </div>
      {row("trim", t.trim, 0, 1.6, 1)}
      {row("high", t.high, EQ_MIN, EQ_MAX, 0)}
      {row("mid", t.mid, EQ_MIN, EQ_MAX, 0)}
      {row("low", t.low, EQ_MIN, EQ_MAX, 0)}
      {row("filter", t.filter, -1, 1, 0)}
      {row("echo", t.echo, 0, 0.9, 0)}
      {row("reverb", t.reverb, 0, 1, 0)}
      <label className="mt-1 flex flex-col items-center gap-1 text-[10px] text-white/60">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={v.fader}
          onChange={(e) => set("fader", Number(e.target.value))}
          aria-label={`${t.fader} ${name}`}
          className="h-20 accent-white [direction:rtl] [writing-mode:vertical-lr]"
        />
        {t.fader}
      </label>
    </div>
  );
}

/** Peak meter for one channel (post-filter). */
function Meter({ deck }: { deck: Deck }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const l = deck.level();
      shown = Math.max(l, shown * 0.9);
      if (bar.current) bar.current.style.width = `${Math.round(shown * 100)}%`;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck]);
  return (
    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
      <span ref={bar} className="block h-full bg-white" />
    </span>
  );
}

// ---------- browser & pads ----------

function Browser({
  engine,
  crateOnly,
}: {
  engine: DjEngine;
  crateOnly?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const load = async (deck: Deck, id: string, title: string, file?: File) => {
    setBusy(id);
    setError(false);
    try {
      await engine.load(deck, id, title, file);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <ul className="space-y-1">
        {CRATE_TRACKS.map(({ file, title }) => (
          <li
            key={file}
            className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {busy === file && (
              <span className="text-[11px] text-white/50">{t.loading}</span>
            )}
            {(["A", "B"] as const).map((d) => (
              <Btn
                key={d}
                small
                onClick={() =>
                  void load(d === "A" ? engine.a : engine.b, file, title)
                }
              >
                {t.loadTo(d)}
              </Btn>
            ))}
          </li>
        ))}
      </ul>
      {crateOnly ? (
        <p className="mt-2 text-[11px] text-white/50">{t.crateOnly}</p>
      ) : (
        <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-white/20 px-2 py-2 text-xs text-white/65 hover:bg-white/[0.04]">
          <Upload className="size-4" />
          {t.upload}
          <input
            type="file"
            accept="audio/*"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const deck =
                engine.a.track && !engine.b.track ? engine.b : engine.a;
              void load(
                deck,
                `file:${f.name}:${f.size}`,
                f.name.replace(/\.[^.]+$/, ""),
                f,
              );
              e.target.value = "";
            }}
          />
        </label>
      )}
      {error && <p className="mt-1 text-xs">{t.loadError}</p>}
    </div>
  );
}

function Pads({ engine }: { engine: DjEngine }) {
  const [hit, setHit] = useState<string | null>(null);
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
      <h3 className="mb-2 text-[10px] tracking-[0.3em] text-white/60 uppercase">
        {t.sampler}
      </h3>
      <div className="grid grid-cols-4 gap-1.5">
        {PADS.map((p, i) => (
          <button
            key={p}
            onPointerDown={() => {
              engine.pad(p);
              setHit(p);
              setTimeout(() => setHit((h) => (h === p ? null : h)), 180);
            }}
            className={cn(
              "flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg border text-xs transition",
              hit === p
                ? "border-white bg-white text-black shadow-[0_0_20px_rgba(255,255,255,.4)]"
                : "border-white/15 bg-white/[0.04] hover:bg-white/10",
            )}
          >
            {t.pads[p]}
            <span className="font-mono text-[10px] opacity-50">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Btn({
  children,
  on,
  small,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  on?: boolean;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      {...rest}
      className={cn(
        "flex items-center justify-center gap-0.5 rounded-md border font-mono whitespace-nowrap transition disabled:opacity-30",
        small ? "h-6 px-2 text-[11px]" : "h-8 text-xs",
        on
          ? "border-white bg-white text-black"
          : "border-white/15 bg-white/[0.04] hover:bg-white/12",
        className,
      )}
    >
      {children}
    </button>
  );
}
