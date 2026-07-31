/**
 * The export builder contract — one builder per dataset, implemented under
 * this directory and dispatched from `./index.ts`.
 *
 * A builder answers exactly two questions and nothing else:
 *
 *   columns() — what are this file's headers, for THIS run?
 *   page()    — give me the next N rows.
 *
 * It never touches storage, never decides access, never knows what a CSV is.
 * That separation is what lets the runner (`lib/exportRunner.ts`) treat all
 * eleven datasets identically, and it's what makes each builder testable by
 * calling it directly with a cursor.
 *
 * ── THE ONE RULE THAT MATTERS: EXACTLY ONE `.paginate()` PER `page()` CALL ──
 *
 * `page()` runs inside a Convex query transaction, which has hard read limits.
 * The house pattern for walking a whole table (every file under
 * `apps/convex/migrations/`, e.g. `0042_wrap_targeting.ts`) is ONE
 * `.paginate()` per invocation, returning the continuation cursor so the
 * caller can come back for more. Builders follow it exactly.
 *
 * Per-row enrichment joins (the people builder does six) are indexed lookups
 * against the page's rows only — never a second `.paginate()`, never a
 * `.collect()` over another whole table, and never `.filter()` (use an index;
 * see `_generated/ai/guidelines.md`). If a join can't be bounded per row, the
 * column doesn't belong in the export.
 *
 * ── WHY COLUMNS ARE RESOLVED ONCE, UP FRONT ──
 *
 * The people export's columns are DYNAMIC: one per form question, discovered
 * from `formDefinitions` at run time. They must be computed ONCE, before the
 * first page, and held constant for the whole file — a column set that grew
 * mid-walk would shift every subsequent row's cells relative to the header
 * already written. The runner enforces this by calling `columns()` once and
 * passing the same list to every `rowsToCsvBody` call.
 */
import type { CsvColumn, CsvValue } from "@events-os/shared";
import type {
  ExportDatasetId,
  ExportFilters,
  ExportSectionId,
} from "@events-os/shared";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

/** Everything a builder needs to know about the run it's serving. Resolved
 *  once by the runner and passed unchanged to `columns()` and every `page()`. */
export interface ExportBuilderContext {
  /** The chapter, or `"central"`. */
  scope: Id<"chapters"> | "central";
  /** The chapter id when scope is a chapter; `null` at central. Provided
   *  separately so builders don't re-narrow the union on every query. */
  chapterId: Id<"chapters"> | null;
  filters: ExportFilters;
  /** Sections the requester asked for AND is allowed to fill. A builder must
   *  emit columns for exactly these — never check capabilities itself; that
   *  decision was already made in `lib/dataExportAccess.ts`. */
  sections: ReadonlySet<ExportSectionId>;
  /** The requester's data reach, for builders whose FIXED columns (not a
   *  section) vary by permission. Same values that produced `sections`. */
  reach: { giving: boolean; finance: boolean };
}

/** One page of rows plus the cursor to resume from. */
export interface ExportPage {
  /** Keyed by `CsvColumn.key`. A missing key is an empty cell in the right
   *  column — never a shifted row (see `rowsToCsv`'s doc). */
  rows: Record<string, CsvValue>[];
  /** Pass back into the next `page()` call. */
  cursor: string | null;
  isDone: boolean;
}

export interface ExportBuilder {
  datasetId: ExportDatasetId;

  /**
   * Rows READ per `page()` call, overriding `EXPORT_PAGE_SIZE`.
   *
   * The default suits a FLAT dataset, where one row of output costs about one
   * document read. It is badly wrong for a WIDE one. The people builder joins
   * six tables per person — emails, seats, RSVPs (and each RSVP's ticket
   * orders and their tickets), engagements, form submissions, academy rows —
   * so a single exported person can cost dozens of reads, and a typical
   * chapter at the default page size lands in the tens of thousands per
   * transaction. Convex caps a transaction at ~16k document reads, so that
   * page throws — on real data only. Seeded tests with a handful of rows sail
   * through it, which is exactly why this is a declared property of the
   * builder rather than something the runner could infer.
   *
   * Set it to roughly `16000 / (worst-case reads per row)` with room to spare.
   */
  pageSize?: number;
  /**
   * The file's columns for this run. Called ONCE before the first page — see
   * the module doc for why it must not vary per page.
   *
   * Every builder puts its own stable id first (`person_id`, `gift_id`, …).
   * That id is what makes a file joinable against another export in a
   * spreadsheet, and it is what lets someone re-import or reconcile a row
   * later. It is never omitted, even when it looks like noise.
   */
  columns(ctx: QueryCtx, bctx: ExportBuilderContext): Promise<CsvColumn[]>;

  /**
   * One page of rows. EXACTLY ONE `.paginate()` — see the module doc.
   * `cursor` is `null` on the first call.
   */
  page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage>;
}
