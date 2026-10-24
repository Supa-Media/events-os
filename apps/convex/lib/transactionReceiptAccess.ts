/**
 * Who may attach a receipt to a transaction, and who may take one off.
 *
 * Two powers, one resolver, so every call site asks the same question:
 *
 *  - ATTACH (`requireAttachTransactionReceipt`) — the gate
 *    `finances.attachReceipt` always had, lifted out of that mutation's body
 *    unchanged: the charge's OWN person (in either book — see
 *    `lib/ownChargeAccess.ts`), bookkeeper+ in the transaction's scope, or
 *    someone with edit rights on the event the charge's budget belongs to
 *    (owner decision, 2026-07-17). Will graduate to a
 *    `finance.receipts.attach` capability if it ever needs narrowing.
 *
 *  - REMOVE (`requireRemoveTransactionReceipt`) — founder, 2026-10-24: "I
 *    need to be able to remove this attachment (I uploaded it by mistake)".
 *    Whoever may attach a receipt may remove one, so a wrong file is undone
 *    by the same person who added it — UNTIL the charge's coding is
 *    approved. Approval is a reviewer signing off on the record, receipt
 *    included, so after that only bookkeeper+ (who could already detach any
 *    receipt through `receipts.unlinkReceipt`) can change it. Will graduate
 *    to `finance.receipts.remove`.
 *
 * `transactionReceiptPermissions` is the non-throwing `has` form, read by
 * screens deciding which buttons to draw.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CENTRAL, FINANCE_ROLE_LABELS, financeRoleAtLeast } from "@events-os/shared";
import { getFinanceRole } from "./finance";
import { getChapterIdOrNull, requireChapterId } from "./context";
import { callerHasEventEditRights } from "./org";
import { ownChargeActor } from "./ownChargeAccess";

/**
 * The single EVENT a transaction's budget is scoped to, if any — `null` for
 * a txn attributed to no budget, or one whose budget isn't a one_time EVENT
 * budget (a project/recurring/central budget has no single event to scope an
 * "event lead" gate to). Used ONLY by the note/receipt/category scoped
 * carve-outs (here and `finances.ts#requireTxnNoteReceiptCategoryAccess`) — never widens what a project's or a recurring budget's
 * txns are reachable by. Checks `type === "one_time"` alongside
 * `refKind === "event"` — today every `refKind:"event"` budget is also
 * `type:"one_time"` (a real event has no OTHER reason to carry `refKind`),
 * so this is defensive belt-and-suspenders against that schema invariant
 * ever drifting, not a behavior change against current data (Opus review,
 * PR #218).
 */
export async function eventForTxn(
  ctx: QueryCtx,
  txn: Doc<"transactions">,
): Promise<Doc<"events"> | null> {
  if (!txn.budgetId) return null;
  const budget = await ctx.db.get(txn.budgetId);
  if (
    !budget ||
    budget.type !== "one_time" ||
    budget.refKind !== "event" ||
    !budget.scopeRefId
  ) {
    return null;
  }
  return await ctx.db.get(budget.scopeRefId as Id<"events">);
}

export interface TransactionReceiptAccess {
  txn: Doc<"transactions">;
  /** Bookkeeper+ in the transaction's own scope. */
  isBookkeeper: boolean;
}

type Verdict =
  | ({ ok: true } & TransactionReceiptAccess)
  | { ok: false; code: string; message: string };

const notFound: Verdict = {
  ok: false,
  code: "NOT_FOUND",
  message: "Transaction not found in your chapter.",
};

async function attachVerdict(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  transactionId: Id<"transactions">,
): Promise<Verdict> {
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  if (!txn) return notFound;
  // THE OWN-CHARGE ARM, ASKED FIRST AND IN BOTH BOOKS — a cardholder's card
  // can draw on central's account (`lib/ownChargeAccess.ts`).
  const ownerPersonId = await ownChargeActor(ctx, txn, homeChapterId);
  const access = await getFinanceRole(ctx, homeChapterId);
  let isBookkeeper: boolean;
  if (txn.chapterId === CENTRAL) {
    // Central reach AND the bookkeeper rank — reach alone isn't a role.
    isBookkeeper =
      access.isCentral && financeRoleAtLeast(access.role, "bookkeeper");
  } else {
    if (txn.chapterId !== homeChapterId) return notFound;
    isBookkeeper = financeRoleAtLeast(access.role, "bookkeeper");
  }
  if (ownerPersonId != null || isBookkeeper) {
    return { ok: true, txn, isBookkeeper };
  }
  const event = await eventForTxn(ctx, txn);
  if (event && (await callerHasEventEditRights(ctx, event))) {
    return { ok: true, txn, isBookkeeper: false };
  }
  return {
    ok: false,
    code: "FORBIDDEN",
    message:
      txn.chapterId === CENTRAL
        ? `This action needs at least the ${FINANCE_ROLE_LABELS.bookkeeper} finance role, or edit rights on the event this transaction belongs to.`
        : "Only the transaction's own person, a bookkeeper, or someone with edit rights on the event this transaction belongs to can attach a receipt.",
  };
}

function removeVerdict(attach: Verdict): Verdict {
  if (!attach.ok) return attach;
  if (attach.txn.codingState === "approved" && !attach.isBookkeeper) {
    return {
      ok: false,
      code: "CODING_APPROVED",
      message:
        "This charge's coding has been approved, so its receipts are locked. Ask a bookkeeper to swap one that's wrong.",
    };
  }
  return attach;
}

function unwrap(verdict: Verdict): TransactionReceiptAccess {
  if (!verdict.ok) {
    throw new ConvexError({ code: verdict.code, message: verdict.message });
  }
  return { txn: verdict.txn, isBookkeeper: verdict.isBookkeeper };
}

export async function requireAttachTransactionReceipt(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionReceiptAccess> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  return unwrap(await attachVerdict(ctx, homeChapterId, transactionId));
}

export async function requireRemoveTransactionReceipt(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionReceiptAccess> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  return unwrap(
    removeVerdict(await attachVerdict(ctx, homeChapterId, transactionId)),
  );
}

/** The `has` form of both gates — never throws. `removeLockedByApproval` is
 *  true when the caller could remove a receipt but for the approved coding,
 *  so a screen can say why the button is missing. */
export async function transactionReceiptPermissions(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<{
  canAttach: boolean;
  canRemove: boolean;
  removeLockedByApproval: boolean;
}> {
  const homeChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
  if (!homeChapterId) {
    return { canAttach: false, canRemove: false, removeLockedByApproval: false };
  }
  const attach = await attachVerdict(ctx, homeChapterId, transactionId);
  const remove = removeVerdict(attach);
  return {
    canAttach: attach.ok,
    canRemove: remove.ok,
    removeLockedByApproval: attach.ok && !remove.ok,
  };
}
