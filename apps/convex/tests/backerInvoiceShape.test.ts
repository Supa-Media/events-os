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
import { BACKER_UNIT_CENTS } from "@events-os/shared";

/**
 * A BACKER'S MONEY REACHES THE LEDGER — whichever shape Stripe sends.
 *
 * The incident these exist for (2026-08-15): every backer's giving was missing
 * from the gifts ledger. Stripe was delivering `invoice.paid` — the endpoint's
 * subscribed events were verified complete — but the handler guarded on
 * `invoice.subscription`, a top-level field newer API versions moved under
 * `parent.subscription_details.subscription`. When the payload carried the new
 * shape the guard was false, the branch did nothing, no log was written, and
 * the route answered 200. Real money, taken from real people, invisible, with
 * every system reporting health.
 *
 * These drive the REAL `/stripe/webhook` route, because the route is where the
 * bug was: the mutation underneath was always correct and its own tests always
 * passed. That is exactly why nothing caught this.
 */

const SECRET = "whsec_testsecret";

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

/** A donor + an active pledge already linked to a Stripe subscription. */
async function seedBacker(
  s: ChapterSetup,
  subscriptionId: string,
): Promise<Id<"pledges">> {
  return run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope: s.chapterId,
      kind: "individual",
      name: "Ada Backer",
      email: "ada@example.com",
      status: "active",
      lifetimeCents: 0,
      giftCount: 0,
      source: "map",
      createdAt: Date.now(),
    });
    return ctx.db.insert("pledges", {
      donorId,
      scope: s.chapterId,
      amountCents: BACKER_UNIT_CENTS,
      status: "active",
      origin: "stripe",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: subscriptionId,
      startedAt: Date.now() - 86_400_000,
      createdAt: Date.now() - 86_400_000,
      // Already announced, so the first-cycle welcome doesn't muddy the
      // assertions — these tests are about the MONEY.
      announcedAt: Date.now() - 86_400_000,
    });
  });
}

const giftsFor = (s: ChapterSetup, pledgeId: Id<"pledges">) =>
  run(s.t, (ctx) =>
    ctx.db
      .query("gifts")
      .withIndex("by_pledge", (q) => q.eq("pledgeId", pledgeId))
      .collect(),
  );

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("invoice.paid → a gift in the ledger", () => {
  test("the LEGACY shape (top-level `subscription`) records the gift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await seedBacker(s, "sub_legacy");

    const res = await postEvent(t, "invoice.paid", {
      id: "in_legacy",
      subscription: "sub_legacy",
      amount_paid: 5000,
    });
    expect(res.status).toBe(200);

    const gifts = await giftsFor(s, pledgeId);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].amountCents).toBe(5000);
    expect(gifts[0].stripeInvoiceId).toBe("in_legacy");
  });

  test("the NEW shape (parent.subscription_details) records the gift", async () => {
    // THE REGRESSION. Before the fix this produced a 200 and an empty ledger.
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await seedBacker(s, "sub_new");

    const res = await postEvent(t, "invoice.paid", {
      id: "in_new",
      parent: { subscription_details: { subscription: "sub_new" } },
      amount_paid: 5000,
    });
    expect(res.status).toBe(200);

    const gifts = await giftsFor(s, pledgeId);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].amountCents).toBe(5000);
    expect(gifts[0].stripeInvoiceId).toBe("in_new");
  });

  test("the gift is dated when STRIPE says it was paid, not when we heard", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await seedBacker(s, "sub_dated");
    const paidAt = Date.parse("2026-05-12T15:00:00Z");

    await postEvent(t, "invoice.paid", {
      id: "in_dated",
      parent: { subscription_details: { subscription: "sub_dated" } },
      amount_paid: 5000,
      status_transitions: { paid_at: Math.floor(paidAt / 1000) },
    });

    const gifts = await giftsFor(s, pledgeId);
    // A redelivered or delayed webhook must not move money into the wrong
    // month — the ledger and every monthly report read this date.
    expect(gifts[0].receivedAt).toBe(paidAt);
  });

  test("a redelivery still records exactly one gift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await seedBacker(s, "sub_dupe");
    const object = {
      id: "in_dupe",
      parent: { subscription_details: { subscription: "sub_dupe" } },
      amount_paid: 5000,
    };
    await postEvent(t, "invoice.paid", object, "evt_1");
    await postEvent(t, "invoice.paid", object, "evt_2");
    expect(await giftsFor(s, pledgeId)).toHaveLength(1);
  });

  test("an unresolvable invoice is refused LOUDLY, not silently", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBacker(s, "sub_quiet");
    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });

    // Neither shape present — the case that used to return 200 in silence.
    const res = await postEvent(t, "invoice.paid", {
      id: "in_orphan",
      amount_paid: 5000,
    });
    spy.mockRestore();

    // Still a 200: Stripe must not retry forever over a payload we can't read.
    expect(res.status).toBe(200);
    // But it is impossible to miss in the logs, and it names the repair tool.
    const said = errors.flat().join(" ");
    expect(said).toContain("in_orphan");
    expect(said).toContain("no gift recorded");
    expect(said).toContain("backerInvoiceRecovery");
  });
});

describe("invoice.payment_failed → past_due", () => {
  test("the NEW shape still moves the pledge to past_due", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await seedBacker(s, "sub_failed");

    await postEvent(t, "invoice.payment_failed", {
      id: "in_failed",
      parent: { subscription_details: { subscription: "sub_failed" } },
    });

    const pledge = await run(s.t, (ctx) => ctx.db.get(pledgeId));
    // Silent here meant a declined card never flipped the status, so the
    // dunning email never sent either.
    expect(pledge?.status).toBe("past_due");
  });
});

describe("recovering what was lost", () => {
  test("a recovered cycle is banked, dated correctly, and mails nobody", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await seedBacker(s, "sub_recover");
    const paidAt = Date.parse("2026-05-12T15:00:00Z");

    // What the sweep does per missing invoice.
    const ok = await t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_recover",
      invoiceId: "in_may",
      amountPaidCents: 5000,
      receivedAt: paidAt,
      suppressEmails: true,
      attemptRecovery: false,
    });
    expect(ok).toBe(true);

    const gifts = await giftsFor(s, pledgeId);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].receivedAt).toBe(paidAt);

    // NOTHING is mailed: no receipt about May, no welcome, no desk bell.
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const names = scheduled.map((r) => r.name);
    expect(names.filter((n) => n.endsWith("sendPledgeReceiptEmail"))).toHaveLength(0);
    expect(names.filter((n) => n.endsWith("sendBackerWelcomeEmail"))).toHaveLength(0);
    expect(names.filter((n) => n.endsWith("notifyGiftRecorded"))).toHaveLength(0);
  });

  test("the donor rollups still move — recovered money is real money", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await seedBacker(s, "sub_rollup");

    await t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_rollup",
      invoiceId: "in_rollup",
      amountPaidCents: 5000,
      suppressEmails: true,
      attemptRecovery: false,
    });

    const pledge = await run(s.t, (ctx) => ctx.db.get(pledgeId));
    const donor = await run(s.t, (ctx) => ctx.db.get(pledge!.donorId));
    expect(donor?.lifetimeCents).toBe(5000);
    expect(donor?.giftCount).toBe(1);
  });

  test("re-recording the same invoice is a no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await seedBacker(s, "sub_twice");
    const args = {
      subscriptionId: "sub_twice",
      invoiceId: "in_twice",
      amountPaidCents: 5000,
      suppressEmails: true,
      attemptRecovery: false,
    };
    await t.mutation(internal.givingPledges.recordPledgeInvoice, args);
    await t.mutation(internal.givingPledges.recordPledgeInvoice, args);
    // The sweep leans on this: it has no stamp of its own, so idempotency on
    // the invoice id is the only thing stopping a double-count.
    expect(await giftsFor(s, pledgeId)).toHaveLength(1);
  });

  test("the ledger check sees an existing gift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBacker(s, "sub_exists");
    await t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_exists",
      invoiceId: "in_exists",
      amountPaidCents: 5000,
      suppressEmails: true,
      attemptRecovery: false,
    });

    expect(
      await t.query(internal.backerInvoiceRecovery.giftExistsForInvoice, {
        invoiceId: "in_exists",
      }),
    ).toBe(true);
    expect(
      await t.query(internal.backerInvoiceRecovery.giftExistsForInvoice, {
        invoiceId: "in_nope",
      }),
    ).toBe(false);
  });

  test("the sweep only offers pledges that have a subscription to check", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBacker(s, "sub_listed");
    // An imported pledge on the old platform has no subscription — there is
    // nothing to ask Stripe about, so it must not appear.
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Legacy",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        source: "givebutter-import",
        createdAt: Date.now(),
      });
      await ctx.db.insert("pledges", {
        donorId,
        scope: s.chapterId,
        amountCents: 5000,
        status: "active",
        origin: "imported",
        createdAt: Date.now(),
      });
    });

    const page = await t.query(
      internal.backerInvoiceRecovery.listPledgesWithSubscriptions,
      { cursor: null, numItems: 50 },
    );
    expect(page.scanned).toBe(2);
    expect(page.due).toHaveLength(1);
    expect(page.due[0].subscriptionId).toBe("sub_listed");
  });
});
