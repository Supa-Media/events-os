import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Phase 5 card tests (person-owned Increase cards + the real-time authorization
 * decision + personal-charge repayment):
 *  - `decideCardAuthorization` APPROVES a normal charge within cap + validity on
 *    an active card, DECLINES when locked / out of the validity window / over the
 *    monthly cap, and logs a `cardAuthorizations` row every time,
 *  - `flagPersonalCharge` sets `isPersonal` + creates ONE pending repayment
 *    (idempotent),
 *  - a settled repayment posts exactly one `flow:"transfer"` offsetting credit
 *    (excluded from spend) + is idempotent,
 *  - `autoLockOverdueCards` locks an overdue card + leaves a current one active,
 *  - issue / list / setControls tenancy + gates,
 *  - `issueCard` degrades without `INCREASE_API_KEY` (still creates the row).
 *
 * All money is integer cents; the network side never runs (no `INCREASE_API_KEY`
 * in the test env) so the decision + repayment logic is exercised via DB apply.
 */

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; userId?: Id<"users">; pwEmail?: string | null } = {
    name: "Person",
  },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: true,
      // Card-eligible by default (a @publicworship.life email) so issueCard's
      // eligibility gate passes; pass `pwEmail: null` to seed an ineligible person.
      pwEmail:
        opts.pwEmail === null
          ? undefined
          : (opts.pwEmail ?? "person@publicworship.life"),
      createdAt: Date.now(),
    }),
  );
}

/** Make the seeded caller a finance manager (person linked to the user + role). */
async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedPerson(s, {
    name: "Manny Manager",
    userId: s.userId,
  });
  await grantRole(s, personId, "manager");
  return personId;
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

/** Set the deployment-wide finance sandbox flag (upserts the singleton row). */
async function setSandboxMode(
  s: ChapterSetup,
  sandboxMode: boolean,
): Promise<void> {
  await run(s.t, async (ctx) => {
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { sandboxMode, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode,
        updatedAt: Date.now(),
      });
    }
  });
}

async function seedCard(
  s: ChapterSetup,
  opts: {
    cardholderPersonId: Id<"people">;
    status?: "active" | "locked" | "canceled";
    monthlyCapCents?: number;
    validFrom?: number;
    validUntil?: number;
    increaseCardId?: string;
    last4?: string;
    receiptGraceEndsAt?: number;
    chapterId?: Id<"chapters">;
  },
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: opts.chapterId ?? s.chapterId,
      cardholderPersonId: opts.cardholderPersonId,
      type: "virtual",
      status: opts.status ?? "active",
      monthlyCapCents: opts.monthlyCapCents,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil,
      increaseCardId: opts.increaseCardId,
      last4: opts.last4,
      receiptGraceEndsAt: opts.receiptGraceEndsAt,
      createdAt: Date.now(),
    }),
  );
}

/** Seed a card charge (outflow). Defaults to posted now (this Eastern month);
 *  `ageDays` back-dates it; `receiptStorageId` marks it receipted. */
async function seedCardTxn(
  s: ChapterSetup,
  opts: {
    cardId: Id<"cards">;
    amountCents: number;
    personId?: Id<"people">;
    ageDays?: number;
    receiptStorageId?: Id<"_storage">;
  },
): Promise<Id<"transactions">> {
  const now = Date.now();
  const postedAt = now - (opts.ageDays ?? 0) * DAY_MS;
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "increase_card",
      flow: "outflow",
      amountCents: opts.amountCents,
      postedAt,
      cardId: opts.cardId,
      personId: opts.personId,
      receiptStorageId: opts.receiptStorageId,
      status: "unreviewed",
      createdAt: now,
    }),
  );
}

/** Seed an APPROVED authorization on a card this month (no settled txn). */
async function seedApprovedAuth(
  s: ChapterSetup,
  cardId: Id<"cards">,
  amountCents: number,
  increaseAuthId: string,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("cardAuthorizations", {
      chapterId: s.chapterId,
      cardId,
      increaseAuthId,
      amountCents,
      approved: true,
      createdAt: Date.now(),
    }),
  );
}

/** Count `source:"repayment"` offsetting credits in the chapter. */
async function repaymentCredits(s: ChapterSetup) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  ).then((rows) => rows.filter((r) => r.source === "repayment"));
}

async function authLogFor(s: ChapterSetup, increaseAuthId: string) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("cardAuthorizations")
      .withIndex("by_increase_auth", (q) =>
        q.eq("increaseAuthId", increaseAuthId),
      )
      .collect(),
  );
}

// ── decideCardAuthorization ──────────────────────────────────────────────────

describe("decideCardAuthorization", () => {
  test("APPROVES a normal charge within cap + validity on an active card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    await seedCard(s, {
      cardholderPersonId: holder,
      monthlyCapCents: 100000,
      validFrom: Date.now() - 1000,
      validUntil: Date.now() + 1_000_000,
      increaseCardId: "card_ok",
    });

    const d = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_ok",
      increaseAuthId: "auth_ok",
      amountCents: 5000,
    });
    expect(d.approved).toBe(true);

    // Every decision is logged.
    const log = await authLogFor(s, "auth_ok");
    expect(log.length).toBe(1);
    expect(log[0].approved).toBe(true);
    expect(log[0].amountCents).toBe(5000);
  });

  test("DECLINES when the card is locked (+ logs the decision)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    await seedCard(s, {
      cardholderPersonId: holder,
      status: "locked",
      increaseCardId: "card_locked",
    });

    const d = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_locked",
      increaseAuthId: "auth_locked",
      amountCents: 100,
    });
    expect(d.approved).toBe(false);

    const log = await authLogFor(s, "auth_locked");
    expect(log.length).toBe(1);
    expect(log[0].approved).toBe(false);
  });

  test("DECLINES when outside the validity window", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    await seedCard(s, {
      cardholderPersonId: holder,
      validUntil: Date.now() - 1000, // already expired
      increaseCardId: "card_expired",
    });

    const d = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_expired",
      increaseAuthId: "auth_expired",
      amountCents: 100,
    });
    expect(d.approved).toBe(false);
  });

  test("DECLINES over the cap from in-flight authorizations (no txn settled)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      monthlyCapCents: 10000,
      increaseCardId: "card_cap",
    });
    // $90 of APPROVED authorizations this month — NOTHING settled to a txn.
    await seedApprovedAuth(s, cardId, 5000, "auth_a");
    await seedApprovedAuth(s, cardId, 4000, "auth_b");
    // Guard: no transaction exists on the card, so a txn-based cap would let
    // these through — the auth-based cap must not.
    const cardTxns = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_card", (q) => q.eq("cardId", cardId))
        .collect(),
    );
    expect(cardTxns.length).toBe(0);

    // $20 more → $110 > $100 cap → DECLINE.
    const over = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_cap",
      increaseAuthId: "auth_over",
      amountCents: 2000,
    });
    expect(over.approved).toBe(false);

    // $5 more → $95 ≤ $100 cap → APPROVE (the declined auth doesn't count).
    const under = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_cap",
      increaseAuthId: "auth_under",
      amountCents: 500,
    });
    expect(under.approved).toBe(true);
  });

  test("an unknown card DECLINES (no card row to log against)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const d = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_missing",
      increaseAuthId: "auth_missing",
      amountCents: 100,
    });
    expect(d.approved).toBe(false);
  });

  test("is idempotent per authorization id (one log, replayed decision)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "card_idem",
    });
    const a = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_idem",
      increaseAuthId: "auth_idem",
      amountCents: 100,
    });
    const b = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_idem",
      increaseAuthId: "auth_idem",
      amountCents: 100,
    });
    expect(a.approved).toBe(b.approved);
    expect((await authLogFor(s, "auth_idem")).length).toBe(1);
  });
});

// ── flagPersonalCharge + repayment ───────────────────────────────────────────

describe("flagPersonalCharge", () => {
  test("sets isPersonal + creates one pending repayment (idempotent)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 6420 });

    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });
    expect(rep.status).toBe("pending");
    expect(rep.payerPersonId).toBe(holder);
    expect(rep.amountCents).toBe(6420);

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.isPersonal).toBe(true);
    expect(txn?.repaymentId).toBe(rep.id);

    // Idempotent: re-flag → same repayment, still one row.
    const again = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });
    expect(again.id).toBe(rep.id);
    const reps = await run(s.t, (ctx) =>
      ctx.db
        .query("personalRepayments")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .collect(),
    );
    expect(reps.length).toBe(1);
  });

  test("a non-cardholder, non-manager cannot flag (FORBIDDEN)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Caller is a viewer, and NOT the cardholder.
    const caller = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await grantRole(s, caller, "viewer");
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 500 });

    let caught: unknown;
    try {
      await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "FORBIDDEN",
    );
  });

  // ── D4: manager-initiated flag (a manager flagging SOMEONE ELSE's charge) ──
  test("a finance manager can flag ANOTHER person's card charge — repayment created, owned by the cardholder", async () => {
    // Manager-flagging-someone-else's-charge schedules a best-effort
    // notification (`notifyPersonalChargeFlagged`) — drain it, same pattern as
    // the dedicated notification test below, else it leaks past this test's
    // torn-down Convex context ("Write outside of transaction
    // _scheduled_functions", CI-only flake — see docs/architecture note).
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s); // the caller (s.as) is a manager, NOT the cardholder
      const holder = await seedPerson(s, { name: "Holder" });
      const cardId = await seedCard(s, { cardholderPersonId: holder });
      const txnId = await seedCardTxn(s, { cardId, amountCents: 3300 });

      const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
        transactionId: txnId,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(rep.status).toBe("pending");
      // The repayment is owned by the CARDHOLDER, not the manager who flagged it.
      expect(rep.payerPersonId).toBe(holder);
      expect(rep.amountCents).toBe(3300);

      const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
      expect(txn?.isPersonal).toBe(true);
      expect(txn?.repaymentId).toBe(rep.id);

      // Exactly one repayment row exists for this charge.
      const reps = await run(s.t, (ctx) =>
        ctx.db
          .query("personalRepayments")
          .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
          .collect(),
      );
      expect(reps.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("manager-initiated flag schedules a best-effort notification to the cardholder (degrades without RESEND_API_KEY, never throws)", async () => {
    vi.useFakeTimers();
    const prevResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const holder = await seedPerson(s, {
        name: "Holder",
        pwEmail: "holder@publicworship.life",
      });
      const cardId = await seedCard(s, { cardholderPersonId: holder });
      const txnId = await seedCardTxn(s, { cardId, amountCents: 1234 });

      const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
        transactionId: txnId,
      });

      // Drains the `ctx.scheduler.runAfter(0, notifyPersonalChargeFlagged, …)`
      // job the mutation queued — must not throw even though Resend degrades.
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      // The contact resolver the notification uses returns the right payer +
      // amount (exercised directly here since the action itself only logs).
      const contact = await s.t.query(internal.cards.getPersonalChargeFlagContact, {
        repaymentId: rep.id,
      });
      expect(contact?.email).toBe("holder@publicworship.life");
      expect(contact?.amountCents).toBe(1234);
    } finally {
      vi.useRealTimers();
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });

  test("a cardholder flagging their OWN charge is the same path (no FORBIDDEN) and needs no manager grant", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 800 });

    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });
    expect(rep.payerPersonId).toBe(holder);
  });
});

describe("markRepaymentPaid", () => {
  test("posts exactly one flow:transfer offsetting credit, idempotently", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 6420 });

    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });
    const paid = await s.as.mutation(api.cards.markRepaymentPaid, {
      repaymentId: rep.id,
    });
    expect(paid.status).toBe("paid");
    expect(paid.creditTransactionId).toBeTruthy();

    // Exactly one offsetting credit, excluded from spend (flow:"transfer").
    const credits = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    ).then((rows) => rows.filter((r) => r.source === "repayment"));
    expect(credits.length).toBe(1);
    expect(credits[0].flow).toBe("transfer");
    expect(credits[0].amountCents).toBe(6420);
    expect(credits[0].personId).toBe(holder);
    expect(credits[0].repaymentId).toBe(rep.id);

    // Idempotent: re-settle → no second credit.
    const again = await s.as.mutation(api.cards.markRepaymentPaid, {
      repaymentId: rep.id,
    });
    expect(again.creditTransactionId).toBe(paid.creditTransactionId);
    const creditsAfter = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    ).then((rows) => rows.filter((r) => r.source === "repayment"));
    expect(creditsAfter.length).toBe(1);
  });

  test("the payer (cardholder) cannot self-settle — manager-only", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Caller = the cardholder, viewer only (NOT a manager).
    const me = await seedPerson(s, { name: "Me", userId: s.userId });
    await grantRole(s, me, "viewer");
    const cardId = await seedCard(s, { cardholderPersonId: me });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 1000 });
    // The cardholder may flag their own charge…
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });
    // …but may NOT self-confirm the money as received (would zero their spend
    // without paying).
    await expect(
      s.as.mutation(api.cards.markRepaymentPaid, { repaymentId: rep.id }),
    ).rejects.toBeInstanceOf(ConvexError);
    // No offsetting credit was posted.
    expect((await repaymentCredits(s)).length).toBe(0);
  });
});

// ── myPersonalRepayments (D4: the bidirectional "You owe" data source) ──────

describe("myPersonalRepayments", () => {
  test("returns the caller's own repayments (every status), scoped to their chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    // Dual-hatted (holder + manager) so `s.as` can also confirm receipt on
    // their own repayment below — same accepted pattern as the ACH-linking
    // tests above (`asChapterManager`/`grantRole` on the caller's own person).
    await grantRole(s, holder, "manager");
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const pendingTxn = await seedCardTxn(s, { cardId, amountCents: 1500 });
    const paidTxn = await seedCardTxn(s, { cardId, amountCents: 2500 });

    const pendingRep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: pendingTxn,
    });
    const paidRep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: paidTxn,
    });
    // Settle the second one.
    await s.as.mutation(api.cards.markRepaymentPaid, {
      repaymentId: paidRep.id,
    });

    const mine = await s.as.query(api.cards.myPersonalRepayments, {});
    expect(mine.length).toBe(2);
    const byId = new Map(mine.map((r) => [r.id, r]));
    expect(byId.get(pendingRep.id)?.status).toBe("pending");
    expect(byId.get(pendingRep.id)?.amountCents).toBe(1500);
    // The PAID one still shows up (not silently dropped) — a consumer that
    // only reads "pending" rows would make it look never-flagged again.
    expect(byId.get(paidRep.id)?.status).toBe("paid");
  });

  test("never returns another person's repayments", async () => {
    // Manager flagging a DIFFERENT person's charge schedules a best-effort
    // notification — drain it so it doesn't leak past this test's torn-down
    // Convex context (same CI-only flake as the dedicated notification test).
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const other = await seedPerson(s, { name: "Someone else" });
      const cardId = await seedCard(s, { cardholderPersonId: other });
      const txnId = await seedCardTxn(s, { cardId, amountCents: 900 });
      await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      // The caller (the manager) has no roster-person repayments of their own.
      const mine = await s.as.query(api.cards.myPersonalRepayments, {});
      expect(mine).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("degrades to [] with no chapter/roster row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No `people` row created for the caller.
    const mine = await s.as.query(api.cards.myPersonalRepayments, {});
    expect(mine).toEqual([]);
  });
});

// ── personalRepaymentsOutstanding (D4: the manager chapter-scope aggregate) ──

describe("personalRepaymentsOutstanding", () => {
  test("counts + sums only NOT-YET-PAID repayments in the caller's chapter", async () => {
    // Each of the three manager-flags-someone-else's-charge calls below
    // schedules a best-effort notification — drain them all so none leak past
    // this test's torn-down Convex context (same CI-only flake as the
    // dedicated notification test).
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const holderA = await seedPerson(s, { name: "Holder A" });
      const holderB = await seedPerson(s, { name: "Holder B" });
      const cardA = await seedCard(s, { cardholderPersonId: holderA });
      const cardB = await seedCard(s, { cardholderPersonId: holderB });
      const txnA = await seedCardTxn(s, { cardId: cardA, amountCents: 1000 });
      const txnB = await seedCardTxn(s, { cardId: cardB, amountCents: 2000 });
      const txnC = await seedCardTxn(s, { cardId: cardA, amountCents: 4000 });

      await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnA });
      await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnB });
      const repC = await s.as.mutation(api.cards.flagPersonalCharge, {
        transactionId: txnC,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      // Settle one of the three — it must drop out of the aggregate.
      await s.as.mutation(api.cards.markRepaymentPaid, { repaymentId: repC.id });

      const agg = await s.as.query(api.cards.personalRepaymentsOutstanding, {});
      expect(agg.count).toBe(2);
      expect(agg.totalCents).toBe(3000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("never counts another chapter's repayments", async () => {
    // Manager flagging a DIFFERENT person's charge schedules a best-effort
    // notification — drain it so it doesn't leak past this test's torn-down
    // Convex context (same CI-only flake as the dedicated notification test).
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const holder = await seedPerson(s, { name: "Holder" });
      const cardId = await seedCard(s, { cardholderPersonId: holder });
      const txnId = await seedCardTxn(s, { cardId, amountCents: 5000 });
      await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      // A second, unrelated chapter with its own manager sees nothing.
      const s2 = await setupChapter(newT(), { email: "other@publicworship.life" });
      await seedManager(s2);
      const agg = await s2.as.query(api.cards.personalRepaymentsOutstanding, {});
      expect(agg.count).toBe(0);
      expect(agg.totalCents).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("gated to viewer+ — a caller with no finance role is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "No role", userId: s.userId });

    let caught: unknown;
    try {
      await s.as.query(api.cards.personalRepaymentsOutstanding, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "FORBIDDEN",
    );
  });

  test("a plain viewer (below manager) CAN read the aggregate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const viewer = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await grantRole(s, viewer, "viewer");
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 750 });
    // A viewer can't flag someone else's charge (not a manager), so seed the
    // repayment directly to isolate the read-gate from the write-gate.
    await run(s.t, (ctx) =>
      ctx.db.insert("personalRepayments", {
        chapterId: s.chapterId,
        transactionId: txnId,
        payerPersonId: holder,
        amountCents: 750,
        method: "ach",
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const agg = await s.as.query(api.cards.personalRepaymentsOutstanding, {});
    expect(agg.count).toBe(1);
    expect(agg.totalCents).toBe(750);
  });
});

describe("initiateRepayment (degrade path)", () => {
  test("without INCREASE_API_KEY leaves the repayment pending", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    // The caller IS the payer (holder linked to the caller user).
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 1000 });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });

    const out = await s.as.action(api.cards.initiateRepayment, {
      repaymentId: rep.id,
      method: "ach",
    });
    expect(out.status).toBe("pending");
    expect(out.creditTransactionId).toBeNull();
  });
});

// ── linkRepaymentBankAccount + the real ACH repayment charge ────────────────

describe("linkRepaymentBankAccount + initiateRepayment (real ACH once linked)", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.INCREASE_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.INCREASE_API_KEY;
    else process.env.INCREASE_API_KEY = originalKey;
  });

  /** An active PRODUCTION Increase account for the chapter (default mode). */
  async function seedActiveAccount(s: ChapterSetup): Promise<void> {
    const now = Date.now();
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: false,
        onboardingStatus: "active",
        increaseAccountId: "account_prod_1",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  test("the payer links their own bank account, never persisting the raw account number", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller IS the payer (the cardholder) — a single person row, so the
    // payer-only link gate resolves the caller to the payer.
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 1000 });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });

    process.env.INCREASE_API_KEY = "test_key";
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/external_accounts")) {
        calls.push(init?.body ? JSON.parse(String(init.body)) : {});
        return new Response(JSON.stringify({ id: "extacct_holder_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.cards.linkRepaymentBankAccount, {
      repaymentId: rep.id,
      routingNumber: "011000015",
      accountNumber: "444555666",
    });
    expect(result.linked).toBe(true);
    expect(calls[0].routing_number).toBe("011000015");

    const stored = await run(s.t, (ctx) => ctx.db.get(rep.id));
    expect(stored?.payerExternalAccountId).toBe("extacct_holder_1");
    expect(stored?.payerAccountLast4).toBe("5666");
    expect(JSON.stringify(stored)).not.toContain("444555666");
  });

  test("a caller who is neither the payer nor a manager cannot link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" }); // not the caller
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 1000 });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });

    // A second member of the SAME chapter — a viewer, not the payer.
    const strangerUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "stranger@publicworship.life" }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId: strangerUserId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    await seedPerson(s, { name: "Stranger", userId: strangerUserId });
    await grantRole(
      s,
      (await run(s.t, (ctx) =>
        ctx.db
          .query("people")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect(),
      )).find((p) => p.name === "Stranger")!._id,
      "viewer",
    );
    const strangerClient = s.t.withIdentity({
      subject: `${strangerUserId}|session`,
      issuer: "test",
    });

    process.env.INCREASE_API_KEY = "test_key";
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called for an unauthorized linker");
    }) as unknown as typeof fetch;

    await expect(
      strangerClient.action(api.cards.linkRepaymentBankAccount, {
        repaymentId: rep.id,
        routingNumber: "011000015",
        accountNumber: "444555666",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("even fully linked, the real ACH DEBIT is GATED OFF — degrades to pending (no /ach_transfers), settles via markRepaymentPaid", async () => {
    // BLOCKER 2: the debit is disabled (REPAYMENT_DEBIT_ENABLED=false) because
    // this PR ships no debit-bounce state machine. Linking still works, but
    // `initiateRepayment` must NOT fire a debit — it degrades to the manual path.
    const t = newT();
    const s = await setupChapter(t);
    await seedActiveAccount(s);
    // The caller is the payer AND a manager (one person row) — the payer links,
    // the same person later confirms receipt via the manager-only markRepaymentPaid.
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    await grantRole(s, holder, "manager");
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 4200 });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });

    process.env.INCREASE_API_KEY = "test_key";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/external_accounts")) {
        return new Response(JSON.stringify({ id: "extacct_holder_2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // A DEBIT must NEVER be originated while the kill-switch is off.
      if (path.includes("/ach_transfers")) {
        throw new Error("the ACH debit must not fire while gated off");
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;

    await s.as.action(api.cards.linkRepaymentBankAccount, {
      repaymentId: rep.id,
      routingNumber: "011000015",
      accountNumber: "444555666",
    });

    // Degrades: stays pending, no offsetting credit posted yet.
    const out = await s.as.action(api.cards.initiateRepayment, {
      repaymentId: rep.id,
      method: "ach",
    });
    expect(out.status).toBe("pending");
    expect(out.creditTransactionId).toBeNull();

    // The manual confirmation still settles it, exactly as before this PR.
    const settled = await s.as.mutation(api.cards.markRepaymentPaid, {
      repaymentId: rep.id,
    });
    expect(settled.status).toBe("paid");
    expect(settled.creditTransactionId).toBeTruthy();

    const credits = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    ).then((rows) => rows.filter((r) => r.source === "repayment"));
    expect(credits.length).toBe(1);
    expect(credits[0].amountCents).toBe(4200);
  });

  test("a manager (not the payer) cannot link a repayment bank account — payer-only", async () => {
    // IMPORTANT 3: linking supplies raw bank numbers that originate an ACH debit;
    // a manager must never enter someone else's account. The payer is a DIFFERENT
    // person than the manager caller here, so the manager's link attempt fails.
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s); // the caller (s.as) is a finance manager
    const holder = await seedPerson(s, { name: "Holder" }); // NOT the caller
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 1000 });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });

    process.env.INCREASE_API_KEY = "test_key";
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called for a manager link attempt");
    }) as unknown as typeof fetch;

    await expect(
      s.as.action(api.cards.linkRepaymentBankAccount, {
        repaymentId: rep.id,
        routingNumber: "011000015",
        accountNumber: "444555666",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("cannot link once the repayment is already paid", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller is the payer AND a manager (one person row) — so the rejection
    // is the "already settled" guard, not the payer-only gate.
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    await grantRole(s, holder, "manager");
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 1000 });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });
    await s.as.mutation(api.cards.markRepaymentPaid, { repaymentId: rep.id });

    process.env.INCREASE_API_KEY = "test_key";
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called once already settled");
    }) as unknown as typeof fetch;

    await expect(
      s.as.action(api.cards.linkRepaymentBankAccount, {
        repaymentId: rep.id,
        routingNumber: "011000015",
        accountNumber: "444555666",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("TOCTOU: attachRepaymentExternalAccount no-ops if the repayment settled mid-link", async () => {
    // IMPORTANT 5: the link gate saw an unsettled repayment, then the slow
    // Increase call ran; if a manager confirmed receipt (markRepaymentPaid) in
    // the meantime, a funding source must NOT be stamped onto the settled row.
    const t = newT();
    const s = await setupChapter(t);
    // The caller is the payer AND a manager (one person row).
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    await grantRole(s, holder, "manager");
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 1000 });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });

    process.env.INCREASE_API_KEY = "test_key";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/external_accounts")) {
        // A manager settles the repayment while the External Account is created.
        await s.as.mutation(api.cards.markRepaymentPaid, { repaymentId: rep.id });
        return new Response(JSON.stringify({ id: "extacct_race_rep" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.cards.linkRepaymentBankAccount, {
      repaymentId: rep.id,
      routingNumber: "011000015",
      accountNumber: "444555666",
    });
    expect(result.linked).toBe(true); // Increase created the account…
    const stored = await run(s.t, (ctx) => ctx.db.get(rep.id));
    // …but the funding source was NOT stamped onto the already-settled repayment.
    expect(stored?.payerExternalAccountId).toBeUndefined();
    expect(stored?.status).toBe("paid");
  });

  test("TOCTOU: applyRepaymentPaid does NOT double-post if already settled (flags for manual refund)", async () => {
    // IMPORTANT 5: if markRepaymentPaid settled the repayment between beginRepayment
    // and the debit landing, applyRepaymentPaid must not post a SECOND credit — the
    // real debit is flagged for manual review/refund instead.
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 1000 });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });
    // Already settled by the manual path.
    await s.as.mutation(api.cards.markRepaymentPaid, { repaymentId: rep.id });
    const before = await run(s.t, (ctx) => ctx.db.get(rep.id));

    // A late debit-settle arrives — must NOT post a second offsetting credit.
    const out = await s.t.mutation(internal.cards.applyRepaymentPaid, {
      repaymentId: rep.id,
      increaseRef: "ach_late_debit",
    });
    expect(out.status).toBe("paid");
    const after = await run(s.t, (ctx) => ctx.db.get(rep.id));
    // The original credit is untouched — no second credit, ref not overwritten.
    expect(after?.creditTransactionId).toBe(before?.creditTransactionId);

    const credits = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    ).then((rows) => rows.filter((r) => r.source === "repayment"));
    expect(credits.length).toBe(1);
  });
});

// ── autoLockOverdueCards ─────────────────────────────────────────────────────

describe("autoLockOverdueCards", () => {
  test("locks an overdue receiptless charge; unlocks after a receipt; current stays active", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });

    // Card A: an 8-day-old charge with no receipt → should auto-lock.
    const cardA = await seedCard(s, { cardholderPersonId: holder });
    const oldTxn = await seedCardTxn(s, {
      cardId: cardA,
      amountCents: 5000,
      ageDays: 8,
    });
    // Card B: a recent receiptless charge → within grace, stays active.
    const cardB = await seedCard(s, { cardholderPersonId: holder });
    await seedCardTxn(s, { cardId: cardB, amountCents: 2000 });
    // Card C: a MANUAL lock (no grace stamp) → never auto-unlocked.
    const cardC = await seedCard(s, {
      cardholderPersonId: holder,
      status: "locked",
    });

    const r1 = await s.t.mutation(internal.cards.autoLockOverdueCards, {});
    expect(r1.lockedCount).toBe(1);
    const a1 = await run(s.t, (ctx) => ctx.db.get(cardA));
    expect(a1?.status).toBe("locked");
    expect(a1?.receiptGraceEndsAt).toBeTruthy();
    expect((await run(s.t, (ctx) => ctx.db.get(cardB)))?.status).toBe("active");
    expect((await run(s.t, (ctx) => ctx.db.get(cardC)))?.status).toBe("locked");

    // Attach a receipt to the overdue charge → the next sweep self-heals.
    const receiptId = await storeBlob(s.t);
    await run(s.t, (ctx) =>
      ctx.db.patch(oldTxn, { receiptStorageId: receiptId }),
    );
    const r2 = await s.t.mutation(internal.cards.autoLockOverdueCards, {});
    expect(r2.unlockedCount).toBe(1);
    const a2 = await run(s.t, (ctx) => ctx.db.get(cardA));
    expect(a2?.status).toBe("active");
    expect(a2?.receiptGraceEndsAt).toBeUndefined();
    // The manual lock is untouched.
    expect((await run(s.t, (ctx) => ctx.db.get(cardC)))?.status).toBe("locked");
  });
});

// ── attachReceipt: immediate unlock-on-upload ────────────────────────────────

describe("attachReceipt (finances.ts) unlocking a card immediately", () => {
  test("unlocks a card auto-locked for exactly the receipt just attached", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const oldTxn = await seedCardTxn(s, {
      cardId,
      amountCents: 5000,
      ageDays: 8,
    });

    // Cron locks it first (the same overdue-receipt predicate attachReceipt reuses).
    await s.t.mutation(internal.cards.autoLockOverdueCards, {});
    expect((await run(s.t, (ctx) => ctx.db.get(cardId)))?.status).toBe(
      "locked",
    );

    const receiptId = await storeBlob(s.t);
    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: oldTxn,
      storageId: receiptId,
    });

    // Unlocked IMMEDIATELY — no second cron sweep needed.
    const card = await run(s.t, (ctx) => ctx.db.get(cardId));
    expect(card?.status).toBe("active");
    expect(card?.receiptGraceEndsAt).toBeUndefined();
    const txn = await run(s.t, (ctx) => ctx.db.get(oldTxn));
    expect(txn?.receiptStorageId).toBe(receiptId);
  });

  test("does NOT unlock while another overdue charge on the card remains", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnA = await seedCardTxn(s, {
      cardId,
      amountCents: 5000,
      ageDays: 8,
    });
    const txnB = await seedCardTxn(s, {
      cardId,
      amountCents: 3000,
      ageDays: 9,
    });

    await s.t.mutation(internal.cards.autoLockOverdueCards, {});
    expect((await run(s.t, (ctx) => ctx.db.get(cardId)))?.status).toBe(
      "locked",
    );

    // Attach a receipt to only ONE of the two overdue charges.
    const receiptId = await storeBlob(s.t);
    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txnA,
      storageId: receiptId,
    });

    // Still locked — txnB is still missing its receipt and overdue.
    let card = await run(s.t, (ctx) => ctx.db.get(cardId));
    expect(card?.status).toBe("locked");
    expect(card?.receiptGraceEndsAt).toBeTruthy();

    // Now clear the last one — the card unlocks immediately.
    const receiptId2 = await storeBlob(s.t);
    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txnB,
      storageId: receiptId2,
    });
    card = await run(s.t, (ctx) => ctx.db.get(cardId));
    expect(card?.status).toBe("active");
    expect(card?.receiptGraceEndsAt).toBeUndefined();
  });

  test("a MANUAL lock (no grace stamp) is left untouched by attachReceipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      status: "locked", // manual lock — no receiptGraceEndsAt
    });
    const txn = await seedCardTxn(s, {
      cardId,
      amountCents: 5000,
      ageDays: 8,
    });

    const receiptId = await storeBlob(s.t);
    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txn,
      storageId: receiptId,
    });

    expect((await run(s.t, (ctx) => ctx.db.get(cardId)))?.status).toBe(
      "locked",
    );
  });

  test("attaching a receipt clears the reminder timeline on that transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txn = await seedCardTxn(s, { cardId, amountCents: 2000, ageDays: 4 });

    await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect((await run(s.t, (ctx) => ctx.db.get(txn)))?.receiptReminderStage).toBe(
      "escalated",
    );

    const receiptId = await storeBlob(s.t);
    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txn,
      storageId: receiptId,
    });

    const after = await run(s.t, (ctx) => ctx.db.get(txn));
    expect(after?.receiptReminderStage).toBeUndefined();
    expect(after?.lastReminderSentAt).toBeUndefined();
  });

  test("attaching a receipt to a non-card txn (no cardId) doesn't throw", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const txn = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 4200,
        postedAt: Date.now(),
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    const receiptId = await storeBlob(s.t);
    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txn,
      storageId: receiptId,
    });

    const after = await run(s.t, (ctx) => ctx.db.get(txn));
    expect(after?.receiptStorageId).toBe(receiptId);
  });
});

// ── setTransactionStatus (finances.ts): clears the reminder timeline too ────

describe("setTransactionStatus clearing the reminder timeline", () => {
  test.each(["reconciled", "excluded"] as const)(
    "transitioning to %s clears receiptReminderStage + lastReminderSentAt",
    async (status) => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const holder = await seedPerson(s, { name: "Holder" });
      const cardId = await seedCard(s, { cardholderPersonId: holder });
      const txn = await seedCardTxn(s, {
        cardId,
        amountCents: 2000,
        ageDays: 4,
      });

      await s.t.mutation(internal.cards.advanceReceiptReminders, {});
      expect(
        (await run(s.t, (ctx) => ctx.db.get(txn)))?.receiptReminderStage,
      ).toBe("escalated");

      await s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txn,
        status,
      });

      const after = await run(s.t, (ctx) => ctx.db.get(txn));
      expect(after?.status).toBe(status);
      expect(after?.receiptReminderStage).toBeUndefined();
      expect(after?.lastReminderSentAt).toBeUndefined();
    },
  );

  test("transitioning to categorized leaves the reminder timeline untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txn = await seedCardTxn(s, { cardId, amountCents: 2000, ageDays: 4 });

    await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    const before = await run(s.t, (ctx) => ctx.db.get(txn));
    expect(before?.receiptReminderStage).toBe("escalated");

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txn,
      status: "categorized",
    });

    const after = await run(s.t, (ctx) => ctx.db.get(txn));
    expect(after?.receiptReminderStage).toBe("escalated");
    expect(after?.lastReminderSentAt).toBe(before?.lastReminderSentAt);
  });
});

// ── advanceReceiptReminders (day-1 flag / day-3 escalate) ────────────────────

describe("advanceReceiptReminders", () => {
  test("flags a 2-day-old missing-receipt charge; leaves a same-day charge alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const todayTxn = await seedCardTxn(s, { cardId, amountCents: 1000 });
    const twoDayTxn = await seedCardTxn(s, {
      cardId,
      amountCents: 1500,
      ageDays: 2,
    });

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.flagged).toEqual([twoDayTxn]);
    expect(r.escalated).toEqual([]);

    expect(
      (await run(s.t, (ctx) => ctx.db.get(todayTxn)))?.receiptReminderStage,
    ).toBeUndefined();
    const flaggedTxn = await run(s.t, (ctx) => ctx.db.get(twoDayTxn));
    expect(flaggedTxn?.receiptReminderStage).toBe("flagged");
    expect(flaggedTxn?.lastReminderSentAt).toBeTruthy();
  });

  test("escalates a 4-day-old missing-receipt charge directly (skips 'flagged')", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const fourDayTxn = await seedCardTxn(s, {
      cardId,
      amountCents: 2500,
      ageDays: 4,
    });

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.flagged).toEqual([]);
    expect(r.escalated).toEqual([fourDayTxn]);
    expect(
      (await run(s.t, (ctx) => ctx.db.get(fourDayTxn)))?.receiptReminderStage,
    ).toBe("escalated");
  });

  test("is idempotent — an already-escalated charge isn't re-returned on the next sweep", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txn = await seedCardTxn(s, { cardId, amountCents: 2500, ageDays: 4 });

    const r1 = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r1.escalated).toEqual([txn]);
    const firstStamp = (await run(s.t, (ctx) => ctx.db.get(txn)))
      ?.lastReminderSentAt;

    const r2 = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r2.escalated).toEqual([]);
    expect(r2.flagged).toEqual([]);
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txn)))?.lastReminderSentAt,
    ).toBe(firstStamp);
  });

  test("caps stage transitions at REMINDER_BATCH_LIMIT per run, oldest charge first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const CAP = 25; // mirrors REMINDER_BATCH_LIMIT in cards.ts
    const total = CAP + 5;
    // All well past RECEIPT_ESCALATE_DAYS (3) and well under the 30-day
    // seed-only horizon, so every one of these is normally email-eligible.
    // Fractional ageDays gives each a distinct postedAt — higher `i` is
    // posted further in the past (older).
    const txns: Id<"transactions">[] = [];
    for (let i = 0; i < total; i++) {
      txns.push(
        await seedCardTxn(s, {
          cardId,
          amountCents: 1000 + i,
          ageDays: 4 + i * 0.01,
        }),
      );
    }

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.flagged).toEqual([]);
    expect(r.escalated).toHaveLength(CAP);
    // The CAP oldest (highest-`i`) charges transition; the 5 newest are left
    // for a later run — proves the backlog drains gradually, oldest first.
    const expectedTransitioned = new Set(txns.slice(5));
    expect(new Set(r.escalated)).toEqual(expectedTransitioned);
    for (const id of txns.slice(0, 5)) {
      expect(
        (await run(s.t, (ctx) => ctx.db.get(id)))?.receiptReminderStage,
      ).toBeUndefined();
    }
  });

  test("charges past the seed-only horizon get their stage set silently — no email, no timestamp", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const ancientTxn = await seedCardTxn(s, {
      cardId,
      amountCents: 5000,
      ageDays: 45, // past the 30-day REMINDER_SEED_ONLY_DAYS horizon
    });

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    // Not returned for email...
    expect(r.escalated).not.toContain(ancientTxn);
    expect(r.flagged).not.toContain(ancientTxn);

    // ...but the stage IS set, so the grid still reflects reality; no
    // reminder-sent stamp since none was actually sent.
    const after = await run(s.t, (ctx) => ctx.db.get(ancientTxn));
    expect(after?.receiptReminderStage).toBe("escalated");
    expect(after?.lastReminderSentAt).toBeUndefined();
  });

  test("skips isPersonal charges entirely — never flagged or escalated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const personalTxn = await seedCardTxn(s, {
      cardId,
      amountCents: 3000,
      ageDays: 4,
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(personalTxn, { isPersonal: true }),
    );

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.flagged).toEqual([]);
    expect(r.escalated).toEqual([]);
    expect(
      (await run(s.t, (ctx) => ctx.db.get(personalTxn)))?.receiptReminderStage,
    ).toBeUndefined();
  });

  test("a charge that already has a receipt is never flagged or escalated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const receiptId = await storeBlob(s.t);
    const txn = await seedCardTxn(s, {
      cardId,
      amountCents: 1200,
      ageDays: 5,
      receiptStorageId: receiptId,
    });

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.flagged).toEqual([]);
    expect(r.escalated).toEqual([]);
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txn)))?.receiptReminderStage,
    ).toBeUndefined();
  });
});

// ── sendReceiptReminders (the daily action: advance + best-effort email) ─────

describe("sendReceiptReminders", () => {
  test("advances stages and reports counts without throwing (no RESEND_API_KEY)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    await seedCardTxn(s, { cardId, amountCents: 1500, ageDays: 2 });
    await seedCardTxn(s, { cardId, amountCents: 2500, ageDays: 4 });
    const prevResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    try {
      const out = await s.t.action(internal.cards.sendReceiptReminders, {});
      expect(out.flaggedCount).toBe(1);
      expect(out.escalatedCount).toBe(1);
    } finally {
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });
});

// ── issue / list / setControls (gates + tenancy) ─────────────────────────────

describe("issueCard", () => {
  test("degrades without INCREASE_API_KEY (creates the row, no increase id)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const manager = await seedManager(s);

    const card = await s.as.action(api.cards.issueCard, {
      cardholderPersonId: manager,
      type: "virtual",
      monthlyCapCents: 50000,
    });
    expect(card.cardholderPersonId).toBe(manager);
    expect(card.status).toBe("active");
    expect(card.last4).toBeNull();
    expect(card.monthlyCapCents).toBe(50000);

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].increaseCardId).toBeUndefined();
  });

  test("rejects a cardholder without a @publicworship.life email (NOT_CARD_ELIGIBLE)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    // A person with no pw email is not card-eligible.
    const ineligible = await seedPerson(s, { name: "Outsider", pwEmail: null });

    await expect(
      s.as.action(api.cards.issueCard, {
        cardholderPersonId: ineligible,
        type: "virtual",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // No card row was minted for the ineligible holder.
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_cardholder", (q) =>
          q.eq("cardholderPersonId", ineligible),
        )
        .collect(),
    );
    expect(rows.length).toBe(0);
  });

  test("does not duplicate an active card for the same person", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const manager = await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await seedCard(s, { cardholderPersonId: holder });

    await s.as.action(api.cards.issueCard, {
      cardholderPersonId: holder,
      type: "physical",
    });
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_cardholder", (q) =>
          q.eq("cardholderPersonId", holder),
        )
        .collect(),
    );
    expect(rows.length).toBe(1);
    void manager;
  });

  test("hides a leftover sandbox account in production → degrades like no account", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await setSandboxMode(s, false); // production
    const holder = await seedPerson(s, { name: "Holder" });
    // A leftover sandbox/test account while the deployment is in production. It's
    // now INVISIBLE in production mode, so issueCard sees "no current-mode
    // account" and degrades (a vendorless card) rather than throwing.
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: true,
        onboardingStatus: "active",
        increaseAccountId: "sandbox_acct_1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const card = await s.as.action(api.cards.issueCard, {
      cardholderPersonId: holder,
      type: "virtual",
    });
    expect(card.status).toBe("active");
    // A degraded card was minted (no vendor id); the sandbox account is untouched.
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].increaseCardId).toBeUndefined();
  });

  test("safety-net guard: throws on an inconsistent row (sandbox:false but sandbox_ id) in production", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await setSandboxMode(s, false); // production
    const holder = await seedPerson(s, { name: "Holder" });
    // Inconsistent: the field says production, but the id is a sandbox id.
    // Mode-aware selection picks it (field wins), then the env-mismatch guard
    // catches the id/mode disagreement.
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: false,
        onboardingStatus: "active",
        increaseAccountId: "sandbox_acct_bad",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      s.as.action(api.cards.issueCard, {
        cardholderPersonId: holder,
        type: "virtual",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.length).toBe(0);
  });

  test("issues on the CURRENT-mode account when both environments exist", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    // A chapter with BOTH a sandbox and a production Increase account.
    const now = Date.now();
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: true,
        onboardingStatus: "active",
        increaseAccountId: "sandbox_acct_1",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: false,
        onboardingStatus: "active",
        increaseAccountId: "acct_prod_1",
        createdAt: now,
        updatedAt: now,
      }),
    );

    // Production mode → issues on the PRODUCTION account.
    await setSandboxMode(s, false);
    const prod = await s.as.mutation(internal.cards.beginIssueCard, {
      cardholderPersonId: holder,
      type: "virtual",
    });
    expect(prod.kind).toBe("created");
    if (prod.kind === "created") {
      expect(prod.increaseAccountId).toBe("acct_prod_1");
    }

    // Flip to sandbox mode → the NEXT card issues on the SANDBOX account.
    const holder2 = await seedPerson(s, { name: "Holder 2" });
    await setSandboxMode(s, true);
    const sb = await s.as.mutation(internal.cards.beginIssueCard, {
      cardholderPersonId: holder2,
      type: "virtual",
    });
    expect(sb.kind).toBe("created");
    if (sb.kind === "created") {
      expect(sb.increaseAccountId).toBe("sandbox_acct_1");
    }
  });

  test("a non-manager cannot issue a card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const caller = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await grantRole(s, caller, "viewer");
    await expect(
      s.as.action(api.cards.issueCard, {
        cardholderPersonId: caller,
        type: "virtual",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("retries a stranded vendorless card once the vendor is reachable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    // A previously-degraded active card with NO increaseCardId.
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    // Vendor now reachable: an active Increase account + a key.
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        onboardingStatus: "active",
        increaseAccountId: "acct_1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const prev = process.env.INCREASE_API_KEY;
    process.env.INCREASE_API_KEY = "test_key";
    try {
      const res = await s.as.mutation(internal.cards.beginIssueCard, {
        cardholderPersonId: holder,
        type: "virtual",
      });
      // It chose to RETRY on the SAME row, not return it vendorless forever.
      expect(res.kind).toBe("created");
      if (res.kind === "created") {
        expect(res.cardId).toBe(cardId);
        expect(res.increaseAccountId).toBe("acct_1");
      }
    } finally {
      if (prev === undefined) delete process.env.INCREASE_API_KEY;
      else process.env.INCREASE_API_KEY = prev;
    }
  });
});

describe("listCards / myCard", () => {
  test("listCards returns the chapter's cards with this-month spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      last4: "4242",
    });
    await seedCardTxn(s, { cardId, amountCents: 2500 });

    const rows = await s.as.query(api.cards.listCards, {});
    expect(rows.length).toBe(1);
    expect(rows[0].last4).toBe("4242");
    expect(rows[0].cardholderName).toBe("Holder");
    expect(rows[0].spentThisMonthCents).toBe(2500);
  });

  test("myCard returns the caller's own card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedManager(s); // person linked to the caller user
    await seedCard(s, { cardholderPersonId: me, last4: "1111" });

    const rows = await s.as.query(api.cards.myCard, {});
    expect(rows.length).toBe(1);
    expect(rows[0].last4).toBe("1111");
    expect(rows[0].cardholderPersonId).toBe(me);
  });

  test("production mode hides a sandbox_ card, shows a prod card + a null-id degraded card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await setSandboxMode(s, false); // production
    const holder = await seedPerson(s, { name: "Holder" });

    await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "sandbox_card_1",
      last4: "0001",
    });
    await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "card_prod_1",
      last4: "0002",
    });
    await seedCard(s, { cardholderPersonId: holder, last4: "0003" }); // null id

    const rows = await s.as.query(api.cards.listCards, {});
    const last4s = rows.map((r) => r.last4).sort();
    expect(last4s).toEqual(["0002", "0003"]); // sandbox card hidden
  });

  test("sandbox mode inverts: shows the sandbox_ card + the degraded card, hides the prod card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await setSandboxMode(s, true); // sandbox
    const holder = await seedPerson(s, { name: "Holder" });

    await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "sandbox_card_1",
      last4: "0001",
    });
    await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "card_prod_1",
      last4: "0002",
    });
    await seedCard(s, { cardholderPersonId: holder, last4: "0003" }); // null id

    const rows = await s.as.query(api.cards.listCards, {});
    const last4s = rows.map((r) => r.last4).sort();
    expect(last4s).toEqual(["0001", "0003"]); // prod card hidden
  });

  test("myCard applies the same environment filter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedManager(s);
    await setSandboxMode(s, false); // production
    await seedCard(s, {
      cardholderPersonId: me,
      increaseCardId: "sandbox_card_1",
      last4: "0001",
    });
    await seedCard(s, {
      cardholderPersonId: me,
      increaseCardId: "card_prod_1",
      last4: "0002",
    });

    const rows = await s.as.query(api.cards.myCard, {});
    expect(rows.map((r) => r.last4)).toEqual(["0002"]);
  });
});

describe("setCardControls (gates + tenancy)", () => {
  test("a manager updates the two controls", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    const updated = await s.as.mutation(api.cards.setCardControls, {
      cardId,
      monthlyCapCents: 12345,
      validUntil: 999999999,
    });
    expect(updated.monthlyCapCents).toBe(12345);
    expect(updated.validUntil).toBe(999999999);
  });

  test("a card in another chapter is not settable", async () => {
    const t = newT();
    const sA = await setupChapter(t, { email: "a@publicworship.life" });
    await seedManager(sA);
    const sB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Boston",
    });
    const holderB = await seedPerson(sB, { name: "HolderB" });
    const cardB = await seedCard(sB, { cardholderPersonId: holderB });

    await expect(
      sA.as.mutation(api.cards.setCardControls, {
        cardId: cardB,
        monthlyCapCents: 1,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a viewer cannot lock a card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const caller = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await grantRole(s, caller, "viewer");
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    await expect(
      s.as.mutation(api.cards.lockCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── WP-C.1: freezeCard / unfreezeCard (self-serve, holder-only) ──────────────

describe("freezeCard / unfreezeCard", () => {
  const ENV = ["INCREASE_API_KEY", "INCREASE_SANDBOX_API_KEY"] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof ENV)[number], string>> = {};
  for (const k of ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test("the holder freezes their own active card instantly", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    const frozen = await s.as.action(api.cards.freezeCard, { cardId });
    expect(frozen.status).toBe("locked");
    expect(frozen.frozenByHolder).toBe(true);
  });

  test("a non-holder (no relation to the card) cannot freeze it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Someone Else", userId: s.userId });
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    await expect(
      s.as.action(api.cards.freezeCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a manager (not the holder) cannot use freezeCard — that's lockCard's job", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    await expect(
      s.as.action(api.cards.freezeCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("freezing a card already LOCKED for another reason (manager lock) is a no-op — never claims frozenByHolder", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      status: "locked", // a manager already locked this card
    });

    const result = await s.as.action(api.cards.freezeCard, { cardId });
    expect(result.status).toBe("locked");
    expect(result.frozenByHolder).toBe(false);

    // Because it was never claimed, the holder's `unfreezeCard` must NOT be
    // able to lift the manager's lock.
    await expect(
      s.as.action(api.cards.unfreezeCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("freezing an already-frozen card is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    await s.as.action(api.cards.freezeCard, { cardId });
    const second = await s.as.action(api.cards.freezeCard, { cardId });
    expect(second.status).toBe("locked");
    expect(second.frozenByHolder).toBe(true);
  });

  test("a canceled card can't be frozen", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      status: "canceled",
    });

    await expect(
      s.as.action(api.cards.freezeCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("the SAME holder unfreezes their own frozen card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    await s.as.action(api.cards.freezeCard, { cardId });
    const unfrozen = await s.as.action(api.cards.unfreezeCard, { cardId });
    expect(unfrozen.status).toBe("active");
    expect(unfrozen.frozenByHolder).toBe(false);
  });

  test("unfreezeCard cannot lift the receipt auto-lock (not the holder's own freeze)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      status: "locked",
      receiptGraceEndsAt: Date.now() + DAY_MS, // auto-locked, not holder-frozen
    });

    await expect(
      s.as.action(api.cards.unfreezeCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a non-holder cannot unfreeze someone else's frozen card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    await s.as.action(api.cards.freezeCard, { cardId });

    // A second member of the SAME chapter (not the holder) tries to unfreeze.
    const strangerUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "stranger@publicworship.life" }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId: strangerUserId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    await seedPerson(s, { name: "Stranger", userId: strangerUserId });
    const strangerClient = s.t.withIdentity({
      subject: `${strangerUserId}|session`,
      issuer: "test",
    });

    await expect(
      strangerClient.action(api.cards.unfreezeCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a manager's unlockCard clears a holder's freeze too", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    // Freeze as the holder — reuse a second caller identity for the holder.
    await run(s.t, (ctx) => ctx.db.patch(cardId, { status: "locked", frozenByHolder: true }));

    const unlocked = await s.as.mutation(api.cards.unlockCard, { cardId });
    expect(unlocked.status).toBe("active");
    expect(unlocked.frozenByHolder).toBe(false);
  });

  test("freeze PATCHes Increase's card status to disabled when a vendor id + key are present", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "card_1",
    });
    process.env.INCREASE_API_KEY = "prod_key";
    const calls = mockRecordingFetch({});

    await s.as.action(api.cards.freezeCard, { cardId });

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch!.url).toContain("/cards/card_1");
    expect(patch!.auth).toBe("Bearer prod_key");
  });

  test("unfreeze PATCHes Increase's card status to active", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "card_1",
    });
    process.env.INCREASE_API_KEY = "prod_key";
    await s.as.action(api.cards.freezeCard, { cardId });

    const calls = mockRecordingFetch({});
    await s.as.action(api.cards.unfreezeCard, { cardId });

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch!.url).toContain("/cards/card_1");
  });

  test("freeze degrades to a logged no-op without INCREASE_API_KEY (local state still flips)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "card_1",
    });
    delete process.env.INCREASE_API_KEY;
    delete process.env.INCREASE_SANDBOX_API_KEY;

    const frozen = await s.as.action(api.cards.freezeCard, { cardId });
    expect(frozen.status).toBe("locked");
    expect(frozen.frozenByHolder).toBe(true);
  });
});

// ── WP-C.1: cancelCard (FM + Treasurer only — never self-serve) ─────────────

describe("cancelCard", () => {
  const ENV = ["INCREASE_API_KEY"] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof ENV)[number], string>> = {};
  for (const k of ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test("a finance manager cancels a card permanently", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    const canceled = await s.as.action(api.cards.cancelCard, { cardId });
    expect(canceled.status).toBe("canceled");
  });

  test("the cardholder themselves cannot cancel their own card — not self-serve", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder", userId: s.userId });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    await expect(
      s.as.action(api.cards.cancelCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a plain viewer cannot cancel a card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const caller = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await grantRole(s, caller, "viewer");
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    await expect(
      s.as.action(api.cards.cancelCard, { cardId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("canceling is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });

    await s.as.action(api.cards.cancelCard, { cardId });
    const second = await s.as.action(api.cards.cancelCard, { cardId });
    expect(second.status).toBe("canceled");
  });

  test("a canceled card DECLINES a real-time authorization", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "card_x",
    });
    await s.as.action(api.cards.cancelCard, { cardId });

    const decision = await t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_x",
      increaseAuthId: "auth_1",
      amountCents: 500,
    });
    expect(decision.approved).toBe(false);
  });

  test("cancel PATCHes Increase's card status to canceled when a vendor id + key are present", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      increaseCardId: "card_1",
    });
    process.env.INCREASE_API_KEY = "prod_key";
    const calls = mockRecordingFetch({});

    await s.as.action(api.cards.cancelCard, { cardId });

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch!.url).toContain("/cards/card_1");
  });
});

// ── WP-C.1: request-a-card ────────────────────────────────────────────────────

describe("requestCard / myCardRequest / listCardRequests / decideCardRequest", () => {
  test("a card-eligible person submits a request", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Me", userId: s.userId });

    const req = await s.as.mutation(api.cards.requestCard, { note: "New hire" });
    expect(req.status).toBe("requested");
    expect(req.note).toBe("New hire");
  });

  test("an ineligible person (no @publicworship.life email) cannot request", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Me", userId: s.userId, pwEmail: null });

    await expect(
      s.as.mutation(api.cards.requestCard, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("only one open request at a time", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Me", userId: s.userId });

    await s.as.mutation(api.cards.requestCard, {});
    await expect(
      s.as.mutation(api.cards.requestCard, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("cannot request a card while already holding a live one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Me", userId: s.userId });
    await seedCard(s, { cardholderPersonId: me });

    await expect(
      s.as.mutation(api.cards.requestCard, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("myCardRequest returns the caller's own pending request; null once approved", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const requesterPersonId = await seedPerson(s, { name: "Me", userId: s.userId });

    const req = await s.as.mutation(api.cards.requestCard, {});
    expect(req.status).toBe("requested");

    const mine = await s.as.query(api.cards.myCardRequest, {});
    expect(mine?.status).toBe("requested");

    // A second member of the SAME chapter, a finance manager, approves it.
    const managerUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "manager@publicworship.life" }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId: managerUserId,
        chapterId: s.chapterId,
        role: "admin",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    const managerPersonId = await seedPerson(s, {
      name: "Manager",
      userId: managerUserId,
    });
    await grantRole(s, managerPersonId, "manager");
    const managerClient = s.t.withIdentity({
      subject: `${managerUserId}|session`,
      issuer: "test",
    });

    const decided = await managerClient.action(api.cards.decideCardRequest, {
      requestId: req.id,
      decision: "approve",
    });
    expect(decided.status).toBe("approved");
    expect(decided.personId).toBe(requesterPersonId);

    // Once approved, the caller's `myCard` reflects the new card; the request
    // banner goes away (avoids a stale "approved" banner sticking around).
    const mineAfter = await s.as.query(api.cards.myCardRequest, {});
    expect(mineAfter).toBeNull();
  });

  test("listCardRequests returns only pending requests in the caller's chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const requester = await seedPerson(s, { name: "Requester" });

    await run(s.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: s.chapterId,
        personId: requester,
        status: "requested",
        requestedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: s.chapterId,
        personId: requester,
        status: "denied",
        requestedAt: Date.now(),
        decidedAt: Date.now(),
      }),
    );

    const rows = await s.as.query(api.cards.listCardRequests, {});
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("requested");
  });

  test("a finance manager approves a request — triggers issueCard", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const requester = await seedPerson(s, {
      name: "Requester",
      pwEmail: "requester@publicworship.life",
    });
    const requestId = await run(s.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: s.chapterId,
        personId: requester,
        status: "requested",
        requestedAt: Date.now(),
      }),
    );

    const decided = await s.as.action(api.cards.decideCardRequest, {
      requestId,
      decision: "approve",
    });
    expect(decided.status).toBe("approved");
    expect(decided.cardId).not.toBeNull();

    const cards = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", requester))
        .collect(),
    );
    expect(cards.length).toBe(1);
    expect(cards[0].status).toBe("active");
  });

  test("a finance manager denies a request — no card created", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const requester = await seedPerson(s, { name: "Requester" });
    const requestId = await run(s.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: s.chapterId,
        personId: requester,
        status: "requested",
        requestedAt: Date.now(),
      }),
    );

    const decided = await s.as.action(api.cards.decideCardRequest, {
      requestId,
      decision: "deny",
    });
    expect(decided.status).toBe("denied");
    expect(decided.cardId).toBeNull();

    const cards = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", requester))
        .collect(),
    );
    expect(cards.length).toBe(0);
  });

  test("a non-manager cannot decide a request", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const caller = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await grantRole(s, caller, "viewer");
    const requester = await seedPerson(s, { name: "Requester" });
    const requestId = await run(s.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: s.chapterId,
        personId: requester,
        status: "requested",
        requestedAt: Date.now(),
      }),
    );

    await expect(
      s.as.action(api.cards.decideCardRequest, { requestId, decision: "approve" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("deciding an already-decided request throws", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const requester = await seedPerson(s, { name: "Requester" });
    const requestId = await run(s.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: s.chapterId,
        personId: requester,
        status: "denied",
        requestedAt: Date.now(),
        decidedAt: Date.now(),
      }),
    );

    await expect(
      s.as.action(api.cards.decideCardRequest, { requestId, decision: "approve" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a request in another chapter is not visible/decidable", async () => {
    const t = newT();
    const sA = await setupChapter(t, { email: "a@publicworship.life" });
    await seedManager(sA);
    const sB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Boston",
    });
    const requesterB = await seedPerson(sB, { name: "RequesterB" });
    const requestIdB = await run(sB.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: sB.chapterId,
        personId: requesterB,
        status: "requested",
        requestedAt: Date.now(),
      }),
    );

    const rowsA = await sA.as.query(api.cards.listCardRequests, {});
    expect(rowsA.length).toBe(0);

    await expect(
      sA.as.action(api.cards.decideCardRequest, {
        requestId: requestIdB,
        decision: "approve",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── handleIncreaseRealTimeDecision env routing (sandbox vs production) ────────

/** A recording `fetch` mock: captures each request's URL + Authorization header
 *  and returns the given JSON. */
function mockRecordingFetch(json: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; auth: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, method, auth });
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("handleIncreaseRealTimeDecision env routing", () => {
  const ENV = [
    "INCREASE_API_KEY",
    "INCREASE_SANDBOX_API_KEY",
    "INCREASE_API_BASE",
  ] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof ENV)[number], string>> = {};
  for (const k of ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  // The fetched RealTimeDecision object the handler reads (card_id +
  // settlement_amount). An unknown card just DECLINES — both the GET and the
  // action POST still fire, which is what we assert routing on.
  const RTD_JSON = {
    card_authorization: { card_id: "card_x", settlement_amount: 100 },
  };

  test("a sandbox_ decision id routes the fetch + action to the sandbox", async () => {
    const t = newT();
    // Both keys present — the `sandbox_` PREFIX (not mere presence) chooses env.
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    const calls = mockRecordingFetch(RTD_JSON);

    await t.action(internal.cards.handleIncreaseRealTimeDecision, {
      realTimeDecisionId: "sandbox_rtd_1",
    });

    const get = calls.find(
      (c) => c.method === "GET" && c.url.includes("/real_time_decisions/"),
    );
    expect(get).toBeTruthy();
    expect(new URL(get!.url).host).toBe("sandbox.increase.com");
    expect(get!.auth).toBe("Bearer sandbox_key");

    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeTruthy();
    expect(new URL(post!.url).host).toBe("sandbox.increase.com");
    expect(post!.auth).toBe("Bearer sandbox_key");
  });

  test("a non-prefixed decision id uses INCREASE_API_KEY + the prod base", async () => {
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    delete process.env.INCREASE_API_BASE; // default → api.increase.com
    const calls = mockRecordingFetch(RTD_JSON);

    await t.action(internal.cards.handleIncreaseRealTimeDecision, {
      realTimeDecisionId: "rtd_1",
    });

    const get = calls.find(
      (c) => c.method === "GET" && c.url.includes("/real_time_decisions/"),
    );
    expect(get).toBeTruthy();
    expect(new URL(get!.url).host).toBe("api.increase.com");
    expect(get!.auth).toBe("Bearer prod_key");
  });
});

// ── issueCard env routing (outbound self-selects by account id prefix) ────────

/** Seed the chapter's Increase account with a given (prefix-carrying) id. */
async function seedIncreaseAccount(
  s: ChapterSetup,
  increaseAccountId: string,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId: s.chapterId,
      onboardingStatus: "active",
      increaseAccountId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("issueCard env routing", () => {
  const ENV = [
    "INCREASE_API_KEY",
    "INCREASE_SANDBOX_API_KEY",
    "INCREASE_API_BASE",
  ] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof ENV)[number], string>> = {};
  for (const k of ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test("a sandbox_ account issues the card against the sandbox with sandbox creds", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    // A sandbox account is only legitimate in sandbox mode (else the env-mismatch
    // guard blocks issuing); match the mode so routing is exercised.
    await setSandboxMode(s, true);
    await seedIncreaseAccount(s, "sandbox_acct_1");

    // Both keys present — the account's `sandbox_` prefix (not presence) routes.
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    const calls = mockRecordingFetch({ id: "sandbox_card_1", last4: "4242" });

    const card = await s.as.action(api.cards.issueCard, {
      cardholderPersonId: holder,
      type: "virtual",
    });
    expect(card.last4).toBe("4242");

    const post = calls.find(
      (c) => c.method === "POST" && c.url.includes("/cards"),
    );
    expect(post).toBeTruthy();
    expect(new URL(post!.url).host).toBe("sandbox.increase.com");
    expect(post!.auth).toBe("Bearer sandbox_key");
  });

  test("a prod account issues the card against prod with the prod key", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await seedIncreaseAccount(s, "acct_1");

    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    delete process.env.INCREASE_API_BASE; // default → api.increase.com
    const calls = mockRecordingFetch({ id: "card_1", last4: "1111" });

    const card = await s.as.action(api.cards.issueCard, {
      cardholderPersonId: holder,
      type: "virtual",
    });
    expect(card.last4).toBe("1111");

    const post = calls.find(
      (c) => c.method === "POST" && c.url.includes("/cards"),
    );
    expect(post).toBeTruthy();
    expect(new URL(post!.url).host).toBe("api.increase.com");
    expect(post!.auth).toBe("Bearer prod_key");
  });
});
