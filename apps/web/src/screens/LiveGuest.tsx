import { tokens, type TokenId } from "@nyxeron/core";
import { useEffect, useMemo } from "react";
import { Backdrop } from "@/components/Backdrop";
import { Button } from "@/components/ui/button";
import { en } from "@/i18n/en";
import { useEvents } from "@/api/events";
import { sales, useSales } from "@/api/sales";
import { topups, useTopups } from "@/api/topups";
import { guestBuy, guestLeave, useNet } from "@/net/session";
import { useGame } from "@/state/store";
import { GuestNight, type OnlineGuest } from "./GuestNight";

const t = en.live;

const s = en.sales;

/**
 * A guest in a CEO's live club: the host's snapshots on screen, buys and leaving through the relay. At a city
 * party that sells real stock, buying one of its tokens is a server call in Credit instead (the api holds it and
 * reserves the units); everything else stays play money through the host's game.
 */
export function LiveGuest() {
  const { remote, me, status, refused, last, ended, room, error } = useNet();
  const go = useGame((x) => x.go);
  // The city event behind this room, if any: its price list makes purchases real.
  const event = useEvents((x) =>
    x.events.find((e) => e.live && e.room === room && e.leaseId > 0),
  );
  const party = useSales((x) => x.party);
  useEffect(() => {
    if (!event) return;
    void sales.enter(event.id);
    void topups.load(); // the guest's Credit, shown with the menu
    return sales.leave;
  }, [event]);
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
      buy: (token: TokenId, qty: number) => {
        const price = party?.list.prices[token];
        if (!price) return guestBuy(token, qty); // play money: the host's game decides
        // Real stock: the api takes Credit and holds the units. Not sent to the host's game, which would also
        // charge the guest's play money for it.
        const notify = useGame.getState().notify;
        sales
          .buy(party.id, token, qty, price)
          .then((left) => notify(s.bought(qty, tokens[token].ticker, left)))
          .catch((e: Error) => notify(s.errors[e.message] ?? e.message, true));
      },
      leave: guestLeave,
      waiting,
      last,
      ended,
    }),
    [waiting, last, ended, party],
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
  return (
    <>
      <GuestNight s={remote} me={me} online={online} />
      {party && <CreditMenu prices={party.list.prices} />}
    </>
  );
}

/** What this party sells as real stock, at the CEO's price, and the guest's Credit. */
function CreditMenu({ prices }: { prices: Partial<Record<TokenId, number>> }) {
  const credits = useTopups((x) => x.credits);
  return (
    <aside
      className="glass fixed top-3 left-1/2 z-40 -translate-x-1/2 rounded-xl px-4 py-2 text-xs"
      aria-label={s.menu}
    >
      <span className="mr-2 tracking-[0.2em] text-white/55 uppercase">
        {s.menu}
      </span>
      {(Object.keys(prices) as TokenId[]).map((t) => (
        <span key={t} className="mr-3 font-mono">
          {tokens[t].ticker} {s.each(prices[t] ?? 0)}
        </span>
      ))}
      {credits !== null && (
        <span className="text-white/60">{s.yourCredit(credits)}</span>
      )}
    </aside>
  );
}
