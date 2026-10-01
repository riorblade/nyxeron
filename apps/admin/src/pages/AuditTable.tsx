import { when, type AuditRow } from "../api";
import { Table } from "../ui/kit";

const detail = (d: Record<string, unknown>) =>
  "before" in d && "after" in d
    ? `${String(d.before)} → ${String(d.after)}${"delta" in d ? ` (${Number(d.delta) > 0 ? "+" : ""}${String(d.delta)})` : ""}`
    : Object.entries(d)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ");

export function AuditTable({
  rows,
  withTarget,
}: {
  rows: AuditRow[];
  withTarget?: boolean;
}) {
  return (
    <Table
      head={[
        "When",
        "Admin",
        "Action",
        ...(withTarget ? ["Target"] : []),
        "Change",
        "Reason",
      ]}
    >
      {rows.map((a) => (
        <tr key={a.id}>
          <td className="whitespace-nowrap text-white/60">{when(a.at)}</td>
          <td>{a.actor}</td>
          <td className="font-mono text-xs">{a.action}</td>
          {withTarget && (
            <td className="max-w-48 truncate">
              {a.target.startsWith("did:") ? (
                <a
                  className="hover:underline"
                  href={`#/users/${encodeURIComponent(a.target)}`}
                >
                  {a.target}
                </a>
              ) : (
                a.target || "—"
              )}
            </td>
          )}
          <td className="font-mono text-xs">{detail(a.detail)}</td>
          <td className="text-white/70">{a.reason}</td>
        </tr>
      ))}
    </Table>
  );
}
