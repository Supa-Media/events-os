/**
 * One-time: label the 2025-12-19 "GLOBAL ECH" credit as the Stripe payout it is.
 *
 * ── THE ARITHMETIC THAT IDENTIFIES IT ───────────────────────────────────────
 * Pop The Balloon's card-present sales, from the `sales` table:
 *
 *     142 sales, gross                        $558.00
 *     less Stripe fees for 2025-12           − $44.01   (`stripe-fees:2025-12`)
 *                                            ─────────
 *                                             $513.99
 *
 * That is the credit, to the cent. The fee figure only became right once the
 * fee sync started sweeping balance transactions rather than charges: $28.81 of
 * it is Stripe's cut of the 142 sales, and the other $15.20 is a standalone
 * `stripe_fee` — Terminal hardware — that the old charge-only sweep could not
 * see. Before that fix the payout looked $15.20 short of anything explainable,
 * which is exactly why it sat unreviewed as an unexplained "GLOBAL ECH" inflow.
 *
 * ── WHY IT MATTERS MORE THAN A LABEL ────────────────────────────────────────
 * Revenue is counted at the sales layer, so the $558.00 is ALREADY in book
 * value. An unlabelled bank credit for the same money counts it a second time:
 * `signedBookCents` returns the full amount for a plain inflow and 0 for one
 * carrying `payoutProcessor`. New York's book value drops by $513.99 here, and
 * that drop is a correction, not a loss.
 *
 * This is the same class of error as the Truist gifts and the Givebutter
 * backfill — revenue recorded once at its source and again when its cash
 * arrives. The three differ only in which mechanism was supposed to prevent it:
 * a gift link, a dedup key, and this label.
 *
 * Matched on amount AND day AND that it is still unlabelled, and refuses unless
 * exactly one row qualifies.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";

const AMOUNT_CENTS = 51399;
const DAY = "2025-12-19";
const NOTE =
  "Stripe payout of Pop The Balloon's card-present sales: $558.00 gross across 142 sales, " +
  "less $44.01 of December Stripe fees ($28.81 taken per charge + $15.20 of Terminal fees). " +
  "Labelled a payout so the money is counted once — at the sales, where the revenue is recorded.";

export const markPtbPayout = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    marked: v.boolean(),
    alreadyMarked: v.boolean(),
    candidates: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];

    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) {
      throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });
    }

    const rows = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapter._id))
        .take(6000)
    ).filter(
      (t) =>
        t.flow === "inflow" &&
        t.amountCents === AMOUNT_CENTS &&
        new Date(t.postedAt).toISOString().slice(0, 10) === DAY,
    );

    const already = rows.filter((t) => t.payoutProcessor != null).length;
    const unlabelled = rows.filter((t) => t.payoutProcessor == null);

    if (rows.length !== 1) {
      problems.push(
        `expected exactly 1 credit of $513.99 on ${DAY}, found ${rows.length} — SKIPPED`,
      );
    }

    let marked = false;
    if (rows.length === 1 && unlabelled.length === 1) {
      if (write) {
        await ctx.db.patch(unlabelled[0]._id, {
          payoutProcessor: "stripe",
          note: NOTE,
          status: "reconciled",
        });
      }
      marked = true;
    }

    return {
      dryRun: !write,
      marked,
      alreadyMarked: already > 0,
      candidates: rows.length,
      problems,
    };
  },
});
