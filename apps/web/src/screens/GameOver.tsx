import { levels, type GameState } from "@nyxeron/core";
import type { CSSProperties } from "react";
import { Backdrop } from "@/components/Backdrop";
import { Brand, HomeButton } from "@/components/Brand";
import { Cta } from "@/components/Cta";
import { en, fmt } from "@/i18n/en";
import { useGame } from "@/store";

const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

export function GameOver({ s }: { s: GameState }) {
  const { origin, start, home } = useGame();
  const o = s.outcome ?? "survived";
  const stats: [string, string][] = [
    ["Day", String(s.day)],
    ["Level", levels[s.level].name],
    ["Coin", fmt(s.coin)],
    ["Reputation", String(s.reputation)],
    ["Violations", String(s.violations)],
  ];
  return (
    <main className="fixed inset-0 overflow-hidden">
      <Backdrop />
      <Brand className="enter absolute top-6 left-10 z-10" />
      <HomeButton className="enter absolute top-6 right-10 z-10" />
      <div className="relative flex h-full flex-col items-center justify-center gap-8 px-6 text-center">
        <h1 className="glow text-[clamp(64px,14vh,160px)] leading-none font-medium tracking-[-0.04em]">
          <span className="line">
            <span className="line-reveal" style={d(200)}>
              {en.outcome[o]}
            </span>
          </span>
        </h1>
        <p
          className="enter max-w-md text-lg font-light text-white/70"
          style={d(600)}
        >
          {en.outcome[`${o}Text`]}
        </p>
        <dl
          className="glass enter grid grid-cols-5 divide-x divide-white/10 rounded-2xl"
          style={d(760)}
        >
          {stats.map(([k, v]) => (
            <div key={k} className="px-6 py-4">
              <dt className="text-[10px] tracking-[0.2em] text-white/45 uppercase">
                {k}
              </dt>
              <dd className="mt-1 font-mono text-lg tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="enter flex gap-3" style={d(900)}>
          {origin && (
            <Cta className="w-48" onClick={() => start(origin)}>
              {en.outcome.retry}
            </Cta>
          )}
          <button
            className="glass h-12 rounded-lg px-6 text-sm tracking-[0.14em] uppercase"
            onClick={home}
          >
            {en.outcome.menu}
          </button>
        </div>
      </div>
    </main>
  );
}
