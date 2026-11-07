import { describe, expect, test } from "@jest/globals";
import {
  applySendBackReason,
  reviewOrder,
  SEND_BACK_REASONS,
} from "./queueDisplay";

describe("reviewOrder", () => {
  test("decidable rows first, then the ones waiting on someone else, each in server order", () => {
    const rows = [
      { id: "a", canReview: false },
      { id: "b", canReview: true },
      { id: "c", canReview: false },
      { id: "d", canReview: true },
    ];
    const { decidable, waitingOnOthers } = reviewOrder(rows);
    expect(decidable.map((r) => r.id)).toEqual(["b", "d"]);
    expect(waitingOnOthers.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("applySendBackReason", () => {
  const [first, second] = SEND_BACK_REASONS;

  test("fills an empty note", () => {
    expect(applySendBackReason("  ", first.note)).toBe(first.note);
  });

  test("swaps one untouched reason for another", () => {
    expect(applySendBackReason(first.note, second.note)).toBe(second.note);
  });

  test("never throws away what the reviewer typed", () => {
    expect(applySendBackReason("Wrong event.", first.note)).toBe(
      `Wrong event. ${first.note}`,
    );
  });

  test("does not add the same reason twice", () => {
    const typed = `Wrong event. ${first.note}`;
    expect(applySendBackReason(typed, first.note)).toBe(typed);
  });
});
