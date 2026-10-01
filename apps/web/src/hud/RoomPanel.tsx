import { Copy, Radio, UserX } from "lucide-react";
import { useState } from "react";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { hostClose, hostOpen, kick, useNet } from "@/net/session";
import { useGame } from "@/store";

const t = en.live;

/** The CEO opens tonight's club to other players: room code, invite link, who is here. */
export function RoomPanel({ clubName }: { clubName: string }) {
  const { role, room, status, players } = useNet();
  const notify = useGame((x) => x.notify);
  const [busy, setBusy] = useState(false);
  const list = Object.values(players);
  const link = `${location.origin}/?join=${room}`;

  if (role !== "host" || !room)
    return (
      <section>
        <h3 className="mb-2 text-[10px] tracking-[0.2em] text-white/60 uppercase">
          {t.openTitle}
        </h3>
        <button
          disabled={busy || role === "host"}
          onClick={async () => {
            setBusy(true);
            try {
              await hostOpen(clubName);
            } catch (e) {
              notify(t.error((e as Error).message), true);
            } finally {
              setBusy(false);
            }
          }}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-white px-3 py-2.5 text-sm font-medium text-black disabled:opacity-50"
        >
          <Radio className="size-4" />
          {busy || role === "host" ? t.opening : t.open}
        </button>
        <p className="mt-1.5 text-[11px] text-white/50">{t.openHint}</p>
      </section>
    );

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-[10px] tracking-[0.2em] text-white/60 uppercase">
        <span
          className={cn(
            "size-1.5 rounded-full",
            status === "live" ? "animate-pulse bg-white" : "bg-white/30",
          )}
        />
        {t.openTitle}
      </h3>
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xl tracking-[0.25em]">{room}</span>
        <button
          className="ml-auto flex h-8 items-center gap-1.5 rounded-md border border-white/15 px-2.5 text-xs hover:bg-white/10"
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            notify(t.copied);
          }}
          title={link}
        >
          <Copy className="size-3.5" /> {t.copyLink}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-white/55">{t.players(list.length)}</p>
      <ul className="mt-1.5 space-y-1">
        {list.length === 0 && (
          <li className="text-xs text-white/45">{t.none}</li>
        )}
        {list.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-2 rounded-md bg-white/[0.04] px-2 py-1 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="text-[10px] text-white/50 uppercase">
              {p.role} · {p.inside ? t.inside : t.waiting}
            </span>
            <button
              className="text-white/55 hover:text-white"
              onClick={() => kick(p.id)}
              aria-label={`${t.kick} ${p.name}`}
              title={t.kick}
            >
              <UserX className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <button
        className="mt-2 text-[11px] text-white/55 underline-offset-2 hover:text-white hover:underline"
        onClick={hostClose}
      >
        {t.close}
      </button>
    </section>
  );
}
