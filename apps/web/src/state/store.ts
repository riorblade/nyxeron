import {
  createBasement,
  createEvent,
  createGig,
  visitorJoin,
  type EventSpec,
  createSandbox,
  createGameState,
  type ActionResult,
  type Difficulty,
  type Level,
  type GameState,
} from "@nyxeron/core";
import { create } from "zustand";
import { en, reasonText } from "@/i18n/en";
import { useProfile } from "@/state/profile";
import { fetchQuotes } from "@/api/quotes";
import { writeSave } from "@/state/save";

/** menu = landing page, dashboard = the player's hub (pick a role), guest = partying at an AI-hosted event. */
export type Screen =
  | "menu"
  | "dashboard"
  | "setup"
  | "game"
  | "over"
  | "guest"
  | "studio"
  | "gig"
  | "live"
  | "livedj";
type NewGame =
  | { mode: "basement" }
  | { mode: "sandbox" }
  | {
      mode: "career";
      name: string;
      genre: string;
      difficulty: Difficulty;
      level?: Level;
    };

interface Store {
  screen: Screen;
  game: GameState | null;
  /** How the current game was created, so Retry can start it again. */
  origin: NewGame | null;
  paused: boolean;
  running: boolean;
  /** At night: looking at the club floor, stepped back into the office, or rearranging furniture (the clock waits for both). */
  view: "venue" | "office" | "edit";
  setView(v: "venue" | "office" | "edit"): void;
  speed: 1 | 2 | 3;
  toast: { id: number; text: string; error: boolean } | null;

  go(screen: Screen): void;
  /** Back to the landing page from anywhere; an unfinished game is autosaved so Continue resumes it. */
  home(): void;
  /** Open Club intro video is playing (the night clock waits for it). */
  intro: boolean;
  setIntro(on: boolean): void;
  start(g: NewGame): void;
  /** The DJ gig being played (fee paid at 04:00). */
  gig: { fee: number } | null;
  /** Accept a DJ invite: the club's night opens at the DJ slot with the player on the decks. */
  joinGig(spec: EventSpec): void;
  /** Walk into an event as a guest, bringing the whole wallet. */
  joinEvent(spec: EventSpec): Promise<void>;
  load(state: GameState): void;
  set(game: GameState): void;
  /** Runs a player action; on failure shows the reason ("Not enough Coin: 1,200 short"). */
  act(fn: (s: GameState) => ActionResult): boolean;
  notify(text: string, error?: boolean): void;
  setPaused(p: boolean): void;
  setRunning(r: boolean): void;
  setSpeed(s: 1 | 2 | 3): void;
}

const newSeed = () => (Math.random() * 2 ** 32) >>> 0;

export const useGame = create<Store>((set, get) => ({
  // An invite link (…/?join=CODE) skips the landing page: straight to the dashboard's join form.
  screen:
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).has("join")
      ? "dashboard"
      : "menu",
  game: null,
  origin: null,
  paused: false,
  running: true,
  view: "venue",
  setView: (view) => set({ view }),
  speed: 1,
  toast: null,

  go: (screen) => set({ screen, paused: false }),
  home: () => {
    const { game, screen } = get();
    if (game && screen === "game" && !game.outcome && writeSave("auto", game))
      get().notify(en.nav.saved);
    set({ screen: "dashboard", paused: false, intro: false });
  },
  intro: false,
  setIntro: (intro) => set({ intro }),
  start: (g) =>
    set({
      origin: g,
      screen: "game",
      paused: false,
      running: true,
      game:
        g.mode === "basement"
          ? createBasement(newSeed())
          : g.mode === "sandbox"
            ? createSandbox(newSeed())
            : createGameState(newSeed(), g.genre, {
                clubName: g.name,
                difficulty: g.difficulty,
                level: g.level,
              }),
    }),
  gig: null,
  joinGig: (spec) =>
    set({
      game: createGig(spec, newSeed()),
      gig: { fee: ("djFee" in spec && spec.djFee) || 0 },
      origin: null,
      screen: "gig",
      paused: false,
      running: true,
      speed: 1,
      intro: false,
      view: "venue",
    }),
  joinEvent: async (spec) => {
    // The AI CEO stocks up at tonight's real spot prices.
    const quotes = await fetchQuotes();
    const { name, wallet, avatar } = useProfile.getState();
    const r = visitorJoin(
      createEvent(spec, newSeed(), quotes),
      "me",
      name || en.dashboard.anon,
      wallet,
      avatar,
    );
    if (!r.ok) return get().notify(reasonText(r.reason, r.short), true);
    set({
      game: r.state,
      origin: null,
      screen: "guest",
      paused: false,
      running: true,
      speed: 1,
      intro: false,
      view: "venue",
    });
  },
  load: (state) =>
    set({
      game: state,
      screen: state.outcome ? "over" : "game",
      paused: false,
      origin: null,
    }),
  set: (game) => {
    const prev = get().game;
    // Autosave after every Night Report.
    if (game.phase === "report" && prev?.phase === "night")
      writeSave("auto", game);
    // Every new night starts on the club floor.
    set(
      game.phase === "night" && prev?.phase !== "night"
        ? { game, view: "venue" }
        : { game },
    );
  },
  act: (fn) => {
    const g = get().game;
    if (!g) return false;
    const r = fn(g);
    if (r.ok) get().set(r.state);
    else get().notify(reasonText(r.reason, r.short), true);
    return r.ok;
  },
  notify: (text, error = false) =>
    set({ toast: { id: Date.now(), text, error } }),
  setPaused: (paused) => set({ paused }),
  setRunning: (running) => set({ running }),
  setSpeed: (speed) => set({ speed }),
}));

// Dev-only handle for automated browser checks (e.g. triggering an escort); stripped from production builds.
if (import.meta.env.DEV)
  (window as unknown as { __game: typeof useGame }).__game = useGame;
