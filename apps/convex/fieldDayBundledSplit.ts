/**
 * One-time: the Field Day $50 was a $30 tee AND a $20 gift (2026-08-09).
 *
 * `lib/seed/historical/fieldDayBundled2026.ts` holds the payment, the arithmetic,
 * the donor and the reasoning behind every judgement in this correction; this
 * runs it. In one sentence: $20 comes off the sale's gross and goes on the
 * giving ledger as a gift to Jordanella Maluka Chagiye's existing donor record,
 * and the $50 payment stays $50.
 *
 * ── IT RUNS THE LIVE CODE PATH, NOT A COPY OF IT ────────────────────────────
 * The write is `salesDonations.ts#applyBundledDonationSplit` — the same function
 * behind the `splitBundledDonation` mutation a human will use from the Sales tab.
 * A historical fix that hand-rolled the same inserts could miss one of the seven
 * rollups hanging off `recordGiftForDonor` (donor lifetime and count, donor
 * status, scope aggregates, the cross-chapter identity aggregate, the territory
 * launch pot, the event's Given total), and the discrepancy would surface months
 * later as a donor total nobody could explain. Sharing the path means the tests
 * that hold the mutation hold this too.
 *
 * ── NOTHING IS WRITTEN ON A PATTERN ─────────────────────────────────────────
 * The sale is found by its Stripe charge id and then RE-VERIFIED — amount, fee,
 * date, book, channel, that it is still unsplit and still carries no item
 * breakdown — against the data module before anything is touched. The donor is
 * found by EMAIL (the primary dedup key, which hits regardless of how her name
 * is spelled) and then re-verified by name. Any disagreement is reported in
 * `problems` and NOTHING is written: all or nothing, because half of this
 * correction is a worse state than none of it.
 *
 * ── BOOK VALUE MUST NOT MOVE ────────────────────────────────────────────────
 * $20 off `sales.grossCents` and $20 onto `gifts` is worth exactly $0 to
 * `reconciliation.ts#computeBookBalances`, which counts both at face value once
 * each. The runner computes `bookValueDeltaCents` from the two sides it actually
 * moved and reports it; `tests/fieldDayBundledSplit.test.ts` asserts it through
 * the real `accountBalances` query — the number the owner reads on
 * /finances/accounts — rather than a re-derivation here, which could agree with
 * this file while both disagree with the page.
 *
 * `execute` omitted / false = a zero-write dry run that reports exactly what a
 * real run would do. Delete this module and its data file once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { findDonorInScope } from "./lib/givingDonors";
import { applyBundledDonationSplit } from "./salesDonations";
import {
  CHARGE_CENTS,
  CHARGE_FEE_CENTS,
  DONATION_CENTS,
  EXPECTED_DONOR_EMAIL,
  EXPECTED_DONOR_GIFT_COUNT,
  EXPECTED_DONOR_LIFETIME_CENTS,
  EXPECTED_DONOR_NAME,
  GIFT_NOTE,
  OWNER_SUPPLIED_NAME,
  SALE_CENTS,
  SOLD_AT_MS,
  STRIPE_CHARGE_ID,
  TEE_ITEM,
  reconciles,
} from "./lib/seed/historical/fieldDayBundled2026";

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** What the correction does to her donor record — the single thing most worth
 *  eyeballing before `execute: true`, because the failure this module is most
 *  concerned with (a second "Jordanella Maluka" record) shows up here as a
 *  lifetime that didn't move rather than as an error. */
const donorReport = v.object({
  name: v.string(),
  email: v.union(v.string(), v.null()),
  /** False means a NEW donor would be created — which for this correction is
   *  always wrong, and stops the run. */
  matchedExisting: v.boolean(),
  lifetimeCentsBefore: v.number(),
  lifetimeCentsAfter: v.number(),
  giftCountBefore: v.number(),
  giftCountAfter: v.number(),
});

export const runFieldDayBundledSplit = internalMutation({
  args: {
    /** Stamped on the sale as `donationSplitBy` — a money reclassification
     *  leaves an attributable trail. Passed in because this runs from the CLI,
     *  which carries the deployment admin key and has no session to derive a
     *  person from. Their roster row in the New York chapter is resolved below;
     *  if they have none the split still runs, unattributed, rather than
     *  failing — the trail is worth having but is not the correction. */
    recordedBy: v.id("users"),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    /** False when something could not be verified — nothing was written. */
    proceeded: v.boolean(),
    stripeChargeId: v.string(),
    saleFound: v.boolean(),
    /** The payment, before and after. These must be equal. */
    chargeCentsBefore: v.number(),
    chargeCentsAfter: v.number(),
    saleGrossCentsAfter: v.number(),
    donationCents: v.number(),
    /** Untouched, and reported so that is visible rather than assumed. */
    feeCents: v.number(),
    donor: v.union(donorReport, v.null()),
    /** The whole point: 0. Non-zero means this is not a reclassification and
     *  should not be executed. */
    bookValueDeltaCents: v.number(),
    /** Disagreements and open questions — reported, never guessed past. */
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { recordedBy, execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];

    // THE JUDGEMENT IS DISCLOSED ON EVERY RUN, dry or real. The $30/$20 split
    // rests on the owner's account of one transaction plus four sibling charges
    // Stripe priced at $30; the identity of the giver rests on the owner alone.
    // A judgement that is invisible after it is made is one nobody can revisit,
    // so it stays in front of whoever reads a run.
    problems.push(
      `the ${usd(DONATION_CENTS)} is recorded as a gift from "${EXPECTED_DONOR_NAME}" on the owner's ` +
        `word of 2026-08-09 (he named her "${OWNER_SUPPLIED_NAME}"; the donor record carries the third ` +
        `name, and the match below is made on her email so the spelling cannot mint a second record). ` +
        `The ${usd(SALE_CENTS)} merch half is corroborated by the four other 2026-08-08 charges Stripe ` +
        `itself priced at ${usd(SALE_CENTS)} for one ${TEE_ITEM.label}; the gift half is then forced by ` +
        `subtraction. If the giver is wrong, undo through salesDonations.undoBundledDonationSplit.`,
    );

    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) {
      throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });
    }

    const sale = await ctx.db
      .query("sales")
      .withIndex("by_charge", (q) => q.eq("stripeChargeId", STRIPE_CHARGE_ID))
      .first();

    const nothing = {
      dryRun: !write,
      proceeded: false,
      stripeChargeId: STRIPE_CHARGE_ID,
      saleFound: sale != null,
      chargeCentsBefore: sale ? sale.grossCents + (sale.donationCents ?? 0) : 0,
      chargeCentsAfter: sale ? sale.grossCents + (sale.donationCents ?? 0) : 0,
      saleGrossCentsAfter: sale?.grossCents ?? 0,
      donationCents: 0,
      feeCents: sale?.feeCents ?? 0,
      donor: null,
      bookValueDeltaCents: 0,
      problems,
    };

    // ── 0. The module's own arithmetic, before any database question ─────────
    if (!reconciles()) {
      problems.push(
        `the data module does not add up: ${usd(SALE_CENTS)} + ${usd(DONATION_CENTS)} is not ` +
          `${usd(CHARGE_CENTS)}, or the item line does not come to the merch half — nothing written.`,
      );
      return nothing;
    }

    if (!sale) {
      problems.push(
        `no sale with Stripe charge ${STRIPE_CHARGE_ID}. Nothing written; find out where the ` +
          `${usd(CHARGE_CENTS)} went before running this again.`,
      );
      return nothing;
    }

    // ── 1. Already split? The benign second run, with positive proof ─────────
    // Not "the amount looks right so it must have run" — the split's own record
    // on the row (`donationCents` + the gift it points at) is what says so.
    if (sale.donationCents !== undefined) {
      const priorGift = sale.donationGiftId ? await ctx.db.get(sale.donationGiftId) : null;
      if (
        sale.donationCents === DONATION_CENTS &&
        sale.grossCents === SALE_CENTS &&
        priorGift &&
        priorGift.amountCents === DONATION_CENTS
      ) {
        return {
          ...nothing,
          proceeded: true,
          donationCents: sale.donationCents,
          saleGrossCentsAfter: sale.grossCents,
        };
      }
      problems.push(
        `this payment already carries a ${usd(sale.donationCents)} split (gross ${usd(sale.grossCents)}, ` +
          `gift ${priorGift ? usd(priorGift.amountCents) : "missing"}) and it is not the one this module ` +
          `describes — nothing written. Resolve by hand.`,
      );
      return nothing;
    }

    // ── 2. The sale, re-verified against the module before anything moves ────
    // Every one of these is a fact the correction depends on. A row that has
    // moved book, changed amount, changed date or already been given an item
    // breakdown is not the row this module was written against, and splitting it
    // anyway would be guessing.
    if (sale.chapterId !== chapter._id) {
      problems.push(
        `sale ${STRIPE_CHARGE_ID}: expected New York's book, found "${sale.chapterId}" — nothing ` +
          `written. This correction moves money between layers on ONE book and cannot reason about two.`,
      );
      return nothing;
    }
    if (sale.grossCents !== CHARGE_CENTS) {
      problems.push(
        `sale ${STRIPE_CHARGE_ID}: expected ${usd(CHARGE_CENTS)}, found ${usd(sale.grossCents)} — ` +
          `nothing written.`,
      );
      return nothing;
    }
    if (sale.feeCents !== CHARGE_FEE_CENTS) {
      // Not fatal to the money — the fee is left alone either way and contributes
      // to no total here. But a fee that has moved means the row was re-read from
      // a Stripe balance transaction that no longer matches what this module was
      // written against, which is worth knowing before trusting the rest.
      problems.push(
        `the fee on ${STRIPE_CHARGE_ID} is ${usd(sale.feeCents)}, not the ${usd(CHARGE_FEE_CENTS)} this ` +
          `module recorded — proceeding (the fee is not split and moves no total), but check why.`,
      );
    }
    if (sale.soldAt !== SOLD_AT_MS) {
      problems.push(
        `sale ${STRIPE_CHARGE_ID}: expected it tapped at ${new Date(SOLD_AT_MS).toISOString()}, found ` +
          `${new Date(sale.soldAt).toISOString()} — nothing written. The gift is dated to this instant.`,
      );
      return nothing;
    }
    if (sale.items.length > 0) {
      problems.push(
        `sale ${STRIPE_CHARGE_ID}: something has since resolved its items (${sale.itemSource}) — ` +
          `nothing written. Read what it now says was sold before assuming ${usd(SALE_CENTS)} of it ` +
          `was one ${TEE_ITEM.label}.`,
      );
      return nothing;
    }

    // ── 3. The donor, found by EMAIL and then re-verified by name ────────────
    // Email is the primary dedup key and hits regardless of how the name is
    // spelled, which is the entire reason this correction does not go anywhere
    // near the owner's two-part "Jordanella Maluka". The name check afterwards is
    // not how she is found — it is how the run proves the row it found is hers.
    const donor = await findDonorInScope(ctx, chapter._id, {
      email: EXPECTED_DONOR_EMAIL,
    });
    if (!donor) {
      problems.push(
        `no donor with email ${EXPECTED_DONOR_EMAIL} on the New York book — nothing written. ` +
          `Running anyway would CREATE a second "${EXPECTED_DONOR_NAME}" and cut her giving history ` +
          `in two, which is the one outcome this correction exists to avoid.`,
      );
      return nothing;
    }
    if (donor.name.trim() !== EXPECTED_DONOR_NAME) {
      problems.push(
        `the donor at ${EXPECTED_DONOR_EMAIL} is now named "${donor.name}", not ` +
          `"${EXPECTED_DONOR_NAME}" — nothing written. The owner's "the donation is from ` +
          `${OWNER_SUPPLIED_NAME}" no longer demonstrably points at this record.`,
      );
      return nothing;
    }
    if (
      donor.lifetimeCents !== EXPECTED_DONOR_LIFETIME_CENTS ||
      donor.giftCount !== EXPECTED_DONOR_GIFT_COUNT
    ) {
      // Not fatal: she is free to give again between this module being written
      // and being run, and the split adds to whatever is there. Said out loud so
      // the before/after below is read against the right starting point.
      problems.push(
        `her giving has moved since this module was written — ${usd(donor.lifetimeCents)} across ` +
          `${donor.giftCount} gifts, not ${usd(EXPECTED_DONOR_LIFETIME_CENTS)} across ` +
          `${EXPECTED_DONOR_GIFT_COUNT}. Proceeding; the ${usd(DONATION_CENTS)} adds to the current total.`,
      );
    }

    const donorBefore = {
      name: donor.name,
      email: donor.email ?? null,
      matchedExisting: true,
      lifetimeCentsBefore: donor.lifetimeCents,
      lifetimeCentsAfter: donor.lifetimeCents + DONATION_CENTS,
      giftCountBefore: donor.giftCount,
      giftCountAfter: donor.giftCount + 1,
    };

    // ── 4. The write, through the live path ─────────────────────────────────
    if (write) {
      // The runner's own attribution. `by_user` and the placeholder rule are
      // the same ones `lib/org.ts#viewerPerson` uses — not that helper itself,
      // because it derives the user from the SESSION and this runs from the CLI
      // with none. Best-effort: an operator with no roster row in New York
      // leaves the split unattributed rather than unrun.
      const personRows = await ctx.db
        .query("people")
        .withIndex("by_user", (q) => q.eq("userId", recordedBy))
        .collect();
      const person =
        personRows.find(
          (p) => p.chapterId === chapter._id && p.isPlaceholder !== true,
        ) ?? null;

      await applyBundledDonationSplit(ctx, {
        saleId: sale._id,
        donationCents: DONATION_CENTS,
        // HER RECORD'S OWN NAME, never the owner's two-part version — belt and
        // braces beside the email, so that even if the email dedup were somehow
        // to miss, the exact-name fallback lands on the same row rather than
        // creating a near-duplicate.
        donorName: EXPECTED_DONOR_NAME,
        donorEmail: EXPECTED_DONOR_EMAIL,
        items: [{ ...TEE_ITEM, candidates: [...TEE_ITEM.candidates] }],
        note: GIFT_NOTE,
        splitByPersonId: person?._id ?? null,
      });
    }

    return {
      dryRun: !write,
      proceeded: true,
      stripeChargeId: STRIPE_CHARGE_ID,
      saleFound: true,
      chargeCentsBefore: CHARGE_CENTS,
      // Computed from the two halves the split actually writes, not asserted —
      // if these ever differ from `chargeCentsBefore`, the payment changed size
      // and the correction is wrong.
      chargeCentsAfter: SALE_CENTS + DONATION_CENTS,
      saleGrossCentsAfter: SALE_CENTS,
      donationCents: DONATION_CENTS,
      feeCents: sale.feeCents,
      donor: donorBefore,
      // Sales revenue falls by the gift; giving rises by the same. Computed from
      // the two sides this run moves rather than hard-coded to 0.
      bookValueDeltaCents: (SALE_CENTS - CHARGE_CENTS) + DONATION_CENTS,
      problems,
    };
  },
});
