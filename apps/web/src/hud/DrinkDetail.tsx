import { drinks, orderCost, type DrinkId, type GameState } from "@nyxeron/core";
import { Package, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { art } from "@/art";
import { Img } from "@/components/Img";
import { en, fmt } from "@/i18n/en";

/** Full-screen card for one bar line: tonight's numbers plus what is actually poured under it. */
export function DrinkDetail({
  s,
  id,
  onClose,
}: {
  s: GameState;
  id: DrinkId;
  onClose: () => void;
}) {
  const info = en.drinkInfo[id];
  const t = en.drinkDetail;
  const dr = drinks[id];
  const cost = orderCost(id, 1, "corner", s.level);
  const price = s.prices[id];
  const margin = price > 0 ? Math.round(((price - cost) / price) * 100) : 0;

  useEffect(() => {
    // Capture phase, so Esc closes the card instead of opening the pause menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Portal: glass panels use backdrop-filter, which would otherwise trap a fixed overlay inside them.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`${t.title}: ${info.line}`}
        className="glass glow enter grid max-h-[92dvh] w-full max-w-4xl grid-cols-1 overflow-y-auto rounded-2xl md:grid-cols-[17rem_1fr] md:overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="flex flex-col gap-4 border-b border-white/10 p-5 md:max-h-[85vh] md:overflow-y-auto md:border-r md:border-b-0">
          <div className="hidden aspect-square items-center justify-center rounded-xl sm:flex border border-white/10 bg-white/[0.03]">
            <Img
              src={art.drink(id)}
              alt=""
              className="size-[80%] object-contain drop-shadow-[0_6px_18px_rgba(0,0,0,.9)]"
              fallback={<Package className="size-10 text-white/30" />}
            />
          </div>
          <div>
            <div className="text-[10px] tracking-[0.3em] text-white/50 uppercase">
              {t.title}
            </div>
            <h2 className="mt-1 text-2xl font-medium tracking-[-0.02em]">
              {info.line}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/70">
              {info.about}
            </p>
          </div>
          <dl className="space-y-1.5 text-sm">
            {dr.minLevel > s.level ? (
              <Stat label={t.stock}>{t.unlock(dr.minLevel)}</Stat>
            ) : (
              <Stat label={t.stock}>{s.stock[id]}</Stat>
            )}
            <Stat label={t.cost}>{fmt(cost)} C</Stat>
            <Stat label={t.price}>{fmt(price)} C</Stat>
            <Stat label={t.margin}>{margin}%</Stat>
            <Stat label={t.buzz}>+{dr.alcohol}</Stat>
          </dl>
          <p className="mt-auto text-xs leading-relaxed text-white/50">
            <span className="block text-[10px] tracking-[0.2em] text-white/60 uppercase">
              {t.serve}
            </span>
            {info.serve}
          </p>
        </aside>

        <section className="flex min-h-0 flex-col">
          <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <h3 className="text-[10px] tracking-[0.3em] text-white/55 uppercase">
              {t.onMenu}
            </h3>
            <button
              className="flex size-8 items-center justify-center rounded-md hover:bg-white/10"
              onClick={onClose}
              aria-label={t.close}
            >
              <X className="size-4" />
            </button>
          </header>
          <ul className="space-y-2 p-5 md:max-h-[70vh] md:overflow-y-auto">
            {info.menu.map((m) => (
              <li
                key={m.name}
                className="rounded-xl border border-white/8 bg-white/[0.03] p-3.5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{m.name}</span>
                  <span className="shrink-0 font-mono text-xs text-white/60">
                    {m.abv} ABV
                  </span>
                </div>
                <div className="text-[11px] tracking-wide text-white/60">
                  {m.origin}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-white/75">
                  {m.note}
                </p>
                {m.famous && (
                  <p className="mt-1.5 text-xs text-white/55">
                    <span className="text-white/60">{t.famous}: </span>
                    {m.famous}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>,
    document.body,
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/50">{label}</dt>
      <dd className="font-mono text-[13px]">{children}</dd>
    </div>
  );
}

/** Wraps a drink's name/thumbnail so clicking it opens the detail card. */
export function DrinkLink({
  s,
  id,
  children,
  className,
}: {
  s: GameState;
  id: DrinkId;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={
          className ??
          "flex min-w-0 items-center gap-3 text-left hover:underline"
        }
        onClick={() => setOpen(true)}
        title={en.drinkDetail.open}
      >
        {children}
      </button>
      {open && <DrinkDetail s={s} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}
