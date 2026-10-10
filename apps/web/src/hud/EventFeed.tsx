import type { GameState } from "@nyxeron/core";
import type { CSSProperties } from "react";
import { clock, en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { eventText, isAlert } from "./eventText";
import { eventIcon } from "./icons";

/** A neon colour per kind of event (alerts are always red-orange), so the feed reads at a glance. */
const hues = [75, 300, 210, 150, 330];
const hueOf = (kind: string, alert: boolean) =>
  alert
    ? 25
    : hues[[...kind].reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length]!;

/** Today's events. `cards` = roomy rows with icon tiles (Office); default = dense one-liners (night HUD). */
export function EventFeed({
  s,
  max = 6,
  cards,
}: {
  s: GameState;
  max?: number;
  cards?: boolean;
}) {
  const events = s.log
    .filter((e) => e.day === s.day)
    .slice(-max)
    .reverse();
  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.22em] text-white/85">
        {en.night.feed}
      </h3>
      {events.length === 0 && (
        <p className="text-xs text-white/35">{en.night.feedEmpty}</p>
      )}
      <ul className={cn(cards ? "space-y-2" : "space-y-1")}>
        {events.map((e, i) => {
          const Icon = eventIcon(e);
          const alert = isAlert(e);
          return (
            <li
              key={s.log.length - i}
              className={cn(
                "enter flex items-start gap-2.5",
                cards && "tile items-center rounded-xl p-2",
                alert
                  ? "text-white"
                  : cards
                    ? "text-white/85"
                    : "text-white/65",
              )}
            >
              <span
                className={cn(
                  "chip flex shrink-0 items-center justify-center rounded-full",
                  cards ? "size-8" : "size-5",
                )}
                style={{ "--hue": hueOf(e.kind, alert) } as CSSProperties}
              >
                <Icon
                  className={cards ? "size-3.5" : "size-3"}
                  strokeWidth={1.75}
                />
              </span>
              <span
                className={cn(
                  "min-w-0 leading-snug",
                  cards ? "text-[13px]" : "truncate font-mono text-xs",
                )}
              >
                {e.minute !== undefined && (
                  <span className="mr-2 font-mono text-[11px] opacity-55">
                    {clock(e.minute)}
                  </span>
                )}
                {eventText(e)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
