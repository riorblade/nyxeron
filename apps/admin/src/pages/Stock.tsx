import { tokens, type TokenId } from "@nyxeron/core";
import { useState, type FormEvent } from "react";
import { api, fmt, when, type Supply } from "../api";
import { Badge, Empty, Err, Section, Table, Title, useLoad } from "../ui/kit";

/**
 * The platform's warehouse: CEOs stock their shops from it. Restocked by hand here, or by the stock agent
 * (POST /api/agent/restock with the on-chain purchase), which reads the same demand numbers.
 */
export function Stock({ canEdit }: { canEdit: boolean }) {
  const { data, error, reload } = useLoad(
    () => api<Supply>("GET", "/admin/stock"),
    [],
  );
  return (
    <>
      <Title
        sub={`CEOs buy shop stock from this warehouse. Suggested = what keeps ${data?.coverDays ?? 3} days of the last week's demand on hand.`}
      >
        Platform stock
      </Title>
      <Err>{error}</Err>
      {data && (
        <div className="flex flex-col gap-4">
          <Section title="Warehouse">
            <Table
              head={[
                "Token",
                "On hand",
                "With CEOs",
                "Sold 24h",
                "Sold 7d",
                "Shops",
                "Days left",
                "Suggested",
              ]}
            >
              {data.tokens.map((r) => (
                <tr key={r.token}>
                  <td>
                    <span className="font-mono text-xs">{r.ticker}</span>{" "}
                    <span className="text-white/70">
                      {tokens[r.token as TokenId]?.name}
                    </span>
                  </td>
                  <td className="font-mono tabular-nums">
                    {fmt(r.onHand)} {r.onHand === 0 && <Badge>sold out</Badge>}
                  </td>
                  <td className="font-mono tabular-nums">{fmt(r.inShops)}</td>
                  <td className="font-mono tabular-nums">{fmt(r.sold24h)}</td>
                  <td className="font-mono tabular-nums">{fmt(r.sold7d)}</td>
                  <td className="font-mono tabular-nums">{r.shops}</td>
                  <td className="font-mono tabular-nums">
                    {r.daysLeft < 0 ? "—" : r.daysLeft.toFixed(1)}
                  </td>
                  <td className="font-mono tabular-nums">
                    {r.suggested ? `+${fmt(r.suggested)}` : "—"}
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
          {canEdit && (
            <Adjust tokens={data.tokens.map((r) => r.token)} done={reload} />
          )}
          <Section title="Movements (last 100)">
            {data.moves.length ? (
              <Table
                head={["When", "Token", "Change", "Kind", "By", "Reason", "Tx"]}
              >
                {data.moves.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap text-white/60">
                      {when(m.at)}
                    </td>
                    <td className="font-mono text-xs">{m.token}</td>
                    <td className="font-mono tabular-nums">
                      {m.delta > 0 ? "+" : ""}
                      {fmt(m.delta)}
                    </td>
                    <td className="font-mono text-xs">{m.kind}</td>
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
                    <td className="text-white/70">{m.reason}</td>
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
              <Empty>No movements yet.</Empty>
            )}
          </Section>
        </div>
      )}
    </>
  );
}

function Adjust({
  tokens: list,
  done,
}: {
  tokens: string[];
  done: () => void;
}) {
  const [token, setToken] = useState(list[0] ?? "");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [tx, setTx] = useState("");
  const [msg, setMsg] = useState("");
  const n = Math.round(Number(delta));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      await api("PUT", `/admin/stock/${token}`, { delta: n, reason, tx });
      setDelta("");
      setReason("");
      setTx("");
      setMsg(`✓ ${n > 0 ? "+" : ""}${fmt(n)} ${token}`);
      done();
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    }
  };
  return (
    <Section title="Restock or correct">
      <form
        className="grid gap-2 md:grid-cols-[10rem_10rem_1fr_1fr_auto]"
        onSubmit={submit}
      >
        <select
          className="field"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Token"
        >
          {list.map((t) => (
            <option key={t} value={t}>
              {tokens[t as TokenId]?.ticker ?? t}
            </option>
          ))}
        </select>
        <input
          className="field font-mono"
          inputMode="numeric"
          placeholder="+500 or -20"
          value={delta}
          onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ""))}
          required
        />
        <input
          className="field"
          placeholder="Reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
        <input
          className="field font-mono"
          placeholder="On-chain tx (optional)"
          value={tx}
          onChange={(e) => setTx(e.target.value)}
        />
        <button className="btn btn-primary" disabled={!n || !reason.trim()}>
          Apply
        </button>
      </form>
      {msg && <p className="mt-2 text-sm text-white/70">{msg}</p>}
    </Section>
  );
}
