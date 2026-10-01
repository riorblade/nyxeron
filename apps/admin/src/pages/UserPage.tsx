import { levels, tokens, type Level, type TokenId } from "@nyxeron/core";
import { ArrowLeft } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { api, fmt, when, type UserDetail } from "../api";
import { Badge, Empty, Err, Kpi, Section, Table, useLoad } from "../ui/kit";
import { AuditTable } from "./AuditTable";

const LEVELS = [1, 2, 3, 4, 5] as const;
const signed = (n: number) => `${n > 0 ? "+" : ""}${fmt(n)}`;

export function UserPage({ id, canEdit }: { id: string; canEdit: boolean }) {
  const {
    data: d,
    error,
    reload,
  } = useLoad(
    () => api<UserDetail>("GET", `/admin/users/${encodeURIComponent(id)}`),
    [id],
  );
  const path = `/admin/users/${encodeURIComponent(id)}`;
  return (
    <>
      <a
        href="#/users"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-white/60 hover:text-white"
      >
        <ArrowLeft className="size-4" /> Players
      </a>
      <Err>{error}</Err>
      {d && (
        <div className="flex flex-col gap-4">
          <header>
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-medium tracking-[-0.02em]">
              {d.user.name || "(no name)"}{" "}
              {d.user.banned && <Badge>banned</Badge>}
              {d.user.unlockLevel > 1 && (
                <Badge>{levels[d.user.unlockLevel as Level].name} access</Badge>
              )}
            </h1>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-white/65 sm:grid-cols-2">
              <Row k="Email">{d.user.email || "—"}</Row>
              <Row k="Wallet">
                <span className="font-mono text-xs break-all">
                  {d.user.walletAddress || "—"}
                </span>
              </Row>
              <Row k="Player id">
                <span className="font-mono text-xs break-all">{d.user.id}</span>
              </Row>
              <Row k="Joined">{when(d.user.createdAt)}</Row>
              <Row k="Last seen">{when(d.user.lastSeen)}</Row>
              {d.user.banned && (
                <Row k="Ban reason">{d.profile.banReason || "—"}</Row>
              )}
            </dl>
          </header>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi label="Coin" value={fmt(d.user.coin)} />
            <Kpi label="Nights" value={d.user.nights} />
            <Kpi label="Gigs" value={d.user.gigs} />
            <Kpi label="Total P&L" value={signed(d.profile.totalPnl)} />
            <Kpi label="Best night" value={signed(d.profile.bestPnl)} />
          </div>

          {canEdit && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Coins path={path} done={reload} />
              <Access path={path} d={d} done={reload} />
              <Moderation path={path} d={d} done={reload} />
              <Saves path={path} d={d} done={reload} />
            </div>
          )}
          {!canEdit && <SavesList d={d} />}

          <Section title="Portfolio">
            {Object.keys(d.profile.portfolio ?? {}).length ? (
              <Table head={["Token", "Qty", "Cost"]}>
                {Object.entries(d.profile.portfolio).map(([t, h]) => (
                  <tr key={t}>
                    <td>{tokens[t as TokenId]?.name ?? t}</td>
                    <td className="font-mono tabular-nums">{fmt(h.qty)}</td>
                    <td className="font-mono tabular-nums">{fmt(h.cost)}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No holdings.</Empty>
            )}
          </Section>

          <Section title="Coin ledger (last 100)">
            {d.ledger.length ? (
              <Table
                head={["When", "Kind", "Change", "Balance", "By", "Reason"]}
              >
                {d.ledger.map((l, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap text-white/60">
                      {when(l.at)}
                    </td>
                    <td className="font-mono text-xs">{l.kind}</td>
                    <td className="font-mono tabular-nums">
                      {signed(l.delta)}
                    </td>
                    <td className="font-mono tabular-nums">{fmt(l.balance)}</td>
                    <td>{l.actor || "—"}</td>
                    <td className="text-white/70">{l.reason}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No coin movements recorded yet.</Empty>
            )}
          </Section>

          <Section title="Admin history">
            {d.audit.length ? (
              <AuditTable rows={d.audit} />
            ) : (
              <Empty>No admin changes.</Empty>
            )}
          </Section>
        </div>
      )}
    </>
  );
}

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex gap-2">
    <dt className="w-24 shrink-0 text-white/45">{k}</dt>
    <dd className="min-w-0">{children}</dd>
  </div>
);

/** A form whose every change needs a reason (it goes into the audit log). */
function useAction(done: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const run = async (
    e: FormEvent,
    fn: () => Promise<unknown>,
    message: string,
  ) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      await fn();
      setOk(message);
      done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status = (
    <>
      <Err>{error}</Err>
      {ok && <p className="text-sm text-white/70">✓ {ok}</p>}
    </>
  );
  return { busy, run, status };
}

const Reason = ({
  value,
  set,
}: {
  value: string;
  set: (v: string) => void;
}) => (
  <input
    className="field"
    placeholder="Reason (required, goes to the audit log)"
    value={value}
    onChange={(e) => set(e.target.value)}
    required
    maxLength={200}
  />
);

function Coins({ path, done }: { path: string; done: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const { busy, run, status } = useAction(done);
  const delta = Math.round(Number(amount));
  return (
    <Section title="Grant or deduct coin">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) =>
          run(
            e,
            () => api("POST", `${path}/coins`, { delta, reason }),
            `${signed(delta)} Coin applied`,
          ).then(() => {
            setAmount("");
            setReason("");
          })
        }
      >
        <input
          className="field font-mono"
          inputMode="numeric"
          placeholder="Amount, e.g. 5000 or -2000"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d-]/g, ""))}
          required
        />
        <Reason value={reason} set={setReason} />
        <button
          className="btn btn-primary self-start"
          disabled={busy || !delta || !reason.trim()}
        >
          {delta < 0 ? "Deduct" : "Grant"} {delta ? fmt(Math.abs(delta)) : ""}{" "}
          Coin
        </button>
        {status}
      </form>
    </Section>
  );
}

function Access({
  path,
  d,
  done,
}: {
  path: string;
  d: UserDetail;
  done: () => void;
}) {
  const [level, setLevel] = useState(d.user.unlockLevel);
  const [reason, setReason] = useState("");
  const { busy, run, status } = useAction(done);
  return (
    <Section title="Venue access">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) =>
          run(
            e,
            () => api("PATCH", path, { unlockLevel: level, reason }),
            "Access updated",
          ).then(() => setReason(""))
        }
      >
        <p className="text-xs text-white/55">
          Lets this player start a new CEO career straight at a bigger venue
          (e.g. the Premium Venue), skipping the climb.
        </p>
        <select
          className="field"
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
          aria-label="Venue"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === 1
                ? "Normal (start at the Token Booth)"
                : `Up to Level ${l}: ${levels[l].name}`}
            </option>
          ))}
        </select>
        <Reason value={reason} set={setReason} />
        <button
          className="btn btn-primary self-start"
          disabled={busy || level === d.user.unlockLevel || !reason.trim()}
        >
          Save access
        </button>
        {status}
      </form>
    </Section>
  );
}

function Moderation({
  path,
  d,
  done,
}: {
  path: string;
  d: UserDetail;
  done: () => void;
}) {
  const [name, setName] = useState(d.user.name);
  const [reason, setReason] = useState("");
  const { busy, run, status } = useAction(done);
  const banned = d.user.banned;
  return (
    <Section title="Moderation">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex gap-2">
          <input
            className="field"
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            aria-label="Name"
          />
          <button
            className="btn"
            disabled={
              busy ||
              name.trim() === d.user.name ||
              !name.trim() ||
              !reason.trim()
            }
            onClick={(e) =>
              run(e, () => api("PATCH", path, { name, reason }), "Renamed")
            }
          >
            Rename
          </button>
        </div>
        <Reason value={reason} set={setReason} />
        <button
          className={banned ? "btn self-start" : "btn btn-primary self-start"}
          disabled={busy || !reason.trim()}
          onClick={(e) =>
            run(
              e,
              () =>
                api("PATCH", path, {
                  banned: !banned,
                  banReason: reason,
                  reason,
                }),
              banned ? "Unbanned" : "Banned",
            )
          }
        >
          {banned ? "Lift ban" : "Ban player"}
        </button>
        <p className="text-xs text-white/50">
          A banned player can sign in and sees the reason, but can&apos;t play
          or change anything.
        </p>
        {status}
      </form>
    </Section>
  );
}

function SavesList({ d }: { d: UserDetail }) {
  return d.saves.length ? (
    <Table head={["Slot", "Club", "Day", "Venue", "Coin", "Saved"]}>
      {d.saves.map((s) => (
        <tr key={s.slot}>
          <td className="font-mono text-xs">{s.slot}</td>
          <td>{s.meta.clubName || "—"}</td>
          <td className="font-mono">{s.meta.day ?? "—"}</td>
          <td>{s.meta.level ? levels[s.meta.level as Level].name : "—"}</td>
          <td className="font-mono tabular-nums">
            {s.meta.coin != null ? fmt(s.meta.coin) : "—"}
          </td>
          <td className="whitespace-nowrap text-white/60">
            {new Date(s.updatedAt).toLocaleString()}
          </td>
        </tr>
      ))}
    </Table>
  ) : (
    <Empty>No career saves.</Empty>
  );
}

function Saves({
  path,
  d,
  done,
}: {
  path: string;
  d: UserDetail;
  done: () => void;
}) {
  const [reason, setReason] = useState("");
  const [sure, setSure] = useState(false);
  const { busy, run, status } = useAction(done);
  return (
    <Section title="CEO career saves">
      <SavesList d={d} />
      {d.saves.length > 0 && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) =>
            run(
              e,
              () => api("POST", `${path}/clear-saves`, { reason }),
              "Saves cleared",
            ).then(() => setSure(false))
          }
        >
          <Reason value={reason} set={setReason} />
          <label className="flex items-center gap-2 text-xs text-white/60">
            <input
              type="checkbox"
              checked={sure}
              onChange={(e) => setSure(e.target.checked)}
            />{" "}
            Delete every career save of this player (can&apos;t be undone)
          </label>
          <button
            className="btn self-start"
            disabled={busy || !sure || !reason.trim()}
          >
            Clear saves
          </button>
          {status}
        </form>
      )}
    </Section>
  );
}
