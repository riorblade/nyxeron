/**
 * Host: which relay connection is which visitor in the club. A reconnecting player comes back with a new relay
 * id; the secret key from their hello (sent only to the host) gets them their own visitor back (cash, tokens).
 */
export class Seats {
  private byPeer = new Map<number, string>();
  private byKey = new Map<string, string>();

  /** A new visitor in the club, playing from this connection. */
  seat(peer: number, v: string, key: string) {
    this.bind(peer, v);
    if (key) this.byKey.set(key, v);
  }
  /** The visitor this key was given, if any. */
  held(key: string) {
    return key ? this.byKey.get(key) : undefined;
  }
  /** The visitor now plays from this connection (an old, maybe half-dead one lets go). */
  bind(peer: number, v: string) {
    for (const [p, x] of this.byPeer) if (x === v) this.byPeer.delete(p);
    this.byPeer.set(peer, v);
  }
  of(peer: number) {
    return this.byPeer.get(peer);
  }
  /** The connection is gone: its visitor, if it had one. */
  drop(peer: number) {
    const v = this.byPeer.get(peer);
    this.byPeer.delete(peer);
    return v;
  }
  clear() {
    this.byPeer.clear();
    this.byKey.clear();
  }
}
