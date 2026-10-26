import { Drone, PersonStanding, ScanEye, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CAM_MODES, type CamMode } from "@/avatar/camera";
import { DANCES, type Celebration, type Emote } from "@/avatar/moves";
import { stick } from "@/avatar/stick";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";

const t = en.guestControls;
const CAM_ICON: Record<CamMode, ReactNode> = {
  eyes: <ScanEye className="size-4" />,
  behind: <PersonStanding className="size-4" />,
  drone: <Drone className="size-4" />,
};

export const nextCam = (m: CamMode) =>
  CAM_MODES[(CAM_MODES.indexOf(m) + 1) % CAM_MODES.length]!;

/** Eyes / behind / drone. */
export function CameraSwitch({
  cam,
  onCam,
}: {
  cam: CamMode;
  onCam(m: CamMode): void;
}) {
  return (
    <div
      className="glass flex items-center gap-1 rounded-xl p-1"
      role="radiogroup"
      aria-label={t.camera}
    >
      {CAM_MODES.map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={cam === m}
          title={`${t.cams[m]} [V]`}
          onClick={() => onCam(m)}
          className={cn(
            "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs",
            cam === m ? "gold" : "text-white/75 hover:bg-white/10",
          )}
        >
          {CAM_ICON[m]}
          <span className="hidden md:inline">{t.cams[m]}</span>
        </button>
      ))}
    </div>
  );
}

/** Pick a dance (keys 1–8 online, G to start/stop) or a celebration the player owns (keys 9, 0). Walking pauses
 *  it; standing still picks it back up. */
export function EmoteBar({
  emote,
  onEmote,
  keys,
  celebrations,
}: {
  emote: Emote | null;
  onEmote(d: Emote | null): void;
  keys: boolean;
  celebrations: Celebration[];
}) {
  return (
    <div
      className="glass flex max-w-full items-center gap-1 overflow-x-auto rounded-xl p-1"
      aria-label={t.dance}
    >
      {DANCES.map((d, i) => (
        <button
          key={d}
          aria-pressed={emote === d}
          onClick={() => onEmote(emote === d ? null : d)}
          className={cn(
            "h-9 shrink-0 rounded-lg px-2.5 text-xs whitespace-nowrap",
            emote === d ? "gold" : "text-white/80 hover:bg-white/10",
          )}
        >
          {keys && (
            <span className="mr-1 font-mono text-[10px] opacity-60">
              {i + 1}
            </span>
          )}
          {en.wardrobe.moves[d]}
        </button>
      ))}
      {celebrations.map((d, i) => (
        <button
          key={d}
          aria-pressed={emote === d}
          onClick={() => onEmote(emote === d ? null : d)}
          className={cn(
            "flex h-9 shrink-0 items-center gap-1 rounded-lg border px-2.5 text-xs whitespace-nowrap",
            emote === d
              ? "gold border-transparent"
              : "border-[oklch(0.8_0.16_75/0.5)] text-[oklch(0.9_0.12_85)] hover:bg-white/10",
          )}
        >
          {keys && (
            <span className="font-mono text-[10px] opacity-60">
              {(DANCES.length + i + 1) % 10}
            </span>
          )}
          <Sparkles className="size-3" />
          {en.wardrobe.moves[d]}
        </button>
      ))}
      <button
        onClick={() => onEmote(null)}
        aria-label={t.stop}
        title={`${t.stop} [G]`}
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/10"
      >
        <Square className="size-3.5" />
      </button>
    </div>
  );
}

/** The touch stick (bottom left, above the dance bar), shown on touch screens only. Writes `stick`; the scene reads it every frame. */
export function Joystick() {
  const [touch] = useState(
    () =>
      typeof matchMedia !== "undefined" &&
      matchMedia("(pointer: coarse)").matches,
  );
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const base = useRef<HTMLDivElement>(null);
  const id = useRef<number | null>(null);
  useEffect(
    () => () => {
      stick.x = stick.y = 0;
    },
    [],
  );
  if (!touch) return null;
  const R = 52;
  const move = (e: React.PointerEvent) => {
    if (id.current !== e.pointerId) return;
    const b = base.current!.getBoundingClientRect();
    let x = e.clientX - (b.left + b.width / 2);
    let y = e.clientY - (b.top + b.height / 2);
    const d = Math.hypot(x, y);
    if (d > R) [x, y] = [(x / d) * R, (y / d) * R];
    setKnob({ x, y });
    stick.x = x / R;
    stick.y = -y / R;
  };
  const end = (e: React.PointerEvent) => {
    if (id.current !== e.pointerId) return;
    id.current = null;
    setKnob({ x: 0, y: 0 });
    stick.x = stick.y = 0;
  };
  return (
    <div
      ref={base}
      aria-hidden
      className="glass fixed bottom-32 left-4 z-30 size-28 touch-none rounded-full"
      onPointerDown={(e) => {
        id.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div
        className="gold absolute top-1/2 left-1/2 size-12 rounded-full"
        style={{
          transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
        }}
      />
    </div>
  );
}
