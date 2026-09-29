import { useEffect } from "react";
import { Toast } from "@/hud/Toast";
import { ClubSetup } from "@/screens/ClubSetup";
import { GameOver } from "@/screens/GameOver";
import { IntroVideo } from "@/screens/IntroVideo";
import { Landing } from "@/screens/Landing";
import { Night } from "@/screens/Night";
import { NightReport } from "@/screens/NightReport";
import { Office } from "@/screens/Office";
import { PauseMenu } from "@/screens/PauseMenu";
import { useGame } from "@/store";

export function App() {
  const { screen, game, paused, setPaused, intro } = useGame();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useGame.getState();
      if (e.key !== "Escape" || st.screen !== "game" || st.intro) return;
      if (st.game?.phase === "night" && st.view !== "venue" && !st.paused)
        st.setView("venue");
      else setPaused(!st.paused);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaused]);

  let view;
  // Key per screen/phase so every navigation fades in instead of snapping.
  let key: string = screen;
  if (screen === "menu" || !game)
    view = screen === "setup" ? <ClubSetup /> : <Landing />;
  else if (screen === "setup") view = <ClubSetup />;
  else if (screen === "over") view = <GameOver s={game} />;
  else {
    key = `${game.phase}-${game.day}`;
    if (game.phase === "day") view = <Office s={game} />;
    else if (game.phase === "night") view = <Night s={game} />;
    else view = <NightReport s={game} />;
  }

  return (
    <>
      <div key={key} className="screen-fade">
        {view}
      </div>
      {intro && game?.phase === "night" && screen === "game" && (
        <IntroVideo day={game.day} />
      )}
      {paused && screen === "game" && <PauseMenu />}
      <Toast />
    </>
  );
}
