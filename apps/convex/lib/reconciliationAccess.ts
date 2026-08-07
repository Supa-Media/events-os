/**
 * Access resolver for the morning reconciliation engine's audit surface —
 * the accounts-page balances/history views, the FM's flag/resolve actions,
 * the pause toggle, and the manual "run now".
 *
 * House rule ("Gate It Behind a Power, Even When It's Open Today"): call
 * sites use ONLY this pair; nothing checks seats inline. Today the body is
 * exactly the Accounts-tab gate (`isCentralEdOrFm` — the Executive Director +
 * Financial Manager seats from the PRD §0.2, plus superuser), because the
 * engine's audit surface lives ON the accounts page and answers to the same
 * two seats. When this needs its own grain it graduates to a
 * `finance.reconciliation.audit` capability in `SEAT_CAPABILITIES`
 * (`packages/shared/src/seats.ts`) — add the string, list it on the seats
 * that should carry it, and change ONLY this file's body (the
 * `campaignsAccess.ts` / `givingAccess.ts` precedent).
 */
import type { QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { isCentralEdOrFm } from "./finance";

/** Whether the caller may view/operate the reconciliation audit surface. */
export async function hasReconciliationAudit(ctx: QueryCtx): Promise<boolean> {
  return await isCentralEdOrFm(ctx);
}

/** Assert `hasReconciliationAudit`, `ConvexError` on refusal (house rule). */
export async function requireReconciliationAudit(ctx: QueryCtx): Promise<void> {
  if (!(await hasReconciliationAudit(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Reconciliation is visible only to the Executive Director and Financial Manager.",
    });
  }
}
