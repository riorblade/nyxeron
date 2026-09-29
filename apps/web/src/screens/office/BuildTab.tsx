import {
  levels,
  permitActive,
  permits,
  r18_upgradeLevel,
  requiredPermits,
  type GameState,
  type Level,
} from "@nyxeron/core";
import { Building2, Crown, Lock } from "lucide-react";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { en, fmt } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useGame } from "@/store";

/** Permits the next level requires that the player doesn't hold: upgrading without them invites inspections. */
const missingAfter = (s: GameState, lv: Level) =>
  requiredPermits(lv).filter((p) => !permitActive(s, p));

export function BuildTab({ s }: { s: GameState }) {
  const { act, notify } = useGame();
  const upgrade = () => {
    if (act(r18_upgradeLevel))
      notify(en.build.levelUp(levels[(s.level + 1) as Level].name));
  };
  return (
    <ol className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
      {([1, 2, 3, 4, 5] as const).map((lv) => {
        const l = levels[lv];
        const current = lv === s.level;
        const next = lv === s.level + 1;
        const done = lv < s.level;
        const far = lv > s.level + 1;
        return (
          <li
            key={lv}
            className={cn(
              "overflow-hidden rounded-xl border bg-white/[0.03]",
              current
                ? "border-white shadow-[0_0_32px_rgba(255,255,255,.14)]"
                : "border-white/10",
              far && "opacity-45",
            )}
          >
            <div className="relative aspect-[16/9]">
              <Img
                src={art.venue(lv)}
                alt={l.name}
                className={cn(
                  "absolute inset-0 size-full object-cover",
                  (far || done) && "grayscale brightness-50",
                )}
                fallback={
                  <Building2 className="absolute inset-0 m-auto size-8 text-white/30" />
                }
              />
              <span className="absolute top-2 left-2 rounded-md bg-black/65 px-2 py-0.5 font-mono text-xs">
                LV {lv}
              </span>
              {current && (
                <span className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-white px-2 py-0.5 text-[10px] font-semibold tracking-[0.15em] text-black uppercase">
                  <Crown className="size-3" /> {en.build.current}
                </span>
              )}
              {far && <Lock className="absolute inset-0 m-auto size-6" />}
            </div>
            <div className="space-y-2 p-4">
              <div className="text-lg font-semibold">{l.name}</div>
              <p className="text-xs leading-relaxed text-white/60">
                {en.build.unlocks[lv - 1]}
              </p>
              {!current && !done && (
                <div className="font-mono text-xs text-white/75">
                  {fmt(l.cost)} C · Rep {l.repRequired}
                </div>
              )}
              {next && missingAfter(s, lv).length > 0 && (
                <div className="text-xs">
                  ⚠{" "}
                  {en.build.permitsNeeded(
                    missingAfter(s, lv)
                      .map((p) => permits[p].name)
                      .join(", "),
                  )}
                </div>
              )}
              {next && (
                <button
                  onClick={upgrade}
                  className="mt-1 h-9 w-full rounded-lg bg-white text-xs font-semibold tracking-[0.14em] text-black uppercase shadow-[0_0_24px_rgba(255,255,255,.18)]"
                >
                  {en.build.upgrade}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
