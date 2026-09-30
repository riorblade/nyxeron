import type { GameState } from "@nyxeron/core";

/**
 * Snapshots of the host's club, gzipped with the browser's own CompressionStream (no library). A full night with
 * hundreds of guests is ~100 KB of JSON and ~10–15 KB compressed.
 */
async function pipe(
  data: Uint8Array<ArrayBuffer>,
  t: CompressionStream | DecompressionStream,
) {
  const out = new Response(new Blob([data]).stream().pipeThrough(t));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (b: Uint8Array<ArrayBuffer>) =>
  pipe(b, new CompressionStream("gzip"));
export const gunzip = (b: Uint8Array<ArrayBuffer>) =>
  pipe(b, new DecompressionStream("gzip"));

const enc = new TextEncoder();
const dec = new TextDecoder();

/** What players need to render and trade in the club: the state minus the host's private history. */
export function publicState(s: GameState): GameState {
  return { ...s, log: s.log.slice(-40) };
}

export async function packState(s: GameState) {
  return gzip(enc.encode(JSON.stringify(publicState(s))));
}

export async function unpackState(b: Uint8Array): Promise<GameState> {
  return JSON.parse(dec.decode(await gunzip(new Uint8Array(b)))) as GameState;
}
