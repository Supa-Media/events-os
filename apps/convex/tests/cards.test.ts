import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

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
  opts: { name: string; userId?: Id<"users"> } = { name: "Person" },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: true,
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

/** Seed a card charge (outflow) posted now (this Eastern month). */
async function seedCardTxn(
  s: ChapterSetup,
  opts: { cardId: Id<"cards">; amountCents: number; personId?: Id<"people"> },
): Promise<Id<"transactions">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "increase_card",
      flow: "outflow",
      amountCents: opts.amountCents,
      postedAt: now,
      cardId: opts.cardId,
      personId: opts.personId,
      status: "unreviewed",
      createdAt: now,
    }),
  );
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

  test("DECLINES when the charge would exceed the monthly cap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, {
      cardholderPersonId: holder,
      monthlyCapCents: 10000,
      increaseCardId: "card_cap",
    });
    // $80 already spent on the card this month.
    await seedCardTxn(s, { cardId, amountCents: 8000 });

    // $50 more → $130 > $100 cap → DECLINE.
    const over = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_cap",
      increaseAuthId: "auth_over",
      amountCents: 5000,
    });
    expect(over.approved).toBe(false);

    // $10 more → $90 ≤ $100 cap → APPROVE.
    const under = await s.t.mutation(internal.cards.decideCardAuthorization, {
      increaseCardId: "card_cap",
      increaseAuthId: "auth_under",
      amountCents: 1000,
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

  test("a non-cardholder, non-manager cannot flag", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Caller is a viewer, and NOT the cardholder.
    const caller = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await grantRole(s, caller, "viewer");
    const holder = await seedPerson(s, { name: "Holder" });
    const cardId = await seedCard(s, { cardholderPersonId: holder });
    const txnId = await seedCardTxn(s, { cardId, amountCents: 500 });

    await expect(
      s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
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

// ── autoLockOverdueCards ─────────────────────────────────────────────────────

describe("autoLockOverdueCards", () => {
  test("locks an overdue card, leaves a current one active", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, { name: "Holder" });
    const overdue = await seedCard(s, {
      cardholderPersonId: holder,
      receiptGraceEndsAt: Date.now() - 1000, // grace passed, receipt missing
    });
    const current = await seedCard(s, {
      cardholderPersonId: holder,
      receiptGraceEndsAt: Date.now() + 1_000_000, // still within grace
    });
    const noGrace = await seedCard(s, { cardholderPersonId: holder });

    const { lockedCount } = await s.t.mutation(
      internal.cards.autoLockOverdueCards,
      {},
    );
    expect(lockedCount).toBe(1);

    expect((await run(s.t, (ctx) => ctx.db.get(overdue)))?.status).toBe("locked");
    expect((await run(s.t, (ctx) => ctx.db.get(current)))?.status).toBe("active");
    expect((await run(s.t, (ctx) => ctx.db.get(noGrace)))?.status).toBe("active");
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
