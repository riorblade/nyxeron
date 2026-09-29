import { createGameState, runNight } from "@nyxeron/core";
import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "./save";

describe("save", () => {
  it("round-trips a mid-game state exactly", () => {
    const s = runNight(createGameState(9));
    expect(deserialize(serialize(s, 1))).toEqual({
      v: 1,
      savedAt: 1,
      state: s,
    });
  });
  it("rejects garbage, empty and old-version saves", () => {
    expect(deserialize(null)).toBeNull();
    expect(deserialize("{not json")).toBeNull();
    expect(
      deserialize(
        JSON.stringify({ v: 0, savedAt: 1, state: createGameState(1) }),
      ),
    ).toBeNull();
  });
});
