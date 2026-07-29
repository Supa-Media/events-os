import {
  MAILY_AUTOSAVE_DEBOUNCE_MS,
  decideAutosave,
  shouldResaveAfterCompletion,
} from "./mailyAutosave";

describe("decideAutosave", () => {
  it("never schedules on a locked (read-only) document, even with a real change", () => {
    expect(decideAutosave({ editable: false, changed: true, showingError: false })).toEqual({
      action: "skip",
    });
    expect(decideAutosave({ editable: false, changed: true, showingError: true })).toEqual({
      action: "skip",
    });
  });

  it("skips when nothing changed and no error is showing", () => {
    expect(decideAutosave({ editable: true, changed: false, showingError: false })).toEqual({
      action: "skip",
    });
  });

  it("clears a stale error when the content already matches what's saved again", () => {
    expect(decideAutosave({ editable: true, changed: false, showingError: true })).toEqual({
      action: "clear-error",
    });
  });

  it("schedules a debounced save on a real, editable change", () => {
    expect(decideAutosave({ editable: true, changed: true, showingError: false })).toEqual({
      action: "schedule",
      delayMs: MAILY_AUTOSAVE_DEBOUNCE_MS,
    });
  });

  it("schedules even while an error is showing — the retry is what clears it", () => {
    expect(decideAutosave({ editable: true, changed: true, showingError: true })).toEqual({
      action: "schedule",
      delayMs: MAILY_AUTOSAVE_DEBOUNCE_MS,
    });
  });
});

describe("shouldResaveAfterCompletion", () => {
  it("is false when nothing landed while the save was in flight", () => {
    expect(shouldResaveAfterCompletion('{"a":1}', '{"a":1}')).toBe(false);
  });

  it("is true when a newer edit landed while the save was in flight", () => {
    expect(shouldResaveAfterCompletion('{"a":1}', '{"a":2}')).toBe(true);
  });
});
