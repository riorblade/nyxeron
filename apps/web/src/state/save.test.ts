import { compactForSave, createGameState, runNight } from "@nyxeron/core";
import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "@/state/save";

describe("save", () => {
  it("round-trips a game exactly (in its compact save form)", () => {
    const s = runNight(createGameState(9));
    // At the report the night is dropped (packages/core test: the game plays on identically).
    expect(deserialize(serialize(s, 1))).toEqual({
      v: 1,
      savedAt: 1,
      state: compactForSave(s),
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
