/**
 * Who may change what a payment rail is recorded as costing.
 *
 * Written as a named resolver on day one even though the answer today is
 * "a superuser", per the house rule: a capability that might ever need
 * restricting gets a `has`/`require` pair from the start, so adding the real
 * gate is one file rather than every call site.
 *
 * WHY THIS IS GUARDED AT ALL. The schedule is not a display preference. It
 * decides what a donor who ticks "cover the processing fees" is CHARGED, and
 * it decides the blended effective rate the finance dashboard reports. An
 * over-stated rate quietly overcharges every donor who opts in; an
 * under-stated one quietly leaves the org short on every one of them. That is
 * a money control, and money controls in this codebase are named.
 *
 * WHY SUPERUSER RATHER THAN THE FINANCE LADDER. A rate change is an org-wide
 * fact about a merchant agreement, not a chapter's bookkeeping — there is no
 * chapter to check a finance role against, and `requireCentralFinanceRole`
 * needs one. When this graduates, the capability to add to `SEAT_CAPABILITIES`
 * is `finance.settings` and the seats to carry it are the Treasurer and the
 * Financial Manager; only this file's body changes.
 */
import type { QueryCtx } from "../_generated/server";
import { isSuperuser, requireSuperuser } from "./superuser";

/** May the caller edit the fee schedule? */
export async function hasFeeScheduleManage(ctx: QueryCtx): Promise<boolean> {
  return isSuperuser(ctx);
}

/** Assert it. Throws `ConvexError` so the app's error boundary can surface it. */
export async function requireFeeScheduleManage(ctx: QueryCtx): Promise<void> {
  await requireSuperuser(ctx);
}
