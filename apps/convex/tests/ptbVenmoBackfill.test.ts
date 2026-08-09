/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "../lib/seed/historical/mapping";
import {
  ADMISSION_41_CANDIDATES,
  COLLECTOR_EMAIL,
  COLLECTOR_NAME,
  EXPECTED_ADMISSIONS,
  EXPECTED_BOOK_VALUE_DELTA_CENTS,
  FORWARDED_AT_MS,
  FORWARDED_CENTS,
  GIVEBUTTER_TRANSACTION_ID,
  PTB_PAGE_SLUG,
  RESOLVED_41ST_GUEST,
  TICKET_ATTENDEE_NAMES,
  TICKET_ORDER_REF,
  TICKET_PRICE_CENTS,
  VENMO_GUESTS,
  VENMO_TYPE_NAME,
  reconciles,
  ticketGrossCents,
} from "../lib/seed/historical/ptbVenmo2026";

/**
 * The 2026-08-09 Pop The Balloon Venmo reclassification.
 *
 * Three things this suite exists to hold still, in descending order of how
 * expensive they would be to get wrong:
 *
 *  1. BOOK VALUE DOES NOT MOVE. $820 of gift becomes $820 of ticket revenue on
 *     the same book, so the org is neither richer nor poorer afterwards. This
 *     is asserted through the REAL `accountBalances` query — the number the
 *     owner is actually reading on /finances/accounts — rather than a
 *     re-implementation of it here, because a re-implementation could agree
 *     with the runner while both disagree with the page.
 *  2. THE GIVEBUTTER SYNC DOES NOT PUT THE GIFT BACK. The whole risk of
 *     removing a gift the sync knows about is that the next run re-inserts it
 *     and the $820 lands twice. The test runs the conversion and then the real
 *     donation apply against the same transaction id.
 *  3. CHARISMA'S DONOR RECORD LOSES THE $820 AND NOTHING ELSE. Her seven other
 *     gifts are real and must survive untouched, with lifetime and count moving
 *     by exactly one gift's worth.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

type Seeded = ChapterSetup & {
  eventId: Id<"events">;
  pageId: Id<"eventPages">;
  donorId: Id<"donors">;
  giftId: Id<"gifts">;
};

/** Her other giving, as production holds it — seven gifts, $645 total. Real
 *  money that this correction must not touch. */
const OTHER_GIFTS = [
  { amountCents: 5500, externalRef: "gb:txn:3253320481" },
  { amountCents: 5000, externalRef: "BeO7FuBxY3EBC8df" },
  { amountCents: 12500, externalRef: "gb:txn:3100956779" },
  { amountCents: 10000, externalRef: "gb:txn:9359345012" },
  { amountCents: 5000, externalRef: "gb:txn:2744414400" },
  { amountCents: 16500, externalRef: "gb:txn:4512295950" },
  { amountCents: 10000, externalRef: undefined },
] as const;

const OTHER_GIFT_CENTS = OTHER_GIFTS.reduce((a, g) => a + g.amountCents, 0);

type SeedOpts = {
  /** Override the forwarded gift's amount (the "row disagrees" cases). */
  giftCents?: number;
  /** Drop the event tag off the gift. */
  untagged?: boolean;
  /** Skip the gift entirely (the "already run / never existed" cases). */
  noGift?: boolean;
};

/**
 * New York with Pop The Balloon and the live gift state: Charisma's eight
 * Givebutter gifts, the $820 one tagged to the event exactly as
 * `applyGivebutterDonations` writes it. Seeded through the real giving helpers
 * so every rollup (donor lifetime, scope aggregate, the page's Given total)
 * starts where production has it rather than where a hand-written fixture
 * guesses.
 */
async function seed(opts: SeedOpts = {}): Promise<Seeded> {
  const t = newT();
  const s = await setupChapter(t);
  const ids = await run(t, async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(s.chapterId, { slug: NEW_YORK_CHAPTER_SLUG });

    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Pop The Balloon",
      slug: "pop-the-balloon",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Pop The Balloon",
      eventDate: Date.UTC(2025, 11, 6, 12, 0, 0),
      status: "completed",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const pageId = await ctx.db.insert("eventPages", {
      eventId,
      chapterId: s.chapterId,
      slug: PTB_PAGE_SLUG,
      published: true,
      goingCount: 0,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: 0,
      revenueCents: 0,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });

    const donorId = await ctx.db.insert("donors", {
      scope: s.chapterId,
      kind: "individual",
      name: COLLECTOR_NAME,
      email: COLLECTOR_EMAIL,
      status: "active",
      lifetimeCents: 0,
      giftCount: 0,
      source: "givebutter-import",
      createdAt: now,
    });
    return { eventId, pageId, donorId };
  });

  // The gifts go in through the shared write path, so the donor/scope/event
  // rollups are the ones the app itself maintains.
  const { recordGiftForDonor } = await import("../lib/givingDonors");
  for (const g of OTHER_GIFTS) {
    await run(t, (ctx) =>
      recordGiftForDonor(ctx, {
        donorId: ids.donorId,
        amountCents: g.amountCents,
        receivedAt: FORWARDED_AT_MS - 30 * 86_400_000,
        method: "givebutter",
        ...(g.externalRef ? { externalRef: g.externalRef } : {}),
      }),
    );
  }

  let giftId = "" as Id<"gifts">;
  if (!opts.noGift) {
    giftId = await run(t, (ctx) =>
      recordGiftForDonor(ctx, {
        donorId: ids.donorId,
        amountCents: opts.giftCents ?? FORWARDED_CENTS,
        receivedAt: FORWARDED_AT_MS,
        method: "givebutter",
        ...(opts.untagged ? {} : { eventId: ids.eventId }),
        externalRef: GIVEBUTTER_TRANSACTION_ID,
      }),
    );
  }
  return { ...s, ...ids, giftId };
}

/** Central ED + finance manager — the reconciliation-audit power that
 *  `accountBalances` is gated on (mirrors reconciliationEngine.test.ts). */
async function asCentralEd(s: ChapterSetup): Promise<void> {
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
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    });
  });
}

/** New York's book value, straight out of the query the accounts page reads. */
async function bookValue(s: Seeded): Promise<number> {
  const balances = await s.as.query(api.reconciliation.accountBalances, {});
  return balances.find((b) => b.scope === s.chapterId)!.bookBalanceCents;
}

function runner(s: Seeded, execute: boolean) {
  return s.t.mutation(internal.ptbVenmoBackfill.runPtbVenmoBackfill, {
    recordedBy: s.userId,
    execute,
  });
}

const state = (s: Seeded) =>
  run(s.t, async (ctx) => {
    const page = (await ctx.db.get(s.pageId))!;
    return {
      gifts: await ctx.db.query("gifts").collect(),
      orders: await ctx.db.query("ticketOrders").collect(),
      types: await ctx.db.query("ticketTypes").collect(),
      conversions: await ctx.db.query("givebutterConvertedDonations").collect(),
      donor: (await ctx.db.get(s.donorId))!,
      revenueCents: page.revenueCents,
      ticketsSoldCount: page.ticketsSoldCount,
      givenCents: page.externalGiftsCents ?? 0,
      givenCount: page.externalGiftsCount ?? 0,
    };
  });

// ── The data module, no database needed ─────────────────────────────────────

describe("ptbVenmo2026 — the tickets are the money", () => {
  test("41 admissions at $20 is the $820 that was forwarded, exactly", () => {
    expect(FORWARDED_CENTS).toBe(82000);
    expect(TICKET_PRICE_CENTS).toBe(2000);
    expect(EXPECTED_ADMISSIONS).toBe(41);
    expect(ticketGrossCents()).toBe(FORWARDED_CENTS);
    expect(reconciles()).toBe(true);
    // Derived, not typed: the count only exists because the division is exact.
    expect(FORWARDED_CENTS % TICKET_PRICE_CENTS).toBe(0);
  });

  test("the guest list transcribes 40, and the owner resolved the 41st", () => {
    expect(VENMO_GUESTS).toHaveLength(40);
    expect(TICKET_ATTENDEE_NAMES).toHaveLength(EXPECTED_ADMISSIONS);
    expect(TICKET_ATTENDEE_NAMES.slice(0, 40)).toEqual(
      VENMO_GUESTS.map((g) => g.name),
    );
    expect(TICKET_ATTENDEE_NAMES[40]).toBe("Brenell Harrison");
    expect(RESOLVED_41ST_GUEST.handle).toBe("Bre-Harrison-1");
  });

  test("the 41st stays OUT of the transcribed forty", () => {
    // `VENMO_GUESTS` is what the guest list's Platform=Venmo column literally
    // says; the 41st is the owner reading his own sheet and telling us which
    // unlabelled payer belongs here. Folding her in would make the
    // transcription's own description false and hide the single place this
    // module rests on memory rather than a source.
    expect(VENMO_GUESTS.map((g) => g.name)).not.toContain(RESOLVED_41ST_GUEST.name);
    expect(RESOLVED_41ST_GUEST.note).toContain("owner-confirmed");
  });

  test("the rejected candidates and their reasons are still recorded", () => {
    const all = ADMISSION_41_CANDIDATES.join(" ");
    expect(all).toContain("Brenell Harrison — CHOSEN");
    // The reason Charisma was rejected is the whole reason this needed asking:
    // her $20 is already a live admission on the Cash App order, so naming her
    // would have put one person in two slots on one event.
    expect(all).toContain("ptb:cashapp:2025-10");
    expect(all).toContain("Fancy — rejected");
  });

  test("every name is distinct — two near-identical spellings are two people", () => {
    // "Vannesa" (@Vanhut) and "Vanessa" (@vanessawanyandeh) are different rows
    // with different handles. Collapsing them as a typo would silently drop an
    // admission and break the $820.
    expect(new Set(TICKET_ATTENDEE_NAMES).size).toBe(TICKET_ATTENDEE_NAMES.length);
    expect(VENMO_GUESTS.some((g) => g.name === "Vannesa")).toBe(true);
    expect(VENMO_GUESTS.some((g) => g.name === "Vanessa")).toBe(true);
  });

  test("the plus-one is two rows, not one row counted twice", () => {
    // Selly paid $40 for herself and Melos. BOTH have their own guest-list row,
    // so both are already one admission each in the forty — nothing to add and
    // nothing to collapse. The shared Venmo handle is what says it was one
    // payment.
    const pair = VENMO_GUESTS.filter((g) => g.handle === "seliom-gobeze");
    expect(pair.map((g) => g.name)).toEqual(["selly", "Melos Ambaye"]);
    expect(TICKET_ATTENDEE_NAMES.filter((n) => n === "selly")).toHaveLength(1);
    expect(TICKET_ATTENDEE_NAMES.filter((n) => n === "Melos Ambaye")).toHaveLength(1);
  });

  test("the expected book-value move is zero, by construction", () => {
    expect(EXPECTED_BOOK_VALUE_DELTA_CENTS).toBe(0);
    expect(ticketGrossCents() - FORWARDED_CENTS).toBe(
      EXPECTED_BOOK_VALUE_DELTA_CENTS,
    );
  });
});

// ── The runner, against a database ──────────────────────────────────────────

describe("runPtbVenmoBackfill", () => {
  test("a dry run reports the whole swap and writes nothing", async () => {
    const s = await seed();
    const res = await runner(s, false);

    expect(res.dryRun).toBe(true);
    expect(res.proceeded).toBe(true);
    expect(res.giftFound).toBe(true);
    expect(res.giftCents).toBe(FORWARDED_CENTS);
    expect(res.ticketCents).toBe(FORWARDED_CENTS);
    expect(res.ticketAdmissions).toBe(EXPECTED_ADMISSIONS);
    expect(res.transcribedAdmissions).toBe(40);
    expect(res.bookValueDeltaCents).toBe(EXPECTED_BOOK_VALUE_DELTA_CENTS);
    expect(res.donor).toMatchObject({
      lifetimeCentsBefore: OTHER_GIFT_CENTS + FORWARDED_CENTS,
      lifetimeCentsAfter: OTHER_GIFT_CENTS,
      giftCountBefore: 8,
      giftCountAfter: 7,
      otherGiftsKept: 7,
      otherGiftCentsKept: OTHER_GIFT_CENTS,
    });

    const after = await state(s);
    expect(after.gifts).toHaveLength(8);
    expect(after.orders).toHaveLength(0);
    expect(after.conversions).toHaveLength(0);
    expect(after.donor.lifetimeCents).toBe(OTHER_GIFT_CENTS + FORWARDED_CENTS);
  });

  test("an executed run swaps the gift for 41 tickets and BOOK VALUE DOES NOT MOVE", async () => {
    const s = await seed();
    await asCentralEd(s);

    const before = await bookValue(s);
    const res = await runner(s, true);
    const after = await bookValue(s);

    // The assertion the whole change is built around, read from the query the
    // owner's reconciliation panel reads.
    expect(after).toBe(before);
    expect(after - before).toBe(EXPECTED_BOOK_VALUE_DELTA_CENTS);
    expect(res.bookValueDeltaCents).toBe(EXPECTED_BOOK_VALUE_DELTA_CENTS);

    const st = await state(s);
    // ── the gift is gone ──
    expect(st.gifts.map((g) => g.externalRef)).not.toContain(
      GIVEBUTTER_TRANSACTION_ID,
    );
    expect(st.gifts).toHaveLength(7);

    // ── the tickets are here ──
    expect(st.orders).toHaveLength(1);
    const order = st.orders[0];
    expect(order.externalRef).toBe(TICKET_ORDER_REF);
    expect(order.status).toBe("paid");
    expect(order.totalCents).toBe(FORWARDED_CENTS);
    expect(order.chapterId).toBe(s.chapterId);
    expect(order.email).toBe(COLLECTOR_EMAIL);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].quantity).toBe(EXPECTED_ADMISSIONS);
    expect(order.items[0].unitPriceCents).toBe(TICKET_PRICE_CENTS);
    expect(order.items[0].attendeeNames).toEqual(TICKET_ATTENDEE_NAMES);
    // Dated the moment the money arrived, not the moment of the correction.
    expect(order.createdAt).toBe(FORWARDED_AT_MS);

    // A tier of its own for the Venmo rail, never sellable.
    const venmoType = st.types.find((tt) => tt.name === VENMO_TYPE_NAME)!;
    expect(venmoType.isActive).toBe(false);
    expect(venmoType.soldCount).toBe(EXPECTED_ADMISSIONS);
    expect(venmoType.priceCents).toBe(TICKET_PRICE_CENTS);

    // ── the event's two counters moved by ±the same $820 ──
    expect(st.revenueCents).toBe(FORWARDED_CENTS);
    expect(st.ticketsSoldCount).toBe(EXPECTED_ADMISSIONS);
    expect(st.givenCents).toBe(0);
    expect(st.givenCount).toBe(0);
    expect(res.eventRevenueDeltaCents + res.eventGivenDeltaCents).toBe(0);
  });

  test("Charisma loses the $820 and keeps her seven real gifts", async () => {
    const s = await seed();
    await runner(s, true);

    const st = await state(s);
    expect(st.donor.lifetimeCents).toBe(OTHER_GIFT_CENTS);
    expect(st.donor.giftCount).toBe(7);
    // Her other giving is byte-for-byte untouched.
    expect(st.gifts.map((g) => g.amountCents).sort((a, b) => a - b)).toEqual(
      OTHER_GIFTS.map((g) => g.amountCents).sort((a, b) => a - b),
    );

    // And the scope rollup came down with her — a raw `ctx.db.delete` would
    // have left this $820 over, which is the reason the removal goes through
    // `removeGiftRow`.
    const rollup = await run(s.t, (ctx) =>
      ctx.db
        .query("givingScopeRollups")
        .withIndex("by_scope", (q) => q.eq("scope", s.chapterId))
        .first(),
    );
    expect(rollup?.lifetimeCents).toBe(OTHER_GIFT_CENTS);
    expect(rollup?.giftCount).toBe(7);
  });

  test("the conversion record says where the money went", async () => {
    const s = await seed();
    await runner(s, true);

    const st = await state(s);
    expect(st.conversions).toHaveLength(1);
    expect(st.conversions[0]).toMatchObject({
      externalRef: GIVEBUTTER_TRANSACTION_ID,
      amountCents: FORWARDED_CENTS,
      scope: s.chapterId,
      eventId: s.eventId,
      convertedTo: `ticketOrders.externalRef=${TICKET_ORDER_REF}`,
      convertedBy: s.userId,
    });
  });

  test("the 41st admission is disclosed on every run, with the alternatives", async () => {
    // Settled, not open — but it is the only figure here that rests on someone's
    // memory rather than on $820 ÷ $20, and a judgement nobody can see is one
    // nobody can revisit. So it stays in front of whoever reads a run, dry or
    // real, together with the two names it was chosen over.
    const s = await seed();
    const dry = await runner(s, false);
    expect(dry.problems.join(" ")).toContain("Brenell Harrison");
    expect(dry.problems.join(" ")).toContain("owner's decision of 2026-08-09");
    expect(dry.problems.join(" ")).toContain("Charisma Stevens");
    expect(dry.problems.join(" ")).toContain("Fancy");

    const wet = await runner(s, true);
    expect(wet.problems.join(" ")).toContain("Brenell Harrison");
  });

  test("the durable conversion record carries the 41st-name reasoning", async () => {
    // This module gets deleted once run; that row is permanent. Someone counting
    // heads against the Cash App order later needs to be able to find out why 41
    // and not 40 without a code archaeology expedition.
    const s = await seed();
    await runner(s, true);
    const reason = (await state(s)).conversions[0].reason;
    expect(reason).toContain("Brenell Harrison");
    expect(reason).toContain("ptb:cashapp:2025-10");
    expect(reason).toContain("Do not re-import");
  });

  test("re-running changes nothing", async () => {
    const s = await seed();
    await runner(s, true);
    const before = await state(s);

    const second = await runner(s, true);
    expect(second.proceeded).toBe(true);
    expect(second.giftFound).toBe(false);
    expect(second.bookValueDeltaCents).toBe(0);
    expect(second.ticketOrderCreated).toBe(false);

    const after = await state(s);
    expect(after.orders).toHaveLength(1);
    expect(after.conversions).toHaveLength(1);
    expect(after.gifts).toHaveLength(7);
    expect(after.revenueCents).toBe(before.revenueCents);
    expect(after.ticketsSoldCount).toBe(before.ticketsSoldCount);
    expect(after.donor.lifetimeCents).toBe(before.donor.lifetimeCents);
  });
});

// ── The trap: the sync putting the gift straight back ───────────────────────

describe("the Givebutter sync does not resurrect the converted gift", () => {
  /** The donation the sync will present on its next run — the same transaction
   *  id, the same $820, because Givebutter's record of it has not changed and
   *  never will. */
  const forwardedDonation = {
    externalId: GIVEBUTTER_TRANSACTION_ID,
    donationCents: FORWARDED_CENTS,
    donorName: COLLECTOR_NAME,
    email: COLLECTOR_EMAIL,
    phone: null,
    receivedAt: FORWARDED_AT_MS,
  };

  test("convert, then run the donation apply against the same transaction id", async () => {
    const s = await seed();
    await asCentralEd(s);
    await runner(s, true);

    const bookValueAfterConversion = await bookValue(s);
    const givenAfterConversion = (await state(s)).givenCents;

    // Exactly what `syncOneCampaign` hands the apply mutation once the campaign
    // is swept again. Without the tombstone, `gifts.by_externalRef` misses and
    // this inserts $820 of gift on top of the $820 of tickets.
    const res = await s.t.mutation(
      internal.givebutterSync.applyGivebutterDonations,
      { eventId: s.eventId, donations: [forwardedDonation] },
    );
    expect(res).toMatchObject({ inserted: 0, converted: 1 });

    const st = await state(s);
    // The $820 did not come back — not as a gift, not on the donor, not on the
    // event's Given total, not in book value.
    expect(st.gifts).toHaveLength(7);
    expect(st.gifts.map((g) => g.externalRef)).not.toContain(
      GIVEBUTTER_TRANSACTION_ID,
    );
    expect(st.donor.lifetimeCents).toBe(OTHER_GIFT_CENTS);
    expect(st.donor.giftCount).toBe(7);
    expect(st.givenCents).toBe(givenAfterConversion);
    expect(await bookValue(s)).toBe(bookValueAfterConversion);
    // And the tickets are still the only record of the money.
    expect(st.orders).toHaveLength(1);
    expect(st.orders[0].totalCents).toBe(FORWARDED_CENTS);
  });

  test("sweeping ten more times still does not bring it back", async () => {
    // The cron runs every 15 minutes. A guard that holds once and not
    // repeatedly would be no guard at all.
    const s = await seed();
    await runner(s, true);
    for (let i = 0; i < 10; i++) {
      await s.t.mutation(internal.givebutterSync.applyGivebutterDonations, {
        eventId: s.eventId,
        donations: [forwardedDonation],
      });
    }
    const st = await state(s);
    expect(st.gifts).toHaveLength(7);
    expect(st.donor.lifetimeCents).toBe(OTHER_GIFT_CENTS);
  });

  test("a converted transaction never even mints a donor row", async () => {
    // The guard sits BEFORE `matchOrCreateDonor` on purpose: a donation that
    // was not a gift must not manufacture a giver either. Proved by converting
    // in a scope where the collector has no donor record of her own name to
    // match, then sweeping.
    const s = await seed();
    await runner(s, true);
    const donorsBefore = await run(s.t, (ctx) =>
      ctx.db.query("donors").collect(),
    );
    await s.t.mutation(internal.givebutterSync.applyGivebutterDonations, {
      eventId: s.eventId,
      donations: [
        { ...forwardedDonation, donorName: "Someone Else", email: "else@x.com" },
      ],
    });
    const donorsAfter = await run(s.t, (ctx) => ctx.db.query("donors").collect());
    expect(donorsAfter).toHaveLength(donorsBefore.length);
  });

  test("an unrelated donation on the same campaign still lands normally", async () => {
    // The guard is keyed on ONE transaction id. Suppressing anything wider
    // would silently swallow real giving — which is the opposite failure, and
    // just as expensive.
    const s = await seed();
    await runner(s, true);
    const res = await s.t.mutation(
      internal.givebutterSync.applyGivebutterDonations,
      {
        eventId: s.eventId,
        donations: [
          forwardedDonation,
          { ...forwardedDonation, externalId: "SomeOtherTxnId", donationCents: 2500 },
        ],
      },
    );
    expect(res).toMatchObject({ inserted: 1, converted: 1 });
    const st = await state(s);
    expect(st.gifts).toHaveLength(8);
    expect(st.gifts.filter((g) => g.externalRef === "SomeOtherTxnId")).toHaveLength(1);
  });
});

// ── Refusals: nothing is written on a row that disagrees ────────────────────

describe("runPtbVenmoBackfill refuses rather than guesses", () => {
  test("a gift that is no longer $820 stops the whole run", async () => {
    const s = await seed({ giftCents: 70000 });
    const res = await runner(s, true);

    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toContain("$700.00");
    const st = await state(s);
    expect(st.orders).toHaveLength(0);
    expect(st.conversions).toHaveLength(0);
    expect(st.gifts).toHaveLength(8);
  });

  test("an amount that isn't a whole number of $20 tickets stops the run", async () => {
    // Checked BEFORE the row is compared to the $820 this module was written
    // against: "does this even describe whole tickets?" has to be answerable
    // first, or a row that is not ticket-shaped at all would only ever be
    // reported as the narrower "expected $820" complaint.
    const s = await seed({ giftCents: 82500 });
    const res = await runner(s, true);
    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toContain("not a whole number");
    expect((await state(s)).orders).toHaveLength(0);
  });

  test("a gift no longer tagged to the event stops the run", async () => {
    // The event tag is what makes the Given rollup reversible; without it,
    // removing the gift would leave the event's "raised" total $820 too high.
    const s = await seed({ untagged: true });
    const res = await runner(s, true);
    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toContain("Pop The Balloon");
    expect((await state(s)).orders).toHaveLength(0);
  });

  test("a missing gift with no conversion record is reported, not assumed done", async () => {
    const s = await seed({ noGift: true });
    const res = await runner(s, true);
    expect(res.proceeded).toBe(false);
    expect(res.giftFound).toBe(false);
    expect(res.problems.join(" ")).toContain("no conversion record");
    expect((await state(s)).orders).toHaveLength(0);
  });

  test("a gift that came back after a conversion is escalated, not re-converted", async () => {
    // The state the tombstone exists to make impossible. If it ever happens,
    // the honest response is to stop and say so — converting again would write
    // a second ticket order for the same $820.
    const s = await seed();
    await runner(s, true);
    await run(s.t, async (ctx) => {
      const { recordGiftForDonor } = await import("../lib/givingDonors");
      await recordGiftForDonor(ctx, {
        donorId: s.donorId,
        amountCents: FORWARDED_CENTS,
        receivedAt: FORWARDED_AT_MS,
        method: "givebutter",
        eventId: s.eventId,
        externalRef: GIVEBUTTER_TRANSACTION_ID,
      });
    });

    const res = await runner(s, true);
    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toContain("re-created after the conversion");
    // Still exactly one ticket order — the correction did not run twice.
    expect((await state(s)).orders).toHaveLength(1);
  });
});
