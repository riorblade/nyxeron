import { create } from "zustand";
import { en } from "@/i18n/en";
import { useGame } from "@/state/store";
import { useAccount } from "@/auth/account";
import type { Party } from "./city";
import { loadCity } from "./city";
import { call } from "./player";

/**
 * Events (api: /api/events): a night a CEO schedules at one of their clubs, public or private, with a start time
 * and a length. Guests say they're going (or open a private event's invite link) and join with one click once the
 * host opens the club. City parties are events at a rented venue (`lease`).
 */
export type ClubEvent = Party;

export interface NewEvent {
  /** A rented city venue, or 0 for a practice club named by `club` + `level`. */
  lease?: number;
  club?: string;
  level?: number;
  startsAt: number;
  minutes: number;
  title: string;
  private: boolean;
}

interface EventStore {
  events: ClubEvent[];
  loaded: boolean;
}
export const useEvents = create<EventStore>(() => ({
  events: [],
  loaded: false,
}));

const base = import.meta.env.VITE_API_BASE ?? "";
const say = (msg: string, bad = false) => useGame.getState().notify(msg, bad);

export async function loadEvents() {
  try {
    const token = await useAccount.getState().token?.();
    const r = await fetch(`${base}/api/events`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) throw new Error(String(r.status));
    useEvents.setState({
      events: (await r.json()) as ClubEvent[],
      loaded: true,
    });
  } catch {
    useEvents.setState({ loaded: true });
  }
}

const inviteLink = (e: ClubEvent) =>
  `${location.origin}/?event=${e.invite ?? ""}`;

async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
  try {
    const v = await fn();
    if (ok) say(ok);
    return v;
  } catch (e) {
    say(en.events.failed((e as Error).message), true);
    return null;
  } finally {
    void loadEvents();
    void loadCity();
  }
}

export const events = {
  create: (e: NewEvent) =>
    act(() => call("POST", "/events", e), en.events.scheduled),
  cancel: (id: number) =>
    act(() => call("DELETE", `/events/${id}`), en.events.cancelled),
  rsvp: (id: number, going: boolean) =>
    act(() => call("POST", `/events/${id}/rsvp`, { going })),
  /** An invite link was opened: the event joins this player's list (private ones too). */
  openInvite: (code: string) =>
    act(
      () =>
        call(
          "GET",
          `/events/invite/${encodeURIComponent(code)}`,
        ) as Promise<unknown> as Promise<ClubEvent>,
      en.events.invitedToast,
    ),
  /** Copy an event's invite link (host). */
  copyInvite(e: ClubEvent) {
    void navigator.clipboard?.writeText(inviteLink(e));
    say(en.events.copied);
  },
  link: inviteLink,
  /**
   * The CEO opened this club: attach the room to its event that's on now (from 15 minutes before), so guests
   * going to it can join. Returns whether the club is private tonight.
   */
  async attachRoom(club: string, room: string): Promise<boolean> {
    await loadEvents();
    const now = Date.now() / 1000;
    const e = useEvents
      .getState()
      .events.find(
        (x) =>
          x.mine &&
          x.club === club &&
          now >= x.startsAt - 900 &&
          now < x.startsAt + x.minutes * 60,
      );
    if (!e) return false;
    await call("PUT", `/events/${e.id}/room`, { room }).catch(() => {});
    void loadEvents();
    return e.private;
  },
};
