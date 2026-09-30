import {
  ids,
  marketOf,
  marketPrice,
  nightOver,
  sellPrice,
  tickNight,
  tokens,
  visitorBuy,
  visitorPnl,
  visitorSell,
  visitorValue,
  type ActionResult,
  type GameState,
  type TokenId,
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
import { art } from "@/art";
import { Img } from "@/components/Img";
import { Button } from "@/components/ui/button";
import { TickerTape } from "@/hud/TickerTape";
import { TokenLink } from "@/hud/TokenDetail";
import { clock, en, fmt, reasonText } from "@/i18n/en";
import { cn, trapFocus } from "@/lib/utils";
import { useProfile } from "@/profile";
import { useGame } from "@/store";
import { VenueView } from "@/venue/VenueView";

const t = en.guest;
const signed = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))} C`;

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

/** A guest's night out: the venue, the token desk, and what the wallet is worth right now. */
export function GuestNight({ s }: { s: GameState }) {
  const { running, setRunning, speed, setSpeed, go } = useGame();
  const [leaving, setLeaving] = useState(false);
  const [hud, setHud] = useState(true);
  const [cinematic, setCinematic] = useState(false);
  const endCinematic = useCallback(() => setCinematic(false), []);
  const over = nightOver(s);
  const done = over || leaving;
  useGuestLoop(done);
  useMusic(nightTrack(s), leaving, "venue");

  const v = s.night!.visitor!;
  const value = visitorValue(s);
  const pnl = visitorPnl(s);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") setLeaving(true);
      else if (e.key === " ") {
        e.preventDefault();
        setRunning(!useGame.getState().running);
      } else if (k === "1" || k === "2" || k === "3")
        setSpeed(Number(k) as 1 | 2 | 3);
      else if (k === "h") setHud((x) => !x);
      else if (k === "c") setCinematic((x) => !x);
      else if (k === "m") audio.toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRunning, setSpeed]);

  const walkOut = () => {
    useProfile.getState().settle(value, pnl);
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
              {clock(s.night!.minute)} · {v.name}
            </div>
          </div>
          <Figure label={t.cash}>{fmt(v.cash)} C</Figure>
          <Figure label={t.value}>{fmt(value)} C</Figure>
          <Figure label={t.pnl}>{signed(pnl)}</Figure>
          <div className="ml-auto flex items-center gap-2">
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
        <div className="flex min-h-0 flex-1 justify-end pointer-events-none!">
          <Desk s={s} />
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

/** Buy and sell at the club's token desk. */
function Desk({ s }: { s: GameState }) {
  const { set, notify } = useGame();
  const v = s.night!.visitor!;
  const menu = ids(tokens).filter((x) => tokens[x].minLevel <= s.level);
  const run = (fn: (g: GameState) => ActionResult) => {
    // Always act on the latest state: the clock may have ticked since this render.
    const g = useGame.getState().game;
    if (!g) return;
    const r = fn(g);
    if (r.ok) {
      set(r.state);
      audio.cash();
    } else notify(reasonText(r.reason, r.short), true);
  };
  return (
    <aside
      className="glass enter flex max-h-full w-full flex-col rounded-xl sm:w-[26rem]"
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
          const pl = h ? sellPrice(s, id) * h.qty - h.cost : 0;
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
                  {fmt(price)} C
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
                {[1, 5].map((q) => (
                  <DeskBtn
                    key={q}
                    disabled={!s.stock[id] || price * q > v.cash}
                    onClick={() => run((g) => visitorBuy(g, id, q))}
                  >
                    {t.buy(q)}
                  </DeskBtn>
                ))}
                <DeskBtn
                  disabled={!h}
                  onClick={() => run((g) => visitorSell(g, id, 1))}
                >
                  {t.sell}
                </DeskBtn>
                <DeskBtn
                  disabled={!h}
                  onClick={() =>
                    run((g) =>
                      visitorSell(
                        g,
                        id,
                        g.night?.visitor?.holdings[id as TokenId]?.qty ?? 0,
                      ),
                    )
                  }
                >
                  {t.sellAll}
                </DeskBtn>
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
  over,
  onStay,
  onLeave,
}: {
  s: GameState;
  over: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  const v = s.night!.visitor!;
  const pnl = visitorPnl(s);
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
        <dl className="mt-4 space-y-1.5 text-sm">
          <Row label={t.broughtIn}>{fmt(v.startCash)} C</Row>
          <Row label={t.walkOut}>{fmt(visitorValue(s))} C</Row>
          <Row label={t.pnl}>
            <span className="font-semibold">{signed(pnl)}</span>
          </Row>
        </dl>
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
