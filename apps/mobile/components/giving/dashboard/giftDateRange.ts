/**
 * Gifts ledger date-range presets (giving CRM v2, owner request #2 — robust
 * filtering) — pure preset → `{from, to}` resolution over `listGifts`'s new
 * `receivedAt` range args (`givingPlatform.ts#listGifts`). Dependency-free (no
 * `react-native` import) so it's unit-testable directly under this package's
 * jest config, mirroring `donorFilters.ts` / `csv.ts`'s own colocated
 * pure-helper precedent. `now` is always passed in (never read internally),
 * so every preset resolves deterministically in tests.
 */

export type GiftDatePreset = "all" | "30d" | "90d" | "ytd" | "custom";

const DAY_MS = 24 * 60 * 60 * 1000;

export type GiftDateRange = { from: number | undefined; to: number | undefined };

/**
 * Resolve a preset to the `listGifts` from/to args (both millis, inclusive).
 * "All time" is the open range (no narrowing at all). `custom` passes its own
 * bounds straight through — the screen's own date pickers already produce
 * millis, and either side may be left open.
 */
export function resolveGiftDateRange(
  preset: GiftDatePreset,
  now: number,
  custom?: { from?: number; to?: number },
): GiftDateRange {
  switch (preset) {
    case "30d":
      return { from: now - 30 * DAY_MS, to: undefined };
    case "90d":
      return { from: now - 90 * DAY_MS, to: undefined };
    case "ytd": {
      const year = new Date(now).getFullYear();
      return { from: new Date(year, 0, 1).getTime(), to: undefined };
    }
    case "custom":
      return { from: custom?.from, to: custom?.to };
    case "all":
    default:
      return { from: undefined, to: undefined };
  }
}

export const GIFT_DATE_PRESET_OPTIONS: { value: GiftDatePreset; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "ytd", label: "This year" },
  { value: "custom", label: "Custom range" },
];
