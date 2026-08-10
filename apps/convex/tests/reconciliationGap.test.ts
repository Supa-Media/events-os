/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CENTRAL } from "@events-os/shared";
import {
  reconcileOrgMoney,
  addableBankPendingCents,
} from "../lib/reconciliationGap";

/**
 * DOES IT ADD UP? — the org-wide reconciliation gap.
 *
 * Two halves, deliberately:
 *
 *  1. `reconcileOrgMoney` on its own. It is pure, it is the whole answer, and
 *     the property that matters most (pending belongs on the CASH side, added
 *     back) is a sign error away from silently reporting a shortfall that
 *     doesn't exist. Testing it without a database means the assertions read as
 *     the arithmetic they are.
 *
 *  2. `reconciliationSummary` end to end, because the arithmetic being right is
 *     worth nothing if the query feeds it the wrong numbers — and the ways it
 *     could are specific: mixing sandbox accounts into a production total,
 *     dropping cash held in an account no live book claims, or reading book
 *     value on a different basis than the cash.
 *
 * Plus the obsolete-failure heal (`upsertDetectedPayout`), which is the other
 * half of "stop telling the treasurer something is wrong when it isn't".
 */

/**
 * The two winding-down piles, absent. Spread into a case that isn't about them
 * so each test still states every term it depends on, without restating the two
 * it doesn't. `givebutterConfigured: false` is the "this org has no Givebutter"
 * shape — the one where a null balance is a COMPLETE answer rather than a gap.
 */
const NO_LEGACY_PILES = {
  givebutterUndepositedCents: null,
  givebutterConfigured: false,
  relayBalanceCents: null,
} as const;

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

/** Central ED — passes `isCentralEdOrFm`, the reconciliation-audit power that
 *  gates every query on this page. Mirrors `reconciliationEngine.test.ts`. */
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
  });
  return personId;
}

/** An active production Increase account for a book, with cached balances. */
async function seedAccount(
  s: ChapterSetup,
  opts: {
    chapterId: Id<"chapters"> | "central";
    balanceCents?: number;
    pendingCents?: number;
    /** The measured booked slice. UNDEFINED IS A REAL STATE — no snapshot has
     *  split this total yet — and it is the state that puts the whole thing
     *  back on the cash side, so tests have to be able to seed both. */
    pendingAlreadyBookedCents?: number;
    pendingBreakdown?: {
      category: string;
      amountCents: number;
      count: number;
      alreadyBookedCents?: number;
    }[];
    sandbox?: boolean;
    increaseAccountId?: string;
  },
): Promise<Id<"increaseAccounts">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId: opts.chapterId,
      increaseAccountId:
        opts.increaseAccountId ??
        (opts.sandbox ? "sandbox_account_x" : "account_x"),
      onboardingStatus: "active",
      sandbox: opts.sandbox ?? false,
      ...(opts.balanceCents !== undefined
        ? { balanceCents: opts.balanceCents, balanceAsOf: Date.now() }
        : {}),
      ...(opts.pendingCents !== undefined
        ? { pendingCents: opts.pendingCents }
        : {}),
      ...(opts.pendingAlreadyBookedCents !== undefined
        ? { pendingAlreadyBookedCents: opts.pendingAlreadyBookedCents }
        : {}),
      ...(opts.pendingBreakdown !== undefined
        ? {
            pendingBreakdown: opts.pendingBreakdown,
            pendingBreakdownAsOf: Date.now(),
          }
        : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** A gift on a book — the revenue half of book value. */
async function seedGift(
  s: ChapterSetup,
  scope: Id<"chapters"> | "central",
  amountCents: number,
  method: "stripe" | "in_kind" = "stripe",
): Promise<void> {
  await run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope,
      kind: "individual",
      name: "Donor",
      status: "active",
      lifetimeCents: amountCents,
      giftCount: 1,
      createdAt: Date.now(),
    });
    await ctx.db.insert("gifts", {
      donorId,
      scope,
      amountCents,
      currency: "usd",
      receivedAt: Date.now(),
      method,
      createdAt: Date.now(),
    });
  });
}

// ── The arithmetic, on its own ───────────────────────────────────────────────

describe("reconcileOrgMoney — the arithmetic", () => {
  test("pending is added BACK to the cash side, not subtracted", () => {
    // THE test. Book value has not deducted a pending authorization (it never
    // reached the ledger) while `available_balance` already has, so the two are
    // on different bases until pending is added back. Get this backwards and
    // the page reports a shortfall of exactly twice the pending total, out of
    // nothing.
    const r = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 90_000,
      bankPendingCents: 10_000,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      ...NO_LEGACY_PILES,
    });
    expect(r.locatedCents).toBe(100_000);
    expect(r.differenceCents).toBe(0);
    expect(r.verdict).toBe("balanced");
  });

  test("money still at Stripe counts as money we can point at", () => {
    // Revenue is counted at the gift/ticket, days before the payout. Without
    // this term the books legitimately exceed the banks by whatever is in
    // transit, and the page would call that a finding every single day.
    const r = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 70_000,
      bankPendingCents: 0,
      stripeAvailableCents: 5_000,
      stripePendingCents: 25_000,
      ...NO_LEGACY_PILES,
    });
    expect(r.locatedCents).toBe(100_000);
    expect(r.verdict).toBe("balanced");
  });

  test("the SIGN is the diagnosis, both ways", () => {
    const short = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 95_000,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      ...NO_LEGACY_PILES,
    });
    expect(short.differenceCents).toBe(-5_000);
    expect(short.verdict).toBe("books_exceed_cash");

    const over = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 105_000,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      ...NO_LEGACY_PILES,
    });
    expect(over.differenceCents).toBe(5_000);
    expect(over.verdict).toBe("cash_exceeds_books");
  });

  test("a cent is a difference — there is no tolerance band", () => {
    const r = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 99_999,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      ...NO_LEGACY_PILES,
    });
    expect(r.verdict).toBe("books_exceed_cash");
    expect(r.differenceCents).toBe(-1);
  });

  test("a never-fetched Stripe balance is flagged, not silently zeroed", () => {
    // Coercing null to 0 would manufacture a gap the size of whatever is
    // actually at Stripe, and present it with the same confidence as a real
    // one. The total still renders (a page with no number is no use) but the
    // caller is told it is short.
    const r = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 100_000,
      bankPendingCents: 0,
      stripeAvailableCents: null,
      stripePendingCents: null,
      ...NO_LEGACY_PILES,
    });
    expect(r.incomplete).toBe(true);
    expect(r.stripeTotalCents).toBeNull();
    expect(r.locatedCents).toBe(100_000);

    const known = reconcileOrgMoney({
      bookValueCents: 0,
      bankAvailableCents: 0,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: null,
      ...NO_LEGACY_PILES,
    });
    // A zero Stripe balance IS a fetched fact. Only "neither half has ever
    // landed" counts as unknown.
    expect(known.incomplete).toBe(false);
    expect(known.stripeTotalCents).toBe(0);
  });

  // ── The two winding-down piles: Givebutter and Relay ──────────────────────

  test("Givebutter's undeposited balance is CASH, not a second helping of revenue", () => {
    // THE double-count test, and the reason it matters: the Givebutter sync
    // writes each ticket and gift into `ticketOrders`/`gifts` the moment it
    // happens, so that money is ALREADY inside book value days before Givebutter
    // remits it. It is missing from the CASH side, not from the books.
    //
    // These are the real production figures from 2026-08-08: $75.00 outstanding
    // at Givebutter, being three $25 tickets on the synced "Public Worship Field
    // Day" campaign, every one of which was present as a `paid` ticketOrders row.
    // Book value counts paid ticket orders, so with the cash located the two
    // sides land exactly level.
    const r = reconcileOrgMoney({
      bookValueCents: 7_500,
      bankAvailableCents: 0,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      givebutterUndepositedCents: 7_500,
      givebutterConfigured: true,
      relayBalanceCents: null,
    });
    expect(r.locatedCents).toBe(7_500);
    expect(r.differenceCents).toBe(0);
    expect(r.verdict).toBe("balanced");
    expect(r.incomplete).toBe(false);

    // And the failure this pins down. Had the term been applied to the BOOKS
    // side instead — the plausible-looking mistake, since the money is "already
    // counted" — the same inputs would report the org holding $75 it does not
    // have, and the panel would send a treasurer hunting for unrecorded income
    // that never existed.
    const ifItHadGoneOnTheBooksSide = reconcileOrgMoney({
      bookValueCents: 7_500 + 7_500,
      bankAvailableCents: 0,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      ...NO_LEGACY_PILES,
    });
    expect(ifItHadGoneOnTheBooksSide.differenceCents).toBe(-15_000);
    expect(r.differenceCents).not.toBe(
      ifItHadGoneOnTheBooksSide.differenceCents,
    );
  });

  test("a CONFIGURED Givebutter that has never been read is a knowledge gap", () => {
    const r = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 100_000,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      givebutterUndepositedCents: null,
      givebutterConfigured: true,
      relayBalanceCents: null,
    });
    // The sides happen to match, but Givebutter could be holding anything, so
    // this must not be presented as a reconciliation.
    expect(r.verdict).toBe("balanced");
    expect(r.missingTerms).toEqual(["givebutter"]);
    expect(r.incomplete).toBe(true);
  });

  test("an UNCONFIGURED Givebutter is not missing — there is nothing to miss", () => {
    // The regression this exists to prevent: treating "no balance" as "unread"
    // would permanently mark every deployment that never used Givebutter as
    // unreconcilable, and the panel would never again be able to say "it adds
    // up" for anyone.
    const r = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 100_000,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      givebutterUndepositedCents: null,
      givebutterConfigured: false,
      relayBalanceCents: null,
    });
    expect(r.missingTerms).toEqual([]);
    expect(r.incomplete).toBe(false);
  });

  test("a recorded Relay balance is money we can point at", () => {
    // $56.93, the figure the founder read off Relay on 2026-08-08. Hand-entered,
    // but once entered it is a pile like any other and belongs in the total.
    const r = reconcileOrgMoney({
      bookValueCents: 5_693,
      bankAvailableCents: 0,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      givebutterUndepositedCents: null,
      givebutterConfigured: false,
      relayBalanceCents: 5_693,
    });
    expect(r.locatedCents).toBe(5_693);
    expect(r.verdict).toBe("balanced");
  });

  test("an unrecorded Relay balance never blocks the verdict", () => {
    // Unlike a processor, "nobody typed a number" and "this org has no Relay"
    // are indistinguishable states, so this term must not be able to declare the
    // reconciliation incomplete. The panel names the absence in its leads
    // instead — visible without being load-bearing.
    const r = reconcileOrgMoney({
      bookValueCents: 100_000,
      bankAvailableCents: 100_000,
      bankPendingCents: 0,
      stripeAvailableCents: 0,
      stripePendingCents: 0,
      givebutterUndepositedCents: null,
      givebutterConfigured: false,
      relayBalanceCents: null,
    });
    expect(r.missingTerms).toEqual([]);
    expect(r.incomplete).toBe(false);
    expect(r.locatedCents).toBe(100_000);
  });

  test("both winding-down piles add on top of the bank and Stripe, not instead", () => {
    // Guards the plain arithmetic slip of overwriting a term rather than summing
    // it — every pile is a separate real place money sits.
    const r = reconcileOrgMoney({
      bookValueCents: 0,
      bankAvailableCents: 1_000,
      bankPendingCents: 200,
      stripeAvailableCents: 30,
      stripePendingCents: 4,
      givebutterUndepositedCents: 7_500,
      givebutterConfigured: true,
      relayBalanceCents: 5_693,
    });
    expect(r.locatedCents).toBe(1_000 + 200 + 30 + 4 + 7_500 + 5_693);
  });
});

// ── The query that feeds it ──────────────────────────────────────────────────

describe("reconciliationSummary — assembling the two sides", () => {
  test("ED/FM gated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Member",
        userId: s.userId,
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.query(api.reconciliation.reconciliationSummary, {}),
    ).rejects.toThrow(/Executive Director and Financial Manager/i);
  });

  test("books and cash net to zero when everything is where it should be", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    // $500 earned by the chapter; the cash is still sitting in central's
    // account because that is where payouts land. Per-book this looks wrong in
    // BOTH directions; org-wide it is exactly right, which is the whole reason
    // the verdict is an org total.
    await seedGift(s, s.chapterId, 50_000);
    await seedAccount(s, { chapterId: CENTRAL, balanceCents: 50_000 });
    await seedAccount(s, {
      chapterId: s.chapterId,
      balanceCents: 0,
      increaseAccountId: "account_ny",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        stripeAvailableCents: 0,
        stripePendingCents: 0,
        updatedAt: Date.now(),
      }),
    );

    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.bookValueCents).toBe(50_000);
    expect(summary.bankAvailableCents).toBe(50_000);
    expect(summary.locatedCents).toBe(50_000);
    expect(summary.differenceCents).toBe(0);
    expect(summary.verdict).toBe("balanced");
  });

  test("pending on any account lands on the cash side of the total", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedGift(s, s.chapterId, 50_000);
    // The chapter spent $100 on a card; the authorization is off the available
    // balance but hasn't posted, so the ledger — and book value — knows nothing
    // about it. The books must still reconcile.
    await seedAccount(s, {
      chapterId: s.chapterId,
      balanceCents: 40_000,
      pendingCents: 10_000,
    });
    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.bankAvailableCents).toBe(40_000);
    expect(summary.bankPendingCents).toBe(10_000);
    expect(summary.locatedCents).toBe(50_000);
    expect(summary.verdict).toBe("balanced");
  });

  test("sandbox accounts never enter a production total", async () => {
    // A demo balance leaking into the live reconciliation would invent a gap
    // out of test data — and the sandbox toggle is a superuser plaything that
    // gets flipped without anyone thinking about this page.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedAccount(s, { chapterId: CENTRAL, balanceCents: 10_000 });
    await seedAccount(s, {
      chapterId: s.chapterId,
      balanceCents: 999_999,
      sandbox: true,
      increaseAccountId: "sandbox_account_demo",
    });
    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.bankAvailableCents).toBe(10_000);
  });

  test("cash in an account no live book claims is counted AND named", async () => {
    // A deactivated chapter's account still holds real money. Dropping it would
    // make the org look short by that amount for a reason nothing on screen
    // could explain; padding the total silently would hide a genuine anomaly.
    // So: in the total, and called out.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const goneChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Closed Chapter",
        isActive: false,
        createdAt: Date.now(),
      }),
    );
    await seedAccount(s, { chapterId: CENTRAL, balanceCents: 10_000 });
    await seedAccount(s, {
      chapterId: goneChapterId,
      balanceCents: 2_500,
      increaseAccountId: "account_closed",
    });
    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.bankAvailableCents).toBe(12_500);
    expect(summary.unattributedBankCents).toBe(2_500);
  });

  test("in-kind revenue is reported, never netted out", async () => {
    // It nets to zero INSIDE book value (revenue + the expense it paid for), so
    // adjusting for it again here would move the gap by the whole in-kind total
    // in the wrong direction. It is surfaced so a reader can tell the two apart
    // when an in-kind gift was entered without its expense.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedGift(s, s.chapterId, 50_000, "in_kind");
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 50_000,
        currency: "usd",
        postedAt: Date.now(),
        description: "Gear bought personally",
        status: "categorized",
        createdAt: Date.now(),
      }),
    );
    await seedAccount(s, { chapterId: CENTRAL, balanceCents: 0 });
    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.inKindRevenueCents).toBe(50_000);
    // Book value already absorbed the pair, so it reconciles against no cash.
    expect(summary.bookValueCents).toBe(0);
    expect(summary.verdict).toBe("balanced");
  });

  test("a book with no bank balance is named, not counted as zero cash", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.booksWithoutBankBalance).toEqual(
      expect.arrayContaining(["Central", "New York"]),
    );
  });

  test("a paid payout whose deposit was never found is offered as a lead", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("stripePayouts", {
        stripePayoutId: "po_lead",
        amountCents: 192_551,
        currency: "usd",
        stripeStatus: "paid",
        arrivalDate: Date.now(),
        processState: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.unmatchedPayoutCount).toBe(1);
    expect(summary.unmatchedPayoutCents).toBe(192_551);
  });
});

// ── The obsolete "Failed" badge ──────────────────────────────────────────────

describe("detected payouts — an obsolete allocation failure is not a problem", () => {
  test("re-detecting a failed payout heals it and drops the stale error", async () => {
    // po_1U1qk8Qv9S5xW6eKsjkeLJvv, in production: a MANUALLY-initiated payout,
    // which Stripe refuses to itemise. The pre-#553 allocation step recorded
    // that refusal as a failure and the page has shown a red badge over a raw
    // Stripe error blob ever since — for work the engine no longer attempts.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("stripePayouts", {
        stripePayoutId: "po_manual",
        amountCents: 192_551,
        currency: "usd",
        stripeStatus: "paid",
        arrivalDate: Date.now(),
        processState: "failed",
        error:
          '{"code":"STRIPE_ERROR","message":"Stripe request failed (400). Balance transaction history can only be filtered on automatic transfers, not manual."}',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.reconciliation.upsertDetectedPayout, {
      stripePayoutId: "po_manual",
      amountCents: 192_551,
      currency: "usd",
      stripeStatus: "paid",
      arrivalDate: Date.now(),
      automatic: false,
    });
    expect(result.processState).toBe("pending");

    const overview = await s.as.query(
      api.reconciliation.reconciliationOverview,
      {},
    );
    const row = overview.payouts.find((p) => p.stripePayoutId === "po_manual");
    expect(row?.processState).toBe("pending");
    expect(row?.error).toBeNull();
    // The fact that DOES explain it, kept: the founder pressed the button.
    expect(row?.automatic).toBe(false);
  });

  test("a payout Stripe itself reports as failed keeps its error", async () => {
    // The heal must not swallow a real problem. This one is money that never
    // arrived, and it stays loud.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("stripePayouts", {
        stripePayoutId: "po_real_fail",
        amountCents: 10_000,
        currency: "usd",
        stripeStatus: "paid",
        arrivalDate: Date.now(),
        processState: "allocated",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.mutation(internal.reconciliation.upsertDetectedPayout, {
      stripePayoutId: "po_real_fail",
      amountCents: 10_000,
      currency: "usd",
      stripeStatus: "failed",
      arrivalDate: Date.now(),
    });
    const overview = await s.as.query(
      api.reconciliation.reconciliationOverview,
      {},
    );
    const row = overview.payouts.find(
      (p) => p.stripePayoutId === "po_real_fail",
    );
    expect(row?.error).toMatch(/AFTER its allocation transfers were booked/);
  });
});

// ── The refresh the page performs on open ────────────────────────────────────

describe("balance snapshot throttle", () => {
  test("a second caller inside the freshness window is turned away", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        balanceSnapshotAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(
      (
        await t.mutation(internal.reconciliation.claimBalanceSnapshot, {
          force: false,
        })
      ).proceed,
    ).toBe(false);
    // A human pressing Refresh has seen the "as of" and decided otherwise.
    expect(
      (
        await t.mutation(internal.reconciliation.claimBalanceSnapshot, {
          force: true,
        })
      ).proceed,
    ).toBe(true);
  });

  test("an in-flight snapshot blocks even a forced refresh", async () => {
    // The lock exists to stop two callers hitting Increase and Stripe at once,
    // which impatience does not exempt anyone from.
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        balanceSnapshotRunningSince: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(
      (
        await t.mutation(internal.reconciliation.claimBalanceSnapshot, {
          force: true,
        })
      ).proceed,
    ).toBe(false);
  });

  test("a wedged lock from a crashed run expires instead of blocking forever", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        balanceSnapshotRunningSince: Date.now() - 10 * 60 * 1000,
        updatedAt: Date.now(),
      }),
    );
    expect(
      (
        await t.mutation(internal.reconciliation.claimBalanceSnapshot, {
          force: false,
        })
      ).proceed,
    ).toBe(true);
  });

  test("finishing releases the lock and stamps the 'as of'", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        balanceSnapshotRunningSince: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.mutation(internal.reconciliation.finishBalanceSnapshot, {});
    const row = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(row?.balanceSnapshotRunningSince).toBeUndefined();
    expect(row?.balanceSnapshotAt).toBeGreaterThan(0);
  });
});

// ── Which pending belongs on the cash side (2026-08-10) ─────────────────────
//
// The panel added back ALL of Increase's `current - available`, on the premise
// that a pending item hasn't reached the ledger. True for a card swipe; false
// for a reimbursement ACH, whose expense row is written when the payout reaches
// `paid` while Increase still holds the instruction pending. Adding that back
// while the books carry it as gone opens a gap exactly as wide as the transfer.
//
// The FIRST cut of this fix discriminated by Increase category, excluding four
// outbound kinds. The tests below exist mostly to pin down why that was wrong:
// the app cannot originate a wire, a check or an RTP transfer at all, so those
// can only come from the Increase dashboard and reach the ledger at SETTLEMENT.
// The transfer id is the only honest discriminator, and it is resolved during
// the snapshot rather than at read time.

describe("addableBankPendingCents", () => {
  test("New York on 2026-08-10: $183.54 pending is $138.55 ours, $44.99 booked", () => {
    // The real numbers. The $44.99 is Sayo Olujide's bus-ticket reimbursement,
    // sent 2026-08-09, and it was the whole of that day's phantom gap.
    expect(
      addableBankPendingCents({
        pendingCents: 18354,
        pendingAlreadyBookedCents: 4499,
      }),
    ).toEqual({ addableCents: 13855, alreadyBookedCents: 4499 });
  });

  test("nothing booked leaves the whole total on the cash side", () => {
    expect(
      addableBankPendingCents({
        pendingCents: 13855,
        pendingAlreadyBookedCents: 0,
      }),
    ).toEqual({ addableCents: 13855, alreadyBookedCents: 0 });
  });

  test("UNMEASURED is not zero-booked — the whole total goes back", () => {
    // Absent means no snapshot has split this total (an old row, or one whose
    // /pending_transactions call failed and was therefore CLEARED rather than
    // left stale). Subtracting an unmeasured figure would invent a number and
    // report money missing; adding it all back only overstates what we can
    // point at, which is the direction that invites a look rather than an alarm.
    expect(addableBankPendingCents({ pendingCents: 18354 })).toEqual({
      addableCents: 18354,
      alreadyBookedCents: 0,
    });
    expect(
      addableBankPendingCents({
        pendingCents: 18354,
        pendingAlreadyBookedCents: null,
      }),
    ).toEqual({ addableCents: 18354, alreadyBookedCents: 0 });
  });

  test("zero pending is zero on both counts", () => {
    expect(
      addableBankPendingCents({ pendingCents: 0, pendingAlreadyBookedCents: 0 }),
    ).toEqual({ addableCents: 0, alreadyBookedCents: 0 });
    expect(addableBankPendingCents({})).toEqual({
      addableCents: 0,
      alreadyBookedCents: 0,
    });
  });

  test("neither line can be a number that isn't a real pile of money", () => {
    // Booked can't exceed what the bank is holding...
    expect(
      addableBankPendingCents({
        pendingCents: 1000,
        pendingAlreadyBookedCents: 5000,
      }),
    ).toEqual({ addableCents: 0, alreadyBookedCents: 1000 });
    // ...and a legacy row from before the writer's clamp can't turn into
    // negative cash.
    expect(
      addableBankPendingCents({
        pendingCents: -500,
        pendingAlreadyBookedCents: -200,
      }),
    ).toEqual({ addableCents: 0, alreadyBookedCents: 0 });
  });

  test("the gap closes when the booked slice comes out", () => {
    // End to end, in the shape the panel reports: books $8,722.60 against
    // $7,041.12 available + $183.54 pending + $1,530.32 Stripe + $75.00
    // Givebutter + $56.93 Relay read $164.31 over. $44.99 of that was this.
    const pending = addableBankPendingCents({
      pendingCents: 18354,
      pendingAlreadyBookedCents: 4499,
    });
    const before = reconcileOrgMoney({
      bookValueCents: 872260,
      bankAvailableCents: 704112,
      bankPendingCents: 18354,
      stripeAvailableCents: 24012,
      stripePendingCents: 129020,
      givebutterUndepositedCents: 7500,
      givebutterConfigured: true,
      relayBalanceCents: 5693,
    });
    const after = reconcileOrgMoney({
      bookValueCents: 872260,
      bankAvailableCents: 704112,
      bankPendingCents: pending.addableCents,
      stripeAvailableCents: 24012,
      stripePendingCents: 129020,
      givebutterUndepositedCents: 7500,
      givebutterConfigured: true,
      relayBalanceCents: 5693,
    });
    expect(before.differenceCents).toBe(16431);
    expect(after.differenceCents).toBe(16431 - 4499);
  });
});

// ── WHICH pending transfer the ledger has already booked ────────────────────
//
// The measurement itself. `bookedTransferIds` is asked about ids pulled off
// `/pending_transactions`; the answer decides whether real money comes off the
// cash side, so every lane of it is pinned here — including the two that must
// answer NO.

describe("bookedTransferIds", () => {
  async function seedPayout(
    s: ChapterSetup,
    transferId: string,
    status: "pending" | "processing" | "paid" | "returned" | "failed",
  ): Promise<void> {
    await run(s.t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Payee",
        createdAt: Date.now(),
      });
      const reimbursementId = await ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        token: crypto.randomUUID(),
        status: status === "paid" ? "paid" : "paying",
        payeeName: "Payee",
        personId,
        totalCents: 4499,
        approvedCents: 4499,
        submittedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("payouts", {
        chapterId: s.chapterId,
        reimbursementId,
        payeePersonId: personId,
        amountCents: 4499,
        provider: "increase",
        status,
        increaseTransferId: transferId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  test("a PAID payout's transfer is booked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPayout(s, "ach_transfer_paid", "paid");
    expect(
      await t.query(internal.reconciliation.bookedTransferIds, {
        transferIds: ["ach_transfer_paid"],
      }),
    ).toEqual(["ach_transfer_paid"]);
  });

  test("a payout still PROCESSING is NOT booked — the pre-submission window", async () => {
    // `applyAchTransfer` stamps `increaseTransferId` the instant
    // POST /ach_transfers returns, with the payout `processing`; the expense row
    // is only written when a fetched status of `submitted` maps it to `paid`.
    // Increase opens the pending transaction at CREATION. Matching on the id
    // alone would subtract a transfer the books have not booked — a phantom
    // shortfall for the length of an ACH cutoff, a weekend, or a
    // `pending_approval` review.
    const t = newT();
    const s = await setupChapter(t);
    await seedPayout(s, "ach_transfer_inflight", "processing");
    expect(
      await t.query(internal.reconciliation.bookedTransferIds, {
        transferIds: ["ach_transfer_inflight"],
      }),
    ).toEqual([]);
  });

  test("a RETURNED payout is not booked — its ledger row was deleted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPayout(s, "ach_transfer_bounced", "returned");
    expect(
      await t.query(internal.reconciliation.bookedTransferIds, {
        transferIds: ["ach_transfer_bounced"],
      }),
    ).toEqual([]);
  });

  test("a stamped engine account-transfer leg is NOT booked", async () => {
    // The engine writes ledger rows for both legs of a central<->chapter move
    // and stamps them with the account-transfer id, so it is tempting to read a
    // stamped id as "the books already moved this". They didn't: both legs carry
    // `transferOrigin:"balance_settlement"`, which `lib/bookBalance.ts` returns
    // ZERO for, so ORG-WIDE BOOK VALUE NEVER CHANGED.
    //
    // Meanwhile the cash side moves twice — while the transfer is pending the
    // sender's `available` has dropped and the receiver's has not yet risen — so
    // adding that pending back is precisely what restores the org total.
    // Subtracting it would invent a `books_exceed_cash` shortfall the size of
    // the settlement, which is the exact failure this whole change exists to
    // prevent, pointed the other way.
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "transfer",
        flow: "transfer",
        transferOrigin: "balance_settlement",
        amountCents: 25_000,
        currency: "usd",
        postedAt: Date.now(),
        status: "reconciled",
        externalId: "account_transfer_moved",
        createdAt: Date.now(),
      }),
    );
    expect(
      await t.query(internal.reconciliation.bookedTransferIds, {
        transferIds: ["account_transfer_moved"],
      }),
    ).toEqual([]);
  });

  test("a transfer nothing in the app originated is NOT booked", async () => {
    // FINDING 1's failure case, at its source. A treasurer mails a $2,000 check
    // from the Increase dashboard: the app has no /check_transfers call at all,
    // so nothing books it until it clears. Calling it booked would refuse $2,000
    // of real cash for as long as the check stayed uncashed.
    const t = newT();
    await setupChapter(t);
    expect(
      await t.query(internal.reconciliation.bookedTransferIds, {
        transferIds: ["check_transfer_from_the_dashboard"],
      }),
    ).toEqual([]);
  });

  test("asks about many ids at once and answers only for the booked ones", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPayout(s, "ach_paid", "paid");
    await seedPayout(s, "ach_processing", "processing");
    expect(
      await t.query(internal.reconciliation.bookedTransferIds, {
        transferIds: ["ach_paid", "ach_processing", "wire_from_dashboard"],
      }),
    ).toEqual(["ach_paid"]);
  });
});

// ── The snapshot: measuring the split at the source ─────────────────────────

describe("snapshotBalances — resolving pending against the ledger", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.INCREASE_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.INCREASE_API_KEY;
    else process.env.INCREASE_API_KEY = originalKey;
  });

  /** `GET /accounts/{id}/balance` + `GET /pending_transactions`, in the exact
   *  shape Increase returns them — the detail object keyed BY the category, with
   *  `transfer_id` on the outbound kinds and absent on the rest. */
  function mockIncrease(
    balance: { current: number; available: number },
    pendingRows: Array<{ amount: number; category: string; transferId?: string }>,
  ) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/balance")) {
        return new Response(
          JSON.stringify({
            current_balance: balance.current,
            available_balance: balance.available,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path.includes("/pending_transactions")) {
        return new Response(
          JSON.stringify({
            data: pendingRows.map((r) => ({
              amount: r.amount,
              source: {
                category: r.category,
                [r.category]: {
                  amount: r.amount,
                  ...(r.transferId ? { transfer_id: r.transferId } : {}),
                },
              },
            })),
            next_cursor: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
  }

  async function accountRow(t: TestConvex, id: Id<"increaseAccounts">) {
    return run(t, (ctx) => ctx.db.get(id));
  }

  /**
   * Run the snapshot AND DRAIN WHAT IT SCHEDULES. `refreshBalancesNow` kicks off
   * the legacy (Relay) feed refresh with `ctx.scheduler.runAfter(0, …)`; left
   * pending it executes after this test has finished, and convex-test attributes
   * its failure to whatever file happens to be running by then — a CI-only,
   * entirely misleading red.
   */
  async function snapshot(s: ChapterSetup): Promise<void> {
    vi.useFakeTimers();
    try {
      await s.as.action(api.reconciliation.refreshBalancesNow, { force: true });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
  }

  test("a paid reimbursement's ACH is measured as booked; the card swipe isn't", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const accountId = await seedAccount(s, { chapterId: s.chapterId });
    await run(s.t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Sayo Olujide",
        createdAt: Date.now(),
      });
      const reimbursementId = await ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        token: crypto.randomUUID(),
        status: "paid",
        payeeName: "Sayo Olujide",
        personId,
        totalCents: 4499,
        approvedCents: 4499,
        submittedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("payouts", {
        chapterId: s.chapterId,
        reimbursementId,
        payeePersonId: personId,
        amountCents: 4499,
        provider: "increase",
        status: "paid",
        increaseTransferId: "ach_transfer_sayo",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    process.env.INCREASE_API_KEY = "test_key";
    mockIncrease({ current: 722466, available: 704112 }, [
      { amount: -13855, category: "card_authorization" },
      {
        amount: -4499,
        category: "ach_transfer_instruction",
        transferId: "ach_transfer_sayo",
      },
    ]);
    await snapshot(s);

    const row = await accountRow(t, accountId);
    expect(row?.pendingCents).toBe(18354);
    expect(row?.pendingAlreadyBookedCents).toBe(4499);
    // And the per-category share, so the drill-down can say WHICH row.
    const ach = row?.pendingBreakdown?.find(
      (p) => p.category === "ach_transfer_instruction",
    );
    expect(ach?.alreadyBookedCents).toBe(4499);
    const card = row?.pendingBreakdown?.find(
      (p) => p.category === "card_authorization",
    );
    expect(card?.alreadyBookedCents).toBeUndefined();
  });

  test("a dashboard check transfer is measured as NOT booked", async () => {
    // FINDING 1, end to end. Nothing in the app originates a check, so nothing
    // books it until it clears — it stays on the cash side for however many
    // weeks it takes the payee to cash it.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const accountId = await seedAccount(s, { chapterId: s.chapterId });

    process.env.INCREASE_API_KEY = "test_key";
    mockIncrease({ current: 900_000, available: 700_000 }, [
      {
        amount: -200_000,
        category: "check_transfer_instruction",
        transferId: "check_transfer_from_dashboard",
      },
    ]);
    await snapshot(s);

    const row = await accountRow(t, accountId);
    expect(row?.pendingCents).toBe(200_000);
    expect(row?.pendingAlreadyBookedCents).toBe(0);
    expect(
      addableBankPendingCents(row!).addableCents,
    ).toBe(200_000);
  });

  test("a POSITIVE pending row never subtracts from the cash side", async () => {
    // FINDING 2. `pendingCents` is `current - available`, which by Increase's
    // definition counts only the rows that REDUCE available — a positive row
    // (an unsettled card refund, or the inbound leg of an ACH debit we pulled)
    // is not in the total, so it must never come out of it. Even when the
    // positive row's transfer IS one the ledger booked.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const accountId = await seedAccount(s, { chapterId: s.chapterId });
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "transfer",
        flow: "transfer",
        amountCents: 2000,
        currency: "usd",
        postedAt: Date.now(),
        status: "reconciled",
        externalId: "inbound_pull",
        createdAt: Date.now(),
      }),
    );

    process.env.INCREASE_API_KEY = "test_key";
    // current - available = 18354: the two debits. The +$20 raises neither.
    mockIncrease({ current: 722466, available: 704112 }, [
      { amount: -13855, category: "card_authorization" },
      { amount: -4499, category: "ach_transfer_instruction" },
      {
        amount: 2000,
        category: "ach_transfer_instruction",
        transferId: "inbound_pull",
      },
    ]);
    await snapshot(s);

    const row = await accountRow(t, accountId);
    expect(row?.pendingCents).toBe(18354);
    expect(row?.pendingAlreadyBookedCents).toBe(0);
    expect(addableBankPendingCents(row!)).toEqual({
      addableCents: 18354,
      alreadyBookedCents: 0,
    });
  });

  test("an itemisation failure CLEARS the split rather than leaving it stale", async () => {
    // FINDING 3's failure, made impossible by construction. The two numbers are
    // written by one mutation, so a fresh total can never sit beside a booked
    // figure measured against a different read.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const accountId = await seedAccount(s, {
      chapterId: s.chapterId,
      balanceCents: 704112,
      pendingCents: 18354,
      pendingAlreadyBookedCents: 4499,
      pendingBreakdown: [
        {
          category: "ach_transfer_instruction",
          amountCents: -4499,
          count: 1,
          alreadyBookedCents: 4499,
        },
      ],
    });

    process.env.INCREASE_API_KEY = "test_key";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/balance")) {
        return new Response(
          JSON.stringify({ current_balance: 722466, available_balance: 704112 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path.includes("/pending_transactions")) {
        return new Response("nope", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
    await snapshot(s);

    const row = await accountRow(t, accountId);
    expect(row?.pendingCents).toBe(18354);
    expect(row?.pendingAlreadyBookedCents).toBeUndefined();
    expect(row?.pendingBreakdown).toBeUndefined();
    // Unmeasured, so the whole total goes back — never a stale $44.99 off.
    expect(addableBankPendingCents(row!)).toEqual({
      addableCents: 18354,
      alreadyBookedCents: 0,
    });
  });
});

// ── The three surfaces have to agree (finding 5) ────────────────────────────

describe("the panel, the table and the drill-down report one number", () => {
  test("the booked slice accumulates across accounts and leaves the cash side", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    // Two books, each with something pending; only one has a transfer the
    // ledger already booked. The panel is a SUM, so a per-account split that
    // isn't accumulated correctly is invisible in a one-account test.
    await seedAccount(s, {
      chapterId: CENTRAL,
      balanceCents: 100_000,
      pendingCents: 6000,
      pendingAlreadyBookedCents: 1000,
    });
    await seedAccount(s, {
      chapterId: s.chapterId,
      balanceCents: 50_000,
      pendingCents: 18354,
      pendingAlreadyBookedCents: 4499,
      increaseAccountId: "account_ny",
    });

    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.bankAvailableCents).toBe(150_000);
    expect(summary.bankPendingCents).toBe(5000 + 13855);
    expect(summary.bankPendingBookedCents).toBe(1000 + 4499);
    // The located total counts the addable slice only — the booked part is
    // already deducted on the books side, so counting it here too would be the
    // double count this whole change exists to stop.
    expect(summary.locatedCents).toBe(150_000 + 5000 + 13855);
  });

  test("an unmeasured account contributes its whole pending, booked stays zero", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedAccount(s, {
      chapterId: CENTRAL,
      balanceCents: 100_000,
      pendingCents: 18354,
    });
    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    expect(summary.bankPendingCents).toBe(18354);
    expect(summary.bankPendingBookedCents).toBe(0);
  });

  test("the table's Pending column sums to the panel's, and the drill-down matches its row", async () => {
    // Three numbers under two labels on one screen was the bug: the panel said
    // $138.55, the table beneath it said $183.54, and the drill-down one tap
    // away said $183.54 under the panel's own label. They are one number now.
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedAccount(s, {
      chapterId: CENTRAL,
      balanceCents: 100_000,
      pendingCents: 6000,
      pendingAlreadyBookedCents: 1000,
    });
    await seedAccount(s, {
      chapterId: s.chapterId,
      balanceCents: 50_000,
      pendingCents: 18354,
      pendingAlreadyBookedCents: 4499,
      increaseAccountId: "account_ny",
      pendingBreakdown: [
        { category: "card_authorization", amountCents: -13855, count: 2 },
        {
          category: "ach_transfer_instruction",
          amountCents: -4499,
          count: 1,
          alreadyBookedCents: 4499,
        },
      ],
    });

    const summary = await s.as.query(api.reconciliation.reconciliationSummary, {});
    const rows = await s.as.query(api.reconciliation.accountBalances, {});
    const drill = await s.as.query(api.reconciliation.bookValueBreakdown, {
      scope: s.chapterId,
    });

    // Panel === Σ table.
    expect(rows.reduce((sum, r) => sum + (r.pendingCents ?? 0), 0)).toBe(
      summary.bankPendingCents,
    );
    expect(
      rows.reduce((sum, r) => sum + (r.pendingAlreadyBookedCents ?? 0), 0),
    ).toBe(summary.bankPendingBookedCents);

    // Table row === drill-down for the same book.
    const ny = rows.find((r) => r.scope === s.chapterId);
    expect(ny?.pendingCents).toBe(13855);
    expect(ny?.pendingAlreadyBookedCents).toBe(4499);
    expect(drill.cash.pendingCents).toBe(13855);
    expect(drill.cash.pendingAlreadyBookedCents).toBe(4499);
    // And the drill-down can name WHICH category was excluded, so the
    // categories summing to more than the figure above them is explained
    // rather than merely visible.
    expect(
      drill.cash.pendingBreakdown.find(
        (p) => p.category === "ach_transfer_instruction",
      )?.alreadyBookedCents,
    ).toBe(4499);
  });

  test("an account with no pending at all still reads null, not zero", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedAccount(s, { chapterId: CENTRAL, balanceCents: 100_000 });
    const rows = await s.as.query(api.reconciliation.accountBalances, {});
    const central = rows.find((r) => r.scope === CENTRAL);
    expect(central?.pendingCents).toBeNull();
    expect(central?.pendingAlreadyBookedCents).toBeNull();
  });
});
