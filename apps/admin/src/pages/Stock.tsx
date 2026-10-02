import { tokens, type TokenId } from "@nyxeron/core";
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
const QUICK = [100, 500, 1000, 5000];

/**
 * The platform's warehouse. CEOs buy their shop stock from it, so an empty warehouse means no shop can restock.
 * Fill it here by hand, or let the stock agent do it (POST /api/agent/restock with the on-chain purchase).
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
  const shelves = data.tokens.reduce((n, r) => n + r.inShops, 0);

  return (
    <>
      <Title sub="CEOs buy the stock for their shops from this warehouse. If a token is empty here, no shop can restock it.">
        Platform stock
      </Title>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="In the warehouse"
          value={fmt(total)}
          note="units, all tokens"
        />
        <Kpi
          label="Empty tokens"
          value={`${empty} / ${data.tokens.length}`}
          note="CEOs can't stock these"
        />
        <Kpi
          label="On CEOs' shelves"
          value={fmt(shelves)}
          note="already sold to shops"
        />
        <Kpi label="Bought by CEOs" value={fmt(sold7d)} note="last 7 days" />
      </div>

      {canEdit && empty > 0 && (
        <FillAll
          rows={data.tokens}
          done={(m) => {
            setNotice(m);
            reload();
          }}
        />
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
              Units the platform holds; CEOs buy from here.
            </Term>
            <Term k="On CEO shelves">
              Units CEOs already bought and haven't sold to players yet.
            </Term>
            <Term k="CEOs bought (24h / 7d)">
              Units CEOs took from the warehouse: this is demand.
            </Term>
            <Term k="Shops">How many CEO shops hold this token.</Term>
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
            "On CEO shelves",
            "CEOs bought 24h / 7d",
            "Shops",
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
        </td>
        <td>{n(r.inShops)}</td>
        <td>
          {n(r.sold24h)} <span className="text-white/40">/</span> {n(r.sold7d)}
        </td>
        <td>{n(r.shops)}</td>
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

/** Add units of one token (or, under "Correct a count", take some away). */
function RestockForm({ r, done }: { r: Row; done: (msg: string) => void }) {
  const [qty, setQty] = useState(r.suggested || 500);
  const [remove, setRemove] = useState(false);
  const [reason, setReason] = useState(
    r.onHand === 0 ? "Initial stock" : "Restock",
  );
  const [tx, setTx] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const delta = remove ? -qty : qty;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("PUT", `/admin/stock/${r.token}`, { delta, reason, tx });
      done(
        `✓ ${remove ? "Removed" : "Added"} ${fmt(qty)} ${ticker(r.token)}: ${fmt(Math.max(0, r.onHand + delta))} in the warehouse`,
      );
    } catch (err) {
      setError(
        (err as Error).message === "sold_out"
          ? "The warehouse doesn't have that many to remove."
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-3 py-2" onSubmit={submit}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">{remove ? "Remove" : "Add"}</span>
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            className={cn(
              "btn h-8 font-mono text-xs",
              qty === q && "btn-primary",
            )}
            onClick={() => setQty(q)}
          >
            {fmt(q)}
          </button>
        ))}
        <input
          className="field h-8 w-28 font-mono"
          inputMode="numeric"
          aria-label="Units"
          value={qty || ""}
          onChange={(e) => setQty(Number(e.target.value.replace(/\D/g, "")))}
        />
        <span className="text-sm text-white/60">
          units of {name(r.token)} → {fmt(Math.max(0, r.onHand + delta))} in the
          warehouse
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <input
          className="field"
          placeholder="Reason (goes to the audit log)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
        <input
          className="field font-mono"
          placeholder="On-chain purchase tx (optional)"
          value={tx}
          onChange={(e) => setTx(e.target.value)}
        />
        <button
          className="btn btn-primary"
          disabled={busy || !qty || !reason.trim()}
        >
          {busy
            ? "Saving…"
            : `${remove ? "Remove" : "Add"} ${fmt(qty)} ${ticker(r.token)}`}
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-white/55">
        <input
          type="checkbox"
          className="accent-white"
          checked={remove}
          onChange={(e) => setRemove(e.target.checked)}
        />
        Correct a count instead (remove units, e.g. after a miscount)
      </label>
      <Err>{error}</Err>
    </form>
  );
}

/** Empty warehouse: fill every empty token in one go. */
function FillAll({ rows, done }: { rows: Row[]; done: (msg: string) => void }) {
  const [qty, setQty] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const targets = rows.filter((r) => r.onHand === 0);
  const fill = async () => {
    setBusy(true);
    setMsg("");
    let ok = 0;
    for (const r of targets) {
      try {
        await api("PUT", `/admin/stock/${r.token}`, {
          delta: qty,
          reason: "Initial stock",
        });
        ok++;
      } catch (e) {
        setMsg(`Stopped at ${ticker(r.token)}: ${(e as Error).message}`);
        break;
      }
    }
    setBusy(false);
    if (ok === targets.length)
      done(`✓ Added ${fmt(qty)} units to each of ${ok} tokens`);
    else if (ok) done(`Added ${fmt(qty)} units to ${ok} tokens, then stopped`);
  };
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-xl border border-white/30 bg-white/[0.05] p-4 shadow-[0_0_24px_rgba(255,255,255,.06)] md:flex-row md:items-center">
      <div className="flex-1">
        <div className="font-medium">
          {targets.length === rows.length
            ? "The warehouse is empty"
            : `${targets.length} tokens are empty`}
        </div>
        <p className="text-sm text-white/60">
          CEOs can't stock their shops until there's stock here. Fill every
          empty token at once, then fine-tune per token with Restock.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <select
          className="field h-9 w-32 font-mono"
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          aria-label="Units per token"
        >
          {QUICK.map((q) => (
            <option key={q} value={q}>
              {fmt(q)} each
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={busy} onClick={fill}>
          <PackagePlus className="size-4" />{" "}
          {busy ? "Filling…" : `Fill ${targets.length} tokens`}
        </button>
      </div>
      {msg && <p className="text-sm text-white/70 md:basis-full">{msg}</p>}
    </div>
  );
}
