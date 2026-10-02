import { useEffect, useState, type ReactNode } from "react";
import { cn } from "./cn";

/** Load once per `deps` change; `reload()` fetches again (after a change). */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    load()
      .then((data) => live && setState({ data }))
      .catch((e: Error) => live && setState({ error: e.message }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export function Title({
  children,
  sub,
}: {
  children: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-medium tracking-[-0.02em]">{children}</h1>
      {sub && <p className="mt-1 text-sm text-white/55">{sub}</p>}
    </header>
  );
}

export function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="panel p-4">
      <div className="label">{label}</div>
      <div className="mt-2 font-mono text-2xl tabular-nums">{value}</div>
      {note && <div className="mt-1 text-xs text-white/50">{note}</div>}
    </div>
  );
}

export function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel p-4", className)}>
      <h2 className="label mb-3">{title}</h2>
      {children}
    </section>
  );
}

export function Table({
  head,
  children,
}: {
  head: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-white/10">
            {head.map((h) => (
              <th key={h} className="label py-2 pr-4 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:py-2 [&_td]:pr-4 [&_tr]:border-b [&_tr]:border-white/5">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export const Badge = ({ children }: { children: ReactNode }) => (
  <span className="rounded border border-white/30 px-1.5 py-0.5 text-[10px] tracking-[0.15em] uppercase">
    {children}
  </span>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="py-4 text-sm text-white/45">{children}</p>
);

export const Err = ({ children }: { children?: ReactNode }) =>
  children ? (
    <p role="alert" className="text-sm text-white underline decoration-dotted">
      Error: {children}
    </p>
  ) : null;
