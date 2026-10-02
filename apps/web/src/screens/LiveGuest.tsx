import { useMemo } from "react";
import { Backdrop } from "@/components/Backdrop";
import { Button } from "@/components/ui/button";
import { en } from "@/i18n/en";
import { guestBuy, guestLeave, useNet } from "@/net/session";
import { useGame } from "@/state/store";
import { GuestNight, type OnlineGuest } from "./GuestNight";

const t = en.live;

/** A guest in a CEO's live club: the host's snapshots on screen, buys and leaving through the relay. */
export function LiveGuest() {
  const { remote, me, status, refused, last, ended, room, error } = useNet();
  const go = useGame((x) => x.go);
  const inside = !!remote?.night?.visitors?.[me];
  const waiting = inside
    ? null
    : status === "host-away"
      ? t.hostAway
      : refused
        ? t.refused(refused)
        : remote?.phase !== "night"
          ? t.doorsClosed
          : t.atTheDoor;
  const online: OnlineGuest = useMemo(
    () => ({
      buy: guestBuy,
      leave: guestLeave,
      waiting,
      last,
      ended,
    }),
    [waiting, last, ended],
  );

  if (!remote || status === "closed" || status === "error")
    return (
      <main className="fixed inset-0 flex items-center justify-center p-6">
        <Backdrop />
        <div className="glass enter relative w-full max-w-sm rounded-2xl p-6 text-center">
          <div className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
            {t.room(room)}
          </div>
          <p className="mt-2 text-lg">
            {status === "error"
              ? t.error(error)
              : status === "closed"
                ? t.closed
                : t.connecting}
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              guestLeave();
              go("dashboard");
            }}
          >
            {en.dashboard.back}
          </Button>
        </div>
      </main>
    );
  return <GuestNight s={remote} me={me} online={online} />;
}
