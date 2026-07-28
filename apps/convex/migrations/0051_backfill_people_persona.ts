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
 * to repeat unconditionally. Batched via `.paginate()`, mirroring
 * `0038_backfill_contact_only_people`'s shape.
 *
 * Run locally:   npx convex run migrations:runPending
 * Run on prod:   npx convex run --prod migrations:runPending
 */
const PAGE_SIZE = 500;

export async function runBackfillPeoplePersona(ctx: MutationCtx) {
  const result = { personaStamped: 0, aggregateInserted: 0 };
  let cursor: string | null = null;

  for (;;) {
    const page = await ctx.db.query("people").paginate({ numItems: PAGE_SIZE, cursor });

    for (const person of page.page) {
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

    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  return result;
}

export const backfillPeoplePersona: Migration = {
  name: "0051_backfill_people_persona",
  run: runBackfillPeoplePersona,
};
