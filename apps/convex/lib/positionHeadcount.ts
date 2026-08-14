/**
 * How many people hold each position — THE ONLY PATH FROM HOLDER RECORDS TO
 * THE PUBLIC PAGE, and it is one function wide.
 *
 * ⚠ THIS FUNCTION RETURNS INTEGERS. IT MUST NEVER RETURN A DOCUMENT, A NAME,
 * AN ID, OR ANYTHING FROM WHICH ONE COULD BE RECOVERED. ⚠
 *
 * Read that as a constraint on future edits, not as a description of today's
 * code. `/finances`'s "Who gets paid" grid publishes what each POSITION is
 * paid, never what a named person earns, and until this file existed that
 * property was STRUCTURAL: `compensationTable()` (`@events-os/shared`) had no
 * ctx, no db, and therefore no reachable holder record at all — a renderer
 * could not have leaked a name if it tried.
 *
 * A headcount badge on each tile is worth the trade (a reader shown a salary
 * is entitled to know whether it is paid once or thirty times), but it is a
 * real trade: the guarantee is now DISCIPLINED rather than structural. The
 * discipline is this file. It reads `seatAssignments` — the rows that name
 * people — and hands back a map of counts and a chapter total. Everything
 * downstream (`publicLedger.publicPositionHeadcount`, `renderLedgerPage`,
 * `compensationTable`) sees only numbers, so no later change to a renderer can
 * widen this on its own. Widening it HERE is the thing to refuse: if a future
 * feature needs a name on the public page, that is a product decision made in
 * the open, not a return-type edit.
 *
 * `apps/convex/tests/publicLedger.test.ts` asserts that real assigned holders'
 * names appear nowhere in the rendered HTML, so the guarantee has a test
 * behind it as well as a comment.
 *
 * ── LIVE, NOT FROZEN ─────────────────────────────────────────────────────────
 * These counts are read at render time on every published month, exactly like
 * the pay figures beside them (see `COMPENSATION_DISCLOSURE`'s doc for the
 * full argument). The consequence is deliberate and worth knowing: a reader
 * opening a BACKDATED month sees today's team, not that month's. The section
 * is a standing statement about the org now — "these are our positions, this
 * is what they pay, this is how many of us there are" — and freezing a
 * headcount per publication would quietly turn it into an unreviewed
 * historical staffing record filed under a heading about pay.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { SEAT_DEFS, SEAT_IDS, type SeatId } from "@events-os/shared";
import { listActiveChapters } from "./chapters";

/** Chapters to enumerate. Matches `publicLedger.ts#countActiveBooks`'s reach,
 *  so "across 3 cities" and "3 of our 4 chapters have published" can never be
 *  counting different fleets. */
const CHAPTER_SCAN_LIMIT = 200;

/** Seat defs to read. The template stamps 27; runtime-added seats (the ED's
 *  chart editor) push past that, and anything beyond this bound simply doesn't
 *  contribute a count — every seat the GRID can print is a template seat, and
 *  those are all inside it. */
const SEAT_DEF_SCAN_LIMIT = 500;

/** Assignments read per scope. A scope's ceiling is every seat filled to
 *  `MULTI_HOLDER_CAP` (27 × 50 = 1,350), so this cannot silently truncate a
 *  real chapter. */
const SCOPE_ASSIGNMENT_SCAN_LIMIT = 2000;

/** Counts only — the shape `@events-os/shared`'s `PositionHeadcount` accepts.
 *  Keyed by `string` rather than `SeatId` because it crosses a Convex
 *  `v.record(v.string(), v.number())` boundary on its way to the page. */
export type PositionHeadcountResult = {
  byPosition: Record<string, number>;
  chapterCount: number;
};

const TEMPLATE_SEAT_IDS = new Set<string>(SEAT_IDS);

/** A `seatDefs.slug` that is one of the template positions the public grid
 *  prints — and is not a `derived` rollup. A runtime-added seat, or a
 *  test/ops fixture def, is not a published position and contributes nothing.
 *
 *  `chapter_directors` is excluded for the same reason `compensationTable()`
 *  skips it: it is a VIEW of every chapter's `chapter_director` holder, so
 *  counting it would count the same people twice under two names. */
function publishedSeatId(slug: string): SeatId | null {
  if (!TEMPLATE_SEAT_IDS.has(slug)) return null;
  const seatId = slug as SeatId;
  return SEAT_DEFS[seatId].derived === true ? null : seatId;
}

/**
 * People per position, right now, across central and every active chapter.
 *
 * A CHAPTER position sums across chapters — "Chapter Director · 3" means three
 * cities each have one, which is the only reading that makes the grid's single
 * tile per position honest. A CENTRAL position is a straight count.
 *
 * One indexed read per scope (`by_scope`) rather than one per (scope, seat):
 * with 27 seats and a growing fleet the second shape is dozens of round trips
 * to answer a question that is one pass over a small, bounded table.
 */
export async function positionHeadcount(
  ctx: QueryCtx,
): Promise<PositionHeadcountResult> {
  const chapters = await listActiveChapters(ctx, CHAPTER_SCAN_LIMIT);
  const defs = await ctx.db.query("seatDefs").take(SEAT_DEF_SCAN_LIMIT);

  const positionByDefId = new Map<Id<"seatDefs">, SeatId>();
  for (const def of defs) {
    const seatId = publishedSeatId(def.slug);
    if (seatId) positionByDefId.set(def._id, seatId);
  }

  const scopes: (Id<"chapters"> | "central")[] = [
    "central",
    ...chapters.map((c) => c._id),
  ];
  const byPosition: Record<string, number> = {};
  for (const scope of scopes) {
    const assignments = await ctx.db
      .query("seatAssignments")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .take(SCOPE_ASSIGNMENT_SCAN_LIMIT);
    for (const assignment of assignments) {
      const seatId = positionByDefId.get(assignment.seatDefId);
      if (!seatId) continue;
      byPosition[seatId] = (byPosition[seatId] ?? 0) + 1;
    }
  }

  return { byPosition, chapterCount: chapters.length };
}
