/**
 * Ambient night backdrop: faint isometric floor grid, two slow drifting light pools, film grain and a vignette.
 * Pure CSS/SVG, no media download. Light pools are blurred white shapes, not gradients.
 */
export function Backdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden bg-black"
    >
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.09]"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1600 900"
      >
        <defs>
          <pattern
            id="iso"
            width="64"
            height="32"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M0 16 L32 0 L64 16 L32 32 Z"
              fill="none"
              stroke="#fff"
              strokeWidth="0.6"
            />
          </pattern>
        </defs>
        <rect
          width="1600"
          height="900"
          fill="url(#iso)"
          transform="translate(0 420) scale(1 0.9)"
        />
      </svg>
      <div className="absolute top-[18%] left-[58%] size-[38vmax] rounded-full bg-white/[0.07] blur-[90px] [animation:drift_18s_ease-in-out_infinite]" />
      <div className="absolute top-[55%] left-[8%] size-[28vmax] rounded-full bg-white/[0.05] blur-[80px] [animation:drift_24s_ease-in-out_infinite_reverse]" />
      <div className="grain" />
      <div className="absolute inset-0 shadow-[inset_0_0_220px_60px_#000]" />
    </div>
  );
}
