import { useState } from "react";
import { audio } from "@/audio";
import { PADS, type PadId } from "@/dj/sampler";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";

/** The CEO's sampler: fire the club's transition sounds over the resident DJ's music (Shift+1…8). */
export function SamplerPanel() {
  const [hit, setHit] = useState<PadId | null>(null);
  const fire = (p: PadId) => {
    audio.pad(p);
    setHit(p);
    setTimeout(() => setHit((h) => (h === p ? null : h)), 180);
  };
  return (
    <section>
      <h3 className="mb-2 text-[10px] tracking-[0.2em] text-white/60 uppercase">
        {en.dj.sampler}
      </h3>
      <div className="grid grid-cols-4 gap-1.5">
        {PADS.map((p, i) => (
          <button
            key={p}
            onPointerDown={() => fire(p)}
            title={`${en.dj.pads[p]} [Shift+${i + 1}]`}
            className={cn(
              "flex h-12 flex-col items-center justify-center rounded-lg border px-1 text-[11px] leading-tight transition",
              hit === p
                ? "border-white bg-white text-black shadow-[0_0_16px_rgba(255,255,255,.4)]"
                : "border-white/15 bg-white/[0.04] hover:bg-white/10",
            )}
          >
            {en.dj.pads[p]}
            <span className="font-mono text-[9px] opacity-50">⇧{i + 1}</span>
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-white/50">{en.dj.ceoSamplerHint}</p>
    </section>
  );
}

/** Shift+1…8 → pad (for the night screen's key handler). */
export const padForKey = (e: KeyboardEvent): PadId | null => {
  if (!e.shiftKey || !/^Digit[1-8]$/.test(e.code)) return null;
  return PADS[Number(e.code.slice(5)) - 1] ?? null;
};
