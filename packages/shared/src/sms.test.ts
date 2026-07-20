import { describe, expect, test } from "vitest";
import {
  estimateSegments,
  estimateSmsCostUsdMicros,
  formatUsdMicros,
  SMS_SEGMENT_PRICE_USD_MICROS,
} from "./sms";

describe("estimateSegments", () => {
  test("empty string still costs one segment", () => {
    expect(estimateSegments("")).toBe(1);
  });

  test("GSM-7: exactly 160 chars is 1 segment", () => {
    expect(estimateSegments("a".repeat(160))).toBe(1);
  });

  test("GSM-7: 161 chars rolls over to 2 segments", () => {
    expect(estimateSegments("a".repeat(161))).toBe(2);
  });

  test("GSM-7: multi-segment math uses the 153-char concatenation size", () => {
    expect(estimateSegments("a".repeat(153 * 2))).toBe(2);
    expect(estimateSegments("a".repeat(153 * 2 + 1))).toBe(3);
  });

  test("GSM-7 extension chars (€, [, ], {, }, ^, |, ~, \\) count double", () => {
    // 159 plain chars + 1 extension char = effective length 161 → 2 segments.
    expect(estimateSegments("a".repeat(159) + "€")).toBe(2);
    expect(estimateSegments("a".repeat(159) + "[")).toBe(2);
    // The same 160 chars, all plain, stays at 1 segment — isolates the effect.
    expect(estimateSegments("a".repeat(160))).toBe(1);
  });

  test("common GSM-7 basic punctuation and accents stay single-count", () => {
    expect(estimateSegments("Hello, world! Ça va? 100% è ready.")).toBe(1);
  });

  test("an emoji forces UCS-2 encoding, dropping the single-segment limit to 70", () => {
    const body = "a".repeat(69) + "😀"; // 69 GSM-7-safe chars + 1 emoji (2 UTF-16 units)
    expect(estimateSegments(body)).toBe(2); // 71 UTF-16 units > 70
  });

  test("UCS-2: exactly 70 chars is 1 segment, 71 is 2", () => {
    expect(estimateSegments("あ".repeat(70))).toBe(1);
    expect(estimateSegments("あ".repeat(71))).toBe(2);
  });

  test("UCS-2 multi-segment math uses the 67-char concatenation size", () => {
    expect(estimateSegments("あ".repeat(67 * 2))).toBe(2);
    expect(estimateSegments("あ".repeat(67 * 2 + 1))).toBe(3);
  });

  test("a single non-GSM-7 character anywhere downgrades the whole message", () => {
    // 200 plain chars (would be 2 GSM-7 segments) + one emoji → UCS-2 rules.
    const body = "a".repeat(200) + "🎉";
    // 203 UTF-16 units under UCS-2 (67/segment) → ceil(203/67) = 4.
    expect(estimateSegments(body)).toBe(Math.ceil((200 + 2) / 67));
  });
});

describe("estimateSmsCostUsdMicros", () => {
  test("one segment × one recipient = the flat per-segment price", () => {
    expect(estimateSmsCostUsdMicros("hi", 1)).toBe(SMS_SEGMENT_PRICE_USD_MICROS);
  });

  test("scales linearly with segments and recipients", () => {
    const twoSegmentBody = "a".repeat(161);
    expect(estimateSmsCostUsdMicros(twoSegmentBody, 5)).toBe(
      2 * SMS_SEGMENT_PRICE_USD_MICROS * 5,
    );
  });

  test("zero recipients costs nothing", () => {
    expect(estimateSmsCostUsdMicros("hello", 0)).toBe(0);
  });
});

describe("formatUsdMicros", () => {
  test("exactly zero is '$0.00'", () => {
    expect(formatUsdMicros(0)).toBe("$0.00");
  });

  test("2 decimals at or above a cent", () => {
    expect(formatUsdMicros(10_000)).toBe("$0.01"); // exactly one cent — the boundary
    expect(formatUsdMicros(1_000_000)).toBe("$1.00");
    expect(formatUsdMicros(2_500_000)).toBe("$2.50");
  });

  test("4 decimals below a cent", () => {
    expect(formatUsdMicros(5_000)).toBe("$0.0050");
    expect(formatUsdMicros(1)).toBe("$0.0000");
  });
});
