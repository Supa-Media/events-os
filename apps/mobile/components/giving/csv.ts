/**
 * CSV serialization — giving CRM v2 (owner request #3): "Every giving grid
 * gets an Export action that serializes the CURRENT view." PURE, RFC4180-ish
 * quoting (a field is quoted whenever it contains a comma, quote, or newline;
 * an embedded quote doubles). Dependency-free (no `react-native` import) so
 * it's unit-testable directly under this package's jest config — mirrors
 * `gridSort.ts` / `donorFilters.ts`'s own colocated pure-helper precedent.
 *
 * The platform hookup (web download vs. native share sheet) lives in
 * `exportCsv.ts`, kept separate because it imports `react-native` (this file
 * must not, or jest can't load it without the RN transform).
 */

export type CsvValue = string | number | boolean | null | undefined;

/** Quote a single CSV field only when it needs it (comma, quote, or any line
 *  break) — an embedded `"` doubles per RFC4180. `null`/`undefined` → "". */
export function csvField(value: CsvValue): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize a header row + data rows to a CSV string (CRLF line endings, no
 *  trailing newline). Every row's cell count is expected to match `headers`'
 *  — a short row simply serializes its own fields (no implicit padding). */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvField).join(","));
  return lines.join("\r\n");
}
