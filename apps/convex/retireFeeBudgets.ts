/**
 * One-time: retire the two draft budgets the fee sync proposed to itself.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * `processorFees.ts#resolveFeeBudgets` auto-created a DRAFT yearly budget per
 * fee year to attribute processor fees against — "Processor fees 2025" ($100)
 * and "Processor fees 2026" ($300), both on New York's General Fund under Bank
 * & Fees. It never attributed anything to them, correctly: a draft confers no
 * authority, and `assertBudgetApprovedForAttribution` would refuse the same
 * link from a human. So the morning engine asked, every morning, for somebody
 * to approve them.
 *
 * Nobody ever did, and nobody should have. A budget is a control on CHOICE, and
 * a processor fee is not one — it is mechanically 2.9% + 30c of money the org
 * already decided to accept, and it cannot be declined without declining the
 * gift. A fee budget can never cause anyone to spend less. It can only produce
 * friction, and it is an INVERTED indicator besides: "over budget on fees" is
 * what a record fundraising month looks like. At $1M raised, Stripe's cut is
 * ~$29,000 against a $300 ceiling.
 *
 * The result was 8 rows totalling $318.69 reading "Needs budget" forever.
 *
 * #584 removed the machinery and marked the fee rows `feeOrigin`, which
 * `finances.ts#needsBudget` reads. This clears what already landed.
 *
 * ── WHY DELETE RATHER THAN EXCLUDE ──────────────────────────────────────────
 * `reverseBadSettlement.ts` excluded its rows rather than deleting them, and
 * was right to: those were real LEDGER entries recording money that had been
 * booked, and the audit trail of a money-path mistake is worth more than a tidy
 * table. These are neither. A draft budget is a PROPOSAL — no money moved, no
 * decision was taken, no `createdBy` was ever set because no user made them,
 * and `budgets` has no exclusion state anyway (that vocabulary belongs to
 * `transactions`). What is worth keeping about them is the reasoning, and that
 * lives in this file and in #584.
 *
 * ── WHY THE "BANK & FEES" CATEGORY STAYS ────────────────────────────────────
 * The brief asked to retire the category too. Doing that would be wrong, and
 * this is the one place the module deviates from its instructions:
 *
 *  1. The category is the fee rows' CODING, not their budget. Fees still get
 *     coded and still appear in reporting — that was never the objection. Every
 *     one of these 8 rows carries `categoryId` pointing at it; deleting it
 *     would strip the coding off the very rows this change is meant to settle.
 *  2. It is where the DISCRETIONARY finance costs belong — a monthly platform
 *     subscription, a paid Givebutter tier, an accounting service. Those are
 *     real decisions and they must stay budgeted. Deleting the category would
 *     remove the home of exactly the costs that keep their budget.
 *  3. Other rows may reference it, and this module reports how many rather than
 *     guessing.
 *
 * The line is drawn at the fee ORIGIN, never at a category name. That is what
 * makes it narrow enough to be right.
 *
 * ── SAFE BECAUSE NOTHING POINTS AT THEM ─────────────────────────────────────
 * The preconditions below refuse to delete a budget that any transaction is
 * attributed to, that carries a `createdBy` (a human made it, so it is theirs
 * to retire), that isn't `draft`, or whose shape doesn't match what the sync
 * wrote. Any mismatch SKIPS and reports rather than writing. A budget with
 * spend against it is not this module's to remove.
 *
 * Re-running is safe: the budgets are gone, so the second run reports
 * `alreadyGone` and writes nothing.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { needsBudget } from "./finances";

/** The labels the retired `feeBudgetLabel(year)` produced. */
const LABELS = ["Processor fees 2025", "Processor fees 2026"];

/**
 * The three Cash App fee rows, by the `externalId` `cashApp2026.ts` gave them.
 *
 * The Stripe rows mark themselves: `processorFees.ts` re-sweeps every month on
 * every run, so its back-fill reaches rows written before `feeOrigin` existed.
 * `cashAppBackfill.ts` is a one-off that has already run — its new marker only
 * fires on INSERT, and these three rows are already inserted. So they are
 * stamped here, by their exact keys, rather than by re-running a historical
 * backfill over production.
 */
const CASH_APP_FEE_REFS = [
  "cashapp-fees:2025-11-06",
  "cashapp-fees:2026-01-06",
  "cashapp-fees:2026-08-07",
];

export const retireFeeBudgets = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    /** What was found, before anything was done. */
    found: v.array(
      v.object({
        label: v.string(),
        year: v.union(v.number(), v.null()),
        amountCents: v.number(),
        approvalStatus: v.union(v.string(), v.null()),
        attributedTransactions: v.number(),
      }),
    ),
    deleted: v.number(),
    alreadyGone: v.number(),
    /** Fee rows still reading "Needs budget" AFTER this run's view of things. */
    feeRowsStillNeedingBudget: v.number(),
    feeRowsMarked: v.number(),
    cashAppRowsStamped: v.number(),
    feeRowCents: v.number(),
    /** Rows coded to Bank & Fees — evidence for keeping the category. */
    bankAndFeesCodedRows: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];

    // ── Look at every fee row, marked or not ─────────────────────────────────
    // Bounded scan of the ledger; this deployment's `transactions` table is in
    // the low thousands and `reverseBadSettlement`-style one-offs read it the
    // same way.
    const allTxns = await ctx.db.query("transactions").take(20_000);

    // ── Stamp the Cash App fee rows ──────────────────────────────────────────
    // Matched on their exact `externalId`s and nothing looser, and each is
    // checked to still look like the fee row it should be before it is touched.
    let cashAppRowsStamped = 0;
    for (const ref of CASH_APP_FEE_REFS) {
      const row = allTxns.find((t) => t.externalId === ref);
      if (!row) {
        problems.push(`no transaction with externalId ${ref} — SKIPPED`);
        continue;
      }
      if (row.feeOrigin != null) continue; // already stamped — idempotent
      if (row.flow !== "outflow" || row.merchantName !== "Cash App") {
        problems.push(
          `${ref} is ${row.flow}/${row.merchantName ?? "no merchant"}, not a Cash App ` +
            `outflow — SKIPPED`,
        );
        continue;
      }
      if (write) await ctx.db.patch(row._id, { feeOrigin: "cash_app_processing" });
      // Reflect the stamp in this run's census even on a dry run, so the
      // preview shows what the real run would leave behind.
      row.feeOrigin = "cash_app_processing";
      cashAppRowsStamped += 1;
    }

    const feeRows = allTxns.filter((t) => t.feeOrigin != null);
    const feeRowCents = feeRows.reduce((sum, t) => sum + t.amountCents, 0);
    const feeRowsStillNeedingBudget = feeRows.filter((t) => needsBudget(t)).length;

    // ── The budgets ──────────────────────────────────────────────────────────
    const budgets = await ctx.db.query("budgets").take(5_000);
    const targets = budgets.filter((b) => LABELS.includes(b.label?.trim() ?? ""));

    const found: {
      label: string;
      year: number | null;
      amountCents: number;
      approvalStatus: string | null;
      attributedTransactions: number;
    }[] = [];

    let bankAndFeesCodedRows = 0;
    const categoryIds = new Set(targets.map((b) => String(b.categoryId)));
    for (const t of allTxns) {
      if (t.categoryId != null && categoryIds.has(String(t.categoryId))) {
        bankAndFeesCodedRows += 1;
      }
    }

    const deletable: typeof targets = [];
    for (const b of targets) {
      const attributed = allTxns.filter((t) => String(t.budgetId) === String(b._id));
      found.push({
        label: b.label ?? "",
        year: b.year ?? null,
        amountCents: b.amountCents,
        approvalStatus: b.approvalStatus ?? null,
        attributedTransactions: attributed.length,
      });

      // ── Preconditions. Any failure SKIPS this budget. ──────────────────────
      if (b.approvalStatus !== "draft") {
        problems.push(
          `"${b.label}" is ${b.approvalStatus ?? "grandfathered"}, not draft — a budget somebody ` +
            `approved is theirs to retire, not this module's — SKIPPED`,
        );
        continue;
      }
      if (b.createdBy != null) {
        problems.push(
          `"${b.label}" carries createdBy ${b.createdBy} — a human made this one — SKIPPED`,
        );
        continue;
      }
      if (attributed.length > 0) {
        problems.push(
          `"${b.label}" has ${attributed.length} transaction(s) attributed to it — deleting it ` +
            `would orphan real coding — SKIPPED`,
        );
        continue;
      }
      // Also refuse anything pointed at by the budget's own dependents, which
      // a proposal never has but a real budget would.
      const lines = await ctx.db
        .query("budgetLines")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .take(1);
      if (lines.length > 0) {
        problems.push(`"${b.label}" has budget lines under it — SKIPPED`);
        continue;
      }
      const log = await ctx.db
        .query("budgetApprovalLog")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .take(1);
      if (log.length > 0) {
        problems.push(
          `"${b.label}" has an approval-decision history — somebody acted on it — SKIPPED`,
        );
        continue;
      }
      deletable.push(b);
    }

    // DELIBERATELY COUPLED: any problem anywhere — a missing Cash App row, a
    // budget that doesn't match — stops the deletions too. If production does
    // not look the way this module expects, the right move is to stop and be
    // read, not to do the half it still recognises.
    let deleted = 0;
    if (problems.length === 0) {
      for (const b of deletable) {
        if (write) await ctx.db.delete(b._id);
        deleted += 1;
      }
    }

    return {
      dryRun: !write,
      found,
      deleted,
      alreadyGone: LABELS.length - targets.length,
      feeRowsStillNeedingBudget,
      feeRowsMarked: feeRows.length,
      cashAppRowsStamped,
      feeRowCents,
      bankAndFeesCodedRows,
      problems,
    };
  },
});
