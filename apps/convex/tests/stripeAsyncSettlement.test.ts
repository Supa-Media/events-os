import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

  test("a submitted ACH gift is recorded as pending at the full charge", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", {
      // The donor typed $100 and covered $3.30 of fees, so Stripe charges
      // $103.30 — and the GIFT is $103.30, coverage included
      // (`gifts.feeCoverageCents`). The pending figure has to be that same
      // number, or the money would appear to change size the day it settles.
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
    expect(rows[0].amountCents).toBe(10_330);
    expect(rows[0].chargeTotalCents).toBe(10_330);
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

    // The row is KEPT as a tombstone — no gift exists on this path, so the row
    // is the only key that can recognise a resent `completed`. What matters for
    // the money is that it is no longer `in_flight`, which is what takes it out
    // of every future digest. A digest already sent that announced it is
    // deliberately not corrected — see `resolvePendingGift`.
    const after = await pendingRows(t);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("failed");
    expect(await centralGifts(t)).toHaveLength(0);
  });

  test("an abandoned checkout drops it too — expiry is not a special case", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_gone", donorId, "unpaid"));
    await postEvent(t, "checkout.session.expired", { id: "cs_gone" });

    // Same tombstone, same reason: no money is coming, and the row is what
    // stops a late redelivery claiming otherwise.
    const after = await pendingRows(t);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("failed");
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

    // A NON-ZERO total on purpose. A subscription session's `amount_total` is
    // its first invoice's total and is routinely non-zero, so "there's no
    // amount to record" is NOT why this is safe — seeding $0 here would have
    // made this test pass for a reason that isn't the mechanism. It is safe
    // because the session carries no `giveDonation` marker and matches no
    // `donations` or `ticketOrders` row, so it falls through to `return false`.
    // A backer's money becomes a gift through `invoice.paid`, keyed on
    // `gifts.stripeInvoiceId`; a row keyed on this session could never be
    // resolved by anything.
    await postEvent(t, "checkout.session.completed", {
      id: "cs_backer",
      amount_total: 5_000,
      payment_status: "unpaid",
      metadata: { pledgeId: String(pledgeId) },
    });

    expect(await pendingRows(t)).toHaveLength(0);
  });

  // ── The two ways a resolved debit came back from the dead ────────────────
  //
  // `by_session` is idempotency against a LIVE row, and a resolved row is
  // DELETED — so on its own it cannot recognise a debit that has already
  // cleared. Both of these shipped in the first cut of this feature and both
  // produced the same permanent phantom: one $100 gift reported by the digest
  // as `$200.00 from 2 gifts ($100.00 still clearing)`, listed once under
  // "Every gift" and again under "Still clearing", with both terminal events
  // already consumed so nothing would ever clean it up.

  test("the settlement arrives FIRST: a late completion doesn't resurrect the debit", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    // Stripe promises neither once-only nor ordered delivery. After an outage
    // both events queue and redeliver in whatever order — and the completion's
    // snapshot is FROZEN at creation, so it still reads `unpaid` however long
    // afterwards it lands.
    await postEvent(
      t,
      "checkout.session.async_payment_succeeded",
      giveSession("cs_ooo", donorId, "paid"),
    );
    expect(await centralGifts(t)).toHaveLength(1);

    await postEvent(t, "checkout.session.completed", giveSession("cs_ooo", donorId, "unpaid"));

    // The gift's own idempotency key is what survives the delete.
    expect(await pendingRows(t)).toHaveLength(0);
    expect(await centralGifts(t)).toHaveLength(1);
  });

  test("the submission is REDELIVERED after it cleared, and stays cleared", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_resend", donorId, "unpaid"), "evt_a");
    await postEvent(
      t,
      "checkout.session.async_payment_succeeded",
      giveSession("cs_resend", donorId, "paid"),
    );
    expect(await pendingRows(t)).toHaveLength(0);

    // ACH takes 2–4 business days, Stripe retries a failing event for three,
    // and "Resend" in the Dashboard is an ordinary debugging move.
    await postEvent(t, "checkout.session.completed", giveSession("cs_resend", donorId, "unpaid"), "evt_b");

    expect(await pendingRows(t)).toHaveLength(0);
    expect(await centralGifts(t)).toHaveLength(1);
  });

  // ── The FAILURE half of the same defect ─────────────────────────────────
  //
  // The settled gift's `externalRef` only exists if the debit CLEARED. On the
  // failure path there is no gift and never will be, so deleting the row left
  // NO key at all — and the same two triggers walked straight back in. Hence
  // the tombstone.

  test("a resent completion after the bank REFUSED it doesn't resurrect the debit", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_refused", donorId, "unpaid"), "evt_a");
    await postEvent(t, "checkout.session.async_payment_failed", { id: "cs_refused" });

    // "Resend" in the Dashboard, days later.
    await postEvent(t, "checkout.session.completed", giveSession("cs_refused", donorId, "unpaid"), "evt_b");

    const rows = await pendingRows(t);
    expect(rows).toHaveLength(1);
    // Still the tombstone — NOT a fresh in-flight row for money the bank
    // already refused.
    expect(rows[0].status).toBe("failed");
    expect(await centralGifts(t)).toHaveLength(0);
  });

  test("the FAILURE arrives first: a late completion doesn't resurrect the debit", async () => {
    const t = newT();
    const donorId = await seedDonor(t);

    // No pending row was ever written — the failure beat the completion.
    await postEvent(t, "checkout.session.async_payment_failed", { id: "cs_ooo_fail" });
    await postEvent(t, "checkout.session.completed", giveSession("cs_ooo_fail", donorId, "unpaid"));

    // Nothing to tombstone, so this one is genuinely open: the completion
    // creates a row, and the 21-day sweep is what bounds it. Asserted so the
    // residual gap is a recorded decision rather than a surprise — the blast
    // radius is one caveated "still clearing" line that never becomes a gift.
    const rows = await pendingRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("in_flight");
    expect(await centralGifts(t)).toHaveLength(0);
  });

  test("a donor who retries after a refusal is counted ONCE, not twice", async () => {
    // The compound case: debit refused → donor gives again on a NEW session →
    // a resend of the OLD completion. Without the tombstone the stale session
    // lands a phantom beside the live row and one $100 intent reads as $200
    // still clearing in a single digest.
    const t = newT();
    const donorId = await seedDonor(t);

    await postEvent(t, "checkout.session.completed", giveSession("cs_try1", donorId, "unpaid"), "evt_1");
    await postEvent(t, "checkout.session.async_payment_failed", { id: "cs_try1" });
    await postEvent(t, "checkout.session.completed", giveSession("cs_try2", donorId, "unpaid"), "evt_2");
    // …and the old one is resent.
    await postEvent(t, "checkout.session.completed", giveSession("cs_try1", donorId, "unpaid"), "evt_3");

    const live = (await pendingRows(t)).filter((r) => r.status === "in_flight");
    expect(live).toHaveLength(1);
    expect(live[0].sessionId).toBe("cs_try2");
  });

  test("a swept tombstone doesn't cry wolf about webhook delivery", async () => {
    // The sweep's `console.error` exists to say "webhooks are being lost".
    // A tombstone aging out is the system working, and counting it as stranded
    // would train people to ignore the one log that matters.
    const t = newT();
    const donorId = await seedDonor(t);
    const now = Date.now();
    await t.mutation(internal.givingPending.recordPendingGift, {
      sessionId: "cs_old_tombstone",
      amountTotalCents: 10_000,
      isGiveDonation: true,
      giveDonorId: String(donorId),
      submittedAt: now - 30 * 24 * 60 * 60 * 1000,
    });
    await t.mutation(internal.givingPending.resolvePendingGift, {
      sessionId: "cs_old_tombstone",
      outcome: "failed",
    });

    // ASSERTED ON THE LOG ITSELF, not on the return value — the return counts
    // every row swept, tombstones included, so checking it would prove nothing
    // about the alarm. The alarm is the whole point of the split.
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
    try {
      expect(
        await t.mutation(internal.givingPending.sweepStrandedPendingGifts, {
          now,
        }),
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await pendingRows(t)).toHaveLength(0);
    // Nothing claiming a webhook went missing, and the session is not named.
    expect(errors.join("\n")).not.toContain("Check webhook delivery");
    expect(errors.join("\n")).not.toContain("cs_old_tombstone");
  });

  test("a debit that never resolved is swept, and one still in flight is not", async () => {
    // Stripe stops retrying after about three days and a longer outage loses
    // the event outright, leaving a row nothing will ever clear. A donor's name
    // must not sit in a table forever with no screen that shows it.
    const t = newT();
    const donorId = await seedDonor(t);
    const now = Date.now();

    await t.mutation(internal.givingPending.recordPendingGift, {
      sessionId: "cs_stranded",
      amountTotalCents: 10_000,
      isGiveDonation: true,
      giveDonorId: String(donorId),
      submittedAt: now - 30 * 24 * 60 * 60 * 1000,
    });
    await t.mutation(internal.givingPending.recordPendingGift, {
      sessionId: "cs_moving",
      amountTotalCents: 10_000,
      isGiveDonation: true,
      giveDonorId: String(donorId),
      submittedAt: now - 2 * 24 * 60 * 60 * 1000,
    });
    expect(await pendingRows(t)).toHaveLength(2);

    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
    let swept!: number;
    try {
      swept = await t.mutation(
        internal.givingPending.sweepStrandedPendingGifts,
        { now },
      );
    } finally {
      spy.mockRestore();
    }

    expect(swept).toBe(1);
    // A stranded row DOES raise the alarm, and names the session so somebody
    // can paste it into the Stripe Dashboard.
    expect(errors.join("\n")).toContain("Check webhook delivery");
    expect(errors.join("\n")).toContain("cs_stranded");
    const left = await pendingRows(t);
    expect(left).toHaveLength(1);
    // The one that is genuinely still moving survives.
    expect(left[0].sessionId).toBe("cs_moving");
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
