import { isInside } from "@nyxeron/core";
import { ChevronUp, Disc3, DoorOpen } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Backdrop } from "@/components/Backdrop";
import { Button } from "@/components/ui/button";
import { acquireEngine, releaseEngine, stopAuto } from "@/dj/session";
import { DjStudio } from "@/dj/Studio";
import { EnergyMeter } from "@/hud/CrowdMoves";
import { clock, en } from "@/i18n/en";
import { guestLeave, startMixing, stopMixing, useNet } from "@/net/session";
import { useProfile } from "@/profile";
import { useGame } from "@/store";
import { VenueView } from "@/venue/VenueView";

const t = en.live;

/**
 * A player DJ live in a CEO's club: the club from the host's snapshots, the player's avatar at the booth, and the
 * studio. The decks are the club's music: the mix state goes to every player, who plays along (dj/mixsync.ts).
 */
export function LiveDj() {
  const { remote, status, refused, room, error } = useNet();
  const { name, avatar } = useProfile();
  const go = useGame((x) => x.go);
  const [open, setOpen] = useState(true);
  const minimize = useCallback(() => setOpen(false), []);

  // Hold the decks for the whole session (the studio panel can collapse) and broadcast the mix.
  useEffect(() => {
    acquireEngine();
    startMixing();
    return () => {
      stopMixing();
      stopAuto();
      releaseEngine();
    };
  }, []);

  const leave = () => {
    guestLeave();
    go("dashboard");
  };

  if (!remote || status === "closed" || status === "error" || refused)
    return (
      <main className="fixed inset-0 flex items-center justify-center p-6">
        <Backdrop />
        <div className="glass enter relative w-full max-w-sm rounded-2xl p-6 text-center">
          <div className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
            {t.room(room)}
          </div>
          <p className="mt-2 text-lg">
            {refused
              ? refused
              : status === "error"
                ? t.error(error)
                : status === "closed"
                  ? t.closed
                  : t.connecting}
          </p>
          <Button className="mt-5" variant="outline" onClick={leave}>
            {en.dashboard.back}
          </Button>
        </div>
      </main>
    );

  const n = remote.night;
  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <VenueView s={remote} guestDj={{ name: name || "DJ", avatar }} />
      <header className="glass enter absolute inset-x-3 top-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{remote.clubName}</div>
          <div className="font-mono text-xs text-white/60">
            {n ? clock(n.minute) : en.guest.doorsClosed} ·{" "}
            {t.djLive(name || "DJ")}
            {status === "host-away" && ` · ${t.hostAway}`}
          </div>
        </div>
        {n && (
          <>
            <div className="w-40">
              <EnergyMeter s={remote} />
            </div>
            <Figure label={en.gig.crowd}>
              {n.guests.filter(isInside).length}
            </Figure>
          </>
        )}
        <button
          className="ml-auto flex h-10 items-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold tracking-[0.12em] text-black uppercase"
          onClick={leave}
        >
          <DoorOpen className="size-4" />
          <span className="hidden sm:inline">{en.gig.leave}</span>
        </button>
      </header>
      {open ? (
        <div className="fixed inset-x-0 bottom-0 z-20 flex max-h-[74dvh] flex-col">
          <DjStudio live crateOnly onClose={minimize} />
        </div>
      ) : (
        <button
          className="glass fixed inset-x-3 bottom-3 z-20 flex h-12 items-center justify-center gap-2 rounded-xl text-sm hover:bg-white/10"
          onClick={() => setOpen(true)}
        >
          <Disc3 className="size-4 animate-spin [animation-duration:3s]" />
          {en.gig.showDecks}
          <ChevronUp className="size-4" />
        </button>
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
      <div className="font-mono text-sm tabular-nums">{children}</div>
    </div>
  );
}
