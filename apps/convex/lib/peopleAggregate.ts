/**
 * People-persona Aggregate — replaces `people.ts#counts`'s old whole-roster
 * scan (founder ask: "there is a convex way to do counts, please do this
 * instead"). Two pieces work together:
 *
 *  1. `people.persona` (`schema/people.ts`) — a DERIVED CACHE of the
 *     `personaFromSignals` ladder (`@events-os/shared`), maintained
 *     write-through below. Never a source of truth, never hand-edited — see
 *     that field's own doc.
 *  2. `peopleByPersona` — a `TableAggregate` namespaced by `chapterId` and
 *     sorted by `[persona, name]`, giving `people.ts#counts` an O(log n)
 *     per-persona count instead of a full roster scan +
 *     `resolvePersonaForRoster` on every call. `[persona, name]` spreads
 *     writes across the B-tree instead of hot-spotting the tail the way
 *     keying on `_creationTime` would (the `@convex-dev/aggregate` README's
 *     documented contention trap); namespacing by chapter means one
 *     chapter's roster churn never contends with another's.
 *
 * Kept in sync via `convex-helpers`' `Triggers` + `customMutation`: EVERY
 * mutation that writes `people`, `engagements`, `roleAssignments`, or
 * `rsvps` — directly, or by calling a helper that does — must be built from
 * the `mutation`/`internalMutation` exported here instead of
 * `./_generated/server`'s raw versions, or its writes silently bypass the
 * trigger and desync the aggregate/cache. A missed write site is a
 * real risk given how many places touch these four tables (roster CRUD,
 * ticketing/giving/attendance-import guest linking, donor linking, the
 * guest-identity review queue, person merges, the AI assistant, Academy
 * training, demo seeding) — `people.ts#repairPersonaAggregate` is the
 * guard against one, and `tests/peopleAggregateConsistency.test.ts` is the
 * test that would catch it.
 *
 * `isPlaceholder`/`isSamplePerson` rows are NEVER represented in the
 * aggregate at all (mirrors `people.ts#counts`'s pre-existing
 * `everyone = people.filter(...)` exclusion) — see `isCountedInAggregate`.
 */
import type { GenericMutationCtx } from "convex/server";
import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import {
  mutation as rawMutation,
  internalMutation as rawInternalMutation,
} from "../_generated/server";
import { TableAggregate } from "@convex-dev/aggregate";
import { Triggers } from "convex-helpers/server/triggers";
import { customCtx, customMutation } from "convex-helpers/server/customFunctions";
import { resolvePersonaForPage } from "./people";

export const peopleByPersona = new TableAggregate<{
  Namespace: Id<"chapters">;
  Key: [string, string];
  DataModel: DataModel;
  TableName: "people";
}>(components.peopleByPersona, {
  namespace: (doc) => doc.chapterId,
  sortKey: (doc) => [doc.persona ?? "contact", doc.name],
});

/** Mirrors `people.ts#counts`'s pre-existing exclusion — a placeholder or
 *  Academy sample-person row is never a real roster member and must never
 *  show up in `all`/persona tallies, so it's never inserted into the
 *  aggregate at all (not even under some sentinel bucket). */
export function isCountedInAggregate(doc: Doc<"people">): boolean {
  return doc.isPlaceholder !== true && doc.isSamplePerson !== true;
}

export const triggers = new Triggers<DataModel>();

// ── `people` itself — own-field persona recompute + existence sync ─────────
//
// `isTeamMember`/`usualRateUsd`/`isVolunteer` live ON this row and can change
// on a plain insert/update with NO other table involved (`people.create`
// setting `isTeamMember: true`, an edit adding `usualRateUsd`, …) — the
// participation-table triggers below can't see that, so this trigger has to
// recompute persona itself rather than only trusting whatever's already
// cached. RECOMPUTE-THEN-SYNC, in two steps:
//  1. Recompute the correct persona from current signals. If it disagrees
//     with the doc's cached `persona`, patch it — that patch re-fires THIS
//     trigger with the corrected doc, converging on the very next
//     (terminal, since persona now matches) invocation. Safe: the
//     computation is a pure function of current state, so this always
//     settles in exactly one extra hop, never a loop.
//  2. Once persona is confirmed correct, sync the aggregate's EXISTENCE for
//     this row against `isCountedInAggregate` (placeholder/sample rows are
//     never represented at all, matching `people.ts#counts`'s pre-existing
//     exclusion).
triggers.register("people", async (ctx, change) => {
  if (change.operation === "delete") {
    if (isCountedInAggregate(change.oldDoc)) {
      await peopleByPersona.deleteIfExists(ctx, change.oldDoc);
    }
    return;
  }

  const newDoc = change.newDoc;
  const resolved = await resolvePersonaForPage(ctx, [newDoc]);
  const correctPersona = resolved.get(newDoc._id) ?? "contact";
  if (newDoc.persona !== correctPersona) {
    await ctx.db.patch(newDoc._id, { persona: correctPersona });
    return;
  }

  const wasIn = change.operation === "update" && isCountedInAggregate(change.oldDoc);
  const isIn = isCountedInAggregate(newDoc);
  if (wasIn && isIn) {
    await peopleByPersona.replaceOrInsert(ctx, change.oldDoc, newDoc);
  } else if (!wasIn && isIn) {
    await peopleByPersona.insertIfDoesNotExist(ctx, newDoc);
  } else if (wasIn && !isIn) {
    await peopleByPersona.deleteIfExists(ctx, change.oldDoc);
  }
  // Neither eligible before nor after: nothing to do.
});

/**
 * Recompute ONE person's cached `persona` (cheap: per-person indexed reads
 * via `resolvePersonaForPage`, never a chapter-wide scan) and patch it only
 * if it actually changed — the patch is what fires the `people` trigger
 * above and keeps the aggregate honest. A no-op if the person no longer
 * exists (already handled by a merge/delete on the `people` table itself).
 */
async function recomputeOne(
  ctx: GenericMutationCtx<DataModel>,
  personId: Id<"people"> | undefined,
): Promise<void> {
  if (!personId) return;
  const person = await ctx.db.get(personId);
  if (!person) return;
  const resolved = await resolvePersonaForPage(ctx, [person]);
  const persona = resolved.get(person._id);
  if (persona && persona !== person.persona) {
    await ctx.db.patch(person._id, { persona });
  }
}

// ── The three participation tables — a row changing here can flip a
//    person's persona even though the `people` row itself wasn't touched
//    (a first RSVP: contact→guest; a first volunteer engagement:
//    guest→volunteer). Recompute is scoped to the one affected person. ──────
triggers.register("engagements", async (ctx, change) => {
  await recomputeOne(ctx, change.newDoc?.personId ?? change.oldDoc?.personId);
});
triggers.register("roleAssignments", async (ctx, change) => {
  await recomputeOne(ctx, change.newDoc?.personId ?? change.oldDoc?.personId);
});
triggers.register("rsvps", async (ctx, change) => {
  const oldPersonId = change.oldDoc?.personId;
  const newPersonId = change.newDoc?.personId;
  await recomputeOne(ctx, oldPersonId);
  if (newPersonId && newPersonId !== oldPersonId) await recomputeOne(ctx, newPersonId);
});

/**
 * Drop-in replacements for `./_generated/server`'s `mutation`/`internalMutation`.
 * Every module that writes `people`/`engagements`/`roleAssignments`/`rsvps`
 * (directly, or via a helper it calls) must build its mutation(s) from these
 * instead — see this module's own doc for why, and the write-site audit in
 * this feature's PR description for the full list of call sites that do.
 */
export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
export const internalMutation = customMutation(rawInternalMutation, customCtx(triggers.wrapDB));
