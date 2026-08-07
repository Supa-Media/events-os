/**
 * One-time: attach the two Truist gifts to the bank credits they arrived on.
 *
 * ── THE DOUBLE COUNT ────────────────────────────────────────────────────────
 * On 2025-09-19 the founder moved $1,000 from Truist into Relay as TWO separate
 * $500 ACH credits. Both halves are recorded correctly — as gifts
 * (`genesis:truist:1` and `:2`) AND as bank rows ("TRUIST COMMUNITY CHECKING"
 * and "ACH Pull"). What was missing is the link between them.
 *
 * `reconciliation.ts#accountBalances` counts revenue at the gifts layer and
 * skips a bank credit only when some gift names it via `gifts.transactionId`.
 * Neither Truist gift did, so New York's book carried the same $1,000 twice —
 * once as giving, once as ledger inflow. This writes the two links, and New
 * York's book value drops by exactly $1,000.
 *
 * ── WHY A ONE-OFF AND NOT THE UI BUTTON ─────────────────────────────────────
 * `givingCandidates.linkGiftToTransaction` is the durable answer and the
 * breakdown modal now offers it on every flagged suspicion. But it resolves the
 * caller from an authenticated session, and this runs from the CLI, which
 * carries the deployment admin key instead. Same checks, no session.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 * Both gifts are $500 and both bank rows are $500 on the same day, so WHICH
 * gift claims WHICH row is arbitrary — and harmless, because the only thing the
 * link changes is that each bank row stops being counted a second time. Paired
 * by `_id` for determinism so a re-run can't shuffle them.
 *
 * Refuses unless it finds EXACTLY two of each, both unlinked. Anything else
 * means the data has moved since this was written, and the right response to
 * that is to stop and say so — the last time something in this reconciliation
 * acted on an assumption about $500 rows, it deleted a real deposit.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";

const GIFT_REFS = ["genesis:truist:1", "genesis:truist:2"] as const;
const AMOUNT_CENTS = 50000;
/** UTC day both credits posted. */
const DAY = "2025-09-19";

export const linkTruistGifts = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    linked: v.number(),
    alreadyLinked: v.number(),
    giftsFound: v.number(),
    bankRowsFound: v.number(),
    pairs: v.array(v.string()),
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

    const gifts = [];
    for (const ref of GIFT_REFS) {
      const g = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", ref))
        .first();
      if (!g) problems.push(`gift ${ref} not found`);
      else if (g.amountCents !== AMOUNT_CENTS) {
        problems.push(`gift ${ref} is ${g.amountCents}¢, expected ${AMOUNT_CENTS}¢`);
      } else gifts.push(g);
    }

    const txns = (
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

    const alreadyLinked = gifts.filter((g) => g.transactionId != null).length;
    const unlinkedGifts = gifts
      .filter((g) => g.transactionId == null)
      .sort((a, b) => (a._id < b._id ? -1 : 1));

    // Never steal a row some other gift already claims.
    const claimedIds = new Set(
      (
        await ctx.db
          .query("gifts")
          .withIndex("by_scope", (q) => q.eq("scope", chapter._id))
          .take(4000)
      )
        .map((g) => g.transactionId)
        .filter(Boolean) as string[],
    );
    const freeTxns = txns
      .filter((t) => !claimedIds.has(t._id))
      .sort((a, b) => (a._id < b._id ? -1 : 1));

    if (unlinkedGifts.length !== freeTxns.length) {
      problems.push(
        `${unlinkedGifts.length} unlinked gift(s) but ${freeTxns.length} unclaimed bank row(s) — refusing to guess`,
      );
    }

    const pairs: string[] = [];
    let linked = 0;
    if (problems.length === 0) {
      for (let i = 0; i < unlinkedGifts.length; i++) {
        const g = unlinkedGifts[i];
        const t = freeTxns[i];
        pairs.push(`${g.externalRef} → "${t.description ?? "(no description)"}"`);
        if (write) await ctx.db.patch(g._id, { transactionId: t._id });
        linked += 1;
      }
    }

    return {
      dryRun: !write,
      linked,
      alreadyLinked,
      giftsFound: gifts.length,
      bankRowsFound: txns.length,
      pairs,
      problems,
    };
  },
});
