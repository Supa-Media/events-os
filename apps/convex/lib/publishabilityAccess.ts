/**
 * Publishability authorization — who may read the CLOSE-GATE ARTIFACT: the
 * per-period report of what stands between a book and a public ledger
 * (`publishability.ts`, `docs/plans/transaction-coding.md` phase 4).
 *
 * House rule ("Gate It Behind a Power, Even When It's Open Today"): the query
 * calls ONLY this pair; nothing in `publishability.ts` checks a seat or a
 * finance role inline. Two powers, because the report has two genuinely
 * different blast radii:
 *
 *  - REPORT (`requirePublishabilityReport`) — read ONE book's gap. Today the
 *    body is exactly `listReconcile`'s own read gate, because it answers the
 *    same question over the same rows: finance VIEWER+ for the caller's own
 *    chapter, central reach for a central-owned or foreign-chapter book. A
 *    viewer floor rather than manager is deliberate — this is the number a
 *    treasurer, a bookkeeper and the ED all have to be looking at together
 *    during a close, and hiding it from the people doing the work is how a
 *    close-gate number stops being believed.
 *
 *  - ALL BOOKS (`requirePublishabilityAllBooks`) — read the MERGED org-wide
 *    report (central + every active chapter in one set of numbers). Central
 *    reach, mirroring `lib/finance.ts#hasAllBooksReconcile`: merging separate
 *    operating books into one figure is a central-desk act, not a chapter
 *    treasurer's.
 *
 * Both graduate to `finance.publishability.view` in `SEAT_CAPABILITIES`
 * (`packages/shared/src/seats.ts`) the day publication becomes a restricted
 * duty — e.g. the org decides only the ED and Financial Manager may see (or
 * quote) the pre-publication gap, so a chapter treasurer can work their own
 * backlog without being able to characterize the org's readiness. Adding it
 * is: add the string, list it on the seats that should carry it, and change
 * ONLY these bodies. No call site moves. (The `campaignsAccess.ts` /
 * `givingAccess.ts` / `reconciliationAccess.ts` precedent.)
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CENTRAL } from "@events-os/shared";
import {
  getFinanceRole,
  requireFinanceCentral,
  requireFinanceRole,
  type FinanceAccess,
  type FinanceScope,
} from "./finance";

/**
 * Whether the caller may read the publishability report for ONE book.
 *
 * `homeChapterId` is always the CALLER's own chapter — a central grant is
 * scope-wide regardless of which chapterId it's resolved against, but
 * `getFinanceRole` only finds a roster row in the chapter passed in (the same
 * note `listReconcile`'s drill-down branch carries). `book` is what they're
 * asking to see.
 */
export async function hasPublishabilityReport(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  book: FinanceScope,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, homeChapterId);
  if (book === CENTRAL || book !== homeChapterId) return access.isCentral;
  return access.role != null;
}

/** The `require` half of {@link hasPublishabilityReport} — every call site
 *  uses this. Returns the resolved access so the caller doesn't re-resolve. */
export async function requirePublishabilityReport(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  book: FinanceScope,
): Promise<FinanceAccess> {
  // Central-owned money, or another chapter's book: central reach, exactly
  // like `listReconcile`'s `scope:"central"` / `chapterId` drill-down.
  if (book === CENTRAL || book !== homeChapterId) {
    return requireFinanceCentral(ctx, homeChapterId);
  }
  return requireFinanceRole(ctx, homeChapterId, "viewer");
}

/** Whether the caller may read the MERGED org-wide report (every book at
 *  once). Read-only probe for the UI; the query still calls the `require`
 *  form. */
export async function hasPublishabilityAllBooks(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, homeChapterId);
  return access.isCentral;
}

/** The `require` half of {@link hasPublishabilityAllBooks}. */
export async function requirePublishabilityAllBooks(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, homeChapterId);
  if (!access.isCentral) {
    // `ConvexError({ code, message })` is the app-wide refusal shape the
    // mobile `FinanceBoundary` / `AuthErrorBoundary` read.
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "The org-wide publishability report needs central (org-wide) finance access.",
    });
  }
  return access;
}
