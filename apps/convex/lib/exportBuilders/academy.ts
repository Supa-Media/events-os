/**
 * Export builder for the `academy_progress` dataset — one row per
 * (person, lesson), mirroring `academyProgress` directly.
 *
 * `supportsCentral: false`, so `bctx.chapterId` is always the real chapter
 * for a run the runner actually dispatches; the `null` guard is defensive.
 *
 * See `./types.ts` for the one-`.paginate()`-per-`page()` rule this follows.
 */
import type { QueryCtx } from "../../_generated/server";
import { isoOrBlank, type CsvColumn, type CsvValue } from "@events-os/shared";
import type { ExportBuilder, ExportBuilderContext, ExportPage } from "./types";

const EMPTY_PAGE: ExportPage = { rows: [], cursor: null, isDone: true };

const ACADEMY_COLUMNS: CsvColumn[] = [
  { key: "person_id", label: "Person ID" },
  { key: "person_name", label: "Person name" },
  { key: "lesson_slug", label: "Lesson" },
  { key: "read_at", label: "First read" },
  { key: "completed_at", label: "Completed" },
  { key: "quiz_score", label: "Quiz score" },
  { key: "quiz_total", label: "Quiz questions" },
];

const academyProgressBuilder: ExportBuilder = {
  datasetId: "academy_progress",
  async columns(): Promise<CsvColumn[]> {
    return ACADEMY_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    if (bctx.chapterId === null) return EMPTY_PAGE;
    const chapterId = bctx.chapterId;

    const result = await ctx.db
      .query("academyProgress")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .paginate({ numItems, cursor });

    const page = result.page;

    // `dateRange` (declared filter): `academyProgress` has no single
    // "created" timestamp — a row's "completion date" is `passedAt` (the
    // dataset description's own words). Rows never passed have nothing to
    // compare against a date window and are excluded WHEN a window is given
    // (present unfiltered), same treatment `gifts` gives a boundary-less row.
    const { from, to } = bctx.filters;
    const kept =
      from === undefined && to === undefined
        ? page
        : page.filter((p) => {
            if (p.passedAt === undefined) return false;
            if (from !== undefined && p.passedAt < from) return false;
            if (to !== undefined && p.passedAt > to) return false;
            return true;
          });

    const personIds = [...new Set(kept.map((p) => p.personId))];
    const personNames = new Map<string, string>();
    for (const id of personIds) {
      const person = await ctx.db.get(id);
      if (person) personNames.set(id, person.name);
    }

    const rows: Record<string, CsvValue>[] = kept.map((p) => ({
      person_id: p.personId,
      person_name: personNames.get(p.personId) ?? "",
      lesson_slug: p.sectionSlug,
      read_at: isoOrBlank(p.readAt),
      completed_at: isoOrBlank(p.passedAt),
      quiz_score: p.quizBestScore ?? "",
      quiz_total: p.quizTotal ?? "",
    }));

    return { rows, cursor: result.continueCursor, isDone: result.isDone };
  },
};

export const academyBuilders: ExportBuilder[] = [academyProgressBuilder];
