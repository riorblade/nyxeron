import { Settings as Gear, X } from "lucide-react";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { audio } from "@/audio";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useSettings, type ClipMode } from "@/settings";

const t = en.settings;

/** General settings: music inside / outside the club, SFX, venue screens, cutscene. */
export function SettingsDialog() {
  const st = useSettings();
  const volume = useSyncExternalStore(
    (cb) => audio.subscribe(cb),
    () => audio.volume,
  );

  useEffect(() => {
    if (!st.open) return;
    // Capture phase: Esc closes Settings instead of toggling the pause menu underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      st.setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [st]);

  if (!st.open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => st.setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={t.title}
        className="glass glow enter flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <Gear className="size-4" /> {t.title}
          </h2>
          <button
            className="flex size-8 items-center justify-center rounded-md hover:bg-white/10"
            onClick={() => st.setOpen(false)}
            aria-label={t.close}
            autoFocus
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="space-y-6 overflow-y-auto p-5">
          <Group title={t.audio}>
            <Row label={t.volume}>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={(e) => {
                  audio.unlock();
                  audio.setVolume(Number(e.target.value) / 100);
                }}
                className="w-36 accent-white"
                aria-label={t.volume}
              />
            </Row>
            <Toggle
              label={t.menuMusic}
              desc={t.menuMusicDesc}
              on={st.menuMusic}
              set={(v) => st.set({ menuMusic: v })}
            />
            <Toggle
              label={t.venueMusic}
              desc={t.venueMusicDesc}
              on={st.venueMusic}
              set={(v) => st.set({ venueMusic: v })}
            />
            <Toggle
              label={t.sfx}
              desc={t.sfxDesc}
              on={st.sfx}
              set={(v) => st.set({ sfx: v })}
            />
          </Group>
          <Group title={t.venue}>
            <div>
              <Row label={t.clips} desc={t.clipsDesc} />
              <div
                className="mt-2 grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-black/30 p-1"
                role="radiogroup"
                aria-label={t.clips}
              >
                {(["peak", "always", "off"] as ClipMode[]).map((m) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={st.clips === m}
                    onClick={() => st.set({ clips: m })}
                    className={cn(
                      "h-8 rounded-md text-xs",
                      st.clips === m
                        ? "bg-white font-semibold text-black"
                        : "text-white/70 hover:bg-white/10",
                    )}
                  >
                    {t.clipModes[m]}
                  </button>
                ))}
              </div>
            </div>
            <Toggle
              label={t.ads}
              desc={t.adsDesc}
              on={st.ads}
              set={(v) => st.set({ ads: v })}
            />
            <Toggle
              label={t.intro}
              desc={t.introDesc}
              on={st.intro}
              set={(v) => st.set({ intro: v })}
            />
          </Group>
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {desc && <div className="text-xs text-white/55">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({
  label,
  desc,
  on,
  set,
}: {
  label: string;
  desc: string;
  on: boolean;
  set: (v: boolean) => void;
}) {
  return (
    <Row label={label} desc={desc}>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => set(!on)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
          on ? "border-white bg-white" : "border-white/25 bg-white/5",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4.5 rounded-full transition-all",
            on ? "left-[1.3rem] bg-black" : "left-0.5 bg-white/70",
          )}
        />
      </button>
    </Row>
  );
}

/** Icon button that opens Settings (HUD, top bars). */
export function SettingsButton({ className }: { className?: string }) {
  const setOpen = useSettings((s) => s.setOpen);
  return (
    <button
      onClick={() => setOpen(true)}
      aria-label={t.open}
      title={t.open}
      className={cn(
        "flex size-10 items-center justify-center rounded-lg border border-white/15 bg-black/30 hover:bg-white/10",
        className,
      )}
    >
      <Gear className="size-4" />
    </button>
  );
}
