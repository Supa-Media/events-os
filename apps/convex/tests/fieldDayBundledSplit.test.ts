/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "../lib/seed/historical/mapping";
import { recordGiftForDonor } from "../lib/givingDonors";
import {
  CHARGE_CENTS,
  CHARGE_FEE_CENTS,
  DONATION_CENTS,
  EXPECTED_BOOK_VALUE_DELTA_CENTS,
  EXPECTED_DONOR_EMAIL,
  EXPECTED_DONOR_GIFT_COUNT,
  EXPECTED_DONOR_LIFETIME_CENTS,
  EXPECTED_DONOR_NAME,
  OWNER_SUPPLIED_NAME,
  SALE_CENTS,
  SOLD_AT_MS,
  STRIPE_CHARGE_ID,
  TEE_ITEM,
  TEE_UNIT_CENTS,
  reconciles,
} from "../lib/seed/historical/fieldDayBundled2026";

/**
 * The 2026-08-08 Field Day bundled-donation correction.
 *
 * Three things this suite exists to hold still:
 *
 *  1. BOOK VALUE DOES NOT MOVE. $20 of merch revenue becomes $20 of giving on
 *     the same book, so the org is neither richer nor poorer afterwards.
 *     Asserted through the REAL `accountBalances` query rather than a
 *     re-implementation of the model, because a re-implementation could agree
 *     with the runner while both disagree with the page the owner reads.
 *  2. JORDANELLA IS NOT DUPLICATED. The record reads "Jordanella Maluka
 *     Chagiye"; the owner said "Jordanella Maluka". The correction must land on
 *     the record that exists, and must REFUSE outright if it cannot find it —
 *     creating a second her is the specific harm here, and it is silent.
 *  3. NOTHING IS WRITTEN ON A PATTERN. Every fact the correction depends on is
 *     re-verified against the live row first, and any disagreement stops the run
 *     with nothing written.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

type Seeded = ChapterSetup & { saleId: Id<"sales">; donorId: Id<"donors"> };

type SeedOpts = {
  /** Move the payment's amount (the "row disagrees" case). */
  grossCents?: number;
  /** Give the sale an item breakdown it didn't have. */
  resolved?: boolean;
  /** Seed no donor (the "would create a second her" case). */
  noDonor?: boolean;
  /** Rename the donor record out from under the module. */
  donorName?: string;
  /** Skip the sale entirely. */
  noSale?: boolean;
};

async function seed(opts: SeedOpts = {}): Promise<Seeded> {
  const t = newT();
  const s = await setupChapter(t);

  const personId = await run(t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(t, async (ctx) => {
    await ctx.db.patch(s.chapterId, { slug: NEW_YORK_CHAPTER_SLUG });
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
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    });
  });

  const ids = await run(t, async (ctx) => {
    let saleId = "" as Id<"sales">;
    if (!opts.noSale) {
      saleId = await ctx.db.insert("sales", {
        chapterId: s.chapterId,
        stripeChargeId: STRIPE_CHARGE_ID,
        soldAt: SOLD_AT_MS,
        grossCents: opts.grossCents ?? CHARGE_CENTS,
        feeCents: CHARGE_FEE_CENTS,
        items: opts.resolved
          ? [{ label: "Hoodie", quantity: 1, unitPriceCents: CHARGE_CENTS, candidates: ["Hoodie"] }]
          : [],
        itemSource: opts.resolved ? "charge_description" : "unresolved",
        channel: "in_person",
        createdAt: Date.now(),
      });
    }
    let donorId = "" as Id<"donors">;
    if (!opts.noDonor) {
      donorId = await ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: opts.donorName ?? EXPECTED_DONOR_NAME,
        email: EXPECTED_DONOR_EMAIL,
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        source: "givebutter-import",
        createdAt: Date.now(),
      });
    }
    return { saleId, donorId };
  });

  // Her two real gifts, through the shared write path so the rollups start where
  // production has them. $50 + $100 = the $150 lifetime the module expects.
  if (!opts.noDonor) {
    for (const cents of [5_000, 10_000]) {
      await run(t, (ctx) =>
        recordGiftForDonor(ctx, {
          donorId: ids.donorId,
          amountCents: cents,
          receivedAt: SOLD_AT_MS - 200 * 86_400_000,
          method: "givebutter",
        }),
      );
    }
  }
  return { ...s, ...ids };
}

function runner(s: Seeded, execute: boolean) {
  return s.t.mutation(internal.fieldDayBundledSplit.runFieldDayBundledSplit, {
    recordedBy: s.userId,
    execute,
  });
}

async function bookValue(s: ChapterSetup): Promise<number> {
  const balances = await s.as.query(api.reconciliation.accountBalances, {});
  return balances.find((b) => b.scope === s.chapterId)!.bookBalanceCents;
}

const saleRow = (s: Seeded) => run(s.t, (ctx) => ctx.db.get(s.saleId));
const allDonors = (s: Seeded) => run(s.t, (ctx) => ctx.db.query("donors").collect());
const allGifts = (s: Seeded) => run(s.t, (ctx) => ctx.db.query("gifts").collect());

// ── The data module, no database needed ─────────────────────────────────────

describe("fieldDayBundled2026 — the split is the payment", () => {
  test("$30 of tee plus $20 of gift is the $50 that was charged, exactly", () => {
    expect(CHARGE_CENTS).toBe(5_000);
    expect(SALE_CENTS).toBe(3_000);
    expect(DONATION_CENTS).toBe(2_000);
    expect(SALE_CENTS + DONATION_CENTS).toBe(CHARGE_CENTS);
    expect(reconciles()).toBe(true);
  });

  test("the merch half is one tee at the price Stripe charged that day", () => {
    // $30 is not a guess about what a tee costs — it is what Stripe billed four
    // other people for the same Price object hours either side of this tap.
    expect(TEE_UNIT_CENTS).toBe(3_000);
    expect(TEE_ITEM.quantity * TEE_ITEM.unitPriceCents).toBe(SALE_CENTS);
    expect(TEE_ITEM.candidates).toEqual(["PW Tee"]);
    // One candidate — this is not a price point several products share.
    expect(TEE_ITEM.candidates).toHaveLength(1);
  });

  test("the donor's third name is recorded, and the owner's version is not used", () => {
    expect(EXPECTED_DONOR_NAME).toBe("Jordanella Maluka Chagiye");
    expect(OWNER_SUPPLIED_NAME).toBe("Jordanella Maluka");
    // The gap this module exists to navigate: an exact-name match would miss.
    expect(EXPECTED_DONOR_NAME).not.toBe(OWNER_SUPPLIED_NAME);
    expect(EXPECTED_DONOR_EMAIL).toContain("@");
  });

  test("the expected book-value move is zero, by construction", () => {
    expect(EXPECTED_BOOK_VALUE_DELTA_CENTS).toBe(0);
    expect(SALE_CENTS - CHARGE_CENTS + DONATION_CENTS).toBe(
      EXPECTED_BOOK_VALUE_DELTA_CENTS,
    );
  });
});

// ── The runner, against a database ──────────────────────────────────────────

describe("runFieldDayBundledSplit", () => {
  test("a dry run reports the whole split and writes nothing", async () => {
    const s = await seed();
    const before = await bookValue(s);
    const res = await runner(s, false);

    expect(res.dryRun).toBe(true);
    expect(res.proceeded).toBe(true);
    expect(res.saleFound).toBe(true);
    expect(res.chargeCentsBefore).toBe(CHARGE_CENTS);
    expect(res.chargeCentsAfter).toBe(CHARGE_CENTS);
    expect(res.saleGrossCentsAfter).toBe(SALE_CENTS);
    expect(res.donationCents).toBe(DONATION_CENTS);
    expect(res.feeCents).toBe(CHARGE_FEE_CENTS);
    expect(res.bookValueDeltaCents).toBe(EXPECTED_BOOK_VALUE_DELTA_CENTS);
    expect(res.donor).toMatchObject({
      name: EXPECTED_DONOR_NAME,
      email: EXPECTED_DONOR_EMAIL,
      matchedExisting: true,
      lifetimeCentsBefore: EXPECTED_DONOR_LIFETIME_CENTS,
      lifetimeCentsAfter: EXPECTED_DONOR_LIFETIME_CENTS + DONATION_CENTS,
      giftCountBefore: EXPECTED_DONOR_GIFT_COUNT,
      giftCountAfter: EXPECTED_DONOR_GIFT_COUNT + 1,
    });

    // Nothing moved.
    expect((await saleRow(s))!.grossCents).toBe(CHARGE_CENTS);
    expect((await saleRow(s))!.donationCents).toBeUndefined();
    expect(await allGifts(s)).toHaveLength(EXPECTED_DONOR_GIFT_COUNT);
    expect(await bookValue(s)).toBe(before);
  });

  test("the judgement behind the split is disclosed on every run", async () => {
    // The $30/$20 rests on the owner's account plus Stripe's own pricing of that
    // day's other charges; the identity of the giver rests on the owner alone.
    // A judgement nobody can see is one nobody can revisit.
    const s = await seed();
    const res = await runner(s, false);
    const all = res.problems.join(" ");
    expect(all).toContain(EXPECTED_DONOR_NAME);
    expect(all).toContain(OWNER_SUPPLIED_NAME);
    expect(all).toContain("undo");
  });

  test("an executed run moves $20 from sales to giving and nothing else", async () => {
    const s = await seed();
    const before = await bookValue(s);
    expect(before).toBe(CHARGE_CENTS + EXPECTED_DONOR_LIFETIME_CENTS);

    const res = await runner(s, true);
    const after = await bookValue(s);

    // THE ASSERTION THIS SUITE EXISTS FOR — through the query the owner reads.
    expect(after).toBe(before);
    expect(res.dryRun).toBe(false);
    expect(res.proceeded).toBe(true);

    const sale = (await saleRow(s))!;
    expect(sale.grossCents).toBe(SALE_CENTS);
    expect(sale.donationCents).toBe(DONATION_CENTS);
    expect(sale.grossCents + sale.donationCents!).toBe(CHARGE_CENTS);
    // The fee is untouched and whole.
    expect(sale.feeCents).toBe(CHARGE_FEE_CENTS);
    // The merch half now says what it was, at the top of the evidence ladder.
    expect(sale.itemSource).toBe("manual");
    expect(sale.items).toEqual([TEE_ITEM]);
    expect(sale.donationSplitBy).toBeDefined();

    // She got the gift, and there is still exactly one of her.
    const donors = await allDonors(s);
    expect(donors).toHaveLength(1);
    expect(donors[0]._id).toBe(s.donorId);
    expect(donors[0].lifetimeCents).toBe(EXPECTED_DONOR_LIFETIME_CENTS + DONATION_CENTS);
    expect(donors[0].giftCount).toBe(EXPECTED_DONOR_GIFT_COUNT + 1);

    const gifts = await allGifts(s);
    expect(gifts).toHaveLength(EXPECTED_DONOR_GIFT_COUNT + 1);
    const added = gifts.find((g) => g.amountCents === DONATION_CENTS)!;
    expect(added.receivedAt).toBe(SOLD_AT_MS);
    expect(added.method).toBe("stripe");
    expect(added.note).toContain("Field Day");
  });

  test("a second run is a no-op with positive proof, not an assumption", async () => {
    const s = await seed();
    await runner(s, true);
    const after = await bookValue(s);

    const second = await runner(s, true);
    expect(second.proceeded).toBe(true);
    expect(second.donationCents).toBe(DONATION_CENTS);
    expect(second.bookValueDeltaCents).toBe(0);

    // Nothing doubled.
    expect(await bookValue(s)).toBe(after);
    expect(await allGifts(s)).toHaveLength(EXPECTED_DONOR_GIFT_COUNT + 1);
    expect((await saleRow(s))!.grossCents).toBe(SALE_CENTS);
  });

  test("the correction is undoable through the live path", async () => {
    const s = await seed();
    const before = await bookValue(s);
    await runner(s, true);
    await s.as.mutation(api.salesDonations.undoBundledDonationSplit, { saleId: s.saleId });

    expect(await bookValue(s)).toBe(before);
    expect((await saleRow(s))!.grossCents).toBe(CHARGE_CENTS);
    expect(await allGifts(s)).toHaveLength(EXPECTED_DONOR_GIFT_COUNT);
    expect((await allDonors(s))[0].lifetimeCents).toBe(EXPECTED_DONOR_LIFETIME_CENTS);
  });
});

// ── It refuses rather than guesses ──────────────────────────────────────────

describe("runFieldDayBundledSplit — nothing is written on a pattern", () => {
  test("no donor at that email stops the run — it will not create a second her", async () => {
    // The specific harm. Running anyway would mint "Jordanella Maluka Chagiye"
    // afresh and leave a real person's giving history cut in two.
    const s = await seed({ noDonor: true });
    const res = await runner(s, true);

    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toMatch(/no donor with email/i);
    expect(await allDonors(s)).toHaveLength(0);
    expect((await saleRow(s))!.grossCents).toBe(CHARGE_CENTS);
  });

  test("a donor renamed since stops the run", async () => {
    const s = await seed({ donorName: "Someone Else Entirely" });
    const res = await runner(s, true);

    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toMatch(/no longer demonstrably points/i);
    expect(await allGifts(s)).toHaveLength(EXPECTED_DONOR_GIFT_COUNT);
  });

  test("a payment that is no longer $50 stops the run", async () => {
    const s = await seed({ grossCents: 6_000 });
    const res = await runner(s, true);

    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toMatch(/expected \$50\.00, found \$60\.00/i);
    expect((await saleRow(s))!.grossCents).toBe(6_000);
    expect(await allGifts(s)).toHaveLength(EXPECTED_DONOR_GIFT_COUNT);
  });

  test("a payment whose items something has since resolved stops the run", async () => {
    const s = await seed({ resolved: true });
    const res = await runner(s, true);

    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toMatch(/resolved its items/i);
    expect((await saleRow(s))!.grossCents).toBe(CHARGE_CENTS);
  });

  test("a missing payment stops the run rather than inventing one", async () => {
    const s = await seed({ noSale: true });
    const res = await runner(s, true);

    expect(res.proceeded).toBe(false);
    expect(res.saleFound).toBe(false);
    expect(res.problems.join(" ")).toMatch(/no sale with Stripe charge/i);
    expect(await allGifts(s)).toHaveLength(EXPECTED_DONOR_GIFT_COUNT);
  });

  test("a split that isn't this one stops the run", async () => {
    // Someone has already split this payment by hand, differently. Converging on
    // this module's numbers would silently overwrite their judgement.
    const s = await seed();
    await s.as.mutation(api.salesDonations.splitBundledDonation, {
      saleId: s.saleId,
      donationCents: 1_000,
      donorName: EXPECTED_DONOR_NAME,
      donorEmail: EXPECTED_DONOR_EMAIL,
      items: [{ label: "PW Tee", quantity: 1, unitPriceCents: 4_000, candidates: ["PW Tee"] }],
    });
    const before = await bookValue(s);

    const res = await runner(s, true);
    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toMatch(/already carries a \$10\.00 split/i);
    expect(await bookValue(s)).toBe(before);
  });
});
