import { useState } from "react";
import { api, type AuditRow } from "../api";
import { Empty, Err, Title, useLoad } from "../ui/kit";
import { AuditTable } from "./AuditTable";

export function Audit() {
  const [before, setBefore] = useState(0);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const { error } = useLoad(async () => {
    const page = await api<AuditRow[]>(
      "GET",
      `/admin/audit?limit=100&before=${before}`,
    );
    setRows((r) => (before ? [...r, ...page] : page));
    return page;
  }, [before]);
  return (
    <>
      <Title sub="Every change made from the back office: who, to whom, before → after, and why.">
        Audit log
      </Title>
      <Err>{error}</Err>
      <div className="panel p-4">
        {rows.length ? (
          <AuditTable rows={rows} withTarget />
        ) : (
          <Empty>Nothing yet.</Empty>
        )}
        {rows.length > 0 && rows.length % 100 === 0 && (
          <button
            className="btn mt-3 h-7"
            onClick={() => setBefore(rows[rows.length - 1]!.id)}
          >
            Older
          </button>
        )}
      </div>
    </>
  );
}
