/**
 * WHO SHOULD review a submitted coding — as opposed to who MAY.
 *
 * `lib/transactionCodingAccess.ts#requireReviewCoding` answers "may this
 * person decide it", and four seats can (ED, FM, Chapter Director,
 * Treasurer). That stays as it is: the other seats are the backup when the
 * assigned reviewer is away. What it never said is whose job a given coding
 * IS, so the daily digest mailed every one of the four about everything, and
 * the ED read a list of New York charges with no way to tell which were his
 * to decide (Dev2, 2026-11-08):
 *
 *   "By default all team codings should be reviewed by the chapter's
 *    Treasurer, or Financial Manager for Central, but purchases by the
 *    treasurer should be reviewed by chapter director and vice versa for 2
 *    party control. Similarly for ED and FM in central."
 *
 * ## The rule
 *
 * A book has two review sides, read from the seat chart by POWER, not by seat
 * name, so a renamed seat keeps routing:
 *
 *  - the BOOKKEEPER side — seats carrying `finance.edit` at the book
 *    (a chapter's Treasurer; Central's Financial Manager);
 *  - the DIRECTOR side — seats carrying `finance.budgets.approve` without
 *    `finance.edit` (a Chapter Director; the Executive Director).
 *
 * The bookkeeper side reviews by default. When the coder sits on the
 * bookkeeper side themselves, the director side reviews instead, so two
 * people always stand behind a charge. The coder is never their own reviewer.
 *
 * A chapter with nobody free on either side (a vacant seat, or one person in
 * both) falls through to Central under the same rule — the Financial Manager,
 * or the ED when the Financial Manager coded it.
 *
 * Returns `null` only when nobody anywhere qualifies; callers then fall back
 * to everyone with authority (`listCodingReviewerPersonIds`), so a coding is
 * never left with no one told.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CENTRAL, expandPowers } from "@events-os/shared";
import type { FinanceScope } from "./finance";

/** One person holding a review-side seat at a scope. */
export interface ReviewSeatHolder {
  personId: Id<"people">;
  seatTitle: string;
}

/** The two review sides at one scope (a chapter, or Central). */
export interface ReviewSeats {
  scope: FinanceScope;
  bookkeepers: ReviewSeatHolder[];
  directors: ReviewSeatHolder[];
}

export type CodingReviewWhy =
  /** The bookkeeper side reviews — the normal case. */
  | "default"
  /** The coder sits on the bookkeeper side, so the director side reviews. */
  | "coded_by_bookkeeper"
  /** Nobody in the chapter was free to review it, so Central does. */
  | "chapter_has_no_reviewer";

export interface CodingReviewAssignment {
  personIds: Id<"people">[];
  /** The seat they review as, e.g. "Treasurer" or "Executive Director". */
  seatTitle: string;
  /** Where that seat sits — the coding's own book, or Central. */
  scope: FinanceScope;
  why: CodingReviewWhy;
}

/** Bound on the scope scan — a scope's seats number in the dozens. */
const SEAT_SCAN_LIMIT = 500;

/** Read the two review sides at `scope` from the live seat chart. */
export async function loadReviewSeats(
  ctx: QueryCtx,
  scope: FinanceScope,
): Promise<ReviewSeats> {
  const bookkeepers: ReviewSeatHolder[] = [];
  const directors: ReviewSeatHolder[] = [];
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_scope", (q) => q.eq("scope", scope))
    .take(SEAT_SCAN_LIMIT);
  for (const a of assignments) {
    const def = await ctx.db.get(a.seatDefId);
    // Rolled-up seats are never real occupancy (same skip as
    // `holdsApprovalSeatAt`).
    if (!def || def.derived) continue;
    const person = await ctx.db.get(a.personId);
    if (!person || person.isPlaceholder === true) continue;
    const powers = expandPowers(def.capabilities);
    const holder = { personId: a.personId, seatTitle: def.title };
    if (powers.has("finance.edit")) bookkeepers.push(holder);
    else if (powers.has("finance.budgets.approve")) directors.push(holder);
  }
  return { scope, bookkeepers, directors };
}

/** The rule at ONE scope. `null` when nobody there is free to review. */
function routeAt(
  seats: ReviewSeats,
  coder: Id<"people"> | null,
): Omit<CodingReviewAssignment, "why"> & { twoParty: boolean } | null {
  const coderIsBookkeeper =
    coder != null && seats.bookkeepers.some((h) => h.personId === coder);
  const order = coderIsBookkeeper
    ? [seats.directors, seats.bookkeepers]
    : [seats.bookkeepers, seats.directors];
  for (const side of order) {
    const free = side.filter((h) => h.personId !== coder);
    if (free.length === 0) continue;
    return {
      personIds: [...new Set(free.map((h) => h.personId))],
      seatTitle: free[0].seatTitle,
      scope: seats.scope,
      twoParty: coderIsBookkeeper && side === seats.directors,
    };
  }
  return null;
}

/**
 * Pure routing: given the seats at the coding's book and at Central, who
 * should review a coding written by `coder`. `bookSeats` is `null` for a
 * Central coding (Central is then the only level).
 */
export function routeCodingReview(
  bookSeats: ReviewSeats | null,
  centralSeats: ReviewSeats,
  coder: Id<"people"> | null,
): CodingReviewAssignment | null {
  if (bookSeats) {
    const local = routeAt(bookSeats, coder);
    if (local) {
      const { twoParty, ...rest } = local;
      return { ...rest, why: twoParty ? "coded_by_bookkeeper" : "default" };
    }
  }
  const central = routeAt(centralSeats, coder);
  if (!central) return null;
  const { twoParty, ...rest } = central;
  return {
    ...rest,
    why: bookSeats
      ? "chapter_has_no_reviewer"
      : twoParty
        ? "coded_by_bookkeeper"
        : "default",
  };
}

/**
 * Per-request cache of seat reads, so a queue or digest over many codings
 * reads each book's seats once.
 */
export function codingReviewRouter(ctx: QueryCtx) {
  const cache = new Map<string, Promise<ReviewSeats>>();
  const seatsAt = (scope: FinanceScope) => {
    const key = String(scope);
    let hit = cache.get(key);
    if (!hit) {
      hit = loadReviewSeats(ctx, scope);
      cache.set(key, hit);
    }
    return hit;
  };
  return async (
    book: FinanceScope,
    coder: Id<"people"> | null | undefined,
  ): Promise<CodingReviewAssignment | null> =>
    routeCodingReview(
      book === CENTRAL ? null : await seatsAt(book),
      await seatsAt(CENTRAL),
      coder ?? null,
    );
}
