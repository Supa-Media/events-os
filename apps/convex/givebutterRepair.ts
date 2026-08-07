/**
 * One-time repair of the Givebutter backfill/sync collision (2026-08-07).
 *
 * Runs the three corrections described in
 * `lib/seed/historical/givebutterRepair2026.ts`:
 *   1. remove the 20 CSV-backfill gift rows the live sync superseded ($665);
 *   2. add the one donation neither importer can reach (Sarah Gonzalez, $100);
 *   3. restate the 14 Pop The Balloon ticket prices the mirror booked at face
 *      value, and move the event's `revenueCents` by the same delta (−$315).
 *
 * NOTHING IS REMOVED OR PATCHED ON A PATTERN. Every row is re-verified against
 * the amount recorded in the data module before it is touched, and a row that
 * disagrees is REPORTED in `mismatches` and skipped — never guessed at. That
 * rule is the direct lesson of a `genesis-bank:42` deletion earlier in this
 * reconciliation: a $500 bank deposit removed because it matched a duplicate's
 * amount and date, when the owner had genuinely sent $500 twice that day.
 *
 * Gifts go through `removeGiftRow`/`recordGiftForDonor` rather than
 * `ctx.db.delete`/`insert`, because donor `lifetimeCents`/`giftCount`, the
 * scope rollups, donor status, the cross-chapter identity totals and the
 * territory launch pot all hang off those helpers. A raw delete would leave
 * every one of them overstated.
 *
 * `execute` omitted / false = a zero-write dry run that reports exactly what a
 * real run would do. Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import {
  matchOrCreateDonor,
  recordGiftForDonor,
  removeGiftRow,
} from "./lib/givingDonors";
import {
  MISSING_GIFT,
  PTB_EXPECTED_TICKET_REVENUE_CENTS,
  STALE_BACKFILL_GIFTS,
  STALE_BACKFILL_TOTAL_CENTS,
  TICKET_PRICE_CORRECTIONS,
  TICKET_REVENUE_DELTA_CENTS,
} from "./lib/seed/historical/givebutterRepair2026";

/** The public page whose event holds the Pop The Balloon ticket mirror. */
const PTB_PAGE_SLUG = "pop-the-balloon";

export const runGivebutterRepair = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    giftsRemoved: v.number(),
    giftCentsRemoved: v.number(),
    missingGiftAdded: v.boolean(),
    ticketsCorrected: v.number(),
    ticketRevenueDeltaCents: v.number(),
    revenueCentsBefore: v.number(),
    revenueCentsAfter: v.number(),
    revenueMatchesExport: v.boolean(),
    /** Rows whose live values disagreed with the module — skipped, not guessed. */
    mismatches: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const mismatches: string[] = [];

    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_slug", (q) => q.eq("slug", PTB_PAGE_SLUG))
      .unique();
    if (!page) {
      throw new ConvexError({
        code: "NO_PAGE",
        message: `No event page with slug "${PTB_PAGE_SLUG}".`,
      });
    }

    // ── 1. Retire the superseded backfill gifts ──────────────────────────────
    let giftsRemoved = 0;
    let giftCentsRemoved = 0;
    for (const stale of STALE_BACKFILL_GIFTS) {
      const gift = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", stale.externalRef))
        .first();
      if (!gift) {
        // Already removed (a second run) — not an error, just nothing to do.
        continue;
      }
      if (gift.amountCents !== stale.amountCents) {
        mismatches.push(
          `${stale.externalRef} (${stale.donor}): expected ${stale.amountCents}¢, found ${gift.amountCents}¢ — SKIPPED`,
        );
        continue;
      }
      if (write) await removeGiftRow(ctx, gift._id);
      giftsRemoved += 1;
      giftCentsRemoved += gift.amountCents;
    }

    // ── 2. The donation no importer can reach ────────────────────────────────
    const already = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) =>
        q.eq("externalRef", MISSING_GIFT.externalRef),
      )
      .first();
    let missingGiftAdded = false;
    if (!already) {
      if (write) {
        const donorId = await matchOrCreateDonor(ctx, {
          scope: page.chapterId,
          name: MISSING_GIFT.donorName,
          email: MISSING_GIFT.email,
          source: "givebutter-import",
        });
        await recordGiftForDonor(ctx, {
          donorId,
          amountCents: MISSING_GIFT.amountCents,
          receivedAt: MISSING_GIFT.receivedAt,
          method: "givebutter",
          externalRef: MISSING_GIFT.externalRef,
          note: MISSING_GIFT.note,
        });
      }
      missingGiftAdded = true;
    }

    // ── 3. Restate the face-value ticket prices ──────────────────────────────
    const revenueCentsBefore = page.revenueCents;
    let ticketsCorrected = 0;
    let appliedDelta = 0;
    for (const fix of TICKET_PRICE_CORRECTIONS) {
      const order = await ctx.db
        .query("ticketOrders")
        .withIndex("by_external_ref", (q) => q.eq("externalRef", fix.externalRef))
        .unique();
      if (!order) {
        mismatches.push(`${fix.externalRef} (${fix.who}): no mirror order — SKIPPED`);
        continue;
      }
      // A mirror order is exactly one ticket; anything else means the sync's
      // shape changed under us and the correction no longer describes it.
      if (order.items.length !== 1 || order.items[0].quantity !== 1) {
        mismatches.push(
          `${fix.externalRef} (${fix.who}): expected 1 line × qty 1, found ${order.items.length} line(s) — SKIPPED`,
        );
        continue;
      }
      const line = order.items[0];
      if (line.unitPriceCents !== fix.expectedCurrentCents) {
        // Already corrected (a second run) is the benign case; anything else is
        // a genuine disagreement worth surfacing.
        if (line.unitPriceCents !== fix.correctedCents) {
          mismatches.push(
            `${fix.externalRef} (${fix.who}): expected ${fix.expectedCurrentCents}¢, found ${line.unitPriceCents}¢ — SKIPPED`,
          );
        }
        continue;
      }
      appliedDelta += fix.correctedCents - fix.expectedCurrentCents;
      ticketsCorrected += 1;
      if (write) {
        await ctx.db.patch(order._id, {
          items: [{ ...line, unitPriceCents: fix.correctedCents }],
          totalCents: fix.correctedCents,
          updatedAt: Date.now(),
        });
      }
    }

    // Move the event's denormalized revenue by the SAME delta the line items
    // moved — the rollup is never recomputed from scratch here, so a partial
    // run (some rows skipped) stays internally consistent.
    const revenueCentsAfter = revenueCentsBefore + appliedDelta;
    if (write && appliedDelta !== 0) {
      await ctx.db.patch(page._id, {
        revenueCents: revenueCentsAfter,
        updatedAt: Date.now(),
      });
    }

    if (giftCentsRemoved !== 0 && giftCentsRemoved !== STALE_BACKFILL_TOTAL_CENTS) {
      mismatches.push(
        `removed ${giftCentsRemoved}¢ of gifts, module expects ${STALE_BACKFILL_TOTAL_CENTS}¢`,
      );
    }
    if (appliedDelta !== 0 && appliedDelta !== TICKET_REVENUE_DELTA_CENTS) {
      mismatches.push(
        `ticket delta ${appliedDelta}¢, module expects ${TICKET_REVENUE_DELTA_CENTS}¢`,
      );
    }

    return {
      dryRun: !write,
      giftsRemoved,
      giftCentsRemoved,
      missingGiftAdded,
      ticketsCorrected,
      ticketRevenueDeltaCents: appliedDelta,
      revenueCentsBefore,
      revenueCentsAfter,
      revenueMatchesExport:
        revenueCentsAfter === PTB_EXPECTED_TICKET_REVENUE_CENTS,
      mismatches,
    };
  },
});
