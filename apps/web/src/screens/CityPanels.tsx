import {
  canHostParty,
  city as cityData,
  LEVELS,
  levels,
  payments,
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
import { events } from "@/api/events";
import { topups, useTopups } from "@/api/topups";
import { EventsFeed, EventsPanel, useEventsLive } from "./EventsPanel";
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
  if (!c) return <p className="text-sm text-white/60">{error || t.loading}</p>;
  const v = myVenues(c).find((x) => x.lease!.id === lease);
  if (!v) return <p className="text-sm text-white/60">{t.gone}</p>;
  return (
    <div className="flex flex-col gap-4">
      <MyVenue v={v} />
    </div>
  );
}

/** The player's Credit (rent and shop purchases are real money), loaded once. */
function useCredit() {
  const credits = useTopups((x) => x.credits);
  useEffect(() => {
    if (credits === null) void topups.load();
  }, [credits]);
  return credits ?? 0;
}

function RentList({ onRented }: { onRented: () => void }) {
  const c = useCity((x) => x.city)!;
  const wallet = useCredit();
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
                  {t.free(free, c.counts?.[lv] ?? venueCount(lv))} ·{" "}
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
  const wallet = useCredit();
  const { events: list } = useEventsLive();
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const lease = v.lease!;
  const rent = c.rent[v.level] ?? 0;
  const party = canHostParty(v.level);
  const days = Math.max(0, Math.ceil((lease.endsAt - c.now) / 86_400));
  const planned = list.some((e) => e.mine && e.leaseId === lease.id);
  // One button in: a public party starting this minute, straight into the club in 3D.
  const enter = async () => {
    setBusy(true);
    const ok = await events.create({
      lease: lease.id,
      club: lease.club,
      level: v.level,
      startsAt: Math.floor(Date.now() / 1000),
      minutes: cityData.party.defaultMinutes,
      title: "",
      private: false,
    });
    setBusy(false);
    if (ok) city.host({ club: lease.club, level: v.level } as Party);
  };
  return (
    <>
      <div className="relative overflow-hidden rounded-2xl border border-white/12">
        <Img
          src={art.venue(v.level)}
          alt=""
          className="absolute inset-0 size-full object-cover opacity-55"
          fallback={<span className="absolute inset-0 bg-white/5" />}
        />
        <div className="relative flex min-h-64 flex-col justify-end gap-4 bg-black/45 p-5 sm:p-7">
          <div className="min-w-0">
            <div className="text-[10px] tracking-[0.25em] text-white/60 uppercase">
              {t.venueLevel(v.level, levels[v.level].name)}
            </div>
            <Rename lease={lease.id} club={lease.club} />
          </div>
          {party ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="h-12 rounded-xl bg-white px-7 text-base font-medium text-black shadow-[0_0_30px_rgba(255,255,255,.25)] disabled:opacity-50"
                disabled={busy}
                onClick={() => void enter()}
              >
                {t.enter}
              </button>
              <span className="text-xs text-white/60">{t.enterHint}</span>
            </div>
          ) : (
            <p className="text-sm text-white/70">{t.partyLocked}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/60">
            <span>{t.daysLeft(days)}</span>
            <button
              className={
                days <= 2
                  ? btn
                  : "underline-offset-2 hover:text-white hover:underline disabled:opacity-40"
              }
              disabled={wallet < rent}
              onClick={() => void city.lease(v.level, "", 1, v.slot)}
            >
              {t.extendShort(fmt(rent))}
            </button>
            {party && (
              <button
                className="underline-offset-2 hover:text-white hover:underline"
                onClick={() => setPlanning((x) => !x)}
              >
                {t.scheduleLater}
              </button>
            )}
          </div>
        </div>
      </div>

      {party && (planning || planned) && (
        <EventsPanel
          club={lease.club}
          level={v.level}
          lease={lease.id}
          form={planning}
          onHost={(e) => city.host(e)}
        />
      )}
      <Shop v={v} />
    </>
  );
}

/** The tenant's venue name, editable in place (e.g. "Escala Bar"). */
function Rename({ lease, club }: { lease: number; club: string }) {
  const [name, setName] = useState<string | null>(null);
  if (name === null)
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-3xl font-medium tracking-[-0.02em]">
          {club}
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

/** The shop in one line (status, open switch); Manage opens its menu: a Credit price per token. */
function Shop({ v }: { v: Venue }) {
  const c = useCity((x) => x.city)!;
  const lease = v.lease!;
  const listed = lease.stock.length;
  const [openMenu, setOpenMenu] = useState(listed === 0);
  const [edit, setEdit] = useState<Partial<Record<TokenId, number>>>({});
  // Real-stock tokens this venue's level may sell (tokens.json minLevel; the api checks the same).
  const menu = shopTokens(v.level).filter((tok) => tok in payments.tokens);
  const priceOf = (tok: TokenId) =>
    edit[tok] ?? lease.stock.find((s) => s.token === tok)?.price ?? 0;
  // Bounds (the api checks the same): between wholesale and maxMarkup × wholesale, for tokens with a live price.
  const bounds = (tok: TokenId) => {
    const w = c.wholesale?.[tok];
    return w ? { min: w, max: Math.floor(w * (c.maxMarkup ?? 3)) } : null;
  };
  const listedNow = menu.filter((tok) => priceOf(tok) > 0);
  // A listed token without a live price can't be saved (the api would refuse it), and leaving it out would take
  // it off the menu without the tenant asking: wait for the price instead.
  const noPrice = listedNow.some((tok) => !bounds(tok));
  const bad = listedNow.some((tok) => {
    const b = bounds(tok);
    return b && (priceOf(tok) < b.min || priceOf(tok) > b.max);
  });
  const save = async () => {
    const prices = Object.fromEntries(
      listedNow.map((tok) => [tok, priceOf(tok)]),
    ) as Partial<Record<TokenId, number>>;
    await city.prices(lease.id, prices);
    // The first menu on a closed shop opens it too: nothing else to learn.
    if (!listed && !lease.open && listedNow.length)
      await city.shop(lease.id, true);
    setEdit({});
  };
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-3">
        <button
          role="switch"
          aria-checked={lease.open}
          aria-label={t.shopOpen}
          onClick={() => void city.shop(lease.id, !lease.open)}
          className={
            "relative h-6 w-11 shrink-0 rounded-full border transition " +
            (lease.open
              ? "border-white bg-white"
              : "border-white/25 bg-white/5")
          }
        >
          <span
            className={
              "absolute top-0.5 size-4.5 rounded-full transition-all " +
              (lease.open ? "left-[22px] bg-black" : "left-0.5 bg-white/60")
            }
          />
        </button>
        <span className="min-w-0 flex-1 text-sm">
          {t.shopLine(lease.open, listed)}
        </span>
        <button className={ghost} onClick={() => setOpenMenu((x) => !x)}>
          {openMenu ? t.done : t.manage}
        </button>
      </div>

      {openMenu && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-xs text-white/55">
            {listed === 0 ? t.emptyShelf : t.menuNote}
          </p>
          {menu.map((tok) => {
            const w = c.wholesale?.[tok];
            const max = bounds(tok)?.max ?? 0;
            const price = priceOf(tok);
            return (
              <div key={tok} className={row + " flex-wrap py-2"}>
                <span className="min-w-28">
                  <span className="font-mono text-xs">
                    {tokens[tok].ticker}
                  </span>{" "}
                  <span className="text-xs text-white/50">
                    ×{fmt(c.supply?.[tok] ?? 0)}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <input
                    className={field + " w-24 font-mono"}
                    inputMode="numeric"
                    aria-label={`${tokens[tok].ticker} ${t.shelf}`}
                    placeholder="—"
                    value={price || ""}
                    disabled={!w}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        [tok]: Number(e.target.value.replace(/\D/g, "")),
                      })
                    }
                  />
                  {w ? (
                    <span className="text-xs text-white/60">
                      {t.floor(fmt(w), fmt(max))}
                      {price > w && ` · ${t.margin(fmt(price - w))}`}
                    </span>
                  ) : (
                    <span className="text-xs text-white/45">—</span>
                  )}
                </span>
              </div>
            );
          })}
          {Object.keys(edit).length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={btn}
                disabled={bad || noPrice}
                onClick={() => void save()}
              >
                {t.savePrices}
              </button>
              {(bad || noPrice) && (
                <span className="text-xs text-white/60">
                  {noPrice ? t.noLivePrice : t.outOfRange}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

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
  // City shops run on Credit: none while the city is shut.
  const shops = c.open
    ? c.venues.filter(
        (v) => v.lease?.open && !v.lease.mine && v.lease.stock.length,
      )
    : [];
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
      <EventsFeed />
      <section className="flex flex-col gap-2">
        <h3 className="text-[10px] tracking-[0.25em] text-white/60 uppercase">
          {t.shops}
        </h3>
        {shops.length === 0 && (
          <p className="text-xs text-white/45">
            {c.open ? t.noShops : en.dashboard.cityTitle}
          </p>
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
  const wallet = useCredit();
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
            <span className="font-mono text-white/65">
              {t.credit(fmt(s.price))}
            </span>
            <span className="text-white/45">×{s.qty}</span>
            <button
              className={btn + " h-6 px-2"}
              disabled={wallet < s.price || s.qty < 1}
              onClick={() => void city.buy(lease.id, s.token, 1, s.price)}
            >
              {t.buy}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
