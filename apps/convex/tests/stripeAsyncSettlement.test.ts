import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { internal } from "../_generated/api";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
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

/** The minimum event an in-flight `donations` / `ticketOrders` row can hang off. */
async function seedEventPage(
  s: ChapterSetup,
): Promise<{ eventId: Id<"events"> }> {
  const now = Date.now();
  return run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Gala",
      slug: "gala",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Summer Gala",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return { eventId };
  });
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
      consent: true,
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

/**
 * THE ONE ROW AN IN-FLIGHT DEBIT LEAVES BEHIND.
 *
 * Everything above asserts that an unsettled ACH session records NO MONEY, and
 * that stays true — `pendingGifts` is not the ledger, not revenue, and not
 * visible to book value (`tests/givingNotifications.test.ts` holds that one
 * down against `accountBalances` directly). What it is, is the only queryable
 * evidence that a bank transfer is on its way, so the weekly giving digest can
 * say how much of its total hasn't landed.
 *
 * The lifecycle these assert is small and total: written on submission, GONE
 * on settlement, GONE on failure, GONE on abandonment. A row that outlived any
 * of those three would be a phantom — money reported as coming that isn't.
 */
describe("an in-flight bank debit leaves exactly one trace", () => {
  async function pendingRows(t: TestConvex) {
    return run(t, (ctx) => ctx.db.query("pendingGifts").collect());
  }

  test("a submitted ACH gift is recorded as pending — with the amount, not the charge", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", {
      // The donor gave $100 and covered $3.30 of fees, so Stripe charges
      // $103.30. The PENDING figure has to be the gift, or it would shrink by
      // the coverage the day it settles and look like money went missing.
      id: "cs_ach_pending",
      amount_total: 10_330,
      payment_status: "unpaid",
      metadata: {
        giveDonation: "1",
        giveDonorId: String(donorId),
        giveScope: "central",
        giveIntendedCents: "10000",
      },
    });

    const rows = await pendingRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(10_000);
    expect(rows[0].scope).toBe("central");
    expect(rows[0].donorName).toBe("Bank Giver");
    expect(rows[0].sessionId).toBe("cs_ach_pending");
    // Still no money anywhere.
    expect(await centralGifts(t)).toHaveLength(0);
  });

  test("a CARD session records nothing pending — it was never in flight", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_card", donorId, "paid"));

    expect(await pendingRows(t)).toHaveLength(0);
    expect(await centralGifts(t)).toHaveLength(1);
  });

  test("REDELIVERY of the submission doesn't double the pending figure", async () => {
    const t = newT();
    const donorId = await seedDonor(t);
    const session = giveSession("cs_dupe", donorId, "unpaid");

    // Stripe delivers at least once, and the dedup ledger gates only the
    // EMAIL — the money paths, this one included, are reached twice on purpose.
    await postEvent(t, "checkout.session.completed", session, "evt_1");
    await postEvent(t, "checkout.session.completed", session, "evt_2");

    expect(await pendingRows(t)).toHaveLength(1);
  });

  test("the debit clears: the pending row is gone and the gift is real", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_ok", donorId, "unpaid"));
    expect(await pendingRows(t)).toHaveLength(1);

    await postEvent(
      t,
      "checkout.session.async_payment_succeeded",
      giveSession("cs_ok", donorId, "paid"),
    );

    // NOT BOTH. The single most important assertion here: for the four days it
    // was in flight the digest counted this money once, as pending; from now on
    // it counts once, as a gift. A surviving pending row would have it in both
    // halves of the same total.
    expect(await pendingRows(t)).toHaveLength(0);
    expect(await centralGifts(t)).toHaveLength(1);
  });

  test("the bank refuses it: the pending row is gone and no gift was ever made", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_bad", donorId, "unpaid"));
    expect(await pendingRows(t)).toHaveLength(1);

    await postEvent(t, "checkout.session.async_payment_failed", { id: "cs_bad" });

    // The amount is out of every future digest. A digest already sent that
    // announced it is deliberately not corrected — see `resolvePendingGift`.
    expect(await pendingRows(t)).toHaveLength(0);
    expect(await centralGifts(t)).toHaveLength(0);
  });

  test("an abandoned checkout drops it too — expiry is not a special case", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_gone", donorId, "unpaid"));
    await postEvent(t, "checkout.session.expired", { id: "cs_gone" });

    expect(await pendingRows(t)).toHaveLength(0);
  });

  test("an event-page donation in flight is recorded against its event and chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEventPage(s);
    const donationId = await run(t, (ctx) =>
      ctx.db.insert("donations", {
        chapterId: s.chapterId,
        eventId,
        name: "Gala Guest",
        email: "guest@example.com",
        amountCents: 7_500,
        currency: "usd",
        method: "card",
        status: "pending",
        stripeCheckoutSessionId: "cs_event",
        createdAt: Date.now(),
      }),
    );

    await postEvent(t, "checkout.session.completed", {
      id: "cs_event",
      amount_total: 7_500,
      payment_status: "unpaid",
    });

    const rows = await pendingRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(7_500);
    expect(rows[0].scope).toBe(s.chapterId);
    // The classification links, so the digest's "By giving type" cut puts this
    // in Events — the same bucket the gift lands in when it settles.
    expect(rows[0].eventId).toBe(eventId);
    expect(rows[0].donationId).toBe(donationId);
  });

  test("a ticket order in flight contributes its ADD-ON GIFT and not its tickets", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEventPage(s);
    await run(t, (ctx) =>
      ctx.db.insert("ticketOrders", {
        eventId,
        chapterId: s.chapterId,
        name: "Ticket Buyer",
        email: "buyer@example.com",
        items: [],
        // $200 of tickets is REVENUE, never a gift, and has no business in a
        // giving digest at any stage of its life.
        totalCents: 20_000,
        donationCents: 2_500,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_order",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await postEvent(t, "checkout.session.completed", {
      id: "cs_order",
      amount_total: 22_500,
      payment_status: "unpaid",
    });

    const rows = await pendingRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(2_500);
  });

  test("a tickets-only order in flight contributes nothing — no gift is coming", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEventPage(s);
    await run(t, (ctx) =>
      ctx.db.insert("ticketOrders", {
        eventId,
        chapterId: s.chapterId,
        name: "Ticket Buyer",
        email: "buyer@example.com",
        items: [],
        totalCents: 20_000,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_tickets",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await postEvent(t, "checkout.session.completed", {
      id: "cs_tickets",
      amount_total: 20_000,
      payment_status: "unpaid",
    });

    expect(await pendingRows(t)).toHaveLength(0);
  });

  test("a BACKER signup in flight contributes nothing — its session prices no gift", async () => {
    const t = newT();
    const donorId = await seedDonor(t);
    const pledgeId = await run(t, (ctx) =>
      ctx.db.insert("pledges", {
        donorId,
        scope: "central",
        amountCents: 5_000,
        status: "incomplete",
        origin: "stripe",
        createdAt: Date.now(),
      }),
    );

    // A subscription session's `amount_total` is $0 or a proration; the money
    // that becomes a gift arrives later as its own `invoice.paid`. Guessing
    // here would put a figure in a digest that no gift ever matches.
    await postEvent(t, "checkout.session.completed", {
      id: "cs_backer",
      amount_total: 0,
      payment_status: "unpaid",
      metadata: { pledgeId: String(pledgeId) },
    });

    expect(await pendingRows(t)).toHaveLength(0);
  });
});

/**
 * THE SEAM. `givingComms.ts` (#588) wrote the three ACH emails and deliberately
 * did not touch this route; this route (#581) wrote the three branches and did
 * not call them. Between those two correct decisions sat a donor who submitted
 * a bank transfer and heard nothing, ever, at any point in its lifecycle.
 *
 * These assert on `_scheduled_functions` rather than on a captured Resend body
 * because the wiring — WHICH email, for WHICH session, HOW MANY TIMES — is the
 * thing that was missing. The words themselves are already covered by
 * `givingComms.test.ts`, and scheduling them means the webhook never blocks on
 * a Stripe round-trip to compose one.
 */
describe("the donor hears about their bank transfer", () => {
  /** Pending scheduled jobs whose function name contains `fragment`. */
  async function scheduled(t: TestConvex, fragment: string) {
    const rows = await run(t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    return rows
      .filter((r) => r.name.includes(fragment))
      .map((r) => r.args[0] as { sessionId?: string });
  }

  test("a submitted debit schedules exactly one 'on its way' email", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_ach", donorId, "unpaid"));

    const jobs = await scheduled(t, "onAchSubmitted");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sessionId).toBe("cs_ach");
  });

  test("a CARD gift gets no ACH email — there is no delay to explain", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_card", donorId, "paid"));

    expect(await scheduled(t, "onAch")).toHaveLength(0);
  });

  test("each lifecycle stage sends once, and REDELIVERY sends nothing more", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    // Stripe retries anything that doesn't answer 200, and replays on demand.
    // Same event id twice is the shape of every one of those retries.
    await postEvent(t, "checkout.session.completed", giveSession("cs_ach", donorId, "unpaid"), "evt_submitted");
    await postEvent(t, "checkout.session.completed", giveSession("cs_ach", donorId, "unpaid"), "evt_submitted");
    expect(await scheduled(t, "onAchSubmitted")).toHaveLength(1);

    await postEvent(t, "checkout.session.async_payment_succeeded", giveSession("cs_ach", donorId, "paid"), "evt_settled");
    await postEvent(t, "checkout.session.async_payment_succeeded", giveSession("cs_ach", donorId, "paid"), "evt_settled");
    expect(await scheduled(t, "onAchSettled")).toHaveLength(1);

    // …and the money path stayed idempotent underneath it all.
    expect(await centralGifts(t)).toHaveLength(1);
  });

  test("a failed debit schedules the failure email, once", async () => {
    const t = newT();
    const donorId = await seedDonor(t);
    const failed = {
      id: "cs_bounce",
      metadata: { giveDonation: "1", giveDonorId: String(donorId), giveScope: "central" },
    };

    await postEvent(t, "checkout.session.async_payment_failed", failed, "evt_failed");
    await postEvent(t, "checkout.session.async_payment_failed", failed, "evt_failed");

    const jobs = await scheduled(t, "onAchFailed");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sessionId).toBe("cs_bounce");
    // Nothing was ever booked, so nothing was reversed either.
    expect(await centralGifts(t)).toHaveLength(0);
  });

  test("an ABANDONED checkout emails nobody — they didn't authorise anything", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.expired", giveSession("cs_gone", donorId, "unpaid"));

    expect(await scheduled(t, "onAch")).toHaveLength(0);
  });

  test("the money path still runs when a redelivery skips the email", async () => {
    // The ordering guarantee in `isFirstDelivery`: settle first, record second.
    // A redelivery must re-run the (idempotent) settle and skip only the send.
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.async_payment_succeeded", giveSession("cs_ach", donorId, "paid"), "evt_x");
    await postEvent(t, "checkout.session.async_payment_succeeded", giveSession("cs_ach", donorId, "paid"), "evt_x");

    expect(await centralGifts(t)).toHaveLength(1);
    expect(await scheduled(t, "onAchSettled")).toHaveLength(1);
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
