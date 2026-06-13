/**
 * Shared design tokens for the Events OS app. Light theme, minimal palette.
 * Keep all raw colors / spacing here so screens never hardcode hex values.
 */
export const colors = {
  text: "#111827",
  muted: "#6b7280",
  accent: "#2563eb",
  bg: "#f9fafb",
  card: "#ffffff",
  border: "#e5e7eb",
  success: "#16a34a",
  amber: "#d97706",
  danger: "#dc2626",
  // tinted surfaces for badges/pills
  accentBg: "#eff6ff",
  successBg: "#f0fdf4",
  amberBg: "#fffbeb",
  dangerBg: "#fef2f2",
  mutedBg: "#f3f4f6",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
};

/** Readiness → semantic color. <34 danger, <67 amber, else success. */
export function readinessColor(pct: number): string {
  if (pct < 34) return colors.danger;
  if (pct < 67) return colors.amber;
  return colors.success;
}

export function readinessBg(pct: number): string {
  if (pct < 34) return colors.dangerBg;
  if (pct < 67) return colors.amberBg;
  return colors.successBg;
}
