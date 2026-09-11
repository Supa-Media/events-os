/**
 * Duty-catalog authorization — the one named gate for "may this caller SHAPE
 * the recurring-duty catalog?", as opposed to merely reading it.
 *
 * Every duty mutation (`responsibilities.create`/`update`/`remove`/
 * `addSeat`/`removeSeat`/`addAssignee`/`removeAssignee`) resolves through
 * `requireManageDuties`, and the surfaces that render editing affordances ask
 * `canManageDuties` — the boolean twin, so an org-chart seat panel never shows
 * an inline editor whose write would then 403. Nothing checks manager-ness
 * inline any more.
 *
 * THE ANSWER TODAY is "a manager (any effective direct report, seat-derived or
 * stored) or a chapter admin" — `requireManagerOrAdmin`, unchanged. It matters
 * because these rows feed the check-in accountability loop: the person being
 * held to a duty must not be able to quietly delete or unassign it before
 * their 1:1. When that needs to become a real, grantable power, this graduates
 * to a `duties.manage` power in `powers.ts` listed on the seats that should
 * carry it, and ONLY the two bodies below change — no call-site churn. See
 * `lib/campaignsAccess.ts` and `lib/givingAccess.ts` for the same shape.
 *
 * Authorship is a SEPARATE axis this file deliberately doesn't fold in: a
 * seat-mapped duty is org-wide (see `responsibilities.ts`'s `orgWideCatalog`)
 * but only its AUTHORING chapter may write it (`requireOwned`). So an editable
 * row is `canManageDuties(ownChapter) && row.chapterId === ownChapter` —
 * exactly what `dutiesForSeat`'s `canEdit` reports.
 */
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { requireManagerOrAdmin } from "./org";

/** May the caller shape `chapterId`'s duty catalog? Boolean twin of
 *  `requireManageDuties`, for read surfaces that decide whether to RENDER an
 *  editor. Never swallow this into a write path — writes call `require`. */
export async function canManageDuties(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  try {
    await requireManageDuties(ctx, chapterId);
    return true;
  } catch {
    return false;
  }
}

/** Assert the caller may shape `chapterId`'s duty catalog, else throw the
 *  `FORBIDDEN` ConvexError every duty mutation surfaces verbatim. */
export async function requireManageDuties(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireManagerOrAdmin(ctx, chapterId);
}
