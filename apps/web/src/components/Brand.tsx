import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/state/store";

/** The NYXERON mark: the VIP diamond (public/brand/mark.svg); white on the dark UI, with a soft glow. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="currentColor"
      aria-hidden
      className="shrink-0 drop-shadow-[0_0_6px_rgba(255,255,255,.35)]"
    >
      <path d="M0 50 C 18 32, 34 10, 48 10 C 41 11, 37 17, 34 23 C 28 36, 18 47, 0 50 Z M100.00 50 C 82.00 32, 66.00 10, 52.00 10 C 59.00 11, 63.00 17, 66.00 23 C 72.00 36, 82.00 47, 100.00 50 Z M0 50.00 C 18 68.00, 34 90.00, 48 90.00 C 41 89.00, 37 83.00, 34 77.00 C 28 64.00, 18 53.00, 0 50.00 Z M100.00 50.00 C 82.00 68.00, 66.00 90.00, 52.00 90.00 C 59.00 89.00, 63.00 83.00, 66.00 77.00 C 72.00 64.00, 82.00 53.00, 100.00 50.00 Z" />
      <path d="M45.5 32.2 C 48.5 27, 51.5 22, 54.5 17.2 L54.5 67.8 C 51.5 73, 48.5 78, 45.5 82.8 Z" />
      <path d="M21.9 50 C 29 46.5, 35 43, 40 38.6 L40 66.8 C 35.5 60.5, 29 53.5, 21.9 50 Z M78.10 50.00 C 71.00 53.50, 65.00 57.00, 60.00 61.40 L60.00 33.20 C 64.50 39.50, 71.00 46.50, 78.10 50.00 Z" />
    </svg>
  );
}

/** Logo + wordmark, top-left on every screen. Always leads back to the landing page. */
export function Brand({
  className,
  compact,
  onClick,
}: {
  className?: string;
  compact?: boolean;
  onClick?: () => void;
}) {
  const home = useGame((s) => s.home);
  return (
    <button
      onClick={onClick ?? home}
      title={en.nav.homeTitle}
      aria-label={en.nav.homeTitle}
      className={cn("flex items-center gap-3 rounded-md", className)}
    >
      <Mark size={compact ? 22 : 26} />
      {!compact && (
        <span className="text-sm font-medium tracking-[0.35em]">
          {en.title}
        </span>
      )}
    </button>
  );
}

/** Explicit Home button for in-game screens. */
export function HomeButton({ className }: { className?: string }) {
  const home = useGame((s) => s.home);
  return (
    <button
      onClick={home}
      title={en.nav.homeTitle}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-black/30 px-3 text-xs text-white/75 hover:bg-white/10 hover:text-white",
        className,
      )}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
      </svg>
      {en.nav.home}
    </button>
  );
}
