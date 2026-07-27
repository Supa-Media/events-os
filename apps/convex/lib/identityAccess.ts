/**
 * Access gate for the Guest Identity review queue (Partiful name-only RSVP
 * resolution — see `migrations/0049_link_rsvp_identifiers.ts` for the
 * automated half and `identity.ts` for the human half). Named/seamed from day
 * one per CLAUDE.md's "Gate It Behind a Power, Even When It's Open Today":
 * the founder's EXPLICIT call is that ANYONE logged in on the team can review
 * the queue and act on it (link a guest, create a new contact, merge a
 * duplicate, record "different") TODAY — this is shared clerical cleanup
 * work, not a sensitive/destructive-by-a-single-click resource — but that
 * could change, so the check lives behind a named resolver instead of being
 * inlined "anyone can do this" at each of `identity.ts`'s call sites.
 *
 * TODAY's body is exactly bare chapter membership (mirrors
 * `lib/servicesAccess.ts#canManageServiceCatalog`'s chapter-scope body): the
 * caller belongs to `chapterId` (via `lib/context.ts#getChapterIdOrNull`), or
 * is a superuser. A future gate might instead require a specific seat (e.g.
 * only certain seats can MERGE two people, even if anyone can LINK a guest) —
 * that's a real distinction this file doesn't draw yet, on purpose.
 *
 * GRADUATING THIS to a real gate (mirrors `lib/servicesAccess.ts`'s doc on
 * the same move) is a THREE-STEP, ONE-FILE change, no call-site churn:
 *   1. Add `"identity.review"` to `SEAT_CAPABILITIES` (`packages/shared/src/seats.ts`).
 *   2. List it on whichever `SEAT_DEFS` entries should carry it.
 *   3. Change ONLY this file's body to check that capability (the
 *      `holdsCampaignCapabilityAt`-style seat scan) instead of bare
 *      membership.
 * Do NOT add the capability string until that decision is actually made —
 * this file's job right now is only to name the seam, not to pre-declare a
 * power nobody can grant yet.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getChapterIdOrNull } from "./context";
import { isSuperuser } from "./superuser";

/** True iff the caller may review/act on `chapterId`'s guest-identity queue.
 *  Today: any authenticated member of that chapter, or a superuser. See the
 *  module doc for what this graduates to. */
export async function canReviewGuestIdentity(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  const callerChapterId = await getChapterIdOrNull(ctx);
  if (callerChapterId === null) return false;
  return callerChapterId === chapterId;
}

/** The throwing gate every `identity.ts` mutation calls — no inline
 *  membership checks anywhere in that file. */
export async function requireReviewGuestIdentity(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  if (!(await canReviewGuestIdentity(ctx, chapterId))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to this chapter's identity review queue.",
    });
  }
}
