import { describe, expect, test } from "@jest/globals";
import {
  dollarsStrToCents,
  flushPendingNumberFields,
  intStrToNumber,
  resolveNumberField,
} from "./audienceFilterFields";

describe("resolveNumberField", () => {
  test("blank text resolves to a valid, cleared criterion", () => {
    expect(resolveNumberField("", dollarsStrToCents)).toEqual({ value: undefined, invalid: false });
    expect(resolveNumberField("   ", intStrToNumber)).toEqual({ value: undefined, invalid: false });
  });

  test("a parseable number resolves to its value", () => {
    expect(resolveNumberField("500", dollarsStrToCents)).toEqual({ value: 50000, invalid: false });
    expect(resolveNumberField("12", intStrToNumber)).toEqual({ value: 12, invalid: false });
  });

  test("unparseable text is flagged invalid, not silently dropped", () => {
    expect(resolveNumberField("abc", dollarsStrToCents)).toEqual({ value: undefined, invalid: true });
    expect(resolveNumberField("12,000", intStrToNumber)).toEqual({ value: undefined, invalid: true });
  });
});

describe("flushPendingNumberFields — the Save WYSIWYG invariant", () => {
  test("a value typed but not yet debounce-committed is what Save persists", () => {
    // Repro from the reported bug: the field's LAST COMMITTED value is
    // $50 (5000 cents) — the user has since typed "500" ($500) but the
    // 400ms debounce hasn't fired yet when Save is tapped. The flush must
    // resolve straight from the raw text, not the stale committed value.
    const committedFilters = { givingLifetimeMinCents: 5000 };
    const pending = [
      { key: "givingLifetimeMinCents", raw: "500", parse: dollarsStrToCents },
    ];

    const flushed = flushPendingNumberFields<typeof committedFilters>(pending);

    expect(flushed).toEqual({ ok: true, patch: { givingLifetimeMinCents: 50000 } });
    const saved = { ...committedFilters, ...(flushed.ok ? flushed.patch : {}) };
    expect(saved.givingLifetimeMinCents).toBe(50000);
    expect(saved.givingLifetimeMinCents).not.toBe(committedFilters.givingLifetimeMinCents);
  });

  test("fields the user never touched aren't in the flush at all", () => {
    // Only fields whose DebouncedNumberField is currently mounted register —
    // an untouched/never-rendered field has no entry, so nothing overwrites
    // filters that were never on screen.
    const flushed = flushPendingNumberFields<{ giftCountMin?: number }>([]);
    expect(flushed).toEqual({ ok: true, patch: {} });
  });

  test("one malformed field blocks the ENTIRE flush — no partial save", () => {
    const pending = [
      { key: "givingLifetimeMinCents", raw: "500", parse: dollarsStrToCents },
      { key: "giftCountMin", raw: "not a number", parse: intStrToNumber },
    ];

    const flushed = flushPendingNumberFields(pending);

    expect(flushed.ok).toBe(false);
    if (!flushed.ok) {
      expect(flushed.invalidKeys).toEqual(["giftCountMin"]);
    }
    // Confirm there's genuinely no patch to accidentally apply on a `!ok` result.
    expect((flushed as { patch?: unknown }).patch).toBeUndefined();
  });

  test("clearing a field to blank is a valid flush, not a block", () => {
    const flushed = flushPendingNumberFields<{ attendedWithinDays?: number }>([
      { key: "attendedWithinDays", raw: "", parse: intStrToNumber },
    ]);
    expect(flushed).toEqual({ ok: true, patch: { attendedWithinDays: undefined } });
  });
});
