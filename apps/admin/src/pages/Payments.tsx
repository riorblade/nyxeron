import { payments, tokens, type TokenId } from "@nyxeron/core";
import { RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, fmt, when, type Payments as Data } from "../api";
import {
  Badge,
  Empty,
  Err,
  Kpi,
  Section,
  Table,
  Title,
  useLoad,
} from "../ui/kit";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const short = (s: string) =>
  s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
const ticker = (t: string) => tokens[t as TokenId]?.ticker ?? t.toUpperCase();
const bscscan = (tx: string) => `https://bscscan.com/tx/${tx}`;
const bscBlock = (n: number) => `https://bscscan.com/block/${n}`;
const stable = (addr: string) =>
  Object.entries(payments.topup.tokens).find(
    ([, a]) => a.toLowerCase() === addr.toLowerCase(),
  )?.[0] ?? short(addr);
const player = (id: string) => (
  <a className="hover:underline" href={`#/users/${encodeURIComponent(id)}`}>
    {short(id)}
  </a>
);

/**
 * Real money: is it backed (the hourly reconciliation against BNB Chain), the top-ups that came in (unknown senders
 * included: money that reached the Agentic Wallet without a player behind it), and party / shop sales (held sales
 * can be voided).
 */
export function Payments({ canEdit }: { canEdit: boolean }) {
  const { data, error, reload } = useLoad(
    () => api<Data>("GET", "/admin/payments"),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [openedAt] = useState(() => Math.floor(Date.now() / 1000));
  if (!data) return <Err>{error}</Err>;
  const last = data.reconciliations[0];
  // The check runs hourly: older than 2 h means BNB Chain couldn't be read since (the status may be out of date).
  const stale = !!last && openedAt - last.at > 2 * 3600;
  const unknown = data.topups.filter((t) => t.status === "unknown");
  const owedBack = data.topups.filter(
    (t) => t.refundCents > 0 && !t.refundedAt,
  );

  const run = async () => {
    const reason = prompt(
      "Why check now? (goes to the audit log; a match resumes payments)",
    )?.trim();
    if (!reason) return;
    setBusy(true);
    setMsg("");
    try {
      await api("POST", "/admin/reconcile", { reason });
      reload();
    } catch (e) {
      setMsg(
        (e as Error).message === "not_configured"
          ? "BNB Chain isn't configured on the api (BSC_RPC_1/2)."
          : "BNB Chain can't be read right now. Nothing changed; try again soon.",
      );
    } finally {
      setBusy(false);
    }
  };
  const refunded = async (tx: string, logIndex: number) => {
    const reason = prompt(
      "Paid back to the sender? Say how (the refund tx; goes to the audit log). Reconciliation stops counting it as owed.",
    )?.trim();
    if (!reason) return;
    try {
      await api("POST", "/admin/topups/refund", { tx, logIndex, reason });
      reload();
    } catch (e) {
      setMsg(`Couldn't mark ${short(tx)} refunded: ${(e as Error).message}`);
    }
  };
  const resolve = async (r: Data["scanRetries"][number]) => {
    const reason = prompt(
      "Checked it on BscScan? Say what you did (credited, refunded, nothing to do; goes to the audit log). It is no longer read again.",
    )?.trim();
    if (!reason) return;
    try {
      await api("POST", "/admin/scan-retries/resolve", {
        kind: r.kind,
        ref: r.ref,
        block: r.block,
        reason,
      });
      reload();
    } catch (e) {
      setMsg(`Couldn't resolve block ${r.block}: ${(e as Error).message}`);
    }
  };
  const voidSale = async (id: number) => {
    const reason = prompt(
      "Why void this sale? (goes to the audit log)",
    )?.trim();
    if (!reason) return;
    try {
      await api("POST", `/admin/sales/${id}/void`, { reason });
      reload();
    } catch (e) {
      setMsg(`Couldn't void sale ${id}: ${(e as Error).message}`);
    }
  };

  return (
    <>
      <Title sub="Credits are real money (100 = $1) and units are real stock (0.001 share): every hour the api checks both against the Agentic Wallet on BNB Chain.">
        Payments
      </Title>

      {data.paused && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-white/40 bg-white/[0.08] p-4"
        >
          <div className="font-medium">Payments are paused</div>
          <p className="text-sm text-white/70">
            The last reconciliation didn&apos;t match, so top-ups, sales and
            restocks are refused until one does.
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {data.paused.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Owed to players"
          value={last ? usd(last.owedCents) : "—"}
          note={
            last?.refundCents
              ? `credits, held included; + ${usd(last.refundCents)} owed back to senders`
              : "credits, held included"
          }
        />
        <Kpi
          label="USDC + USDT in the wallet"
          value={last ? usd(last.walletCents) : "—"}
          note="read from BNB Chain"
        />
        <Kpi
          label="Platform's own"
          value={last ? usd(last.platformCents) : "—"}
          note="fees, wholesale, restocks"
        />
        <Kpi
          label={stale ? "Last check (stale)" : "Last check"}
          value={last ? (last.ok ? "Backed" : "Short") : "—"}
          note={last ? when(last.at) : "not run yet"}
        />
      </div>

      <Section title="Reconciliation">
        {canEdit && (
          <button
            className="btn mb-3"
            disabled={busy}
            onClick={() => void run()}
          >
            <RefreshCw className="size-4" /> {busy ? "Checking…" : "Check now"}
          </button>
        )}
        {msg && (
          <p role="status" className="mb-3 text-sm text-white/80">
            {msg}
          </p>
        )}
        {data.reconciliations.length ? (
          <Table
            head={[
              "When",
              "Result",
              "Owed",
              "Wallet − platform",
              "Units counted / on chain",
              "Problems",
            ]}
          >
            {data.reconciliations.map((r, i) => (
              <tr key={i}>
                <td className="whitespace-nowrap text-white/60">
                  {when(r.at)}
                </td>
                <td>{r.ok ? "Backed" : <Badge>short</Badge>}</td>
                <td className="font-mono tabular-nums">
                  {usd(r.owedCents)}
                  {r.refundCents ? (
                    <div className="text-xs text-white/60">
                      + {usd(r.refundCents)} to refund
                    </div>
                  ) : null}
                </td>
                <td className="font-mono tabular-nums">
                  {usd(r.walletCents - r.platformCents)}
                </td>
                <td className="font-mono text-xs">
                  {Object.entries(r.units ?? {}).map(([t, u]) => (
                    <div key={t}>
                      {ticker(t)} {fmt(u.counted)} / {fmt(u.onChain)}
                    </div>
                  ))}
                </td>
                <td className="text-xs text-white/70">
                  {r.problems?.join("; ") || "—"}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>
            No check yet: it runs every hour once BNB Chain is configured.
          </Empty>
        )}
      </Section>

      {canEdit && (
        <Seed
          done={(m) => {
            setMsg(m);
            reload();
          }}
        />
      )}

      <Section title={`Unknown transfers (${unknown.length})`} className="mt-4">
        {unknown.length ? (
          <p className="mb-2 text-sm text-white/60">
            USDC/USDT that reached the Agentic Wallet from a wallet that is no
            player&apos;s. No credits were given; refund them by hand (or book
            them as the seed). Until then they count as owed, not as backing.
          </p>
        ) : (
          <Empty>None: every top-up came from a player&apos;s wallet.</Empty>
        )}
      </Section>

      <Section
        title={`Unread on chain (${data.scanRetries?.length ?? 0})`}
        className="mt-4"
      >
        {data.scanRetries?.length ? (
          <>
            <p className="mb-2 text-sm text-white/60">
              Blocks or receipts the top-up scanner couldn&apos;t read (both
              providers refused them) and moved past. Open ones are read again:
              blocks for about 4 hours, players&apos; receipts for about 2 days;
              players&apos; own reports still credit their deposits. Given up:
              check the block on BscScan, credit or refund by hand, then Resolve
              it (with what you did). Wallet payouts: until they read, unknown
              senders&apos; transfers in those blocks may be a swap&apos;s
              change and can&apos;t be marked refunded.
            </p>
            <Table
              head={[
                "Block",
                "What",
                "Status",
                "Reads",
                "Last read",
                "Why",
                ...(canEdit ? [""] : []),
              ]}
            >
              {data.scanRetries.map((r) => (
                <tr key={`${r.kind}-${r.ref}-${r.block}`}>
                  <td className="font-mono text-xs">
                    <a
                      className="hover:underline"
                      href={bscBlock(r.block)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {r.block}
                    </a>
                  </td>
                  <td className="font-mono text-xs">
                    {r.kind === "logs" ? (
                      `${stable(r.ref)} transfers`
                    ) : r.kind === "payouts" ? (
                      `wallet payouts, blocks ${r.block}–${r.ref}`
                    ) : (
                      <a
                        className="hover:underline"
                        href={bscscan(r.ref)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        receipt {short(r.ref)}
                      </a>
                    )}
                  </td>
                  <td>
                    {r.status === "open" ? "retrying" : <Badge>given up</Badge>}
                  </td>
                  <td className="font-mono tabular-nums">{r.attempts}</td>
                  <td className="whitespace-nowrap text-white/60">
                    {when(r.updatedAt)}
                  </td>
                  <td className="text-xs text-white/70">{r.reason}</td>
                  {canEdit && (
                    <td>
                      <button
                        className="btn h-8 text-xs"
                        onClick={() => void resolve(r)}
                        aria-label={`Resolve block ${r.block}`}
                      >
                        Resolve
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </Table>
          </>
        ) : (
          <Empty>None: the scanner read every block.</Empty>
        )}
      </Section>

      <Section title="Top-ups (last 200)" className="mt-4">
        {owedBack.length > 0 && (
          <p className="mb-2 text-sm text-white/60">
            {owedBack.length} shown here still owe money back to their sender.
            Reconciliation counts it as owed until you mark it refunded.
          </p>
        )}
        {data.topups.length ? (
          <Table
            head={[
              "When",
              "Player",
              "Amount",
              "Fee",
              "Credits",
              "Status",
              "Owed back",
              "Tx",
            ]}
          >
            {data.topups.map((t) => (
              <tr key={`${t.tx}-${t.logIndex}`}>
                <td className="whitespace-nowrap text-white/60">
                  {when(t.at)}
                </td>
                <td>
                  {t.userId ? (
                    t.email || player(t.userId)
                  ) : (
                    <span title={t.sender}>{short(t.sender)}</span>
                  )}
                </td>
                <td className="font-mono tabular-nums">{usd(t.usdCents)}</td>
                <td className="font-mono tabular-nums">{usd(t.fee)}</td>
                <td className="font-mono tabular-nums">{fmt(t.credits)}</td>
                <td>
                  {t.status === "credited" ? (
                    "credited"
                  ) : (
                    <Badge>{t.status}</Badge>
                  )}
                  {t.reason ? (
                    <div className="max-w-64 text-xs text-white/60">
                      {t.reason}
                    </div>
                  ) : null}
                </td>
                <td className="font-mono text-xs tabular-nums">
                  {t.refundCents > 0 ? (
                    t.refundedAt ? (
                      <span className="text-white/60">
                        {usd(t.refundCents)} refunded
                      </span>
                    ) : (
                      <>
                        {usd(t.refundCents)}
                        {canEdit && (
                          <button
                            className="btn ml-2 h-8 text-xs"
                            onClick={() => void refunded(t.tx, t.logIndex)}
                            aria-label={`Mark ${t.tx} refunded`}
                          >
                            Refunded
                          </button>
                        )}
                      </>
                    )
                  ) : (
                    "—"
                  )}
                </td>
                <td className="font-mono text-xs">
                  <a
                    className="hover:underline"
                    href={bscscan(t.tx)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {short(t.tx)}
                  </a>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No top-ups yet.</Empty>
        )}
      </Section>

      <Section title="Sales (last 200)" className="mt-4">
        {data.sales.length ? (
          <Table
            head={[
              "When",
              "Where",
              "Buyer",
              "CEO",
              "Units",
              "Price / wholesale",
              "Status",
              ...(canEdit ? [""] : []),
            ]}
          >
            {data.sales.map((x) => (
              <tr key={x.id}>
                <td className="whitespace-nowrap text-white/60">
                  {when(x.createdAt)}
                </td>
                <td className="text-xs">
                  {x.partyId ? `Party ${x.partyId}` : `Shop ${x.leaseId}`}
                </td>
                <td>{player(x.buyer)}</td>
                <td>{player(x.seller)}</td>
                <td className="font-mono">
                  {fmt(x.qty)} {ticker(x.token)}
                </td>
                <td className="font-mono tabular-nums">
                  {fmt(x.price)} / {fmt(x.wholesale)}
                </td>
                <td>
                  {x.status === "settled" ? (
                    "settled"
                  ) : (
                    <Badge>{x.status}</Badge>
                  )}
                </td>
                {canEdit && (
                  <td className="text-right">
                    {x.status === "held" && (
                      <button
                        className="btn h-8 text-xs"
                        onClick={() => void voidSale(x.id)}
                        aria-label={`Void sale ${x.id}`}
                      >
                        Void
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No sales yet.</Empty>
        )}
      </Section>
    </>
  );
}

/** Book USDC/USDT the team sent to the Agentic Wallet as the platform's own money (the api reads the tx). */
function Seed({ done }: { done: (msg: string) => void }) {
  const [tx, setTx] = useState("");
  const [reason, setReason] = useState("Seed for the first stock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const errors: Record<string, string> = {
    pending:
      "Not final yet on BNB Chain (15 confirmations). Try again in a minute.",
    tx_used: "This seed is already booked.",
    not_a_restock:
      "No USDC/USDT reached the Agentic Wallet in that transaction.",
    credited_to_a_player:
      "That transfer was a player's top-up: it backs their Credit (or is owed back to them).",
    not_a_seed:
      "The Agentic Wallet sent tokens out in that transaction: it's a swap, report it on the Stock page.",
    not_configured: "BNB Chain isn't configured on the api (BSC_RPC_1/2).",
    bad_request: "Check the tx hash and give a reason.",
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const got = await api<{ usdCents?: number; error?: string }>(
        "POST",
        "/admin/seed",
        { tx: tx.trim(), reason },
      );
      if (got.error) setError(errors[got.error] ?? got.error);
      else {
        setTx("");
        done(`✓ Booked ${usd(got.usdCents ?? 0)} as the platform's seed`);
      }
    } catch (err) {
      const code = (err as Error).message;
      setError(errors[code] ?? code);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Book a seed" className="mt-4">
      <p className="mb-2 text-sm text-white/60">
        Money the team sends to the Agentic Wallet to buy the first stock is the
        platform&apos;s, not a player&apos;s. Paste its tx: the api reads it on
        BNB Chain and books it.
      </p>
      <form
        className="grid gap-2 md:grid-cols-[1fr_1fr_auto]"
        onSubmit={submit}
      >
        <input
          className="field font-mono"
          placeholder="Transfer tx (0x…)"
          aria-label="Seed transfer tx"
          value={tx}
          onChange={(e) => setTx(e.target.value)}
          required
        />
        <input
          className="field"
          placeholder="Reason (audit log)"
          aria-label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
        <button
          className="btn btn-primary"
          disabled={busy || !tx.trim() || !reason.trim()}
        >
          {busy ? "Checking…" : "Book seed"}
        </button>
      </form>
      <Err>{error}</Err>
    </Section>
  );
}
