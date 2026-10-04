import { payments, tokens, type TokenId } from "@nyxeron/core";
import { Info, PackagePlus } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { api, fmt, when, type Supply } from "../api";
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
import { cn } from "../ui/cn";

type Row = Supply["tokens"][number];
const name = (t: string) => tokens[t as TokenId]?.name ?? t;
const ticker = (t: string) => tokens[t as TokenId]?.ticker ?? t.toUpperCase();
// Tokens that may hold real stock (payments.json): a swap for anything else is refused.
const whitelisted = (t: string) => t in payments.tokens;

/**
 * The platform's warehouse. CEOs buy their shop stock from it, so an empty warehouse means no shop can restock.
 * Units come in only from a swap the api verified on BNB Chain: the stock agent reports its own, and here an
 * admin reports one by its tx. Typing a number can only take units out (a correction).
 */
export function Stock({ canEdit }: { canEdit: boolean }) {
  const { data, error, reload } = useLoad(
    () => api<Supply>("GET", "/admin/stock"),
    [],
  );
  const [open, setOpen] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  // The last change's confirmation (kept here: the empty-warehouse banner goes away once it's filled).
  const [notice, setNotice] = useState("");
  if (!data) return <Err>{error}</Err>;

  const total = data.tokens.reduce((n, r) => n + r.onHand, 0);
  const empty = data.tokens.filter((r) => r.onHand === 0).length;
  const sold7d = data.tokens.reduce((n, r) => n + r.sold7d, 0);

  return (
    <>
      <Title sub="Real stock the platform holds in the Agentic Wallet. Parties and shops sell from it; if a token is empty here, nobody can buy it.">
        Platform stock
      </Title>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi
          label="In the warehouse"
          value={fmt(total)}
          note="units, all tokens"
        />
        <Kpi
          label="Empty tokens"
          value={`${empty} / ${data.tokens.length}`}
          note="nobody can buy these"
        />
        <Kpi label="Sold to players" value={fmt(sold7d)} note="last 7 days" />
      </div>

      {empty > 0 && (
        <div className="mb-4 rounded-xl border border-white/30 bg-white/[0.05] p-4">
          <div className="font-medium">
            {empty === data.tokens.length
              ? "The warehouse is empty"
              : `${empty} tokens are empty`}
          </div>
          <p className="text-sm text-white/60">
            Stock is real bStock in the Agentic Wallet. Buy it with the wallet
            (or let the stock agent do it), then report the swap's tx on the
            token below: the api reads it on BNB Chain and adds the units it
            bought.
          </p>
        </div>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-white/80">
          {notice}
        </p>
      )}

      <Section title="Warehouse">
        <button
          className="mb-3 flex items-center gap-1.5 text-xs text-white/60 hover:text-white"
          onClick={() => setHelp((v) => !v)}
        >
          <Info className="size-3.5" />{" "}
          {help ? "Hide" : "What do these columns mean?"}
        </button>
        {help && (
          <dl className="mb-4 grid gap-x-6 gap-y-1.5 rounded-lg border border-white/10 p-3 text-xs text-white/70 sm:grid-cols-2">
            <Term k="In warehouse">
              Units the platform holds (0.001 share each); parties and shops
              sell from here.
            </Term>
            <Term k="Sold (24h / 7d)">
              Units players bought at parties and shops: this is demand.
            </Term>
            <Term k="Runs out in">
              Days the warehouse lasts at the last 7 days' pace (— = no demand
              yet).
            </Term>
            <Term k="Suggested">
              Top-up that keeps {data.coverDays} days of that demand in stock.
              The stock agent uses the same numbers.
            </Term>
          </dl>
        )}
        <Table
          head={[
            "Token",
            "In warehouse",
            "Sold 24h / 7d",
            "Runs out in",
            "Suggested",
            ...(canEdit ? [""] : []),
          ]}
        >
          {data.tokens.map((r) => (
            <TokenRow
              key={r.token}
              r={r}
              canEdit={canEdit}
              open={open === r.token}
              toggle={() => setOpen(open === r.token ? null : r.token)}
              done={(m) => {
                setNotice(m);
                setOpen(null);
                reload();
              }}
            />
          ))}
        </Table>
      </Section>

      <Section title="Movements (last 100)" className="mt-4">
        {data.moves.length ? (
          <Table
            head={[
              "When",
              "Token",
              "Change",
              "Kind",
              "By",
              "Reason",
              "On-chain tx",
            ]}
          >
            {data.moves.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-white/60">
                  {when(m.at)}
                </td>
                <td className="font-mono text-xs">{ticker(m.token)}</td>
                <td className="font-mono tabular-nums">
                  {m.delta > 0 ? "+" : "−"}
                  {fmt(Math.abs(m.delta))}
                </td>
                <td className="text-xs">
                  {m.kind === "sold"
                    ? "bought by a CEO"
                    : m.kind === "restock"
                      ? "restock"
                      : "correction"}
                </td>
                <td>
                  {m.userId ? (
                    <a
                      className="hover:underline"
                      href={`#/users/${encodeURIComponent(m.userId)}`}
                    >
                      CEO
                    </a>
                  ) : (
                    m.actor
                  )}
                </td>
                <td className="text-white/70">{m.reason || "—"}</td>
                <td
                  className="max-w-40 truncate font-mono text-xs text-white/60"
                  title={m.tx}
                >
                  {m.tx || "—"}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>
            Nothing yet. Restocks, corrections and CEO purchases show up here.
          </Empty>
        )}
      </Section>
    </>
  );
}

const Term = ({ k, children }: { k: string; children: ReactNode }) => (
  <div>
    <dt className="font-medium text-white">{k}</dt>
    <dd>{children}</dd>
  </div>
);

function TokenRow({
  r,
  canEdit,
  open,
  toggle,
  done,
}: {
  r: Row;
  canEdit: boolean;
  open: boolean;
  toggle: () => void;
  done: (msg: string) => void;
}) {
  const n = (v: number) => (
    <span className="font-mono tabular-nums">{fmt(v)}</span>
  );
  return (
    <>
      <tr className={cn(open && "bg-white/[0.04]")}>
        <td>
          <span className="font-mono text-xs">{ticker(r.token)}</span>{" "}
          <span className="text-white/75">{name(r.token)}</span>
        </td>
        <td>
          {n(r.onHand)} {r.onHand === 0 && <Badge>empty</Badge>}
          {r.reserved > 0 && (
            <span className="ml-1 text-xs text-white/50">
              · {fmt(r.reserved)} held
            </span>
          )}
        </td>
        <td>
          {n(r.sold24h)} <span className="text-white/40">/</span> {n(r.sold7d)}
        </td>
        <td className="font-mono tabular-nums">
          {r.daysLeft < 0 ? "—" : `${r.daysLeft.toFixed(1)} days`}
        </td>
        <td className="font-mono tabular-nums">
          {r.suggested ? `+${fmt(r.suggested)}` : "—"}
        </td>
        {canEdit && (
          <td className="text-right">
            <button
              className={cn("btn h-8 text-xs", open && "bg-white/10")}
              onClick={toggle}
            >
              {open ? (
                "Close"
              ) : (
                <>
                  <PackagePlus className="size-3.5" /> Restock
                </>
              )}
            </button>
          </td>
        )}
      </tr>
      {open && (
        <tr className="bg-white/[0.04]">
          <td colSpan={8}>
            <RestockForm r={r} done={done} />
          </td>
        </tr>
      )}
    </>
  );
}

const reasons: Record<string, string> = {
  pending:
    "Not final yet on BNB Chain (15 confirmations). Report it again in a minute.",
  tx_used: "This swap was already counted.",
  not_a_restock:
    "That transaction didn't bring this token's bStock into the Agentic Wallet.",
  over_limit: "The swap is over the agent's limits ($ per swap / per day).",
  not_configured: "BNB Chain isn't configured on the api (BSC_RPC_1/2).",
  chain_unavailable: "BNB Chain can't be read right now. Try again soon.",
  bad_request: "Check the tx hash (0x + 64 hex characters).",
  sold_out: "The warehouse doesn't have that many to remove.",
};

/** Report a swap for one token (units come from the chain), or take units out under "Correct a count". */
function RestockForm({ r, done }: { r: Row; done: (msg: string) => void }) {
  const real = whitelisted(r.token);
  const [remove, setRemove] = useState(!real);
  const [qty, setQty] = useState(0);
  const [reason, setReason] = useState(
    r.onHand === 0 ? "Initial stock" : "Restock",
  );
  const [tx, setTx] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (remove) {
        await api("PUT", `/admin/stock/${r.token}`, { delta: -qty, reason });
        done(`✓ Removed ${fmt(qty)} ${ticker(r.token)}`);
        return;
      }
      const got = await api<{ units?: number; error?: string }>(
        "PUT",
        `/admin/stock/${r.token}`,
        { tx: tx.trim(), reason },
      );
      if (got.error) setError(reasons[got.error] ?? got.error);
      else
        done(`✓ Added ${fmt(got.units ?? 0)} ${ticker(r.token)} from the swap`);
    } catch (err) {
      const code = (err as Error).message;
      setError(reasons[code] ?? code);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-3 py-2" onSubmit={submit}>
      {remove ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Remove</span>
          <input
            className="field h-8 w-28 font-mono"
            inputMode="numeric"
            aria-label="Units to remove"
            value={qty || ""}
            onChange={(e) => setQty(Number(e.target.value.replace(/\D/g, "")))}
          />
          <span className="text-sm text-white/60">
            units of {name(r.token)} → {fmt(Math.max(0, r.onHand - qty))} in the
            warehouse
          </span>
        </div>
      ) : (
        <p className="text-sm text-white/60">
          Paste the tx of a swap that bought {ticker(r.token)} into the Agentic
          Wallet. The units come from what the chain shows it received.
        </p>
      )}
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <input
          className="field"
          placeholder="Reason (goes to the audit log)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
        {!remove && (
          <input
            className="field font-mono"
            placeholder="Swap tx (0x…)"
            aria-label="Swap tx"
            value={tx}
            onChange={(e) => setTx(e.target.value)}
            required
          />
        )}
        <button
          className="btn btn-primary"
          disabled={busy || !reason.trim() || (remove ? !qty : !tx.trim())}
        >
          {busy
            ? "Checking…"
            : remove
              ? `Remove ${fmt(qty)} ${ticker(r.token)}`
              : "Report swap"}
        </button>
      </div>
      {real ? (
        <label className="flex items-center gap-2 text-xs text-white/55">
          <input
            type="checkbox"
            className="accent-white"
            checked={remove}
            onChange={(e) => setRemove(e.target.checked)}
          />
          Correct a count instead (remove units, e.g. after a miscount)
        </label>
      ) : (
        <p className="text-xs text-white/55">
          {ticker(r.token)} isn't in the paid economy yet: units can only be
          removed.
        </p>
      )}
      <Err>{error}</Err>
    </form>
  );
}
