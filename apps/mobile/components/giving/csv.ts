/**
 * CSV serialization — thin re-export.
 *
 * The real implementation moved to `@events-os/shared`'s `csv` module
 * (`packages/shared/src/csv.ts`) when exports grew a SERVER-side path inside
 * Convex, where nothing under `apps/mobile` is importable — see that file's
 * module doc for the full story, including the two things it adds over this
 * original: the formula-injection guard on `csvField` (a form answer or note
 * starting with `=`/`+`/`-`/`@` is neutralized with a leading apostrophe
 * before it reaches Excel/Sheets) and the UTF-8 BOM helpers.
 *
 * Kept here, under the same name, so the two existing giving-grid callers
 * (`giving/donors.tsx`, `giving/gifts.tsx`) and this file's own colocated
 * test (`csv.test.ts`) keep working unchanged — every export in the app now
 * shares the ONE quoting implementation.
 */
export { csvField, toCsv, type CsvValue } from "@events-os/shared";
