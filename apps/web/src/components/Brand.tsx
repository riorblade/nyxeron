import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/state/store";

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 26 26"
      aria-hidden
      className="shrink-0 drop-shadow"
    >
      <circle cx="13" cy="13" r="12.5" fill="#ededed" />
      <path d="M13 3 L21 13 L13 23 L5 13 Z" fill="#050606" />
      <path d="M13 3 L21 13 L13 13 Z" fill="#737778" />
      <path d="M13 13 L13 23 L5 13 Z" fill="#fafafa" opacity=".9" />
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
