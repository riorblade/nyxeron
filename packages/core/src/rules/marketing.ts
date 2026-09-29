import { channels, legal, type ChannelId } from "../data";
import { fail, type ActionResult } from "../result";
import { createRng } from "../rng";
import { clamp, type GameState } from "../state";

/** R5: promo if coin ≥ cost and energy ≥ 1 → hype up; the channel's segment is boosted tonight. */
export function r05_promote(s: GameState, channel: ChannelId): ActionResult {
  const c = channels[channel];
  if (s.level < c.minLevel) return fail("levelLocked");
  if (s.activePromos.includes(channel)) return fail("alreadyActive");
  if (s.ceoEnergy < 1) return fail("notEnoughEnergy");
  if (s.coin < c.cost) return fail("notEnoughCoin", c.cost - s.coin);
  return {
    ok: true,
    state: {
      ...s,
      coin: s.coin - c.cost,
      ceoEnergy: s.ceoEnergy - 1,
      hype: clamp(s.hype + c.hype),
      activePromos: [...s.activePromos, channel],
      log: [
        ...s.log,
        { day: s.day, kind: "promoPosted", channel, hype: c.hype },
      ],
    },
  };
}

/** R17: controversial promo → hype +30, but 25% backfire: rep −20 and an inspection is guaranteed tonight. */
export function r17_controversialPromo(s: GameState): ActionResult {
  const p = legal.controversialPromo;
  if (s.ceoEnergy < 1) return fail("notEnoughEnergy");
  if (s.coin < p.cost) return fail("notEnoughCoin", p.cost - s.coin);
  const rng = createRng(s.seed);
  const backfired = rng.chance(p.backfireChance);
  return {
    ok: true,
    state: {
      ...s,
      seed: rng.seed,
      coin: s.coin - p.cost,
      ceoEnergy: s.ceoEnergy - 1,
      hype: clamp(s.hype + p.hype),
      reputation: backfired ? clamp(s.reputation - p.repPenalty) : s.reputation,
      forcedInspection: s.forcedInspection || backfired,
      log: [
        ...s.log,
        { day: s.day, kind: "controversialPromo", hype: p.hype, backfired },
      ],
    },
  };
}
