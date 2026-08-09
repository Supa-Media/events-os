import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * DELAYED SETTLEMENT — the ACH lifecycle, driven through the real
 * `/stripe/webhook` route rather than through the internal mutations.
 *
 * The route is where the bug lived, so the route is what these test. Every
 * settle path is already covered elsewhere at the mutation level
 * (`givingDonations.test.ts`); what was missing, and what could not be
 * expressed by calling those mutations directly, is the QUESTION THE ROUTE
 * ASKS BEFORE CALLING THEM: has the money actually arrived?
 *
 * Stripe enabled ACH direct debit on this account on 2026-08-09. From that
 * moment `checkout.session.completed` stopped meaning "paid" — for a bank debit
 * it fires on submission, with `payment_status: "unpaid"`, and the funds land
 * about four business days later or not at all. The failure this guards against
 * is a `gifts` row (and a public activity-wall entry, and emailed tickets) for
 * money that does not exist.
 */

const SECRET = "whsec_testsecret";

/** A valid `Stripe-Signature` for a payload signed now. */
function signedHeader(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** POST a signed Stripe event at the real route, as Stripe would. */
async function postEvent(
  t: TestConvex,
  type: string,
  object: Record<string, unknown>,
  eventId = `evt_${Math.random().toString(36).slice(2)}`,
): Promise<Response> {
  const payload = JSON.stringify({ id: eventId, type, data: { object } });
  return t.fetch("/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": signedHeader(payload) },
    body: payload,
  });
}

/** A `/give` one-time session, as Stripe sends it, with a chosen payment_status. */
function giveSession(
  sessionId: string,
  donorId: Id<"donors">,
  paymentStatus: string | undefined,
  amountTotal = 10_000,
): Record<string, unknown> {
  return {
    id: sessionId,
    amount_total: amountTotal,
    ...(paymentStatus === undefined ? {} : { payment_status: paymentStatus }),
    metadata: {
      giveDonation: "1",
      giveDonorId: String(donorId),
      giveScope: "central",
    },
  };
}

async function centralGifts(t: TestConvex) {
  return run(t, (ctx) =>
    ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", "central"))
      .collect(),
  );
}

async function seedDonor(t: TestConvex): Promise<Id<"donors">> {
  const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
    scope: "central",
    amountCents: 10_000,
    name: "Bank Giver",
    email: "bank.giver@example.com",
  });
  return prepared.donorId;
}

let priorSecret: string | undefined;
beforeEach(() => {
  priorSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  if (priorSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = priorSecret;
});

describe("checkout.session.completed — the settled gate", () => {
  test("a CARD session (payment_status paid) still records the gift, exactly as before", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    const res = await postEvent(t, "checkout.session.completed", giveSession("cs_card", donorId, "paid"));
    expect(res.status).toBe(200);

    const gifts = await centralGifts(t);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].amountCents).toBe(10_000);
    expect(gifts[0].externalRef).toBe("give:cs_card");
  });

  test("a payload with NO payment_status settles — absent must not stop real card gifts", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_legacy", donorId, undefined));

    expect(await centralGifts(t)).toHaveLength(1);
  });

  test("an ACH session (payment_status unpaid) records NOTHING — no gift", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    const res = await postEvent(t, "checkout.session.completed", giveSession("cs_ach", donorId, "unpaid"));
    expect(res.status).toBe(200);

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
    expect(await centralGifts(t)).toHaveLength(0);
  });

  test("an unsettled ACH session does not light up the public activity wall", async () => {
    // The wall is per-territory, so this one has to be chapter-scoped — a
    // "central" gift has no chapter to post to and never records an entry.
    const t = newT();
    const s = await setupChapter(t);
    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: s.chapterId,
      amountCents: 10_000,
      name: "Bank Giver",
      email: "bank.giver@example.com",
    });
    // The giver opted into the wall, so a PENDING entry exists from checkout.
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_wall",
      scope: s.chapterId,
      kind: "gift",
      amountCents: 10_000,
      displayName: "A Neighbour",
    });

    await postEvent(t, "checkout.session.completed", {
      id: "cs_wall",
      amount_total: 10_000,
      payment_status: "unpaid",
      metadata: {
        giveDonation: "1",
        giveDonorId: String(prepared.donorId),
        giveScope: String(s.chapterId),
      },
    });

    const activity = await run(t, (ctx) => ctx.db.query("givingActivity").collect());
    expect(activity).toHaveLength(1);
    expect(activity[0].status).toBe("pending");

    // …and it DOES light up once the debit clears.
    await postEvent(t, "checkout.session.async_payment_succeeded", {
      id: "cs_wall",
      amount_total: 10_000,
      payment_status: "paid",
      metadata: {
        giveDonation: "1",
        giveDonorId: String(prepared.donorId),
        giveScope: String(s.chapterId),
      },
    });
    const after = await run(t, (ctx) => ctx.db.query("givingActivity").collect());
    expect(after[0].status).toBe("visible");
  });

  test("an unrecognised future payment_status is treated as NOT settled", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_weird", donorId, "some_new_pending_state"));

    expect(await centralGifts(t)).toHaveLength(0);
  });
});

describe("the async settlement events", () => {
  test("async_payment_succeeded records the gift, and only once across redelivery", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    // Day 0: submitted, unsettled, nothing recorded.
    await postEvent(t, "checkout.session.completed", giveSession("cs_ach", donorId, "unpaid"));
    expect(await centralGifts(t)).toHaveLength(0);

    // ~Day 4: the debit clears.
    await postEvent(t, "checkout.session.async_payment_succeeded", giveSession("cs_ach", donorId, "paid"));
    const gifts = await centralGifts(t);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].amountCents).toBe(10_000);

    // Stripe delivers at least once — a redelivery must not double-record.
    await postEvent(t, "checkout.session.async_payment_succeeded", giveSession("cs_ach", donorId, "paid"));
    // And a late-arriving duplicate of the original completion must not either.
    await postEvent(t, "checkout.session.completed", giveSession("cs_ach", donorId, "unpaid"));
    expect(await centralGifts(t)).toHaveLength(1);
  });

  test("async_payment_failed leaves no gift behind", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_bounce", donorId, "unpaid"));
    const res = await postEvent(t, "checkout.session.async_payment_failed", {
      id: "cs_bounce",
      metadata: { giveDonation: "1", giveDonorId: String(donorId), giveScope: "central" },
    });
    expect(res.status).toBe(200);

    expect(await centralGifts(t)).toHaveLength(0);
  });

  test("the settled amount comes from the ASYNC event, not from the pending one", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_amt", donorId, "unpaid", 10_000));
    // Stripe is the source of truth for what actually settled.
    await postEvent(t, "checkout.session.async_payment_succeeded", giveSession("cs_amt", donorId, "paid", 25_000));

    const gifts = await centralGifts(t);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].amountCents).toBe(25_000);
  });
});

describe("the signature gate still governs the new events", () => {
  test("an unsigned async_payment_succeeded is rejected and records nothing", async () => {
    const t = newT();
    const donorId = await seedDonor(t);
    const payload = JSON.stringify({
      id: "evt_forged",
      type: "checkout.session.async_payment_succeeded",
      data: { object: giveSession("cs_forged", donorId, "paid") },
    });

    const res = await t.fetch("/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=deadbeef" },
      body: payload,
    });
    expect(res.status).toBe(400);
    expect(await centralGifts(t)).toHaveLength(0);
  });
});
