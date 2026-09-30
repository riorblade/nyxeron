/** Manual pyro cues from the HUD to the 3D venue (which owns the effects), without prop-drilling the scene. */
export type PyroCue = "fire" | "fog" | "both";
const EVENT = "nyx:pyro";

export const firePyro = (cue: PyroCue) =>
  window.dispatchEvent(new CustomEvent<PyroCue>(EVENT, { detail: cue }));

export function onPyro(fn: (cue: PyroCue) => void) {
  const h = (e: Event) => fn((e as CustomEvent<PyroCue>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
