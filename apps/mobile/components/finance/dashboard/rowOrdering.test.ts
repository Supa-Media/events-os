import { describe, expect, test } from "@jest/globals";
import { orderRows } from "./rowOrdering";

function row(id: string, approvalStatus: string) {
  return { id, approvalStatus };
}

describe("orderRows", () => {
  test("pins submitted rows regardless of fold state, unfolded shows up to 5 of the rest", () => {
    const rows = [
      row("a", "approved"),
      row("b", "submitted"),
      row("c", "approved"),
      row("d", "draft"),
      row("e", "approved"),
      row("f", "approved"),
      row("g", "approved"),
      row("h", "submitted"),
    ];
    const { pinned, visible, hidden } = orderRows(rows, false, 5);
    expect(pinned.map((r) => r.id)).toEqual(["b", "h"]);
    expect(visible.map((r) => r.id)).toEqual(["a", "c", "d", "e", "f"]);
    expect(hidden.map((r) => r.id)).toEqual(["g"]);
  });

  test("expanded shows every non-pinned row, nothing hidden", () => {
    const rows = [row("a", "approved"), row("b", "submitted"), row("c", "approved")];
    const { pinned, visible, hidden } = orderRows(rows, true, 1);
    expect(pinned.map((r) => r.id)).toEqual(["b"]);
    expect(visible.map((r) => r.id)).toEqual(["a", "c"]);
    expect(hidden).toEqual([]);
  });

  test("no rows over the fold threshold: nothing hidden", () => {
    const rows = [row("a", "approved"), row("b", "approved")];
    const { hidden } = orderRows(rows, false, 5);
    expect(hidden).toEqual([]);
  });
});
