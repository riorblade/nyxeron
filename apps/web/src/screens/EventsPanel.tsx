import {
  city as cityData,
  levels,
  tokens,
  type Level,
  type TokenId,
} from "@nyxeron/core";
import { CalendarClock, Copy, Globe, Lock } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { art } from "@/lib/art";
import { events, loadEvents, useEvents, type ClubEvent } from "@/api/events";
import { menuOf, priceRange, sales, type PriceList } from "@/api/sales";
import { Img } from "@/components/Img";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { guestJoin } from "@/net/session";
import { useProfile } from "@/state/profile";
import { useGame } from "@/state/store";

const t = en.events;
const field =
  "h-9 rounded-md border border-white/15 bg-black/30 px-2.5 text-sm outline-none focus:border-white/50";
const btn =
  "h-9 shrink-0 rounded-md bg-white px-3 text-xs font-medium text-black disabled:opacity-40";
const ghost =
  "h-8 shrink-0 rounded-md border border-white/15 px-3 text-xs hover:bg-white/10 disabled:opacity-40";
const label = "text-[10px] tracking-[0.25em] text-white/55 uppercase";

/** Keep events fresh while a panel shows them (every 15 s). */
export function useEventsLive() {
  useEffect(() => {
    void loadEvents();
    const id = setInterval(() => void loadEvents(), 15_000);
    return () => clearInterval(id);
  }, []);
  return useEvents();
}

/** "Sat 4 Oct, 22:00" in the player's own time zone. */
export const when = (unix: number) =>
  new Date(unix * 1000).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** The clock for countdowns, ticking every 30 s (kept out of render, which must stay pure). */
function useNow() {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** "in 2 h 5 min" / "now". */
export function startsIn(unix: number, now: number) {
  const s = Math.round(unix - now);
  if (s <= 0) return t.now;
  // Whole minutes, rounded up, then split: never "1 h 60 min".
  const mins = Math.ceil(s / 60);
  const d = Math.floor(mins / 1440),
    h = Math.floor((mins % 1440) / 60),
    m = mins % 60;
  return t.inTime(
    d ? `${d} d ${h} h` : h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`,
  );
}

/** datetime-local value for a moment, in local time. */
const localInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

const Badge = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex shrink-0 items-center gap-1 rounded border border-white/20 px-1.5 py-px text-[9px] tracking-[0.15em] text-white/75 uppercase">
    {children}
  </span>
);

/**
 * The host's events for one club: schedule (date and time picker, length, public or private) and manage (invite
 * link, who's going, cancel). `lease` for a rented city venue; a practice club is named by `club` + `level`.
 */
export function EventsPanel({
  club,
  level,
  lease = 0,
  form = true,
  onHost,
}: {
  club: string;
  level: Level;
  lease?: number;
  /** false: only the planned events, no scheduling form (it opens on demand). */
  form?: boolean;
  /** Shown on an event that's due (from 15 minutes before): go into the club to run it. */
  onHost?: (e: ClubEvent) => void;
}) {
  const { events: list } = useEventsLive();
  const mine = list.filter(
    (e) => e.mine && (lease ? e.leaseId === lease : e.club === club),
  );
  const [when_, setWhen] = useState(() => {
    const d = new Date(Date.now() + 3_600_000);
    d.setMinutes(0, 0, 0);
    return localInput(d);
  });
  const [minutes, setMinutes] = useState(cityData.party.defaultMinutes);
  const [title, setTitle] = useState("");
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = level < cityData.party.minLevel;
  const now = useNow();
  const max = localInput(
    new Date((now + cityData.party.maxAheadDays * 86_400) * 1000),
  );

  return (
    <section className="flex flex-col gap-3">
      <h3 className={label}>{t.title}</h3>
      {!form ? null : locked ? (
        <p className="text-sm text-white/55">{t.locked}</p>
      ) : (
        <form
          className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const created = await events.create({
              lease,
              club,
              level,
              startsAt: Math.floor(new Date(when_).getTime() / 1000),
              minutes,
              title: title.trim(),
              private: priv,
            });
            setBusy(false);
            if (created) setTitle("");
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <label className="flex flex-col gap-1 text-[11px] text-white/55">
              {t.when}
              <input
                type="datetime-local"
                className={field}
                value={when_}
                min={localInput(new Date(now * 1000))}
                max={max}
                onChange={(e) => setWhen(e.target.value)}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-white/55">
              {t.minutes}
              <select
                className={field}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              >
                {[5, 10, 15, 20, 30, 45, 60].map((m) => (
                  <option key={m} value={m}>
                    {t.minutesOpt(m)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-col gap-1 text-[11px] text-white/55">
              <legend className="mb-1">{t.who}</legend>
              <div className="flex rounded-md border border-white/15 p-0.5">
                {[
                  [false, t.public, Globe],
                  [true, t.private, Lock],
                ].map(([v, l, Icon]) => {
                  const I = Icon as typeof Globe;
                  return (
                    <button
                      key={String(v)}
                      type="button"
                      aria-pressed={priv === v}
                      onClick={() => setPriv(v as boolean)}
                      className={cn(
                        "flex h-8 items-center gap-1.5 rounded px-2.5 text-xs",
                        priv === v
                          ? "bg-white text-black"
                          : "text-white/70 hover:bg-white/10",
                      )}
                    >
                      <I className="size-3.5" /> {l as string}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className={cn(field, "flex-1")}
              maxLength={20}
              placeholder={t.titlePlaceholder}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label={t.titleLabel}
            />
            <button className={btn} disabled={busy}>
              <span className="flex items-center gap-1.5">
                <CalendarClock className="size-3.5" />
                {t.schedule}
              </span>
            </button>
          </div>
          <p className="text-[11px] text-white/50">
            {priv ? t.privateHint : t.publicHint}
          </p>
        </form>
      )}

      {mine.length === 0 ? (
        form && <p className="text-xs text-white/45">{t.none}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {e.title || e.club}
                  {e.live && <Badge>● {t.live}</Badge>}
                  <Badge>
                    {e.private ? (
                      <Lock className="size-2.5" />
                    ) : (
                      <Globe className="size-2.5" />
                    )}
                    {e.private ? t.private : t.public}
                  </Badge>
                </span>
                <span className="block text-xs text-white/55">
                  {when(e.startsAt)} · {t.minutesOpt(e.minutes)} ·{" "}
                  {startsIn(e.startsAt, now)} · {t.going(e.going)}
                </span>
              </span>
              {onHost && now >= e.startsAt - 900 && (
                <button className={btn} onClick={() => onHost(e)}>
                  {t.openClub}
                </button>
              )}
              {e.leaseId > 0 && now < e.startsAt && (
                <PriceEditor event={e.id} />
              )}
              <button className={ghost} onClick={() => events.copyInvite(e)}>
                <span className="flex items-center gap-1.5">
                  <Copy className="size-3.5" /> {t.copyInvite}
                </span>
              </button>
              <button
                className={ghost}
                onClick={() => void events.cancel(e.id)}
              >
                {t.cancel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Join a live event's club. */
async function joinEvent(e: ClubEvent) {
  const { name, avatar, wallet } = useProfile.getState();
  try {
    await guestJoin(e.room, {
      name: name || en.dashboard.anon,
      avatar,
      cash: wallet,
    });
    useGame.getState().go("live");
  } catch (err) {
    useGame.getState().notify(en.live.error((err as Error).message), true);
  }
}

/** Guest: live and upcoming events (public, plus private ones you were invited to), with Going and Join. */
export function EventsFeed() {
  const { events: list, loaded } = useEventsLive();
  const others = list.filter((e) => !e.mine);
  return (
    <section className="flex flex-col gap-2">
      <h3 className={label}>{t.feedTitle}</h3>
      {loaded && others.length === 0 && (
        <p className="text-xs text-white/45">{t.feedEmpty}</p>
      )}
      {others.map((e) => (
        <EventRow key={e.id} e={e} />
      ))}
    </section>
  );
}

function EventRow({ e }: { e: ClubEvent }) {
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const live = e.live && !!e.room;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
      <Img
        src={art.venue(e.level)}
        alt=""
        className="size-12 shrink-0 rounded-lg object-cover"
        fallback={<span className="size-12 rounded-lg bg-white/5" />}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {e.title || e.club}
          {live && <Badge>● {t.live}</Badge>}
          {e.private && (
            <Badge>
              <Lock className="size-2.5" /> {t.invited}
            </Badge>
          )}
        </span>
        <span className="block text-xs text-white/55">
          {e.club} · {levels[e.level as Level].name} · {t.by(e.owner)}
        </span>
        <span className="block text-xs text-white/55">
          {when(e.startsAt)} · {live ? t.onNow : startsIn(e.startsAt, now)} ·{" "}
          {t.going(e.going)}
        </span>
      </span>
      {live ? (
        <button
          className={btn}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await joinEvent(e);
            setBusy(false);
          }}
        >
          {t.join}
        </button>
      ) : (
        <button
          className={cn(ghost, e.iGo && "border-white/60 bg-white/10")}
          aria-pressed={!!e.iGo}
          onClick={() => void events.rsvp(e.id, !e.iGo)}
        >
          {e.iGo ? t.goingYes : t.goingAsk}
        </button>
      )}
    </div>
  );
}

/**
 * Seamless join: when an event you're going to goes live (its host opened the club), a banner offers to walk in.
 * Mounted on the dashboard.
 */
export function LiveEventBanner() {
  const { events: list } = useEventsLive();
  const e = list.find((x) => !x.mine && x.iGo && x.live && x.room);
  const [busy, setBusy] = useState(false);
  if (!e) return null;
  return (
    <div
      role="status"
      className="enter flex flex-wrap items-center gap-3 rounded-xl border border-white/40 bg-white/[0.08] px-4 py-3 shadow-[0_0_30px_rgba(255,255,255,.12)]"
    >
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-white" />
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{e.title || e.club}</span>{" "}
        <span className="text-white/70">{t.liveBanner(e.owner)}</span>
      </span>
      <button
        className={btn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await joinEvent(e);
          setBusy(false);
        }}
      >
        {t.joinNow}
      </button>
    </div>
  );
}

/** The host's Credit prices for a city party's real stock, before it starts. */
function PriceEditor({ event }: { event: number }) {
  const s = en.sales;
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PriceList | null>(null);
  const [draft, setDraft] = useState<Partial<Record<TokenId, number>>>({});
  const [busy, setBusy] = useState(false);
  const say = useGame((x) => x.notify);
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    try {
      const l = await sales.prices(event);
      setList(l);
      setDraft(
        Object.fromEntries(
          (Object.keys(l.wholesale) as TokenId[]).map((t) => [
            t,
            l.prices[t] ?? 0,
          ]),
        ),
      );
    } catch (err) {
      say(s.errors[(err as Error).message] ?? (err as Error).message, true);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await sales.setPrices(event, menuOf(draft));
      say(s.saved);
      setOpen(false);
    } catch (err) {
      say(s.errors[(err as Error).message] ?? (err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="basis-full">
      <button
        className={ghost}
        onClick={() => void toggle()}
        aria-expanded={open}
      >
        {s.prices}
      </button>
      {open && list && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-white/10 p-3">
          <p className="text-[11px] text-white/55">{s.pricesNote}</p>
          {(Object.keys(list.wholesale) as TokenId[]).map((t) => {
            const r = priceRange(list, t);
            return (
              <label key={t} className="flex items-center gap-2 text-xs">
                <span className="w-14 font-mono">{tokens[t].ticker}</span>
                <input
                  className="h-8 w-24 rounded-md border border-white/15 bg-black/30 px-2 font-mono"
                  inputMode="numeric"
                  value={draft[t] || ""}
                  placeholder="—"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      [t]: Number(e.target.value.replace(/\D/g, "")),
                    })
                  }
                  aria-label={`${tokens[t].ticker} ${s.prices}`}
                />
                <span className="text-white/50">{s.floor(r.min, r.max)}</span>
              </label>
            );
          })}
          <button className={btn} disabled={busy} onClick={() => void save()}>
            {s.save}
          </button>
        </div>
      )}
    </div>
  );
}
