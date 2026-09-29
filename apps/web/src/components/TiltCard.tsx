import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Collectible-style card: cursor-driven 3D tilt with inertia, a few stacked slices for physical
 * thickness, and a soft light spot that follows the cursor (MotionSites "Animated Cards", in B&W).
 */
export function TiltCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const m = { x: 0, y: 0, tx: 0, ty: 0 };
    let raf = 0;
    const loop = () => {
      m.x += (m.tx - m.x) * 0.12;
      m.y += (m.ty - m.y) * 0.12;
      el.style.setProperty("--rx", `${(-m.y * 9).toFixed(2)}deg`);
      el.style.setProperty("--ry", `${(m.x * 11).toFixed(2)}deg`);
      el.style.setProperty("--mx", `${(m.x * 50 + 50).toFixed(1)}%`);
      el.style.setProperty("--my", `${(m.y * 50 + 50).toFixed(1)}%`);
      const settled = Math.abs(m.tx - m.x) + Math.abs(m.ty - m.y) < 0.002;
      raf = settled ? 0 : requestAnimationFrame(loop);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      m.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      m.ty = ((e.clientY - r.top) / r.height) * 2 - 1;
      el.dataset.hover = "";
      kick();
    };
    const leave = () => {
      m.tx = m.ty = 0;
      delete el.dataset.hover;
      kick();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div className={cn("[perspective:900px]", className)}>
      <div
        ref={ref}
        className="group/tilt relative h-full [transform-style:preserve-3d]"
        style={{
          transform: "rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg))",
        }}
      >
        {[-3, -2, -1].map((z) => (
          <div
            key={z}
            aria-hidden
            className="absolute inset-0 rounded-2xl bg-neutral-700"
            style={{ transform: `translateZ(${z}px)` }}
          />
        ))}
        <div className="relative h-full overflow-hidden rounded-2xl border border-white/15 bg-neutral-950 shadow-[inset_0_1px_1px_rgba(255,255,255,.15)] [transform:translateZ(1px)]">
          {children}
          <div
            aria-hidden
            className="pointer-events-none absolute size-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/0 blur-2xl transition-colors duration-300 group-data-[hover]/tilt:bg-white/12"
            style={{ left: "var(--mx, 50%)", top: "var(--my, 50%)" }}
          />
        </div>
      </div>
    </div>
  );
}
