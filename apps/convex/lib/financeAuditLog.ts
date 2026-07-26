/**
 * financeAuditLog — thin insert wrapper for the append-only field-change
 * trail (founder ask: "let's get more audit trails when people update
 * reconcile rows... whatever you feel like would be most important for the
 * financial part of this app"). See `schema/finances.ts`'s own doc comment on
 * the `financeAuditLog` table for the full design (why it's a NEW table
 * rather than an extension of `approvals`/`budgetApprovalLog`/
 * `reattributionAudit`).
 *
 * This file adds no authorization of its own — every writer resolves its own
 * `actorPersonId` through whichever finance gate it already calls
 * (`requireReconcileTxn`, `requireFinanceRole`, etc.) and passes it straight
 * through. Kept out of `finances.ts` only so `receipts.ts` (which already
 * imports helpers FROM `finances.ts`, never the reverse) can log
 * receipt attach/detach without a circular import.
 */
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { FinanceAuditAction } from "@events-os/shared";
import type { FinanceScope } from "./finance";

export type FinanceAuditSubjectType = "transaction" | "budget";

export interface FinanceAuditEntry {
  chapterId: FinanceScope;
  subjectType: FinanceAuditSubjectType;
  subjectId: string;
  action: FinanceAuditAction;
  /** `null`/omitted for the rare superuser-with-no-roster-row caller — see
   *  the schema doc comment's note on why this stays optional. */
  actorPersonId?: Id<"people"> | null;
  /** The changed field's name (e.g. "status", "category", "budget"). Omit for
   *  an action with no single changed field (e.g. `manual_create`). */
  field?: string;
  /** Human-readable — a name/label/formatted amount, NEVER a raw id. */
  before?: string | null;
  after?: string | null;
  /** Required by the caller (`setTransactionStatus`) for an `excluded`
   *  status_change; optional everywhere else. */
  reason?: string | null;
  amountCents?: number;
}

/** Append one row. Never patches or deletes — every call is a brand-new
 *  insert, matching the table's append-only contract. */
export async function logFinanceAudit(
  ctx: MutationCtx,
  entry: FinanceAuditEntry,
): Promise<void> {
  await ctx.db.insert("financeAuditLog", {
    chapterId: entry.chapterId,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    action: entry.action,
    ...(entry.actorPersonId ? { actorPersonId: entry.actorPersonId } : {}),
    ...(entry.field !== undefined ? { field: entry.field } : {}),
    ...(entry.before != null ? { before: entry.before } : {}),
    ...(entry.after != null ? { after: entry.after } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.amountCents !== undefined ? { amountCents: entry.amountCents } : {}),
    createdAt: Date.now(),
  });
}
