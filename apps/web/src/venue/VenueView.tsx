import { escortGuest, type GameState } from "@nyxeron/core";
import { useEffect, useRef } from "react";
import { useGame } from "@/store";
import { VenueScene } from "./scene3d";

export function VenueView({ s }: { s: GameState }) {
  const el = useRef<HTMLDivElement>(null);
  const r = useRef<VenueScene | null>(null);

  useEffect(() => {
    let cancelled = false;
    const v = new VenueScene((id) =>
      useGame.getState().act((g) => escortGuest(g, id)),
    );
    v.init(el.current!).then(() => {
      // StrictMode mounts twice; a renderer torn down before init finished must not become current.
      if (cancelled) return;
      r.current = v;
      const g = useGame.getState().game;
      if (g) v.update(g);
    });
    return () => {
      cancelled = true;
      r.current = null;
      v.destroy();
    };
  }, []);

  useEffect(() => {
    r.current?.update(s);
  }, [s]);

  return <div ref={el} className="absolute inset-0" />;
}
