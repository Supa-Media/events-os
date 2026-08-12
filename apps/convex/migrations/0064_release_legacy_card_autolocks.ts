import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Release the auto-locks the receipt sweep wrongly applied to legacy (Relay)
 * cards.
 *
 * WHY. `autoLockOverdueCards` scanned every `cards` row and patched any with an
 * overdue missing-receipt charge to `status:"locked"`. But a lock is only ever
 * ENFORCED by `decideCardAuthorization`, which Increase reaches by
 * `increaseCardId` — a `source:"legacy"` row is a Relay card linked by last-4
 * and has no Increase object, so nothing consults us before it authorizes.
 * The row said "locked", every surface reading `status` repeated it, and the
 * card kept working. The sweep now skips legacy cards (`canEnforceCardLock`);
 * this is the one-time cleanup for rows it already stamped.
 *
 * WHAT. Every `source:"legacy"` card that is `status:"locked"` WITH a
 * `receiptGraceEndsAt` stamp — the signature of an AUTO-lock — goes back to
 * `"active"` and loses the stamp. The receipts those charges owe are not
 * forgiven: they stay outstanding on the charge, keep appearing in Receipt
 * Chase (which scans transactions, not cards), keep sending reminders, and
 * remain eligible for the 60-day accountable-plan conversion. Only the false
 * claim goes away.
 *
 * A legacy card locked WITHOUT a stamp is left alone: that's a deliberate
 * human act (a manager's `lockCard` before this guard existed, or a holder's
 * self-freeze). It was equally unenforceable, but it records an intent someone
 * expressed, and silently reversing it would be its own surprise — the manager
 * should clear it themselves now that `lockCard` explains why it can't work.
 *
 * IDEMPOTENT: a released row is `"active"` and never matches again.
 * BOUNDS: `cards` is small — same cap as `0059_split_legacy_increase_cards`.
 */
const CARD_SCAN_LIMIT = 2000;

export type ReleaseLegacyCardAutolocksResult = {
  /** Legacy rows carrying a false auto-lock, now returned to active. */
  released: number;
  /** Legacy rows locked WITHOUT a grace stamp — a deliberate manual lock,
   *  left for a human to clear. */
  manualLocksLeft: number;
};

export async function runReleaseLegacyCardAutolocks(
  ctx: MutationCtx,
): Promise<ReleaseLegacyCardAutolocksResult> {
  const cards = await ctx.db.query("cards").take(CARD_SCAN_LIMIT);
  const result: ReleaseLegacyCardAutolocksResult = {
    released: 0,
    manualLocksLeft: 0,
  };

  for (const card of cards) {
    if (card.source !== "legacy" || card.status !== "locked") continue;
    if (card.receiptGraceEndsAt == null) {
      result.manualLocksLeft++;
      continue;
    }
    await ctx.db.patch(card._id, {
      status: "active",
      receiptGraceEndsAt: undefined,
    });
    result.released++;
  }

  return result;
}

export const releaseLegacyCardAutolocks: Migration = {
  name: "0064_release_legacy_card_autolocks",
  run: runReleaseLegacyCardAutolocks,
};
