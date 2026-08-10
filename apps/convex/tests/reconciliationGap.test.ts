/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
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
// for a transfer we sent ourselves, which `increasePayouts.ts` books as spend
// in the same mutation that sends it. Adding that back while the books carry it
// as gone opens a gap exactly as wide as the transfer.

describe("addableBankPendingCents", () => {
  const CARD = { category: "card_authorization", amountCents: -13855, count: 2 };
  const ACH = {
    category: "ach_transfer_instruction",
    amountCents: -4499,
    count: 1,
  };

  test("New York on 2026-08-10: $183.54 pending is $138.55 ours, $44.99 booked", () => {
    // The real numbers. The $44.99 is Sayo Olujide's bus-ticket reimbursement,
    // sent 2026-08-09, and it was the whole of that day's phantom gap.
    expect(
      addableBankPendingCents({
        pendingCents: 18354,
        pendingBreakdown: [CARD, ACH],
      }),
    ).toEqual({ addableCents: 13855, alreadyBookedCents: 4499 });
  });

  test("card authorizations are still added back in full", () => {
    expect(
      addableBankPendingCents({
        pendingCents: 13855,
        pendingBreakdown: [CARD],
      }),
    ).toEqual({ addableCents: 13855, alreadyBookedCents: 0 });
  });

  test("every outbound instruction kind counts as booked", () => {
    for (const category of [
      "ach_transfer_instruction",
      "wire_transfer_instruction",
      "check_transfer_instruction",
      "real_time_payments_transfer_instruction",
    ]) {
      expect(
        addableBankPendingCents({
          pendingCents: 1000,
          pendingBreakdown: [{ category, amountCents: -1000, count: 1 }],
        }),
      ).toEqual({ addableCents: 0, alreadyBookedCents: 1000 });
    }
  });

  test("an unrecognised category keeps the old behaviour, not silence", () => {
    // Allowlist, not denylist: Increase has ~16 pending categories and a new
    // one must not quietly disappear off the cash side.
    expect(
      addableBankPendingCents({
        pendingCents: 500,
        pendingBreakdown: [
          { category: "inbound_funds_hold", amountCents: -500, count: 1 },
        ],
      }),
    ).toEqual({ addableCents: 500, alreadyBookedCents: 0 });
  });

  test("no breakdown yet falls back to adding the whole total back", () => {
    expect(addableBankPendingCents({ pendingCents: 18354 })).toEqual({
      addableCents: 18354,
      alreadyBookedCents: 0,
    });
    expect(
      addableBankPendingCents({ pendingCents: 18354, pendingBreakdown: [] }),
    ).toEqual({ addableCents: 18354, alreadyBookedCents: 0 });
  });

  test("a STALE breakdown is refused rather than subtracted from", () => {
    // A failed /pending_transactions fetch leaves the previous rollup in place
    // while pendingCents moves on. Subtracting from it would take $44.99 off
    // the cash side for a transfer that posted days ago.
    expect(
      addableBankPendingCents({
        pendingCents: 13855, // the ACH posted; the rollup still lists it
        pendingBreakdown: [CARD, ACH],
      }),
    ).toEqual({ addableCents: 13855, alreadyBookedCents: 0 });
  });

  test("zero pending is zero on both counts", () => {
    expect(
      addableBankPendingCents({ pendingCents: 0, pendingBreakdown: [] }),
    ).toEqual({ addableCents: 0, alreadyBookedCents: 0 });
    expect(addableBankPendingCents({})).toEqual({
      addableCents: 0,
      alreadyBookedCents: 0,
    });
  });

  test("the gap closes when the booked slice comes out", () => {
    // End to end, in the shape the panel reports: books $8,722.60 against
    // $7,041.12 available + $183.54 pending + $1,530.32 Stripe + $75.00
    // Givebutter + $56.93 Relay read $164.31 over. $44.99 of that was this.
    const pending = addableBankPendingCents({
      pendingCents: 18354,
      pendingBreakdown: [CARD, ACH],
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
