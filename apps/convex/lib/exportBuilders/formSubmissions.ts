/**
 * Form Submissions export — one row per FORM SUBMISSION (not per person),
 * walking `formSubmissions` by `by_chapter` with the required ONE
 * `.paginate()` per `page()` call (see `./types.ts`). Includes anonymous
 * event surveys (`personId` absent, `eventId` set) — the people export's
 * `form_answers` section can only ever surface a form question against a
 * PERSON, so an anonymous survey response would otherwise be invisible in
 * every export this app offers. This file is where it lives.
 *
 * Columns: submission identity + one column per (form, question) across
 * every form defined for the chapter — the SAME `formAnswerColumnKey` /
 * `formAnswerColumnLabel` helpers the people export's `form_answers` section
 * uses, so a question's column header reads identically in both files.
 * Unlike the people export (one row per PERSON, columns filled from
 * whichever forms they've answered), here each row is exactly ONE submission
 * of exactly ONE form — every OTHER form's question columns on that row are
 * blank. That's intentional: the wide shape is what lets someone open the
 * file, find the row's form, and read every answer across without a second
 * lookup, at the cost of a sparse grid for chapters running several
 * distinct forms.
 */
import type { CsvColumn, CsvValue } from "@events-os/shared";
import {
  flattenAnswer,
  formAnswerColumnKey,
  formAnswerColumnLabel,
  isoOrBlank,
} from "@events-os/shared";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { ExportBuilder, ExportBuilderContext, ExportPage } from "./types";

/** Generous bound over a chapter's form catalog — mirrors the same cap in
 *  `./people.ts` (both read the same small, chapter-scoped table). */
const FORM_DEFINITIONS_PER_CHAPTER_LIMIT = 200;

async function loadFormDefs(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"formDefinitions">[]> {
  return await ctx.db
    .query("formDefinitions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(FORM_DEFINITIONS_PER_CHAPTER_LIMIT);
}

function questionColumnDefs(forms: Doc<"formDefinitions">[]): CsvColumn[] {
  const cols: CsvColumn[] = [];
  for (const form of forms) {
    for (const q of form.questions) {
      cols.push({
        key: formAnswerColumnKey(form.formKey, q.key),
        label: formAnswerColumnLabel(form.title, q.label),
      });
    }
  }
  return cols;
}

function fixedColumnDefs(): CsvColumn[] {
  return [
    { key: "submission_id", label: "Submission ID" },
    { key: "form_key", label: "Form key" },
    { key: "form_title", label: "Form title" },
    { key: "person_id", label: "Person ID" },
    { key: "person_name", label: "Person name" },
    { key: "event_id", label: "Event ID" },
    { key: "event_name", label: "Event name" },
    { key: "submitted_at", label: "Submitted at" },
    { key: "source", label: "Source" },
  ];
}

async function columns(ctx: QueryCtx, bctx: ExportBuilderContext): Promise<CsvColumn[]> {
  const forms = bctx.chapterId ? await loadFormDefs(ctx, bctx.chapterId) : [];
  return [...fixedColumnDefs(), ...questionColumnDefs(forms)];
}

async function page(
  ctx: QueryCtx,
  bctx: ExportBuilderContext,
  cursor: string | null,
  numItems: number,
): Promise<ExportPage> {
  if (!bctx.chapterId) return { rows: [], cursor: null, isDone: true };
  const chapterId = bctx.chapterId;

  const result = await ctx.db
    .query("formSubmissions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .paginate({ numItems, cursor });

  // Small, chapter-scoped, re-read every page() call (builders are stateless
  // between calls) — same bounded read `columns()` uses, so both agree on
  // which forms exist without sharing any cross-call state.
  const forms = await loadFormDefs(ctx, chapterId);
  const formByKey = new Map(forms.map((f) => [f.formKey, f]));

  const from = bctx.filters.from;
  const to = bctx.filters.to;

  const rows: Record<string, CsvValue>[] = [];
  for (const sub of result.page) {
    if (from !== undefined && sub.submittedAt < from) continue;
    if (to !== undefined && sub.submittedAt > to) continue;

    const form = formByKey.get(sub.formKey);
    // Point reads, bounded by this page's row count — never a second
    // `.paginate()`/unbounded scan.
    const person = sub.personId ? await ctx.db.get(sub.personId) : null;
    const event = sub.eventId ? await ctx.db.get(sub.eventId) : null;

    const row: Record<string, CsvValue> = {
      submission_id: sub._id,
      form_key: sub.formKey,
      form_title: form?.title ?? sub.formKey,
      person_id: sub.personId ?? "",
      person_name: person?.name ?? "",
      event_id: sub.eventId ?? "",
      event_name: event?.name ?? "",
      submitted_at: isoOrBlank(sub.submittedAt),
      source: sub.source,
    };

    if (form) {
      for (const q of form.questions) {
        row[formAnswerColumnKey(form.formKey, q.key)] = flattenAnswer(sub.answers[q.key]);
      }
    }

    rows.push(row);
  }

  return {
    rows,
    cursor: result.isDone ? null : result.continueCursor,
    isDone: result.isDone,
  };
}

export const formSubmissionsBuilders: ExportBuilder[] = [
  {
    datasetId: "form_submissions",
    columns,
    page,
  },
];
