import { useEffect, useRef, useState, type CSSProperties } from "react";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

const SKIP_KEY = "nyxeron:skipIntro";

/** Per-viewer preference; storage can be unavailable (private mode), so default to showing the intro. */
export function introEnabled(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) !== "1";
  } catch {
    return true;
  }
}

/** Full-screen "Open Club" cutscene. The night clock waits until it ends or is skipped. */
export function IntroVideo({ day }: { day: number }) {
  const setIntro = useGame((s) => s.setIntro);
  const video = useRef<HTMLVideoElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [dontShow, setDontShow] = useState(false);

  const done = () => {
    if (leaving) return;
    setLeaving(true);
    try {
      if (dontShow) localStorage.setItem(SKIP_KEY, "1");
    } catch {
      /* preference just won't persist */
    }
    setTimeout(() => setIntro(false), 500);
  };
  const doneRef = useRef(done);
  useEffect(() => {
    doneRef.current = done;
  });

  useEffect(() => {
    // Sound is allowed right after the Open Club click; if the browser still blocks it, play muted.
    const v = video.current;
    v?.play().catch(() => {
      v.muted = true;
      v.play().catch(() => doneRef.current());
    });
    const onKey = (e: KeyboardEvent) => {
      if ([" ", "Enter", "Escape"].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        doneRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-black transition-opacity duration-500",
        leaving && "opacity-0",
      )}
      onClick={done}
      role="dialog"
      aria-label={en.intro.doors}
    >
      <video
        ref={video}
        src="/intro.mp4"
        poster="/intro-poster.jpg"
        playsInline
        preload="auto"
        onEnded={done}
        onError={done}
        className="h-full w-full object-cover"
      />
      {/* Cinematic bars + title, like a film opening. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[7vh] bg-black" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[7vh] bg-black" />
      <h2 className="pointer-events-none absolute bottom-[11vh] left-10 text-[clamp(40px,7vh,80px)] leading-none font-medium tracking-[-0.035em] [text-shadow:0_2px_12px_rgba(0,0,0,.6)]">
        <span className="line">
          <span
            className="line-reveal"
            style={{ "--d": "400ms" } as CSSProperties}
          >
            {en.hud.day(day)}
          </span>
        </span>
        <span className="line text-white/70">
          <span
            className="line-reveal"
            style={{ "--d": "560ms" } as CSSProperties}
          >
            {en.intro.doors}
          </span>
        </span>
      </h2>
      <div
        className="absolute right-10 bottom-[11vh] flex items-center gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <label className="flex cursor-pointer items-center gap-2 text-xs text-white/70">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="accent-white"
          />
          {en.intro.dontShow}
        </label>
        <button
          className="glass h-10 rounded-lg px-5 text-sm tracking-[0.14em] uppercase"
          onClick={done}
        >
          {en.intro.skip} ⏭
        </button>
      </div>
    </div>
  );
}
