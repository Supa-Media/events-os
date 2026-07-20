import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { hashEmailCode } from "../lib/emailCodes";

/**
 * RSVP email verification: a 6-digit code (stored hashed) confirms the guest
 * owns the email on their RSVP. Covers code issuance from submitRsvp, the
 * verify/resend mutations' guardrails (attempts, expiry, rate limit), how
 * blasts treat unverified addresses, and Stripe fulfillment auto-verifying.
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Night",
      slug: "night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Verification Night",
      eventDate: now + 7 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Seeded chapter + published page, ready for public RSVPs. */
async function setupPage() {
  const t = newT();
  const s = await setupChapter(t);
  const eventId = await seedEvent(s);
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true },
  });
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  return { t, s, eventId, pageId, slug: admin.page!.slug };
}

function rsvpByToken(s: ChapterSetup, token: string) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("rsvps")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique(),
  );
}

function codeRowFor(s: ChapterSetup, rsvpId: Id<"rsvps">) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("rsvpEmailCodes")
      .withIndex("by_rsvp", (q) => q.eq("rsvpId", rsvpId))
      .unique(),
  );
}

/** Overwrite the stored hash so the test knows the "emailed" code. */
async function plantCode(s: ChapterSetup, rsvpId: Id<"rsvps">, code: string) {
  const row = await codeRowFor(s, rsvpId);
  await run(s.t, (ctx) =>
    ctx.db.patch(row!._id, { codeHash: hashEmailCode(code) }),
  );
}

async function submitAda(t: ReturnType<typeof newT>, slug: string) {
  return await t.mutation(api.ticketing.submitRsvp, {
    slug,
    name: "Ada Guest",
    email: "ada@example.com",
    status: "going",
  });
}

describe("code issuance from submitRsvp", () => {
  test("a new RSVP needs verification; only a hash is stored, never returned", async () => {
    const { t, s, slug } = await setupPage();
    const res = await submitAda(t, slug);
    expect(res.needsEmailVerification).toBe(true);
    expect(Object.keys(res).sort()).toEqual([
      "needsEmailVerification",
      "status",
      "token",
    ]);

    const rsvp = await rsvpByToken(s, res.token);
    expect(rsvp!.emailVerified).toBe(false);
    const row = await codeRowFor(s, rsvp!._id);
    expect(row).toMatchObject({ attempts: 0 });
    expect(row!.expiresAt).toBeGreaterThan(Date.now());
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);

    const pub = await t.query(api.ticketing.getPublicPage, {
      slug,
      token: res.token,
    });
    expect(pub?.viewer?.emailVerified).toBe(false);
  });

  test("changing the email resets verification; unchanged email keeps it", async () => {
    const { t, s, slug } = await setupPage();
    const { token } = await submitAda(t, slug);
    const rsvp = await rsvpByToken(s, token);
    await plantCode(s, rsvp!._id, "123456");
    await t.mutation(api.ticketingVerification.verifyRsvpEmail, {
      slug,
      token,
      code: "123456",
    });

    // Same email (token-only status flip) → stays verified.
    const same = await t.mutation(api.ticketing.submitRsvp, {
      slug,
      token,
      status: "maybe",
    });
    expect(same.needsEmailVerification).toBe(false);
    expect((await rsvpByToken(s, token))!.emailVerified).toBe(true);

    // New email → back to unverified with a fresh pending code.
    const changed = await t.mutation(api.ticketing.submitRsvp, {
      slug,
      token,
      status: "maybe",
      email: "ada-new@example.com",
    });
    expect(changed.needsEmailVerification).toBe(true);
    const after = await rsvpByToken(s, token);
    expect(after!.emailVerified).toBe(false);
    expect(await codeRowFor(s, after!._id)).not.toBeNull();
  });
});

describe("verifyRsvpEmail", () => {
  test("the correct code verifies and deletes the code row", async () => {
    const { t, s, slug } = await setupPage();
    const { token } = await submitAda(t, slug);
    const rsvp = await rsvpByToken(s, token);
    await plantCode(s, rsvp!._id, "123456");

    const res = await t.mutation(api.ticketingVerification.verifyRsvpEmail, {
      slug,
      token,
      code: "123456",
    });
    expect(res).toEqual({ ok: true });
    expect((await rsvpByToken(s, token))!.emailVerified).toBe(true);
    expect(await codeRowFor(s, rsvp!._id)).toBeNull();

    const pub = await t.query(api.ticketing.getPublicPage, { slug, token });
    expect(pub?.viewer?.emailVerified).toBe(true);
  });

  test("five wrong codes lock the pending code out", async () => {
    const { t, s, slug } = await setupPage();
    const { token } = await submitAda(t, slug);
    const rsvp = await rsvpByToken(s, token);
    await plantCode(s, rsvp!._id, "123456");

    for (let i = 0; i < 5; i++) {
      const res = await t.mutation(api.ticketingVerification.verifyRsvpEmail, {
        slug,
        token,
        code: "000000",
      });
      expect(res.ok).toBe(false);
    }
    expect((await codeRowFor(s, rsvp!._id))!.attempts).toBe(5);

    // Even the right code is refused once locked.
    await expect(
      t.mutation(api.ticketingVerification.verifyRsvpEmail, {
        slug,
        token,
        code: "123456",
      }),
    ).rejects.toThrow(/Too many tries/);
    expect((await rsvpByToken(s, token))!.emailVerified).toBe(false);
  });

  test("an expired code is rejected", async () => {
    const { t, s, slug } = await setupPage();
    const { token } = await submitAda(t, slug);
    const rsvp = await rsvpByToken(s, token);
    await plantCode(s, rsvp!._id, "123456");
    const row = await codeRowFor(s, rsvp!._id);
    await run(s.t, (ctx) => ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 }));

    await expect(
      t.mutation(api.ticketingVerification.verifyRsvpEmail, {
        slug,
        token,
        code: "123456",
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe("resendRsvpEmailCode", () => {
  test("rate-limited within 60s; a later resend issues a fresh code", async () => {
    const { t, s, slug } = await setupPage();
    const { token } = await submitAda(t, slug);
    const rsvp = await rsvpByToken(s, token);

    await expect(
      t.mutation(api.ticketingVerification.resendRsvpEmailCode, { slug, token }),
    ).rejects.toThrow(/just sent/);

    const row = await codeRowFor(s, rsvp!._id);
    await run(s.t, (ctx) =>
      ctx.db.patch(row!._id, { lastSentAt: Date.now() - 61_000, attempts: 3 }),
    );
    await t.mutation(api.ticketingVerification.resendRsvpEmailCode, {
      slug,
      token,
    });
    const fresh = await codeRowFor(s, rsvp!._id);
    expect(fresh!.attempts).toBe(0);
    expect(fresh!.lastSentAt).toBeGreaterThan(Date.now() - 5_000);
  });

  test("refused once the email is already verified", async () => {
    const { t, s, slug } = await setupPage();
    const { token } = await submitAda(t, slug);
    const rsvp = await rsvpByToken(s, token);
    await plantCode(s, rsvp!._id, "123456");
    await t.mutation(api.ticketingVerification.verifyRsvpEmail, {
      slug,
      token,
      code: "123456",
    });
    await expect(
      t.mutation(api.ticketingVerification.resendRsvpEmailCode, { slug, token }),
    ).rejects.toThrow(/already verified/);
  });
});

describe("blast audiences and verification", () => {
  test("legacy (undefined) counts as verified; explicit false is excluded", async () => {
    const { s, eventId } = await setupPage();
    await run(s.t, async (ctx) => {
      const now = Date.now();
      const base = {
        eventId,
        chapterId: s.chapterId,
        status: "going" as const,
        source: "rsvp" as const,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.db.insert("rsvps", { ...base, name: "Legacy", email: "legacy@example.com", token: "tok-legacy" });
      await ctx.db.insert("rsvps", { ...base, name: "Unverified", email: "unverified@example.com", token: "tok-unverified", emailVerified: false });
      await ctx.db.insert("rsvps", { ...base, name: "Verified", email: "verified@example.com", token: "tok-verified", emailVerified: true });
    });
    const blastId = await run(s.t, (ctx) =>
      ctx.db.insert("blasts", {
        eventId,
        chapterId: s.chapterId,
        channel: "email",
        body: "hello",
        audience: "everyone",
        status: "sending",
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );
    const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
    expect(payload?.emails.sort()).toEqual([
      "legacy@example.com",
      "verified@example.com",
    ]);
  });
});

describe("checkout and verification", () => {
  test("a paid Stripe fulfillment marks the buyer's email verified", async () => {
    const { t, s, eventId, pageId, slug } = await setupPage();
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { ticketsEnabled: true },
    });
    const paidId = (await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "Supporter",
      priceCents: 2500,
    })) as Id<"ticketTypes">;

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Ben Buyer",
      email: "ben@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: paidId, quantity: 1 }],
    });
    expect(prepared.needsEmailVerification).toBe(true);
    const rsvp = await rsvpByToken(s, prepared.guestToken);
    expect(rsvp!.emailVerified).toBe(false);
    // Paid carts don't email a code — Stripe will vouch for the address.
    expect(await codeRowFor(s, rsvp!._id)).toBeNull();

    await t.mutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: "cs_verify",
    });
    await t.mutation(internal.ticketing.markSessionPaid, {
      sessionId: "cs_verify",
      paymentIntentId: "pi_1",
    });
    expect((await rsvpByToken(s, prepared.guestToken))!.emailVerified).toBe(true);
  });

  test("a free claim emails a code and stays unverified after fulfillment", async () => {
    const { t, s, eventId, pageId, slug } = await setupPage();
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { ticketsEnabled: true },
    });
    const freeId = (await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "Community",
      priceCents: 0,
    })) as Id<"ticketTypes">;

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Cara Claim",
      email: "cara@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: freeId, quantity: 1 }],
    });
    expect(prepared.needsEmailVerification).toBe(true);
    const rsvp = await rsvpByToken(s, prepared.guestToken);
    expect(await codeRowFor(s, rsvp!._id)).not.toBeNull();

    await t.mutation(internal.ticketing.fulfillOrder, {
      orderId: prepared.orderId,
    });
    expect((await rsvpByToken(s, prepared.guestToken))!.emailVerified).toBe(false);
  });
});
