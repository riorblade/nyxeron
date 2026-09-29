import { Button } from "@/components/ui/button";
import { en } from "@/i18n/en";
import { trapFocus } from "@/lib/utils";
import { writeSave } from "@/save";
import { useSettings } from "@/settings";
import { useGame } from "@/store";

export function PauseMenu() {
  const { game, setPaused, home, notify } = useGame();
  const openSettings = useSettings((s) => s.setOpen);
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-md"
      role="dialog"
      aria-modal
      aria-labelledby="pause-title"
      onKeyDown={trapFocus}
    >
      <div className="glass glow enter flex w-80 flex-col gap-3 rounded-2xl p-6">
        <h2
          id="pause-title"
          className="mb-2 text-center text-2xl font-medium tracking-[-0.02em]"
        >
          {en.pause.title}
        </h2>
        <Button autoFocus onClick={() => setPaused(false)}>
          {en.pause.resume}
        </Button>
        <div className="grid grid-cols-3 gap-2">
          {([1, 2, 3] as const).map((n) => (
            <Button
              key={n}
              variant="outline"
              size="sm"
              onClick={() =>
                game && writeSave(n, game) && notify(en.pause.saved(n))
              }
            >
              {en.pause.save} {n}
            </Button>
          ))}
        </div>
        <Button variant="outline" onClick={() => openSettings(true)}>
          {en.settings.open}
        </Button>
        <Button variant="ghost" onClick={home}>
          {en.pause.quit}
        </Button>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          {en.pause.controls}
        </p>
      </div>
    </div>
  );
}
