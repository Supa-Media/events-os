/**
 * Access gate for the Service Catalog (`serviceOptions.ts`) — the managed
 * dropdown behind `people.serviceIds` (see `schema/services.ts`'s module
 * doc). Named/seamed from day one per CLAUDE.md's "Gate It Behind a Power,
 * Even When It's Open Today": the founder's explicit call is that ANYONE in
 * the chapter can manage the catalog today (add/rename/deactivate/merge
 * options — it's a shared vocabulary, not a sensitive resource), but that
 * could change (e.g. restricting catalog edits to a chapter director once
 * chapters accumulate a lot of cruft), so the check lives behind a named
 * resolver instead of being inlined "anyone can do this" at each of
 * `serviceOptions.ts`'s five call sites.
 *
 * TODAY's body is exactly `lib/context.ts#requireChapterId`'s membership
 * check (the same "does the caller belong to THIS chapter" rule
 * `people.create` relies on), just non-throwing so `requireManageServiceCatalog`
 * can raise its own, catalog-specific message.
 *
 * GRADUATING THIS to a real gate (mirrors `lib/campaignsAccess.ts` /
 * `lib/givingAccess.ts`'s doc on the same move) is a THREE-STEP, ONE-FILE
 * change, no call-site churn:
 *   1. Add `"services.manageCatalog"` to `SEAT_CAPABILITIES`
 *      (`packages/shared/src/seats.ts`).
 *   2. List it on whichever `SEAT_DEFS` entries should carry it (e.g.
 *      `chapter_director`).
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

/** True iff the caller may manage `chapterId`'s service catalog. Today: any
 *  authenticated member of that chapter (superuser always passes, the
 *  bootstrap path mirrored across the repo). See the module doc for what this
 *  graduates to. */
export async function canManageServiceCatalog(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  const callerChapterId = await getChapterIdOrNull(ctx);
  return callerChapterId === chapterId;
}

/** The throwing gate every `serviceOptions.ts` mutation calls — no inline
 *  membership checks anywhere in that file. */
export async function requireManageServiceCatalog(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  if (!(await canManageServiceCatalog(ctx, chapterId))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to this chapter's service catalog.",
    });
  }
}
