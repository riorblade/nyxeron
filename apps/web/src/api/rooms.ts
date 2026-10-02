import { useEffect } from "react";
import { useAccount } from "@/auth/account";
import { hostOpen, useNet } from "@/net/session";
import { useGame, type Screen } from "@/state/store";
import { city } from "./city";
import { call } from "./player";

/**
 * Clubs open right now (api: /api/rooms). A CEO's club is open to players whenever the CEO is in it, and is
 * announced here every 20 s so guests can find it without a code; the api forgets a club 45 s after its last
 * announcement.
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
 * While the CEO is in a club (not the Basement challenge), open it to players and keep it listed. Mounted once
 * in App; leaving the game closes the room (App's other effect), which ends the listing here.
 */
export function useHostedClub(screen: Screen) {
  const game = useGame((x) => x.game);
  const signedIn = useAccount((a) => !!a.account);
  const role = useNet((n) => n.role);
  const room = useNet((n) => n.room);
  const mode = game?.mode;
  const clubName = game?.clubName;

  // Open the room when the CEO walks into their club.
  useEffect(() => {
    if (screen !== "game" || !signedIn || !clubName || mode === "basement")
      return;
    if (useNet.getState().role !== "off") return;
    hostOpen(clubName)
      .then((code) => city.roomOpened(code))
      .catch(() => {
        /* relay unreachable: the club still plays; RoomPanel offers to retry */
      });
  }, [screen, signedIn, clubName, mode]);

  // Keep it listed while it's open; take it off the list when it closes.
  useEffect(() => {
    if (role !== "host" || !room || !signedIn) return;
    const announce = () => {
      const g = useGame.getState().game;
      if (!g) return;
      call("POST", "/rooms", {
        room,
        club: g.clubName,
        level: g.level,
        players: Object.keys(useNet.getState().players).length,
        night: g.phase === "night",
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
  }, [role, room, signedIn]);
}
