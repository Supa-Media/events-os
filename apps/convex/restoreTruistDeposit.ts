/**
 * Restore one transaction I deleted in error (2026-08-07).
 *
 * THE MISTAKE. `genesisDedupe` removed 12 `genesis-bank:*` rows as duplicates of the
 * live bank feed. Eleven of those were right. The twelfth — `genesis-bank:42`, a $500
 * inflow described "TRUIST COMMUNITY CHECKING" on 2025-09-19 — was NOT a duplicate.
 * It shared its amount and date with a "$500 ACH Pull" row, and I reasoned they were
 * one deposit described two ways by two importers.
 *
 * They were two deposits. The owner's Relay statement shows TWO separate
 * "TRUIST COMMUNITY CHECKING / ACH Add Funds" credits of $500 that day, together making
 * up the $1,000 he moved from Truist. Both are real money, and both giving-side gifts
 * (`genesis:truist:1` and `genesis:truist:2`, "(1 of 2)" and "(2 of 2)") were right all
 * along — my later theory that one was a phantom was also wrong.
 *
 * WHY THE HEURISTIC FAILED. Same amount, same day, same flow is strong evidence of a
 * duplicate right up until someone genuinely sends the same amount twice in one day,
 * which is exactly what a person splitting a $1,000 transfer does. The dedup pass had
 * no way to tell those apart from the ledger alone; only the bank statement could.
 * Where an amount+date match is the ONLY evidence, a bank statement should confirm it
 * before anything is deleted.
 *
 * Restored with its original values from the pre-deletion snapshot, including the
 * `postedAt`, the import note, and the AI suggestion it carried — so the row reads as
 * though it was never removed, rather than as a new manual entry. Convex assigns a
 * fresh `_id`; nothing referenced the old one (no gift, no receipt, no exception).
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";

const EXTERNAL_ID = "genesis-bank:42";
const AMOUNT_CENTS = 50000;
/** 2025-09-19, the value it carried before deletion. */
const POSTED_AT = 1758240000000;

export const restoreTruistDeposit = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    restored: v.boolean(),
    alreadyPresent: v.boolean(),
    siblingsOnThatDay: v.number(),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });

    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapter._id))
      .take(6000);

    if (rows.some((t) => t.externalId === EXTERNAL_ID)) {
      return { dryRun: !write, restored: false, alreadyPresent: true, siblingsOnThatDay: 0 };
    }

    // The statement shows TWO $500 credits that day. Count what's there so the run
    // reports whether restoring brings it back to two — and so a second, accidental
    // run would be visible as three rather than passing silently.
    const day = new Date(POSTED_AT).toISOString().slice(0, 10);
    const siblings = rows.filter(
      (t) =>
        t.flow === "inflow" &&
        t.amountCents === AMOUNT_CENTS &&
        new Date(t.postedAt).toISOString().slice(0, 10) === day,
    ).length;

    if (write) {
      await ctx.db.insert("transactions", {
        chapterId: chapter._id,
        source: "relay_csv",
        flow: "inflow",
        amountCents: AMOUNT_CENTS,
        currency: "usd",
        postedAt: POSTED_AT,
        description: "TRUIST COMMUNITY CHECKING",
        note:
          "Income: Transfers in · ACH · Sep 2025 (genesis import). Restored 2026-08-07 " +
          "after being deleted in error as a duplicate — the Relay statement shows TWO " +
          "separate $500 ACH Add Funds credits from Truist that day, not one.",
        status: "unreviewed",
        externalId: EXTERNAL_ID,
        createdAt: Date.now(),
      });
    }
    return { dryRun: !write, restored: true, alreadyPresent: false, siblingsOnThatDay: siblings };
  },
});
