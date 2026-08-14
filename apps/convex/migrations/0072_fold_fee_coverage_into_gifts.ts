import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { applyScopeDelta, applyLaunchFundDelta } from "../lib/givingDonors";
import { syncDonorIdentity } from "../lib/donorIdentity";

/**
 * Fold the fee coverage back INTO the gift it was taken out of.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * A donor who ticked "cover the processing fee" was booked twice over: the
 * amount they typed went into `gifts.amountCents`, and the extra they paid on
 * top went into `gifts.feeCoverageCents`, deliberately OUTSIDE every giving
 * total. The reasoning was year-on-year comparability as the feature's
 * adoption grew — but the comparability was fictional. Charisma Stevens was
 * charged $309.27, every cent of it left her account and landed with us, and
 * the ledger reported a $300.00 gift. Her own receipt said $309.27. Two
 * documents, one donation, different numbers, and the difference recorded
 * nowhere a report would ever read.
 *
 * The gift is the gross. The processor's cut is an expense of the org, exactly
 * as it is on the gift beside it that nobody covered. See
 * `schema/givingPlatform.ts#gifts.feeCoverageCents` for the rule this now
 * enforces, and `lib/givingDonors.ts#coverageOnCharge` for the settle path.
 *
 * ── IT MOVES BOOK VALUE, ON PURPOSE ─────────────────────────────────────────
 * Book value is `Σ gifts.amountCents + Σ signedBookCents(ledger)`, so folding
 * raises it by exactly the coverage that was previously invisible. That is a
 * CORRECTION, not a drift: the cash side always counted the charge — see
 * `reconciliation.ts`'s in-flight netting, which already had to reach for
 * `chargeTotalCents` because "using the gift figure would leave a
 * coverage-sized sliver unaccounted for". This closes that sliver on the
 * settled side too rather than working around it a second time.
 *
 * Every derived figure the original write moved is moved by the SAME signed
 * delta, exactly once each, mirroring `editGiftRow`'s amount branch:
 *   · the donor's `lifetimeCents`,
 *   · the scope rollup (`applyScopeDelta`),
 *   · the donor identity aggregate (`syncDonorIdentity`),
 *   · the territory launch pot, but ONLY for a gift flagged
 *     `countedInLaunchFund`, and the launch freeze is respected inside
 *     `applyLaunchFundDelta` — a launched territory's pot stays frozen.
 * `editGiftRow` itself is unusable here: it demands an editing user and
 * refuses system-written gifts, which every one of these is.
 *
 * `giftCount` does NOT move. This corrects the size of gifts that were always
 * there; it does not discover new ones.
 *
 * ── WHY THE FLAG ────────────────────────────────────────────────────────────
 * Folding is not idempotent — run twice, every covered gift is overstated by
 * its coverage — and no combination of a row's own values distinguishes a
 * folded row from an unfolded one. The ledger stops a second RUN; the flag,
 * `gifts.feeCoverageInAmount`, stops the two cases the ledger cannot see.
 *
 * The second of those is the one worth spelling out: THE DEPLOY LANDS BEFORE
 * THIS MIGRATION DOES. A gift settling in that window is written by the new
 * code and is already gross — folding it would overstate it, and it is
 * otherwise shaped exactly like a historical row. So the flag is not a
 * migration marker bolted on afterwards: `recordGiftForDonor` stamps it on
 * every covered gift it writes, which is what makes "already under the new
 * rule" a property of the DATA rather than of the clock. Rows are selected by
 * "has coverage AND is not stamped", and each is stamped in the same patch
 * that moves its money.
 *
 * ── PENDING ROWS TOO ────────────────────────────────────────────────────────
 * An in-flight ACH row (`pendingGifts`) carries both figures, so its fold is
 * the assignment `amountCents = chargeTotalCents` — idempotent by
 * construction, needing no flag, and touching no rollup (this table is
 * invisible to book value by design; see `givingPending.ts`).
 */
export async function runFoldFeeCoverageIntoGifts(
  ctx: MutationCtx,
): Promise<{
  giftsFolded: number;
  centsFolded: number;
  pendingFolded: number;
}> {
  let giftsFolded = 0;
  let centsFolded = 0;

  // Small by nature — only `/give` checkouts with the box ticked ever set the
  // field, and the feature is young. A full scan is the honest read here: there
  // is no index on `feeCoverageCents`, and adding one for a one-shot migration
  // would outlive the reason for it.
  const gifts = await ctx.db.query("gifts").collect();
  for (const gift of gifts) {
    const coverage = gift.feeCoverageCents ?? 0;
    if (coverage <= 0) continue;
    if (gift.feeCoverageInAmount) continue; // already under the new rule
    if (!Number.isInteger(coverage)) {
      // A non-integer coverage is metadata we can't explain; moving money on
      // it would be a guess. Left exactly as it is, flagged by its absence
      // from the counts below.
      console.error(
        `[0072] gift ${gift._id} has a non-integer feeCoverageCents (${coverage}) — skipped`,
      );
      continue;
    }

    const donor = await ctx.db.get(gift.donorId);
    if (!donor) {
      // A gift whose donor row is gone still holds money, but the donor and
      // identity rollups it would move no longer exist. Correcting the gift
      // without them would desync the scope rollup from the donor rows that
      // feed it, so this is left for a human.
      console.error(
        `[0072] gift ${gift._id} has no donor row — skipped, correct it by hand`,
      );
      continue;
    }

    await ctx.db.patch(gift._id, {
      amountCents: gift.amountCents + coverage,
      feeCoverageInAmount: true,
    });
    await ctx.db.patch(gift.donorId, {
      lifetimeCents: Math.max(0, donor.lifetimeCents + coverage),
    });
    await applyScopeDelta(ctx, donor.scope, { lifetimeDelta: coverage });
    if (gift.countedInLaunchFund) {
      await applyLaunchFundDelta(ctx, gift.scope, coverage);
    }
    await syncDonorIdentity(ctx, gift.donorId);

    giftsFolded += 1;
    centsFolded += coverage;
  }

  // In-flight ACH: report the charge, which is what the settle path will book.
  let pendingFolded = 0;
  const pending = await ctx.db.query("pendingGifts").collect();
  for (const row of pending) {
    const charge = row.chargeTotalCents;
    if (charge === undefined || charge === row.amountCents) continue;
    await ctx.db.patch(row._id, { amountCents: charge });
    pendingFolded += 1;
  }

  console.log(
    `[0072] folded ${giftsFolded} gifts (${centsFolded}c) and ${pendingFolded} pending rows`,
  );
  return { giftsFolded, centsFolded, pendingFolded };
}

export const foldFeeCoverageIntoGifts: Migration = {
  name: "0072_fold_fee_coverage_into_gifts",
  run: runFoldFeeCoverageIntoGifts,
};
