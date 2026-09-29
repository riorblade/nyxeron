import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Primary call to action: white pill, dark arrow box on the right (MotionSites "Data Signal"). */
export function Cta({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        "group relative flex h-12 items-center rounded-lg bg-white pr-14 pl-5 text-left text-[15px] font-medium tracking-[0.18em] text-neutral-950 uppercase shadow-[0_1px_5px_rgba(0,0,0,.38),inset_0_1px_0_rgba(255,255,255,.72)] disabled:opacity-40",
        className,
      )}
    >
      {children}
      <span className="absolute top-1.5 right-1.5 bottom-1.5 flex aspect-square items-center justify-center rounded-md bg-neutral-950 text-white transition-transform duration-300 ease-(--ease-out-expo) group-hover:translate-x-0.5">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path
            d="M3 7h8m-3.5-3.5L11 7l-3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}
