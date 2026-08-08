/**
 * One-time: stop crediting the founder for things other people's cash paid for.
 *
 * ── THE PATTERN ─────────────────────────────────────────────────────────────
 * Before the org had a bank account, people handed the founder cash. It stayed
 * in his personal account and was spent on the org — so the SAME money is in
 * the books twice: once as their cash gift, and again as an in-kind gift from
 * him when he spent it. The purchase is real and belongs in the ledger; the
 * second gift is not, because it was never his contribution.
 *
 * Five such gifts exist, all `method:"other"`, none linked to a bank row —
 * because the cash never touched one:
 *
 *     Jude Omodon    2024-09-13   $1,000.00   genesis:don24:jude
 *     Segun Olujide  2024-09-14   $1,000.00   genesis:don24:segun
 *     Zayy Powell    2024-10-16      $15.00   genesis:don24:tajzai1
 *     LK Kupoluyi    2024-11-03     $700.00   genesis:don24:layomi-speakers
 *     Zayy Powell    2025-12-27      $50.00   genesis:don24:tajzai2
 *                                  ─────────
 *                                  $2,765.00
 *
 * ── THE ARITHMETIC PROVES THE MODEL ─────────────────────────────────────────
 * In-kind expenses total $13,356.62 against $12,656.62 of in-kind gifts — a
 * $700 difference, which is LK's gift ALREADY netted out (his `externalRef`
 * says so: `layomi-speakers`, against the $701.13 Alto Professional PA speaker
 * bought 2024-10-25).
 *
 * Net out the other four as well and the whole structure closes exactly:
 *
 *     in-kind revenue      $10,591.62
 *     in-kind expenses    −$13,356.62
 *     don24 cash revenue   +$2,765.00
 *                          ──────────
 *     net effect on book        $0.00
 *
 * Zero to the cent, from two independently-recorded sides. That is what says
 * the reading is right rather than merely plausible.
 *
 * ── AN EARLIER VERSION OF THIS FILE HAD IT BACKWARDS ────────────────────────
 * It read the $700 as an UNDERCOUNT and would have raised the gear gift to the
 * full $4,446.91 — crediting the founder for a speaker LK paid for, and
 * double-counting LK's donation. The gap was correct accounting. Nothing in the
 * data said so; the founder did.
 *
 * ── ALLOCATION ──────────────────────────────────────────────────────────────
 * Each cash gift is netted from the in-kind gift covering the spending of its
 * own period, so both stay individually true rather than only summing right:
 * the 2024 cash ($2,015) comes off `genesis:gear2024`, the Dec-2025 $50 off
 * `genesis:buy25`.
 *
 * Book value drops $2,065. The expenses are untouched — they have receipts and
 * the money really was spent. What moves is who gets credit for putting it in.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { editGiftRow } from "./lib/givingDonors";

/** An in-kind gift, and the cash gifts whose credit it wrongly absorbed. */
const RESTATEMENTS = [
  {
    giftRef: "genesis:gear2024",
    fromCents: 374691,
    toCents: 173191, // $4,446.91 receipts − $700 LK (already out) − $2,015
    cashRefs: ["genesis:don24:jude", "genesis:don24:segun", "genesis:don24:tajzai1"],
    cashCents: 201500,
  },
  {
    giftRef: "genesis:buy25",
    fromCents: 433194,
    toCents: 428194, // less Zayy Powell's Dec-2025 $50
    cashRefs: ["genesis:don24:tajzai2"],
    cashCents: 5000,
  },
] as const;

export const netOutCashGifts = internalMutation({
  args: { editedBy: v.id("users"), execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    restated: v.number(),
    totalReducedCents: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { editedBy, execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];
    const byRef = async (ref: string) =>
      ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", ref))
        .first();

    let restated = 0;
    let totalReducedCents = 0;

    for (const r of RESTATEMENTS) {
      const gift = await byRef(r.giftRef);
      if (!gift) {
        problems.push(`${r.giftRef}: not found`);
        continue;
      }
      if (gift.amountCents === r.toCents) continue; // already restated

      // The whole justification is that the cash gifts EXIST and are already
      // counted. If one is missing, netting it out would ERASE that revenue
      // rather than move its credit — the opposite of the intent.
      let cashTotal = 0;
      let missing = false;
      for (const cashRef of r.cashRefs) {
        const c = await byRef(cashRef);
        if (!c) {
          problems.push(`${cashRef}: not found — refusing to net out an unrecorded gift`);
          missing = true;
          continue;
        }
        cashTotal += c.amountCents;
      }
      if (missing) continue;
      if (cashTotal !== r.cashCents) {
        problems.push(
          `${r.giftRef}: cash gifts total ${cashTotal}¢, expected ${r.cashCents}¢ — SKIPPED`,
        );
        continue;
      }
      if (gift.amountCents !== r.fromCents) {
        problems.push(
          `${r.giftRef}: is ${gift.amountCents}¢, expected ${r.fromCents}¢ — SKIPPED`,
        );
        continue;
      }

      if (write) {
        await editGiftRow(ctx, {
          giftId: gift._id,
          amountCents: r.toCents,
          note:
            `In-kind spending, restated 2026-08-07. ${formatUsd(r.cashCents)} of it was cash ` +
            `given to him before the org had a bank account (${r.cashRefs.join(", ")}); those ` +
            `gifts carry that credit, so it is not counted twice. The expenses are unchanged — ` +
            `the money was spent and has receipts.`,
          editedBy,
        });
      }
      restated += 1;
      totalReducedCents += gift.amountCents - r.toCents;
    }

    return { dryRun: !write, restated, totalReducedCents, problems };
  },
});

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
