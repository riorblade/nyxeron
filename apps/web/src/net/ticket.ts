import { call, online } from "@/api/player";
import { useAccount } from "@/auth/account";

/** Whose ticket, and until when (local clock) it's used: the api issues 10 minutes, the client keeps 9. */
let cached: { who: string; ticket: string; until: number } | null = null;

/** Forget the ticket (the relay refused it): the next one is fetched from the api. */
export function dropTicket() {
  cached = null;
}

/**
 * The api's pass for the multiplayer relay: proves this browser is a signed-in, unbanned player (the relay keys
 * limits and kicks by account). Kept for 9 minutes and only for the account it was issued to; "" offline or when the
 * api issues none (the relay then decides: a dev relay lets anyone in, production refuses with bad_ticket).
 */
export async function relayTicket(fresh = false): Promise<string> {
  const who = useAccount.getState().account?.id ?? "";
  if (!online() || !who) return "";
  if (!fresh && cached?.who === who && cached.until > Date.now())
    return cached.ticket;
  try {
    const r = (await call("POST", "/relay/ticket")) as unknown as {
      ticket: string;
    };
    cached = { who, ticket: r.ticket, until: Date.now() + 9 * 60_000 };
    return r.ticket;
  } catch {
    cached = null;
    return "";
  }
}
