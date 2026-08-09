import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type TestConvex } from "./setup.helpers";
import { disputeMovesMoney } from "../givingReversals";
import type { Id } from "../_generated/dataModel";

/**
 * THE LATE RETURN — money that already posted to the books, pulled back out
 * weeks later.
 *
 * #581 stopped a gift being booked before its ACH debit settled. This is the
 * other window, and it is the longer one: a bank can return a SETTLED debit for
 * up to 60 calendar days, and Stripe raises it as `charge.dispute.created`.
 * Before this, the gift stayed on the books forever — donor lifetime total,
 * scope rollup, launch pot and public giving wall all still counting money that
 * had gone back to the payer.
 *
 * The assertions that matter here are the ones about ROLLUPS, not about the
 * gift row. Deleting a gift is easy; the bug worth guarding is a reversal that
 * takes the row out and leaves `lifetimeCents` claiming it.
 */

const SECRET = "whsec_testsecret";
const SESSION = "cs_late_return";

function signedHeader(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

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

/** Stripe's `GET /checkout/sessions?payment_intent=…` → our session. */
function installStripeFetch(sessionId: string | null): void {
  globalThis.fetch = (async (url: string): Promise<unknown> => {
    if (String(url).includes("/checkout/sessions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: sessionId ? [{ id: sessionId }] : [] }),
        text: async () => "{}",
      };
    }
    if (String(url).includes("/charges/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ payment_intent: "pi_from_charge" }),
        text: async () => "{}",
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/** A settled `/give` gift in a chapter book, exactly as the webhook books one. */
async function arrangeSettledGift(amountCents = 50_000) {
  const t = newT();
  const s = await setupChapter(t);
  const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
    scope: s.chapterId,
    amountCents,
    name: "Bank Giver",
    email: "bank.giver@example.com",
  });
  await postEvent(t, "checkout.session.async_payment_succeeded", {
    id: SESSION,
    amount_total: amountCents,
    payment_status: "paid",
    metadata: {
      giveDonation: "1",
      giveDonorId: String(prepared.donorId),
      giveScope: String(s.chapterId),
    },
  });
  return { t, s, donorId: prepared.donorId, amountCents };
}

async function donorRow(t: TestConvex, donorId: Id<"donors">) {
  const row = await run(t, (ctx) => ctx.db.get(donorId));
  if (!row) throw new Error("donor vanished");
  return row;
}

async function gifts(t: TestConvex) {
  return run(t, (ctx) => ctx.db.query("gifts").collect());
}

async function reversals(t: TestConvex) {
  return run(t, (ctx) => ctx.db.query("giftReversals").collect());
}

/** A `charge.dispute.created` payload as Stripe sends it. */
function disputeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "dp_late_return",
    charge: "ch_x",
    payment_intent: "pi_x",
    amount: 50_000,
    reason: "insufficient_funds",
    status: "lost",
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
const realStripeKey = process.env.STRIPE_SECRET_KEY;
let priorSecret: string | undefined;

beforeEach(() => {
  priorSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (priorSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = priorSecret;
  if (realStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = realStripeKey;
});

describe("disputeMovesMoney — the inquiry trap", () => {
  /**
   * Stripe raises an authorization INQUIRY as `charge.dispute.created`, the
   * same event name a real return uses, distinguished only by a `warning_`
   * status. Acting on one would delete a perfectly good gift because
   * somebody's bank asked a question.
   */
  test("a warning_* status is an inquiry — no money moved", () => {
    for (const s of ["warning_needs_response", "warning_under_review", "warning_closed"]) {
      expect(disputeMovesMoney(s)).toBe(false);
    }
  });

  test("every real dispute status moves money", () => {
    for (const s of ["needs_response", "under_review", "won", "lost"]) {
      expect(disputeMovesMoney(s)).toBe(true);
    }
  });

  test("an absent status counts as real", () => {
    // Failing to reverse a real return is the worse error: the books overstate
    // income and the donor keeps a thank-you for money they got back. A won
    // dispute can undo it; an unnoticed return cannot.
    expect(disputeMovesMoney(undefined)).toBe(true);
    expect(disputeMovesMoney(null)).toBe(true);
  });
});

describe("the webhook route", () => {
  async function scheduled(t: TestConvex, fragment: string) {
    const rows = await run(t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    return rows
      .filter((r) => r.name.includes(fragment))
      .map((r) => r.args[0] as Record<string, unknown>);
  }

  test("charge.dispute.created hands the dispute to the reversal action", async () => {
    const { t } = await arrangeSettledGift();

    await postEvent(t, "charge.dispute.created", disputeEvent());

    const jobs = await scheduled(t, "onDisputeCreated");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      disputeId: "dp_late_return",
      chargeId: "ch_x",
      paymentIntentId: "pi_x",
      reason: "insufficient_funds",
      status: "lost",
      amountCents: 50_000,
    });
  });

  test("charge.dispute.closed hands the outcome to the restore action", async () => {
    const { t } = await arrangeSettledGift();

    await postEvent(t, "charge.dispute.closed", disputeEvent({ status: "won" }));

    const jobs = await scheduled(t, "onDisputeClosed");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ disputeId: "dp_late_return", status: "won" });
  });
});

describe("reversing a returned gift", () => {
  test("the gift comes off the books AND the donor's totals come with it", async () => {
    const { t, donorId, amountCents } = await arrangeSettledGift();
    // Precondition: the gift is really there and really counted.
    expect(await gifts(t)).toHaveLength(1);
    const before = await donorRow(t, donorId);
    expect(before.lifetimeCents).toBe(amountCents);
    expect(before.giftCount).toBe(1);

    installStripeFetch(SESSION);
    await t.action(internal.givingReversals.onDisputeCreated, {
      disputeId: "dp_1",
      chargeId: "ch_x",
      paymentIntentId: "pi_x",
      reason: "insufficient_funds",
      status: "lost",
      amountCents,
    });

    expect(await gifts(t)).toHaveLength(0);
    // THE ASSERTION THIS FILE EXISTS FOR. Deleting the row is easy; leaving
    // `lifetimeCents` claiming it is the bug.
    const after = await donorRow(t, donorId);
    expect(after.lifetimeCents).toBe(0);
    expect(after.giftCount).toBe(0);
  });

  test("it leaves a tombstone carrying the snapshot and Stripe's own reason", async () => {
    const { t, donorId, amountCents } = await arrangeSettledGift();
    installStripeFetch(SESSION);

    await t.action(internal.givingReversals.onDisputeCreated, {
      disputeId: "dp_1",
      chargeId: "ch_x",
      paymentIntentId: "pi_x",
      reason: "incorrect_account_details",
      status: "lost",
      amountCents,
    });

    const rows = await reversals(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      donorId,
      amountCents,
      status: "reversed",
      stripeDisputeId: "dp_1",
      stripeChargeId: "ch_x",
      disputeReason: "incorrect_account_details",
      disputedAmountCents: amountCents,
      externalRef: `give:${SESSION}`,
    });
    // Enough to put it back: the original date and method, not today's.
    expect(rows[0].method).toBe("stripe");
    expect(rows[0].receivedAt).toBeGreaterThan(0);
  });

  test("an INQUIRY reverses nothing — a bank asking a question is not a return", async () => {
    const { t, donorId } = await arrangeSettledGift();
    installStripeFetch(SESSION);

    await t.action(internal.givingReversals.onDisputeCreated, {
      disputeId: "dp_inquiry",
      chargeId: "ch_x",
      paymentIntentId: "pi_x",
      status: "warning_needs_response",
    });

    expect(await gifts(t)).toHaveLength(1);
    expect(await reversals(t)).toHaveLength(0);
    expect((await donorRow(t, donorId)).lifetimeCents).toBe(50_000);
  });

  test("REDELIVERY reverses once — idempotent on the dispute, not the event", async () => {
    const { t, donorId, amountCents } = await arrangeSettledGift();
    installStripeFetch(SESSION);
    const args = {
      disputeId: "dp_1",
      chargeId: "ch_x",
      paymentIntentId: "pi_x",
      reason: "insufficient_funds",
      status: "lost",
      amountCents,
    };

    await t.action(internal.givingReversals.onDisputeCreated, args);
    await t.action(internal.givingReversals.onDisputeCreated, args);
    // A DIFFERENT event about the same dispute — the case event-id dedup would
    // have missed entirely.
    await t.action(internal.givingReversals.onDisputeCreated, {
      ...args,
      status: "under_review",
    });

    expect(await reversals(t)).toHaveLength(1);
    // The donor's total was decremented exactly once, not three times into the
    // clamp at zero.
    expect((await donorRow(t, donorId)).lifetimeCents).toBe(0);
  });

  test("a dispute against something that isn't a /give gift no-ops", async () => {
    const { t } = await arrangeSettledGift();
    // The disputed payment resolves to a different session — a ticket order,
    // say. Nothing of ours to reverse, and nothing invented.
    installStripeFetch("cs_some_ticket_order");

    await t.action(internal.givingReversals.onDisputeCreated, {
      disputeId: "dp_other",
      chargeId: "ch_y",
      paymentIntentId: "pi_y",
      status: "lost",
    });

    expect(await gifts(t)).toHaveLength(1);
    expect(await reversals(t)).toHaveLength(0);
  });

  test("a charge with no checkout session behind it no-ops", async () => {
    const { t } = await arrangeSettledGift();
    installStripeFetch(null); // Tap-to-Pay sale, invoice, manual charge…

    await t.action(internal.givingReversals.onDisputeCreated, {
      disputeId: "dp_none",
      chargeId: "ch_z",
      paymentIntentId: "pi_z",
      status: "lost",
    });

    expect(await gifts(t)).toHaveLength(1);
    expect(await reversals(t)).toHaveLength(0);
  });
});

describe("the donor, and the wall", () => {
  test("a returned gift comes off the public wall and the donor is told once", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: s.chapterId,
      amountCents: 50_000,
      name: "Bank Giver",
      email: "bank.giver@example.com",
    });
    // They opted in, and the gift cleared, so they are visibly on the wall.
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: `give:${SESSION}`,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 50_000,
      displayName: "A Neighbour",
      consent: true,
    });
    await postEvent(t, "checkout.session.async_payment_succeeded", {
      id: SESSION,
      amount_total: 50_000,
      payment_status: "paid",
      metadata: {
        giveDonation: "1",
        giveDonorId: String(prepared.donorId),
        giveScope: String(s.chapterId),
      },
    });
    const posted = await run(t, (ctx) => ctx.db.query("givingActivity").collect());
    expect(posted[0].status).toBe("visible");

    installStripeFetch(SESSION);
    await t.action(internal.givingReversals.onDisputeCreated, {
      disputeId: "dp_1",
      chargeId: "ch_x",
      paymentIntentId: "pi_x",
      reason: "insufficient_funds",
      status: "lost",
      amountCents: 50_000,
    });

    // The wall is consent-gated, but consent was to show a gift that HAPPENED.
    const wall = await run(t, (ctx) => ctx.db.query("givingActivity").collect());
    expect(wall[0].status).toBe("hidden");

    const jobs = await run(t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const returned = jobs.filter((j) => j.name.includes("onAchReturned"));
    expect(returned).toHaveLength(1);
    expect(returned[0].args[0]).toMatchObject({
      sessionId: SESSION,
      reason: "insufficient_funds",
    });
    // NOT the never-cleared email — that one says "you haven't been charged",
    // which is false for money that did leave their account.
    expect(jobs.filter((j) => j.name.includes("onAchFailed"))).toHaveLength(0);
  });

  test("a redelivery does not email the donor a second time", async () => {
    const { t, amountCents } = await arrangeSettledGift();
    installStripeFetch(SESSION);
    const args = {
      disputeId: "dp_1",
      chargeId: "ch_x",
      paymentIntentId: "pi_x",
      status: "lost",
      amountCents,
    };

    await t.action(internal.givingReversals.onDisputeCreated, args);
    await t.action(internal.givingReversals.onDisputeCreated, args);

    const jobs = await run(t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.filter((j) => j.name.includes("onAchReturned"))).toHaveLength(1);
  });
});

describe("a dispute the org WINS", () => {
  async function reversedGift() {
    const arranged = await arrangeSettledGift();
    installStripeFetch(SESSION);
    await arranged.t.action(internal.givingReversals.onDisputeCreated, {
      disputeId: "dp_1",
      chargeId: "ch_x",
      paymentIntentId: "pi_x",
      reason: "debit_not_authorized",
      status: "needs_response",
      amountCents: arranged.amountCents,
    });
    return arranged;
  }

  test("winning puts the gift back, with its ORIGINAL date", async () => {
    const { t, donorId, amountCents } = await reversedGift();
    const tombstone = (await reversals(t))[0];
    expect(await gifts(t)).toHaveLength(0);

    await t.action(internal.givingReversals.onDisputeClosed, {
      disputeId: "dp_1",
      status: "won",
    });

    const restored = await gifts(t);
    expect(restored).toHaveLength(1);
    expect(restored[0].amountCents).toBe(amountCents);
    // The money arrived when it arrived. A dispute resolving in our favour in
    // November does not move a September gift into November.
    expect(restored[0].receivedAt).toBe(tombstone.receivedAt);
    expect(restored[0].externalRef).toBe(`give:${SESSION}`);

    const donor = await donorRow(t, donorId);
    expect(donor.lifetimeCents).toBe(amountCents);
    expect(donor.giftCount).toBe(1);
  });

  test("the tombstone stays, marked restored and pointing at the new row", async () => {
    const { t } = await reversedGift();

    await t.action(internal.givingReversals.onDisputeClosed, {
      disputeId: "dp_1",
      status: "won",
    });

    const rows = await reversals(t);
    // Not deleted — the reversal really happened, and the trail of a money-path
    // event outlives the row it is about.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("restored");
    expect(rows[0].restoredAt).toBeGreaterThan(0);
    expect(rows[0].restoredGiftId).toBe((await gifts(t))[0]._id);
  });

  test("LOSING changes nothing — the reversal already happened", async () => {
    const { t, donorId } = await reversedGift();

    await t.action(internal.givingReversals.onDisputeClosed, {
      disputeId: "dp_1",
      status: "lost",
    });

    expect(await gifts(t)).toHaveLength(0);
    expect((await reversals(t))[0].status).toBe("reversed");
    expect((await donorRow(t, donorId)).lifetimeCents).toBe(0);
  });

  test("a win is applied once, however many times it is delivered", async () => {
    const { t, donorId, amountCents } = await reversedGift();

    await t.action(internal.givingReversals.onDisputeClosed, { disputeId: "dp_1", status: "won" });
    await t.action(internal.givingReversals.onDisputeClosed, { disputeId: "dp_1", status: "won" });

    expect(await gifts(t)).toHaveLength(1);
    expect((await donorRow(t, donorId)).lifetimeCents).toBe(amountCents);
  });

  test("winning a dispute we never reversed for does nothing", async () => {
    const { t } = await arrangeSettledGift();

    await t.action(internal.givingReversals.onDisputeClosed, {
      disputeId: "dp_never_seen",
      status: "won",
    });

    // Emphatically NOT a second gift.
    expect(await gifts(t)).toHaveLength(1);
    expect(await reversals(t)).toHaveLength(0);
  });
});
