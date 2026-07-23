import { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { formatCents, RECEIPT_GRACE_DAYS } from "@events-os/shared";
import { isMissingReceiptCharge } from "../../cards";
import { ROLLUP_SCAN_LIMIT, DAY_MS } from "./constants";

type AttentionItem = {
  kind: string;
  title: string;
  badgeCount: number;
  detail: string;
  actionLabel: string;
};

/** Reimbursement statuses awaiting a manager decision — mirrors the exact set
 *  `listStaleReimbursements` (reimbursements.ts) treats as "awaiting a
 *  manager", so the two queues never drift on what counts as approvable. */
const APPROVABLE_REIMBURSEMENT_STATUSES = ["submitted", "preapproved"] as const;

/**
 * The chapter "Needs attention" queue: (a) reimbursements awaiting a manager
 * decision (submitted / preapproved — NOT pre-approval-pending, approved, or
 * terminal), and (b) cards with a missing-receipt charge still inside the
 * `RECEIPT_GRACE_DAYS` grace window (nearing the auto-lock sweep, not yet past
 * it — those are already locked by the cron). Each active card is checked
 * against its own recent charges via `isMissingReceiptCharge`, the exact same
 * predicate `autoLockOverdueCards` (cards.ts) uses, so "nearing" and "overdue"
 * can never disagree on what counts as a missing receipt.
 */
export async function chapterAttentionQueue(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  // (a) Reimbursements to approve.
  let reimbCount = 0;
  let reimbCents = 0;
  for (const status of APPROVABLE_REIMBURSEMENT_STATUSES) {
    const rows = await ctx.db
      .query("reimbursementRequests")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", chapterId).eq("status", status),
      )
      .take(ROLLUP_SCAN_LIMIT);
    if (rows.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading "${status}" reimbursements for chapter ${chapterId}; count/total truncated.`,
      );
    }
    for (const r of rows) {
      reimbCount++;
      reimbCents += r.totalCents;
    }
  }
  if (reimbCount > 0) {
    items.push({
      kind: "reimbursements",
      title: "Reimbursements to approve",
      badgeCount: reimbCount,
      detail: `${formatCents(reimbCents)} awaiting approval`,
      actionLabel: "Review",
    });
  }

  // (b) Cards nearing the receipt auto-lock — count distinct CARDHOLDERS (a
  // person with two nearing charges is one attention row, not two).
  const cutoff = Date.now() - RECEIPT_GRACE_DAYS * DAY_MS;
  const chapterCards = await ctx.db
    .query("cards")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  if (chapterCards.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading cards for chapter ${chapterId}; nearing-lock scan truncated.`,
    );
  }
  const nearingCardholders = new Set<Id<"people">>();
  for (const card of chapterCards) {
    // Only ACTIVE cards can still be "nearing" — a locked card already tipped
    // over (the auto-lock cron caught it) or was manually locked/canceled.
    if (card.status !== "active") continue;
    const charges = await ctx.db
      .query("transactions")
      .withIndex("by_card", (q) => q.eq("cardId", card._id))
      .take(ROLLUP_SCAN_LIMIT);
    if (charges.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading charges for card ${card._id}; nearing-lock check truncated.`,
      );
    }
    const nearing = charges.some(
      (tr) => isMissingReceiptCharge(tr, card) && tr.postedAt >= cutoff,
    );
    if (nearing) nearingCardholders.add(card.cardholderPersonId);
  }
  if (nearingCardholders.size > 0) {
    items.push({
      kind: "cards",
      title: "Cards nearing receipt lock",
      badgeCount: nearingCardholders.size,
      detail:
        nearingCardholders.size === 1
          ? "1 cardholder has a receipt due before the auto-lock"
          : `${nearingCardholders.size} cardholders have a receipt due before the auto-lock`,
      actionLabel: "Review",
    });
  }

  // (c) Budgets awaiting approval (WP-3.2): explicit submissions only — a
  // grandfathered legacy budget never appears here (its literal
  // `approvalStatus` is absent, not `"submitted"`). The decision itself
  // happens right on the budget card (Approve / Request changes), so this
  // row is a pure count/nudge — no dedicated destination to navigate to.
  const pendingBudgets = await ctx.db
    .query("budgets")
    .withIndex("by_chapter_and_approval_status", (q) =>
      q.eq("chapterId", chapterId).eq("approvalStatus", "submitted"),
    )
    .take(ROLLUP_SCAN_LIMIT);
  if (pendingBudgets.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading pending-approval budgets for chapter ${chapterId}; count truncated.`,
    );
  }
  if (pendingBudgets.length > 0) {
    items.push({
      kind: "budget_approvals",
      title: "Budgets awaiting approval",
      badgeCount: pendingBudgets.length,
      detail:
        pendingBudgets.length === 1
          ? "1 budget needs a decision"
          : `${pendingBudgets.length} budgets need a decision`,
      actionLabel: "Review",
    });
  }

  return items;
}
