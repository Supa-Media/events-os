/**
 * One-time: bring the 2024 gear in-kind gift up to the spending it stands for.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * An in-kind gift and the expense it paid for must be EQUAL. Someone buying
 * $500 of gear for the org is $500 of contribution and $500 of cost; the pair
 * nets to zero on book value, which is the honest answer and the reason in-kind
 * counts as revenue at all (founder decision, 2026-08-07). Any difference
 * between the two is a silent error in book value — and, because it never shows
 * as an unexplained row anywhere, one nothing on any screen would surface.
 *
 * Across the whole deployment that invariant holds to within a single number:
 *
 *     in-kind EXPENSES   66 rows   $13,356.62
 *     in-kind GIFTS      34 rows   $12,656.62
 *                                  ──────────
 *     shortfall                       $700.00
 *
 * $13,356.62 is the figure the founder gave independently for personal-card
 * spending, so the expense side is right and the gift side is $700 light.
 *
 * ── IT IS ONE GIFT, NOT SPREAD ──────────────────────────────────────────────
 * Every other in-kind pair reconciles exactly — `genesis:ltn` $3,500.00 against
 * $3,500.00, `genesis:cleanup2026` $843.03 against $843.03. The whole shortfall
 * sits on `genesis:gear2024`: the gift reads $3,746.91 against 18 Amazon and
 * Sweetwater orders totalling $4,446.91.
 *
 * The likely history is the $700 "Public Worship Speakers" row — a donation the
 * original import had misread as an expense. Removing that expense was right;
 * the gift appears to have been reduced alongside it, when the 18 real orders
 * it stands for never changed.
 *
 * ── DIRECTION ───────────────────────────────────────────────────────────────
 * This RAISES book value by $700, which widens the gap against the bank rather
 * than closing it. That is still correct: the gap is a measurement, not a
 * target, and an in-kind pair that doesn't net to zero is wrong in both
 * directions at once. Do not "fix" this by shrinking the expenses — they have
 * receipts.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { editGiftRow } from "./lib/givingDonors";

const GIFT_REF = "genesis:gear2024";
const EXPECTED_CENTS = 374691;
/** The 18 `genesis-inkind-exp` rows dated 2024, summed. */
const CORRECTED_CENTS = 444691;

export const fixGear2024Gift = internalMutation({
  args: { editedBy: v.id("users"), execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    restated: v.boolean(),
    fromCents: v.number(),
    toCents: v.number(),
    expenseRowsFound: v.number(),
    expenseCents: v.number(),
    matchesExpenses: v.boolean(),
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

    // Re-derive the target from the live rows rather than trusting the constant:
    // if an order was added or corrected since this was written, the gift should
    // follow the receipts, and a disagreement should stop the run rather than
    // write a stale number.
    const expenses = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", gift.scope as never))
        .take(6000)
    ).filter(
      (t) =>
        String(t.externalId ?? "").startsWith("genesis-inkind-exp") &&
        new Date(t.postedAt).getUTCFullYear() === 2024 &&
        t.status !== "excluded",
    );
    const expenseCents = expenses.reduce((sum, t) => sum + t.amountCents, 0);

    if (expenseCents !== CORRECTED_CENTS) {
      problems.push(
        `2024 in-kind expenses are ${expenseCents}¢, this module expects ${CORRECTED_CENTS}¢ — SKIPPED`,
      );
    }
    if (gift.amountCents === CORRECTED_CENTS) {
      return {
        dryRun: !write,
        restated: false,
        fromCents: gift.amountCents,
        toCents: CORRECTED_CENTS,
        expenseRowsFound: expenses.length,
        expenseCents,
        matchesExpenses: true,
        problems,
      };
    }
    if (gift.amountCents !== EXPECTED_CENTS) {
      problems.push(
        `gift is ${gift.amountCents}¢, expected ${EXPECTED_CENTS}¢ — SKIPPED`,
      );
    }

    let restated = false;
    if (problems.length === 0) {
      if (write) {
        await editGiftRow(ctx, {
          giftId: gift._id,
          amountCents: CORRECTED_CENTS,
          note:
            "In-kind: 2024 music-ministry gear across 18 Amazon/Sweetwater orders, Aug–Oct 2024, " +
            "bought personally. Restated 2026-08-07 to $4,446.91 — the sum of those 18 receipts. " +
            "It had read $3,746.91, $700 short, which left the only in-kind pair in the books that " +
            "didn't net to zero.",
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
      expenseRowsFound: expenses.length,
      expenseCents,
      matchesExpenses: expenseCents === CORRECTED_CENTS,
      problems,
    };
  },
});
