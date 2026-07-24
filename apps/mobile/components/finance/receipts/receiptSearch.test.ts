import { describe, expect, test } from "@jest/globals";
import { receiptMatchesSearch } from "./receiptSearch";

const audible = { merchant: "Audible", amountCents: 1636 };
const costco = { merchant: "Costco Wholesale", amountCents: 4210 };
const noAmount = { merchant: "Mystery Vendor", amountCents: null };
const noMerchant = { merchant: null, amountCents: 999 };

describe("receiptMatchesSearch", () => {
  test("empty query matches everything", () => {
    expect(receiptMatchesSearch(audible, "")).toBe(true);
    expect(receiptMatchesSearch(audible, "   ")).toBe(true);
    expect(receiptMatchesSearch(noAmount, "")).toBe(true);
  });

  test("matches on merchant name, case-insensitively", () => {
    expect(receiptMatchesSearch(audible, "aud")).toBe(true);
    expect(receiptMatchesSearch(costco, "COSTCO")).toBe(true);
    expect(receiptMatchesSearch(costco, "wholesale")).toBe(true);
    expect(receiptMatchesSearch(audible, "costco")).toBe(false);
  });

  test("matches an amount typed as dollars, with $, or as raw cents", () => {
    // The owner's Audible $16.36 case, every way it might be typed.
    expect(receiptMatchesSearch(audible, "16.36")).toBe(true);
    expect(receiptMatchesSearch(audible, "$16.36")).toBe(true);
    expect(receiptMatchesSearch(audible, "1636")).toBe(true);
    expect(receiptMatchesSearch(audible, "16.37")).toBe(false);
  });

  test("a receipt with no amount only matches by merchant", () => {
    expect(receiptMatchesSearch(noAmount, "mystery")).toBe(true);
    expect(receiptMatchesSearch(noAmount, "16.36")).toBe(false);
  });

  test("a receipt with no merchant still matches by amount", () => {
    expect(receiptMatchesSearch(noMerchant, "9.99")).toBe(true);
    expect(receiptMatchesSearch(noMerchant, "audible")).toBe(false);
  });
});
