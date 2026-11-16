/**
 * Who may give a buyer their money back from the Sales page.
 *
 * A refund sends chapter money OUT, so it sits above the bookkeeper floor the
 * rest of the Sales page writes at (`sales.ts` — picking a basket or an event
 * moves no money). Today that is the finance MANAGER rung on the sale's
 * chapter, which a central finance manager (and the ED, through the seat
 * bridge) also reaches.
 *
 * CLAUDE.md's "gate it behind a power": when refunds need to be granted per
 * seat rather than by finance rung, this graduates to a `finance.sales.refund`
 * string in `SEAT_CAPABILITIES` — add it, list it on the seats that carry it,
 * and change THESE bodies. No call site moves.
 *
 * No second approver. A refund returns money to the person who paid it, by
 * the card they paid with, and can never be pointed anywhere else — the
 * separation-of-duties rule exists for money that could leave to the
 * approver's own benefit, which this cannot.
 */
import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { financeRoleAtLeast } from "@events-os/shared";
import { getFinanceRole, type FinanceAccess } from "./finance";

export async function hasSaleRefund(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return financeRoleAtLeast(access.role, "manager");
}

/** The `require` half of `hasSaleRefund` — every call site uses this. */
export async function requireSaleRefund(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, chapterId);
  if (!financeRoleAtLeast(access.role, "manager")) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Refunding a sale needs the finance manager role.",
    });
  }
  return access;
}
