/**
 * Access gate for the Service Catalog (`serviceOptions.ts`) — the managed
 * dropdown behind `people.serviceIds` (see `schema/services.ts`'s module
 * doc). Named/seamed from day one per CLAUDE.md's "Gate It Behind a Power,
 * Even When It's Open Today": the founder's explicit call is that ANYONE in
 * the chapter can manage the catalog today (add/rename/deactivate/merge
 * options — it's a shared vocabulary, not a sensitive resource), but that
 * could change, so the check lives behind a named resolver instead of being
 * inlined "anyone can do this" at each of `serviceOptions.ts`'s call sites.
 *
 * SCOPED like the catalog itself (`schema/services.ts`): a `ServiceCatalogScope`
 * is either `"central"` (an org-wide option, affecting every chapter) or a
 * specific chapter (a local addition). TODAY's body for a chapter scope is
 * exactly `lib/context.ts#requireChapterId`'s membership check (the same
 * "does the caller belong to THIS chapter" rule `people.create` relies on);
 * for `"central"` it's "belongs to ANY chapter" (there's no separate
 * org-membership concept — every chapter member is part of the org). Both
 * are non-throwing so `requireManageServiceCatalog` can raise its own,
 * catalog-specific message.
 *
 * ORG-WIDE EDITS ARE THE LIKELIEST THING TO GATE FIRST: a chapter director
 * renaming their own chapter's local addition affects only their roster; an
 * org-wide rename/merge reshapes every chapter's catalog at once. When that
 * graduates, expect chapter-local scope to stay open (bare membership) while
 * `"central"` starts checking a real capability — but that's a future
 * decision, not this one.
 *
 * GRADUATING THIS to a real gate (mirrors `lib/campaignsAccess.ts` /
 * `lib/givingAccess.ts`'s doc on the same move) is a THREE-STEP, ONE-FILE
 * change, no call-site churn:
 *   1. Add `"services.manageCatalog"` to `SEAT_CAPABILITIES`
 *      (`packages/shared/src/seats.ts`).
 *   2. List it on whichever `SEAT_DEFS` entries should carry it (e.g.
 *      `chapter_director`, or a central seat for the org-wide half).
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

/** A service-catalog scope: `"central"` (org-wide, every chapter) or a real
 *  chapter (that chapter's local additions) — mirrors `schema/services.ts`'s
 *  `chapterId` (absent = central) and the `GivingScope`/`FinanceScope`
 *  central-sentinel convention used elsewhere in this repo. */
export type ServiceCatalogScope = Id<"chapters"> | "central";

/** True iff the caller may manage `scope`'s service catalog. Today: any
 *  authenticated member of `scope` (a specific chapter), or any authenticated
 *  member of ANY chapter for `"central"` — superuser always passes, the
 *  bootstrap path mirrored across the repo. See the module doc for what this
 *  graduates to. */
export async function canManageServiceCatalog(
  ctx: QueryCtx,
  scope: ServiceCatalogScope,
): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  const callerChapterId = await getChapterIdOrNull(ctx);
  if (callerChapterId === null) return false;
  if (scope === "central") return true;
  return callerChapterId === scope;
}

/** The throwing gate every `serviceOptions.ts` mutation calls — no inline
 *  membership checks anywhere in that file. Always call with the OPTION'S
 *  OWN scope (`row.chapterId ?? "central"`), not the caller's chapter. */
export async function requireManageServiceCatalog(
  ctx: QueryCtx,
  scope: ServiceCatalogScope,
): Promise<void> {
  if (!(await canManageServiceCatalog(ctx, scope))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        scope === "central"
          ? "You don't have access to the org-wide service catalog."
          : "You don't have access to this chapter's service catalog.",
    });
  }
}
