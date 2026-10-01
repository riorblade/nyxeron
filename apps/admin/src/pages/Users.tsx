import { levels, type Level } from "@nyxeron/core";
import { useEffect, useState } from "react";
import { api, fmt, when, type UserRow } from "../api";
import { Badge, Empty, Err, Table, Title, useLoad } from "../ui/kit";

const PAGE = 50;
const SORTS = {
  recent: "Last seen",
  new: "Newest",
  coin: "Coin",
  nights: "Nights",
  name: "Name",
};

export function Users() {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("recent");
  const [offset, setOffset] = useState(0);
  // Search once typing pauses.
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(input);
      setOffset(0);
    }, 300);
    return () => clearTimeout(id);
  }, [input]);
  const { data, error } = useLoad(
    () =>
      api<{ users: UserRow[]; total: number }>(
        "GET",
        `/admin/users?${new URLSearchParams({ q, sort, limit: String(PAGE), offset: String(offset) })}`,
      ),
    [q, sort, offset],
  );
  return (
    <>
      <Title sub="Search by email, name, wallet address or player id.">
        Players
      </Title>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          className="field sm:max-w-sm"
          placeholder="Search…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
        <select
          className="field sm:w-40"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setOffset(0);
          }}
          aria-label="Sort"
        >
          {Object.entries(SORTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <Err>{error}</Err>
      {data && (
        <div className="panel p-4">
          {data.users.length ? (
            <Table
              head={[
                "Player",
                "Email",
                "Coin",
                "Nights",
                "Gigs",
                "Venue access",
                "Last seen",
              ]}
            >
              {data.users.map((u) => (
                <tr
                  key={u.id}
                  className="cursor-pointer hover:bg-white/5"
                  onClick={() =>
                    (location.hash = `#/users/${encodeURIComponent(u.id)}`)
                  }
                >
                  <td>
                    <a
                      href={`#/users/${encodeURIComponent(u.id)}`}
                      className="font-medium hover:underline"
                    >
                      {u.name || "(no name)"}
                    </a>{" "}
                    {u.banned && <Badge>banned</Badge>}
                  </td>
                  <td className="text-white/70">{u.email || "—"}</td>
                  <td className="font-mono tabular-nums">{fmt(u.coin)}</td>
                  <td className="font-mono tabular-nums">{u.nights}</td>
                  <td className="font-mono tabular-nums">{u.gigs}</td>
                  <td>
                    {u.unlockLevel > 1
                      ? levels[u.unlockLevel as Level].name
                      : "—"}
                  </td>
                  <td className="text-white/60">{when(u.lastSeen)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>No players match.</Empty>
          )}
          <div className="mt-3 flex items-center justify-between text-xs text-white/55">
            <span>
              {data.total
                ? `${offset + 1}–${offset + data.users.length} of ${fmt(data.total)}`
                : ""}
            </span>
            <span className="flex gap-2">
              <button
                className="btn h-7"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                Previous
              </button>
              <button
                className="btn h-7"
                disabled={offset + PAGE >= data.total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </button>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
