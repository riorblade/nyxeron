import {
  ids,
  levels,
  night,
  scenarios,
  tokens,
  type EventSpec,
  type Level,
} from "@nyxeron/core";
import {
  ArrowLeft,
  Briefcase,
  Crown,
  Disc3,
  FolderOpen,
  PartyPopper,
  Settings,
  Sparkles,
  Trophy,
  Wallet,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { LOUNGE, useMusic } from "@/audio";
import { art } from "@/art";
import { Backdrop } from "@/components/Backdrop";
import { Brand } from "@/components/Brand";
import { Cta } from "@/components/Cta";
import { Img } from "@/components/Img";
import { Input } from "@/components/ui/input";
import { clock, en, fmt, genres } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { canRefill, useProfile } from "@/profile";
import { readSave, type Slot } from "@/save";
import { useSettings } from "@/settings";
import { guestJoin } from "@/net/session";
import { useAccount } from "@/auth/account";
import { useGame } from "@/store";

type Step = "home" | "role" | "ceo" | "guest" | "dj";
const t = en.dashboard;
const SLOTS: Slot[] = ["auto", 1, 2, 3];
/** One step back: a role's panel → the role picker → the dashboard home. */
const up = (s: Step): Step =>
  s === "ceo" || s === "guest" || s === "dj" ? "role" : "home";
const signed = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))} C`;

/** The player's hub between the landing page and the game: profile, wallet, then pick a role (CEO or guest). */
export function Dashboard() {
  useMusic(LOUNGE);
  // A shared invite link (…/?join=CODE) opens straight on the guest step with the code filled in.
  const [invite] = useState(() => {
    const code = new URLSearchParams(location.search).get("join") ?? "";
    if (code) history.replaceState(null, "", location.pathname);
    return code
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
  });
  const [step, setStep] = useState<Step>(invite ? "guest" : "home");
  const go = useGame((x) => x.go);
  const back = () => setStep(up);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.target instanceof HTMLInputElement) return;
      if (step === "home") go("menu");
      else setStep(up);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go]);

  return (
    <main className="fixed inset-0 overflow-y-auto">
      <Backdrop />
      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col gap-6 p-4 sm:p-8">
        <header className="enter flex items-center justify-between gap-3">
          <Brand onClick={() => go("menu")} />
          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] tracking-[0.3em] text-white/50 uppercase sm:inline">
              {t.title}
            </span>
            <button
              className="flex size-9 items-center justify-center rounded-lg border border-white/15 bg-black/30 hover:bg-white/10"
              onClick={() => useSettings.getState().setOpen(true)}
              aria-label={en.landing.settings}
              title={en.landing.settings}
            >
              <Settings className="size-4" />
            </button>
          </div>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-[21rem_1fr]">
          <ProfileCard />
          <section className="glass enter flex min-h-[28rem] flex-col rounded-2xl p-5 sm:p-7">
            {step !== "home" && (
              <button
                className="mb-4 flex items-center gap-1.5 self-start text-sm text-white/60 hover:text-white"
                onClick={back}
              >
                <ArrowLeft className="size-4" /> {t.back}
              </button>
            )}
            {step === "home" && <Home onEnter={() => setStep("role")} />}
            {step === "role" && <RolePicker onPick={setStep} />}
            {step === "ceo" && <CeoPanel />}
            {step === "guest" && (
              <>
                <LiveJoin initial={invite} />
                <EventList />
              </>
            )}
            {step === "dj" && <GigList />}
          </section>
        </div>
      </div>
    </main>
  );
}

function ProfileCard() {
  const p = useProfile();
  const auto = readSave("auto");
  return (
    <aside
      className="glass enter flex flex-col gap-5 rounded-2xl p-5"
      style={{ "--d": "60ms" } as CSSProperties}
    >
      <AccountRow />
      <div className="flex items-center gap-3">
        <span className="flex size-12 shrink-0 items-start justify-center overflow-hidden rounded-full border border-white/20 bg-white/[0.06]">
          <img
            src={`/sprites/guest-${p.avatar}.webp`}
            alt=""
            className="mt-1 h-[250%] w-auto max-w-none object-contain object-top"
          />
        </span>
        <label className="min-w-0 flex-1 text-[10px] tracking-[0.2em] text-white/50 uppercase">
          {t.nameLabel}
          <Input
            className="mt-1 h-9 text-sm tracking-normal normal-case"
            value={p.name}
            maxLength={20}
            placeholder={t.namePlaceholder}
            onChange={(e) => p.setName(e.target.value)}
          />
        </label>
      </div>

      <AvatarPicker />

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-white/55 uppercase">
          <Wallet className="size-3.5" /> {t.wallet}
        </div>
        <div className="mt-1 font-mono text-3xl tabular-nums">
          {fmt(p.wallet)} <span className="text-base text-white/50">C</span>
        </div>
        <p className="mt-1 text-[11px] text-white/50">{t.walletNote}</p>
        {canRefill(p.wallet) && (
          <button
            className="mt-3 h-8 rounded-md bg-white px-3 text-xs font-medium text-black"
            onClick={p.refill}
          >
            {t.refill}
          </button>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        <Stat icon={<PartyPopper className="size-3.5" />} label={t.nights}>
          {p.nights}
        </Stat>
        <Stat icon={<Sparkles className="size-3.5" />} label={t.totalPnl}>
          {signed(p.totalPnl)}
        </Stat>
        <Stat icon={<Trophy className="size-3.5" />} label={t.bestPnl}>
          {p.nights ? signed(p.bestPnl) : "—"}
        </Stat>
      </dl>

      <Portfolio />

      <div className="mt-auto border-t border-white/10 pt-4">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-white/55 uppercase">
          <Crown className="size-3.5" /> {t.club}
        </div>
        <p className="mt-1 text-sm text-white/75">
          {auto
            ? t.clubLine(
                auto.state.clubName,
                auto.state.day,
                levels[auto.state.level].name,
              )
            : t.noClub}
        </p>
      </div>
    </aside>
  );
}

/** Pick a look from the club's guest sprites (1–5 men, 6–10 women); it walks the floor on guest nights. */
function AvatarPicker() {
  const { avatar, setAvatar } = useProfile();
  const group = (label: string, from: number) => (
    <div>
      <div className="mb-1 text-[10px] text-white/45">{label}</div>
      <div className="grid grid-cols-5 gap-1.5">
        {[0, 1, 2, 3, 4].map((i) => {
          const n = from + i;
          return (
            <button
              key={n}
              onClick={() => setAvatar(n)}
              aria-pressed={avatar === n}
              aria-label={t.avatarPick(n)}
              className={cn(
                "flex aspect-[3/4] items-end justify-center overflow-hidden rounded-md border bg-white/[0.03] transition",
                avatar === n
                  ? "border-white shadow-[0_0_14px_rgba(255,255,255,.35)]"
                  : "border-white/10 opacity-70 hover:opacity-100",
              )}
            >
              <img
                src={`/sprites/guest-${n}.webp`}
                alt=""
                className="h-[92%] w-auto object-contain"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="text-[10px] tracking-[0.2em] text-white/50 uppercase">
        {t.avatar}
      </div>
      {group(t.men, 1)}
      {group(t.women, 6)}
    </div>
  );
}

/** Tokens the player bought on nights out (buy-only, so they keep them). On-chain delivery comes later. */
function Portfolio() {
  const portfolio = useProfile((p) => p.portfolio);
  const rows = ids(tokens).filter((x) => portfolio[x]?.qty);
  return (
    <div>
      <div className="mb-2 text-[10px] tracking-[0.2em] text-white/50 uppercase">
        {t.portfolio}
      </div>
      {rows.length ? (
        <ul className="space-y-1">
          {rows.map((x) => (
            <li
              key={x}
              className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs"
            >
              <Img
                src={art.token(x)}
                alt=""
                className="size-5 rounded-full object-cover"
                fallback={<span className="size-5" />}
              />
              <span className="font-mono font-semibold">
                {tokens[x].ticker}
              </span>
              <span className="ml-auto font-mono tabular-nums">
                ×{portfolio[x]!.qty}
              </span>
              <span className="w-24 text-right text-white/50">
                {t.paid(fmt(portfolio[x]!.cost))}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-white/50">{t.portfolioEmpty}</p>
      )}
    </div>
  );
}

/** Who is signed in: email, embedded wallet (copy), sign out. Hidden when sign-in isn't configured (dev). */
function AccountRow() {
  const { account, logout, server } = useAccount();
  const notify = useGame((x) => x.notify);
  if (!account) return null;
  const a = en.auth;
  const w = account.wallet;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs">
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="truncate">{account.email}</span>
          {server && (
            <span
              className="shrink-0 rounded border border-white/20 px-1 text-[9px] tracking-wider text-white/70 uppercase"
              title={a.serverHint}
            >
              {a.server[server]}
            </span>
          )}
        </div>
        <button
          className="mt-0.5 font-mono text-[11px] text-white/55 hover:text-white disabled:hover:text-white/55"
          disabled={!w}
          title={w || undefined}
          onClick={() => {
            void navigator.clipboard?.writeText(w);
            notify(a.copied);
          }}
        >
          {w ? `${a.wallet}: ${w.slice(0, 6)}…${w.slice(-4)}` : a.walletPending}
        </button>
      </div>
      <button
        className="shrink-0 rounded-md border border-white/15 px-2.5 py-1.5 hover:bg-white/10"
        onClick={async () => {
          await logout?.();
          // A clean start: every per-player store goes back to signed-out defaults.
          location.reload();
        }}
      >
        {a.signOut}
      </button>
    </div>
  );
}

function Stat({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2 py-2.5">
      <dd className="truncate font-mono text-sm tabular-nums">{children}</dd>
      <dt className="mt-1 flex items-center justify-center gap-1 text-[10px] text-white/50">
        {icon}
        {label}
      </dt>
    </div>
  );
}

function Home({ onEnter }: { onEnter: () => void }) {
  const name = useProfile((p) => p.name);
  return (
    <div className="flex flex-1 flex-col justify-end gap-6">
      <div>
        <div className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
          {t.kicker}
        </div>
        <h1 className="mt-2 text-4xl font-medium tracking-[-0.03em] sm:text-6xl">
          {name ? `${name}.` : en.title}
        </h1>
        <p className="mt-3 max-w-lg text-white/65">{en.tagline}</p>
      </div>
      <Cta className="w-60" onClick={onEnter} autoFocus>
        {t.enter}
      </Cta>
    </div>
  );
}

function RolePicker({ onPick }: { onPick: (s: Step) => void }) {
  const roles = [
    { id: "ceo" as const, Icon: Briefcase, ...t.roles.ceo },
    { id: "dj" as const, Icon: Disc3, ...t.roles.dj },
    { id: "guest" as const, Icon: PartyPopper, ...t.roles.guest },
  ];
  return (
    <div className="flex flex-1 flex-col gap-5">
      <h2 className="text-2xl font-medium tracking-[-0.02em]">
        {t.chooseRole}
      </h2>
      <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-3">
        {roles.map(({ id, Icon, title, tagline, desc }, i) => (
          <button
            key={id}
            autoFocus={i === 0}
            onClick={() => onPick(id)}
            className="enter group flex flex-col justify-between gap-8 rounded-2xl border border-white/12 bg-white/[0.03] p-6 text-left transition hover:border-white/40 hover:bg-white/[0.07] hover:shadow-[0_0_30px_rgba(255,255,255,.12)]"
            style={{ "--d": `${i * 80}ms` } as CSSProperties}
          >
            <Icon className="size-8 text-white/80" />
            <div>
              <div className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
                {tagline}
              </div>
              <div className="mt-1 text-3xl font-medium tracking-[-0.02em]">
                {title}
              </div>
              <p className="mt-3 text-sm leading-relaxed text-white/65">
                {desc}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function CeoPanel() {
  const { start, go, load } = useGame();
  const auto = readSave("auto");
  const [loading, setLoading] = useState(false);
  const row =
    "flex w-full items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5 text-left hover:border-white/30 hover:bg-white/[0.07] disabled:opacity-40";
  const options: [string, string, () => void][] = [
    [t.newCareer, t.newCareerDesc, () => go("setup")],
    [t.basement, t.basementDesc, () => start({ mode: "basement" })],
    [t.sandbox, t.sandboxDesc, () => start({ mode: "sandbox" })],
  ];
  return (
    <div className="flex flex-col gap-3">
      <h2 className="mb-2 text-2xl font-medium tracking-[-0.02em]">
        {t.ceoTitle}
      </h2>
      {auto && (
        <button
          className={cn(row, "border-white/40 bg-white/[0.08]")}
          onClick={() => load(auto.state)}
          autoFocus
        >
          <span>
            <span className="block font-medium">{t.continue}</span>
            <span className="block text-xs text-white/60">
              {t.clubLine(
                auto.state.clubName,
                auto.state.day,
                levels[auto.state.level].name,
              )}
            </span>
          </span>
          <span aria-hidden>→</span>
        </button>
      )}
      {options.map(([label, desc, fn]) => (
        <button key={label} className={row} onClick={fn}>
          <span>
            <span className="block font-medium">{label}</span>
            <span className="block text-xs text-white/60">{desc}</span>
          </span>
          <span aria-hidden>→</span>
        </button>
      ))}
      <button className={row} onClick={() => setLoading((v) => !v)}>
        <span className="flex items-center gap-2 font-medium">
          <FolderOpen className="size-4" /> {t.load}
        </span>
        <span aria-hidden>{loading ? "−" : "+"}</span>
      </button>
      {loading &&
        SLOTS.map((slot) => {
          const f = readSave(slot);
          return (
            <button
              key={slot}
              disabled={!f}
              onClick={() => f && load(f.state)}
              className={cn(row, "py-2.5 text-sm")}
            >
              <span className="tracking-[0.14em] uppercase">
                {slot === "auto" ? en.menu.autosave : en.menu.slot(slot)}
              </span>
              <span className="text-xs text-white/60">
                {f
                  ? t.clubLine(
                      f.state.clubName,
                      f.state.day,
                      levels[f.state.level].name,
                    )
                  : en.menu.empty}
              </span>
            </button>
          );
        })}
    </div>
  );
}

/** Walk into a real CEO's live club with the room code they shared. */
function LiveJoin({
  initial,
  as = "guest",
}: {
  initial: string;
  as?: "guest" | "dj";
}) {
  const go = useGame((x) => x.go);
  const [code, setCode] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const l = en.live;
  const join = async () => {
    const { name, avatar, wallet } = useProfile.getState();
    setBusy(true);
    setError("");
    try {
      await guestJoin(code, { name: name || t.anon, avatar, cash: wallet }, as);
      go(as === "dj" ? "livedj" : "live");
    } catch (e) {
      setError(l.error((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mb-6 flex flex-col gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void join();
      }}
    >
      <div>
        <h2 className="text-lg font-medium">
          {as === "dj" ? l.djJoinTitle : l.joinTitle}
        </h2>
        <p className="text-sm text-white/55">
          {as === "dj" ? l.djJoinHint : l.joinHint}
        </p>
      </div>
      <div className="flex gap-2">
        <Input
          value={code}
          onChange={(e) =>
            setCode(
              e.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .slice(0, 6),
            )
          }
          placeholder="K7QX9P"
          aria-label={l.code}
          autoFocus={!!initial}
          className="h-10 max-w-40 font-mono text-lg tracking-[0.3em] uppercase"
        />
        <button
          type="submit"
          disabled={code.length !== 6 || busy}
          className="h-10 rounded-lg bg-white px-4 text-xs font-semibold tracking-[0.14em] text-black uppercase disabled:opacity-40"
        >
          {busy ? "…" : as === "dj" ? l.djJoin : l.join}
        </button>
      </div>
      {error && <p className="text-sm text-white/80">{error}</p>}
    </form>
  );
}

function EventList() {
  const join = useGame((x) => x.joinEvent);
  const wallet = useProfile((p) => p.wallet);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-2xl font-medium tracking-[-0.02em]">
          {t.eventsTitle}
        </h2>
        <p className="mt-1 text-sm text-white/55">{t.eventsNote}</p>
      </div>
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {scenarios.events.map((e: EventSpec, i) => {
          const lv = e.level as Level;
          const cover = levels[lv].coverCharge;
          const menu = ids(tokens).filter((x) => tokens[x].minLevel <= lv);
          return (
            <li
              key={e.id}
              className="enter flex flex-col overflow-hidden rounded-2xl border border-white/12 bg-white/[0.03]"
              style={{ "--d": `${i * 70}ms` } as CSSProperties}
            >
              <div className="relative aspect-video">
                <Img
                  src={art.venue(lv)}
                  alt=""
                  className="size-full object-cover"
                  fallback={<span className="block size-full bg-white/5" />}
                />
                <span className="absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] tracking-[0.2em] uppercase">
                  <span className="size-1.5 animate-pulse rounded-full bg-white" />
                  {t.live}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-3 p-4">
                <div>
                  <div className="text-lg font-medium">{e.clubName}</div>
                  <div className="text-xs text-white/55">
                    {levels[lv].name} · {genres[e.genre] ?? e.genre}
                  </div>
                  <div className="mt-1 text-[11px] text-white/45">
                    {t.hostedBy}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {menu.map((x) => (
                    <span
                      key={x}
                      className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/70"
                    >
                      {tokens[x].ticker}
                    </span>
                  ))}
                </div>
                <div className="mt-auto flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-white/65">
                    {t.cover(fmt(cover))}
                  </span>
                  <button
                    className="h-9 rounded-lg bg-white px-4 text-xs font-semibold tracking-[0.14em] text-black uppercase disabled:opacity-40"
                    disabled={wallet < cover}
                    onClick={() => void join(e)}
                  >
                    {t.join}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The DJ's side: practise in the studio, or take a gig at one of tonight's clubs. */
function GigList() {
  const { go, joinGig } = useGame();
  const gigs = useProfile((p) => p.gigs ?? 0);
  const g = en.gig;
  return (
    <div className="flex flex-col gap-4">
      <button
        className="flex items-center justify-between gap-4 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3.5 text-left hover:border-white/40 hover:bg-white/[0.08]"
        onClick={() => go("studio")}
      >
        <span className="flex items-center gap-3">
          <Disc3 className="size-5" />
          <span>
            <span className="block font-medium">{g.studio}</span>
            <span className="block text-xs text-white/60">{g.studioDesc}</span>
          </span>
        </span>
        <span aria-hidden>→</span>
      </button>
      <LiveJoin initial="" as="dj" />
      <div>
        <h2 className="text-2xl font-medium tracking-[-0.02em]">{g.invites}</h2>
        <p className="mt-1 text-sm text-white/55">
          {g.invitesNote} · {g.gigs(gigs)}
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {scenarios.events
          .filter((e) => "djFee" in e && e.djFee)
          .map((e, i) => {
            const lv = e.level as Level;
            return (
              <li
                key={e.id}
                className="enter flex flex-col overflow-hidden rounded-2xl border border-white/12 bg-white/[0.03]"
                style={{ "--d": `${i * 70}ms` } as CSSProperties}
              >
                <div className="relative aspect-video">
                  <Img
                    src={art.venue(lv)}
                    alt=""
                    className="size-full object-cover"
                    fallback={<span className="block size-full bg-white/5" />}
                  />
                  <span className="absolute top-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] tracking-[0.2em] uppercase">
                    {g.slot(clock(night.djSetStartMinute))}
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <div>
                    <div className="text-lg font-medium">{e.clubName}</div>
                    <div className="text-xs text-white/55">
                      {levels[lv].name} · {genres[e.genre] ?? e.genre}
                    </div>
                    <div className="mt-1 text-[11px] text-white/45">
                      {t.hostedBy}
                    </div>
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <span className="font-mono text-sm">
                      {fmt(("djFee" in e && e.djFee) || 0)} C
                    </span>
                    <button
                      className="h-9 rounded-lg bg-white px-4 text-xs font-semibold tracking-[0.14em] text-black uppercase"
                      onClick={() => joinGig(e)}
                    >
                      {g.accept}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
