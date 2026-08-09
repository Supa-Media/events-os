/**
 * Splitting a bundled gift out of a sale — and putting it back.
 *
 * ── THE SITUATION THIS EXISTS FOR ────────────────────────────────────────────
 * In-person money comes through a third-party Tap-to-Pay app
 * (`com.pocketvendor.payment`) that sends Stripe ONE amount. It has no notion of
 * a donation, and it is not ours to change. So when someone at Field Day on
 * 2026-08-08 wanted a $30 tee and also wanted to give $20, there was nowhere for
 * the second half to go. The owner, that day:
 *
 *     "The $50 was someone wanting to buy a shirt but also give a donation,
 *      I had no way to really do that so I just typed in 50"
 *
 * $50 of merch revenue is the wrong answer twice over: the giving ledger never
 * hears about $20 that was given, and the donor's own record never grows by it.
 * The total was right, which is exactly why nobody would ever have caught it.
 *
 * ── WHY AFTER THE FACT, AND NOT AT THE POINT OF SALE ─────────────────────────
 * Because the point of sale is a third-party app that will keep sending a single
 * amount no matter what we build. Any fix that requires the operator to have
 * done something different at the table is a fix for a rail we don't own. So the
 * split has to be possible LATER, from a row that already exists — someone looks
 * at a $50 sale and says "$30 of that was a tee, $20 was a gift from Jordanella".
 * That is what `splitBundledDonation` is.
 *
 * ── FOLLOWING `ticketOrders`, NOT INVENTING A SECOND PATTERN ─────────────────
 * `ticketOrders.donationCents` already solved this exact problem for the ticket
 * rail: one Stripe charge carrying tickets AND an add-on gift, split so tickets
 * become revenue and the gift becomes giving, with the donation deliberately NOT
 * part of `totalCents`. `sales.donationCents` is the same field doing the same
 * job on the merch rail, with the same invariant — see its schema doc.
 *
 * ONE DEPARTURE, and it is forced. A ticket order's bundled gift settles into a
 * `donations` row first (`giving.ts#createPaidDonationForOrder`), which then
 * dual-writes the `gifts` row. A sale cannot do that: `donations.eventId` is
 * REQUIRED — a donation is a row on an event's public giving page — and a sale
 * often has no event at all (the $50 charge above is attributed to no event,
 * because card-present sales are matched to events by date and that day's
 * charges matched nothing). Rather than invent an event to hang a donation off,
 * the split writes the `gifts` row directly through `matchOrCreateDonor` +
 * `recordGiftForDonor` — which is the same pair `dualWriteGiftForDonation` calls
 * at the end of the ticket path anyway. Same ledger, same helpers, one fewer hop
 * through a table that cannot represent this case.
 *
 * ── NEVER `ctx.db.insert("gifts")` ───────────────────────────────────────────
 * The helpers are not a convenience. Hanging off `recordGiftForDonor` are the
 * donor's lifetime total and gift count, the donor's derived status, the scope
 * aggregates, the cross-chapter identity rollup, the territory launch-fund pot,
 * and — when the sale has an event — that event's "Given" counter. A raw insert
 * leaves every one of them understated, and `removeGiftRow` is the only thing
 * that reverses the set. That is why undo goes back out through it.
 *
 * ── TOTAL REVENUE MUST NOT MOVE ──────────────────────────────────────────────
 * `reconciliation.ts#computeBookBalances` counts `sales.grossCents` and
 * `gifts.amountCents` at face value, once each. Taking $20 off one and adding
 * $20 to the other is worth exactly $0, and that is the test of whether a split
 * is a reclassification or a mistake. `tests/salesDonations.test.ts` reads book
 * value out of the real `accountBalances` query before and after and requires
 * equality — not a re-derivation of the model here, which could agree with this
 * file while both disagree with the page the owner actually reads.
 *
 * ── THE FEE IS NOT SPLIT ─────────────────────────────────────────────────────
 * There is one fee and it belongs to the whole payment. Stripe stated it for the
 * charge and never stated a per-half breakdown, so splitting it would be
 * deriving a number nobody reported — and `sales.feeCents` documents itself as
 * never derived. `gifts` has no fee field to hold the other piece in any case.
 * It moves no total either way: fees are a separate monthly expense written by
 * `processorFees.ts` from Stripe's own balance-transaction ledger, and book
 * value never nets them out of revenue. So `feeCents` is left untouched, whole,
 * on the sale row.
 */
import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireFinanceRole } from "./lib/finance";
import {
  findDonorInScope,
  matchOrCreateDonor,
  recordGiftForDonor,
  removeGiftRow,
} from "./lib/givingDonors";

/**
 * The floor for splitting a payment. A split moves money between two revenue
 * streams without changing the total, so it is a bookkeeping correction rather
 * than an approval — `bookkeeper` is the same bar `finances.ts#markAsRefund`
 * reclassifies a transaction pair at. Written through `requireFinanceRole`
 * rather than inline so raising it later is one line here and nothing at the
 * call sites.
 */
const SPLIT_MIN_ROLE = "bookkeeper" as const;

/** A hand-typed gift far past this is a mis-key, not a donation. Cheap guard on
 *  a field a human types into a phone at a merch table. */
const MAX_DONATION_CENTS = 1_000_000;

/** Line items as a caller may restate them for the merch half of a split. */
const itemInput = v.object({
  label: v.string(),
  quantity: v.number(),
  unitPriceCents: v.number(),
  candidates: v.array(v.string()),
});

type SaleItem = Doc<"sales">["items"][number];

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function itemsTotal(items: readonly SaleItem[]): number {
  return items.reduce((a, i) => a + i.quantity * i.unitPriceCents, 0);
}

/**
 * Which giving rail this sale's money arrived on, so the gift's `method` says
 * something true rather than defaulting. Read off the sale's own idempotency key
 * — the one field that already records which rail carried the payment — so it
 * can never disagree with the row it came from.
 */
function giftMethodForSale(sale: Doc<"sales">): Doc<"gifts">["method"] {
  if (sale.stripeChargeId) return "stripe";
  if (sale.externalRef?.startsWith("cashapp:")) return "cash_app";
  return "other";
}

/** The gift's dedup key: this sale, and only ever this sale. Namespaced like
 *  every other `externalRef` in the ledger so it cannot collide with a rail's
 *  own ids, and derived from the sale id so a second split of the same row
 *  would be visible rather than silent (it is refused outright below). */
function giftRefForSale(saleId: Id<"sales">): string {
  return `sale:${saleId}:donation`;
}

/** What a split did, for whoever asked for it. */
export type SplitResult = {
  donorId: Id<"donors">;
  giftId: Id<"gifts">;
  donorExisted: boolean;
  donorName: string;
  saleGrossCents: number;
  donationCents: number;
  chargeCents: number;
};

export type SplitArgs = {
  saleId: Id<"sales">;
  donationCents: number;
  donorName: string;
  donorEmail?: string;
  donorPhone?: string;
  items?: SaleItem[];
  note?: string;
  /** Stamped as `donationSplitBy`. The public mutation passes the caller's
   *  roster person; a one-time migration passes whoever authorised the run. */
  splitByPersonId?: Id<"people"> | null;
};

/**
 * The split itself, with NO authorization of its own — every caller brings its
 * own gate (`splitBundledDonation` below, `requireFinanceRole`; the one-time
 * `fieldDayBundledSplit.ts`, the deployment admin key). Extracted so those two
 * cannot drift: a historical correction that hand-rolled the same writes could
 * miss a rollup the live path maintains, and the difference would only show up
 * as a wrong donor total months later. The migration runs THIS, so the tests
 * that hold this function still hold the migration too.
 */
export async function applyBundledDonationSplit(
  ctx: MutationCtx,
  args: SplitArgs,
): Promise<SplitResult> {
  const sale = await ctx.db.get(args.saleId);
  if (!sale) {
    throw new ConvexError({ code: "NOT_FOUND", message: "That sale doesn't exist." });
  }

  if (sale.donationCents !== undefined) {
    throw new ConvexError({
      code: "ALREADY_SPLIT",
      message:
        `This payment already carries a ${usd(sale.donationCents)} gift. Undo that split ` +
        `first if it was wrong — splitting twice would take the gift off the sale twice.`,
    });
  }

  const donationCents = args.donationCents;
  if (!Number.isInteger(donationCents) || donationCents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "A bundled gift has to be a whole number of cents above zero.",
    });
  }
  if (donationCents > MAX_DONATION_CENTS) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${usd(donationCents)} looks like a mis-key rather than a gift.`,
    });
  }
  // STRICTLY less, not at-most. A payment that was ENTIRELY a gift is not a
  // sale with a gift attached — it is a gift that was rung up on the merch
  // terminal, and leaving a $0 sale row behind to represent it would put a
  // sale in the books that never sold anything. Say so instead of writing it.
  if (donationCents >= sale.grossCents) {
    throw new ConvexError({
      code: "GIFT_EXCEEDS_SALE",
      message:
        `The gift (${usd(donationCents)}) has to leave something behind — this payment is ` +
        `${usd(sale.grossCents)}. If the whole payment was a gift, record it in Giving and ` +
        `remove the sale row rather than splitting it to zero.`,
    });
  }

  const name = args.donorName.trim();
  if (!name) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "A gift needs a giver — say who it was from.",
    });
  }

  const newGrossCents = sale.grossCents - donationCents;

  // ── The merch half's breakdown ───────────────────────────────────────────
  // Whatever `items` ends up as, it has to describe `grossCents` and nothing
  // else. The existing breakdown described the FULL payment, so once the gift
  // comes off it is either still exactly right (it never mentioned the gift)
  // or it is now overstated — and there is no way to tell which by looking at
  // it, only by adding it up.
  let items = sale.items;
  let itemSource = sale.itemSource;
  if (args.items !== undefined) {
    for (const line of args.items) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new ConvexError({
          code: "INVALID_ITEMS",
          message: `"${line.label}" needs a whole quantity above zero.`,
        });
      }
      if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents <= 0) {
        throw new ConvexError({
          code: "INVALID_ITEMS",
          message: `"${line.label}" needs a whole unit price above zero.`,
        });
      }
    }
    const stated = itemsTotal(args.items);
    if (stated !== newGrossCents) {
      throw new ConvexError({
        code: "ITEMS_DONT_ADD_UP",
        message:
          `Those items come to ${usd(stated)} but the sale is ${usd(newGrossCents)} once the ` +
          `${usd(donationCents)} gift comes off. A breakdown that doesn't add up is a guess.`,
      });
    }
    items = args.items;
    // The SAME top rung `sales.setSaleItems` writes, and for the same reason: a
    // human deliberately overruling the sync's reading of a payload. Being
    // unoutrankable is what stops a later enrichment run writing the FULL
    // charge's basket onto a row whose `grossCents` is only the merch half.
    // See `lib/salesItems.ts`.
    itemSource = "manual";
  } else {
    const existing = itemsTotal(sale.items);
    if (existing !== 0 && existing !== newGrossCents) {
      throw new ConvexError({
        code: "ITEMS_CONTRADICT_SPLIT",
        message:
          `This sale's items come to ${usd(existing)}, which can't be right once ${usd(donationCents)} ` +
          `of it is a gift — the sale would be ${usd(newGrossCents)}. Say what the merch half was.`,
      });
    }
  }

  // ── The gift, through the helpers and nothing else ───────────────────────
  // `matchOrCreateDonor` dedups by lowercased email, then exact phone, then
  // EXACT name, and creates when none of the three hits. The SAME lookup is
  // run first, purely so the caller can be TOLD which happened: the exact-name
  // fallback is the failure mode worth surfacing, because "Jordanella Maluka"
  // does not match "Jordanella Maluka Chagiye" and the silent outcome is a
  // second donor record with half of a real person's giving history in it.
  // Read-only and index-backed, so it costs one lookup to make that visible.
  const scope = sale.chapterId;
  const priorDonor = await findDonorInScope(ctx, scope, {
    ...(args.donorEmail ? { email: args.donorEmail } : {}),
    ...(args.donorPhone ? { phone: args.donorPhone } : {}),
    name,
  });
  const donorId = await matchOrCreateDonor(ctx, {
    scope,
    name,
    ...(args.donorEmail ? { email: args.donorEmail } : {}),
    ...(args.donorPhone ? { phone: args.donorPhone } : {}),
    source: "manual",
  });
  const donor = (await ctx.db.get(donorId))!;
  const donorExisted = priorDonor !== null;

  const giftId = await recordGiftForDonor(ctx, {
    donorId,
    amountCents: donationCents,
    // The DAY THE CARD WAS TAPPED, not the day someone got round to
    // splitting it. The gift happened when the payment happened; dating it
    // today would move it into the wrong month for every giving report and
    // would make the donor's `lastGiftAt` lie.
    receivedAt: sale.soldAt,
    method: giftMethodForSale(sale),
    // Only when the sale itself is attributed to an event — this bumps that
    // event's "Given" total (`recordGiftForDonor`'s guarded event rollup), and
    // `removeGiftRow` reverses exactly that bump on undo.
    ...(sale.eventId ? { eventId: sale.eventId } : {}),
    externalRef: giftRefForSale(sale._id),
    note:
      args.note?.trim() ||
      `Bundled gift split out of a ${usd(sale.grossCents)} in-person payment ` +
        `(${usd(newGrossCents)} of merch + ${usd(donationCents)} given).`,
  });

  const now = Date.now();
  await ctx.db.patch(sale._id, {
    grossCents: newGrossCents,
    donationCents,
    donationGiftId: giftId,
    ...(args.splitByPersonId ? { donationSplitBy: args.splitByPersonId } : {}),
    donationSplitAt: now,
    items,
    itemSource,
  });

  return {
    donorId,
    giftId,
    donorExisted,
    donorName: donor.name,
    saleGrossCents: newGrossCents,
    donationCents,
    chargeCents: newGrossCents + donationCents,
  };
}

/**
 * Record that part of an in-person payment was a gift. The deliverable of this
 * module: a human looking at a $50 sale can say "$30 of this was a tee, $20 was
 * a gift from X" and have the books agree.
 *
 * Gated at `bookkeeper` through `requireFinanceRole` — the same floor
 * `finances.ts#markAsRefund` reclassifies a transaction pair at, and for the
 * same reason: this moves money between streams without changing the total, so
 * it is bookkeeping rather than approval. Never checked inline, so raising the
 * bar later is one constant.
 */
export const splitBundledDonation = mutation({
  args: {
    saleId: v.id("sales"),
    /** The gift half, in integer cents. Comes OFF `grossCents`; the payment
     *  itself is untouched, because the payment already happened. */
    donationCents: v.number(),
    /** Who gave it. Matched against existing donors by email, then phone, then
     *  EXACT name — pass an email whenever one is known, because the name
     *  fallback is exact-string and "Jordanella Maluka" would not find
     *  "Jordanella Maluka Chagiye", it would create a second her. */
    donorName: v.string(),
    donorEmail: v.optional(v.string()),
    donorPhone: v.optional(v.string()),
    /** What the MERCH half was, if the splitter knows. Must sum to the sale's
     *  remaining gross — a breakdown that doesn't add up is refused rather than
     *  rounded. Omit to leave the existing breakdown alone. */
    items: v.optional(v.array(itemInput)),
    /** Why, in the splitter's words. Lands on the gift, where it survives. */
    note: v.optional(v.string()),
  },
  returns: v.object({
    donorId: v.id("donors"),
    giftId: v.id("gifts"),
    /** Whether an EXISTING donor took the gift. False means a new donor record
     *  was created — worth surfacing, because a split that quietly mints a
     *  duplicate donor splits someone's giving history in half. */
    donorExisted: v.boolean(),
    donorName: v.string(),
    /** The merch half after the split. */
    saleGrossCents: v.number(),
    donationCents: v.number(),
    /** The two together — unchanged, and equal to what the card was charged. */
    chargeCents: v.number(),
  }),
  handler: async (ctx, args) => {
    const sale = await ctx.db.get(args.saleId);
    if (!sale) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That sale doesn't exist." });
    }
    const access = await requireFinanceRole(ctx, sale.chapterId, SPLIT_MIN_ROLE);
    return applyBundledDonationSplit(ctx, { ...args, splitByPersonId: access.personId });
  },
});

/**
 * Put a split back. The inverse of `splitBundledDonation`, and the reason a
 * mis-split is a correction rather than a scar: the gift leaves through
 * `removeGiftRow` (reversing the donor's lifetime and count, their derived
 * status, the scope aggregates, the identity rollup, the launch-fund pot and
 * the event's Given total), and the sale's gross goes back up by the same
 * amount. Book value is unchanged again, in the other direction.
 *
 * IT REFUSES ON DISAGREEMENT. A split gift is an ordinary editable row on the
 * gifts desk — `isSystemWrittenGift` doesn't cover it, deliberately, since it is
 * a human's entry rather than a rail's — so someone may have changed its amount
 * or moved its scope since. Restoring the sale by `sale.donationCents` while the
 * gift is worth something else would move book value by the difference, which is
 * the one thing this whole area is not allowed to do. So the two are compared
 * first and a mismatch stops the undo with the numbers in the message, rather
 * than picking one to believe.
 */
export const undoBundledDonationSplit = mutation({
  args: { saleId: v.id("sales") },
  returns: v.object({
    saleGrossCents: v.number(),
    restoredCents: v.number(),
    /** False when the gift row was already gone (removed from the gifts desk).
     *  The undo still restores the sale — the money has to live somewhere, and
     *  with the gift gone the sale is the only place left. */
    giftRemoved: v.boolean(),
  }),
  handler: async (ctx, { saleId }) => {
    const sale = await ctx.db.get(saleId);
    if (!sale) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That sale doesn't exist." });
    }
    await requireFinanceRole(ctx, sale.chapterId, SPLIT_MIN_ROLE);

    const donationCents = sale.donationCents;
    if (donationCents === undefined || donationCents <= 0) {
      throw new ConvexError({
        code: "NOT_SPLIT",
        message: "This payment doesn't carry a bundled gift, so there's nothing to undo.",
      });
    }

    let giftRemoved = false;
    if (sale.donationGiftId) {
      const gift = await ctx.db.get(sale.donationGiftId);
      if (gift) {
        if (gift.amountCents !== donationCents) {
          throw new ConvexError({
            code: "GIFT_CHANGED",
            message:
              `The gift is now ${usd(gift.amountCents)} but this sale has ${usd(donationCents)} ` +
              `split off it. Someone edited one of them. Reconcile the two by hand — undoing ` +
              `now would move book value by ${usd(Math.abs(gift.amountCents - donationCents))}.`,
          });
        }
        if (gift.scope !== sale.chapterId) {
          throw new ConvexError({
            code: "GIFT_MOVED",
            message:
              `The gift has been moved to another book since the split. Move it back before ` +
              `undoing, or the two halves of this payment will land on different books.`,
          });
        }
        await removeGiftRow(ctx, gift._id);
        giftRemoved = true;
      }
    }

    const restoredGross = sale.grossCents + donationCents;
    // The breakdown described the MERCH HALF. With the gift folded back in it
    // no longer adds up, and there is nothing honest to replace it with — the
    // payment is back to being an amount nobody has explained. Clear it to
    // `unresolved`, which also hands the row back to the nightly sync: with
    // `manual` gone from `itemSource`, Stripe's own evidence can outrank a
    // blank again and re-enrich it.
    const keepItems = itemsTotal(sale.items) === restoredGross;
    await ctx.db.patch(saleId, {
      grossCents: restoredGross,
      donationCents: undefined,
      donationGiftId: undefined,
      donationSplitBy: undefined,
      donationSplitAt: undefined,
      ...(keepItems ? {} : { items: [], itemSource: "unresolved" as const }),
    });

    return { saleGrossCents: restoredGross, restoredCents: donationCents, giftRemoved };
  },
});
