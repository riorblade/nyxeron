import { createEvent, runNight, scenarios } from "@nyxeron/core";
import { describe, expect, it } from "vitest";
import { packState, unpackState } from "./codec";

describe("snapshot codec", () => {
  it("round-trips a full club night and compresses it well", async () => {
    const s = createEvent(scenarios.events[2]!, 3);
    const packed = await packState(s);
    const back = await unpackState(packed);
    expect(back.night!.guests.length).toBe(s.night!.guests.length);
    expect(back.clubName).toBe(s.clubName);
    expect(packed.length).toBeLessThan(JSON.stringify(s).length / 4);
  });
  it("keeps only the recent log", async () => {
    const s = runNight(createEvent(scenarios.events[1]!, 4));
    const back = await unpackState(await packState(s));
    expect(back.log.length).toBeLessThanOrEqual(40);
  });
});
