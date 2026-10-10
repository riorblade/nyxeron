import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { Crash, reloadOnStaleChunks } from "@/components/Crash";
import { writeSave } from "@/state/save";
import { useGame } from "@/state/store";

// A deploy that lands mid-day: keep the club as it is before reloading into the new build.
reloadOnStaleChunks(() => {
  const { game, screen, slot } = useGame.getState();
  if (game && screen === "game" && slot != null) writeSave(slot, game);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crash>
      <App />
    </Crash>
  </StrictMode>,
);
