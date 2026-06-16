/**
 * Site-map geometry — the pure, React-free math + helpers shared by every site
 * map surface (the editor canvas, the inline preview, and the public read-only
 * view). These were previously triplicated across
 * `components/event/SiteMapEditor.tsx`, `SiteMapPreview.tsx`, and
 * `SiteMapView.tsx`; this module is the single source of truth.
 *
 * Coordinates are normalized 0..1 against the (measured) container size:
 *  - percentage positioning (`left:${x*100}%`) renders before measurement,
 *  - lines need PIXEL geometry (length via `hypot`, angle via `atan2`), so they
 *    take the measured container size and bail (return null) until it's known.
 *
 * Everything here is pure: no React, no `react-native` imports — just math and
 * string/color helpers — so it can be unit-tested and imported anywhere.
 */
import { optionColor } from "./optionColor";

// ── Shared geometry constants ────────────────────────────────────────────────

/** Default rect/circle SHAPE size as a fraction of the container (0..1). */
export const DEFAULT_SHAPE_SIZE = 0.18;
/** Fallback shape color name when a shape has none. */
export const DEFAULT_SHAPE_COLOR = "blue";
/** Fallback marker color name when a marker has none. */
export const DEFAULT_MARKER_COLOR = "red";

/**
 * Canonical diameter (px) of a placed overlay circle (supply / volunteer).
 *
 * The three surfaces had DIVERGED on this (editor 42, preview 34, view 36); 36
 * is the canonical value. The EDITOR may scale this up for a comfortable drag
 * target — pass a `size` prop to the presentational components rather than
 * forking the constant.
 */
export const CIRCLE_SIZE = 36;

/** Half a marker pin's badge (px) — used to center a pin on its point. */
export const MARKER_HALF = 8;

// ── Geometry input types ─────────────────────────────────────────────────────

/** The three sketchable shape kinds. */
export type ShapeType = "rect" | "circle" | "line";

/**
 * Minimal shape geometry the renderers need (all coords normalized 0..1). The
 * data layer rows carry extra fields (`_id`, …); this is the structural subset
 * the geometry/presentational helpers consume.
 */
export type ShapeGeometry = {
  type: ShapeType;
  x: number;
  y: number;
  w?: number | null;
  h?: number | null;
  x2?: number | null;
  y2?: number | null;
  color?: string | null;
  label?: string | null;
};

/** Minimal marker geometry (normalized 0..1 point + optional label/color). */
export type MarkerGeometry = {
  x: number;
  y: number;
  label?: string | null;
  color?: string | null;
};

/** Overlay placement kinds — supplies & volunteers. */
export type PlacementKind = "supply" | "volunteer";

/** Minimal placement geometry (normalized 0..1 point + kind + label). */
export type PlacementGeometry = {
  kind: PlacementKind;
  x: number;
  y: number;
  label?: string | null;
};

/** A measured container size in px (or null before first layout). */
export type ContainerSize = { width: number; height: number } | null;

// ── Number helpers ───────────────────────────────────────────────────────────

/** Clamp a number into the normalized 0..1 range. */
export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** True only when every supplied value is a finite number (guards NaN CSS). */
export function allFinite(...ns: (number | null | undefined)[]): boolean {
  return ns.every((n) => typeof n === "number" && Number.isFinite(n));
}

// ── Percentage / pixel positioning ───────────────────────────────────────────

/** `left`/`top` percentage strings for a normalized point — `{ left, top }`. */
export function percentPosition(
  x: number,
  y: number,
): { left: `${number}%`; top: `${number}%` } {
  return { left: `${x * 100}%`, top: `${y * 100}%` };
}

// ── Line geometry (pixel) ────────────────────────────────────────────────────

/** A resolved line in pixel space: start, length, and rotation (degrees). */
export type LineGeometry = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  angleDeg: number;
};

/**
 * Resolve a line shape into pixel geometry against the measured container.
 * Coerces a half-defined line to its start point. Returns null before the
 * container is measured or when any coordinate is non-finite, so callers never
 * feed NaN into `left`/`top`/`width`.
 */
export function lineGeometry(
  shape: Pick<ShapeGeometry, "x" | "y" | "x2" | "y2">,
  size: ContainerSize,
): LineGeometry | null {
  const W = size?.width ?? 0;
  const H = size?.height ?? 0;
  const nx = shape.x;
  const ny = shape.y;
  const nx2 = shape.x2 ?? shape.x;
  const ny2 = shape.y2 ?? shape.y;
  if (!(W > 0 && H > 0) || !allFinite(nx, ny, nx2, ny2)) return null;
  const x1 = nx * W;
  const y1 = ny * H;
  const x2 = nx2 * W;
  const y2 = ny2 * H;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const angleDeg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  return { x1, y1, x2, y2, length, angleDeg };
}

// ── Color helpers ────────────────────────────────────────────────────────────

/** Resolve a shape color name → its hex value (falls back to the default). */
export function shapeHex(color?: string | null): string {
  return optionColor(color ?? DEFAULT_SHAPE_COLOR).text;
}

/** Resolve a marker color name → its hex value (falls back to the default). */
export function markerHex(color?: string | null): string {
  return optionColor(color ?? DEFAULT_MARKER_COLOR).text;
}

/** A shape's ~12% alpha fill, derived from its border hex. */
export function shapeFill(color?: string | null): string {
  return `${shapeHex(color)}1F`;
}

// ── Label helpers ────────────────────────────────────────────────────────────

/**
 * Initials from a name — first letters of the first two words, uppercase.
 * "Ada Okafor" → "AO"; single word → its first letter; empty → "".
 */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

/** First letter of a title, uppercase (empty → ""). */
export function firstLetter(title: string | null | undefined): string {
  return (title ?? "").trim().charAt(0).toUpperCase();
}
