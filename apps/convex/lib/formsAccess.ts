/**
 * Access gate for Form Submissions (`schema/forms.ts`) — named/seamed from day
 * one per CLAUDE.md's "Gate It Behind a Power, Even When It's Open Today":
 * today ANYONE in the chapter can view that chapter's form submissions (a
 * consolidated Google Forms import, not a sensitive resource on its own) and
 * the only WRITE path is the internal Google Forms import (`formSubmissions.ts`'s
 * `importSubmissionsBatch`, called only from the "use node" import action —
 * never a public mutation in this PR), so there's no end-user write to gate
 * yet. Still, the read side goes through a named resolver instead of an
 * inline "anyone can do this" at each of `formSubmissions.ts`'s three query
 * call sites — see `lib/servicesAccess.ts` for the identical shape this
 * copies.
 *
 * SCOPED like every other chapter-owned table here: a `formSubmissions`/
 * `formDefinitions` row's own `chapterId` decides visibility, never the
 * caller's. TODAY's body is exactly `lib/context.ts#requireChapterId`'s
 * membership check (the same "does the caller belong to THIS chapter" rule
 * `people.create` and `serviceOptions`'s central-scope check rely on).
 *
 * GRADUATING THIS to a real gate (mirrors `lib/servicesAccess.ts`'s own doc on
 * the same move) is a THREE-STEP, ONE-FILE change, no call-site churn:
 *   1. Add `"forms.view"` (and, once an in-app submission UI exists,
 *      `"forms.manage"`) to `SEAT_CAPABILITIES` (`packages/shared/src/seats.ts`).
 *   2. List it on whichever `SEAT_DEFS` entries should carry it.
 *   3. Change ONLY this file's body to check that capability instead of bare
 *      membership.
 * Do NOT add either capability string until that decision is actually made —
 * this file's job right now is only to name the seam.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getChapterIdOrNull } from "./context";
import { isSuperuser } from "./superuser";

/** True iff the caller may VIEW `chapterId`'s form submissions/definitions.
 *  Today: any authenticated member of that chapter — superuser always passes,
 *  the bootstrap path mirrored across the repo. See the module doc for what
 *  this graduates to (`"forms.view"`). */
export async function canViewFormSubmissions(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  const callerChapterId = await getChapterIdOrNull(ctx);
  return callerChapterId !== null && callerChapterId === chapterId;
}

/** The throwing gate every `formSubmissions.ts` query calls — no inline
 *  membership checks at the call sites. Always pass the ROW'S OWN chapterId
 *  (the linked person's/event's `chapterId`), never the caller's. */
export async function requireViewFormSubmissions(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  if (!(await canViewFormSubmissions(ctx, chapterId))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to this chapter's form submissions.",
    });
  }
}

/**
 * True iff the caller may MANAGE (write/import into) `chapterId`'s form
 * submissions. Not called by anything in this PR — the only write path is
 * the internal import (`internalMutation`s aren't reachable by end users at
 * all, so they don't need this gate) — but named now, per the same CLAUDE.md
 * section, for the in-app submission UI a later PR will add. Today: same
 * body as `canViewFormSubmissions` (bare chapter membership); graduates to
 * `"forms.manage"` per the module doc.
 */
export async function canManageFormSubmissions(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  return canViewFormSubmissions(ctx, chapterId);
}
