import {
  isInside,
  night as nightData,
  nightOver,
  tickNight,
  type GameState,
} from "@nyxeron/core";
import { ChevronUp, Disc3, DoorOpen, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EnergyMeter } from "@/hud/CrowdMoves";
import { acquireEngine, releaseEngine, stopAuto } from "@/dj/session";
import { DjStudio } from "@/dj/Studio";
import { clock, duration, en, fmt } from "@/i18n/en";
import { cn, trapFocus } from "@/lib/utils";
import { useProfile } from "@/state/profile";
import { player } from "@/api/player";
import { useGame } from "@/state/store";
import { VenueView } from "@/venue/VenueView";

const t = en.gig;
/** Real milliseconds per in-game minute during a set: 01:00–04:00 plays out in about six minutes. */
const MS_PER_MINUTE = 2000;

/** The club runs itself (AI CEO); the DJ only has the decks. The clock can be paused. */
function useGigClock(stopped: boolean) {
  const running = useGame((x) => x.running);
  useEffect(() => {
    if (!running || stopped) return;
    const id = setInterval(() => {
      const { game, set } = useGame.getState();
      if (game && !nightOver(game)) set(tickNight(game));
    }, MS_PER_MINUTE);
    return () => clearInterval(id);
  }, [running, stopped]);
}

/**
 * Playing a DJ gig: the player's avatar at the decks, the studio live over the club (collapsible, the music keeps
 * going), the crowd's energy, and the fee at 04:00.
 */
export function GigNight({ s }: { s: GameState }) {
  const { running, setRunning, go, gig } = useGame();
  const { name, avatar } = useProfile();
  const [open, setOpen] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const over = nightOver(s);
  useGigClock(over || leaving);
  const n = s.night!;
  const inside = n.guests.filter(isInside).length;
  const minimize = useCallback(() => setOpen(false), []);

  // The decks stay live for the whole gig, even with the studio panel collapsed.
  useEffect(() => {
    acquireEngine();
    return () => {
      stopAuto();
      releaseEngine();
    };
  }, []);

  const done = (paid: boolean) => {
    if (paid && gig) player.payGig(gig.fee);
    go("dashboard");
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <VenueView
        s={s}
        active={!over}
        guestDj={{ name: name || en.dashboard.anon, avatar }}
      />
      <header className="glass enter absolute inset-x-3 top-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{s.clubName}</div>
          <div className="font-mono text-xs text-white/60">
            {clock(n.minute)} · {t.left(duration(nightData.minutes - n.minute))}
          </div>
        </div>
        <div className="w-40">
          <EnergyMeter s={s} />
        </div>
        <Figure label={t.crowd}>{inside}</Figure>
        <Figure label={t.fee}>
          {fmt(gig?.fee ?? 0)} {en.unit}
        </Figure>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="flex size-10 items-center justify-center rounded-lg border border-white/25 bg-black/30 hover:bg-white/10"
            onClick={() => setRunning(!running)}
            aria-label={running ? t.pause : t.resume}
            title={running ? t.pause : t.resume}
          >
            {running ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4" />
            )}
          </button>
          <button
            className="flex h-10 items-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold tracking-[0.12em] text-black uppercase"
            onClick={() => setLeaving(true)}
          >
            <DoorOpen className="size-4" />
            <span className="hidden sm:inline">{t.leave}</span>
          </button>
        </div>
      </header>

      {open ? (
        <div className="fixed inset-x-0 bottom-0 z-20 flex max-h-[74dvh] flex-col">
          <DjStudio live onClose={minimize} />
        </div>
      ) : (
        <button
          className="glass fixed inset-x-3 bottom-3 z-20 flex h-12 items-center justify-center gap-2 rounded-xl text-sm hover:bg-white/10"
          onClick={() => setOpen(true)}
        >
          <Disc3 className="size-4 animate-spin [animation-duration:3s]" />
          {t.showDecks}
          <ChevronUp className="size-4" />
        </button>
      )}

      {(over || leaving) && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div
            role="alertdialog"
            aria-modal
            aria-labelledby="gig-end"
            onKeyDown={trapFocus}
            className="glass glow enter w-full max-w-sm rounded-2xl p-6"
          >
            <div className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
              {s.clubName}
            </div>
            <h2 id="gig-end" className="mt-1 text-2xl font-medium">
              {over ? t.doneTitle : t.leaveTitle}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/65">
              {over ? t.doneText : t.leaveText}
            </p>
            {over && (
              <dl className="mt-4 space-y-1.5 text-sm">
                <Row label={t.crowd}>
                  {n.guests.filter((g) => g.admitted).length}
                </Row>
                <Row label={t.peak}>{Math.round(n.peakEnergy)}</Row>
                <Row label={t.fee}>
                  +{fmt(gig?.fee ?? 0)} {en.unit}
                </Row>
              </dl>
            )}
            <div className="mt-5 flex justify-end gap-2">
              {!over && (
                <Button variant="ghost" onClick={() => setLeaving(false)}>
                  {t.stay}
                </Button>
              )}
              <Button autoFocus onClick={() => done(over)}>
                {over ? t.collect : t.leave}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] tracking-[0.2em] text-white/50 uppercase">
        {label}
      </div>
      <div className={cn("font-mono text-sm tabular-nums")}>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/55">{label}</dt>
      <dd className="font-mono tabular-nums">{children}</dd>
    </div>
  );
}
