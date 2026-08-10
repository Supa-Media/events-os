// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `reconcile/helpers.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  adaptReceiptSuggestions,
  suggestionMeta,
  suggestionTitle,
  suggestionWarning,
  type SuggestedReceipt,
} from "./receiptSuggestions";

/** One row exactly as `receipts.suggestedForTransaction` sends it — nested
 *  `match` block and all. This fixture IS the contract; if the query's shape
 *  moves, this is the test that says so. */
const wire = {
  receiptId: "rc_1",
  url: "https://files.example/rc_1.jpg",
  contentType: "image/jpeg",
  filename: "IMG_0421.jpg",
  source: "email",
  amountCents: 5830,
  receiptDate: Date.UTC(2026, 7, 3, 16, 0, 0),
  merchant: "Chipotle",
  ocrAmountCents: 5830,
  ocrDate: Date.UTC(2026, 7, 3, 16, 0, 0),
  ocrMerchant: "CHIPOTLE 2841",
  ocrError: null,
  createdAt: Date.UTC(2026, 7, 4, 12, 0, 0),
  match: {
    amountExact: true,
    amountDeltaCents: 0,
    daysApart: 1,
    withinDateWindow: true,
    merchantOverlap: true,
    pipelineSuggested: true,
  },
  score: 15,
};

function one(patch: Partial<SuggestedReceipt> = {}): SuggestedReceipt {
  return { ...adaptReceiptSuggestions([wire])[0], ...patch };
}

describe("adaptReceiptSuggestions", () => {
  test("flattens the query's row to what the UI actually renders", () => {
    expect(adaptReceiptSuggestions([wire])).toEqual([
      {
        receiptId: "rc_1",
        url: "https://files.example/rc_1.jpg",
        amountCents: 5830,
        receiptDate: wire.receiptDate,
        merchant: "Chipotle",
        amountMatches: true,
        filename: "IMG_0421.jpg",
        contentType: "image/jpeg",
      },
    ]);
  });

  // The reason the adapter exists: the caller may not be allowed to read the
  // query, or this bundle may be talking to a deployment that predates it.
  // "Loading", "no such function" and "forbidden" all have to render as no
  // suggestions rather than as a crash.
  test("anything that isn't a list of rows is simply no suggestions", () => {
    expect(adaptReceiptSuggestions(undefined)).toEqual([]);
    expect(adaptReceiptSuggestions(null)).toEqual([]);
    expect(
      adaptReceiptSuggestions(new Error("Could not find public function")),
    ).toEqual([]);
    expect(adaptReceiptSuggestions({ receipts: [wire] })).toEqual([]);
    expect(adaptReceiptSuggestions("nope")).toEqual([]);
  });

  test("drops rows with no receipt id and keeps the rest", () => {
    expect(adaptReceiptSuggestions([{ url: "x" }, null, 7, wire])).toHaveLength(1);
  });

  test("missing optional fields become null, never undefined or NaN", () => {
    expect(adaptReceiptSuggestions([{ receiptId: "rc_2" }])).toEqual([
      {
        receiptId: "rc_2",
        url: null,
        amountCents: null,
        receiptDate: null,
        merchant: null,
        amountMatches: false,
        filename: null,
        contentType: null,
      },
    ]);
  });

  test("an unreadable amount never passes as a match", () => {
    const [s] = adaptReceiptSuggestions([
      {
        receiptId: "rc_3",
        amountCents: null,
        ocrError: "unreadable",
        match: { amountExact: false },
      },
    ]);
    expect(s.amountMatches).toBe(false);
    expect(s.amountCents).toBeNull();
  });

  test("a missing `match` block reads as 'not a match', not as one", () => {
    expect(adaptReceiptSuggestions([{ receiptId: "rc_5" }])[0]?.amountMatches).toBe(
      false,
    );
  });

  test("accepts a flat `amountMatches` too, so a reshaped payload still works", () => {
    expect(
      adaptReceiptSuggestions([{ receiptId: "rc_6", amountMatches: true }])[0]
        ?.amountMatches,
    ).toBe(true);
  });

  test("accepts `_id` as the id, in case the query names it that way", () => {
    expect(adaptReceiptSuggestions([{ _id: "rc_4" }])[0]?.receiptId).toBe("rc_4");
  });
});

describe("suggestionTitle", () => {
  test("merchant first, then the file it arrived as, then something honest", () => {
    expect(suggestionTitle(one())).toBe("Chipotle");
    expect(suggestionTitle(one({ merchant: null }))).toBe("IMG_0421.jpg");
    expect(suggestionTitle(one({ merchant: null, filename: null }))).toBe(
      "Emailed receipt",
    );
  });
});

describe("suggestionMeta", () => {
  test("amount and date, the two facts that let you recognise your own receipt", () => {
    expect(suggestionMeta(one())).toBe("$58.30 · Aug 3");
  });

  test("says the total is missing rather than leaving a silent gap", () => {
    expect(suggestionMeta(one({ amountCents: null, receiptDate: null }))).toBe(
      "No total read",
    );
  });
});

describe("suggestionWarning", () => {
  test("silence on a clean match", () => {
    expect(suggestionWarning(one(), -5830)).toBeNull();
  });

  test("a mismatch reuses the attach-time sentence", () => {
    expect(
      suggestionWarning(one({ amountMatches: false, amountCents: 4217 }), -5830),
    ).toBe(
      "This receipt shows $42.17 but the charge is $58.30 — is this the right receipt, or does it only cover part of the charge?",
    );
  });

  test("an unread total asks the human to look before confirming", () => {
    expect(
      suggestionWarning(one({ amountMatches: false, amountCents: null }), -5830),
    ).toContain("check it covers the whole charge");
  });
});

