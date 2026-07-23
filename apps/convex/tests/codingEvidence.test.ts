import { describe, expect, test } from "vitest";
import {
  buildCodingEvidence,
  type EvidenceTxn,
} from "../lib/codingEvidence";
import { merchantMatch } from "../lib/merchantSimilarity";

/**
 * Unit tests for the PURE coding-evidence builder (`lib/codingEvidence.ts`) —
 * no Convex harness needed. Pins the two signals the LLM prompt is grounded
 * with: (1) merchant history from HUMAN-confirmed codings only, and (2)
 * tier-1/2 corroborating spend on candidate budgets. The DB adapter
 * (`aiCodingData.gatherCodingEvidence`) is a thin shell over this.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 15);

function txn(over: Partial<EvidenceTxn> & { id: string }): EvidenceTxn {
  return {
    postedAt: NOW,
    status: "categorized",
    merchantName: "Office Depot",
    ...over,
  };
}

describe("merchantMatch (shared similarity primitive)", () => {
  test("exact normalized-merchant match beats fuzzy", () => {
    expect(
      merchantMatch({ merchantName: "Office Depot" }, { merchantName: "office depot" }),
    ).toBe("exact");
  });
  test("token overlap (noise words stripped) is fuzzy", () => {
    expect(
      merchantMatch(
        { merchantName: "SQ *HOME DEPOT INC" },
        { merchantName: "Home Depot Supply Co" },
      ),
    ).toBe("fuzzy");
  });
  test("no shared tokens → null", () => {
    expect(
      merchantMatch({ merchantName: "Office Depot" }, { merchantName: "Delta Airlines" }),
    ).toBeNull();
  });
});

describe("buildCodingEvidence — merchant history", () => {
  test("counts human-coded charges with a similar merchant, grouped by dimension", () => {
    const evidence = buildCodingEvidence({
      subject: { merchantName: "Office Depot", postedAt: NOW },
      priorTxns: [
        txn({ id: "a", categoryId: "cat_supplies", budgetId: "bud_retreat" }),
        txn({ id: "b", merchantName: "office depot", categoryId: "cat_supplies" }),
        txn({ id: "c", merchantName: "Delta Airlines", categoryId: "cat_travel" }),
      ],
      candidateBudgetIds: new Set(),
      nearbyWindowMs: 10 * DAY,
      topK: 5,
    });

    const cat = evidence.merchantHistory.find((e) => e.kind === "category");
    expect(cat).toMatchObject({ id: "cat_supplies", count: 2, exact: true });
    // The Delta charge shares no merchant tokens → never counted.
    expect(
      evidence.merchantHistory.some((e) => e.id === "cat_travel"),
    ).toBe(false);
    const bud = evidence.merchantHistory.find((e) => e.kind === "budget");
    expect(bud).toMatchObject({ id: "bud_retreat", count: 1 });
  });

  test("ignores un-accepted AI guesses — only HUMAN-confirmed codings count", () => {
    const evidence = buildCodingEvidence({
      subject: { merchantName: "Office Depot", postedAt: NOW },
      priorTxns: [
        // Unreviewed row that merely carries a category — NOT a human decision.
        txn({ id: "u", status: "unreviewed", categoryId: "cat_supplies" }),
        // A settled row with no link at all — nothing to learn from.
        txn({ id: "n", status: "reconciled", categoryId: null, budgetId: null }),
      ],
      candidateBudgetIds: new Set(),
      nearbyWindowMs: 10 * DAY,
      topK: 5,
    });
    expect(evidence.merchantHistory).toEqual([]);
  });

  test("empty when the subject has no matchable merchant tokens", () => {
    const evidence = buildCodingEvidence({
      subject: { merchantName: "", postedAt: NOW },
      priorTxns: [txn({ id: "a", categoryId: "cat_supplies" })],
      candidateBudgetIds: new Set(),
      nearbyWindowMs: 10 * DAY,
      topK: 5,
    });
    expect(evidence.merchantHistory).toEqual([]);
  });

  test("respects topK", () => {
    const priorTxns = Array.from({ length: 8 }, (_, i) =>
      txn({ id: `t${i}`, categoryId: `cat_${i}` }),
    );
    const evidence = buildCodingEvidence({
      subject: { merchantName: "Office Depot", postedAt: NOW },
      priorTxns,
      candidateBudgetIds: new Set(),
      nearbyWindowMs: 10 * DAY,
      topK: 3,
    });
    expect(evidence.merchantHistory).toHaveLength(3);
  });
});

describe("buildCodingEvidence — candidate budget spend (tier 1/2)", () => {
  test("tier-1 nearby count + tier-2 similar merchant on candidate budgets only", () => {
    const evidence = buildCodingEvidence({
      subject: { merchantName: "Office Depot", postedAt: NOW },
      priorTxns: [
        // On a candidate budget, within the window AND similar merchant.
        txn({ id: "a", budgetId: "bud_cand", postedAt: NOW - 2 * DAY }),
        // On the same candidate, far in time, different merchant → neither.
        txn({
          id: "b",
          budgetId: "bud_cand",
          postedAt: NOW - 300 * DAY,
          merchantName: "Delta Airlines",
        }),
        // On a NON-candidate budget → excluded from this signal.
        txn({ id: "c", budgetId: "bud_other", postedAt: NOW }),
      ],
      candidateBudgetIds: new Set(["bud_cand"]),
      nearbyWindowMs: 10 * DAY,
      topK: 5,
    });

    expect(evidence.candidateBudgetEvidence).toHaveLength(1);
    expect(evidence.candidateBudgetEvidence[0]).toMatchObject({
      budgetId: "bud_cand",
      nearbyCount: 1,
      similarMerchant: true,
    });
  });

  test("a candidate budget with neither nearby nor similar spend is omitted", () => {
    const evidence = buildCodingEvidence({
      subject: { merchantName: "Office Depot", postedAt: NOW },
      priorTxns: [
        txn({
          id: "a",
          budgetId: "bud_cand",
          postedAt: NOW - 300 * DAY,
          merchantName: "Delta Airlines",
        }),
      ],
      candidateBudgetIds: new Set(["bud_cand"]),
      nearbyWindowMs: 10 * DAY,
      topK: 5,
    });
    expect(evidence.candidateBudgetEvidence).toEqual([]);
  });
});
