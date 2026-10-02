import {
  canHostParty,
  city as cityData,
  LEVELS,
  levels,
  shopTokens,
  tokens,
  venueCount,
  type Level,
  type TokenId,
} from "@nyxeron/core";
import { useEffect, useState } from "react";
import { art } from "@/lib/art";
import { useAccount } from "@/auth/account";
import {
  city,
  loadCity,
  myVenues,
  useCity,
  type Party,
  type Venue,
} from "@/api/city";
import { Img } from "@/components/Img";
import { fetchOpenClubs, type OpenClub } from "@/api/rooms";
import { en, fmt } from "@/i18n/en";
import { guestJoin } from "@/net/session";
import { useProfile } from "@/state/profile";
import { useGame } from "@/state/store";

const t = en.city;
const row =
  "flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3";
const btn =
  "h-8 shrink-0 rounded-md bg-white px-3 text-xs font-medium text-black disabled:opacity-40";
const ghost =
  "h-8 shrink-0 rounded-md border border-white/15 px-3 text-xs hover:bg-white/10 disabled:opacity-40";
const field =
  "h-8 rounded-md border border-white/15 bg-black/30 px-2 text-sm outline-none focus:border-white/50";
const day = (unix: number) =>
  new Date(unix * 1000).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Keep the city fresh while a panel shows it. */
export function useCityLive() {
  useEffect(() => {
    void loadCity();
    const id = setInterval(() => void loadCity(), 20_000);
    return () => clearInterval(id);
  }, []);
  return useCity();
}

/** CEO: rent another venue in the city. `onRented` goes back to the club list once it's yours. */
export function RentVenue({ onRented }: { onRented: () => void }) {
  const { city: c, error } = useCityLive();
  const signedIn = useAccount((a) => !!a.account);
  if (!signedIn) return <p className="text-sm text-white/60">{t.signIn}</p>;
  if (!c) return <p className="text-sm text-white/60">{error || t.loading}</p>;
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-2xl font-medium tracking-[-0.02em]">{t.rentTitle}</h2>
      <RentList onRented={onRented} />
    </div>
  );
}

/** CEO: run one of your city venues (name, rent, shop, parties). */
export function ManageVenue({ lease }: { lease: number }) {
  const { city: c, error } = useCityLive();
  useEffect(() => useCity.setState({ hosting: null }), []);
  if (!c) return <p className="text-sm text-white/60">{error || t.loading}</p>;
  const v = myVenues(c).find((x) => x.lease!.id === lease);
  if (!v) return <p className="text-sm text-white/60">{t.gone}</p>;
  return (
    <div className="flex flex-col gap-4">
      <MyVenue v={v} />
    </div>
  );
}

function RentList({ onRented }: { onRented: () => void }) {
  const c = useCity((x) => x.city)!;
  const wallet = useProfile((p) => p.wallet);
  const [club, setClub] = useState("");
  const [weeks, setWeeks] = useState(1);
  return (
    <>
      <p className="text-sm text-white/60">{t.rentNote}</p>
      <label className="flex flex-col gap-1.5 text-xs text-white/60 sm:flex-row sm:items-center">
        {t.clubName}
        <input
          className={field + " sm:w-60"}
          maxLength={20}
          value={club}
          onChange={(e) => setClub(e.target.value)}
        />
        <select
          className={field}
          value={weeks}
          onChange={(e) => setWeeks(Number(e.target.value))}
          aria-label={t.weeks(weeks)}
        >
          {Array.from({ length: cityData.maxWeeksAhead }, (_, i) => (
            <option key={i} value={i + 1}>
              {t.weeks(i + 1)}
            </option>
          ))}
        </select>
      </label>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {LEVELS.map((lv) => {
          const free = c.venues.filter(
            (v) => v.level === lv && !v.lease,
          ).length;
          const cost = (c.rent[lv] ?? 0) * weeks;
          return (
            <li
              key={lv}
              className="flex flex-col overflow-hidden rounded-2xl border border-white/12 bg-white/[0.03]"
            >
              <Img
                src={art.venue(lv)}
                alt=""
                className="aspect-[21/9] w-full object-cover"
                fallback={<span className="block aspect-[21/9] bg-white/5" />}
              />
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="font-medium">
                  Lv {lv} · {levels[lv].name}
                </div>
                <div className="text-xs text-white/55">
                  {t.free(free, venueCount(lv))} ·{" "}
                  {t.perWeek(fmt(c.rent[lv] ?? 0))}
                  {canHostParty(lv) ? ` · ${t.parties}` : ` · ${t.shop}`}
                </div>
                <button
                  className={btn + " mt-auto self-start"}
                  disabled={!free || !club.trim() || wallet < cost}
                  onClick={async () => {
                    const before = myVenues(useCity.getState().city).length;
                    await city.lease(lv, club.trim(), weeks);
                    if (myVenues(useCity.getState().city).length > before)
                      onRented();
                  }}
                >
                  {free ? t.rent(fmt(cost)) : t.full}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function MyVenue({ v }: { v: Venue }) {
  const c = useCity((x) => x.city)!;
  const wallet = useProfile((p) => p.wallet);
  const lease = v.lease!;
  const rent = c.rent[v.level] ?? 0;
  return (
    <>
      <div className={row}>
        <div className="min-w-0">
          <div className="text-[10px] tracking-[0.25em] text-white/50 uppercase">
            {t.yours}
          </div>
          <Rename lease={lease.id} club={lease.club} level={v.level} />
          <div className="text-xs text-white/55">
            {t.until(day(lease.endsAt))}
          </div>
        </div>
        <button
          className={ghost}
          disabled={wallet < rent}
          onClick={() => void city.lease(v.level, "", 1, v.slot)}
        >
          {t.extend(fmt(rent))}
        </button>
      </div>
      <Shop v={v} />
      {canHostParty(v.level) ? (
        <Parties v={v} />
      ) : (
        <p className="text-sm text-white/55">{t.partiesLocked}</p>
      )}
    </>
  );
}

/** The tenant's venue name, editable in place (e.g. "Escala Bar"). */
function Rename({
  lease,
  club,
  level,
}: {
  lease: number;
  club: string;
  level: Level;
}) {
  const [name, setName] = useState<string | null>(null);
  if (name === null)
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-lg font-medium">
          {t.at(club, levels[level].name)}
        </span>
        <button
          className="text-xs text-white/55 underline hover:text-white"
          onClick={() => setName(club)}
        >
          {t.rename}
        </button>
      </div>
    );
  return (
    <form
      className="mt-1 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && name.trim() !== club)
          void city.rename(lease, name.trim());
        setName(null);
      }}
    >
      <input
        className={field}
        maxLength={20}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        aria-label={t.clubName}
      />
      <button className={btn}>{t.rename}</button>
    </form>
  );
}

function Shop({ v }: { v: Venue }) {
  const c = useCity((x) => x.city)!;
  const lease = v.lease!;
  const prices = c.prices?.[v.level] ?? {};
  const stock = Object.fromEntries(lease.stock.map((s) => [s.token, s]));
  const held = lease.stock.reduce((n, s) => n + s.qty, 0);
  // Stock is shared by all of the player's venues; so is their storage.
  const storage = myVenues(c).reduce((n, x) => n + levels[x.level].storage, 0);
  const [edit, setEdit] = useState<Partial<Record<TokenId, number>>>({});
  const [qty, setQty] = useState(10);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[10px] tracking-[0.25em] text-white/60 uppercase">
          {t.shop} · {t.storage(held, storage)}
        </h3>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-white"
            checked={lease.open}
            onChange={(e) => void city.shop(lease.id, e.target.checked)}
          />
          {t.shopOpen}
        </label>
      </div>
      <ul className="flex flex-col gap-1.5">
        {shopTokens(v.level).map((tok) => {
          const p = prices[tok];
          const s = stock[tok];
          return (
            <li key={tok} className={row + " flex-wrap py-2"}>
              <span className="min-w-36">
                <span className="font-mono text-xs">{tokens[tok].ticker}</span>{" "}
                <span className="text-sm">{tokens[tok].name}</span>
                <span className="block text-[11px] text-white/50">
                  {t.inStock(s?.qty ?? 0)}
                  {p ? ` · ${t.cost(fmt(p.wholesale))}` : ""}
                  {` · ${t.warehouse(c.supply?.[tok] ?? 0)}`}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {s && (
                  <label className="flex items-center gap-1 text-[11px] text-white/55">
                    {t.shelf}
                    <input
                      className={field + " w-20 font-mono"}
                      inputMode="numeric"
                      value={edit[tok] ?? s.price}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          [tok]: Number(e.target.value.replace(/\D/g, "")),
                        })
                      }
                      title={p ? t.maxPrice(fmt(p.max)) : undefined}
                    />
                  </label>
                )}
                <button
                  className={ghost}
                  disabled={!p || (c.supply?.[tok] ?? 0) < qty}
                  onClick={() => void city.stock(tok, qty)}
                >
                  {t.restock(qty, fmt((p?.wholesale ?? 0) * qty))}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2">
        <select
          className={field}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          aria-label={t.restock(qty, "")}
        >
          {[1, 10, 50, 100].map((n) => (
            <option key={n} value={n}>
              ×{n}
            </option>
          ))}
        </select>
        <button
          className={btn}
          disabled={!Object.keys(edit).length}
          onClick={() => {
            void city.shop(lease.id, undefined, edit);
            setEdit({});
          }}
        >
          {t.savePrices}
        </button>
      </div>
    </section>
  );
}

/** datetime-local value for a moment (local time). */
const localInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

function Parties({ v }: { v: Venue }) {
  const c = useCity((x) => x.city)!;
  const mine = c.parties.filter((p) => p.leaseId === v.lease!.id);
  const [when, setWhen] = useState(() =>
    localInput(new Date(Date.now() + 3_600_000)),
  );
  const [minutes, setMinutes] = useState(cityData.party.defaultMinutes);
  const [title, setTitle] = useState("");
  const now = c.now; // the server's clock at the last refresh (every 20 s)
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] tracking-[0.25em] text-white/60 uppercase">
        {t.parties}
      </h3>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void city.party(
            v.lease!.id,
            Math.floor(new Date(when).getTime() / 1000),
            minutes,
            title,
          );
        }}
      >
        <label className="flex flex-col gap-1 text-[11px] text-white/55">
          {t.when}
          <input
            type="datetime-local"
            className={field}
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-white/55">
          {t.minutes}
          <input
            type="number"
            className={field + " w-20"}
            min={cityData.party.minMinutes}
            max={cityData.party.maxMinutes}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-white/55">
          {t.partyTitle}
          <input
            className={field}
            maxLength={20}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <button className={btn}>{t.schedule}</button>
      </form>
      {mine.length === 0 && (
        <p className="text-xs text-white/45">{t.noParties}</p>
      )}
      {mine.map((p) => (
        <div key={p.id} className={row + " py-2"}>
          <span className="min-w-0 text-sm">
            {p.live && (
              <span className="mr-2 text-[10px] tracking-[0.2em] uppercase">
                ● {t.liveNow}
              </span>
            )}
            {p.title || p.club} · {day(p.startsAt)} · {p.minutes} min
          </span>
          <span className="flex gap-2">
            {now >= p.startsAt - 900 && (
              <button className={btn} onClick={() => city.host(p)}>
                {t.hostNow}
              </button>
            )}
            <button className={ghost} onClick={() => void city.cancel(p.id)}>
              {t.cancel}
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}

/** Guest: parties on now and coming up, and shops to buy from. */
/** Clubs open right now, refreshed every 15 s. */
function useOpenClubs() {
  const [clubs, setClubs] = useState<OpenClub[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetchOpenClubs()
        .then((x) => live && setClubs(x))
        .catch(() => live && setClubs((c) => c ?? []));
    void load();
    const id = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return clubs;
}

export function CityGuest() {
  const { city: c } = useCityLive();
  const open = useOpenClubs();
  if (!c) return null;
  const later = c.parties.filter((p) => !p.live);
  const shops = c.venues.filter(
    (v) => v.lease?.open && !v.lease.mine && v.lease.stock.length,
  );
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-[10px] tracking-[0.25em] text-white/60 uppercase">
          ● {t.openNow}
        </h3>
        {open?.length === 0 && (
          <p className="text-xs text-white/45">{t.noneOpen}</p>
        )}
        {open?.map((club) => (
          <OpenClubRow
            key={club.room}
            club={club}
            party={c.parties.find((p) => p.live && p.room === club.room)}
          />
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[10px] tracking-[0.25em] text-white/60 uppercase">
          {t.upcoming}
        </h3>
        {later.length === 0 && (
          <p className="text-xs text-white/45">{t.noUpcoming}</p>
        )}
        {later.slice(0, 8).map((p) => (
          <div key={p.id} className={row + " py-2 text-sm"}>
            <span className="min-w-0 truncate">
              {p.title || p.club} ·{" "}
              <span className="text-white/55">{levels[p.level].name}</span>
            </span>
            <span className="shrink-0 font-mono text-xs text-white/65">
              {day(p.startsAt)} · {p.minutes}m
            </span>
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[10px] tracking-[0.25em] text-white/60 uppercase">
          {t.shops}
        </h3>
        {shops.length === 0 && (
          <p className="text-xs text-white/45">{t.noShops}</p>
        )}
        {shops.map((v) => (
          <ShopFront key={v.lease!.id} v={v} />
        ))}
      </section>
    </div>
  );
}

function OpenClubRow({ club, party }: { club: OpenClub; party?: Party }) {
  const go = useGame((x) => x.go);
  const [busy, setBusy] = useState(false);
  return (
    <div className={row}>
      <Img
        src={art.venue(club.level)}
        alt=""
        className="size-12 shrink-0 rounded-lg object-cover"
        fallback={<span className="size-12 rounded-lg bg-white/5" />}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {party?.title || club.club}
        </span>
        <span className="text-xs text-white/55">
          {t.at(club.club, levels[club.level].name)} · {t.by(club.host)} ·{" "}
          {club.night ? t.nightOn : t.doorsSoon} · {t.inside(club.players)}
        </span>
      </span>
      <button
        className={btn}
        disabled={busy}
        onClick={async () => {
          const { name, avatar, wallet } = useProfile.getState();
          setBusy(true);
          try {
            await guestJoin(club.room, {
              name: name || en.dashboard.anon,
              avatar,
              cash: wallet,
            });
            go("live");
          } catch (e) {
            useGame
              .getState()
              .notify(en.live.error((e as Error).message), true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t.join}
      </button>
    </div>
  );
}

function ShopFront({ v }: { v: Venue }) {
  const wallet = useProfile((p) => p.wallet);
  const lease = v.lease!;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="text-sm font-medium">
        {t.at(lease.club, levels[v.level as Level].name)}{" "}
        <span className="text-xs font-normal text-white/50">
          {t.by(lease.owner)}
        </span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-2">
        {lease.stock.map((s) => (
          <li
            key={s.token}
            className="flex items-center gap-2 rounded-md border border-white/10 px-2 py-1 text-xs"
          >
            <span className="font-mono">{tokens[s.token].ticker}</span>
            <span className="font-mono text-white/65">{fmt(s.price)} C</span>
            <span className="text-white/45">×{s.qty}</span>
            <button
              className={btn + " h-6 px-2"}
              disabled={wallet < s.price}
              onClick={() => void city.buy(lease.id, s.token, 1)}
            >
              {t.buy}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
