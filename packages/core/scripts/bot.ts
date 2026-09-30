import { aiPrepare, nextDay, runNight, type GameState } from "../src";

/** A sensible (not optimal) player: the AI CEO's day, then the night. */
export const botDay = (s: GameState): GameState =>
  nextDay(runNight(aiPrepare(s)));
