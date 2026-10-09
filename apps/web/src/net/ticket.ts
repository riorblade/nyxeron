import { call, online } from "@/api/player";

let cached: { ticket: string; exp: number } | null = null;

/**
 * The api's pass for the multiplayer relay: proves this browser is a signed-in, unbanned player (the relay keys
 * limits and kicks by account). Kept until a minute before it expires; "" offline or when the api issues none
 * (the relay then decides: a dev relay lets anyone in, production refuses with bad_ticket).
 */
export async function relayTicket(fresh = false): Promise<string> {
  if (!online()) return "";
  if (!fresh && cached && cached.exp * 1000 - Date.now() > 60_000)
    return cached.ticket;
  try {
    cached = (await call("POST", "/relay/ticket")) as unknown as {
      ticket: string;
      exp: number;
    };
    return cached.ticket;
  } catch {
    cached = null;
    return "";
  }
}
