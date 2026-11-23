/**
 * WHAT A CONTRACTOR AGREEMENT MAY BE CODED TO — the body of
 * `contractorPayments.codingOptionsForScope`, kept here so the 3,000-line
 * module doesn't grow another scan.
 *
 * One rule for every book: an event, project, or standing budget is offered at
 * a scope only when the budget BEHIND it belongs to that scope. That is the
 * picker-side half of `assertCodingMatchesScope` — a chapter's event funded by
 * a central budget is central's to pay, and offering it at the chapter desk is
 * exactly how an agreement came to say "New York's books" over central's money.
 */
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { CENTRAL, type BudgetCadence } from "@events-os/shared";
import {
  gatherForPickerCandidates,
  budgetDisplayNameFor,
  isStalePastEvent,
} from "./forPickerCandidates";
import { listActiveChapters } from "./chapters";
import { hasContractorPaymentsCompose } from "./contractorPaymentsAccess";
import type { FinanceScope } from "./finance";

/** `budgetId` is set when the row must be coded by its BUDGET rather than by
 *  the event/project id: central's own events and projects live in a
 *  chapter's table, so coding a central agreement to the event id would fail
 *  the create path's same-scope check, while central's budget id passes it. */
type RefRow = { id: string; label: string; budgetId?: Id<"budgets"> };

export type CodingBook = {
  events: RefRow[];
  projects: RefRow[];
  budgets: { id: Id<"budgets">; label: string; cadence: BudgetCadence }[];
};

export type ChapterCodingBook = CodingBook & { scope: Id<"chapters">; name: string };

/** One scope's own events, projects and standing budgets. */
export async function codingBookFor(
  ctx: QueryCtx,
  scope: FinanceScope,
  scanLimit: number,
  /** The event an existing agreement is already coded to — kept even when it
   *  has aged out, so the edit screen still shows what it says. */
  keepEventId?: string,
): Promise<CodingBook> {
  const { candidates } = await gatherForPickerCandidates(
    ctx,
    scope === CENTRAL ? null : (scope as Id<"chapters">),
    scanLimit,
  );
  const book: CodingBook = { events: [], projects: [], budgets: [] };
  const now = Date.now();
  for (const c of candidates) {
    if (!c.budget || c.budget.chapterId !== scope) continue;
    // Events that already happened drop out after a grace window — see
    // `PAST_EVENT_PICKER_GRACE_MS`.
    if (isStalePastEvent(c, now) && c.refId !== keepEventId) continue;
    const ref: RefRow = {
      id: c.refId,
      label: c.label,
      ...(scope === CENTRAL ? { budgetId: c.budget._id } : {}),
    };
    if (c.refKind === "event") book.events.push(ref);
    else if (c.refKind === "project") book.projects.push(ref);
    else {
      book.budgets.push({
        id: c.budget._id,
        label: budgetDisplayNameFor(c.budget),
        cadence: c.budget.cadence,
      });
    }
  }
  return book;
}

/**
 * Every chapter's book, for the CENTRAL composer.
 *
 * The central desk reads "Central — all chapters", and the person sitting at it
 * looks for a chapter's event the same way they find it on the Budgets tab.
 *
 * A chapter's EVENTS and PROJECTS are pickable from central (founder,
 * 2026-11-23, reversing #871's greyed-out list): central pays, the event keeps
 * its chapter, and the spend books to central's books tagged with the event.
 * A chapter's standing BUDGETS stay greyed — they are that chapter's money.
 * Only chapters the caller may compose for are listed.
 */
export async function chapterCodingBooks(
  ctx: QueryCtx,
  scanLimit: number,
  keepEventId?: string,
): Promise<ChapterCodingBook[]> {
  const chapters = await listActiveChapters(ctx);
  const books: ChapterCodingBook[] = [];
  for (const chapter of chapters) {
    if (!(await hasContractorPaymentsCompose(ctx, chapter._id))) continue;
    const book = await codingBookFor(ctx, chapter._id, scanLimit, keepEventId);
    if (book.events.length + book.projects.length + book.budgets.length === 0) continue;
    books.push({ scope: chapter._id, name: chapter.name, ...book });
  }
  return books;
}
