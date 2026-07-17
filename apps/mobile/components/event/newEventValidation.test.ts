import { describe, expect, test } from "@jest/globals";
import { getCreateBlockReason, type CreateFormState } from "./newEventValidation";

const VALID: CreateFormState = {
  selectedId: "tmpl_123",
  effectiveName: "Test",
  date: "2026-07-24",
  time: "10:40",
};

describe("getCreateBlockReason", () => {
  test("returns null (unblocked) when every field is valid", () => {
    expect(getCreateBlockReason(VALID)).toBeNull();
  });

  test("returns null for the ad-hoc blank-event selection, same as a real template id", () => {
    expect(getCreateBlockReason({ ...VALID, selectedId: "blank" })).toBeNull();
  });

  test("blocks on no template/blank selected — the live-blocker root cause", () => {
    expect(getCreateBlockReason({ ...VALID, selectedId: null })).toBe(
      "Pick a template — or start blank.",
    );
  });

  test("blocks on an empty name", () => {
    expect(getCreateBlockReason({ ...VALID, effectiveName: "   " })).toBe(
      "Give the event a name.",
    );
  });

  test("blocks on no date entered", () => {
    expect(getCreateBlockReason({ ...VALID, date: "" })).toBe("Pick an event date.");
  });

  test("blocks on a date in the wrong shape (e.g. a raw native-input format that never got normalized to YYYY-MM-DD)", () => {
    expect(getCreateBlockReason({ ...VALID, date: "07/24/2026" })).toBe(
      "That date isn't valid — check the year, month, and day.",
    );
  });

  test("blocks on no start time entered", () => {
    expect(getCreateBlockReason({ ...VALID, time: "" })).toBe(
      "Set a start time — the run of show is timed from it.",
    );
  });

  test("blocks on an invalid start time", () => {
    expect(getCreateBlockReason({ ...VALID, time: "25:99" })).toBe(
      "That start time isn't valid — check the hour and minute.",
    );
  });

  test("template selection is checked before name/date/time — matches handleCreate's order", () => {
    expect(
      getCreateBlockReason({
        selectedId: null,
        effectiveName: "",
        date: "",
        time: "",
      }),
    ).toBe("Pick a template — or start blank.");
  });
});
