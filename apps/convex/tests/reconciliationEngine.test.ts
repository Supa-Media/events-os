/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { CENTRAL } from "@events-os/shared";
import { signedBookCents } from "../lib/bookBalance";

/**
 * MORNING RECONCILIATION ENGINE (`reconciliation.ts`) — the money math, run
 * against fixture payout items (the network fetch / DB apply seam means no
 * Stripe is ever touched here; `applyPayoutAllocation` and
 * `runAutoSettlement` ARE the engine's ledger writes).
 *
 * What matters and is asserted here:
 *  - a payout's per-book nets become central↔chapter transfer pairs with
 *    `transferOrigin:"payout_allocation"`, and re-running allocates NOTHING
 *    twice (deterministic group ids);
 *  - untraceable money stays on central's book, counted loudly; repayment
 *    cash returns book NO transfer (the chapter was credited at settle);
 *  - refunds net against their book, and a refund-heavy payout books the
 *    reverse direction;
 *  - the bank deposit is found and labeled like `markAsPayout` would;
 *  - `payout_allocation` pairs do NOT pay down `interScopeBalances` (revenue
 *    isn't settlement), while `runAutoSettlement`'s pairs DO zero it — and a
 *    second same-day settlement run books nothing;
 *  - engine pairs never pollute the City Launch Fund position;
 *  - `signedBookCents` signs every ledger shape correctly (the accounts-page
 *    "book value" depends on it);
 *  - the audit surface is ED/FM-gated and flags are dedup'd/resolvable.
 */

// ── Seat/fixture helpers (the transfers.test.ts conventions) ─────────────────

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** Central ED — passes `isCentralEdOrFm` (the reconciliation-audit power).
 *  Also granted a central finance MANAGER role: the tests read
 *  `interScopeBalances` (central viewer+) and record manual transfers
 *  (central bookkeeper+/ED), and the ED title alone doesn't bridge into
 *  `financeRoles`. */
async function asCentralEd(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
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
  return personId;
}

/** A chapter-scope donor + one gift, the pledge-cycle / give-gift fixtures. */
async function seedDonorWithGift(
  s: ChapterSetup,
  scope: Id<"chapters"> | typeof CENTRAL,
  gift: { stripeInvoiceId?: string; externalRef?: string; amountCents: number },
): Promise<void> {
  await run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope,
      kind: "individual",
      name: "Backer",
      status: "active",
      lifetimeCents: gift.amountCents,
      giftCount: 1,
      createdAt: Date.now(),
    });
    await ctx.db.insert("gifts", {
      donorId,
      scope,
      amountCents: gift.amountCents,
      currency: "usd",
      receivedAt: Date.now(),
      method: "stripe",
      stripeInvoiceId: gift.stripeInvoiceId,
      externalRef: gift.externalRef,
      createdAt: Date.now(),
    });
  });
}

/** A paid ticket order in the caller's chapter (needs a real event). */
async function seedTicketOrder(
  s: ChapterSetup,
  totalCents: number,
): Promise<Id<"ticketOrders">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Field Day",
      slug: "field-day",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Field Day",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const ticketTypeId = await ctx.db.insert("ticketTypes", {
      eventId,
      chapterId: s.chapterId,
      name: "GA",
      priceCents: totalCents,
      currency: "usd",
      soldCount: 1,
      sortOrder: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("ticketOrders", {
      eventId,
      chapterId: s.chapterId,
      name: "Guest",
      email: "guest@example.com",
      items: [
        { ticketTypeId, name: "GA", quantity: 1, unitPriceCents: totalCents },
      ],
      totalCents,
      currency: "usd",
      status: "paid",
      stripePaymentIntentId: "pi_order_1",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedDetectedPayout(
  s: ChapterSetup,
  args: { stripePayoutId: string; amountCents: number; arrivalDate?: number },
): Promise<void> {
  await s.t.mutation(internal.reconciliation.upsertDetectedPayout, {
    stripePayoutId: args.stripePayoutId,
    amountCents: args.amountCents,
    currency: "usd",
    stripeStatus: "paid",
    arrivalDate: args.arrivalDate ?? Date.now(),
  });
}

/** Balance settlements now carry a unique suffix so a chapter can be settled
 *  more than once a day (see `settleChapterBalances`), so the tests match on
 *  the stable prefix rather than an exact id. */
function settlementLegsFor(s: ChapterSetup, prefix: string) {
  return run(s.t, async (ctx) =>
    (await ctx.db.query("transactions").take(500)).filter((t) =>
      (t.transferGroupId ?? "").startsWith(prefix),
    ),
  );
}

function legsFor(s: ChapterSetup, transferGroupId: string) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_transfer_group", (q) =>
        q.eq("transferGroupId", transferGroupId),
      )
      .collect(),
  );
}

function payoutRow(s: ChapterSetup, stripePayoutId: string) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("stripePayouts")
      .withIndex("by_stripe_payout", (q) =>
        q.eq("stripePayoutId", stripePayoutId),
      )
      .unique(),
  );
}

// ── Payout allocation ────────────────────────────────────────────────────────

describe("applyPayoutAllocation — the per-book money math", () => {
  test("chapter revenue becomes a central→chapter pair, net of fees; unmapped stays central", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A pledge cycle ($50 − $1.75 fee) and a give gift ($100 − $3.20 fee),
    // both belonging to the chapter's book; plus an unmapped $10 charge.
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_1",
      amountCents: 5_000,
    });
    await seedDonorWithGift(s, s.chapterId, {
      externalRef: "give:cs_give_1",
      amountCents: 10_000,
    });
    await seedDetectedPayout(s, { stripePayoutId: "po_1", amountCents: 14_005 });

    const result = await t.mutation(
      internal.reconciliation.applyPayoutAllocation,
      {
        stripePayoutId: "po_1",
        items: [
          { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_1" },
          {
            grossCents: 10_000,
            feeCents: 320,
            netCents: 9_680,
            sessionId: "cs_give_1",
            metadata: { giveDonation: "1" },
          },
          { grossCents: 1_000, feeCents: 59, netCents: 941 }, // untraceable
        ],
      },
    );

    expect(result.transfersBooked).toBe(1);
    expect(result.allocatedCents).toBe(4_825 + 9_680);
    expect(result.unmappedNetCents).toBe(941);

    const legs = await legsFor(s, `payoutalloc-po_1-${s.chapterId}`);
    expect(legs.length).toBe(2);
    for (const leg of legs) {
      expect(leg.flow).toBe("transfer");
      expect(leg.source).toBe("transfer");
      expect(leg.amountCents).toBe(14_505);
      expect(leg.transferDirection).toBe("central_to_chapter");
      expect(leg.transferOrigin).toBe("payout_allocation");
    }
    expect(new Set(legs.map((l) => l.chapterId))).toEqual(
      new Set([CENTRAL, s.chapterId]),
    );

    const po = await payoutRow(s, "po_1");
    expect(po?.processState).toBe("allocated");
    expect(po?.unmappedNetCents).toBe(941);
    const chapterEntry = po?.allocation?.find((a) => a.scope === s.chapterId);
    expect(chapterEntry?.netCents).toBe(14_505);
    expect(chapterEntry?.transferGroupId).toBe(
      `payoutalloc-po_1-${s.chapterId}`,
    );
  });

  test("re-running the same payout books NOTHING twice (deterministic group ids)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_2",
      amountCents: 5_000,
    });
    await seedDetectedPayout(s, { stripePayoutId: "po_2", amountCents: 4_825 });
    const items = [
      { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_2" },
    ];

    const first = await t.mutation(
      internal.reconciliation.applyPayoutAllocation,
      { stripePayoutId: "po_2", items },
    );
    const second = await t.mutation(
      internal.reconciliation.applyPayoutAllocation,
      { stripePayoutId: "po_2", items },
    );

    expect(first.transfersBooked).toBe(1);
    expect(second.transfersBooked).toBe(0);
    expect(
      (await legsFor(s, `payoutalloc-po_2-${s.chapterId}`)).length,
    ).toBe(2);
  });

  test("a ticket order allocates via its session metadata.orderId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const orderId = await seedTicketOrder(s, 2_500);
    await seedDetectedPayout(s, { stripePayoutId: "po_3", amountCents: 2_367 });

    await t.mutation(internal.reconciliation.applyPayoutAllocation, {
      stripePayoutId: "po_3",
      items: [
        {
          grossCents: 2_500,
          feeCents: 133,
          netCents: 2_367,
          sessionId: "cs_order_1",
          metadata: { orderId: String(orderId) },
        },
      ],
    });

    const legs = await legsFor(s, `payoutalloc-po_3-${s.chapterId}`);
    expect(legs.length).toBe(2);
    expect(legs[0]?.amountCents).toBe(2_367);
    const po = await payoutRow(s, "po_3");
    expect(po?.itemKindCounts?.ticket_order).toBe(1);
  });

  test("refund-heavy payout books the REVERSE direction; repayments book nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_4",
      amountCents: 5_000,
    });
    await seedDetectedPayout(s, { stripePayoutId: "po_4", amountCents: 100 });

    const result = await t.mutation(
      internal.reconciliation.applyPayoutAllocation,
      {
        stripePayoutId: "po_4",
        items: [
          // A $20 refund against the chapter's earlier revenue outweighs this
          // payout's $50 cycle → the chapter owes the difference back.
          { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_4" },
          {
            grossCents: -7_000,
            feeCents: 0,
            netCents: -7_000,
            invoiceId: "in_4",
            isReversal: true,
          },
          // Repayment cash return — chapter book already credited at settle.
          {
            grossCents: 2_000,
            feeCents: 88,
            netCents: 1_912,
            metadata: { repaymentIds: "abc" },
          },
        ],
      },
    );

    const legs = await legsFor(s, `payoutalloc-po_4-${s.chapterId}`);
    expect(legs.length).toBe(2);
    expect(legs[0]?.transferDirection).toBe("chapter_to_central");
    expect(legs[0]?.amountCents).toBe(7_000 - 4_825);

    expect(result.transfersBooked).toBe(1);
    const po = await payoutRow(s, "po_4");
    expect(po?.repaymentNetCents).toBe(1_912);
    expect(po?.itemKindCounts?.refund).toBe(1);
    expect(po?.itemKindCounts?.repayment).toBe(1);
  });

  test("a re-run that recomputes a DIFFERENT net surfaces the drift instead of silently overwriting", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedDetectedPayout(s, { stripePayoutId: "po_drift", amountCents: 0 });
    // First pass: only an unmapped-ish traceable item nets the chapter 4825.
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_drift",
      amountCents: 5_000,
    });
    const items1 = [
      { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_drift" },
    ];
    await t.mutation(internal.reconciliation.applyPayoutAllocation, {
      stripePayoutId: "po_drift",
      items: items1,
    });
    // Second pass resolves an EXTRA item to the chapter (late-arriving gift):
    // the recomputed net (9650) no longer matches the booked pair (4825).
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_drift2",
      amountCents: 5_000,
    });
    await t.mutation(internal.reconciliation.applyPayoutAllocation, {
      stripePayoutId: "po_drift",
      items: [
        ...items1,
        { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_drift2" },
      ],
    });

    // Still exactly one pair, at the ORIGINAL amount…
    const legs = await legsFor(s, `payoutalloc-po_drift-${s.chapterId}`);
    expect(legs.length).toBe(2);
    expect(legs[0]?.amountCents).toBe(4_825);
    // …and the drift is loud on the payout row.
    const po = await payoutRow(s, "po_drift");
    expect(po?.error).toMatch(/offsetting transfer/i);
  });

  test("the bank deposit is found and labeled like markAsPayout would", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const arrival = Date.now();
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_5",
      amountCents: 5_000,
    });
    // A SANDBOX test deposit with the same amount + text must never be
    // claimed as the real payout's arrival (mode filter, #163 precedent).
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "increase_ach",
        flow: "inflow",
        amountCents: 4_825,
        currency: "usd",
        postedAt: arrival + 30_000,
        merchantName: "STRIPE",
        status: "unreviewed",
        externalId: "sandbox_transaction_dep_1",
        createdAt: Date.now(),
      }),
    );
    // The ingested central bank row for the deposit (net amount, STRIPE text).
    const depositId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "increase_ach",
        flow: "inflow",
        amountCents: 4_825,
        currency: "usd",
        postedAt: arrival + 60_000,
        merchantName: "STRIPE",
        description: "ORIG CO NAME:STRIPE",
        status: "unreviewed",
        externalId: "transaction_dep_1",
        createdAt: Date.now(),
      }),
    );
    await seedDetectedPayout(s, {
      stripePayoutId: "po_5",
      amountCents: 4_825,
      arrivalDate: arrival,
    });

    const result = await t.mutation(
      internal.reconciliation.applyPayoutAllocation,
      {
        stripePayoutId: "po_5",
        items: [
          { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_5" },
        ],
      },
    );

    expect(result.depositMatched).toBe(true);
    const deposit = await run(s.t, (ctx) => ctx.db.get(depositId));
    expect(deposit?.payoutProcessor).toBe("stripe");
    expect(deposit?.stripePayoutId).toBe("po_5");
    // Machine-coded, NOT human-reconciled: unreviewed lifts to categorized.
    expect(deposit?.status).toBe("categorized");
    // The heuristic match says HOW the row got claimed (Opus inverse-audit,
    // 2026-08-13): a text-heuristic that suppresses a row from every total
    // must be discoverable on the row itself, never silent.
    expect(deposit?.note).toContain("Matched to Stripe payout po_5 automatically");
    expect((await payoutRow(s, "po_5"))?.matchedTransactionId).toBe(depositId);
  });
});

// ── Interplay with interScopeBalances + auto settlement ──────────────────────

describe("auto settlement + the settling-leg exclusion", () => {
  /** Seed direction (a): the chapter's card paid for a CENTRAL budget line. */
  async function seedCrossBookSpend(
    s: ChapterSetup,
    amountCents: number,
  ): Promise<void> {
    await run(s.t, async (ctx) => {
      const centralBudgetId = await ctx.db.insert("budgets", {
        chapterId: CENTRAL,
        amountCents: 100_000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        approvalStatus: "approved",
        createdAt: Date.now(),
      });
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents,
        postedAt: Date.now(),
        status: "categorized",
        budgetId: centralBudgetId,
        createdAt: Date.now(),
      });
    });
  }

  test("payout_allocation pairs do NOT pay down a card-spend imbalance", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedCrossBookSpend(s, 30_000); // central owes chapter $300

    // An allocation pair in the SAME direction (central→chapter) lands…
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_6",
      amountCents: 5_000,
    });
    await seedDetectedPayout(s, { stripePayoutId: "po_6", amountCents: 4_825 });
    await t.mutation(internal.reconciliation.applyPayoutAllocation, {
      stripePayoutId: "po_6",
      items: [
        { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_6" },
      ],
    });

    // …and the imbalance is UNCHANGED — revenue isn't settlement.
    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(
      balances.find((b) => b.chapterId === s.chapterId)?.netCents,
    ).toBe(30_000);
  });

  test("runAutoSettlement zeroes the net with an auto_settlement pair; re-run books nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedCrossBookSpend(s, 30_000);

    const first = await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-07",
    });
    expect(first.settlementsBooked).toBe(1);
    expect(first.settledCents).toBe(30_000);

    const legs = await legsFor(s, `autosettle-${s.chapterId}-2026-08-07`);
    expect(legs.length).toBe(2);
    expect(legs[0]?.transferOrigin).toBe("auto_settlement");
    expect(legs[0]?.transferDirection).toBe("central_to_chapter");

    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(0);

    // Same-day re-run: net now 0 → nothing booked; and even with NEW spend it
    // could never duplicate the day's group id (ALREADY_RECORDED is caught).
    const second = await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-07",
    });
    expect(second.settlementsBooked).toBe(0);
  });

  /** A settling pair written straight to the ledger at a chosen status — the
   *  shape `recordTransferPair` produces, so the read side can't tell it apart.
   *  `recordTransferPair` has no way to book an already-excluded pair, and the
   *  production row that caused the loop below was excluded AFTER the fact. */
  async function seedSettlingPair(
    s: ChapterSetup,
    args: {
      amountCents: number;
      direction: "central_to_chapter" | "chapter_to_central";
      status: "reconciled" | "excluded";
      transferGroupId: string;
    },
  ): Promise<void> {
    await run(s.t, async (ctx) => {
      for (const scope of [CENTRAL, s.chapterId] as const) {
        await ctx.db.insert("transactions", {
          chapterId: scope,
          source: "transfer",
          flow: "transfer",
          amountCents: args.amountCents,
          postedAt: Date.now(),
          status: args.status,
          transferGroupId: args.transferGroupId,
          transferDirection: args.direction,
          transferOrigin: "auto_settlement",
          createdAt: Date.now(),
        });
      }
    });
  }

  test("an EXCLUDED settling leg is not a settlement — it must not re-open the net", async () => {
    // THE SECOND HALF OF THE FEEDBACK LOOP `settleChapterBalances` pinned above.
    // `chapterInterScopeRows` filtered settling legs on source/origin/mode and
    // never on `status`, while both spend sides go through `isSpend`, which
    // drops `status:"excluded"`. So the one move a human has to neutralise a bad
    // engine pair — marking it Excluded — took it off the spend side and left it
    // standing on the settled side.
    //
    // Production, 2026-08-09: a bogus $2,003.95 chapter→central `auto_settlement`
    // pair was set to `excluded` to kill it. The next morning the engine read it
    // as "New York has already paid central $2,003.95" and booked a fresh
    // central→chapter pair for $2,003.95 against a $0.00 base. That leg is
    // SIGNED, so $2,003.95 of book value moved for spending that does not exist
    // — and the new pair would have counted on the other side the morning after,
    // for ever. It nets to zero org-wide, so the reconciliation panel never
    // complained.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);

    // No card spend anywhere: nothing is owed in either direction.
    await seedSettlingPair(s, {
      amountCents: 200_395,
      direction: "chapter_to_central",
      status: "excluded",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-09`,
    });

    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(0);

    const out = await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-10",
    });
    expect(out.settlementsBooked).toBe(0);
    expect(await legsFor(s, `autosettle-${s.chapterId}-2026-08-10`)).toHaveLength(0);
  });

  test("the production shape: an excluded leg BESIDE a live one — the filter alone leaves the net unsettled", async () => {
    // THE CASE THE OTHER TWO TESTS MISS, and the one that matters operationally.
    // Production is not "an excluded leg on its own" — it is a THREE-ROUND pile:
    // real spend, the engine's honest settlement of it, the bogus excluded round
    // two, and the bogus live round three. Rounds two and three CANCEL on the
    // settled side, which is why the loop stopped rather than oscillating:
    //
    //   without the status filter: (22453 − 222848) − (0 − 200395) =      $0.00
    //   with it, nothing voided:   (22453 − 222848) − (0 −      0) = −$2,003.95
    //   with it, round three void: (22453 −  22453) − (0 −      0) =      $0.00
    //
    // So production sits at a WRONG but STABLE fixed point, and adding the
    // filter takes the net NEGATIVE and books a fourth round on the next cron.
    // The filter is correct and it is not sufficient: it has to ship with the
    // cleanup that voids round three. Anyone tempted to land one without the
    // other should read the middle line above.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedCrossBookSpend(s, 22_453); // the 4 real rows, as one

    // Round one: the engine's honest settlement of that spend.
    await seedSettlingPair(s, {
      amountCents: 22_453,
      direction: "central_to_chapter",
      status: "reconciled",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-07`,
    });
    // Round two: bogus, neutralised by a human with `excluded`.
    await seedSettlingPair(s, {
      amountCents: 200_395,
      direction: "chapter_to_central",
      status: "excluded",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-09`,
    });
    // Round three: booked BECAUSE round two was excluded, and still live.
    await seedSettlingPair(s, {
      amountCents: 200_395,
      direction: "central_to_chapter",
      status: "reconciled",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-10`,
    });

    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      -200_395,
    );

    // …and the engine acts on it: round four, in the opposite direction.
    const four = await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-11",
    });
    expect(four.settlementsBooked).toBe(1);
    const fourLegs = await legsFor(s, `autosettle-${s.chapterId}-2026-08-11`);
    expect(fourLegs).toHaveLength(2);
    expect(fourLegs[0]?.transferDirection).toBe("chapter_to_central");
    expect(fourLegs[0]?.amountCents).toBe(200_395);
  });

  test("voiding round three is what actually settles it", async () => {
    // The other half of the pair above: with round three excluded — which is
    // what `reverseExcludedSettlementLoop.voidLoopedAutoSettlement` does — the
    // net is 0 and the engine has nothing left to book. This is the end state
    // the cleanup is aiming at, pinned so a future edit to either the filter or
    // the runner has to keep hitting it.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedCrossBookSpend(s, 22_453);
    await seedSettlingPair(s, {
      amountCents: 22_453,
      direction: "central_to_chapter",
      status: "reconciled",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-07`,
    });
    await seedSettlingPair(s, {
      amountCents: 200_395,
      direction: "chapter_to_central",
      status: "excluded",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-09`,
    });
    await seedSettlingPair(s, {
      amountCents: 200_395,
      direction: "central_to_chapter",
      status: "excluded", // ← voided by the cleanup
      transferGroupId: `autosettle-${s.chapterId}-2026-08-10`,
    });

    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(0);
    const out = await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-11",
    });
    expect(out.settlementsBooked).toBe(0);
  });

  test("a LIVE settling leg still settles — the status test is not a blanket drop", async () => {
    // The guard above must not be satisfiable by ignoring settling legs
    // wholesale: an identical pair left `reconciled` has to keep paying its
    // direction down, exactly as it did before.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedCrossBookSpend(s, 30_000); // central owes the chapter $300

    await seedSettlingPair(s, {
      amountCents: 30_000,
      direction: "central_to_chapter",
      status: "reconciled",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-09`,
    });

    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(0);
    const out = await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-10",
    });
    expect(out.settlementsBooked).toBe(0);
  });

  test("engine pairs never touch the City Launch Fund position", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);

    // One engine allocation + one engine settlement + one MANUAL transfer.
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_7",
      amountCents: 5_000,
    });
    await seedDetectedPayout(s, { stripePayoutId: "po_7", amountCents: 4_825 });
    await t.mutation(internal.reconciliation.applyPayoutAllocation, {
      stripePayoutId: "po_7",
      items: [
        { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_7" },
      ],
    });
    await seedCrossBookSpend(s, 10_000);
    await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-07",
    });
    await s.as.mutation(api.transfers.recordTransfer, {
      direction: "central_to_chapter",
      chapterId: s.chapterId,
      amountCents: 50_000,
      postedAt: Date.now(),
      note: "Launch grant",
    });

    const now = new Date();
    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
    });
    // ONLY the manual transfer counts — engine rows are excluded.
    expect(dash.cityLaunchFund.launchGrantsMadeCents).toBe(50_000);
    expect(dash.cityLaunchFund.skimsReceivedCents).toBe(0);
  });
});

// ── signedBookCents (the accounts-page book value) ───────────────────────────

/** Give a scope a cached bank balance, the way the engine's snapshot step does. */
async function seedBankBalance(
  s: ChapterSetup,
  scope: Id<"chapters"> | typeof CENTRAL,
  balanceCents: number,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId: scope,
      increaseAccountId: `acct_${String(scope).slice(0, 8)}`,
      onboardingStatus: "active",
      balanceCents,
      balanceAsOf: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

// ── Balance settlement — the model that replaced per-payout allocation ───────
// Every payout lands in central's account, so central holds what the chapters
// earned. Rather than itemise each payout back to the record that produced it,
// the engine compares each chapter's BOOK to its BANK and moves the difference.

/** Turn on real cash movement the way the FM does from the accounts page —
 *  the standing authorization `settleChapterBalances` now requires before it
 *  will book a `balance_settlement` pair (see that function's doc: a
 *  settlement nothing will ever execute is not a ledger event). */
async function enableRealMovement(s: ChapterSetup): Promise<void> {
  await s.as.mutation(api.reconciliation.setRealMovementEnabled, {
    enabled: true,
  });
}

describe("settleChapterBalances — cash follows the book", () => {
  const DAY = "2026-08-08";

  test("a skipped chapter does not eat the pool the next one needs", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const s2 = await setupChapter(t, { chapterName: "Chicago" });
    await asCentralEd(s);
    await enableRealMovement(s);
    // Central holds $1,000 of chapter cash (no central book of its own), and
    // TWO chapters are each owed $500. The first already has a settlement in
    // flight, so it must be skipped — and skipping must RELEASE its share, or
    // the second chapter is starved by money that was never sent.
    await seedBankBalance(s, CENTRAL, 100_000);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 50_000 });
    await seedBankBalance(s, s.chapterId, 0);
    await seedDonorWithGift(s, s2.chapterId, { amountCents: 50_000 });
    await seedBankBalance(s, s2.chapterId, 0);
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "transfer",
        flow: "transfer",
        amountCents: 50_000,
        postedAt: Date.now(),
        status: "reconciled",
        transferOrigin: "balance_settlement",
        transferGroupId: `balsettle-${s.chapterId}-2026-08-08-1`,
        transferDirection: "central_to_chapter",
        createdAt: Date.now(),
      }),
    );

    const out = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );

    // Chicago still gets its full $500 — the skipped chapter reserved nothing.
    expect(out.settlementsBooked).toBe(1);
    expect(out.movedCents).toBe(50_000);
  });

  test("a pre-fix settlement is never executed as real cash", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    // Production's shape: booked 2026-08-17, after real movement was enabled,
    // so the pre-enable filter does not catch it — but priced under the old
    // raw-bank bound, i.e. possibly fronted.
    const stale = Date.UTC(2026, 7, 17, 9, 30);
    // Real movement enabled BEFORE the stale pair was booked — production's
    // exact sequence (04:34, then 09:30). Without this the pre-enable filter
    // excludes the pair on its own and the assertion below proves nothing
    // about the floor.
    await run(s.t, async (ctx) => {
      const settings = await ctx.db.query("financeSettings").first();
      if (settings) {
        await ctx.db.patch(settings._id, {
          autoTransferRealMovementSinceMs: Date.UTC(2026, 7, 17, 4, 34),
        });
      }
    });
    await run(s.t, async (ctx) => {
      for (const scope of [CENTRAL, s.chapterId]) {
        await ctx.db.insert("transactions", {
          chapterId: scope,
          source: "transfer",
          flow: "transfer",
          amountCents: 265_667,
          postedAt: stale,
          status: "reconciled",
          transferOrigin: "balance_settlement",
          transferGroupId: `balsettle-${s.chapterId}-2026-08-17`,
          transferDirection: "central_to_chapter",
          createdAt: stale,
        });
      }
    });

    const pairs = await t.query(
      internal.reconciliation.listUnexecutedEnginePairs,
      {},
    );

    expect(pairs.map((p) => p.transferGroupId)).not.toContain(
      `balsettle-${s.chapterId}-2026-08-17`,
    );
  });

  test("central does NOT front a chapter whose money is still clearing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    // The owner's case (2026-08-17). Central holds $5,000 of ITS OWN money —
    // seeded as central revenue so its book equals its bank. Chicago has just
    // raised $1,000 that is still clearing at Stripe: its book says $1,000,
    // its bank says $0.
    await seedDonorWithGift(s, CENTRAL, { amountCents: 500_000 });
    await seedBankBalance(s, CENTRAL, 500_000);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 100_000 });
    await seedBankBalance(s, s.chapterId, 0);

    const out = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );

    // Central COULD send $1,000 — it is sitting in the account. It must not:
    // that is central's own money, and the chapter's has not arrived.
    expect(out.settlementsBooked).toBe(0);
    expect(out.movedCents).toBe(0);
    expect(await settlementLegsFor(s, `balsettle-${s.chapterId}-`)).toHaveLength(0);
  });

  test("…and settles the moment that money actually lands", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    // Same books as above, except the $1,000 has now cleared into central's
    // account: bank $6,000 against central's own book of $5,000, so exactly
    // $1,000 is distributable and it belongs to the chapter.
    await seedDonorWithGift(s, CENTRAL, { amountCents: 500_000 });
    await seedBankBalance(s, CENTRAL, 600_000);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 100_000 });
    await seedBankBalance(s, s.chapterId, 0);

    const out = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );

    expect(out.settlementsBooked).toBe(1);
    expect(out.movedCents).toBe(100_000);
  });

  test("moves a chapter the gap between its book and its bank", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    // The chapter earned $500 and holds $100.
    await seedDonorWithGift(s, s.chapterId, { amountCents: 50_000 });
    await seedBankBalance(s, CENTRAL, 100_000);
    await seedBankBalance(s, s.chapterId, 10_000);

    const out = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );
    expect(out.settlementsBooked).toBe(1);
    expect(out.movedCents).toBe(40_000);

    const legs = await settlementLegsFor(s, `balsettle-${s.chapterId}-`);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.transferOrigin === "balance_settlement")).toBe(true);
    expect(legs.every((l) => l.amountCents === 40_000)).toBe(true);
    expect(legs.every((l) => l.transferDirection === "central_to_chapter")).toBe(true);
  });

  test("sends only what central actually holds, and says so", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 50_000 });
    await seedBankBalance(s, CENTRAL, 12_000); // central can't cover $400
    await seedBankBalance(s, s.chapterId, 10_000);

    const out = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );
    // Booking the full $400 would create a pair the ledger claims happened and
    // the bank refuses to execute.
    expect(out.movedCents).toBe(12_000);
    expect(out.notes.join(" ")).toMatch(/the rest once more clears/);
  });

  test("pulls the excess back when a chapter holds more than its book", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 10_000 });
    await seedBankBalance(s, CENTRAL, 100_000);
    await seedBankBalance(s, s.chapterId, 30_000);

    const out = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );
    expect(out.settlementsBooked).toBe(1);
    const legs = await settlementLegsFor(s, `balsettle-${s.chapterId}-`);
    expect(legs.every((l) => l.transferDirection === "chapter_to_central")).toBe(true);
    expect(legs[0].amountCents).toBe(20_000);
  });

  test("ignores drift too small to be worth a ledger row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 10_000 });
    await seedBankBalance(s, CENTRAL, 100_000);
    await seedBankBalance(s, s.chapterId, 9_900); // $1 out

    const out = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );
    expect(out.settlementsBooked).toBe(0);
  });

  test("its own pairs are not read back as cross-book card spend", async () => {
    // THE FEEDBACK LOOP THIS PINS. `chapterInterScopeRows` treats a
    // central↔chapter transfer leg as SETTLING cross-book card debt. A balance
    // settlement pays down no such debt — it moves a chapter the cash its book
    // says it is owed — but until it was excluded there, a $2,003.95
    // central→chapter settlement read as "central has already paid the chapter
    // $2,003.95", flipped the cross-book net, and made `runAutoSettlement` book
    // an opposing $2,003.95 chapter→central pair.
    //
    // That pair is SIGNED where a balance settlement contributes zero, so each
    // round shifted real book value with no spending behind it — and the next
    // run would have done it again the other way, for ever.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 50_000 });
    await seedBankBalance(s, CENTRAL, 100_000);
    await seedBankBalance(s, s.chapterId, 10_000);

    await t.mutation(internal.reconciliation.settleChapterBalances, {
      dateStr: DAY,
    });
    expect(await settlementLegsFor(s, `balsettle-${s.chapterId}-`)).toHaveLength(2);

    // With no card spend anywhere, the auto settlement must find nothing to do.
    const auto = await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: DAY,
    });
    expect(auto.settlementsBooked).toBe(0);
    expect(await legsFor(s, `autosettle-${s.chapterId}-${DAY}`)).toHaveLength(0);
  });

  test("is idempotent across a same-day re-run", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await enableRealMovement(s);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 50_000 });
    await seedBankBalance(s, CENTRAL, 100_000);
    await seedBankBalance(s, s.chapterId, 10_000);

    await t.mutation(internal.reconciliation.settleChapterBalances, { dateStr: DAY });
    // A manual "Run now" after the cron must not book the movement twice.
    const second = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );
    expect(second.settlementsBooked).toBe(0);
    expect(await settlementLegsFor(s, `balsettle-${s.chapterId}-`)).toHaveLength(2);
  });

  test("books NOTHING while real cash movement is off, and says why through notes", async () => {
    // THE bug this gate closes: a `balance_settlement` pair contributes zero
    // to book value by construction, so with nothing to ever execute it, it
    // never closes the gap it measures — the identical pair would get booked
    // again every morning forever (founder: "it creates actual things on the
    // ledger which is just wrong and cluttered"). Real movement is OFF by
    // default here (no `enableRealMovement` call).
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 50_000 });
    await seedBankBalance(s, CENTRAL, 100_000);
    await seedBankBalance(s, s.chapterId, 10_000);

    const out = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );
    // Nothing booked, nothing claimed moved — the return shape stays honest.
    expect(out.settlementsBooked).toBe(0);
    expect(out.movedCents).toBe(0);
    // No ledger rows at all — this is the "actual things on the ledger"
    // complaint closing: NOTHING is written when nothing will ever execute.
    expect(await settlementLegsFor(s, `balsettle-${s.chapterId}-`)).toHaveLength(0);
    // The finding is not lost — it travels through the run-summary `notes`
    // channel the accounts page already renders.
    const note = out.notes.join(" ");
    expect(note).toContain("New York"); // setupChapter's default chapter name
    expect(note).toMatch(/real cash movement is off/);
    // AND through the typed `unsettledGaps` channel — the one the accounts
    // page renders unconditionally, unlike `notes` (capped, collapsible).
    // This is what closes the finding that `notes` alone is not enough.
    expect(out.unsettledGaps).toHaveLength(1);
    expect(out.unsettledGaps[0]).toMatchObject({
      scopeName: "New York",
      bookBalanceCents: 50_000,
      bankBalanceCents: 10_000,
      gapCents: 40_000, // book above bank — the chapter is owed $400
    });
  });

  test("resumes booking once real cash movement is turned on", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedDonorWithGift(s, s.chapterId, { amountCents: 50_000 });
    await seedBankBalance(s, CENTRAL, 100_000);
    await seedBankBalance(s, s.chapterId, 10_000);

    // Off: measured but not booked.
    const off = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );
    expect(off.settlementsBooked).toBe(0);
    expect(await settlementLegsFor(s, `balsettle-${s.chapterId}-`)).toHaveLength(0);
    expect(off.unsettledGaps).toHaveLength(1);

    // On: the SAME day's re-run now books it — turning the toggle on does not
    // require waiting for tomorrow's date to pick the gap back up.
    await enableRealMovement(s);
    const on = await t.mutation(
      internal.reconciliation.settleChapterBalances,
      { dateStr: DAY },
    );
    expect(on.settlementsBooked).toBe(1);
    expect(on.movedCents).toBe(40_000);
    // Booked now, so nothing is left standing unreported.
    expect(on.unsettledGaps).toHaveLength(0);
    const legs = await settlementLegsFor(s, `balsettle-${s.chapterId}-`);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.transferOrigin === "balance_settlement")).toBe(true);
  });
});

describe("signedBookCents — every ledger shape signs correctly", () => {
  const base = {
    amountCents: 1_000,
    status: "reconciled",
  } as unknown as Doc<"transactions">;
  const tr = (over: Partial<Doc<"transactions">>): Doc<"transactions"> =>
    ({ ...base, ...over }) as Doc<"transactions">;

  test("plain flows and exclusions", () => {
    expect(signedBookCents(tr({ flow: "inflow" }))).toBe(1_000);
    expect(signedBookCents(tr({ flow: "outflow" }))).toBe(-1_000);
    expect(signedBookCents(tr({ flow: "inflow", status: "excluded" }))).toBe(0);
  });

  test("pair legs sign by direction + own scope", () => {
    const chapterId = "ch_1" as Id<"chapters">;
    const pair = (
      scope: typeof CENTRAL | Id<"chapters">,
      direction: "central_to_chapter" | "chapter_to_central",
    ) =>
      tr({
        flow: "transfer",
        source: "transfer",
        chapterId: scope,
        transferDirection: direction,
      });
    expect(signedBookCents(pair(CENTRAL, "central_to_chapter"))).toBe(-1_000);
    expect(signedBookCents(pair(chapterId, "central_to_chapter"))).toBe(1_000);
    expect(signedBookCents(pair(CENTRAL, "chapter_to_central"))).toBe(1_000);
    expect(signedBookCents(pair(chapterId, "chapter_to_central"))).toBe(-1_000);
  });

  test("revenue's bank arrivals contribute ZERO — counted once at the gifts/tickets layer", () => {
    // A labeled/engine-matched payout deposit is the cash arrival of
    // already-counted revenue.
    expect(
      signedBookCents(tr({ flow: "inflow", payoutProcessor: "stripe" })),
    ).toBe(0);
    expect(
      signedBookCents(tr({ flow: "inflow", stripePayoutId: "po_1" })),
    ).toBe(0);
    // A payout-allocation pair leg redistributes that same deposit.
    expect(
      signedBookCents(
        tr({
          flow: "transfer",
          source: "transfer",
          transferOrigin: "payout_allocation",
          transferDirection: "central_to_chapter",
          chapterId: "ch_1" as Id<"chapters">,
        }),
      ),
    ).toBe(0);
  });

  test("a balance settlement contributes nothing, so the target can't chase itself", () => {
    // Crediting a chapter's book for its own top-up would raise the very number
    // the top-up aims at, and the engine would move money every morning forever.
    for (const chapterId of ["ch_1" as Id<"chapters">, CENTRAL]) {
      expect(
        signedBookCents(
          tr({
            flow: "transfer",
            transferOrigin: "balance_settlement",
            transferDirection: "central_to_chapter",
            chapterId,
          }),
        ),
      ).toBe(0);
    }
  });

  test("a marked bank transfer contributes NOTHING to either book", () => {
    // Cash moving between accounts the org already owns is neither earning nor
    // spending, so it changes no book's VALUE — only where the cash sits.
    //
    // This test used to assert the opposite (−1000 / +1000, the bank's own
    // direction). The founder's $2,873.21 Central→New York move is what showed
    // that model wrong: New York's Stripe payouts land in Central's account, so
    // moving them on took $2,873.21 off Central for revenue Central never
    // earned, and credited New York twice for revenue it had earned once. The
    // engine already treats its own version of that delivery as valueless
    // (`payout_allocation` legs return 0); a hand-marked one now agrees.
    expect(
      signedBookCents(tr({ flow: "transfer", preMarkFlow: "outflow" })),
    ).toBe(0);
    expect(
      signedBookCents(tr({ flow: "transfer", preMarkFlow: "inflow" })),
    ).toBe(0);
    // `preMarkFlow` is read BEFORE `flow`. A half-unmarked pair exists in
    // production — one leg back to `flow:"outflow"` with `preMarkFlow` never
    // cleared — and reading `flow` first would zero one leg while keeping the
    // other, turning a pair that nets to nothing into a $1,000 hole.
    expect(
      signedBookCents(tr({ flow: "outflow", preMarkFlow: "outflow" })),
    ).toBe(0);
    expect(
      signedBookCents(tr({ flow: "transfer", source: "repayment" })),
    ).toBe(1_000);
    // Historical implied-direction kinds.
    expect(
      signedBookCents(
        tr({ flow: "transfer", source: "skim", chapterId: CENTRAL }),
      ),
    ).toBe(1_000);
    expect(
      signedBookCents(
        tr({
          flow: "transfer",
          source: "launch_grant",
          chapterId: "ch_1" as Id<"chapters">,
        }),
      ),
    ).toBe(1_000);
    // Unknown transfer shape → 0, never a guess.
    expect(signedBookCents(tr({ flow: "transfer", source: "manual" }))).toBe(0);
  });
});

// ── Audit surface: gating, balances, history, flags ──────────────────────────

describe("audit surface — accounts-page queries + flags", () => {
  test("everything is ED/FM-gated; a plain member is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);
    await expect(
      s.as.query(api.reconciliation.accountBalances, {}),
    ).rejects.toThrow(/Executive Director and Financial Manager/i);
    await expect(
      s.as.query(api.reconciliation.reconciliationOverview, {}),
    ).rejects.toThrow(/Executive Director and Financial Manager/i);
    await expect(
      s.as.mutation(api.reconciliation.setReconciliationPaused, {
        paused: true,
      }),
    ).rejects.toThrow(/Executive Director and Financial Manager/i);
    expect(await s.as.query(api.reconciliation.canViewReconciliation, {})).toBe(
      false,
    );
  });

  test("accountBalances: book value reflects engine pairs; history shows origin + payout id", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_8",
      amountCents: 5_000,
    });
    // Central's bank deposit for the payout…
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "increase_ach",
        flow: "inflow",
        amountCents: 4_825,
        currency: "usd",
        postedAt: Date.now(),
        merchantName: "STRIPE",
        status: "unreviewed",
        externalId: "transaction_dep_8",
        createdAt: Date.now(),
      }),
    );
    await seedDetectedPayout(s, { stripePayoutId: "po_8", amountCents: 4_825 });
    await t.mutation(internal.reconciliation.applyPayoutAllocation, {
      stripePayoutId: "po_8",
      items: [
        { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_8" },
      ],
    });

    const balances = await s.as.query(api.reconciliation.accountBalances, {});
    const central = balances.find((b) => b.scope === CENTRAL);
    const chapter = balances.find((b) => b.scope === s.chapterId);
    // Founder model: money-in from the GIVING layer, not bank arrivals.
    // Central earned nothing; its matched deposit + allocation outflow leg
    // both contribute 0 to the ledger side (revenue counted once).
    expect(central?.bookBalanceCents).toBe(0);
    expect(central?.revenueCents).toBe(0);
    expect(central?.ledgerNetCents).toBe(0);
    // Chapter: the $50 gift is its revenue (gross of Stripe's $1.75 fee);
    // the allocation inflow leg contributes 0 — no double-count.
    expect(chapter?.bookBalanceCents).toBe(5_000);
    expect(chapter?.revenueCents).toBe(5_000);
    expect(chapter?.ledgerNetCents).toBe(0);

    const history = await s.as.query(api.reconciliation.listTransferHistory, {});
    expect(history.length).toBe(1);
    expect(history[0]?.origin).toBe("payout_allocation");
    expect(history[0]?.stripePayoutId).toBe("po_8");
    expect(history[0]?.chapterName).toBe("New York");
  });

  test("accountBalances: a sale is revenue, gross of the Stripe fee", async () => {
    // Third revenue stream (founder model 2026-08-07). In-person sales never reached
    // the books at all, so their cash sat in the bank with no revenue behind it.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("sales", {
        chapterId: s.chapterId,
        stripeChargeId: "ch_test_1",
        soldAt: Date.now(),
        grossCents: 3_000,
        feeCents: 117,
        items: [{ label: "PW Tee", quantity: 1, unitPriceCents: 3_000, candidates: ["PW Tee"] }],
        itemSource: "amount_decomposition",
        channel: "in_person",
        createdAt: Date.now(),
      }),
    );
    const balances = await s.as.query(api.reconciliation.accountBalances, {});
    const chapter = balances.find((b) => b.scope === s.chapterId);
    // Gross, not net — the fee is an expense, not a haircut on what was sold.
    expect(chapter?.revenueCents).toBe(3_000);
    expect(chapter?.bookBalanceCents).toBe(3_000);
  });

  test("accountBalances: an in-kind gift is revenue, and nets to zero against its expense", async () => {
    // Founder decision 2026-08-07. In-kind gifts used to be excluded from revenue
    // because no cash arrives — but the expense they paid for IS in the ledger, so
    // excluding only the revenue side counted the cost and not the contribution and
    // pushed a book negative for being given things. The pair must net to zero.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: s.chapterId, kind: "individual", name: "Founder", status: "active",
        lifetimeCents: 50_000, giftCount: 1, createdAt: Date.now(),
      });
      await ctx.db.insert("gifts", {
        donorId, scope: s.chapterId, amountCents: 50_000, currency: "usd",
        receivedAt: Date.now(), method: "in_kind", createdAt: Date.now(),
      });
      // The gear they bought for the org — the expense side of the same act.
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId, source: "manual", flow: "outflow",
        amountCents: 50_000, currency: "usd", postedAt: Date.now(),
        description: "Gear bought personally", status: "categorized",
        createdAt: Date.now(),
      });
    });

    const balances = await s.as.query(api.reconciliation.accountBalances, {});
    const chapter = balances.find((b) => b.scope === s.chapterId);
    expect(chapter?.revenueCents).toBe(50_000);
    expect(chapter?.ledgerNetCents).toBe(-50_000);
    // The whole point: being given $500 of gear leaves the book where it started,
    // not $500 in the hole.
    expect(chapter?.bookBalanceCents).toBe(0);
  });

  test("accountBalances: ticket sales are revenue; ledger spend subtracts", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedTicketOrder(s, 2_500); // a paid GA ticket
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 1_000,
        postedAt: Date.now(),
        status: "categorized",
        createdAt: Date.now(),
      }),
    );

    const balances = await s.as.query(api.reconciliation.accountBalances, {});
    const chapter = balances.find((b) => b.scope === s.chapterId);
    expect(chapter?.revenueCents).toBe(2_500);
    expect(chapter?.ledgerNetCents).toBe(-1_000);
    expect(chapter?.bookBalanceCents).toBe(1_500);
  });

  /**
   * PENDING ACH IS NOT MONEY, AND BOOK VALUE MUST NOT NOTICE IT.
   *
   * The giving digest now reports in-flight bank debits (`pendingGifts`, added
   * so the weekly email can say how much of its total hasn't cleared). The
   * entire risk of that feature is this: the org spent months closing the
   * book-vs-bank gap to exactly $0.00, and counting authorised-but-unmoved
   * money as revenue would reopen it by the size of whatever is in flight.
   *
   * The guard is that book value reads `gifts` and `transactions` and nothing
   * else, so this asserts the number is IDENTICAL before and after a pending
   * row exists — not merely "still plausible". Every other property of the
   * feature is a matter of wording; this one is a matter of money.
   */
  test("accountBalances: an in-flight ACH gift moves NOTHING — not revenue, not book value", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedTicketOrder(s, 2_500); // a paid GA ticket — some real revenue

    const before = await s.as.query(api.reconciliation.accountBalances, {});
    const beforeChapter = before.find((b) => b.scope === s.chapterId);
    expect(beforeChapter?.revenueCents).toBe(2_500);
    expect(beforeChapter?.bookBalanceCents).toBe(2_500);

    // A $5,000 bank debit, authorised by a donor and not yet moved by the bank
    // — exactly what `givingPending.recordPendingGift` writes on the
    // `checkout.session.completed`-unsettled webhook.
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Bank Giver",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      });
      await ctx.db.insert("pendingGifts", {
        sessionId: "cs_in_flight",
        status: "in_flight",
        scope: s.chapterId,
        amountCents: 500_000,
        currency: "usd",
        submittedAt: Date.now(),
        donorName: "Bank Giver",
        donorId,
        createdAt: Date.now(),
      });
    });

    const after = await s.as.query(api.reconciliation.accountBalances, {});
    // Identical, row for row. Not "close" — the same numbers.
    expect(after).toEqual(before);
    const afterChapter = after.find((b) => b.scope === s.chapterId);
    expect(afterChapter?.revenueCents).toBe(2_500);
    expect(afterChapter?.ledgerNetCents).toBe(0);
    expect(afterChapter?.bookBalanceCents).toBe(2_500);

    // …and nothing leaked into either table book value is built from.
    const written = await run(s.t, async (ctx) => ({
      gifts: await ctx.db.query("gifts").collect(),
      transactions: await ctx.db.query("transactions").collect(),
    }));
    expect(written.gifts).toHaveLength(0);
    expect(written.transactions).toHaveLength(0);
  });

  test("flags: one open flag per artifact, resolvable with a note", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);

    const flagId = await s.as.mutation(
      api.reconciliation.flagReconciliationEntry,
      { kind: "payout", refKey: "po_9", note: "Looks off" },
    );
    // Double-tap → same flag, not a second row.
    const again = await s.as.mutation(
      api.reconciliation.flagReconciliationEntry,
      { kind: "payout", refKey: "po_9", note: "Looks off again" },
    );
    expect(again).toBe(flagId);

    await s.as.mutation(api.reconciliation.resolveReconciliationFlag, {
      flagId,
      resolutionNote: "Verified against the Stripe dashboard.",
    });
    const flag = await run(s.t, (ctx) => ctx.db.get(flagId));
    expect(flag?.status).toBe("resolved");
    expect(flag?.resolutionNote).toMatch(/Verified/);

    // An empty note is refused — the note IS the audit trail.
    await expect(
      s.as.mutation(api.reconciliation.flagReconciliationEntry, {
        kind: "transfer",
        refKey: "tg_1",
        note: "   ",
      }),
    ).rejects.toThrow(/note/i);
  });

  test("pause + start-date settings round-trip; ensureSince is forward-only", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);

    const stamped = await t.mutation(internal.reconciliation.ensureSince, {});
    expect(stamped).toBeGreaterThan(0);
    // Second call returns the SAME stamp (never re-stamps forward).
    expect(await t.mutation(internal.reconciliation.ensureSince, {})).toBe(
      stamped,
    );

    await s.as.mutation(api.reconciliation.setReconciliationPaused, {
      paused: true,
    });
    const overview = await s.as.query(
      api.reconciliation.reconciliationOverview,
      {},
    );
    expect(overview.paused).toBe(true);
    expect(overview.sinceMs).toBe(stamped);

    // FM backdates deliberately.
    await s.as.mutation(api.reconciliation.setReconciliationStart, {
      sinceMs: stamped - 1_000,
    });
    expect(
      (await s.as.query(api.reconciliation.reconciliationOverview, {})).sinceMs,
    ).toBe(stamped - 1_000);
  });

  test("beginRun refuses a concurrent second run", async () => {
    const t = newT();
    const first = await t.mutation(internal.reconciliation.beginRun, {
      trigger: "cron",
    });
    expect(first).not.toBeNull();
    const second = await t.mutation(internal.reconciliation.beginRun, {
      trigger: "webhook",
    });
    expect(second).toBeNull();
  });
});

// ── Real cash movement (default-off; DB seams of the execution step) ─────────
// The Increase POST itself lives in the action (network); these cover the
// seams the money depends on: which pairs are eligible, the both-legs stamp
// that also feeds `increaseLedger`'s already-booked guard, the account
// readiness read, and the FM-gated toggle.

describe("real cash movement — eligibility, stamping, toggle", () => {
  /** Direction (a) cross-book spend, same shape as the settlement suite's
   *  local helper (that one is scoped to its own describe). */
  async function seedCrossBookSpendFor(
    s: ChapterSetup,
    amountCents: number,
  ): Promise<void> {
    await run(s.t, async (ctx) => {
      const centralBudgetId = await ctx.db.insert("budgets", {
        chapterId: CENTRAL,
        amountCents: 100_000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        approvalStatus: "approved",
        createdAt: Date.now(),
      });
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents,
        postedAt: Date.now(),
        status: "categorized",
        budgetId: centralBudgetId,
        createdAt: Date.now(),
      });
    });
  }

  test("only UNSTAMPED ENGINE pairs booked AFTER enabling are eligible; manual pairs never execute", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);

    // Nothing is EVER eligible before real movement has been enabled.
    expect(
      await t.query(internal.reconciliation.listUnexecutedEnginePairs, {}),
    ).toHaveLength(0);

    // A pre-enable engine pair (the historical backlog) stays ineligible…
    await seedCrossBookSpendFor(s, 3_000);
    await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-07",
    });
    // Eligibility is "booked AT/AFTER the enable stamp", and both sides of that
    // comparison are `Date.now()` at millisecond resolution. In a test the pair
    // and the stamp can land in the SAME millisecond, which makes this
    // deliberately-pre-enable pair read as post-enable and fails the assertion
    // below — the whole flake, ~4 runs in 14. Production can't hit it (a human
    // flips the toggle days apart from a cron run), so the fix belongs here, not
    // in the comparison. One clear millisecond is enough to make it decisive.
    await new Promise((r) => setTimeout(r, 2));
    await s.as.mutation(api.reconciliation.setRealMovementEnabled, {
      enabled: true,
    });
    expect(
      await t.query(internal.reconciliation.listUnexecutedEnginePairs, {}),
    ).toHaveLength(0);

    // …a post-enable engine settlement pair is eligible…
    await seedCrossBookSpendFor(s, 10_000);
    await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-08",
    });
    // …and a MANUAL transfer (never eligible — it records cash that already
    // moved outside the app).
    await s.as.mutation(api.transfers.recordTransfer, {
      direction: "central_to_chapter",
      chapterId: s.chapterId,
      amountCents: 5_000,
      postedAt: Date.now(),
    });

    const pending = await t.query(
      internal.reconciliation.listUnexecutedEnginePairs,
      {},
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      transferGroupId: `autosettle-${s.chapterId}-2026-08-08`,
      chapterId: s.chapterId,
      direction: "central_to_chapter",
      amountCents: 10_000,
    });

    // Stamping marks BOTH legs and empties the eligible list; re-stamping is
    // a no-op that never overwrites the recorded transfer id.
    await t.mutation(internal.reconciliation.stampPairMoved, {
      transferGroupId: pending[0]!.transferGroupId,
      increaseTransferId: "account_transfer_1",
    });
    const legs = await legsFor(s, pending[0]!.transferGroupId);
    expect(legs.map((l) => l.externalId)).toEqual([
      "account_transfer_1",
      "account_transfer_1",
    ]);
    await t.mutation(internal.reconciliation.stampPairMoved, {
      transferGroupId: pending[0]!.transferGroupId,
      increaseTransferId: "account_transfer_2",
    });
    expect(
      (await legsFor(s, pending[0]!.transferGroupId)).map((l) => l.externalId),
    ).toEqual(["account_transfer_1", "account_transfer_1"]);
    expect(
      await t.query(internal.reconciliation.listUnexecutedEnginePairs, {}),
    ).toHaveLength(0);

    // A PRODUCTION-stamped settling leg still nets in the live balance
    // (matchesMode keeps prod ids) — the settlement stays paid-down. The
    // fixture's extra $50 MANUAL transfer over-settles: 10,000 owed −
    // 10,000 stamped auto-settle − 5,000 manual = −5,000. If the stamp had
    // dropped the auto-settle leg out of the mode filter, this would read
    // +5,000 instead.
    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      -5_000,
    );
  });

  test("a VOIDED pair is never wired to Increase — retracting a booking retracts the cash too", async () => {
    // The landmine this closes. `status:"excluded"` is how the app retracts a
    // booking that should never have happened (`reverseExcludedSettlementLoop`,
    // and the same `excluded` marker the settling-leg filter in
    // `transfers.ts#chapterInterScopeRows` was blind to). This list was blind to
    // it as well, and the only reason that has never cost money is that real
    // movement has never been switched on — the two engine pairs voided in
    // production so far would have been handed to Increase the next time it was
    // drained. Moving REAL money for a row the ledger says didn't happen is the
    // worst version of the bug this PR is about.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await s.as.mutation(api.reconciliation.setRealMovementEnabled, {
      enabled: true,
    });

    await seedCrossBookSpendFor(s, 10_000);
    await t.mutation(internal.reconciliation.runAutoSettlement, {
      dateStr: "2026-08-08",
    });
    const groupId = `autosettle-${s.chapterId}-2026-08-08`;
    expect(
      await t.query(internal.reconciliation.listUnexecutedEnginePairs, {}),
    ).toHaveLength(1);

    // Void it, the way the cleanup runners do.
    await run(s.t, async (ctx) => {
      for (const leg of await ctx.db
        .query("transactions")
        .withIndex("by_transfer_group", (q) => q.eq("transferGroupId", groupId))
        .collect()) {
        await ctx.db.patch(leg._id, { status: "excluded" });
      }
    });

    expect(
      await t.query(internal.reconciliation.listUnexecutedEnginePairs, {}),
    ).toHaveLength(0);
  });

  test("a payout pair moves cash only when its deposit really landed at Increase", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await s.as.mutation(api.reconciliation.setRealMovementEnabled, {
      enabled: true,
    });

    // Payout A: allocated but deposit NOT matched → ineligible.
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_rm1",
      amountCents: 5_000,
    });
    await seedDetectedPayout(s, { stripePayoutId: "po_rm1", amountCents: 4_825 });
    await t.mutation(internal.reconciliation.applyPayoutAllocation, {
      stripePayoutId: "po_rm1",
      items: [
        { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_rm1" },
      ],
    });
    expect(
      await t.query(internal.reconciliation.listUnexecutedEnginePairs, {}),
    ).toHaveLength(0);

    // Payout B: matched to an increase_ach deposit → eligible.
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_rm2",
      amountCents: 5_000,
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "increase_ach",
        flow: "inflow",
        amountCents: 4_825,
        currency: "usd",
        postedAt: Date.now(),
        merchantName: "STRIPE",
        status: "unreviewed",
        externalId: "transaction_rm2",
        createdAt: Date.now(),
      }),
    );
    await seedDetectedPayout(s, { stripePayoutId: "po_rm2", amountCents: 4_825 });
    await t.mutation(internal.reconciliation.applyPayoutAllocation, {
      stripePayoutId: "po_rm2",
      items: [
        { grossCents: 5_000, feeCents: 175, netCents: 4_825, invoiceId: "in_rm2" },
      ],
    });
    const pending = await t.query(
      internal.reconciliation.listUnexecutedEnginePairs,
      {},
    );
    expect(pending.map((p) => p.transferGroupId)).toEqual([
      `payoutalloc-po_rm2-${s.chapterId}`,
    ]);
  });

  test("productionAccountIds requires ACTIVE production accounts on both sides", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Only a SANDBOX chapter account + an active production central account.
    await run(s.t, async (ctx) => {
      await ctx.db.insert("increaseAccounts", {
        chapterId: "central",
        sandbox: false,
        increaseAccountId: "account_central",
        onboardingStatus: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: true,
        increaseAccountId: "sandbox_account_ch",
        onboardingStatus: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const ids = await t.query(internal.reconciliation.productionAccountIds, {
      chapterId: s.chapterId,
    });
    expect(ids.centralAccountId).toBe("account_central");
    expect(ids.chapterAccountId).toBeNull(); // sandbox row never qualifies
  });

  test("the toggle is FM-gated, defaults OFF, and round-trips", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);
    await expect(
      s.as.mutation(api.reconciliation.setRealMovementEnabled, {
        enabled: true,
      }),
    ).rejects.toThrow(/Executive Director and Financial Manager/i);

    const t2 = newT();
    const s2 = await setupChapter(t2);
    await asCentralEd(s2);
    expect(
      (await s2.as.query(api.reconciliation.reconciliationOverview, {}))
        .realMovement,
    ).toBe(false);
    await s2.as.mutation(api.reconciliation.setRealMovementEnabled, {
      enabled: true,
    });
    expect(
      (await s2.as.query(api.reconciliation.reconciliationOverview, {}))
        .realMovement,
    ).toBe(true);
  });
});
