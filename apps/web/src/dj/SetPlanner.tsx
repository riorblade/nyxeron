import { ArrowDown, ArrowUp, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CRATE_TRACKS } from "@/audio";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { BLEND_GAP } from "./autodj";
import type { DjEngine } from "./engine";
import { PADS, type PadId } from "./sampler";
import { currentAuto, startAuto, stopAuto } from "./session";
import { item, useSets } from "./sets";
import {
  entryAt,
  TRANSITIONS,
  type DjSet,
  type SetItem,
  type TransitionId,
} from "./transitions";

const t = en.dj.planner;
const field =
  "h-7 rounded-md border border-white/15 bg-black/50 px-1.5 text-xs outline-none focus:border-white/50";

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** "1:03" or "63" → seconds. */
const parseTime = (v: string) => {
  const [m, s] = v.includes(":") ? v.split(":") : ["0", v];
  const n = Number(m) * 60 + Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Plan a set before the event: tracks in order, where each starts, how long it plays, and the move (+ pad) into the
 * next. Preview it here; pick it in the Office for the club to play when the DJ slot starts.
 */
export function SetPlanner({ engine }: { engine: DjEngine }) {
  const { sets, save, remove, tonight, setTonight } = useSets();
  const [sel, setSel] = useState(sets[0]?.id ?? "");
  const set = sets.find((x) => x.id === sel) ?? sets[0];
  const bpms = useBpms(engine, set);
  const auto = currentAuto();
  const playing = !!auto && auto.set.id === set?.id;

  const update = (patch: Partial<DjSet>) => set && save({ ...set, ...patch });
  const setItem = (i: number, patch: Partial<SetItem>) =>
    set &&
    update({
      items: set.items.map((it, j) => (j === i ? { ...it, ...patch } : it)),
    });
  const move = (i: number, d: -1 | 1) => {
    if (!set) return;
    const items = [...set.items];
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j]!, items[i]!];
    update({ items });
  };
  const create = () => {
    const id = `set-${Date.now().toString(36)}`;
    save({ id, name: t.newName(sets.length + 1), items: [] });
    setSel(id);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className={field}
          value={set?.id ?? ""}
          onChange={(e) => setSel(e.target.value)}
          aria-label={t.pick}
        >
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          className={cn(field, "flex items-center gap-1")}
          onClick={create}
        >
          <Plus className="size-3.5" /> {t.new}
        </button>
        {set && (
          <>
            <input
              className={cn(field, "w-36")}
              value={set.name}
              maxLength={32}
              onChange={(e) => update({ name: e.target.value })}
              aria-label={t.name}
            />
            <button
              className={cn(field, "ml-auto flex items-center gap-1")}
              onClick={() => {
                remove(set.id);
                setSel(sets.find((x) => x.id !== set.id)?.id ?? "");
              }}
              aria-label={t.delete}
              title={t.delete}
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>

      {set && (
        <>
          <ol className="space-y-1.5">
            {set.items.map((it, i) => {
              const nextIt = set.items[(i + 1) % set.items.length]!;
              const a = bpms[it.track];
              const b = bpms[nextIt.track];
              const clash =
                !!a &&
                !!b &&
                entryAt(it.transition) === 0 &&
                set.items.length > 1 &&
                Math.abs(a / b - 1) > BLEND_GAP;
              return (
                <li
                  key={i}
                  className={cn(
                    "rounded-lg border bg-white/[0.03] p-2",
                    playing && auto.index === i
                      ? "border-white/60"
                      : "border-white/10",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="w-5 font-mono text-[11px] text-white/50">
                      {i + 1}
                    </span>
                    <select
                      className={cn(field, "min-w-0 flex-1")}
                      value={it.track}
                      onChange={(e) => {
                        const tr = CRATE_TRACKS.find(
                          (x) => x.file === e.target.value,
                        )!;
                        setItem(i, { track: tr.file, title: tr.title });
                      }}
                      aria-label={t.track}
                    >
                      {CRATE_TRACKS.map((x) => (
                        <option key={x.file} value={x.file}>
                          {x.title}
                        </option>
                      ))}
                    </select>
                    <span className="w-16 text-right font-mono text-[10px] text-white/50">
                      {a ? `${a.toFixed(0)} BPM` : "…"}
                    </span>
                    <button
                      className={field}
                      onClick={() => move(i, -1)}
                      aria-label={t.up}
                    >
                      <ArrowUp className="size-3" />
                    </button>
                    <button
                      className={field}
                      onClick={() => move(i, 1)}
                      aria-label={t.down}
                    >
                      <ArrowDown className="size-3" />
                    </button>
                    <button
                      className={field}
                      onClick={() =>
                        update({ items: set.items.filter((_, j) => j !== i) })
                      }
                      aria-label={t.remove}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6.5 text-[11px] text-white/60">
                    <label className="flex items-center gap-1">
                      {t.from}
                      <input
                        className={cn(field, "w-14")}
                        defaultValue={mmss(it.start)}
                        key={`${set.id}-${i}-${it.start}`}
                        onBlur={(e) =>
                          setItem(i, { start: parseTime(e.target.value) })
                        }
                        aria-label={t.from}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      {t.play}
                      <select
                        className={field}
                        value={it.bars}
                        onChange={(e) =>
                          setItem(i, { bars: Number(e.target.value) })
                        }
                      >
                        {[8, 16, 32, 48, 64].map((n) => (
                          <option key={n} value={n}>
                            {t.bars(n)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span aria-hidden>→</span>
                    <select
                      className={field}
                      value={it.transition}
                      onChange={(e) =>
                        setItem(i, {
                          transition: e.target.value as TransitionId,
                        })
                      }
                      aria-label={t.move}
                      title={t.moveHints[it.transition]}
                    >
                      {TRANSITIONS.map((k) => (
                        <option key={k} value={k}>
                          {t.moves[k]}
                        </option>
                      ))}
                    </select>
                    <select
                      className={field}
                      value={it.beats}
                      onChange={(e) =>
                        setItem(i, { beats: Number(e.target.value) })
                      }
                      aria-label={t.length}
                    >
                      {[4, 8, 16, 32].map((n) => (
                        <option key={n} value={n}>
                          {t.beats(n)}
                        </option>
                      ))}
                    </select>
                    <select
                      className={field}
                      value={it.sfx ?? ""}
                      onChange={(e) =>
                        setItem(i, {
                          sfx: (e.target.value || null) as PadId | null,
                        })
                      }
                      aria-label={t.sfx}
                    >
                      <option value="">{t.noSfx}</option>
                      {PADS.map((p) => (
                        <option key={p} value={p}>
                          {en.dj.pads[p]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {clash && (
                    <p className="mt-1 pl-6.5 text-[11px] text-white/75">
                      ⚠ {t.clash(Math.round(Math.abs(a / b - 1) * 100))}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className={field}
              value=""
              onChange={(e) => {
                const tr = CRATE_TRACKS.find((x) => x.file === e.target.value);
                if (tr)
                  update({ items: [...set.items, item(tr.file, tr.title)] });
              }}
              aria-label={t.add}
            >
              <option value="">+ {t.add}</option>
              {CRATE_TRACKS.map((x) => (
                <option key={x.file} value={x.file}>
                  {x.title}
                </option>
              ))}
            </select>
            <button
              className={cn(
                "ml-auto flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium",
                playing ? "border border-white/30" : "bg-white text-black",
              )}
              disabled={!set.items.length}
              onClick={() => {
                if (playing) stopAuto();
                else startAuto(set);
                engine.emit();
              }}
            >
              {playing ? (
                <Square className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {playing ? t.stop : t.preview}
            </button>
            <label className="flex items-center gap-1.5 text-xs text-white/70">
              <input
                type="checkbox"
                checked={tonight === set.id}
                onChange={(e) => setTonight(e.target.checked ? set.id : null)}
                className="accent-white"
              />
              {t.tonight}
            </label>
          </div>
        </>
      )}
    </div>
  );
}

/** BPM of each track in the set (decoded once and cached by the engine), for the tempo-gap warnings. */
function useBpms(engine: DjEngine, set: DjSet | undefined) {
  const [bpms, setBpms] = useState<Record<string, number>>({});
  const tracks = [...new Set(set?.items.map((i) => i.track) ?? [])].join();
  useEffect(() => {
    let live = true;
    for (const id of tracks.split(",").filter(Boolean)) {
      const title = CRATE_TRACKS.find((x) => x.file === id)?.title ?? id;
      engine
        .track(id, title)
        .then((tr) => live && setBpms((b) => ({ ...b, [id]: tr.bpm })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [engine, tracks]);
  return bpms;
}

/** One line over the decks while a planned set is playing: now, next, and the move coming up. */
export function AutoStatus({ engine }: { engine: DjEngine }) {
  const auto = currentAuto();
  if (!auto || auto.state === "stopped") return null;
  const it = auto.item;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/30 bg-white/[0.06] px-3 py-1.5 text-xs">
      <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold text-black">
        {t.auto}
      </span>
      <span className="font-medium">{auto.set.name}</span>
      <span className="text-white/70">
        {auto.state === "loading" ? t.loading : t.now(it.title)}
      </span>
      <span className="text-white/55">
        {auto.state === "move"
          ? t.moving(t.moves[it.transition], auto.upcoming.title)
          : t.next(t.moves[it.transition], auto.upcoming.title)}
      </span>
      <button
        className="ml-auto flex items-center gap-1 rounded border border-white/25 px-2 py-0.5 hover:bg-white/10"
        onClick={() => {
          stopAuto();
          engine.emit();
        }}
      >
        <Square className="size-3" /> {t.stop}
      </button>
    </div>
  );
}
