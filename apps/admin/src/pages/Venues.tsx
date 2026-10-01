import { levels, type Level } from "@nyxeron/core";
import { useState } from "react";
import { api, fmt, when, type CityView, type Lease } from "../api";
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

const LEVELS = [1, 2, 3, 4, 5] as const;

/** The city: every venue, who rents it, open shops, live and scheduled parties, and the rent table. */
export function Venues({ canEdit }: { canEdit: boolean }) {
  const {
    data: c,
    error,
    reload,
  } = useLoad(() => api<CityView>("GET", "/admin/city"), []);
  const [level, setLevel] = useState<number | "all">("all");
  const [msg, setMsg] = useState("");
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg("");
    try {
      await fn();
      setMsg(`✓ ${ok}`);
      reload();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    }
  };
  const ask = (what: string) =>
    window.prompt(`Reason to ${what} (goes to the audit log):`)?.trim();

  if (!c) return <Err>{error}</Err>;
  const rented = c.venues.filter((v) => v.lease);
  const live = c.parties.filter((p) => p.live);
  const shown = c.venues.filter((v) =>
    level === "all" ? v.lease : v.level === level,
  );
  return (
    <>
      <Title sub="Venues are rented weekly with Coin; shops sell while tenants are away; Level 3+ hosts parties.">
        Venues
      </Title>
      {msg && <p className="mb-3 text-sm text-white/70">{msg}</p>}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Rented" value={`${rented.length} / ${c.venues.length}`} />
        <Kpi
          label="Shops open"
          value={
            rented.filter((v) => v.lease!.open && v.lease!.stock.length).length
          }
        />
        <Kpi label="Parties live" value={live.length} />
        <Kpi label="Scheduled" value={c.parties.length - live.length} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Section title="Venues">
          <div className="mb-3 flex flex-wrap gap-1">
            {(["all", ...LEVELS] as const).map((l) => (
              <button
                key={l}
                className={`btn h-7 text-xs ${level === l ? "btn-primary" : ""}`}
                onClick={() => setLevel(l)}
              >
                {l === "all" ? "Rented" : `Lv ${l} · ${levels[l].name}`}
              </button>
            ))}
          </div>
          {shown.length ? (
            <Table head={["Venue", "Tenant", "Status", "Rented until", ""]}>
              {shown.map((v) => (
                <tr key={`${v.level}-${v.slot}`}>
                  <td className="whitespace-nowrap">
                    Lv {v.level} #{v.slot}
                    <div className="text-xs text-white/50">
                      {levels[v.level as Level].name}
                    </div>
                  </td>
                  <td>
                    {v.lease ? (
                      <Tenant l={v.lease} />
                    ) : (
                      <span className="text-white/40">free</span>
                    )}
                  </td>
                  <td>
                    {v.lease && (
                      <Status
                        l={v.lease}
                        parties={c.parties.filter(
                          (p) => p.leaseId === v.lease!.id,
                        )}
                      />
                    )}
                  </td>
                  <td className="whitespace-nowrap text-white/60">
                    {v.lease ? when(v.lease.endsAt) : "—"}
                  </td>
                  <td>
                    {canEdit && v.lease && (
                      <button
                        className="text-xs text-white/60 underline hover:text-white"
                        onClick={() => {
                          const reason = ask("end this lease");
                          if (reason)
                            void act(
                              () =>
                                api(
                                  "POST",
                                  `/admin/leases/${v.lease!.id}/end`,
                                  { reason },
                                ),
                              "Lease ended",
                            );
                        }}
                      >
                        End lease
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>No venues rented yet.</Empty>
          )}
        </Section>

        <div className="flex flex-col gap-4">
          <Section title="Parties">
            {c.parties.length ? (
              <ul className="flex flex-col gap-2 text-sm">
                {c.parties.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-md border border-white/10 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">
                        {p.title || p.club}
                      </span>
                      {p.live ? (
                        <Badge>live</Badge>
                      ) : (
                        <span className="text-xs text-white/50">scheduled</span>
                      )}
                    </div>
                    <div className="text-xs text-white/55">
                      {p.club} · Lv {p.level} · {p.owner || "—"}
                    </div>
                    <div className="font-mono text-xs text-white/65">
                      {when(p.startsAt)} · {p.minutes} min
                      {p.room ? ` · room ${p.room}` : ""}
                    </div>
                    {canEdit && (
                      <button
                        className="mt-1 text-xs text-white/60 underline hover:text-white"
                        onClick={() => {
                          const reason = ask("cancel this party");
                          if (reason)
                            void act(
                              () =>
                                api("POST", `/admin/parties/${p.id}/cancel`, {
                                  reason,
                                }),
                              "Party cancelled",
                            );
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No parties scheduled.</Empty>
            )}
          </Section>
          <RentTable rent={c.rent} canEdit={canEdit} done={reload} />
        </div>
      </div>
    </>
  );
}

const Tenant = ({ l }: { l: Lease }) => (
  <>
    <div className="font-medium">{l.club}</div>
    <a
      href={`#/users/${encodeURIComponent(l.ownerId)}`}
      className="text-xs text-white/60 hover:underline"
    >
      {l.owner || "(no name)"} · {l.email || l.ownerId}
    </a>
  </>
);

function Status({ l, parties }: { l: Lease; parties: CityView["parties"] }) {
  const units = l.stock.reduce((n, s) => n + s.qty, 0);
  return (
    <div className="flex flex-wrap gap-1 text-xs">
      {parties.some((p) => p.live) && <Badge>party live</Badge>}
      {parties.some((p) => !p.live) && (
        <Badge>{parties.filter((p) => !p.live).length} scheduled</Badge>
      )}
      <span className="text-white/60">
        shop {l.open ? "open" : "closed"} · {fmt(units)} units
      </span>
    </div>
  );
}

function RentTable({
  rent,
  canEdit,
  done,
}: {
  rent: Record<string, number>;
  canEdit: boolean;
  done: () => void;
}) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const changed = Object.fromEntries(
    Object.entries(edit)
      .map(([l, v]) => [l, Number(v)] as const)
      .filter(([l, v]) => v && v !== rent[l]),
  );
  return (
    <Section title="Weekly rent">
      <form
        className="flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("PUT", "/admin/rent", { rent: changed, reason });
            setEdit({});
            setReason("");
            setMsg("✓ Saved (new leases and extensions)");
            done();
          } catch (err) {
            setMsg(`Error: ${(err as Error).message}`);
          }
        }}
      >
        {LEVELS.map((l) => (
          <label
            key={l}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span>
              Lv {l} · {levels[l].name}
            </span>
            <input
              className="field w-28 text-right font-mono"
              inputMode="numeric"
              disabled={!canEdit}
              value={edit[l] ?? String(rent[l] ?? "")}
              onChange={(e) =>
                setEdit({ ...edit, [l]: e.target.value.replace(/\D/g, "") })
              }
            />
          </label>
        ))}
        {canEdit && (
          <>
            <input
              className="field"
              placeholder="Reason (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              className="btn btn-primary self-start"
              disabled={!Object.keys(changed).length || !reason.trim()}
            >
              Save rent
            </button>
          </>
        )}
        {msg && <p className="text-sm text-white/70">{msg}</p>}
      </form>
    </Section>
  );
}
