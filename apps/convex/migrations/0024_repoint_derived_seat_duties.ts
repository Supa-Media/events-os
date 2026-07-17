import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { Migration } from "./index";

/**
 * Duties can no longer target the central chart's DERIVED `chapter_directors`
 * mirror seat — its holders are COMPUTED (rolled up from every chapter's real
 * `chapter_director` seat), never assigned (see `SEAT_DEFS.chapter_directors`
 * in `@events-os/shared` and the new `requireSeatDefs` guard in
 * `responsibilities.ts`). Before that guard existed, the Duties "Assign to
 * seats" picker listed BOTH the mirror ("Chapter Directors") and the real
 * chapter-chart seat ("Chapter Director") as separately assignable targets,
 * and some duties got mapped to the mirror.
 *
 * Owner decision (2026-07-17, verbatim): "the expectation for Chapter
 * Director at one place is gonna be the same for the expectation somewhere
 * else. If they need a fork in the road somewhere we'll deal with that
 * later." Chapter Director is ONE role with identical expectations across
 * every chapter — the derived mirror is not a second duty target. This
 * backfill repoints every `responsibilities` row's `assigneeSeatIds`: any
 * entry equal to the derived seat's id is replaced with the real
 * chapter-chart root seat's id, deduping if a row already had both (matching
 * via `responsibilityAppliesTo` is a plain Set-membership check, so a
 * duplicate entry wouldn't have changed WHO a duty applied to, but it's
 * debris no surface should keep rendering post-repoint).
 *
 * WHY this repoint MATTERS beyond just "picker debris": the derived seat has
 * NO `seatAssignments` rows, ever (holders are computed, never assigned) —
 * so a duty left mapped to it can never match ANY person's held seats and is
 * permanently dead. Repointing it onto the real `chapter_director` id is what
 * makes the duty resolvable at all. And since `responsibilities.ts`'s
 * `orgWideCatalog` resolves a seat-mapped duty ORG-WIDE (every chapter's
 * holder of that seat def, not just the authoring chapter's — same owner
 * decision quoted above), the repoint now delivers EXACTLY the intended
 * semantics in one step: every chapter's director picks up the duty, not just
 * the chapter that happened to author the row.
 *
 * Idempotent: resolves the derived/real seat ids by slug on every run, so a
 * second pass finds the derived id in no row's `assigneeSeatIds` and touches
 * nothing. Also a safe no-op if `seatDefs` hasn't been seeded yet (0022/0023
 * run earlier in the registry, but this guards a hand invocation too).
 */
export async function runRepointDerivedSeatDuties(ctx: MutationCtx) {
  let repointed = 0;
  let deduped = 0;

  const derivedDef = await ctx.db
    .query("seatDefs")
    .withIndex("by_slug", (q) => q.eq("slug", "chapter_directors"))
    .unique();
  const realDef = await ctx.db
    .query("seatDefs")
    .withIndex("by_slug", (q) => q.eq("slug", "chapter_director"))
    .unique();
  if (!derivedDef || !realDef) return { repointed, deduped };

  const rows = await ctx.db.query("responsibilities").collect();
  for (const row of rows) {
    const seatIds = row.assigneeSeatIds;
    if (!seatIds || !seatIds.includes(derivedDef._id)) continue;

    const mapped = seatIds.map((id) =>
      id === derivedDef._id ? realDef._id : id,
    );
    const seen = new Set<Id<"seatDefs">>();
    const next: Id<"seatDefs">[] = [];
    for (const id of mapped) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
    deduped += mapped.length - next.length;

    await ctx.db.patch(row._id, {
      assigneeSeatIds: next,
      updatedAt: Date.now(),
    });
    repointed++;
  }

  return { repointed, deduped };
}

export const repointDerivedSeatDuties: Migration = {
  name: "0024_repoint_derived_seat_duties",
  run: runRepointDerivedSeatDuties,
};
