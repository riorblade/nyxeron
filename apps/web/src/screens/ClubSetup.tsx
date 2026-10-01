import { LOUNGE, useMusic } from "@/audio";
import { levels, type Difficulty, type Level } from "@nyxeron/core";
import { useAccount } from "@/auth/account";
import { useEffect, useState } from "react";
import { Backdrop } from "@/components/Backdrop";
import { Brand } from "@/components/Brand";
import { Cta } from "@/components/Cta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { en, genres } from "@/i18n/en";
import { useGame } from "@/store";

export function ClubSetup() {
  useMusic(LOUNGE);
  const { start, go } = useGame();
  const [name, setName] = useState("");
  const [genre, setGenre] = useState("edm");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  // Venues the back office opened for this player (1 = everyone starts at the booth).
  const unlocked = useAccount((a) => a.access.unlockLevel);
  const [level, setLevel] = useState<Level>(1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && go("dashboard");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);
  return (
    <main className="fixed inset-0 flex items-center justify-center overflow-hidden p-6">
      <Backdrop />
      <Brand className="enter absolute top-6 left-10" />
      <form
        className="glass enter relative flex w-full max-w-md flex-col gap-6 rounded-2xl p-8"
        onSubmit={(e) => {
          e.preventDefault();
          start({
            mode: "career",
            name: name.trim() || en.setup.namePlaceholder,
            genre,
            difficulty,
            level,
          });
        }}
      >
        <h1 className="text-3xl font-medium tracking-[-0.02em]">
          {en.setup.title}
        </h1>
        <label className="flex flex-col gap-2 text-sm">
          {en.setup.name}
          <Input
            autoFocus
            maxLength={24}
            value={name}
            placeholder={en.setup.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-2">{en.setup.genre}</legend>
          <div className="flex flex-wrap gap-2">
            {Object.entries(genres).map(([id, label]) => (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={genre === id ? "default" : "outline"}
                aria-pressed={genre === id}
                onClick={() => setGenre(id)}
              >
                {label}
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-2">{en.setup.difficulty}</legend>
          <div className="flex gap-2">
            {(["easy", "normal", "hard"] as const).map((d) => (
              <Button
                key={d}
                type="button"
                size="sm"
                variant={difficulty === d ? "default" : "outline"}
                aria-pressed={difficulty === d}
                onClick={() => setDifficulty(d)}
              >
                {en.setup.difficulties[d]}
              </Button>
            ))}
          </div>
        </fieldset>
        {unlocked > 1 && (
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-2">{en.setup.venue}</legend>
            <div className="flex flex-wrap gap-2">
              {([1, 2, 3, 4, 5] as const)
                .filter((l) => l <= unlocked)
                .map((l) => (
                  <Button
                    key={l}
                    type="button"
                    size="sm"
                    variant={level === l ? "default" : "outline"}
                    aria-pressed={level === l}
                    onClick={() => setLevel(l)}
                  >
                    {levels[l].name}
                  </Button>
                ))}
            </div>
            <p className="text-xs text-white/50">{en.setup.venueNote}</p>
          </fieldset>
        )}
        <div className="flex gap-3">
          <Cta type="submit" className="flex-1">
            {en.setup.start}
          </Cta>
          <Button
            type="button"
            size="lg"
            variant="ghost"
            onClick={() => go("dashboard")}
          >
            {en.menu.back}
          </Button>
        </div>
      </form>
    </main>
  );
}
