/**
 * One-time: stop crediting the founder for gear other people's cash paid for.
 *
 * ── THE PATTERN ─────────────────────────────────────────────────────────────
 * Before the org had a bank account, three people handed the founder cash:
 *
 *     Jude Omodon    2024-09-13   $1,000.00   genesis:don24:jude
 *     Segun Olujide  2024-09-14   $1,000.00   genesis:don24:segun
 *     LK Kupoluyi    2024-11-03     $700.00   genesis:don24:layomi-speakers
 *
 * It stayed in his personal account and was spent on the org — which means the
 * SAME money is in the books twice: once as their cash gift, and again as an
 * in-kind gift from him when he spent it. The purchase is real and belongs in
 * the ledger; the second gift is not, because it wasn't his contribution.
 *
 * ── LK IS ALREADY HANDLED. THE OTHER TWO ARE NOT. ───────────────────────────
 * The 2024 gear is 18 Amazon and Sweetwater receipts totalling $4,446.91, and
 * the in-kind gift reads $3,746.91 — exactly $700 less. That is LK's gift
 * already netted out, and his `externalRef` names it: `layomi-speakers`,
 * against the $701.13 Alto Professional PA speaker bought on 2024-10-25.
 *
 * An earlier version of this module read that $700 as an UNDERCOUNT and tried
 * to raise the gift to the full $4,446.91. That would have credited the founder
 * for a speaker LK paid for and double-counted LK's donation. The gap was
 * correct accounting; only the founder knew why.
 *
 * Jude's and Segun's $2,000 got no such treatment, so:
 *
 *     2024 gear receipts                      $4,446.91
 *     less LK (already netted out)             − $700.00
 *     less Jude + Segun (this change)        − $2,000.00
 *                                            ───────────
 *     the founder's own 2024 contribution     $1,746.91
 *
 * ── DIRECTION ───────────────────────────────────────────────────────────────
 * Book value drops $2,000. The expenses are untouched — they have receipts and
 * the money really was spent. What changes is who gets the credit for putting
 * it in, and the answer is Jude and Segun, whose gifts are already recorded.
 *
 * NOT COVERED: two small `genesis:don24:` gifts to Zayy Powell ($15 on
 * 2024-10-16, $50 on 2025-12-27) share the shape — method `other`, no bank row
 * — but the founder named only these three, and $65 of someone else's money is
 * not worth assuming about. Flagged rather than folded in.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { editGiftRow } from "./lib/givingDonors";

const GIFT_REF = "genesis:gear2024";
const EXPECTED_CENTS = 374691;
/** $4,446.91 of receipts, less LK's $700 and Jude + Segun's $2,000. */
const CORRECTED_CENTS = 174691;
/** The two cash gifts being netted out — re-verified before anything is written. */
const CASH_GIFT_REFS = ["genesis:don24:jude", "genesis:don24:segun"] as const;
const CASH_GIFT_TOTAL_CENTS = 200000;

export const fixGear2024Gift = internalMutation({
  args: { editedBy: v.id("users"), execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    restated: v.boolean(),
    fromCents: v.number(),
    toCents: v.number(),
    cashGiftsVerified: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { editedBy, execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];

    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", GIFT_REF))
      .first();
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: `${GIFT_REF} not found.` });
    }

    // The whole justification is that Jude's and Segun's gifts EXIST and are
    // already counted. If either is missing, netting them out of the in-kind
    // gift would erase $1,000 of revenue rather than move its credit.
    let cashGiftsVerified = 0;
    let cashTotal = 0;
    for (const ref of CASH_GIFT_REFS) {
      const g = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", ref))
        .first();
      if (!g) {
        problems.push(`${ref}: not found — refusing to net out a gift that isn't recorded`);
        continue;
      }
      cashGiftsVerified += 1;
      cashTotal += g.amountCents;
    }
    if (cashGiftsVerified === CASH_GIFT_REFS.length && cashTotal !== CASH_GIFT_TOTAL_CENTS) {
      problems.push(`cash gifts total ${cashTotal}¢, expected ${CASH_GIFT_TOTAL_CENTS}¢`);
    }

    if (gift.amountCents === CORRECTED_CENTS) {
      return {
        dryRun: !write,
        restated: false,
        fromCents: gift.amountCents,
        toCents: CORRECTED_CENTS,
        cashGiftsVerified,
        problems,
      };
    }
    if (gift.amountCents !== EXPECTED_CENTS) {
      problems.push(`gift is ${gift.amountCents}¢, expected ${EXPECTED_CENTS}¢ — SKIPPED`);
    }

    let restated = false;
    if (problems.length === 0) {
      if (write) {
        await editGiftRow(ctx, {
          giftId: gift._id,
          amountCents: CORRECTED_CENTS,
          note:
            "In-kind: 2024 music-ministry gear across 18 Amazon/Sweetwater orders, Aug–Oct 2024, " +
            "bought personally. The receipts total $4,446.91, but $2,700 of it was cash given to " +
            "him before the org had a bank account — LK Kupoluyi $700 (already netted out), Jude " +
            "Omodon $1,000 and Segun Olujide $1,000 (netted out 2026-08-07). Their gifts carry " +
            "that credit; this is his own $1,746.91.",
          editedBy,
        });
      }
      restated = true;
    }

    return {
      dryRun: !write,
      restated,
      fromCents: gift.amountCents,
      toCents: CORRECTED_CENTS,
      cashGiftsVerified,
      problems,
    };
  },
});
