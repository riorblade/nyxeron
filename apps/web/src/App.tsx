import { SettingsDialog } from "@/components/SettingsDialog";
import { lazy, Suspense, useEffect } from "react";
import { Toast } from "@/hud/Toast";
import { ClubSetup } from "@/screens/ClubSetup";
import { Dashboard } from "@/screens/Dashboard";
import { GameOver } from "@/screens/GameOver";
import { IntroVideo } from "@/screens/IntroVideo";
import { Landing } from "@/screens/Landing";
import { NightReport } from "@/screens/NightReport";
import { Office } from "@/screens/Office";
import { PauseMenu } from "@/screens/PauseMenu";
import { hostClose, useNet } from "@/net/session";
import { useGame } from "@/store";

/**
 * The night screen carries three.js and the 3D venue (most of the JS). It loads on demand, and is fetched in the
 * background as soon as the office is up, so opening the club never waits on it.
 */
const loadNight = () => import("@/screens/Night");
const Night = lazy(() => loadNight().then((m) => ({ default: m.Night })));
const GuestNight = lazy(() =>
  import("@/screens/GuestNight").then((m) => ({ default: m.GuestNight })),
);
const StudioScreen = lazy(() =>
  import("@/screens/StudioScreen").then((m) => ({
    default: m.StudioScreen,
  })),
);
const GigNight = lazy(() =>
  import("@/screens/GigNight").then((m) => ({ default: m.GigNight })),
);
const LiveGuest = lazy(() =>
  import("@/screens/LiveGuest").then((m) => ({ default: m.LiveGuest })),
);
const blank = <div className="fixed inset-0 bg-black" />;

export function App() {
  const { screen, game, paused, setPaused, intro } = useGame();

  // Leaving the CEO's game (home, game over) closes the live room; players are told the club closed.
  useEffect(() => {
    if (screen !== "game" && useNet.getState().role === "host") hostClose();
  }, [screen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useGame.getState();
      if (e.key !== "Escape" || st.screen !== "game" || st.intro) return;
      // Esc in a text field just leaves the field.
      if (e.target instanceof HTMLInputElement) return e.target.blur();
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
  if (screen === "setup") view = <ClubSetup />;
  else if (screen === "dashboard") view = <Dashboard />;
  else if (screen === "studio")
    view = (
      <Suspense fallback={blank}>
        <StudioScreen />
      </Suspense>
    );
  else if (screen === "live")
    view = (
      <Suspense fallback={blank}>
        <LiveGuest />
      </Suspense>
    );
  else if (screen === "menu" || !game) view = <Landing />;
  else if (screen === "gig")
    view = (
      <Suspense fallback={blank}>
        <GigNight s={game} />
      </Suspense>
    );
  else if (screen === "guest")
    view = (
      <Suspense fallback={blank}>
        <GuestNight s={game} />
      </Suspense>
    );
  else if (screen === "over") view = <GameOver s={game} />;
  else {
    key = `${game.phase}-${game.day}`;
    if (game.phase === "day") view = <Office s={game} />;
    else if (game.phase === "night")
      view = (
        <Suspense fallback={blank}>
          <Night s={game} />
        </Suspense>
      );
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
      <SettingsDialog />
      <Toast />
    </>
  );
}
