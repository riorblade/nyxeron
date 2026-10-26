import type { TokenId, GameState } from "@nyxeron/core";
import { RotateCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TokenDetail } from "@/hud/TokenDetail";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { useSettings } from "@/state/settings";
import { useGame } from "@/state/store";
import { KINDS } from "./furniture";
import { onPyro } from "./pyro";
import { sendRoam, shareShow, useNet } from "@/net/session";
import type { CamMode } from "@/avatar/camera";
import type { Dance } from "@/avatar/moves";
import { VenueScene } from "./scene3d";

type Steer = { cam: CamMode; emote: Dance | null };

/** Guest screens: the player walks their avatar, dances what they pick, and picks the camera. */
function applySteer(v: VenueScene, st: Steer | undefined) {
  v.setControl(!!st);
  if (st) {
    v.setCameraMode(st.cam);
    v.setEmote(st.emote);
  }
  v.onRoam = st ? sendRoam : undefined;
}

export function VenueView({
  s,
  editing = false,
  active = true,
  cinematic = false,
  onCinematicEnd,
  onDone,
  guestDj,
  me = "me",
  steer,
}: {
  /** Guest screens: the player walks their avatar, dances what they pick, and picks the camera. */
  steer?: Steer;
  s: GameState;
  /** Which visitor is this browser's player (online: their relay id). */
  me?: string;
  /** Gig mode: the player at the decks (their avatar and name). */
  guestDj?: { name: string; avatar: number };
  editing?: boolean;
  /** false while another screen covers the venue: rendering pauses. */
  active?: boolean;
  /** Auto camera (Night's C key); ends itself when the player grabs the camera. */
  cinematic?: boolean;
  onCinematicEnd?: () => void;
  onDone?: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const r = useRef<VenueScene | null>(null);
  const [selected, setSelected] = useState(-1);
  const [noGl, setNoGl] = useState(false);
  // The scene loads async (after the first effects ran), so init reads the latest guest DJ from here.
  const guestRef = useRef<{ name: string; avatar: number } | null>(null);
  const meRef = useRef("me");
  // Steering: the latest settings live in a ref, so the scene picks them up when it finishes loading too.
  const steerRef = useRef<Steer | undefined>(undefined);
  const [drink, setDrink] = useState<TokenId | null>(null);
  const clips = useSettings((x) => x.clips);
  const ads = useSettings((x) => x.ads);
  const pyroMode = useSettings((x) => x.pyro);
  // In someone else's live club (guest or DJ), the show is the host's: no pyro of our own.
  const following = useNet((n) => n.role === "guest" || n.role === "dj");

  useEffect(() => {
    let cancelled = false;
    const v = new VenueScene();
    v.onSelect = setSelected;
    v.onTokenClick = setDrink;
    v.onBurst = (cue) => shareShow({ t: "fx", cue });
    v.init(el.current!)
      .then(() => {
        // StrictMode mounts twice; a renderer torn down before init finished must not become current.
        if (cancelled) return;
        r.current = v;
        const { clips, ads, pyro } = useSettings.getState();
        v.setScreenPrefs({ clips, ads });
        const n = useNet.getState().role;
        v.setPyroAuto(pyro === "auto" && n !== "guest" && n !== "dj");
        v.setGuestDj(guestRef.current ?? null);
        v.setMe(meRef.current);
        applySteer(v, steerRef.current);
        v.setRemoteRoams(useNet.getState().roams);
        const g = useGame.getState().game;
        if (g) v.update(g);
      })
      .catch((e: unknown) => {
        // No WebGL (hardware acceleration off, an old GPU, some VMs): the night still runs on the panels, so say
        // why the room is empty instead of failing silently.
        if (cancelled) return;
        console.warn("venue: 3D view unavailable", e);
        setNoGl(true);
      });
    return () => {
      cancelled = true;
      r.current = null;
      v.destroy();
    };
  }, []);

  useEffect(() => {
    r.current?.update(s);
  }, [s]);

  useEffect(() => {
    r.current?.setActive(active);
  }, [active]);

  useEffect(() => {
    const v = r.current;
    if (!v) return;
    v.onCinematicEnd = onCinematicEnd;
    v.setCinematic(cinematic);
  }, [cinematic, onCinematicEnd]);

  useEffect(() => {
    r.current?.setScreenPrefs({ clips, ads });
  }, [clips, ads]);

  useEffect(() => {
    r.current?.setPyroAuto(pyroMode === "auto" && !following);
  }, [pyroMode, following]);
  useEffect(() => {
    meRef.current = me;
    r.current?.setMe(me);
  }, [me]);
  const roams = useNet((n) => n.roams);
  const cam = steer?.cam;
  const emote = steer?.emote ?? null;
  const steering = !!steer;
  useEffect(() => {
    const st = steering && cam ? { cam, emote } : undefined;
    steerRef.current = st;
    if (r.current) applySteer(r.current, st);
  }, [steering, cam, emote]);
  useEffect(() => {
    r.current?.setRemoteRoams(roams);
  }, [roams]);
  const gName = guestDj?.name;
  const gAvatar = guestDj?.avatar;
  useEffect(() => {
    guestRef.current = gName ? { name: gName, avatar: gAvatar ?? 1 } : null;
    r.current?.setGuestDj(guestRef.current);
  }, [gName, gAvatar]);
  useEffect(() => onPyro((cue) => r.current?.pyro(cue)), []);

  useEffect(() => {
    r.current?.setEditing(editing);
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "r") r.current?.rotateSelected();
      else if (k === "delete" || k === "backspace") r.current?.deleteSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, s.level]);

  const btn =
    "flex h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs hover:bg-white/10 disabled:opacity-35";

  return (
    <>
      <div ref={el} className="absolute inset-0" />
      {noGl && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center p-6 text-center"
        >
          <p className="glass max-w-sm rounded-xl p-4 text-sm text-white/70">
            {en.night.noWebgl}
          </p>
        </div>
      )}
      {drink && <TokenDetail s={s} id={drink} onClose={() => setDrink(null)} />}
      {editing && (
        <div className="glass enter absolute inset-x-3 bottom-3 z-20 flex max-h-[45dvh] flex-col gap-2 overflow-y-auto rounded-xl p-3 lg:inset-x-auto lg:left-1/2 lg:-translate-x-1/2">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
            <h2 className="text-[10px] tracking-[0.3em] text-white/60 uppercase">
              {en.editor.title}
            </h2>
            <span className="hidden text-[11px] text-white/60 md:inline">
              {en.editor.hint}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 whitespace-nowrap lg:flex-nowrap">
            <span className="mr-1 text-[10px] tracking-[0.2em] text-white/60 uppercase">
              {en.editor.add}
            </span>
            {KINDS.map((k) => (
              <button
                key={k}
                className={btn}
                onClick={() => r.current?.addFurniture(k)}
              >
                + {en.editor.kinds[k]}
              </button>
            ))}
            <span className="mx-1 h-6 w-px bg-white/15" />
            <button
              className={btn}
              disabled={selected < 0}
              onClick={() => r.current?.rotateSelected()}
            >
              <RotateCw className="size-3.5" /> {en.editor.rotate}
            </button>
            <button
              className={btn}
              disabled={selected < 0}
              onClick={() => r.current?.deleteSelected()}
            >
              <Trash2 className="size-3.5" /> {en.editor.remove}
            </button>
            <button className={btn} onClick={() => r.current?.resetFurniture()}>
              {en.editor.reset}
            </button>
            <button
              className={cn(
                btn,
                "border-white bg-white font-semibold text-black hover:bg-white/85",
              )}
              onClick={onDone}
            >
              {en.editor.done}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
