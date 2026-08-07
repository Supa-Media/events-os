/**
 * Revenue-side reconciliation (2026-08-07) — a ONE-TIME ops module.
 *
 * Two fixes toward the founder's goal of book value tracking real cash:
 *
 *   1. LINK DIRECT-TO-BANK GIFTS. When someone wires or ACHs the org directly, the
 *      money produces a `gifts` row AND a plain bank inflow for the same dollars.
 *      `reconciliation.ts` already knows to skip the bank row — but only when the gift
 *      names it via `gifts.transactionId`. Not one of the 172 gifts is linked, so
 *      every direct gift is counted twice: once as revenue, once as ledger inflow.
 *
 *   2. CREATE THE MISSING IN-KIND GIFT. $13,356.62 of the ledger is spending the
 *      founders put on personal cards. All of it is donated, so all of it should have
 *      a matching gift — otherwise the book carries the cost of a donation without the
 *      donation. $12,513.59 already does. The last $843.03 is the 16 purchases
 *      recovered from Amazon order history and Uber trip history on 2026-08-06, which
 *      were created as expenses with no giving-side counterpart.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — payout fee rows. Revenue is counted gross and
 * lands net, so the fee should be an expense; the founder asked for exactly that. It
 * cannot be derived honestly yet. Stripe's payout engine has no rows in production
 * (`stripePayouts` is empty), and working backwards from the deposits doesn't close
 * either: $16,404.19 of payout deposits has been banked against only $12,793.25 of
 * recorded gifts and tickets. That $3,610.94 excess is the merch and food sold through
 * Stripe that hasn't been connected yet — so the difference between gross and net
 * today is "fees MINUS unrecorded sales", not fees. Writing a fee row from that number
 * would be inventing one. Connect the sales first; then the residual IS the fee and
 * this can be finished in one pass.
 *
 * Dry-run by default. Idempotent.
 *
 * The new gift is inserted directly rather than through `recordGiftForDonor`, which
 * would also match-or-create a donor, stamp `lastGiftAt`, re-derive donor status from
 * the 90-day window and touch the territory launch pot — all wrong for a backfilled
 * 2025 in-kind row attached to an existing donor. The donor rollup it DOES owe
 * (`lifetimeCents`, `giftCount`) is applied explicitly alongside.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";

/**
 * Bank rows that ARE a recorded gift arriving. Linking them stops the double-count.
 *
 * A deposit may carry MORE THAN ONE gift: the founder wired $7,000 and split it
 * $5,000 to central / $2,000 to New York, so both gifts point at the one deposit.
 * `linkedGiftTxnIds` is a Set, so the row is skipped once regardless — which is the
 * correct behaviour, not a coincidence worth relying on silently.
 *
 * Gifts are matched by amount + date + scope rather than `externalRef`, because the
 * split legs were created in-app and carry no ref. `scope` is what disambiguates the
 * two halves of the wire.
 */
type GiftKey = { amountCents: number; scope: "central" | "ny" };
const GIFT_ARRIVALS: {
  bankAmountCents: number;
  bankDateISO: string;
  giftDateISO: string;
  gifts: GiftKey[];
  note: string;
}[] = [
  {
    bankAmountCents: 700000,
    bankDateISO: "2026-03-26",
    giftDateISO: "2026-03-26",
    gifts: [
      { amountCents: 500000, scope: "central" },
      { amountCents: 200000, scope: "ny" },
    ],
    note: "Founder wire, split $5,000 central / $2,000 New York against one $7,000 deposit",
  },
  {
    bankAmountCents: 100000,
    bankDateISO: "2025-09-17",
    giftDateISO: "2025-09-17",
    gifts: [{ amountCents: 100000, scope: "ny" }],
    note: "Founder wire",
  },
  {
    bankAmountCents: 50000,
    bankDateISO: "2025-09-19",
    giftDateISO: "2025-09-19",
    gifts: [{ amountCents: 50000, scope: "ny" }],
    note: "Truist → Relay transfer",
  },
];

/** The one in-kind gift still missing: the 2026-08-06 receipt recovery. */
const MISSING_INKIND = {
  externalRef: "genesis:cleanup2026",
  amountCents: 84303,
  receivedAtISO: "2025-12-31",
  donorName: "Oluseyi Olujide",
  note:
    "In-kind: 16 purchases recovered 2026-08-06 from Amazon order history and Uber trip " +
    "history — 8 Amazon orders and 8 rides bought personally for the org, none of which " +
    "reached the original Notion record. Dated year-end 2025 (they span Nov 2024–Sep 2025). " +
    "Mirrors the `genesis-cleanup:*` expense rows.",
};

const DAY = 86400000;

export const runGenesisRevenueSync = internalMutation({
  args: { editedBy: v.id("users"), execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    giftsLinked: v.number(),
    inKindGiftCreated: v.boolean(),
    alreadyApplied: v.number(),
    skipped: v.array(v.string()),
  }),
  handler: async (ctx, { editedBy, execute }) => {
    const write = execute ?? false;
    const skipped: string[] = [];
    let giftsLinked = 0, alreadyApplied = 0, inKindGiftCreated = false;

    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });

    const txns: Doc<"transactions">[] = [];
    for (const c of await ctx.db.query("chapters").collect()) {
      txns.push(
        ...(await ctx.db
          .query("transactions")
          .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", c._id))
          .take(6000)),
      );
    }
    txns.push(
      ...(await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", "central"))
        .take(6000)),
    );

    // ── 1. Link gift arrivals ────────────────────────────────────────────────
    for (const arrival of GIFT_ARRIVALS) {
      const when = Date.parse(arrival.bankDateISO + "T00:00:00Z");
      const bank = txns.find(
        (t) =>
          t.flow === "inflow" &&
          t.status !== "excluded" &&
          t.amountCents === arrival.bankAmountCents &&
          Math.abs(t.postedAt - when) <= 2 * DAY,
      );
      if (!bank) {
        skipped.push(`${arrival.note}: no ${arrival.bankAmountCents}c inflow near ${arrival.bankDateISO}`);
        continue;
      }
      const giftWhen = Date.parse(arrival.giftDateISO + "T00:00:00Z");
      for (const key of arrival.gifts) {
        const scope = key.scope === "central" ? ("central" as const) : chapter._id;
        const candidates = await ctx.db
          .query("gifts")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .collect();
        const matches = candidates.filter(
          (g) =>
            g.amountCents === key.amountCents &&
            Math.abs(g.receivedAt - giftWhen) <= 2 * DAY &&
            g.method !== "in_kind",
        );
        if (matches.length !== 1) {
          // Ambiguity here would link the wrong gift, so refuse rather than guess.
          skipped.push(
            `${arrival.note}: expected exactly 1 ${key.amountCents}c ${key.scope} gift near ${arrival.giftDateISO}, found ${matches.length}`,
          );
          continue;
        }
        const gift = matches[0];
        if (gift.transactionId === bank._id) { alreadyApplied++; continue; }
        if (gift.transactionId != null) {
          skipped.push(`${arrival.note}: a matching gift already links elsewhere`);
          continue;
        }
        // A plain patch is right here: `transactionId` is provenance, not money —
        // no amount changes, so no rollup moves.
        if (write) await ctx.db.patch(gift._id, { transactionId: bank._id });
        giftsLinked++;
      }
    }

    // ── 2. The missing in-kind gift ──────────────────────────────────────────
    const existing = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", MISSING_INKIND.externalRef))
      .first();
    if (existing) {
      alreadyApplied++;
    } else {
      const donors = await ctx.db
        .query("donors")
        .withIndex("by_scope", (q) => q.eq("scope", chapter._id))
        .collect();
      // The founder has two donor records (a known duplicate, flagged separately);
      // attach to the one carrying the rest of his giving so totals stay in one place.
      const donor = donors
        .filter((d) => d.name === MISSING_INKIND.donorName)
        .sort((a, b) => b.lifetimeCents - a.lifetimeCents)[0];
      if (!donor) {
        skipped.push(`donor "${MISSING_INKIND.donorName}" not found on the NY chapter`);
      } else if (write) {
        const receivedAt = Date.parse(MISSING_INKIND.receivedAtISO + "T12:00:00Z");
        await ctx.db.insert("gifts", {
          donorId: donor._id,
          scope: chapter._id,
          amountCents: MISSING_INKIND.amountCents,
          currency: "usd",
          receivedAt,
          method: "in_kind",
          externalRef: MISSING_INKIND.externalRef,
          note: MISSING_INKIND.note,
          recordedBy: editedBy,
          createdAt: Date.now(),
        });
        await ctx.db.patch(donor._id, {
          lifetimeCents: donor.lifetimeCents + MISSING_INKIND.amountCents,
          giftCount: donor.giftCount + 1,
        });
        inKindGiftCreated = true;
      } else {
        inKindGiftCreated = true;
      }
    }

    return { dryRun: !write, giftsLinked, inKindGiftCreated, alreadyApplied, skipped };
  },
});
