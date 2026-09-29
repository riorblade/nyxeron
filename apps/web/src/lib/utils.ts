import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Keeps Tab / Shift+Tab inside a dialog (keydown handler for its root element). */
export function trapFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])",
    ),
  ];
  if (!items.length) return;
  const first = items[0]!,
    last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
