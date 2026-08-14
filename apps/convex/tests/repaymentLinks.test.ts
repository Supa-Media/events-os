/// <reference types="vite/client" />
/**
 * THE NO-LOGIN PAY-BACK LINK.
 *
 * Founder, 2026-08-14: "these might be past team members even… it should
 * literally just be a rendered page where I could copy a link, where they can
 * see the charge they're being charged for and go to the Stripe checkout."
 *
 * A URL that settles somebody's debt with no session behind it earns a
 * different class of test than the rest of this feature. Two questions, and
 * both of them are the whole point:
 *
 *  1. WHAT DOES THE TOKEN AUTHORIZE? Exactly one thing — paying THIS person's
 *     outstanding charges. It must not reach another person's debt even when
 *     handed that debt's id directly, must not survive revocation, and must
 *     not let the client name an amount.
 *  2. WHAT DOES THE PAGE DISCLOSE? Amounts, dates, and the chapter's name.
 *     Never the payer's name, never the merchant. A link that ends up in a
 *     group chat should leak a few numbers, not an identity.
 *
 * Settlement itself is deliberately NOT re-tested here: the public checkout
 * carries the same `repaymentIds` metadata into the same webhook as every
 * other rail, and that path is covered in `repaymentFeeCoverage` and
 * `repaymentAchRail`. What IS tested is that it hands that path the right ids.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manny Manager",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedRepayment(
  s: ChapterSetup,
  payerPersonId: Id<"people">,
  amountCents: number,
  opts: { status?: "pending" | "processing" | "paid"; merchantName?: string } = {},
): Promise<Id<"personalRepayments">> {
  const now = Date.now();
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      currency: "usd",
      postedAt: now,
      personId: payerPersonId,
      merchantName: opts.merchantName ?? "Very Identifying Merchant",
      status: "reconciled",
      isPersonal: true,
      createdAt: now,
    }),
  );
  const repaymentId = await run(s.t, (ctx) =>
    ctx.db.insert("personalRepayments", {
      chapterId: s.chapterId,
      transactionId,
      payerPersonId,
      amountCents,
      method: "card",
      status: opts.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await run(s.t, (ctx) => ctx.db.patch(transactionId, { repaymentId }));
  return repaymentId;
}

/** Mint a link as the manager and hand back its token. */
async function mint(s: ChapterSetup, payerPersonId: Id<"people">): Promise<string> {
  const { token } = await s.as.mutation(api.repaymentLinks.mintLink, {
    payerPersonId,
  });
  return token;
}

describe("pay-back link — minting", () => {
  test("pressing Copy twice hands out the SAME link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    await seedRepayment(s, dana, 10_100);

    const first = await mint(s, dana);
    const second = await mint(s, dana);
    // Minting fresh on every press would silently kill the link they texted
    // five minutes ago, with neither side able to work out why.
    expect(second).toBe(first);
  });

  test("a viewer can't mint one — handing out a pay URL is collecting", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, "Bookkeeper");
    await run(s.t, (ctx) => ctx.db.patch(me, { userId: s.userId }));
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: me,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const dana = await seedPerson(s, "Dana");
    await expect(
      s.as.mutation(api.repaymentLinks.mintLink, { payerPersonId: dana }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("revoking kills the old link and the next mint issues a new one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    await seedRepayment(s, dana, 10_100);

    const original = await mint(s, dana);
    await s.as.mutation(api.repaymentLinks.revokeLink, { payerPersonId: dana });

    // The revoked token reads as inactive, not as a 404 — whoever holds it
    // needs to know to ask for a new one, not to assume they're square.
    expect(
      await t.query(api.repaymentLinks.publicByToken, { token: original }),
    ).toBeNull();

    const replacement = await mint(s, dana);
    expect(replacement).not.toBe(original);
    expect(
      await t.query(api.repaymentLinks.publicByToken, { token: replacement }),
    ).not.toBeNull();
  });
});

describe("pay-back link — what the page discloses", () => {
  test("amounts and dates, and NO name of any kind", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana Volunteer");
    await seedRepayment(s, dana, 4_200, { merchantName: "Dana's Corner Store" });
    const token = await mint(s, dana);

    // Read with NO identity at all — a stranger with the URL.
    const page = await t.query(api.repaymentLinks.publicByToken, { token });
    expect(page).not.toBeNull();
    expect(page!.charges).toHaveLength(1);
    expect(page!.charges[0].amountCents).toBe(4_200);
    expect(page!.totalCents).toBe(4_200);

    // The whole disclosure surface, serialized. Neither the payer's name nor
    // the merchant may appear anywhere in it.
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("Dana");
    expect(serialized).not.toContain("Corner Store");
  });

  test("a settled charge drops off entirely", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    await seedRepayment(s, dana, 4_200);
    await seedRepayment(s, dana, 900, { status: "paid" });
    const token = await mint(s, dana);

    const page = await t.query(api.repaymentLinks.publicByToken, { token });
    // On the authed page a settled charge stays as a receipt. Here it is a
    // stranger's-eye view of a debt already cleared — disclosure with no
    // purpose.
    expect(page!.charges).toHaveLength(1);
    expect(page!.totalCents).toBe(4_200);
  });

  test("a clearing bank transfer is shown but not counted as still payable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    await seedRepayment(s, dana, 4_200, { status: "processing" });
    const token = await mint(s, dana);

    const page = await t.query(api.repaymentLinks.publicByToken, { token });
    expect(page!.charges).toHaveLength(1);
    expect(page!.charges[0].clearing).toBe(true);
    // Not in the "please pay this" total — they already did.
    expect(page!.totalCents).toBe(0);
  });

  test("once everything is settled the page says so instead of asking again", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    await seedRepayment(s, dana, 4_200, { status: "paid" });
    const token = await mint(s, dana);

    const page = await t.query(api.repaymentLinks.publicByToken, { token });
    expect(page!.settled).toBe(true);
    expect(page!.charges).toHaveLength(0);
  });

  test("a made-up token is indistinguishable from a revoked one", async () => {
    const t = newT();
    await setupChapter(t);
    expect(
      await t.query(api.repaymentLinks.publicByToken, { token: "not-a-real-token" }),
    ).toBeNull();
    expect(
      await t.query(api.repaymentLinks.publicByToken, { token: "" }),
    ).toBeNull();
  });
});

describe("pay-back link — what the token authorizes", () => {
  test("it CANNOT pay somebody else's charge, even given the id", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    const sam = await seedPerson(s, "Sam");
    const danaCharge = await seedRepayment(s, dana, 4_200);
    const samCharge = await seedRepayment(s, sam, 9_900);
    const danaToken = await mint(s, dana);

    // The attack this guards: hold one legitimate link, submit a different
    // person's repayment id. It is dropped, not billed and not acknowledged.
    const quote = await t.query(api.repaymentLinks.publicQuote, {
      token: danaToken,
      repaymentIds: [danaCharge, samCharge],
    });
    expect(quote!.count).toBe(1);
    expect(quote!.totalCents).toBe(4_200);

    const prepared = await t.mutation(
      internal.repaymentLinks.preparePublicCheckout,
      { token: danaToken, repaymentIds: [danaCharge, samCharge], method: "card" },
    );
    expect(prepared.repaymentIds).toEqual([danaCharge]);
    expect(prepared.totalCents).toBe(4_200);
  });

  test("a duplicated id doesn't double the charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    const charge = await seedRepayment(s, dana, 4_200);
    const token = await mint(s, dana);

    const quote = await t.query(api.repaymentLinks.publicQuote, {
      token,
      repaymentIds: [charge, charge, charge],
    });
    expect(quote!.count).toBe(1);
    expect(quote!.totalCents).toBe(4_200);
  });

  test("a revoked token cannot start a checkout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    const charge = await seedRepayment(s, dana, 4_200);
    const token = await mint(s, dana);
    await s.as.mutation(api.repaymentLinks.revokeLink, { payerPersonId: dana });

    let caught: unknown;
    try {
      await t.mutation(internal.repaymentLinks.preparePublicCheckout, {
        token,
        repaymentIds: [charge],
        method: "card",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "LINK_INACTIVE",
    );
  });

  test("a charge already clearing can't be put through a second time", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    const clearing = await seedRepayment(s, dana, 4_200, { status: "processing" });
    const token = await mint(s, dana);

    let caught: unknown;
    try {
      await t.mutation(internal.repaymentLinks.preparePublicCheckout, {
        token,
        repaymentIds: [clearing],
        method: "card",
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "NOTHING_OWED",
    );
  });

  test("it quotes and bills the same fee arithmetic as the signed-in page", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    const charge = await seedRepayment(s, dana, 10_000);
    const token = await mint(s, dana);

    const quote = await t.query(api.repaymentLinks.publicQuote, {
      token,
      repaymentIds: [charge],
    });
    const prepared = await t.mutation(
      internal.repaymentLinks.preparePublicCheckout,
      { token, repaymentIds: [charge], method: "card" },
    );

    // The $100 → $103.30 case the whole fee-coverage feature is anchored on:
    // being logged out must not change what a repayment costs.
    expect(quote!.card.chargeCents).toBe(10_330);
    expect(prepared.chargeCents).toBe(10_330);
    expect(prepared.feeCents).toBe(330);
    // …and the bank rail is offered here too, at its own much lower rate.
    expect(quote!.ach.feeCents).toBeLessThan(quote!.card.feeCents);
  });

  test("choosing the bank rail pins us_bank_account, and stamps the row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    const charge = await seedRepayment(s, dana, 10_000);
    const token = await mint(s, dana);

    const prepared = await t.mutation(
      internal.repaymentLinks.preparePublicCheckout,
      { token, repaymentIds: [charge], method: "ach" },
    );
    expect(prepared.paymentMethodTypes).toEqual(["us_bank_account"]);
    const stored = await run(s.t, (ctx) => ctx.db.get(charge));
    expect(stored?.method).toBe("ach");
  });

  test("the ids it hands the checkout are what the webhook will settle", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const dana = await seedPerson(s, "Dana");
    const a = await seedRepayment(s, dana, 4_200);
    const b = await seedRepayment(s, dana, 900);
    const token = await mint(s, dana);

    const prepared = await t.mutation(
      internal.repaymentLinks.preparePublicCheckout,
      { token, repaymentIds: [a, b], method: "card" },
    );
    // Settlement is the SAME path as every other rail — this is the seam where
    // the public flow hands over to it, so it's the seam worth pinning.
    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: prepared.repaymentIds,
      sessionId: "cs_public",
      amountTotalCents: prepared.chargeCents,
      feeCoverageCents: prepared.feeCents,
    });

    const rows = await run(s.t, (ctx) =>
      Promise.all([ctx.db.get(a), ctx.db.get(b)]),
    );
    expect(rows[0]?.status).toBe("paid");
    expect(rows[1]?.status).toBe("paid");
    // And the page it came from now says thank you rather than asking again.
    const page = await t.query(api.repaymentLinks.publicByToken, { token });
    expect(page!.settled).toBe(true);
  });
});
