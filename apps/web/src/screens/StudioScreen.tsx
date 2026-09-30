import { Backdrop } from "@/components/Backdrop";
import { Brand } from "@/components/Brand";
import { DjStudio } from "@/dj/Studio";
import { useGame } from "@/store";

/** The DJ role from the dashboard: a practice room with the full studio. */
export function StudioScreen() {
  const go = useGame((x) => x.go);
  return (
    <main className="fixed inset-0 overflow-y-auto">
      <Backdrop />
      <div className="relative mx-auto flex max-w-[1500px] flex-col gap-4 p-3 sm:p-6">
        <Brand className="enter" onClick={() => go("dashboard")} />
        <DjStudio onClose={() => go("dashboard")} />
      </div>
    </main>
  );
}
