import {
  ids,
  marketOf,
  marketPrice,
  nightOver,
  tickNight,
  tokens,
  visitorBuy,
  visitorPnl,
  visitorValue,
  type ActionResult,
  type GameState,
  type TokenId,
  type Visitor,
} from "@nyxeron/core";
import { Clapperboard, DoorOpen, Eye, EyeOff } from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { audio, nightTrack, useMusic } from "@/audio";
import { art } from "@/lib/art";
import { Img } from "@/components/Img";
import { Button } from "@/components/ui/button";
import { TickerTape } from "@/hud/TickerTape";
import { escLeaving } from "@/screens/leaveKey";
import { TokenLink } from "@/hud/TokenDetail";
import { clock, en, fmt, reasonText } from "@/i18n/en";
import { cn, trapFocus } from "@/lib/utils";
import { player } from "@/api/player";
import { useGame } from "@/state/store";
import { VenueView } from "@/venue/VenueView";
import { useNet } from "@/net/session";

const t = en.guest;
const signed = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))} ${en.unit}`;

/** The club runs itself (AI CEO); the guest only watches the clock. 1 tick = 1 in-game minute. */
function useGuestLoop(stopped: boolean) {
  const { running, speed } = useGame();
  useEffect(() => {
    if (!running || stopped) return;
    const id = setInterval(() => {
      const { game, set } = useGame.getState();
      if (game && !nightOver(game)) set(tickNight(game));
    }, 1000 / speed);
    return () => clearInterval(id);
  }, [running, speed, stopped]);
}

/** Online: the host runs the club; buying and leaving go through the relay. */
export interface OnlineGuest {
  buy(token: TokenId, qty: number): void;
  leave(): void;
  /** Why I'm not at the desk yet (doors closed, host away, refused at the door…); null once inside. */
  waiting: string | null;
  /** Me at the last snapshot I was inside (after the host's night ends the snapshot no longer has me). */
  last: { v: Visitor; value: number; pnl: number } | null;
  ended: boolean;
}

/**
 * A guest's night out: the venue, the token desk, and what the wallet is worth right now. Offline the club is an
 * AI event running here; online (`online`) it is a CEO's live club, shown from their snapshots.
 */
export function GuestNight({
  s,
  me = "me",
  online,
}: {
  s: GameState;
  me?: string;
  online?: OnlineGuest;
}) {
  const { running, setRunning, speed, setSpeed, go } = useGame();
  const [leaving, setLeaving] = useState(false);
  const [hud, setHud] = useState(true);
  const [cinematic, setCinematic] = useState(false);
  const endCinematic = useCallback(() => setCinematic(false), []);
  const over = online ? online.ended : nightOver(s);
  const liveDj = useNet((x) => (online ? x.dj : null));
  const done = over || leaving;
  useGuestLoop(done || !!online);
  useMusic(nightTrack(s), leaving, "venue");

  const inside = s.night?.visitors?.[me];
  const v = inside ?? online?.last?.v;
  const value = inside ? visitorValue(s, me) : (online?.last?.value ?? 0);
  const pnl = inside ? visitorPnl(s, me) : (online?.last?.pnl ?? 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") setLeaving((l) => escLeaving(l, over));
      else if (e.key === " " && !online) {
        e.preventDefault();
        setRunning(!useGame.getState().running);
      } else if ((k === "1" || k === "2" || k === "3") && !online)
        setSpeed(Number(k) as 1 | 2 | 3);
      else if (k === "h") setHud((x) => !x);
      else if (k === "c") setCinematic((x) => !x);
      else if (k === "m") audio.toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRunning, setSpeed, online, over]);

  const walkOut = () => {
    // Buy-only: the tokens are the guest's, so they go home to the portfolio with the cash.
    if (v) player.settle(v.cash, v.holdings, pnl);
    online?.leave();
    go("dashboard");
  };

  const seg = (on: boolean) =>
    cn(
      "h-8 min-w-9 rounded-md px-2.5 font-mono text-xs",
      on ? "bg-white text-black" : "text-white/70 hover:bg-white/10",
    );

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <VenueView
        s={s}
        me={me}
        guestDj={liveDj ?? undefined}
        cinematic={cinematic}
        onCinematicEnd={endCinematic}
        active={!done}
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-0 flex flex-col gap-3 p-3 [&>*]:pointer-events-auto",
          (!hud || cinematic) && "hidden",
        )}
      >
        <header className="glass enter flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{s.clubName}</div>
            <div className="font-mono text-xs text-white/60">
              {s.night ? clock(s.night.minute) : t.doorsClosed}
              {v && ` · ${v.name}`}
              {online && ` · ${t.live}`}
            </div>
          </div>
          {v && (
            <>
              <Figure label={t.cash}>
                {fmt(v.cash)} {en.unit}
              </Figure>
              <Figure label={t.value}>
                {fmt(value)} {en.unit}
              </Figure>
              <Figure label={t.pnl}>{signed(pnl)}</Figure>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {!online && (
              <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-1">
                <button
                  className={seg(!running)}
                  onClick={() => setRunning(!running)}
                  aria-label={running ? "Pause" : "Play"}
                >
                  {running ? "❚❚" : "▶"}
                </button>
                {([1, 2, 3] as const).map((x) => (
                  <button
                    key={x}
                    className={seg(speed === x && running)}
                    onClick={() => setSpeed(x)}
                    aria-pressed={speed === x}
                    title={`${en.night.speed(x)} [${x}]`}
                  >
                    {x}×
                  </button>
                ))}
              </div>
            )}
            <IconBtn
              label={`${en.night.cinematic} [C]`}
              onClick={() => setCinematic(true)}
            >
              <Clapperboard className="size-4" />
            </IconBtn>
            <IconBtn
              label={`${en.night.hideHud} [H]`}
              onClick={() => setHud(false)}
            >
              <EyeOff className="size-4" />
            </IconBtn>
            <button
              className="flex h-10 items-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold tracking-[0.12em] text-black uppercase"
              onClick={() => setLeaving(true)}
            >
              <DoorOpen className="size-4" />
              <span className="hidden sm:inline">{t.leave}</span>
            </button>
          </div>
        </header>
        <TickerTape s={s} />
        {/* pointer-events-none! lets the 3D canvas behind get orbit/zoom; the desk turns clicks back on for itself. */}
        <div className="flex min-h-0 flex-1 justify-end pointer-events-none!">
          {inside ? (
            <Desk s={s} me={me} onBuy={online?.buy} />
          ) : (
            online?.waiting && (
              <p className="glass enter pointer-events-auto self-start rounded-xl px-4 py-3 text-sm text-white/80 sm:max-w-[26rem]">
                {online.waiting}
              </p>
            )
          )}
        </div>
      </div>

      {(!hud || cinematic) && (
        <button
          className="glass fixed right-3 bottom-3 z-20 flex h-10 items-center gap-2 rounded-lg px-3 text-xs opacity-60 transition-opacity hover:opacity-100"
          onClick={() => (cinematic ? setCinematic(false) : setHud(true))}
        >
          <Eye className="size-4" />
          {cinematic ? en.night.cinematicExit : en.night.showHud}
        </button>
      )}

      {done && (
        <Summary
          s={s}
          v={v}
          value={value}
          pnl={pnl}
          over={over}
          onStay={() => setLeaving(false)}
          onLeave={walkOut}
        />
      )}
    </div>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] tracking-[0.2em] text-white/50 uppercase">
        {label}
      </div>
      <div className="font-mono text-sm tabular-nums">{children}</div>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className="flex size-10 items-center justify-center rounded-lg border border-white/25 bg-black/30 hover:bg-white/10"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

/** Buy at the club's token desk (locally, or through the host when online). */
function Desk({
  s,
  me,
  onBuy,
}: {
  s: GameState;
  me: string;
  onBuy?: (token: TokenId, qty: number) => void;
}) {
  const { set, notify } = useGame();
  const v = s.night!.visitors![me]!;
  const menu = ids(tokens).filter((x) => tokens[x].minLevel <= s.level);
  /** Runs a desk trade; `msg` is the confirmation toast, built from the state after the trade. */
  const run = (
    fn: (g: GameState) => ActionResult,
    msg: (after: GameState) => string,
  ) => {
    // Always act on the latest state: the clock may have ticked since this render.
    const g = useGame.getState().game;
    if (!g) return;
    const r = fn(g);
    if (!r.ok) return notify(reasonText(r.reason, r.short), true);
    set(r.state);
    audio.cash();
    notify(msg(r.state));
  };
  return (
    <aside
      className="glass enter pointer-events-auto flex max-h-full w-full flex-col rounded-xl sm:w-[26rem]"
      style={{ "--d": "100ms" } as CSSProperties}
    >
      <header className="border-b border-white/10 px-4 py-3">
        <h2 className="text-[10px] tracking-[0.3em] text-white/60 uppercase">
          {t.desk}
        </h2>
        <p className="mt-0.5 text-[11px] text-white/50">{t.deskNote}</p>
      </header>
      <ul className="space-y-1.5 overflow-y-auto p-3">
        {menu.map((id) => {
          const h = v.holdings[id];
          const price = marketPrice(s, id);
          const change = Math.round((marketOf(s.night, id) - 1) * 1000) / 10;
          const pl = h ? price * h.qty - h.cost : 0;
          return (
            <li
              key={id}
              className="rounded-lg border border-white/8 bg-white/[0.025] p-2.5"
            >
              <div className="flex items-center gap-2.5">
                <TokenLink
                  s={s}
                  id={id}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:[&_.nm]:underline"
                >
                  <Img
                    src={art.token(id)}
                    alt=""
                    className="size-8 shrink-0 rounded-full object-cover"
                    fallback={<span className="size-8" />}
                  />
                  <span className="min-w-0 leading-tight">
                    <span className="nm block font-mono text-sm font-semibold">
                      {tokens[id].ticker}
                    </span>
                    <span className="block text-[11px] text-white/55">
                      {s.stock[id] ? t.left(s.stock[id]) : t.soldOut}
                    </span>
                  </span>
                </TokenLink>
                <span className="text-right font-mono text-sm leading-tight tabular-nums">
                  {fmt(price)} {en.unit}
                  <span className="block text-[11px] text-white/55">
                    {change > 0 ? "▲" : change < 0 ? "▼" : "·"}{" "}
                    {Math.abs(change)}%
                  </span>
                </span>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/60">
                  {h ? `${t.held(h.qty)} · ${signed(pl)}` : ""}
                </span>
                {[1, 5, 10].map((q) => (
                  <DeskBtn
                    key={q}
                    disabled={!s.stock[id] || price * q > v.cash}
                    onClick={() =>
                      onBuy
                        ? onBuy(id, q)
                        : run(
                            (g) => visitorBuy(g, me, id, q),
                            () => t.bought(q, tokens[id].ticker, price * q),
                          )
                    }
                  >
                    {t.buy(q)}
                  </DeskBtn>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function DeskBtn(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="h-7 rounded-md border border-white/15 bg-white/[0.04] px-2 font-mono text-[11px] whitespace-nowrap hover:bg-white/12 disabled:opacity-35"
    />
  );
}

/** Leaving (or 04:00): what the night was worth. Holdings are cashed out at the desk price. */
function Summary({
  s,
  v,
  value,
  pnl,
  over,
  onStay,
  onLeave,
}: {
  s: GameState;
  v: Visitor | undefined;
  value: number;
  pnl: number;
  over: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal
        aria-labelledby="guest-summary"
        onKeyDown={trapFocus}
        className="glass glow enter w-full max-w-sm rounded-2xl p-6"
      >
        <div className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
          {over ? t.closing : s.clubName}
        </div>
        <h2 id="guest-summary" className="mt-1 text-2xl font-medium">
          {over ? t.summary : t.leaveTitle}
        </h2>
        {!over && (
          <p className="mt-2 text-sm leading-relaxed text-white/65">
            {t.leaveWarn}
          </p>
        )}
        {v && (
          <dl className="mt-4 space-y-1.5 text-sm">
            <Row label={t.broughtIn}>
              {fmt(v.startCash)} {en.unit}
            </Row>
            <Row label={t.cashLeft}>
              {fmt(v.cash)} {en.unit}
            </Row>
            <Row label={t.tokensHome}>
              {fmt(value - v.cash)} {en.unit}
            </Row>
            <Row label={t.pnl}>
              <span className="font-semibold">{signed(pnl)}</span>
            </Row>
          </dl>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {!over && (
            <Button variant="ghost" onClick={onStay}>
              {t.stay}
            </Button>
          )}
          <Button autoFocus onClick={onLeave}>
            {over ? t.toDashboard : t.leave}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/55">{label}</dt>
      <dd className="font-mono tabular-nums">{children}</dd>
    </div>
  );
}
