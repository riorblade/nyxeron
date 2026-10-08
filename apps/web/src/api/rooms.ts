import { useEffect } from "react";
import { useAccount } from "@/auth/account";
import { hostOpen, useNet } from "@/net/session";
import { useGame, type Screen } from "@/state/store";
import { events } from "./events";
import { call } from "./player";

/**
 * Clubs open right now (api: /api/rooms). A CEO's club is open to players whenever the CEO is in it, and is
 * announced here every 20 s so guests can find it without a code (a private club isn't listed: guests use the
 * invite link); the api forgets a club 45 s after its last announcement.
 */
export interface OpenClub {
  room: string;
  club: string;
  level: 1 | 2 | 3 | 4 | 5;
  host: string;
  players: number;
  night: boolean;
  since: number;
}

export async function fetchOpenClubs(): Promise<OpenClub[]> {
  const r = await fetch(`${import.meta.env.VITE_API_BASE ?? ""}/api/rooms`);
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as OpenClub[];
}

const HEARTBEAT_MS = 20_000;

/**
 * While the CEO is in a club, open it to players and keep it listed (unless it's private). Mounted once
 * in App; leaving the game closes the room (App's other effect), which ends the listing here.
 */
export function useHostedClub(screen: Screen) {
  const game = useGame((x) => x.game);
  const signedIn = useAccount((a) => !!a.account);
  const role = useNet((n) => n.role);
  const room = useNet((n) => n.room);
  // A change of visibility re-announces at once.
  const priv = useNet((n) => n.private);
  const clubName = game?.clubName;

  // Open the room when the CEO walks into their club.
  useEffect(() => {
    if (screen !== "game" || !signedIn || !clubName) return;
    if (useNet.getState().role !== "off") return;
    hostOpen(clubName).catch(() => {
      /* relay unreachable: the club still plays; RoomPanel offers to retry */
    });
  }, [screen, signedIn, clubName]);

  // Keep it listed while it's open; take it off the list when it closes.
  useEffect(() => {
    if (role !== "host" || !room || !signedIn) return;
    // Tonight's event at this club goes live with this room as soon as it's on (from 15 minutes before, even if
    // the club opened earlier); a private event makes the club private.
    let attached = false;
    const announce = () => {
      const g = useGame.getState().game;
      if (!g) return;
      if (!attached)
        events
          .attachRoom(g.clubName, room)
          .then((e) => {
            if (!e) return;
            attached = true;
            if (e.private) useNet.setState({ private: true });
          })
          .catch(() => {
            /* the next heartbeat retries */
          });
      call("POST", "/rooms", {
        room,
        club: g.clubName,
        level: g.level,
        players: Object.keys(useNet.getState().players).length,
        night: g.phase === "night",
        private: useNet.getState().private,
      }).catch(() => {
        /* the next heartbeat retries */
      });
    };
    announce();
    const id = setInterval(announce, HEARTBEAT_MS);
    return () => {
      clearInterval(id);
      call("DELETE", `/rooms/${room}`).catch(() => {});
    };
  }, [role, room, signedIn, priv]);
}
