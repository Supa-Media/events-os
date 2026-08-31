/**
 * Server-side people search — the ONE place that decides what "searching for
 * a person" means, and the ONE walk that finds matches without holding a
 * whole chapter roster in memory.
 *
 * WHY THIS EXISTS: every people picker used to ship a roster to the client
 * and filter it there with `name.toLowerCase().includes(q)`. That is only
 * correct while the roster the client holds is COMPLETE — and
 * `seats.assignablePeople` (the org-chart seat picker's roster) was never
 * complete: it `.take(300)`'d per chapter in creation order and then sliced
 * the merged, name-sorted result to 500. A person added today fell outside
 * that window in any sizeable chapter, so the org-chart picker's search
 * genuinely could not find them — the search box was filtering a truncated
 * list and saying "No matches" (reported 2026-08-31). Client-side filtering
 * over a server-truncated list is the bug; the fix is to filter where the
 * whole roster is.
 *
 * MATCH SEMANTICS are deliberately identical to `people.listPaginated`'s
 * (the People tab's grid), so the picker and the grid never disagree about
 * what a query matches: case-insensitive substring over name / email /
 * pwEmail, plus a digits-only substring over phone.
 */
import { paginator } from "convex-helpers/server/pagination";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import schema from "../schema";

/** A parsed query. `null` means "no search" — every candidate matches. */
export type PeopleSearchTerms = { text: string; digits: string } | null;

/**
 * Parse a raw search box value. Returns `null` for an empty/whitespace query
 * so callers can branch once (`terms === null` → plain roster read) instead
 * of re-testing the string everywhere.
 */
export function parsePeopleSearch(search: string | undefined): PeopleSearchTerms {
  const text = (search ?? "").trim().toLowerCase();
  if (!text) return null;
  return { text, digits: text.replace(/\D/g, "") };
}

/**
 * Does this person match the query? Name / email / pwEmail substring, or a
 * digits-only phone substring (so "555 0134", "555-0134" and "5550134" all
 * find the same person). Mirrors `people.listPaginated`'s `passesFieldFilters`
 * search block exactly — change both together.
 */
export function personMatchesSearch(
  person: Pick<Doc<"people">, "name" | "email" | "pwEmail" | "phone">,
  terms: PeopleSearchTerms,
): boolean {
  if (!terms) return true;
  if (person.name.toLowerCase().includes(terms.text)) return true;
  if (person.email?.toLowerCase().includes(terms.text)) return true;
  if (person.pwEmail?.toLowerCase().includes(terms.text)) return true;
  if (
    terms.digits.length > 0 &&
    person.phone &&
    person.phone.replace(/\D/g, "").includes(terms.digits)
  ) {
    return true;
  }
  return false;
}

/** Rows read per index batch while walking a chapter for matches. Big enough
 *  that a typical chapter resolves in one or two batches, small enough that a
 *  central-scope search (one walk PER chapter) doesn't over-read. */
const SEARCH_BATCH_SIZE = 200;

/**
 * Hard bound on how many rows a single chapter walk will read before giving
 * up, whether or not it filled `limit`. A search whose only match sorts last
 * alphabetically in a huge chapter walks the whole roster — this is the
 * ceiling on that. Generous against a real chapter (the People-CRM brief
 * sizes a chapter "into the thousands") while staying a bound rather than an
 * unbounded scan.
 */
const SEARCH_SCAN_CAP = 5000;

/**
 * Walk one chapter's roster in NAME order and return up to `limit` people
 * that pass `include` and match `terms`.
 *
 * Ordering is the index's, not a post-sort: `by_chapter_and_name` hands rows
 * back already alphabetised across the whole walk, so stopping at `limit`
 * yields the first `limit` matches alphabetically — a stable, explainable
 * truncation, unlike the creation-order `.take()` it replaces (which dropped
 * whoever was added most recently).
 *
 * USES `convex-helpers`' `paginator`, NOT `ctx.db….paginate()`: this is
 * called in a loop here, and again once PER CHAPTER for a central-scope
 * search, and Convex permits exactly one built-in paginated query per
 * function call — see `people.listPaginated`'s note about the production
 * outage that rule caused (2026-07-27). Do NOT swap this to `ctx.db`.
 */
export async function searchChapterPeople(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  opts: {
    terms: PeopleSearchTerms;
    /** Eligibility predicate — placeholders, sample people, contact-only
     *  rows, card eligibility, … Applied BEFORE the search match so a
     *  caller's roster policy is never widened by a query. */
    include: (person: Doc<"people">) => boolean;
    /** Max matches to return. */
    limit: number;
    /** Optional override of the per-walk read ceiling (defaults to
     *  `SEARCH_SCAN_CAP`) — a central-scope caller fanning out over many
     *  chapters can lower it. */
    scanCap?: number;
  },
): Promise<Doc<"people">[]> {
  const scanCap = opts.scanCap ?? SEARCH_SCAN_CAP;
  const matches: Doc<"people">[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  let isDone = false;

  while (!isDone && matches.length < opts.limit && scanned < scanCap) {
    const batch = await paginator(ctx.db, schema)
      .query("people")
      .withIndex("by_chapter_and_name", (q) => q.eq("chapterId", chapterId))
      .order("asc")
      .paginate({ numItems: SEARCH_BATCH_SIZE, cursor });
    isDone = batch.isDone;
    cursor = batch.continueCursor;
    scanned += batch.page.length;
    for (const person of batch.page) {
      if (!opts.include(person)) continue;
      if (!personMatchesSearch(person, opts.terms)) continue;
      matches.push(person);
      if (matches.length >= opts.limit) break;
    }
  }

  return matches;
}
