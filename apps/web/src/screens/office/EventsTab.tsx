import type { GameState } from "@nyxeron/core";
import { EventsPanel } from "../EventsPanel";

/** Office → Events: schedule this club's events (public or private, date and time, length) and share invites. */
export function EventsTab({ s }: { s: GameState }) {
  return (
    <div className="max-w-3xl">
      <EventsPanel club={s.clubName} level={s.level} />
    </div>
  );
}
