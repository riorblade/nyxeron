import { useSettings } from "@/state/settings";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { audio, LOUNGE, useMusic } from "@/audio";
import { Cta } from "@/components/Cta";
import { en } from "@/i18n/en";
import { useGame } from "@/state/store";
import "./landing.css";

/** Scroll windows, all in 0..1 of their section's progress. */
const C = {
  shrink: [0.0, 0.4],
  dissolveGreek: [0.05, 0.34],
  dissolve: [0.45, 0.7],
  revealVh: 80, // the split travels a fixed 80vh of scroll; reveal start is derived from it
  brandEndPx: 120,
  brandMaxScale: 0.51,
  lerp: 0.08,
  epsilon: 0.01,
  endMargin: 0.05,
  swaps: 7,
  swapWindow: [0.03, 0.38],
  swapHalf: 0.011,
  s2Words: [0.02, 0.26],
  s2Exit: [0.02, 0.32],
  s3Words: [0.55, 0.95],
  // ponytail: fixed thresholds instead of the spec's rotated-strip geometry solver; solve it if the timing reads off.
  titleOn: 0.92,
  titleOut: 0.3,
  titleHysteresis: 0.01,
  burstSteps: 3,
  burstGap: 90,
} as const;

/** Letters that flicker to a Greek partner (Nyx is Greek; mostly phonetic, all visibly different). */
const GREEK: Record<string, string> = {
  X: "Ξ",
  O: "Ω",
  Y: "Ψ",
  R: "Ρ",
  G: "Γ",
  L: "Λ",
  F: "Φ",
  D: "Δ",
  S: "Σ",
  P: "Π",
};

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const norm = (p: number, [a, b]: readonly number[]) =>
  clamp((p - a!) / (b! - a!));
/** Deterministic 0..1 hash, so the glyph flicker is a pure function of scroll position. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
/** Word i's window start. Capped one word-duration (0.09, see .s2-word/.s3-word) short of 1 so the last word fully lands. */
const spread = ([a, b]: readonly number[], i: number, n: number) =>
  a! + ((Math.min(b!, 0.91) - a!) * i) / Math.max(1, n - 1);
const vars = (o: Record<string, number | string>) => o as CSSProperties;

function Line({ role, text }: { role: "main" | "alt" | "crew"; text: string }) {
  return (
    <span
      className="brand__line"
      data-role={role}
      aria-hidden={role === "main" ? undefined : true}
    >
      {[...text.toUpperCase()].map((c, i) => (
        <span key={i} className="brand__char" data-latin={c === " " ? " " : c}>
          {c === " " ? " " : c}
        </span>
      ))}
    </span>
  );
}

function Words({
  text,
  cls,
  w,
  x,
}: {
  text: string;
  cls: string;
  w: readonly number[];
  x?: readonly number[];
}) {
  const words = text.split(" ");
  return words.map((word, i) => (
    <Fragment key={i}>
      <span
        className={cls}
        style={vars({
          "--w0": spread(w, i, words.length),
          ...(x && { "--x0": spread(x, i, words.length) }),
        })}
      >
        {word}
      </span>{" "}
    </Fragment>
  ));
}

function useVeltraClock() {
  const fmtTime = () =>
    `[ ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })} ]`;
  const [t, setT] = useState(fmtTime);
  useEffect(() => {
    let iv: ReturnType<typeof setInterval>;
    const first = setTimeout(
      () => {
        setT(fmtTime());
        iv = setInterval(() => setT(fmtTime()), 60_000);
      },
      60_000 - (Date.now() % 60_000),
    );
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, []);
  return t;
}

/** Landing sound switch. The first click anywhere already starts the music; this makes it discoverable. */
function SoundToggle() {
  const state = useSyncExternalStore(
    (cb) => audio.subscribe(cb),
    () => (!audio.unlocked ? "off" : audio.muted ? "muted" : "on"),
  );
  const on = state === "on";
  return (
    <button
      className="hit micro nx-in"
      style={vars({ "--d": "830ms" })}
      aria-pressed={on}
      onClick={() => {
        audio.unlock();
        if (state === "muted" || state === "on") audio.toggleMute();
      }}
    >
      ♪ {on ? en.landing.soundOn : en.landing.soundOff}
    </button>
  );
}

export function Landing() {
  useMusic(LOUNGE);
  const go = useGame((x) => x.go);
  const [ctaLive, setCtaLive] = useState(false);
  const clock = useVeltraClock();
  const root = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLVideoElement>(null);
  const reveal = useRef<HTMLVideoElement>(null);
  const brand = useRef<HTMLHeadingElement>(null);
  const r1 = useRef<HTMLDivElement>(null);
  const r2 = useRef<HTMLDivElement>(null);
  const r3 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = en.landing.docTitle;
    window.scrollTo(0, 0);
    const el = root.current!;
    const h = hero.current!;
    const rv = reveal.current!;
    const b = brand.current!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const setVar = (k: string, v: number) =>
      el.style.setProperty(k, v.toFixed(4));

    const chars = (role: string) => [
      ...b.querySelectorAll<HTMLElement>(`[data-role="${role}"] .brand__char`),
    ];
    const byRole = {
      main: chars("main"),
      alt: chars("alt"),
      crew: chars("crew"),
    };
    const all = [...byRole.main, ...byRole.alt, ...byRole.crew];
    const latin = (c: HTMLElement) => {
      if (c.hasAttribute("data-greek")) {
        c.removeAttribute("data-greek");
        c.textContent = c.dataset.latin!;
      }
    };
    const greek = (c: HTMLElement) => {
      const g = GREEK[c.dataset.latin!];
      if (g && !c.hasAttribute("data-greek")) {
        c.setAttribute("data-greek", "");
        c.textContent = g;
      }
    };

    // Glyph-swap schedule: 7 events tiled over the window, jittered by a fixed hash.
    const swappable = byRole.main.filter((c) => GREEK[c.dataset.latin!]);
    const [sa, sb] = C.swapWindow;
    const cell = (sb - sa) / C.swaps;
    const swaps = Array.from({ length: C.swaps }, (_, n) => ({
      at: sa + cell * (n + 0.5) + (hash(n) - 0.5) * cell * 0.6,
      char: swappable[Math.floor(hash(n + 99) * swappable.length)],
    }));

    let span = 1,
      span2 = 1,
      span3 = 1,
      shrinkEnd: number = C.brandMaxScale,
      revealStart = 0.68;
    let target = 0,
      smoothed = 0,
      raf = 0,
      title: "main" | "alt" | "crew" = "main",
      revealOn = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const scrubTime = (p: number) => {
      const d = h.duration;
      if (!d) return 0;
      return Math.min(1, p / revealStart) * Math.max(0, d - C.endMargin);
    };

    const burst = (role: "main" | "alt" | "crew") => {
      const list = byRole[role].filter((c) => GREEK[c.dataset.latin!]);
      for (let i = 0; i <= C.burstSteps; i++)
        timers.push(
          setTimeout(() => {
            list.forEach(latin);
            if (i < C.burstSteps && list.length)
              greek(list[Math.floor(hash(i + role.length * 7) * list.length)]!);
          }, i * C.burstGap),
        );
    };

    const updateTitle = (p: number, p3: number) => {
      const hy = C.titleHysteresis;
      const out = title === "crew" ? p3 > C.titleOut - hy : p3 >= C.titleOut;
      const on = title !== "main" ? p > C.titleOn - hy : p >= C.titleOn;
      const next = out ? "crew" : on ? "alt" : "main";
      if (next === title) return;
      title = next;
      if (next === "main") b.removeAttribute("data-title");
      else b.setAttribute("data-title", next);
      if (!reduced) burst(next);
    };

    const onScroll = () => {
      const y = window.scrollY;
      const p = clamp(y / span);
      const p2 = clamp((y - span) / span2);
      const p3 = clamp((y - span - span2) / span3);
      setVar("--shrink", 1 - (1 - shrinkEnd) * norm(p, C.shrink));
      setVar("--exit", norm(p, C.dissolve));
      setVar("--exit-greek", norm(p, C.dissolveGreek));
      setVar("--reveal", norm(p, [revealStart, 1]));
      setVar("--s2", p2);
      setVar("--s3", p3);
      target = scrubTime(p);

      // Reveal clip plays (and loops) only while the split is open; rewinds on each fresh entry.
      if (!reduced) {
        const want = p >= revealStart;
        if (want && !revealOn) {
          rv.currentTime = 0;
          rv.play().catch(() => {});
        } else if (!want && revealOn) rv.pause();
        else if (want && rv.paused) rv.play().catch(() => {});
        revealOn = want;
      }

      if (!reduced) {
        const hit = swaps.find((s) => Math.abs(p - s.at) < C.swapHalf)?.char;
        for (const c of swappable) if (c !== hit) latin(c);
        if (hit) greek(hit);
      }
      updateTitle(p, p3);
      setCtaLive(p3 > 0.9);
    };

    const measure = () => {
      // fonts.ready can resolve after the landing page is gone (straight to the dashboard).
      if (!r1.current) return;
      el.style.setProperty("--shrink", "1");
      all.forEach((c) => {
        latin(c);
        c.style.width = "";
      });
      const slots = b.querySelectorAll(".brand__slot");
      const blockH =
        slots[slots.length - 1]!.getBoundingClientRect().bottom -
        slots[0]!.getBoundingClientRect().top;
      shrinkEnd = Math.min(C.brandEndPx / blockH, C.brandMaxScale);
      el.style.setProperty("--shrink-end", shrinkEnd.toFixed(4));
      // Lock each glyph to its Latin advance so Greek flips never reflow the line.
      all.forEach(
        (c) => (c.style.width = `${c.getBoundingClientRect().width}px`),
      );
      span = Math.max(1, r1.current!.offsetHeight - innerHeight);
      span2 = r2.current!.offsetHeight;
      span3 = r3.current!.offsetHeight;
      revealStart = Math.max(
        0.35,
        1 - ((C.revealVh / 100) * innerHeight) / span,
      );
      onScroll();
    };

    const frame = () => {
      smoothed += (target - smoothed) * C.lerp;
      if (Math.abs(target - smoothed) < C.epsilon / 10) smoothed = target;
      // The hero is encoded all-intra, so seeks are cheap; `!seeking` keeps us from stacking them.
      if (
        !reduced &&
        h.readyState >= 2 &&
        !h.seeking &&
        Math.abs(h.currentTime - smoothed) > C.epsilon
      )
        h.currentTime = smoothed;
      raf = requestAnimationFrame(frame);
    };
    const onLoaded = () => {
      smoothed = target = scrubTime(0);
      h.currentTime = smoothed;
    };

    h.pause();
    h.addEventListener("loadeddata", onLoaded);
    measure();
    document.fonts.ready.then(measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      h.removeEventListener("loadeddata", onLoaded);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      window.scrollTo(0, 0);
    };
  }, []);

  const L = en.landing;
  // Everything (clubs, events, the studio) starts from the dashboard.
  const contact = () => go("dashboard");
  const bottomWords = L.bottom.flatMap((l) => l.split(" "));
  let bw = 0;

  return (
    <div ref={root} className="nx">
      <div className="stage">
        <video
          ref={hero}
          className="stage__media"
          src="/landing-hero.mp4"
          poster="/landing-hero.webp"
          muted
          playsInline
          preload="auto"
        />
      </div>
      <div className="reveal" aria-hidden>
        <video
          ref={reveal}
          className="reveal__video"
          src="/landing-reveal.mp4"
          muted
          loop
          playsInline
          preload="auto"
        />
      </div>
      <div className="nx-grain" aria-hidden />

      <div ref={r1} className="runway" aria-hidden />
      <div ref={r2} className="runway-2" aria-hidden />
      <div ref={r3} className="runway-3" aria-hidden />

      <section className="sec2" aria-label={L.statement}>
        <h2 className="s2-statement">
          <Words text={L.statement} cls="s2-word" w={C.s2Words} x={C.s2Exit} />
        </h2>
      </section>

      <section className="sec3" aria-label={L.bottom.join(", ")}>
        <p className="s3-left" style={vars({ "--i": 0 })}>
          {L.left}
        </p>
        <p className="s3-right" style={vars({ "--i": 1 })}>
          {L.right}
        </p>
        <p className="s3-bottom">
          {L.bottom.map((line, li) => (
            <Fragment key={li}>
              {line.split(" ").map((word, wi) => (
                <Fragment key={wi}>
                  <span
                    className="s3-word"
                    style={vars({
                      "--w0": spread(C.s3Words, bw++, bottomWords.length),
                    })}
                  >
                    {word}
                  </span>{" "}
                </Fragment>
              ))}
              {li < L.bottom.length - 1 && <br />}
            </Fragment>
          ))}
        </p>
      </section>

      <div className="frame">
        <h1 className="brand" ref={brand} aria-label={L.main.join(" ")}>
          {[0, 1].map((i) => (
            <span key={i} className="brand__slot">
              <Line role="main" text={L.main[i]!} />
              <Line role="alt" text={L.alt[i]!} />
              <Line role="crew" text={L.crew[i]!} />
            </span>
          ))}
          <span className="brand__greek" lang="el" aria-hidden>
            {L.greek.map((g, i) => (
              <span
                key={i}
                className="nx-in"
                style={vars({ "--d": `${450 + i * 60}ms` })}
              >
                {g}
              </span>
            ))}
          </span>
        </h1>

        <div className="chrome micro">
          <div className="nx-in" style={vars({ "--d": "550ms" })}>
            <time className="clock__time">{clock}</time>
            <span className="clock__zone">
              {L.zone[0]}
              <br />
              {L.zone[1]}
            </span>
          </div>
          <nav className="nav" aria-label="Primary">
            {[
              [L.enter, () => go("dashboard")],
              [L.settings, () => useSettings.getState().setOpen(true)],
            ].map(([label, fn], i) => (
              <button
                key={i}
                className="hit micro nx-in"
                style={vars({ "--d": `${590 + i * 40}ms` })}
                onClick={fn as () => void}
              >
                {label as string}
              </button>
            ))}
          </nav>
          <button
            className="contact micro hit nx-in"
            style={vars({ "--d": "710ms" })}
            onClick={contact}
          >
            ↳&nbsp;{L.contactNew}
          </button>
        </div>

        <p className="lede">
          <span className="nx-in" style={vars({ "--d": "700ms" })}>
            {L.lede}
          </span>
        </p>
        <div className="foot micro">
          <span className="nx-in" style={vars({ "--d": "800ms" })}>
            {L.copyright}
          </span>
          <SoundToggle />
          <span className="nx-in" style={vars({ "--d": "860ms" })}>
            {L.scroll}
          </span>
        </div>
      </div>

      <div className="nx-cta" data-live={ctaLive || undefined}>
        <Cta className="w-52" onClick={() => go("dashboard")}>
          {L.newCareer}
        </Cta>
      </div>
    </div>
  );
}
