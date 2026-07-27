import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { resolvePersonaForPage } from "../lib/people";
import { peopleByPersona, isCountedInAggregate } from "../lib/peopleAggregate";

/**
 * Persona-cache + Aggregate backfill (founder ask: "there is a convex way to
 * do counts, please do this instead" — see `lib/peopleAggregate.ts`'s module
 * doc for the full design of `people.ts#counts`'s Aggregate-component
 * replacement). For EVERY existing `people` row this does two things:
 *
 *  1. Computes and stamps `persona` (the derived-cache field
 *     `lib/peopleAggregate.ts`'s triggers maintain write-through from here
 *     on) using the SAME ladder a live read uses —
 *     `resolvePersonaForPage`/`@events-os/shared#personaFromSignals`.
 *  2. Explicitly populates `peopleByPersona` (the `TableAggregate`) for
 *     every row that counts toward `people.ts#counts`, via
 *     `insertIfDoesNotExist` — safe to repeat, and correct regardless of
 *     whether this migration's `ctx` happens to be trigger-wrapped.
 *
 * Deliberately does the aggregate population EXPLICITLY here rather than
 * relying on the `persona` patch to fire `lib/peopleAggregate.ts`'s `people`
 * trigger as a side effect: `migrations.ts#runPending` (the runner that
 * invokes every registry migration, including this one) is NOT built from
 * the triggers-wrapped `internalMutation` — none of the OTHER, already-shipped
 * migrations in this registry need trigger coverage (they ran to completion
 * before `persona`/the aggregate existed), and this one runs LAST (highest
 * filename number), so it always recomputes from the FINAL post-migration
 * state regardless of what any earlier migration did. Being explicit here
 * means this migration is correct no matter what invokes it — `runPending`,
 * a direct `npx convex run`, or a test calling `runBackfillPeoplePersona`
 * with a plain (non-wrapped) `MutationCtx`.
 *
 * Idempotent: a row that already carries `persona` skips the recompute (the
 * cache-stamp half), and `insertIfDoesNotExist` makes the aggregate half safe
 * to repeat unconditionally. Walks per chapter with indexed `.take()` — NOT
 * a looped `.paginate()`; see the note on the function below.
 *
 * Run locally:   npx convex run migrations:runPending
 * Run on prod:   npx convex run --prod migrations:runPending
 */
/** Bound generous relative to a real chapter's roster. Matches
 *  `people.ts#repairPersonaAggregate`'s own scan bound — the same walk, proven
 *  against production. */
const ROSTER_SCAN_LIMIT = 20000;
const CHAPTER_SCAN_LIMIT = 1000;

/**
 * WALKS BY CHAPTER WITH `.take()`, NOT `.paginate()` IN A LOOP.
 *
 * The first version of this migration looped `ctx.db.query("people")
 * .paginate(...)` (copying `0038_backfill_contact_only_people`'s shape) and
 * CRASHED the production deploy: "This query or mutation function ran multiple
 * paginated queries. Convex only supports a single paginated query in each
 * function." 0038 gets away with the same shape only because its dataset fits
 * in one page, so its loop never makes a second `paginate` call — that is
 * luck, not a pattern to copy.
 *
 * Indexed `.take()` per chapter has no such limit and is the same walk
 * `people.ts#repairPersonaAggregate` uses, which ran cleanly against
 * production (4 chapters / 473 people) while this was being fixed.
 */
export async function runBackfillPeoplePersona(ctx: MutationCtx) {
  const result = { personaStamped: 0, aggregateInserted: 0 };
  const chapters = await ctx.db.query("chapters").take(CHAPTER_SCAN_LIMIT);

  for (const chapter of chapters) {
    const roster = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
      .take(ROSTER_SCAN_LIMIT);

    for (const person of roster) {
      let current = person;
      if (current.persona == null) {
        const resolved = await resolvePersonaForPage(ctx, [current]);
        const persona = resolved.get(current._id) ?? "contact";
        await ctx.db.patch(current._id, { persona });
        current = { ...current, persona };
        result.personaStamped++;
      }
      if (isCountedInAggregate(current)) {
        await peopleByPersona.insertIfDoesNotExist(ctx, current);
        result.aggregateInserted++;
      }
    }
  }

  return result;
}

export const backfillPeoplePersona: Migration = {
  name: "0051_backfill_people_persona",
  run: runBackfillPeoplePersona,
};
