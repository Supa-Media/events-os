/**
 * Pure pan/zoom transform math for the org chart's Figma-like canvas —
 * dependency-free so both platform implementations (`OrgChartCanvas.web.tsx`'s
 * wheel/drag handlers, `OrgChartCanvas.native.tsx`'s low-frequency "Fit"/+/-
 * button handlers) and this file's own unit tests share ONE definition of
 * "clamp", "zoom around a point", and "fit to content".
 *
 * NOTE: native's real-time pinch/pan gesture callbacks do NOT call into this
 * module — Reanimated worklets (the UI thread) can only call functions that
 * are themselves compiled as worklets, and cross-file worklet detection is
 * unreliable. Those callbacks inline the same (small) arithmetic directly —
 * see `OrgChartCanvas.native.tsx`. Keep the two in sync if the model changes.
 */

export type Transform = { x: number; y: number; scale: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** Trackpad-pinch-to-scale bounds — matches the design spec's "clamp scale
 *  ~0.4–2" so the chart can never shrink to noise or blow up past legibility. */
export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2;

/** Absolute floor for "Fit to screen" specifically — deliberately looser than
 *  the interactive `MIN_SCALE`. Fit's whole job is to show the ENTIRE tree; a
 *  wide Full-tree scope (every chapter grafted under one root — see
 *  `OrgTree.tsx`'s own doc comment) can genuinely need a scale below 0.4 to
 *  fit. Silently clamping Fit to the interactive floor would cut content off
 *  on both edges with no visual indicator anything is missing, AND leave the
 *  user unable to zoom out any further to see the rest (0.4 is also the
 *  interactive floor). Kept just above 0 only to avoid a truly degenerate
 *  (invisible / non-finite) transform — the next interactive zoom
 *  (pinch/wheel/+/-) re-clamps to `[MIN_SCALE, MAX_SCALE]` as normal on its
 *  own first update, so a sub-`MIN_SCALE` Fit result never "sticks" once the
 *  user actually starts zooming themselves. */
export const FIT_MIN_SCALE = 0.02;

/** Default identity transform — origin, 100%. */
export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, scale: 1 };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Zoom `t` by `factor` (>1 zooms in, <1 zooms out), keeping the CANVAS-SPACE
 * point currently under `pointer` (in the container's own local px coords,
 * e.g. a wheel event's offset from the container's top-left) visually fixed —
 * the standard "zoom toward the cursor" behavior. A no-op (returns `t`
 * unchanged) once scale is already clamped at either bound in that direction,
 * so repeated zoom-in/out at the edge doesn't drift the pan position.
 */
export function zoomAroundPoint(t: Transform, pointer: Point, factor: number): Transform {
  const nextScale = clampScale(t.scale * factor);
  if (nextScale === t.scale) return t;
  const worldX = (pointer.x - t.x) / t.scale;
  const worldY = (pointer.y - t.y) / t.scale;
  return {
    scale: nextScale,
    x: pointer.x - worldX * nextScale,
    y: pointer.y - worldY * nextScale,
  };
}

/** Translate `t` by a raw pixel delta (no scale change). */
export function panBy(t: Transform, dx: number, dy: number): Transform {
  return { ...t, x: t.x + dx, y: t.y + dy };
}

/**
 * Clamp `t`'s translation so the content can never be panned fully off-screen
 * — at least `margin` px of the (scaled) content rect stays visible within the
 * container on each axis, independent of whether the content is currently
 * larger or smaller than the container (either ordering of the two candidate
 * bounds is handled via min/max, rather than assuming content > container).
 */
export function clampTranslation(
  t: Transform,
  container: Size,
  content: Size,
  margin = 120,
): Transform {
  const contentW = content.width * t.scale;
  const contentH = content.height * t.scale;
  return {
    ...t,
    x: clampAxis(t.x, container.width, contentW, margin),
    y: clampAxis(t.y, container.height, contentH, margin),
  };
}

function clampAxis(pos: number, containerSize: number, scaledContentSize: number, margin: number): number {
  const a = margin - scaledContentSize;
  const b = containerSize - margin;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.min(hi, Math.max(lo, pos));
}

/**
 * The transform that fits `content` inside `container` with `padding` px of
 * breathing room on every side, centered — what the "Fit" control (and the
 * canvas's own auto-fit on load / scope change) computes. Scale never exceeds
 * 1 (fitting a small chart shouldn't blow it up past 100%), but — UNLIKE
 * interactive zoom — is only floored at `FIT_MIN_SCALE`, not the tighter
 * interactive `MIN_SCALE`. See `FIT_MIN_SCALE`'s doc comment for why: Fit
 * must actually fit, even below what a user could reach by pinching/
 * scrolling themselves.
 */
export function computeFitTransform(container: Size, content: Size, padding = 48): Transform {
  if (content.width <= 0 || content.height <= 0 || container.width <= 0 || container.height <= 0) {
    return IDENTITY_TRANSFORM;
  }
  const availW = Math.max(1, container.width - padding * 2);
  const availH = Math.max(1, container.height - padding * 2);
  const scale = Math.max(FIT_MIN_SCALE, Math.min(availW / content.width, availH / content.height, 1));
  return {
    scale,
    x: (container.width - content.width * scale) / 2,
    y: (container.height - content.height * scale) / 2,
  };
}
