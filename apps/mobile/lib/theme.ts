/**
 * Events OS design tokens — the SINGLE source of truth for the visual system.
 *
 * Brand DNA comes from publicworship.life: warm cream surfaces, dark reddish
 * "ink" text, a confident red accent, and a set of pastel secondaries used for
 * status/categories. Headings are the Corben serif; body/UI is DM Sans.
 *
 * These values are mirrored verbatim into `tailwind.config.js` so screens style
 * with NativeWind `className`s (e.g. `bg-surface text-ink`) and never hardcode
 * hex. The few places that need raw values at runtime (icon tints, chart fills,
 * the readiness ring) import from here.
 */
import {
  MODULE_READY_PHASE,
  readinessTier,
  type PhaseKey,
} from "@events-os/shared";

// ── Brand palette (publicworship tokens) ─────────────────────────────────────
export const palette = {
  ink: "#210909", // primary text
  cream: "#FDF6F6", // app background
  creamSoft: "#FAEEE9", // sunken / hover surface

  // brand red scale
  brand50: "#FBE8E8",
  brand100: "#F9DFDF",
  brand200: "#F2D2D2",
  brand300: "#F5D3D0",
  brand500: "#D23B3A", // accent
  brand700: "#922424",

  // pastel secondaries (status + categories)
  peach: "#F5E5C7",
  mint: "#A8D9C4",
  lavender: "#C9A8E0",
  sky: "#D6E5F2",
  linkBlue: "#4A6BC0",
  statPurple: "#7004B8",
} as const;

/**
 * Semantic color roles — what screens actually reference. Maps the raw palette
 * to UI intent so the system stays cohesive and re-themeable.
 */
export const colors = {
  // surfaces
  surface: palette.cream, // page background
  raised: "#FFFFFF", // cards / tables / sidebar
  sunken: palette.creamSoft, // hover rows, subtle fills

  // text
  ink: palette.ink,
  muted: "#7A5A5A", // secondary text (warm muted, not cold gray)
  faint: "#A98C8C", // tertiary / placeholders

  // structure
  border: "#EFE0DC", // hairline borders
  borderStrong: "#E4CFCB",

  // brand accent
  accent: palette.brand500,
  accentHover: palette.brand700,
  accentSoft: palette.brand50,
  accentText: "#FFFFFF",

  // status semantics
  success: "#2F7D5B",
  successSoft: palette.mint,
  successBg: "#EAF6F0",
  warn: "#B4761A",
  warnSoft: palette.peach,
  warnBg: "#FBF1DE",
  danger: palette.brand500,
  dangerBg: palette.brand50,
  info: palette.linkBlue,
  infoBg: palette.sky,

  // pastels (category accents)
  peach: palette.peach,
  mint: palette.mint,
  lavender: palette.lavender,
  sky: palette.sky,
  statPurple: palette.statPurple,

  // legacy aliases (kept so any not-yet-migrated code still resolves)
  text: palette.ink,
  bg: palette.cream,
  card: "#FFFFFF",
  amber: "#B4761A",
  amberBg: "#FBF1DE",
  accentBg: palette.brand50,
  mutedBg: palette.creamSoft,
} as const;

// ── Spacing / radius / type scale (mirrored to tailwind) ─────────────────────
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

export const fontFamily = {
  display: "Corben_700Bold", // serif headings
  displayRegular: "Corben_400Regular",
  body: "DMSans_400Regular", // sans body / UI
  bodyMedium: "DMSans_500Medium",
  bodySemi: "DMSans_600SemiBold",
  bodyBold: "DMSans_700Bold",
} as const;

// ── Phase identity colors ────────────────────────────────────────────────────
// Each lifecycle phase owns a hue, used by BOTH the header readiness rings and
// the module tabs that feed them — the shared hue is what visually links a ring
// to its tabs. The sequence reads as a journey across the event's arc:
// dawn amber (pre-plan) → brand-red heat (planning) → showtime plum (day-of) →
// afterglow green (post). `main` draws rings/underlines/labels, `soft` is the
// wash behind a highlighted tab, `glow` feeds web box-shadows / halos.
export const phaseColors: Record<
  PhaseKey,
  { main: string; soft: string; glow: string }
> = {
  prePlan: { main: "#C9821E", soft: "#F9EDD8", glow: "rgba(201,130,30,0.38)" },
  planning: {
    main: palette.brand500,
    soft: palette.brand50,
    glow: "rgba(210,59,58,0.38)",
  },
  dayOf: { main: "#8A3FC2", soft: "#F2E7FA", glow: "rgba(138,63,194,0.38)" },
  post: { main: "#2F7D5B", soft: "#E6F4ED", glow: "rgba(47,125,91,0.38)" },
} as const;

/**
 * Which phase HUE a module tab wears — extends the scoring map
 * (MODULE_READY_PHASE) with display-only assignments for modules that have no
 * ready gate. Custom modules default to planning (they're prep work).
 */
const MODULE_DISPLAY_PHASE: Record<string, PhaseKey> = {
  planning_doc: "planning",
  retro: "post",
};

export function modulePhase(moduleKey: string): PhaseKey {
  return (
    MODULE_READY_PHASE[moduleKey] ?? MODULE_DISPLAY_PHASE[moduleKey] ?? "planning"
  );
}

// ── Readiness → semantic color (0–100) ───────────────────────────────────────
// All four helpers below derive their tier from the shared `readinessTier`
// (<34 danger · <67 warn · else success) so the threshold rule lives in ONE
// place; this layer only maps tier → color / NativeWind class.

/** <34 danger · <67 warn · else success. */
export function readinessColor(pct: number): string {
  return { danger: colors.danger, warn: colors.warn, success: colors.success }[
    readinessTier(pct)
  ];
}

export function readinessBg(pct: number): string {
  return {
    danger: colors.dangerBg,
    warn: colors.warnBg,
    success: colors.successBg,
  }[readinessTier(pct)];
}

/** NativeWind class helpers for readiness, so screens stay className-driven. */
export function readinessTextClass(pct: number): string {
  return { danger: "text-danger", warn: "text-warn", success: "text-success" }[
    readinessTier(pct)
  ];
}
