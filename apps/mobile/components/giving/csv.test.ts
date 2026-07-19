import { describe, expect, test } from "@jest/globals";
import { csvField, toCsv } from "./csv";

describe("csvField", () => {
  test("null/undefined become an empty field", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  test("numbers and plain strings pass through unquoted", () => {
    expect(csvField(42)).toBe("42");
    expect(csvField("Jane Doe")).toBe("Jane Doe");
    expect(csvField(true)).toBe("true");
  });

  test("a comma forces quoting", () => {
    expect(csvField("Smith, Jane")).toBe('"Smith, Jane"');
  });

  test("a newline (either style) forces quoting", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
    expect(csvField("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  test("an embedded quote is doubled and the field is quoted", () => {
    expect(csvField('She said "hi"')).toBe('"She said ""hi"""');
  });

  test("a lone quote with no comma/newline still forces quoting", () => {
    expect(csvField('5" pipe')).toBe('"5"" pipe"');
  });
});

describe("toCsv", () => {
  test("serializes a header row + data rows with CRLF line endings", () => {
    const csv = toCsv(
      ["Name", "Amount"],
      [
        ["Jane Doe", 1000],
        ["Smith, Bob", 2000],
      ],
    );
    expect(csv).toBe('Name,Amount\r\nJane Doe,1000\r\n"Smith, Bob",2000');
  });

  test("no trailing newline after the last row", () => {
    const csv = toCsv(["A"], [["1"]]);
    expect(csv.endsWith("\r\n")).toBe(false);
  });

  test("an empty rows array still serializes just the header", () => {
    expect(toCsv(["A", "B"], [])).toBe("A,B");
  });

  test("null/undefined cells in a data row become empty fields", () => {
    expect(toCsv(["A", "B"], [["x", null], ["y", undefined]])).toBe(
      "A,B\r\nx,\r\ny,",
    );
  });
});
