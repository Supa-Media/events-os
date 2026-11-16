/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { refundEmailHtml, refundSmsBody } from "../saleRefundNotices";

/**
 * Refunds from the Sales page (`saleRefunds.ts`). What matters: only a finance
 * manager can send one, a refund takes the order out of revenue and voids its
 * tickets, a FAILED refund changes nothing and can be reissued, and an order
 * can't be refunded twice.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Role = "viewer" | "bookkeeper" | "manager";

async function setupWithRole(role: Role): Promise<ChapterSetup> {
  const t = newT();
  const s = await setupChapter(t);
  await run(t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    });
    await ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    });
  });
  return s;
}

/** A paid $30 Stripe order with one issued ticket, on an event page. */
async function seedPaidOrder(s: ChapterSetup) {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Service",
      slug: `service-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Brooklyn's Got Talent (Christian Edition)",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const pageId = await ctx.db.insert("eventPages", {
      eventId,
      chapterId: s.chapterId,
      slug: `bgt-${Math.random()}`,
      published: true,
      goingCount: 1,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: 1,
      revenueCents: 3000,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const ticketTypeId = await ctx.db.insert("ticketTypes", {
      eventId,
      chapterId: s.chapterId,
      name: "General Admission",
      priceCents: 3000,
      currency: "usd",
      soldCount: 1,
      sortOrder: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const orderId = await ctx.db.insert("ticketOrders", {
      eventId,
      chapterId: s.chapterId,
      name: "Buyer",
      email: "buyer@example.com",
      items: [
        { ticketTypeId, name: "General Admission", quantity: 1, unitPriceCents: 3000 },
      ],
      totalCents: 3000,
      currency: "usd",
      status: "paid",
      stripePaymentIntentId: "pi_test_123",
      createdAt: now,
      updatedAt: now,
    });
    const ticketId = await ctx.db.insert("tickets", {
      eventId,
      chapterId: s.chapterId,
      orderId,
      ticketTypeId,
      ticketTypeName: "General Admission",
      attendeeName: "Buyer",
      attendeeEmail: "buyer@example.com",
      code: `PW-${Math.random()}`,
      status: "valid",
      createdAt: now,
    });
    return { orderId, ticketId, ticketTypeId, pageId };
  });
}

/** Stub Stripe's refunds endpoint with one answer. */
function stubStripe(answer: { ok: boolean; status?: string; error?: string }) {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_refunds");
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: answer.ok,
    status: answer.ok ? 200 : 402,
    json: async () =>
      answer.ok
        ? { id: "re_test_1", status: answer.status ?? "succeeded" }
        : { error: { message: answer.error ?? "Card closed" } },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("refundTicketOrder", () => {
  test("a manager's refund voids the ticket, drops the counters, and leaves revenue", async () => {
    const s = await setupWithRole("manager");
    const { orderId, ticketId, ticketTypeId, pageId } = await seedPaidOrder(s);
    const fetchMock = stubStripe({ ok: true });

    const res = await s.as.action(api.saleRefunds.refundTicketOrder, {
      orderId,
      reason: "Can't make it",
    });
    expect(res.status).toBe("succeeded");

    // Idempotency key is the attempt row — a retry can't pay out twice.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^sale-refund-/);
    expect(String(init.body)).toContain("amount=3000");

    const after = await run(s.t, async (ctx) => ({
      order: await ctx.db.get(orderId),
      ticket: await ctx.db.get(ticketId),
      tt: await ctx.db.get(ticketTypeId),
      page: await ctx.db.get(pageId),
    }));
    expect(after.order?.status).toBe("refunded");
    expect(after.ticket?.status).toBe("void");
    expect(after.tt?.soldCount).toBe(0);
    expect(after.page?.ticketsSoldCount).toBe(0);
    expect(after.page?.revenueCents).toBe(0);

    // Still listed (so the refund is visible) but out of every total.
    const list = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    expect(list.sales).toHaveLength(1);
    expect(list.sales[0].refund?.status).toBe("succeeded");
    expect(list.summary.grossCents).toBe(0);
    expect(list.summary.count).toBe(0);
    expect(list.summary.refundedCount).toBe(1);
    expect(list.summary.refundedCents).toBe(3000);
    expect(list.canRefund).toBe(true);

    // And it can't be refunded a second time.
    await expect(
      s.as.action(api.saleRefunds.refundTicketOrder, { orderId }),
    ).rejects.toThrow(ConvexError);
  });

  test("a failed refund changes nothing and can be reissued", async () => {
    const s = await setupWithRole("manager");
    const { orderId, ticketId } = await seedPaidOrder(s);

    stubStripe({ ok: false, error: "Card closed" });
    const first = await s.as.action(api.saleRefunds.refundTicketOrder, { orderId });
    expect(first.status).toBe("failed");
    expect(first.message).toBe("Card closed");

    let order = await run(s.t, (ctx) => ctx.db.get(orderId));
    expect(order?.status).toBe("paid");
    const list = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    expect(list.sales[0].refund?.status).toBe("failed");
    expect(list.summary.grossCents).toBe(3000);

    // Reissue: a new attempt that goes through.
    vi.unstubAllGlobals();
    stubStripe({ ok: true });
    const second = await s.as.action(api.saleRefunds.refundTicketOrder, { orderId });
    expect(second.status).toBe("succeeded");
    order = await run(s.t, (ctx) => ctx.db.get(orderId));
    expect(order?.status).toBe("refunded");
    const ticket = await run(s.t, (ctx) => ctx.db.get(ticketId));
    expect(ticket?.status).toBe("void");

    const history = await s.as.query(api.saleRefunds.refundHistory, { orderId });
    expect(history.map((h) => h.status)).toEqual(["succeeded", "failed"]);
  });

  test("a refund Stripe later fails is put back", async () => {
    const s = await setupWithRole("manager");
    const { orderId, ticketId, pageId } = await seedPaidOrder(s);
    stubStripe({ ok: true, status: "pending" });
    await s.as.action(api.saleRefunds.refundTicketOrder, { orderId });
    const refundId = (await s.as.query(api.saleRefunds.refundHistory, { orderId }))[0]
      .id as Id<"saleRefunds">;

    vi.unstubAllGlobals();
    stubStripe({ ok: true, status: "failed" });
    const checked = await s.as.action(api.saleRefunds.checkRefund, { refundId });
    expect(checked.status).toBe("failed");

    const after = await run(s.t, async (ctx) => ({
      order: await ctx.db.get(orderId),
      ticket: await ctx.db.get(ticketId),
      page: await ctx.db.get(pageId),
    }));
    expect(after.order?.status).toBe("paid");
    expect(after.ticket?.status).toBe("valid");
    expect(after.page?.revenueCents).toBe(3000);
    expect(after.page?.ticketsSoldCount).toBe(1);
  });

  test("a bookkeeper can see sales but not send a refund", async () => {
    const s = await setupWithRole("bookkeeper");
    const { orderId } = await seedPaidOrder(s);
    const fetchMock = stubStripe({ ok: true });

    const list = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    expect(list.canRefund).toBe(false);
    await expect(
      s.as.action(api.saleRefunds.refundTicketOrder, { orderId }),
    ).rejects.toThrow(/finance manager/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an order not paid through our Stripe checkout is refused", async () => {
    const s = await setupWithRole("manager");
    const { orderId } = await seedPaidOrder(s);
    await run(s.t, (ctx) => ctx.db.patch(orderId, { stripePaymentIntentId: undefined }));
    const fetchMock = stubStripe({ ok: true });
    await expect(
      s.as.action(api.saleRefunds.refundTicketOrder, { orderId }),
    ).rejects.toThrow(/where it was paid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refund notice", () => {
  test("tells the buyer the amount, the card, and 5–10 business days — never 'reply'", () => {
    const html = refundEmailHtml({
      name: "Charisma Stevens",
      amountCents: 3000,
      eventName: "Brooklyn's Got Talent",
      slug: null,
    });
    expect(html).toContain("$30.00");
    expect(html).toContain("5–10 business days");
    expect(html).toContain("card you used");
    expect(html.toLowerCase()).not.toContain("reply");
    const sms = refundSmsBody({ amountCents: 3000, eventName: "Brooklyn's Got Talent" });
    expect(sms).toContain("$30.00");
    expect(sms).toContain("5–10 business days");
  });

  test("a live refund schedules the notice; a refused one doesn't", async () => {
    const s = await setupWithRole("manager");
    const { orderId } = await seedPaidOrder(s);
    stubStripe({ ok: false });
    await s.as.action(api.saleRefunds.refundTicketOrder, { orderId });
    const countNotices = () =>
      run(s.t, async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
          f.name.includes("sendRefundNotice"),
        ).length,
      );
    expect(await countNotices()).toBe(0);

    vi.unstubAllGlobals();
    stubStripe({ ok: true });
    await s.as.action(api.saleRefunds.refundTicketOrder, { orderId });
    expect(await countNotices()).toBe(1);
  });
});
