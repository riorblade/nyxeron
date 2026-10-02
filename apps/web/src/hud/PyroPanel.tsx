import { Cloud, Flame, Zap } from "lucide-react";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useSettings } from "@/state/settings";
import { firePyro, type PyroCue } from "@/venue/pyro";

const cues: { cue: PyroCue; Icon: typeof Flame; key: string }[] = [
  { cue: "fire", Icon: Flame, key: "F" },
  { cue: "fog", Icon: Cloud, key: "G" },
  { cue: "both", Icon: Zap, key: "B" },
];

/** Stage pyro: auto (on the DJ's beat) or manual (the CEO fires flames, fog, or both). */
export function PyroPanel() {
  const { pyro, set } = useSettings();
  const t = en.pyro;
  const manual = pyro === "manual";
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] tracking-[0.2em] text-white/60 uppercase">
          {t.title}
        </h3>
        <div
          role="radiogroup"
          aria-label={t.title}
          className="flex rounded-md border border-white/15 p-0.5 text-[11px]"
        >
          {(["auto", "manual"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={pyro === m}
              onClick={() => set({ pyro: m })}
              className={cn(
                "rounded px-2.5 py-1",
                pyro === m
                  ? "bg-white text-black"
                  : "text-white/70 hover:bg-white/10",
              )}
            >
              {t.modes[m]}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {cues.map(({ cue, Icon, key }) => (
          <button
            key={cue}
            disabled={!manual}
            onClick={() => firePyro(cue)}
            title={`${t.cues[cue]} [${key}]`}
            className="flex flex-col items-center gap-1 rounded-lg border border-white/15 bg-white/[0.04] py-2.5 text-xs hover:bg-white/12 active:scale-95 disabled:opacity-35 disabled:active:scale-100"
          >
            <Icon className="size-4" />
            {t.cues[cue]}
            <span className="font-mono text-[10px] text-white/45">{key}</span>
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-white/50">
        {manual ? t.manualHint : t.autoHint}
      </p>
    </section>
  );
}
