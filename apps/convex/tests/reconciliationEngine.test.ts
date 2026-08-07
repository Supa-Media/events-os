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

  test("the bank deposit is found and labeled like markAsPayout would", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const arrival = Date.now();
    await seedDonorWithGift(s, s.chapterId, {
      stripeInvoiceId: "in_5",
      amountCents: 5_000,
    });
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

  test("marked bank transfers keep the bank's direction; special sources sign by meaning", () => {
    expect(
      signedBookCents(tr({ flow: "transfer", preMarkFlow: "outflow" })),
    ).toBe(-1_000);
    expect(
      signedBookCents(tr({ flow: "transfer", preMarkFlow: "inflow" })),
    ).toBe(1_000);
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
    // Central: +4825 deposit − 4825 allocation outflow leg = 0.
    expect(central?.bookBalanceCents).toBe(0);
    // Chapter: +4825 allocation inflow leg — its true value by morning.
    expect(chapter?.bookBalanceCents).toBe(4_825);

    const history = await s.as.query(api.reconciliation.listTransferHistory, {});
    expect(history.length).toBe(1);
    expect(history[0]?.origin).toBe("payout_allocation");
    expect(history[0]?.stripePayoutId).toBe("po_8");
    expect(history[0]?.chapterName).toBe("New York");
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
