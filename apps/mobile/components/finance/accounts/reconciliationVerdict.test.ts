// No @types/jest / ambient globals configured for this package — import the
// test globals explicitly from @jest/globals, matching
// `components/orgchart/treeUtils.test.ts`.
import { describe, expect, test } from "@jest/globals";
import { condenseVerdict } from "./reconciliationVerdict";

/**
 * These pin the three things the condensed card can get catastrophically
 * wrong, all of which used to be caught by the working being visible
 * underneath and are now caught by nothing else:
 *
 *  1. Losing the SIGN. "More money than the books explain" and "the books
 *     claim money that is nowhere" are opposite investigations, and the card
 *     shows an absolute value beside a directional label — so if the label
 *     ever comes from the wrong branch, the reader is sent to the wrong end of
 *     the app with full confidence.
 *  2. Alarming about ZERO. An exact match must render as an exact match, not
 *     as "$0.00 unaccounted for" in a warning colour.
 *  3. Vouching for a zero we can't vouch for. Books and cash agreeing while a
 *     processor balance has never been read is a coincidence, not a
 *     reconciliation.
 */
describe("condenseVerdict", () => {
  test("an exact match reads as success and shows no figure", () => {
    const v = condenseVerdict({
      verdict: "balanced",
      differenceCents: 0,
      incomplete: false,
      missingTerms: [],
    });
    expect(v.kind).toBe("balanced");
    expect(v.tone).toBe("success");
    // Zero is a real state, not an alarm about nothing.
    expect(v.amountCents).toBe(0);
  });

  test("a zero we can't vouch for is unknowable, not balanced", () => {
    const v = condenseVerdict({
      verdict: "balanced",
      differenceCents: 0,
      incomplete: true,
      missingTerms: ["stripe"],
    });
    expect(v.kind).toBe("unknowable");
    // Not success: the two sides matching proves nothing while a whole pile of
    // money is missing from one of them.
    expect(v.tone).toBe("warn");
    expect(v.missingLabel).toBe("Stripe");
  });

  test("names every unread vendor, so the reader knows where to go", () => {
    const v = condenseVerdict({
      verdict: "balanced",
      differenceCents: 0,
      incomplete: true,
      missingTerms: ["stripe", "givebutter"],
    });
    expect(v.missingLabel).toBe("Stripe or Givebutter");
  });

  test("more cash than books keeps its direction and loses its sign only in the magnitude", () => {
    const v = condenseVerdict({
      verdict: "cash_exceeds_books",
      differenceCents: 61468,
      incomplete: false,
      missingTerms: [],
    });
    expect(v.kind).toBe("gap");
    expect(v.cashHigh).toBe(true);
    expect(v.amountCents).toBe(61468);
  });

  test("books exceeding cash is the opposite direction at the same magnitude", () => {
    const v = condenseVerdict({
      verdict: "books_exceed_cash",
      differenceCents: -61468,
      incomplete: false,
      missingTerms: [],
    });
    expect(v.kind).toBe("gap");
    expect(v.cashHigh).toBe(false);
    // Displayed positive beside a directional label — never as "-$614.68".
    expect(v.amountCents).toBe(61468);
  });

  test("a one-cent difference is still a gap — there is no tolerance band", () => {
    const v = condenseVerdict({
      verdict: "books_exceed_cash",
      differenceCents: -1,
      incomplete: false,
      missingTerms: [],
    });
    expect(v.kind).toBe("gap");
    expect(v.amountCents).toBe(1);
  });

  test("an incomplete money side still reports a real difference as a gap", () => {
    // Missing Givebutter makes the gap a floor rather than a final figure, but
    // it is a finding either way — the panel names the unread vendor in the
    // working instead of suppressing the number.
    const v = condenseVerdict({
      verdict: "books_exceed_cash",
      differenceCents: -5000,
      incomplete: true,
      missingTerms: ["givebutter"],
    });
    expect(v.kind).toBe("gap");
    expect(v.cashHigh).toBe(false);
    expect(v.missingLabel).toBe("Givebutter");
  });
});
