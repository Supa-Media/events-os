/**
 * Option color → concrete style.
 *
 * Select/status column options carry a `color` string (red, amber, green, …)
 * from `@events-os/shared`. NativeWind can't build classes from dynamic strings
 * (`bg-${color}` won't compile), so option tags style with inline hex values
 * from this map — the same approach `Avatar` uses for its pastel initials.
 *
 * Hues reuse the brand tokens in `theme.ts` where they fit so tags stay on-brand.
 */
import { colors } from "./theme";

export interface OptionStyle {
  bg: string;
  text: string;
}

const DEFAULT: OptionStyle = { bg: colors.sunken, text: colors.muted };

const MAP: Record<string, OptionStyle> = {
  red: { bg: colors.dangerBg, text: colors.danger },
  amber: { bg: colors.warnBg, text: colors.warn },
  green: { bg: colors.successBg, text: colors.success },
  blue: { bg: colors.infoBg, text: colors.info },
  teal: { bg: "#DCF0E8", text: "#1F5A41" },
  purple: { bg: "#EFE2F7", text: "#4B2A66" },
  pink: { bg: "#F9DCEA", text: "#9B2C5E" },
  gray: { bg: colors.sunken, text: colors.muted },
  orange: { bg: "#FBEAD2", text: "#7A4B12" },
};

/** Resolve an option color string to `{ bg, text }` hex values (safe default). */
export function optionColor(color?: string | null): OptionStyle {
  if (!color) return DEFAULT;
  return MAP[color] ?? DEFAULT;
}
