/**
 * Pure, dependency-free logic for the audience picker's numeric filter
 * fields (`AudiencesView.tsx`'s `DebouncedNumberField`) — split out so it's
 * testable without rendering (this app's jest config only picks up
 * `*.test.ts`, not `.tsx`; see `jest.config.js`'s doc).
 *
 * `resolveNumberField`/`flushPendingNumberFields` are the SAME functions
 * `DebouncedNumberField` uses for its debounce timer AND `handleSave` uses
 * to flush every mounted numeric field synchronously before saving — the
 * single source of truth that makes Save WYSIWYG: whatever's on screen when
 * Save is tapped is what gets persisted, never a stale pre-debounce value,
 * and a still-malformed field blocks the save instead of silently reverting
 * to its last-committed number.
 */

/** A numeric field's resolved state, given its raw typed text. */
export type NumberFieldResolution = { value: number | undefined; invalid: boolean };

/**
 * Resolves a numeric field's raw typed text: blank → valid `undefined`
 * (clears the criterion); text that doesn't parse → `invalid` (the field's
 * committed value must NOT change); otherwise the parsed number.
 */
export function resolveNumberField(
  raw: string,
  parse: (raw: string) => number | undefined,
): NumberFieldResolution {
  const trimmed = raw.trim();
  if (!trimmed) return { value: undefined, invalid: false };
  const parsed = parse(trimmed);
  if (parsed === undefined) return { value: undefined, invalid: true };
  return { value: parsed, invalid: false };
}

/** One mounted numeric field's current raw text + how to parse it — what
 *  `DebouncedNumberField` mirrors into `AudienceForm`'s `rawFieldsRef` on
 *  every keystroke so a flush can read it synchronously at save time. */
export type PendingNumberField = {
  key: string;
  raw: string;
  parse: (raw: string) => number | undefined;
};

export type FlushPendingResult<F> =
  | { ok: true; patch: Partial<F> }
  | { ok: false; invalidKeys: string[] };

/**
 * Resolves every currently-mounted numeric field's raw text at once. If ANY
 * field is malformed, the WHOLE flush is rejected (`ok: false`) rather than
 * silently applying the fields that DID parse — a half-applied save (some
 * edits landed, one silently didn't) is its own kind of data loss.
 */
export function flushPendingNumberFields<F>(fields: PendingNumberField[]): FlushPendingResult<F> {
  const patch: Record<string, number | undefined> = {};
  const invalidKeys: string[] = [];
  for (const f of fields) {
    const resolution = resolveNumberField(f.raw, f.parse);
    if (resolution.invalid) {
      invalidKeys.push(f.key);
      continue;
    }
    patch[f.key] = resolution.value;
  }
  if (invalidKeys.length > 0) return { ok: false, invalidKeys };
  return { ok: true, patch: patch as Partial<F> };
}

export function centsToDollarsStr(cents?: number | null): string {
  if (cents == null) return "";
  return String(Math.round(cents) / 100);
}

export function dollarsStrToCents(str: string): number | undefined {
  const trimmed = str.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100);
}

export function intToStr(n?: number | null): string {
  return n != null ? String(n) : "";
}

export function intStrToNumber(str: string): number | undefined {
  const n = Number(str.trim());
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/** Prefix `AudiencesView`'s Exclude-people-who group's `DebouncedNumberField`s
 *  mangle onto their `fieldKey` (e.g. `"exclude:giftCountMin"`) so they
 *  register into the SAME shared `rawFieldsRef` the Filters group's fields
 *  use, without colliding on key — both groups' numeric fields flush
 *  together on Save (one shared WYSIWYG registry, per the file doc), and
 *  `splitExcludePatch` below is what routes the combined flush back into
 *  the two separate `filters`/`excludeFilters` patches. */
export const EXCLUDE_FIELD_PREFIX = "exclude:";

/**
 * Splits a flushed patch's keys into the include-side and exclude-side
 * partitions, stripping `EXCLUDE_FIELD_PREFIX` off the exclude keys.
 * `flushPendingNumberFields` itself is agnostic to WHICH group a field
 * belongs to (it just resolves raw text → numbers) — this is the one place
 * that routes the combined result back to `filters`/`excludeFilters`.
 */
export function splitExcludePatch<F>(
  patch: Record<string, number | undefined>,
): { include: Partial<F>; exclude: Partial<F> } {
  const include: Record<string, number | undefined> = {};
  const exclude: Record<string, number | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith(EXCLUDE_FIELD_PREFIX)) {
      exclude[key.slice(EXCLUDE_FIELD_PREFIX.length)] = value;
    } else {
      include[key] = value;
    }
  }
  return { include: include as Partial<F>, exclude: exclude as Partial<F> };
}
