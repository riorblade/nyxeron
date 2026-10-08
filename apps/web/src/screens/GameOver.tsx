import { LOUNGE, useMusic } from "@/audio";
import { levels, playOn, type GameState } from "@nyxeron/core";
import type { CSSProperties } from "react";
import { Backdrop } from "@/components/Backdrop";
import { Brand, HomeButton } from "@/components/Brand";
import { Cta } from "@/components/Cta";
import { en, fmt } from "@/i18n/en";
import { useGame } from "@/state/store";

const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

export function GameOver({ s }: { s: GameState }) {
  useMusic(LOUNGE, true); // the club, heard through the wall
  const { origin, slot, start, home, set, go } = useGame();
  const o = s.outcome ?? "survived";
  const stats: [string, string][] = [
    ["Day", String(s.day)],
    ["Level", levels[s.level].name],
    [en.dashboard.wallet, fmt(s.coin)],
    ["Reputation", String(s.reputation)],
    ["Violations", String(s.violations)],
  ];
  return (
    <main className="fixed inset-0 overflow-hidden">
      <Backdrop />
      <Brand className="enter absolute top-6 left-10 z-10" />
      <HomeButton className="enter absolute top-6 right-10 z-10" />
      <div className="relative flex h-full flex-col items-center justify-center gap-8 px-6 text-center">
        <h1 className="glow text-[clamp(48px,min(14vh,18vw),160px)] leading-none font-medium tracking-[-0.04em]">
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
          className="glass enter grid grid-cols-2 divide-white/10 rounded-2xl sm:grid-cols-5 sm:divide-x"
          style={d(760)}
        >
          {stats.map(([k, v]) => (
            <div key={k} className="px-3 py-3 sm:px-6 sm:py-4">
              <dt className="text-[10px] tracking-[0.2em] text-white/60 uppercase">
                {k}
              </dt>
              <dd className="mt-1 font-mono text-lg tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <div
          className="enter flex w-full flex-col gap-3 sm:w-auto sm:flex-row"
          style={d(900)}
        >
          {o !== "defeat" ? (
            <Cta
              className="w-full sm:w-48"
              onClick={() => {
                set(playOn(s));
                go("game");
              }}
            >
              {en.outcome.playOn}
            </Cta>
          ) : (
            origin && (
              <Cta
                className="w-full sm:w-48"
                onClick={() => start(origin, slot)}
              >
                {en.outcome.retry}
              </Cta>
            )
          )}
          <button
            className="glass h-12 rounded-lg px-6 text-sm tracking-[0.14em] whitespace-nowrap uppercase"
            onClick={home}
          >
            {en.outcome.menu}
          </button>
        </div>
      </div>
    </main>
  );
}
