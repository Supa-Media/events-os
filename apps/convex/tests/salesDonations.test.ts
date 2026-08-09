/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { recordGiftForDonor } from "../lib/givingDonors";

/**
 * Splitting a bundled gift out of an in-person sale.
 *
 * Four things this suite exists to hold still, in descending order of how
 * expensive they would be to get wrong:
 *
 *  1. TOTAL REVENUE DOES NOT MOVE. A split takes money off one stream and puts
 *     the same money on another, so the org is neither richer nor poorer
 *     afterwards. Asserted through the REAL `accountBalances` query — the number
 *     the owner is actually reading on /finances/accounts — rather than a
 *     re-implementation of the model here, which could agree with the mutation
 *     while both disagree with the page.
 *  2. THE GIFT LANDS ON THE PERSON WHO ALREADY EXISTS. `matchOrCreateDonor`'s
 *     last resort is an EXACT name match, so a near-miss silently creates a
 *     second donor and cuts a real person's giving history in half. The email
 *     path is what prevents it, and that is tested with the exact pair of names
 *     that provoked it in production.
 *  3. IT IS REVERSIBLE, AND THE GIFT GOES BACK OUT THROUGH `removeGiftRow`.
 *     Undo must return every rollup — donor lifetime, gift count, scope
 *     aggregate — to where it started, not merely delete a row.
 *  4. IT REFUSES RATHER THAN GUESSES. A gift bigger than the sale, a breakdown
 *     that doesn't add up, a second split, an edited gift on undo: each stops
 *     with nothing written.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const CHARGE_CENTS = 5_000;
const FEE_CENTS = 200;
const TEE_CENTS = 3_000;
const GIFT_CENTS = 2_000;
const SOLD_AT = Date.UTC(2026, 7, 8, 18, 10, 6);

/** Her record as production holds it — the third name is the point. */
const DONOR_NAME = "Jordanella Maluka Chagiye";
const DONOR_EMAIL = "jordanellamaluka@hotmail.com";
/** What the owner called her. Two parts, not three. */
const OWNER_NAME = "Jordanella Maluka";
/** $150 across 2 gifts. */
const PRIOR_GIFTS = [5_000, 10_000] as const;
const PRIOR_LIFETIME = PRIOR_GIFTS.reduce((a, b) => a + b, 0);

const TEE_ITEM = {
  label: "PW Tee",
  quantity: 1,
  unitPriceCents: TEE_CENTS,
  candidates: ["PW Tee"],
};

type Seeded = ChapterSetup & {
  saleId: Id<"sales">;
  donorId: Id<"donors">;
};

type SeedOpts = {
  /** Give the sale an item breakdown describing the FULL charge. */
  itemsForWholeCharge?: boolean;
  /** Seed no donor at all (the "a split would create one" case). */
  noDonor?: boolean;
  /** Attribute the sale to an event, so the gift bumps that event's Given. */
  eventId?: Id<"events">;
};

/**
 * New York, one $50 card-present sale, and Jordanella's existing donor record
 * with her two real gifts. The gifts go in through `recordGiftForDonor` so every
 * rollup starts where production has it rather than where a hand-written fixture
 * guesses.
 */
async function seed(opts: SeedOpts = {}): Promise<Seeded> {
  const t = newT();
  const s = await setupChapter(t);
  await grantFinance(s, "manager");

  const ids = await run(t, async (ctx) => {
    const saleId = await ctx.db.insert("sales", {
      chapterId: s.chapterId,
      stripeChargeId: "ch_3U2EgzQv9S5xW6eK00dIIcJ9",
      soldAt: SOLD_AT,
      grossCents: CHARGE_CENTS,
      feeCents: FEE_CENTS,
      items: opts.itemsForWholeCharge
        ? [{ label: "$50 item", quantity: 1, unitPriceCents: CHARGE_CENTS, candidates: ["Hoodie"] }]
        : [],
      itemSource: opts.itemsForWholeCharge ? "amount_decomposition" : "unresolved",
      channel: "in_person",
      createdAt: Date.now(),
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
    });
    let donorId = "" as Id<"donors">;
    if (!opts.noDonor) {
      donorId = await ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: DONOR_NAME,
        email: DONOR_EMAIL,
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        source: "givebutter-import",
        createdAt: Date.now(),
      });
    }
    return { saleId, donorId };
  });

  if (!opts.noDonor) {
    for (const cents of PRIOR_GIFTS) {
      await run(t, (ctx) =>
        recordGiftForDonor(ctx, {
          donorId: ids.donorId,
          amountCents: cents,
          receivedAt: SOLD_AT - 90 * 86_400_000,
          method: "givebutter",
        }),
      );
    }
  }
  return { ...s, ...ids };
}

/** Central ED + a graded finance role — the same pair `accountBalances` and
 *  `requireFinanceRole` are gated on (mirrors ptbVenmoBackfill.test.ts). */
async function grantFinance(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, async (ctx) => {
    await ctx.db.insert("specializedRoles", {
      personId,
      title: "executive_director",
      roleKind: "leadership",
      scope: "central",
      createdAt: Date.now(),
    });
    await ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "central",
      createdAt: Date.now(),
    });
  });
}

/** New York's book value, straight out of the query the accounts page reads. */
async function bookValue(s: ChapterSetup): Promise<number> {
  const balances = await s.as.query(api.reconciliation.accountBalances, {});
  return balances.find((b) => b.scope === s.chapterId)!.bookBalanceCents;
}

const saleRow = (s: Seeded) => run(s.t, (ctx) => ctx.db.get(s.saleId));
const donorRow = (s: Seeded) => run(s.t, (ctx) => ctx.db.get(s.donorId));
const allGifts = (s: Seeded) => run(s.t, (ctx) => ctx.db.query("gifts").collect());
const allDonors = (s: Seeded) => run(s.t, (ctx) => ctx.db.query("donors").collect());

function split(s: Seeded, over: Record<string, unknown> = {}) {
  return s.as.mutation(api.salesDonations.splitBundledDonation, {
    saleId: s.saleId,
    donationCents: GIFT_CENTS,
    donorName: DONOR_NAME,
    donorEmail: DONOR_EMAIL,
    items: [TEE_ITEM],
    ...over,
  } as Parameters<typeof s.as.mutation>[1]);
}

// ── The money ───────────────────────────────────────────────────────────────

describe("splitBundledDonation — the money", () => {
  test("$50 becomes $30 of sale and $20 of gift, and book value does not move", async () => {
    const s = await seed();
    const before = await bookValue(s);
    expect(before).toBe(CHARGE_CENTS + PRIOR_LIFETIME);

    const res = await split(s);
    const after = await bookValue(s);

    // THE ASSERTION THIS SUITE EXISTS FOR.
    expect(after).toBe(before);
    expect(res.saleGrossCents).toBe(TEE_CENTS);
    expect(res.donationCents).toBe(GIFT_CENTS);
    expect(res.chargeCents).toBe(CHARGE_CENTS);

    const sale = (await saleRow(s))!;
    expect(sale.grossCents).toBe(TEE_CENTS);
    expect(sale.donationCents).toBe(GIFT_CENTS);
    expect(sale.grossCents + sale.donationCents!).toBe(CHARGE_CENTS);
  });

  test("the fee is not divided — all $2.00 stays on the payment", async () => {
    // One fee, stated by Stripe for the whole charge and never for a half. It
    // moves no total (fees are their own expense via processorFees.ts), so the
    // only wrong answer here is a derived one.
    const s = await seed();
    await split(s);
    expect((await saleRow(s))!.feeCents).toBe(FEE_CENTS);
  });

  test("the gift is dated to the tap, not to the day of the split", async () => {
    const s = await seed();
    const res = await split(s);
    const gift = (await run(s.t, (ctx) => ctx.db.get(res.giftId)))!;
    expect(gift.receivedAt).toBe(SOLD_AT);
    expect(gift.amountCents).toBe(GIFT_CENTS);
    // Card-present Stripe money, so the giving ledger says so.
    expect(gift.method).toBe("stripe");
    expect(gift.externalRef).toBe(`sale:${s.saleId}:donation`);
  });

  test("the merch half's items must add up to the merch half", async () => {
    const s = await seed();
    await split(s);
    const sale = (await saleRow(s))!;
    const stated = sale.items.reduce((a, i) => a + i.quantity * i.unitPriceCents, 0);
    expect(stated).toBe(sale.grossCents);
    // Top of the evidence ladder: a person said so, and no sync may outrank it.
    expect(sale.itemSource).toBe("manual");
  });
});

// ── The donor ───────────────────────────────────────────────────────────────

describe("splitBundledDonation — whose gift it is", () => {
  test("it lands on the donor who already exists, by email", async () => {
    const s = await seed();
    const res = await split(s);

    expect(res.donorExisted).toBe(true);
    expect(res.donorId).toBe(s.donorId);
    expect(res.donorName).toBe(DONOR_NAME);

    const donor = (await donorRow(s))!;
    expect(donor.lifetimeCents).toBe(PRIOR_LIFETIME + GIFT_CENTS);
    expect(donor.giftCount).toBe(PRIOR_GIFTS.length + 1);
    // One person, one record.
    expect(await allDonors(s)).toHaveLength(1);
  });

  test("the owner's two-part name finds her too — BECAUSE the email is passed", async () => {
    // The production trap, exactly. "Jordanella Maluka" is not
    // "Jordanella Maluka Chagiye", and `matchOrCreateDonor`'s name fallback is
    // an exact string compare. The email is the primary dedup key and hits
    // first, so the wrong name is harmless as long as the email is there.
    const s = await seed();
    const res = await split(s, { donorName: OWNER_NAME, donorEmail: DONOR_EMAIL });

    expect(res.donorExisted).toBe(true);
    expect(res.donorId).toBe(s.donorId);
    expect(await allDonors(s)).toHaveLength(1);
    // Her record keeps its own name — a match never renames the row it found.
    expect((await donorRow(s))!.name).toBe(DONOR_NAME);
  });

  test("without the email, the two-part name mints a SECOND her — and says so", async () => {
    // This is why the migration passes the email and the record's own name. The
    // mutation does not refuse it (a genuinely new giver is a legitimate case),
    // but `donorExisted: false` is the signal a caller must not ignore.
    const s = await seed();
    const res = await split(s, { donorName: OWNER_NAME, donorEmail: undefined });

    expect(res.donorExisted).toBe(false);
    expect(res.donorId).not.toBe(s.donorId);
    expect(await allDonors(s)).toHaveLength(2);
    // Book value is still right — the money landed, just on a duplicate.
    expect(await bookValue(s)).toBe(CHARGE_CENTS + PRIOR_LIFETIME);
  });

  test("a sale attributed to an event bumps that event's Given total", async () => {
    const s0 = await seed();
    const eventId = await run(s0.t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s0.chapterId,
        name: "Field Day",
        slug: "field-day",
        version: 1,
        createdBy: s0.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("events", {
        chapterId: s0.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Field Day",
        eventDate: SOLD_AT,
        status: "completed",
        createdBy: s0.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const pageId = await run(s0.t, (ctx) =>
      ctx.db.insert("eventPages", {
        eventId,
        chapterId: s0.chapterId,
        slug: "field-day",
        published: true,
        goingCount: 0,
        maybeCount: 0,
        notGoingCount: 0,
        ticketsSoldCount: 0,
        revenueCents: 0,
        createdBy: s0.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s0.t, (ctx) => ctx.db.patch(s0.saleId, { eventId }));

    await split(s0);
    const page = (await run(s0.t, (ctx) => ctx.db.get(pageId)))!;
    expect(page.externalGiftsCents).toBe(GIFT_CENTS);
    expect(page.externalGiftsCount).toBe(1);

    // …and undo takes it back off, which is the reason the gift leaves through
    // `removeGiftRow` rather than `ctx.db.delete`.
    await s0.as.mutation(api.salesDonations.undoBundledDonationSplit, { saleId: s0.saleId });
    const after = (await run(s0.t, (ctx) => ctx.db.get(pageId)))!;
    expect(after.externalGiftsCents).toBe(0);
    expect(after.externalGiftsCount).toBe(0);
  });
});

// ── Undo ────────────────────────────────────────────────────────────────────

describe("undoBundledDonationSplit", () => {
  test("it puts every rollup back exactly where it started", async () => {
    const s = await seed();
    const before = await bookValue(s);
    const donorBefore = (await donorRow(s))!;

    await split(s);
    const res = await s.as.mutation(api.salesDonations.undoBundledDonationSplit, {
      saleId: s.saleId,
    });

    expect(res.giftRemoved).toBe(true);
    expect(res.restoredCents).toBe(GIFT_CENTS);
    expect(res.saleGrossCents).toBe(CHARGE_CENTS);
    expect(await bookValue(s)).toBe(before);

    const donorAfter = (await donorRow(s))!;
    expect(donorAfter.lifetimeCents).toBe(donorBefore.lifetimeCents);
    expect(donorAfter.giftCount).toBe(donorBefore.giftCount);
    expect(donorAfter.status).toBe(donorBefore.status);
    // The gift row is gone, not zeroed — her other two survive untouched.
    expect(await allGifts(s)).toHaveLength(PRIOR_GIFTS.length);

    const sale = (await saleRow(s))!;
    expect(sale.donationCents).toBeUndefined();
    expect(sale.donationGiftId).toBeUndefined();
    expect(sale.donationSplitBy).toBeUndefined();
    expect(sale.donationSplitAt).toBeUndefined();
    // The breakdown described the merch half and no longer adds up; the row goes
    // back to being an amount nobody has explained, which hands it to the sync.
    expect(sale.items).toEqual([]);
    expect(sale.itemSource).toBe("unresolved");
  });

  test("split → undo → split again is legal and lands in the same place", async () => {
    const s = await seed();
    await split(s);
    await s.as.mutation(api.salesDonations.undoBundledDonationSplit, { saleId: s.saleId });
    const again = await split(s);

    expect(again.donorId).toBe(s.donorId);
    expect(await bookValue(s)).toBe(CHARGE_CENTS + PRIOR_LIFETIME);
    expect((await donorRow(s))!.giftCount).toBe(PRIOR_GIFTS.length + 1);
  });

  test("it refuses when someone has edited the gift since", async () => {
    // Restoring the sale by `donationCents` while the gift is worth something
    // else would move book value by the difference — the one thing this area is
    // not allowed to do.
    const s = await seed();
    const res = await split(s);
    await run(s.t, (ctx) => ctx.db.patch(res.giftId, { amountCents: 2_500 }));

    await expect(
      s.as.mutation(api.salesDonations.undoBundledDonationSplit, { saleId: s.saleId }),
    ).rejects.toThrow(/GIFT_CHANGED|edited/i);

    // Nothing written: the sale is still split.
    expect((await saleRow(s))!.donationCents).toBe(GIFT_CENTS);
  });

  test("an unsplit sale has nothing to undo", async () => {
    const s = await seed();
    await expect(
      s.as.mutation(api.salesDonations.undoBundledDonationSplit, { saleId: s.saleId }),
    ).rejects.toThrow(/NOT_SPLIT|bundled gift/i);
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe("splitBundledDonation — it refuses rather than guesses", () => {
  test("a gift that swallows the whole payment is not a sale", async () => {
    const s = await seed();
    await expect(split(s, { donationCents: CHARGE_CENTS, items: undefined })).rejects.toThrow(
      /GIFT_EXCEEDS_SALE|leave something behind/i,
    );
    expect((await saleRow(s))!.grossCents).toBe(CHARGE_CENTS);
  });

  test("a breakdown that doesn't add up is refused, not rounded", async () => {
    const s = await seed();
    await expect(
      split(s, { items: [{ ...TEE_ITEM, unitPriceCents: 2_500 }] }),
    ).rejects.toThrow(/ITEMS_DONT_ADD_UP|add up/i);
    expect(await allGifts(s)).toHaveLength(PRIOR_GIFTS.length);
  });

  test("existing items that describe the whole charge stop a silent split", async () => {
    // The row already claims a $50 basket. Taking $20 off the gross without
    // saying what the remaining $30 was would leave items and gross
    // contradicting each other, so it asks rather than picking one.
    const s = await seed({ itemsForWholeCharge: true });
    await expect(split(s, { items: undefined })).rejects.toThrow(
      /ITEMS_CONTRADICT_SPLIT|can't be right/i,
    );
  });

  test("splitting twice is refused", async () => {
    const s = await seed();
    await split(s);
    await expect(split(s, { items: undefined })).rejects.toThrow(/ALREADY_SPLIT/i);
    expect((await saleRow(s))!.grossCents).toBe(TEE_CENTS);
  });

  test("cents must be whole and positive", async () => {
    const s = await seed();
    await expect(split(s, { donationCents: 0 })).rejects.toThrow(/INVALID_AMOUNT/i);
    await expect(split(s, { donationCents: 20.5 })).rejects.toThrow(/INVALID_AMOUNT/i);
  });

  test("a gift needs a giver", async () => {
    const s = await seed();
    await expect(split(s, { donorName: "   " })).rejects.toThrow(/INVALID_INPUT|giver/i);
  });
});

// ── The gate ────────────────────────────────────────────────────────────────

describe("splitBundledDonation — who may do it", () => {
  test("a viewer may not split a payment", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinance(s, "viewer");
    const saleId = await run(t, (ctx) =>
      ctx.db.insert("sales", {
        chapterId: s.chapterId,
        stripeChargeId: "ch_viewer",
        soldAt: SOLD_AT,
        grossCents: CHARGE_CENTS,
        feeCents: FEE_CENTS,
        items: [],
        itemSource: "unresolved",
        channel: "in_person",
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.salesDonations.splitBundledDonation, {
        saleId,
        donationCents: GIFT_CENTS,
        donorName: DONOR_NAME,
        donorEmail: DONOR_EMAIL,
        items: [TEE_ITEM],
      }),
    ).rejects.toThrow(/FORBIDDEN|finance role/i);
  });

  test("a bookkeeper may — that is the documented floor", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinance(s, "bookkeeper");
    const saleId = await run(t, (ctx) =>
      ctx.db.insert("sales", {
        chapterId: s.chapterId,
        stripeChargeId: "ch_bookkeeper",
        soldAt: SOLD_AT,
        grossCents: CHARGE_CENTS,
        feeCents: FEE_CENTS,
        items: [],
        itemSource: "unresolved",
        channel: "in_person",
        createdAt: Date.now(),
      }),
    );
    const res = await s.as.mutation(api.salesDonations.splitBundledDonation, {
      saleId,
      donationCents: GIFT_CENTS,
      donorName: DONOR_NAME,
      donorEmail: DONOR_EMAIL,
      items: [TEE_ITEM],
    });
    expect(res.saleGrossCents).toBe(TEE_CENTS);
    // And the split carries its author.
    const sale = (await run(t, (ctx) => ctx.db.get(saleId)))!;
    expect(sale.donationSplitBy).toBeDefined();
    expect(sale.donationSplitAt).toBeGreaterThan(0);
  });
});
