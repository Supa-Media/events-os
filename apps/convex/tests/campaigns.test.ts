import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Email campaigns (audiences.ts + campaigns.ts + the /unsubscribe and
 * /resend/webhook routes, http.ts):
 *  - Access: `myCampaignsAccess` (soft) + every CRUD/send gate — central
 *    ED/FM or superuser only.
 *  - Audience resolution per source: guests (dedup by most-recently-updated
 *    row, `emailVerified` gate, suppression), donors (scope fan-out,
 *    donorStatus, gaveWithinDays), people (isPlaceholder/inactive gate,
 *    pwEmail fallback), all suppression-filtered.
 *  - Campaign lifecycle: draft → send → materialize → deliver, with
 *    personalization, unsubscribe headers, suppressed-skip, and a
 *    resend-unconfigured recorded failure.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

function emptyDoc() {
  return { blocks: [] as unknown[] };
}

function heroDoc() {
  return {
    blocks: [
      { id: "b1", kind: "heading", text: "Hi {{firstName}}" },
      { id: "b2", kind: "text", markdown: "Thanks for being part of this." },
    ],
  };
}

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

// ── Access ────────────────────────────────────────────────────────────────

describe("myCampaignsAccess", () => {
  test("a superuser can view", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
    });
  });

  test("a non-privileged user cannot view (soft — no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: false,
    });
  });
});

describe("access gates throw for non-privileged callers", () => {
  test("createAudience", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.audiences.createAudience, {
        scope: "central",
        name: "Everyone",
        source: "people",
        filters: {},
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("createCampaign", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const audienceId = await run(s.t, (ctx) =>
      ctx.db.insert("audiences", {
        scope: "central",
        name: "A",
        source: "people",
        filters: {},
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "Newsletter",
        subject: "Hi",
        audienceId,
        doc: emptyDoc(),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("send", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const campaignId = await run(s.t, async (ctx) => {
      const audienceId = await ctx.db.insert("audiences", {
        scope: "central",
        name: "A",
        source: "people",
        filters: {},
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("campaigns", {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
        status: "draft",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(
      s.as.mutation(api.campaigns.send, { campaignId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── Audience CRUD ─────────────────────────────────────────────────────────

describe("audiences CRUD", () => {
  test("create/get/update/archive/list round-trip", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await s.as.mutation(api.audiences.createAudience, {
      scope: "central",
      name: "Active donors",
      source: "donors",
      filters: { donorStatus: "active" },
    });
    const fetched = await s.as.query(api.audiences.getAudience, { audienceId });
    expect(fetched.name).toBe("Active donors");

    await s.as.mutation(api.audiences.updateAudience, {
      audienceId,
      name: "Active donors (renamed)",
    });
    expect((await s.as.query(api.audiences.getAudience, { audienceId })).name).toBe(
      "Active donors (renamed)",
    );

    const listed = await s.as.query(api.audiences.listAudiences, { scope: "central" });
    expect(listed.map((a) => a._id)).toContain(audienceId);

    await s.as.mutation(api.audiences.archiveAudience, { audienceId });
    const listedAfterArchive = await s.as.query(api.audiences.listAudiences, {
      scope: "central",
    });
    expect(listedAfterArchive.map((a) => a._id)).not.toContain(audienceId);
  });

  test("createAudience rejects a blank name", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await expect(
      s.as.mutation(api.audiences.createAudience, {
        scope: "central",
        name: "   ",
        source: "people",
        filters: {},
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── Guest audience resolution ─────────────────────────────────────────────

async function seedEventWithGuests(s: ChapterSetup): Promise<Id<"events">> {
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
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Night",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: "Ann Older",
      email: "ann@example.com",
      status: "going",
      token: "tok-ann-1",
      createdAt: now,
      updatedAt: now - 10_000,
    });
    // A later row for the SAME email, with an updated name — dedup should
    // keep this one (the most-recently-updated).
    await ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: "Ann Newer",
      email: "ann@example.com",
      status: "going",
      token: "tok-ann-2",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: "Unverified Guy",
      email: "unverified@example.com",
      emailVerified: false,
      status: "going",
      token: "tok-unverified",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: "No Email",
      status: "going",
      token: "tok-noemail",
      createdAt: now,
      updatedAt: now,
    });
    return eventId;
  });
}

describe("previewAudience — guests", () => {
  test("dedups by email keeping the most-recently-updated name, drops unverified/email-less, drops suppressed", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedEventWithGuests(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "unverified@example.com", // would already be excluded anyway
        reason: "manual",
        createdAt: Date.now(),
      }),
    );

    const preview = await s.as.query(api.audiences.previewAudience, {
      scope: "central",
      source: "guests",
      filters: {},
    });
    expect(preview.count).toBe(1);
    expect(preview.sample).toEqual([{ name: "Ann Newer", email: "ann@example.com" }]);
    expect(preview.excludedUnverified).toBe(1);
  });

  test("filters.eventId restricts to one event", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await seedEventWithGuests(s);
    const preview = await s.as.query(api.audiences.previewAudience, {
      scope: "central",
      source: "guests",
      filters: { eventId },
    });
    expect(preview.count).toBe(1);
  });
});

// ── Donor audience resolution ─────────────────────────────────────────────

async function seedDonor(
  s: ChapterSetup,
  opts: { email: string; status: "prospect" | "active" | "lapsed"; lastGiftAt?: number },
): Promise<Id<"donors">> {
  return await run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope: s.chapterId,
      kind: "individual",
      name: `Donor ${opts.email}`,
      email: opts.email,
      status: opts.status,
      lifetimeCents: 1000,
      giftCount: 1,
      createdAt: Date.now(),
    });
    if (opts.lastGiftAt !== undefined) {
      await ctx.db.insert("gifts", {
        donorId,
        scope: s.chapterId,
        amountCents: 1000,
        currency: "usd",
        receivedAt: opts.lastGiftAt,
        method: "cash",
        createdAt: opts.lastGiftAt,
      });
    }
    return donorId;
  });
}

describe("previewAudience — donors", () => {
  test("donorStatus filters, gaveWithinDays filters, suppressed excluded", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    await seedDonor(s, { email: "recent@example.com", status: "active", lastGiftAt: now - 5 * DAY });
    await seedDonor(s, { email: "stale@example.com", status: "active", lastGiftAt: now - 90 * DAY });
    await seedDonor(s, { email: "prospect@example.com", status: "prospect" });
    await seedDonor(s, { email: "suppressed@example.com", status: "active", lastGiftAt: now - DAY });
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "suppressed@example.com",
        reason: "bounce",
        createdAt: Date.now(),
      }),
    );

    const statusOnly = await s.as.query(api.audiences.previewAudience, {
      scope: s.chapterId,
      source: "donors",
      filters: { donorStatus: "active" },
    });
    expect(statusOnly.count).toBe(2); // recent + stale (suppressed dropped)
    expect(statusOnly.excludedSuppressed).toBe(1);

    const withGaveWithinDays = await s.as.query(api.audiences.previewAudience, {
      scope: s.chapterId,
      source: "donors",
      filters: { donorStatus: "active", gaveWithinDays: 30 },
    });
    expect(withGaveWithinDays.count).toBe(1);
    expect(withGaveWithinDays.sample[0].email).toBe("recent@example.com");
  });

  test("a central-scoped audience fans out across every active chapter + central", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const otherChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "LA", isActive: true, createdAt: Date.now() }),
    );
    await seedDonor(s, { email: "ny@example.com", status: "active" });
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: otherChapterId,
        kind: "individual",
        name: "LA donor",
        email: "la@example.com",
        status: "active",
        lifetimeCents: 500,
        giftCount: 1,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Central donor",
        email: "central@example.com",
        status: "active",
        lifetimeCents: 500,
        giftCount: 1,
        createdAt: Date.now(),
      }),
    );

    const preview = await s.as.query(api.audiences.previewAudience, {
      scope: "central",
      source: "donors",
      filters: { donorStatus: "active" },
    });
    expect(preview.count).toBe(3);
  });
});

// ── People audience resolution ────────────────────────────────────────────

describe("previewAudience — people", () => {
  test("excludes placeholders/inactive, prefers pwEmail, drops suppressed", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await run(s.t, async (ctx) => {
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Team Member",
        email: "personal@example.com",
        pwEmail: "team@publicworship.life",
        status: "active",
        createdAt: Date.now(),
      });
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Inactive",
        email: "inactive@example.com",
        status: "inactive",
        createdAt: Date.now(),
      });
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Placeholder",
        email: "placeholder@example.com",
        isPlaceholder: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Suppressed",
        email: "suppressed-person@example.com",
        status: "active",
        createdAt: Date.now(),
      });
      await ctx.db.insert("emailSuppressions", {
        email: "suppressed-person@example.com",
        reason: "manual",
        createdAt: Date.now(),
      });
    });

    const preview = await s.as.query(api.audiences.previewAudience, {
      scope: "central",
      source: "people",
      filters: { chapterId: s.chapterId },
    });
    expect(preview.count).toBe(1);
    expect(preview.sample[0].email).toBe("team@publicworship.life");
    expect(preview.excludedSuppressed).toBe(1);
  });
});

// ── Campaign CRUD ─────────────────────────────────────────────────────────

async function seedAudience(s: ChapterSetup, source: "guests" | "donors" | "people" = "people") {
  return await run(s.t, (ctx) =>
    ctx.db.insert("audiences", {
      scope: "central",
      name: "Aud",
      source,
      filters: {},
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("campaign CRUD", () => {
  test("createCampaign validates the EmailDocument", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    await expect(
      s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: { blocks: [{ id: "b1", kind: "bogus" }] },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("createCampaign rejects a missing audience", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await expect(
      s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId: "not_a_real_id" as unknown as Id<"audiences">,
        doc: emptyDoc(),
      }),
    ).rejects.toThrow();
  });

  test("updateCampaignMeta/updateCampaignDoc are blocked once a campaign isn't a draft", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
    });
    await run(s.t, (ctx) => ctx.db.patch(campaignId, { status: "sent" }));
    await expect(
      s.as.mutation(api.campaigns.updateCampaignMeta, { campaignId, name: "New name" }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.campaigns.updateCampaignDoc, { campaignId, doc: emptyDoc() }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── Send pipeline ─────────────────────────────────────────────────────────

async function configureResend(s: ChapterSetup): Promise<void> {
  await s.as.mutation(api.integrationSettings.setResendSettings, {
    apiKey: "re_test_key",
    fromAddress: "Chapter OS <os@publicworship.life>",
  });
}

describe("send pipeline", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("draft → send → materialize → deliver: personalization, unsubscribe headers, counts", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Riley Reader",
          email: "riley@example.com",
          status: "active",
          createdAt: Date.now(),
        }),
      );
      const audienceId = await seedAudience(s, "people");
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "Spring update",
        subject: "Hello!",
        audienceId,
        doc: heroDoc(),
      });

      const sends: { to: string; subject: string; body: Record<string, unknown> }[] = [];
      globalThis.fetch = (async (
        _url: string,
        init?: { body?: string },
      ) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sends.push({ to: body.to, subject: body.subject, body });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("sent");
      expect(campaign.recipientCount).toBe(1);
      expect(campaign.sentCount).toBe(1);
      expect(campaign.failedCount).toBe(0);

      expect(sends).toHaveLength(1);
      expect(sends[0].to).toBe("riley@example.com");
      // {{firstName}} was substituted from the resolved recipient's name.
      expect(sends[0].body.html as string).toContain("Hi Riley");
      expect(sends[0].body.html as string).toContain("Unsubscribe");
      expect(sends[0].body.headers).toMatchObject({
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      });
      expect((sends[0].body.headers as Record<string, string>)["List-Unsubscribe"]).toMatch(
        /^<.*\/unsubscribe\/.+>$/,
      );

      const recipients = await run(s.t, (ctx) =>
        ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect(),
      );
      expect(recipients).toHaveLength(1);
      expect(recipients[0].status).toBe("sent");
      expect(recipients[0].unsubscribeToken.length).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a suppressed recipient is skipped at delivery time and marked 'suppressed'", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Suppressed Sam",
          email: "sam@example.com",
          status: "active",
          createdAt: Date.now(),
        }),
      );
      const audienceId = await seedAudience(s, "people");
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
      });

      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount++;
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      // Drive materialize directly (bypassing the scheduler) so a suppression
      // can be inserted in the real gap between materialize and deliver —
      // `send()` only SCHEDULES materialize, so `finishAllScheduledFunctions`
      // alone would drain both steps back-to-back with no room to inject one.
      await run(s.t, (ctx) => ctx.db.patch(campaignId, { status: "sending" }));
      await t.action(internal.campaigns.materializeRecipients, { campaignId });
      await run(s.t, (ctx) =>
        ctx.db.insert("emailSuppressions", {
          email: "sam@example.com",
          reason: "unsubscribe",
          createdAt: Date.now(),
        }),
      );
      // materializeRecipients already scheduled deliverCampaignBatch — drain it.
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(fetchCount).toBe(0);
      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.sentCount).toBe(0);
      expect(campaign.suppressedCount).toBe(1);
      expect(campaign.status).toBe("failed"); // 0 sent out of 1 processed
    } finally {
      vi.useRealTimers();
    }
  });

  test("Resend unconfigured — send() records a failure without scheduling anything", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    // No resend settings configured, and no RESEND_API_KEY env.
    const realKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "P",
          email: "p@example.com",
          status: "active",
          createdAt: Date.now(),
        }),
      );
      const audienceId = await seedAudience(s, "people");
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
      });
      await s.as.mutation(api.campaigns.send, { campaignId });
      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("failed");
      expect(campaign.error).toMatch(/Resend isn't connected/);
    } finally {
      if (realKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = realKey;
    }
  });

  test("zero matching recipients — materialize records a failure", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      const audienceId = await seedAudience(s, "people"); // no people seeded
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
      });
      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("failed");
      expect(campaign.recipientCount).toBe(0);
      expect(campaign.error).toMatch(/No recipients/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("send is refused for a campaign that's already sending/sent", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
    });
    await run(s.t, (ctx) => ctx.db.patch(campaignId, { status: "sent" }));
    await expect(s.as.mutation(api.campaigns.send, { campaignId })).rejects.toBeInstanceOf(
      ConvexError,
    );
  });

  test("retrying a failed send clears prior campaignRecipients rows instead of duplicating them", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Retry Rey",
          email: "rey@example.com",
          status: "active",
          createdAt: Date.now(),
        }),
      );
      const audienceId = await seedAudience(s, "people");
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
      });
      // Simulate a prior failed attempt that got as far as materializing one
      // (now-stale) row before failing.
      await run(s.t, async (ctx) => {
        await ctx.db.patch(campaignId, { status: "failed", error: "boom" });
        await ctx.db.insert("campaignRecipients", {
          campaignId,
          email: "stale@example.com",
          status: "failed",
          error: "boom",
          unsubscribeToken: "stale-token",
        });
      });

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        text: async () => "{}",
      })) as unknown as typeof fetch;

      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const recipients = await run(s.t, (ctx) =>
        ctx.db
          .query("campaignRecipients")
          .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
          .collect(),
      );
      expect(recipients.map((r) => r.email)).toEqual(["rey@example.com"]);
      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("sent");
      expect(campaign.recipientCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── sendTest ──────────────────────────────────────────────────────────────

describe("sendTest", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("sends exactly one email with a '[Test] ' subject prefix to the given address", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Big news",
      audienceId,
      doc: heroDoc(),
    });

    let capturedTo: string | undefined;
    let capturedSubject: string | undefined;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      capturedTo = body.to;
      capturedSubject = body.subject;
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as typeof fetch;

    await s.as.action(api.campaigns.sendTest, { campaignId, to: "preview@example.com" });
    expect(capturedTo).toBe("preview@example.com");
    expect(capturedSubject).toBe("[Test] Big news");

    // No campaignRecipients row was ever created by a test send.
    const recipients = await run(s.t, (ctx) =>
      ctx.db
        .query("campaignRecipients")
        .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
        .collect(),
    );
    expect(recipients).toHaveLength(0);
  });

  test("rejects a non-privileged caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const superuser = await asSuperuser(t);
    await configureResend(superuser);
    const audienceId = await seedAudience(superuser);
    const campaignId = await superuser.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
    });
    await expect(
      s.as.action(api.campaigns.sendTest, { campaignId, to: "x@example.com" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

