import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { isCandidateShaped } from "../givingCandidates";
import {
  CASHBACK_SOURCE_CATEGORY,
  INTEREST_SOURCE_CATEGORY,
} from "@events-os/shared";

/**
 * What may be offered as an unbooked gift.
 *
 * The rule reaches two surfaces at once — the giving-candidates desk and the
 * reconciliation panel's "credits that look like giving" lead — which is the
 * point of having one definition. It is also why a false positive here is
 * expensive: on 2026-08-17 the panel told the owner that $1.76 of "giving"
 * was recorded as nothing, and all three rows were the bank paying its own
 * account (two Increase cashback payments and one interest payment).
 */
function txn(over: Partial<Doc<"transactions">> = {}): Doc<"transactions"> {
  return {
    _id: "w1" as Doc<"transactions">["_id"],
    _creationTime: 0,
    chapterId: "kh1" as Doc<"transactions">["chapterId"],
    source: "increase_ach",
    flow: "inflow",
    amountCents: 85,
    postedAt: 0,
    status: "reconciled",
    createdAt: 0,
    ...over,
  } as Doc<"transactions">;
}

describe("isCandidateShaped", () => {
  test("a plain bank credit with no explanation is still a candidate", () => {
    expect(isCandidateShaped(txn({ description: "ACH credit from a donor" }))).toBe(true);
  });

  test("bank CASHBACK is not giving", () => {
    expect(
      isCandidateShaped(
        txn({
          description: "Cashback payment for 2026-07 for Seyi Olujide",
          sourceCategory: CASHBACK_SOURCE_CATEGORY,
        }),
      ),
    ).toBe(false);
  });

  test("account INTEREST is not giving", () => {
    expect(
      isCandidateShaped(
        txn({
          description: "Interest payment for 2026-07",
          sourceCategory: INTEREST_SOURCE_CATEGORY,
        }),
      ),
    ).toBe(false);
  });

  test("a payer's fee coverage is not giving", () => {
    expect(
      isCandidateShaped(
        txn({ merchantName: "Processing fee covered by payer", feeCoverageOrigin: "repayment" }),
      ),
    ).toBe(false);
  });

  test("a refund credit is not giving", () => {
    expect(
      isCandidateShaped(
        txn({ refundsTransactionId: "w2" as Doc<"transactions">["_id"] }),
      ),
    ).toBe(false);
  });

  test("the pre-existing rules still hold", () => {
    expect(isCandidateShaped(txn({ flow: "outflow" }))).toBe(false);
    expect(isCandidateShaped(txn({ cardId: "ts1" as Doc<"cards">["_id"] }))).toBe(false);
    expect(isCandidateShaped(txn({ source: "repayment" }))).toBe(false);
    expect(isCandidateShaped(txn({ merchantName: "STRIPE TRANSFER" }))).toBe(false);
  });

  test("an UNSTAMPED interest row is still a candidate — why 0078 exists", () => {
    // `sourceCategory` only arrived 2026-08-13, and migration 0066 stamped
    // cashback alone. An interest row ingested before that carries no marker,
    // so the read path cannot recognize it and the stamp is the only fix.
    // This asserts the gap the migration closes rather than pretending the
    // read path handles it: if this ever flips to `false`, someone taught
    // `autoExplainedKind` to infer from text, which is the doctrine
    // `sourceCategory` exists to avoid.
    expect(isCandidateShaped(txn({ description: "Interest payment for 2026-07" }))).toBe(true);
  });
});
