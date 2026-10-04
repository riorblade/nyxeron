import { payments } from "@nyxeron/core";
import { useAddFunds, useSendTransaction } from "@privy-io/react-auth";
import { CreditCard, ExternalLink, Wallet, X } from "lucide-react";
import { useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { Input } from "@/components/ui/input";
import { useAccount } from "@/auth/account";
import {
  topupQuote,
  topupRoom,
  topups,
  useTopups,
  type Topup,
} from "@/api/topups";
import { en, fmt } from "@/i18n/en";
import { trapFocus } from "@/lib/utils";

const t = en.topup;
const USDC = payments.topup.tokens.USDC as `0x${string}`;
const BSC = payments.chainId;
const bscscan = (tx: string) => `https://bscscan.com/tx/${tx}`;

/**
 * Top up Credit: add USDC to the game wallet by card (Privy's funding flow), then send it to the platform's
 * Agentic Wallet with gas sponsored by the game, and wait for the api to credit it. Rendered only for a signed-in
 * player (inside Privy's provider).
 */
export function TopUpDialog() {
  const s = useTopups();
  const wallet = useAccount((a) => a.account?.wallet ?? "");
  const { addFunds } = useAddFunds();
  const { sendTransaction } = useSendTransaction();
  const [usd, setUsd] = useState(String(payments.topup.minUsd));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      topups.close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const cents = Math.round(Number(usd) * 100);
  const room = topupRoom(s.topped);
  const min = payments.topup.minUsd * 100;
  const valid = Number.isFinite(cents) && cents >= min && cents <= room;
  const busy = s.phase === "sending" || s.phase === "confirming";

  const card = async () => {
    try {
      await addFunds({
        destination: { address: wallet, chain: `eip155:${BSC}`, asset: USDC },
        fiat: { defaultAmount: usd, source: { defaultAsset: "usd" } },
      });
    } catch {
      /* closed by the player: nothing to do */
    }
  };

  const send = async () => {
    if (!valid || busy) return;
    topups.sending();
    let hash: string;
    try {
      ({ hash } = await sendTransaction(
        {
          to: USDC,
          chainId: BSC,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [
              payments.agenticWallet as `0x${string}`,
              parseUnits((cents / 100).toFixed(2), 18),
            ],
          }),
        },
        { sponsor: true },
      ));
    } catch (e) {
      topups.failed(t.walletError((e as Error).message ?? "rejected"));
      return;
    }
    await topups.report(hash);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={topups.close}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={t.title}
        onKeyDown={trapFocus}
        className="glass glow enter flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <Wallet className="size-4" /> {t.title}
          </h2>
          <button
            className="flex size-8 items-center justify-center rounded-md hover:bg-white/10"
            onClick={topups.close}
            aria-label={t.close}
            autoFocus
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-5 overflow-y-auto p-5">
          <div>
            <div className="text-[10px] tracking-[0.2em] text-white/55 uppercase">
              {t.balance}
            </div>
            <div className="mt-1 font-mono text-3xl tabular-nums">
              {s.credits === null ? "—" : fmt(s.credits)}
              {s.credits !== null && (
                <span className="ml-2 text-base text-white/50">
                  {t.usd(s.credits)}
                </span>
              )}
            </div>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t.addTitle}</h3>
            <p className="text-xs text-white/55">{t.addNote}</p>
            <button
              className="flex h-9 items-center gap-2 rounded-md border border-white/15 px-3 text-sm hover:bg-white/10 disabled:opacity-50"
              onClick={card}
              disabled={!wallet || busy}
            >
              <CreditCard className="size-4" /> {t.add}
            </button>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t.sendTitle}</h3>
            <p className="text-xs text-white/55">
              {t.sendNote(payments.topup.feePercent)}
            </p>
            {room < min ? (
              <p className="text-sm text-white/75">{t.full}</p>
            ) : (
              <>
                <label className="block text-xs text-white/55">
                  {t.amount}
                  <Input
                    className="mt-1 h-9 font-mono"
                    inputMode="decimal"
                    value={usd}
                    disabled={busy}
                    onChange={(e) =>
                      setUsd(e.target.value.replace(/[^0-9.]/g, ""))
                    }
                    aria-invalid={!valid}
                  />
                </label>
                <p className="text-xs text-white/55">
                  {cents < min ? t.min(payments.topup.minUsd) : t.room(room)}
                </p>
                <button
                  className="h-9 w-full rounded-md bg-white text-sm font-medium text-black disabled:opacity-40"
                  onClick={send}
                  disabled={!valid || busy || !wallet}
                >
                  {t.send((cents / 100).toFixed(2))}
                  {valid && (
                    <span className="ml-2 text-black/60">
                      · {t.youGet(topupQuote(cents).credits)}
                    </span>
                  )}
                </button>
              </>
            )}
            <Status />
          </section>

          {s.list.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium">{t.history}</h3>
              <ul className="space-y-1.5">
                {s.list.slice(0, 5).map((x) => (
                  <Row key={`${x.tx}-${x.logIndex}`} x={x} />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Status() {
  const { phase, error, tx, list } = useTopups();
  if (phase === "idle") return null;
  const last = list.find((x) => x.tx === tx);
  const text =
    phase === "sending"
      ? t.sending
      : phase === "confirming"
        ? t.confirming
        : phase === "done"
          ? t.done(last?.credits ?? 0)
          : (t.errors[error] ?? error);
  return (
    <p
      role={phase === "error" ? "alert" : "status"}
      className={
        phase === "error" ? "text-sm text-white" : "text-sm text-white/75"
      }
    >
      {text}
      {tx && (
        <a
          className="ml-2 inline-flex items-center gap-1 text-xs text-white/55 underline hover:text-white"
          href={bscscan(tx)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t.viewTx} <ExternalLink className="size-3" />
        </a>
      )}
    </p>
  );
}

function Row({ x }: { x: Topup }) {
  return (
    <li className="flex items-center justify-between rounded-md border border-white/10 px-3 py-2 text-xs">
      <span className="font-mono">{t.usd(x.usdCents)}</span>
      <span className="text-white/55">{t.status[x.status] ?? x.status}</span>
      <span className="font-mono">+{fmt(x.credits)}</span>
      <a
        className="text-white/55 hover:text-white"
        href={bscscan(x.tx)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t.viewTx}
      >
        <ExternalLink className="size-3.5" />
      </a>
    </li>
  );
}
