// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `gridView.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  rowActions,
  type RowActionId,
  type RowActionRow,
  type RowActionViewer,
} from "./rowActions";

/** An ordinary card charge: somebody's card, nothing marked, synced source. */
const plain: RowActionRow = {
  correctable: false,
  isMarkedTransfer: false,
  payoutProcessor: null,
  isPersonal: false,
  repaymentStatus: null,
  hasPayee: true,
};

const manager: RowActionViewer = { isManager: true, isOwnCharge: false };
const bookkeeper: RowActionViewer = { isManager: false, isOwnCharge: false };
const payer: RowActionViewer = { isManager: false, isOwnCharge: true };

const ids = (row: RowActionRow, viewer: RowActionViewer): RowActionId[] =>
  rowActions(row, viewer).map((a) => a.id);

describe("rowActions — who is offered what", () => {
  test("an ordinary charge offers a manager exactly one thing", () => {
    expect(ids(plain, manager)).toEqual(["markPersonal"]);
  });

  test("the PAYER may flag their own charge without being a manager", () => {
    expect(ids(plain, payer)).toEqual(["markPersonal"]);
  });

  test("a bookkeeper looking at somebody else's charge is offered nothing", () => {
    // The renderer draws no `⋯` at all for this — an empty menu is a dead
    // control, which is what the split was for.
    expect(ids(plain, bookkeeper)).toEqual([]);
  });

  test("a row with no resolvable payee asks a MANAGER who owes it, and offers a bookkeeper nothing", () => {
    const noPayee = { ...plain, hasPayee: false };
    expect(ids(noPayee, manager)).toEqual(["markPersonalNamingPayer"]);
    expect(ids(noPayee, payer)).toEqual([]);
    expect(ids(noPayee, bookkeeper)).toEqual([]);
  });
});

describe("rowActions — the personal flag, both directions", () => {
  const flagged = { ...plain, isPersonal: true, repaymentStatus: "pending" };

  test("an unpaid personal charge offers the un-mark, not a second mark", () => {
    expect(ids(flagged, manager)).toEqual(["unmarkPersonal"]);
    expect(ids(flagged, payer)).toEqual(["unmarkPersonal"]);
  });

  test("a REPAID one offers neither — the server refuses to un-flag a settled charge", () => {
    expect(ids({ ...flagged, repaymentStatus: "paid" }, manager)).toEqual([]);
  });

  test("a bookkeeper who is neither manager nor payer can't undo somebody's flag", () => {
    expect(ids(flagged, bookkeeper)).toEqual([]);
  });
});

describe("rowActions — un-marking a marking is manager-only", () => {
  const transfer = { ...plain, isMarkedTransfer: true, hasPayee: false };
  const payout = { ...plain, payoutProcessor: "stripe", hasPayee: false };

  test("a marked transfer un-marks both legs", () => {
    expect(ids(transfer, manager)).toEqual([
      "markPersonalNamingPayer",
      "unmarkTransfer",
    ]);
    expect(ids(transfer, bookkeeper)).toEqual([]);
  });

  test("a processor payout un-marks alone — it has no leg to pair with", () => {
    expect(ids(payout, manager)).toEqual([
      "markPersonalNamingPayer",
      "unmarkPayout",
    ]);
    expect(ids(payout, payer)).toEqual([]);
  });

  test("transfer wins over payout if a row somehow claims both", () => {
    // The server won't produce this (each mutation refuses the other's rows),
    // but printing one is better than printing a contradiction.
    expect(ids({ ...transfer, payoutProcessor: "stripe" }, manager)).toContain(
      "unmarkTransfer",
    );
    expect(
      ids({ ...transfer, payoutProcessor: "stripe" }, manager),
    ).not.toContain("unmarkPayout");
  });
});

describe("rowActions — correcting a row", () => {
  test("only where the SERVER said the source accepts it, and only for a manager", () => {
    const correctable = { ...plain, correctable: true };
    expect(ids(correctable, manager)).toEqual(["markPersonal", "correct"]);
    expect(ids(correctable, payer)).toEqual(["markPersonal"]);
    expect(ids(plain, manager)).not.toContain("correct");
  });
});

describe("rowActions — the menu itself", () => {
  test("personal first, un-marking second, correcting last", () => {
    const everything: RowActionRow = {
      correctable: true,
      isMarkedTransfer: true,
      payoutProcessor: null,
      isPersonal: false,
      repaymentStatus: null,
      hasPayee: true,
    };
    expect(ids(everything, manager)).toEqual([
      "markPersonal",
      "unmarkTransfer",
      "correct",
    ]);
  });

  test("every offered action carries a label, and no id is offered twice", () => {
    const everything: RowActionRow = {
      correctable: true,
      isMarkedTransfer: true,
      payoutProcessor: null,
      isPersonal: false,
      repaymentStatus: null,
      hasPayee: true,
    };
    const actions = rowActions(everything, manager);
    for (const action of actions) {
      expect(action.label.length).toBeGreaterThan(0);
    }
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });
});
