import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { postRepaymentFeeCoverage } from "../cards";

/**
 * Back-book the fee coverage on repayments that settled BEFORE there was a row
 * to put it in.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * `settleRepayment` posted a credit for the DEBT while the payer had sent the
 * debt PLUS the processor's fee, and the monthly fee sweep booked that fee as
 * an expense regardless. So every fee-covered repayment quietly sank book value
 * by its coverage: a $6.00 personal charge paid back as $6.49 moved Stripe's
 * balance by $6.00 and the books by $5.51, leaving 49¢ of the org's own money
 * reading as unexplained cash (founder, 2026-08-14: "the unaccounted for in our
 * banking was 49 cents"). The sibling change posts that row going forward; this
 * puts it on the payments that already happened.
 *
 * ── WHY THIS IS AN ACTION, AND NOT IN THE REGISTRY ──────────────────────────
 * Because the coverage is NOT DERIVED. `processorFees.ts`'s header states the
 * rule this follows: the fee schedule "says what a payment SHOULD cost. It
 * never re-derives what one DID cost… Nothing here may be used to write a fee
 * figure into the books." Re-running `grossUpCents` over the debt would be
 * exactly that — a prediction written into the ledger as an actual, and one
 * that cannot tell a session charged with coverage from a session charged at
 * face value before the feature existed. Get that backwards and it credits the
 * org money nobody sent.
 *
 * So it reads Stripe. `amount_total − the debts that session settled` IS the
 * coverage, from the processor's own record, and a pre-feature session reports
 * a difference of zero and is skipped by arithmetic rather than by a guess
 * about deploy timing. A `MutationCtx` cannot `fetch`, hence an action; an
 * action cannot be in `MIGRATIONS` (the runner is a mutation), hence human-run
 * — the same arrangement as `0037` / `0048` / `0050`, and the registry's own
 * header documents the pattern.
 *
 * ── RUNNING IT ──────────────────────────────────────────────────────────────
 *   npx convex run migrations/0073_backfill_repayment_fee_coverage:run
 *   npx convex run migrations/0073_backfill_repayment_fee_coverage:run '{"execute":true}'
 *
 * DRY BY DEFAULT, like every other money migration here: the first form reads
 * Stripe, prints exactly what it would post, and writes nothing. Idempotent
 * either way — the writer dedupes on `externalId`, so a second execute run
 * finds every row already there and posts nothing.
 */

const STRIPE_API = "https://api.stripe.com/v1";

type Candidate = {
  sessionId: string;
  debtCents: number;
  repaymentIds: string[];
};

/** Settled Stripe repayments that could be carrying uncovered coverage,
 *  grouped by the checkout session that paid them. */
export const listCandidates = internalMutation({
  args: {},
  returns: v.array(
    v.object({
      sessionId: v.string(),
      debtCents: v.number(),
      repaymentIds: v.array(v.string()),
    }),
  ),
  handler: async (ctx): Promise<Candidate[]> => {
    const rows = await ctx.db.query("personalRepayments").collect();
    const bySession = new Map<string, Candidate>();
    for (const r of rows) {
      const sessionId = r.stripeCheckoutSessionId;
      // Only a repayment that actually SETTLED through Stripe can carry
      // coverage. A pending one was never charged; an Increase/ACH one has no
      // Stripe session to read.
      if (!sessionId || r.status !== "paid" || !r.creditTransactionId) continue;
      const prior = bySession.get(sessionId);
      if (prior) {
        prior.debtCents += r.amountCents;
        prior.repaymentIds.push(String(r._id));
      } else {
        bySession.set(sessionId, {
          sessionId,
          debtCents: r.amountCents,
          repaymentIds: [String(r._id)],
        });
      }
    }

    // Drop the sessions already carrying their row, so a re-run reads far less
    // of Stripe than it did the first time.
    const out: Candidate[] = [];
    for (const c of bySession.values()) {
      const existing = await ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) =>
          q.eq("externalId", `stripe_repayment_fee_coverage:${c.sessionId}`),
        )
        .first();
      if (!existing) out.push(c);
    }
    return out;
  },
});

/** Post one session's coverage through the SAME writer the live settle path
 *  uses — dedup key, book choice, note and status all come from there rather
 *  than being restated here, where they could drift. */
export const postOne = internalMutation({
  args: {
    sessionId: v.string(),
    coverageCents: v.number(),
    repaymentIds: v.array(v.id("personalRepayments")),
  },
  returns: v.boolean(),
  handler: async (ctx, { sessionId, coverageCents, repaymentIds }) => {
    const repayments: Doc<"personalRepayments">[] = [];
    for (const id of repaymentIds) {
      const r = await ctx.db.get(id);
      if (r) repayments.push(r);
    }
    if (repayments.length === 0) return false;
    await postRepaymentFeeCoverage(ctx, {
      sessionId,
      coverageCents,
      repayments,
    });
    return true;
  },
});

export const run = internalAction({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    examined: v.number(),
    posted: v.number(),
    totalCents: v.number(),
    skippedNoCoverage: v.number(),
    unreadable: v.number(),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is not set — cannot read the actuals.");
    }

    const candidates: Candidate[] = await ctx.runMutation(
      internal.migrations["0073_backfill_repayment_fee_coverage"].listCandidates,
      {},
    );

    let posted = 0;
    let totalCents = 0;
    let skippedNoCoverage = 0;
    let unreadable = 0;

    for (const c of candidates) {
      const response = await fetch(
        `${STRIPE_API}/checkout/sessions/${encodeURIComponent(c.sessionId)}`,
        { headers: { Authorization: `Bearer ${secretKey}` } },
      );
      if (!response.ok) {
        // A session Stripe will not show us is one we cannot state a coverage
        // for. Counted and named, never assumed to be zero.
        console.error(
          `[0073] could not read session ${c.sessionId}: ${response.status} — skipped`,
        );
        unreadable += 1;
        continue;
      }
      const session = (await response.json()) as {
        amount_total?: number | null;
        payment_status?: string | null;
      };
      const charged = session.amount_total ?? 0;
      const coverage = charged - c.debtCents;

      // Zero is the pre-feature case and the overwhelmingly common one: the
      // payer was billed the debt exactly. Negative would mean the session paid
      // LESS than the debts we think it settled — a real discrepancy, but not
      // one this migration is entitled to resolve by inventing a row.
      if (coverage <= 0) {
        if (coverage < 0) {
          console.error(
            `[0073] session ${c.sessionId} charged ${charged}c against ${c.debtCents}c ` +
              `of debt — NEGATIVE coverage, needs a human. Skipped.`,
          );
        }
        skippedNoCoverage += 1;
        continue;
      }

      console.log(
        `[0073] session ${c.sessionId}: charged ${charged}c, debt ${c.debtCents}c ` +
          `⇒ ${coverage}c of fee coverage${write ? "" : " (dry run — nothing written)"}`,
      );
      if (write) {
        await ctx.runMutation(
          internal.migrations["0073_backfill_repayment_fee_coverage"].postOne,
          {
            sessionId: c.sessionId,
            coverageCents: coverage,
            repaymentIds: c.repaymentIds as never,
          },
        );
      }
      posted += 1;
      totalCents += coverage;
    }

    console.log(
      `[0073] examined ${candidates.length}, ${write ? "posted" : "would post"} ` +
        `${posted} coverage rows totalling ${totalCents}c ` +
        `(${skippedNoCoverage} had none, ${unreadable} unreadable)`,
    );
    return {
      examined: candidates.length,
      posted,
      totalCents,
      skippedNoCoverage,
      unreadable,
    };
  },
});
