// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, test } from "@jest/globals";
import { normalizeScannedCode, shouldProcessScan } from "./ticketScan";

/**
 * Pure scan-lock/normalize logic behind `TicketScanner` — the camera
 * component itself isn't unit-tested (this app's convention, see
 * `helpers.test.ts`'s doc comment), but the dedup/cooldown decision it makes
 * on every `onBarcodeScanned` firing is plain logic and fully testable here.
 */

describe("normalizeScannedCode", () => {
  test("trims and uppercases", () => {
    expect(normalizeScannedCode(" pw-8fk2-qw9t ")).toBe("PW-8FK2-QW9T");
  });
});

describe("shouldProcessScan", () => {
  test("nothing locked yet → always processes", () => {
    expect(shouldProcessScan(null, "PW-AAAA-BBBB", 1000)).toBe(true);
  });

  test("same code, inside the cooldown → blocked", () => {
    expect(
      shouldProcessScan({ code: "PW-AAAA-BBBB", at: 1000 }, "PW-AAAA-BBBB", 1500),
    ).toBe(false);
  });

  test("a different code is never blocked by another code's lock", () => {
    expect(
      shouldProcessScan({ code: "PW-AAAA-BBBB", at: 1000 }, "PW-CCCC-DDDD", 1500),
    ).toBe(true);
  });

  test("same code, cooldown elapsed → processes again (e.g. after 'Scan next')", () => {
    expect(
      shouldProcessScan({ code: "PW-AAAA-BBBB", at: 1000 }, "PW-AAAA-BBBB", 3500),
    ).toBe(true);
  });
});
