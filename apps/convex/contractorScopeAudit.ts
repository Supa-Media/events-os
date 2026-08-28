/**
 * WHICH EXISTING CONTRACTOR PAYMENTS SIT IN THE WRONG BOOKS?
 *
 * The 2026-08-28 scope work fixed this going forward: an agreement now belongs
 * to a scope, the books follow the BUDGET rather than whoever composed, and a
 * cross-scope coding is refused at the door. None of that touched rows already
 * written. This is how you find out whether that matters — whether the number
 * is zero, or a handful, or a problem.
 *
 * ── WHY THIS IS A REPORT AND NOT A MIGRATION ────────────────────────────────
 *
 * The obvious "fix" is to rewrite the scope on the affected rows. It would be
 * wrong, and the reason is worth stating plainly because a future reader will
 * be tempted by it.
 *
 * A PAID payment is not a labelling mistake. The money genuinely left a
 * specific Increase account — `payouts.chapterId` is a record of a real bank
 * event, not an attribution — so re-scoping it to central would make the
 * database claim funds departed an account they never touched, which is a
 * worse defect than the one being fixed. The honest correction for money that
 * left the wrong book is an inter-book TRANSFER (central reimburses the
 * chapter, `transfers.ts`), which is a real financial act somebody has to
 * decide to perform.
 *
 * And an UNPAID one is cheap to fix by hand: cancel it and re-compose at the
 * right desk, which is a handful of clicks and leaves a clean audit trail
 * instead of a rewritten one.
 *
 * A published month raises the stakes again: Bylaws Article XI makes a
 * published statement a promise, and amending one is a public act with its own
 * process. So the report says which rows are in that position and stops. What
 * to do about them is the founder's call, not a script's.
 *
 * ── RUNNING IT ──────────────────────────────────────────────────────────────
 *
 *   npx convex run contractorScopeAudit:report '{}'
 *   npx convex run contractorScopeAudit:report '{}' --prod
 *
 * Read-only. Safe to run against production, and safe to run repeatedly.
 */
import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { periodKeyOf } from "./lib/publicLedgerStale";
import { scopeInternalName } from "./lib/financeScope";
import type { FinanceScope } from "./lib/finance";

/** Bounded like every other admin sweep in this codebase — a scan limit that a
 *  chapter's payment volume is nowhere near, so a truncated read would be
 *  visible rather than silent (`truncated` is returned). */
const SCAN_LIMIT = 5000;

/**
 * The scope of the budget actually funding a payment's coding.
 *
 * Deliberately a copy of `contractorPayments.ts#fundingScopeFor`'s logic rather
 * than an import: that one is a write-path guard on the CURRENT rule, and this
 * is a forensic read of historical rows. If the rule changes, this report
 * should keep answering the question it was written to answer — "where did the
 * money for this actually come from" — rather than silently start reporting
 * whatever the new guard happens to check.
 */
async function fundingScopeOf(
  ctx: QueryCtx,
  row: Doc<"contractorPayments">,
): Promise<FinanceScope | null> {
  if (row.budgetId) {
    const budget = await ctx.db.get(row.budgetId);
    return budget?.chapterId ?? null;
  }
  const ref = row.eventId ?? row.projectId;
  if (!ref) return null;
  const refKind = row.eventId ? "event" : "project";
  const budgets = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) =>
      q.eq("refKind", refKind).eq("scopeRefId", String(ref)),
    )
    .take(10);
  if (budgets.length === 0) return null;
  return budgets.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b))
    .chapterId;
}

/** Is the month this transaction falls in already published for the book it
 *  currently sits in? The difference between "fix it" and "amend a public
 *  statement". */
async function isPublished(
  ctx: QueryCtx,
  scope: FinanceScope,
  postedAt: number,
): Promise<boolean> {
  const pub = await ctx.db
    .query("financePublications")
    .withIndex("by_scope_and_period", (q) =>
      q.eq("scope", scope).eq("periodKey", periodKeyOf(postedAt)),
    )
    .first();
  return pub?.status === "published" || pub?.status === "amending";
}

export const report = internalQuery({
  args: {
    /** Include rows that are correctly scoped too, for a full picture. Off by
     *  default — the point of the report is the exceptions. */
    includeClean: v.optional(v.boolean()),
  },
  handler: async (ctx, { includeClean }) => {
    const payments = await ctx.db.query("contractorPayments").take(SCAN_LIMIT);

    const mismatched: Array<{
      contractorPaymentId: Id<"contractorPayments">;
      payeeName: string;
      status: string;
      agreedAmountCents: number;
      bookedTo: string;
      fundedBy: string;
      /** Did money actually leave? This is what decides whether the fix is a
       *  re-compose or an inter-book transfer. */
      moneyMoved: boolean;
      /** Which account it left, when it did — a real bank fact. */
      paidFromScope: string | null;
      ledgerMonth: string | null;
      /** A published month means amending a public statement, not editing a
       *  row. Bylaws Article XI. */
      monthPublished: boolean;
      suggestedFix: string;
    }> = [];

    let clean = 0;
    let uncoded = 0;

    for (const row of payments) {
      const funding = await fundingScopeOf(ctx, row);
      if (funding == null) {
        // A self-serve request that nobody has coded yet. Not a mismatch —
        // `approve` already refuses to release money until somebody codes it.
        uncoded += 1;
        continue;
      }
      if (funding === row.chapterId) {
        clean += 1;
        if (!includeClean) continue;
      }

      const txn = await ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", row._id),
        )
        .first();
      const payout = await ctx.db
        .query("payouts")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", row._id),
        )
        .first();
      const moneyMoved = payout?.status === "paid";
      const monthPublished = txn
        ? await isPublished(ctx, txn.chapterId, txn.postedAt)
        : false;

      const bookedTo = await scopeInternalName(ctx, row.chapterId);
      const fundedBy = await scopeInternalName(ctx, funding);

      mismatched.push({
        contractorPaymentId: row._id,
        payeeName: row.payeeName,
        status: row.status,
        agreedAmountCents: row.agreedAmountCents,
        bookedTo,
        fundedBy,
        moneyMoved,
        paidFromScope: payout
          ? await scopeInternalName(ctx, payout.chapterId)
          : null,
        ledgerMonth: txn ? periodKeyOf(txn.postedAt) : null,
        monthPublished,
        suggestedFix: !moneyMoved
          ? `Cancel it and re-compose at the ${fundedBy} desk — nothing has been sent, so this costs nothing but a few clicks.`
          : monthPublished
            ? `Money left ${bookedTo}'s account and the month is PUBLISHED. Correcting this is an amendment plus an inter-book transfer from ${fundedBy} — a decision, not an edit.`
            : `Money left ${bookedTo}'s account against ${fundedBy}'s budget. Book an inter-book transfer so the two agree; do not relabel the payout, which records a real bank event.`,
      });
    }

    return {
      scanned: payments.length,
      truncated: payments.length === SCAN_LIMIT,
      clean,
      uncoded,
      mismatchedCount: mismatched.length,
      // Sorted worst-first: published months, then money that moved, then the
      // cheap ones — the order somebody would want to work them in.
      mismatched: mismatched.sort(
        (a, b) =>
          Number(b.monthPublished) - Number(a.monthPublished) ||
          Number(b.moneyMoved) - Number(a.moneyMoved) ||
          b.agreedAmountCents - a.agreedAmountCents,
      ),
      note:
        mismatched.length === 0
          ? "Nothing is mis-scoped. No migration is needed."
          : "Read `suggestedFix` per row. Nothing here is safe to fix by rewriting scope — see this module's header for why.",
    };
  },
});
