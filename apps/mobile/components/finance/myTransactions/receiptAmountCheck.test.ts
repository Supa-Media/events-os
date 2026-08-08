// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `reconcile/helpers.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { parseAmountToCents, receiptAmountMismatch } from "./receiptAmountCheck";

describe("parseAmountToCents", () => {
  test("reads what a person actually types on a receipt", () => {
    expect(parseAmountToCents("58.30")).toBe(5830);
    expect(parseAmountToCents("$58.30")).toBe(5830);
    expect(parseAmountToCents(" 1,234.50 ")).toBe(123450);
    expect(parseAmountToCents("58")).toBe(5800);
    expect(parseAmountToCents("58.3")).toBe(5830);
    expect(parseAmountToCents(".5")).toBe(50);
  });

  test("a half-typed or nonsense entry warns about nothing", () => {
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("   ")).toBeNull();
    expect(parseAmountToCents(".")).toBeNull();
    expect(parseAmountToCents("-58.30")).toBeNull();
    expect(parseAmountToCents("58.303")).toBeNull();
    expect(parseAmountToCents("about fifty")).toBeNull();
  });
});

describe("receiptAmountMismatch", () => {
  test("silence when it matches — including against a negative outflow", () => {
    expect(receiptAmountMismatch(5830, 5830)).toBeNull();
    expect(receiptAmountMismatch(5830, -5830)).toBeNull();
  });

  test("a short receipt asks the partial question", () => {
    expect(receiptAmountMismatch(4217, -5830)).toBe(
      "This receipt shows $42.17 but the charge is $58.30 — is this the right receipt, or does it only cover part of the charge?",
    );
  });

  test("an over-total receipt asks the other question", () => {
    expect(receiptAmountMismatch(9900, -5830)).toBe(
      "This receipt shows $99.00 but the charge is $58.30 — is this the right receipt, or does it cover more than this one charge?",
    );
  });
});
