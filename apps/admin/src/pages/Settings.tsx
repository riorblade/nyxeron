import { useState, type FormEvent } from "react";
import { api, when, type Role } from "../api";
import { Empty, Err, Section, Table, Title, useLoad } from "../ui/kit";

export function Settings({ role }: { role: Role }) {
  return (
    <>
      <Title>Settings</Title>
      <div className="grid gap-4 lg:grid-cols-2">
        <Announcement canEdit={role !== "viewer"} />
        {role === "owner" && <Admins />}
      </div>
    </>
  );
}

function Announcement({ canEdit }: { canEdit: boolean }) {
  const [form, setForm] = useState<{ text: string; active: boolean } | null>(
    null,
  );
  const [msg, setMsg] = useState("");
  const { error } = useLoad(async () => {
    const a = await api<{ text: string; active: boolean; updatedAt: number }>(
      "GET",
      "/admin/announcement",
    );
    setForm({ text: a.text, active: a.active });
    return a;
  }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      await api("PUT", "/admin/announcement", form);
      setMsg(
        form?.active
          ? "✓ Live on every player's dashboard"
          : "✓ Saved (hidden)",
      );
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    }
  };
  return (
    <Section title="Dashboard announcement">
      <Err>{error}</Err>
      {form && (
        <form className="flex flex-col gap-2" onSubmit={save}>
          <textarea
            className="field h-24 py-2"
            maxLength={280}
            placeholder="e.g. Double coin weekend! Basement opens at 22:00."
            value={form.text}
            disabled={!canEdit}
            onChange={(e) => setForm({ ...form, text: e.target.value })}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.active}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            Show it to players
          </label>
          {canEdit && (
            <button className="btn btn-primary self-start">Save</button>
          )}
          {msg && <p className="text-sm text-white/70">{msg}</p>}
        </form>
      )}
    </Section>
  );
}

interface AdminList {
  owners: string[];
  admins: { email: string; role: string; grantedBy: string; at: number }[];
}

function Admins() {
  const { data, error, reload } = useLoad(
    () => api<AdminList>("GET", "/admin/admins"),
    [],
  );
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [msg, setMsg] = useState("");
  const set = async (e: FormEvent | null, who: string, r: string) => {
    e?.preventDefault();
    setMsg("");
    try {
      await api("PUT", "/admin/admins", { email: who, role: r });
      setEmail("");
      reload();
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    }
  };
  return (
    <Section title="Admins">
      <p className="mb-3 text-xs text-white/55">
        Owners come from the server (ADMIN_EMAILS). Admins can change players;
        viewers can only look.
      </p>
      <Err>{error}</Err>
      {data && (
        <Table head={["Email", "Role", "Added", ""]}>
          {data.owners.map((o) => (
            <tr key={o}>
              <td>{o}</td>
              <td>owner</td>
              <td className="text-white/50">server</td>
              <td />
            </tr>
          ))}
          {data.admins.map((a) => (
            <tr key={a.email}>
              <td>{a.email}</td>
              <td>{a.role}</td>
              <td className="text-white/50" title={`by ${a.grantedBy}`}>
                {when(a.at)}
              </td>
              <td>
                <button
                  className="text-xs text-white/60 underline hover:text-white"
                  onClick={() => set(null, a.email, "")}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {data && !data.admins.length && <Empty>No other admins yet.</Empty>}
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => set(e, email, role)}
      >
        <input
          className="field"
          type="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <select
          className="field sm:w-32"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label="Role"
        >
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <button className="btn btn-primary">Add</button>
      </form>
      {msg && <p className="mt-2 text-sm text-white/70">{msg}</p>}
    </Section>
  );
}
