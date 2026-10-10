/**
 * Scroll progress (0..1 of the hero runway) at which the reveal clip starts downloading: one viewport of scroll
 * before the split opens at `revealStart`, so it is buffered by the time it shows. `span` is the runway's
 * scrollable height and `viewportH` the window height, both in px.
 */
export const revealLoadAt = (
  revealStart: number,
  span: number,
  viewportH: number,
) => Math.max(0, revealStart - viewportH / Math.max(1, span));
