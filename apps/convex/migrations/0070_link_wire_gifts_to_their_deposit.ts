import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { Migration } from "./index";
import { isCandidateShaped } from "../givingCandidates";
import { giftCoverageCents } from "../lib/giftCoverage";

/**
 * Match already-recorded WIRE gifts to the bank credit that delivered them.
 *
 * WHY. A wire is money that hit the account directly, so it exists twice: as
 * the `gifts` row where the org counts its revenue, and as the plain inflow the
 * bank sync wrote. `gifts.transactionId` is the statement that the second IS
 * the first, and every book-value surface subtracts it. Without the link, the
 * dollar counts twice — which is what published New York's March as $9,050 of
 * income against a real $2,050 (founder, 2026-08-13).
 *
 * The founder's $7,000 wire was recorded as its two real gifts on the day it
 * arrived — $5,000 for central, $2,000 for the chapter — and neither could be
 * linked, because the rule wanted one gift of exactly the deposit's amount in
 * the deposit's own book. #696 fixed the rule. This does the same job for the
 * gifts already sitting in the books, so nobody has to go and click them.
 *
 * ── WHAT IT MATCHES ─────────────────────────────────────────────────────────
 * Only `method:"wire"` gifts, and only unlinked ones. That is the honest scope:
 * a wire gift, by definition, describes money that arrived in the bank account
 * on its own. Every other method either never touches the bank as its own row
 * (cash, in-kind) or arrives as a labelled processor payout that already
 * contributes zero (Stripe, Givebutter).
 *
 * Unlinked wire gifts are grouped by the UTC DAY they were received, and the
 * group is matched as one amount — that is what makes the split work: $5,000 +
 * $2,000 on 2026-03-26 looks for a $7,000 deposit, not for two deposits. Books
 * are deliberately ignored when grouping, because the whole point is that the
 * money landed in one account and part of it is another book's revenue.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 * A group is linked only when EXACTLY ONE candidate deposit fits:
 *
 *  - an inflow, within `MATCH_WINDOW_MS` of the day, for exactly the group's
 *    total;
 *  - `isCandidateShaped` — the same exclusion the desk uses, so a card refund,
 *    a transfer leg or a Stripe/Givebutter payout is never claimed as a wire;
 *  - carrying no gift coverage already.
 *
 * Two fitting deposits is an ambiguity a machine has no business resolving, so
 * it leaves both alone and counts the group as skipped. Deleting on a
 * heuristic once cost this deployment a real $500 deposit; the difference here
 * is that a link deletes nothing, moves a book only toward the truth, and is
 * retractable in the product (`unlinkGiftFromTransaction`) — but the caution
 * behind that history is why "exactly one" is not "the best one".
 *
 * IDEMPOTENT: it only ever considers gifts with no `transactionId`, so a
 * second run finds the work already done and links nothing.
 */
const SCAN_LIMIT = 5000;
/** How far a deposit may post from the day the gift says it was received. A
 *  wire sent on a Friday can post on the Monday. */
const MATCH_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

export type LinkWireGiftsResult = {
  /** Unlinked wire gifts found. */
  wireGifts: number;
  /** Day-groups considered. */
  groups: number;
  /** Groups matched to exactly one deposit. */
  linkedGroups: number;
  /** Gifts given a `transactionId`. */
  linkedGifts: number;
  /** Groups left alone — no fitting deposit, or more than one. */
  skippedGroups: number;
};

/** The UTC day a timestamp falls on, as a groupable key. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function runLinkWireGiftsToTheirDeposit(
  ctx: MutationCtx,
): Promise<LinkWireGiftsResult> {
  const result: LinkWireGiftsResult = {
    wireGifts: 0,
    groups: 0,
    linkedGroups: 0,
    linkedGifts: 0,
    skippedGroups: 0,
  };

  const allGifts = await ctx.db.query("gifts").take(SCAN_LIMIT);
  const byDay = new Map<string, Doc<"gifts">[]>();
  for (const gift of allGifts) {
    if (gift.method !== "wire") continue;
    if (gift.transactionId != null) continue;
    result.wireGifts++;
    const key = dayKey(gift.receivedAt);
    const slot = byDay.get(key) ?? [];
    slot.push(gift);
    byDay.set(key, slot);
  }
  if (byDay.size === 0) return result;

  const allTxns = await ctx.db.query("transactions").take(SCAN_LIMIT);

  for (const [, group] of byDay) {
    result.groups++;
    const totalCents = group.reduce((sum, g) => sum + g.amountCents, 0);
    // Every gift in the group claims the same arrival, so the window is
    // anchored on the earliest of them.
    const anchor = Math.min(...group.map((g) => g.receivedAt));

    const fits: Doc<"transactions">[] = [];
    for (const tr of allTxns) {
      if (tr.amountCents !== totalCents) continue;
      if (Math.abs(tr.postedAt - anchor) > MATCH_WINDOW_MS) continue;
      if (tr.status === "excluded") continue;
      if (!isCandidateShaped(tr)) continue;
      if ((await giftCoverageCents(ctx, tr._id)) > 0) continue;
      fits.push(tr);
    }

    // Exactly one, or nothing. See the module doc.
    if (fits.length !== 1) {
      result.skippedGroups++;
      continue;
    }
    for (const gift of group) {
      await ctx.db.patch(gift._id, { transactionId: fits[0]._id });
      result.linkedGifts++;
    }
    result.linkedGroups++;
  }

  return result;
}

export const linkWireGiftsToTheirDeposit: Migration = {
  name: "0070_link_wire_gifts_to_their_deposit",
  run: runLinkWireGiftsToTheirDeposit,
};
