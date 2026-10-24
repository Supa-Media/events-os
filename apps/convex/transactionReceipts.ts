/**
 * Taking a receipt OFF a transaction — the member-facing counterpart to
 * `finances.attachReceipt`.
 *
 * Founder, 2026-10-24, with a storage-unit invoice attached to a Google
 * charge: "I need to be able to remove this attachment (I uploaded it by
 * mistake)." Detaching already existed (`receipts.unlinkReceipt`) but only
 * for bookkeepers, so the person who made the mistake on `/code` had no way
 * to undo it. Who may remove is `lib/transactionReceiptAccess.ts`'s call:
 * whoever may attach, until the coding is approved.
 *
 * The receipt document itself is NOT deleted — only the link comes off, the
 * same as `unlinkReceipt` — so a file attached to the wrong charge can still
 * be found in the library and attached to the right one.
 */
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { RECEIPT_STATE_LABELS } from "@events-os/shared";
import { requireChapterId } from "./lib/context";
import { viewerPerson } from "./lib/org";
import { unlinkReceiptFromTransaction } from "./lib/receiptLinks";
import { logFinanceAudit } from "./lib/financeAuditLog";
import {
  requireRemoveTransactionReceipt,
  transactionReceiptPermissions,
} from "./lib/transactionReceiptAccess";

/** What the caller may do with this charge's receipts — drives which buttons
 *  the receipt viewer and the coding panel draw. Never throws on a missing
 *  right; the mutations below are the real gate. */
export const permissions = query({
  args: { transactionId: v.id("transactions") },
  returns: v.object({
    canAttach: v.boolean(),
    canRemove: v.boolean(),
    removeLockedByApproval: v.boolean(),
  }),
  handler: async (ctx, { transactionId }) =>
    await transactionReceiptPermissions(ctx, transactionId),
});

export const removeReceipt = mutation({
  args: {
    transactionId: v.id("transactions"),
    receiptId: v.id("receipts"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const { txn } = await requireRemoveTransactionReceipt(ctx, args.transactionId);

    const { unlinked } = await unlinkReceiptFromTransaction(ctx, {
      receiptId: args.receiptId,
      transactionId: args.transactionId,
    });
    if (!unlinked) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That receipt isn't attached to this charge.",
      });
    }

    // Another receipt may still be attached — the audit row says what the
    // charge is left with, not just that one came off.
    const after = await ctx.db.get(args.transactionId);
    const afterKey = after?.receiptStorageId != null ? "attached" : "none";
    const actor = await viewerPerson(ctx, chapterId);
    await logFinanceAudit(ctx, {
      chapterId: txn.chapterId,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "receipt_detach",
      actorPersonId: actor?._id ?? null,
      field: "receipt",
      before: RECEIPT_STATE_LABELS.attached,
      after: RECEIPT_STATE_LABELS[afterKey],
      beforeKey: "attached",
      afterKey,
      amountCents: txn.amountCents,
    });
    return null;
  },
});
