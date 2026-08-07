/**
 * One-time approval of the four receipt exceptions filed by the genesis cleanup.
 *
 * WHY THIS EXISTS AT ALL. `genesisCleanup` deliberately filed those exceptions rather
 * than self-approving them: approving a no-receipt claim is a judgement about someone's
 * spending, and `receiptExceptions.approve` enforces separation of duties. The owner
 * has now made that judgement — but he can't act on it from the reconcile grid, where
 * "Awaiting approval" is inert text rather than a control (the decide UI lives only in
 * the dashboard drill-down's detail panel). This unblocks him while that gap is fixed
 * properly in the app.
 *
 * IT IS NOT A BYPASS. The owner is a superuser and `requireApproveReceiptException`
 * would grant him central finance-manager rights through the normal public mutation;
 * this runs the SAME `decideException` core with his person id as the decider, so the
 * audit trail records exactly what it would have had he clicked a button. What it
 * skips is only the auth resolution, which a CLI call has no session for.
 *
 * SEPARATION OF DUTIES STILL HOLDS. The cleanup attested with
 * `attestedByPersonId: null`, so there is no requester for the approver to collide
 * with — `assertSeparationOfDuties` cannot fire here even on the public path. This
 * module asserts that explicitly rather than relying on it: an exception whose
 * `attestedByPersonId` matches the decider is SKIPPED, never approved.
 *
 * SCOPE: only the four `lost` exceptions this cleanup filed, matched by transaction
 * `externalId`. It will not decide anything a human filed.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { decideException } from "./lib/receiptExceptions";
import { logFinanceAudit } from "./lib/financeAuditLog";
import { CLEANUP_EXCEPTIONS } from "./lib/seed/historical/genesisCleanup2026";

const SCAN_LIMIT = 6000;

export const approveGenesisExceptions = internalMutation({
  args: {
    decidedByPersonId: v.id("people"),
    decidedByUserId: v.id("users"),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    approved: v.number(),
    alreadyDecided: v.number(),
    skipped: v.array(v.string()),
  }),
  handler: async (ctx, { decidedByPersonId, decidedByUserId, execute }) => {
    const write = execute ?? false;
    const wanted = new Set(CLEANUP_EXCEPTIONS.map((e) => e.externalId));

    // Resolve the cleanup's transactions, then their exceptions. Scoped by
    // externalId so nothing a human filed can be swept up.
    const chapters = await ctx.db.query("chapters").collect();
    const txns: Doc<"transactions">[] = [];
    for (const c of chapters) {
      txns.push(
        ...(await ctx.db
          .query("transactions")
          .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", c._id))
          .take(SCAN_LIMIT)),
      );
    }
    const mine = txns.filter((t) => t.externalId && wanted.has(t.externalId));

    let approved = 0;
    let alreadyDecided = 0;
    const skipped: string[] = [];

    for (const txn of mine) {
      const rows = await ctx.db
        .query("receiptExceptions")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
        .collect();
      const pending = rows.filter((r) => r.status === "pending");
      if (!pending.length) { alreadyDecided++; continue; }
      for (const ex of pending) {
        // Never approve one's own filing, even though the cleanup left no filer.
        if (ex.attestedByPersonId != null && ex.attestedByPersonId === decidedByPersonId) {
          skipped.push(`${txn.externalId}: decider is the filer — separation of duties`);
          continue;
        }
        if (write) {
          await decideException(ctx, {
            exception: ex,
            approve: true,
            decisionNote:
              "Approved by the owner after reviewing each row against what evidence exists. " +
              "Filed by the 2026-08-06 genesis cleanup; decided out-of-band because the " +
              "reconcile grid offers no decide control.",
            decidedByPersonId,
            decidedByUserId,
          });
          await logFinanceAudit(ctx, {
            chapterId: txn.chapterId,
            subjectType: "transaction",
            subjectId: txn._id,
            action: "receipt_exception_decide",
            actorPersonId: decidedByPersonId,
            field: "receiptException",
            before: "Awaiting approval",
            after: "Approved — Lost",
            amountCents: txn.amountCents,
          });
        }
        approved++;
      }
    }

    return { dryRun: !write, approved, alreadyDecided, skipped };
  },
});
