import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { resolveAudienceRecipients } from "../lib/audienceResolve";

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

// ── Two-party approval helpers ───────────────────────────────────────────────
// `send()` now only accepts `approved`/`failed` (see `campaigns.ts`'s
// state-machine doc) — every pre-existing "create a draft, send it" test
// below needs to actually clear approval first. These three helpers drive
// that through the REAL mutations (not a direct `ctx.db.patch` to
// "approved") so the snapshot-hash binding is exercised honestly.

/** `resolveCampaignCallerPersonId` needs a roster profile for the caller's
 *  own userId — `setupChapter` doesn't seed one (most tests never needed a
 *  personId at all before this feature). Mirrors
 *  `givingPower.test.ts#seedSelfPerson`. */
async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      createdAt: Date.now(),
    }),
  );
}

/** A fresh user + person + an ad-hoc CENTRAL seat carrying `campaigns.approve`
 *  — a distinct identity from `s`'s own, eligible as a reviewer. Returns an
 *  authenticated client for them. */
async function seedReviewer(
  s: ChapterSetup,
  name = "Reviewer",
): Promise<{ personId: Id<"people">; as: ReturnType<TestConvex["withIdentity"]> }> {
  const reviewerUserId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: `${name.toLowerCase().replace(/\s+/g, "")}@publicworship.life` }),
  );
  const reviewerPersonId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: reviewerUserId,
      createdAt: Date.now(),
    }),
  );
  const seatDefId = await run(s.t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug: `test_reviewer_${reviewerUserId}`,
      title: "Test Reviewer",
      chart: "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities: ["campaigns.approve"],
      sortOrder: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: "central",
      personId: reviewerPersonId,
      createdAt: Date.now(),
    }),
  );
  const as = s.t.withIdentity({ subject: `${reviewerUserId}|session`, issuer: "test" });
  return { personId: reviewerPersonId, as };
}

/** Drive a `draft` campaign all the way to `approved` via the real
 *  `submitForApproval`/`approveCampaign` mutations — seeds the caller's own
 *  roster profile + a distinct reviewer, submits, and approves. Requires
 *  Resend already configured (`submitForApproval` validates it, same as
 *  `send`). Returns the reviewer identity for tests that also want to deny /
 *  request changes on the SAME reviewer. */
async function approveCampaignViaFlow(
  s: ChapterSetup,
  campaignId: Id<"campaigns">,
  opts: { purpose?: string } = {},
): Promise<{ personId: Id<"people">; as: ReturnType<TestConvex["withIdentity"]> }> {
  await seedSelfPerson(s);
  const reviewer = await seedReviewer(s);
  await s.as.mutation(api.campaigns.submitForApproval, {
    campaignId,
    purpose: opts.purpose ?? "Sending the update",
    reviewerPersonId: reviewer.personId,
  });
  await reviewer.as.mutation(api.campaigns.approveCampaign, { campaignId });
  return reviewer;
}

// ── Access ────────────────────────────────────────────────────────────────

describe("myCampaignsAccess", () => {
  test("a superuser can view and approve", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canApprove: true,
    });
  });

  test("a non-privileged user cannot view or approve (soft — no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: false,
      canApprove: false,
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

  test("excludes contact-only rows (person-centric audiences Phase 1) — the 'People' source is roster-only", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await run(s.t, async (ctx) => {
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Real Teammate",
        email: "teammate@example.com",
        status: "active",
        createdAt: Date.now(),
      });
      // Auto-created from a donor gift / import / public RSVP — never a real
      // roster member, so "People" (the legacy roster-shaped source) must not
      // silently include them. Phase 3's filter model is the deliberate way
      // to reach contacts later (specs/person-centric-audiences.md).
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Auto-created Contact",
        email: "contact@example.com",
        status: "active",
        isContactOnly: true,
        createdAt: Date.now(),
      });
    });

    const preview = await s.as.query(api.audiences.previewAudience, {
      scope: "central",
      source: "people",
      filters: { chapterId: s.chapterId },
    });
    expect(preview.count).toBe(1);
    expect(preview.sample.map((r) => r.email)).toEqual(["teammate@example.com"]);
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
        // `deliverCampaignBatch` now posts the whole batch as one request —
        // the body is an ARRAY of per-recipient items, Resend's
        // `/emails/batch` shape (see `lib/resend.ts#sendResendEmailBatch`).
        const items: Record<string, unknown>[] = init?.body ? JSON.parse(init.body) : [];
        for (const item of items) {
          sends.push({ to: item.to as string, subject: item.subject as string, body: item });
        }
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await approveCampaignViaFlow(s, campaignId);
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
      // `submitForApproval` ALSO requires Resend configured (it validates
      // everything `send` does) — so approval has to happen WHILE it's
      // connected, then Resend gets disconnected right before the send
      // itself, to isolate this test's actual target: `send`'s OWN
      // independent resend-ready re-check.
      await configureResend(s);
      await approveCampaignViaFlow(s, campaignId);
      await s.as.mutation(api.integrationSettings.setResendSettings, { apiKey: null });

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
      await approveCampaignViaFlow(s, campaignId);
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
      // Approve first (stamps `approvedSnapshotHash` from the CURRENT
      // content/audience — nothing changes after, so a retry's re-check
      // still matches), THEN simulate a prior failed attempt that got as far
      // as materializing one (now-stale) row before failing — only the
      // `status`/`error`/stray-row parts of "a prior failed send" are being
      // simulated here, not a lapsed approval.
      await approveCampaignViaFlow(s, campaignId);
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

  test("one Resend batch request carries every recipient, each with its own distinct unsubscribe URL", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      await run(s.t, async (ctx) => {
        for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
          await ctx.db.insert("people", {
            chapterId: s.chapterId,
            name: email,
            email,
            status: "active",
            createdAt: Date.now(),
          });
        }
      });
      const audienceId = await seedAudience(s, "people");
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
      });
      await approveCampaignViaFlow(s, campaignId);

      let requestCount = 0;
      let lastBatch: Array<{ to: string; headers: Record<string, string> }> = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        requestCount++;
        lastBatch = init?.body ? JSON.parse(init.body) : [];
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      // 3 recipients comfortably fit in one 100-recipient batch — one Resend
      // request for the whole send.
      expect(requestCount).toBe(1);
      expect(lastBatch).toHaveLength(3);
      const unsubscribeLinks = lastBatch.map((item) => item.headers["List-Unsubscribe"]);
      expect(new Set(unsubscribeLinks).size).toBe(3); // every item's token is distinct

      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.sentCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a non-2xx batch response marks every recipient in that batch failed", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      await run(s.t, async (ctx) => {
        for (const email of ["x@example.com", "y@example.com"]) {
          await ctx.db.insert("people", {
            chapterId: s.chapterId,
            name: email,
            email,
            status: "active",
            createdAt: Date.now(),
          });
        }
      });
      const audienceId = await seedAudience(s, "people");
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
      });
      await approveCampaignViaFlow(s, campaignId);

      globalThis.fetch = (async () => ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ message: "invalid recipient in batch" }),
      })) as unknown as typeof fetch;

      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.sentCount).toBe(0);
      expect(campaign.failedCount).toBe(2);
      expect(campaign.status).toBe("failed"); // 0 sent out of 2 processed

      const recipients = await run(s.t, (ctx) =>
        ctx.db
          .query("campaignRecipients")
          .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
          .collect(),
      );
      expect(recipients.every((r) => r.status === "failed")).toBe(true);
      expect(recipients.every((r) => r.error?.includes("422"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Per-campaign sender ("send as a person") ─────────────────────────────────

describe("per-campaign sender", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("createCampaign rejects fromEmail when Resend's from address isn't configured", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    await expect(
      s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
        fromEmail: "aj@publicworship.life",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("createCampaign rejects a fromEmail whose domain doesn't match the org's Resend sender", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s); // fromAddress: "Chapter OS <os@publicworship.life>"
    const audienceId = await seedAudience(s);
    await expect(
      s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: heroDoc(),
        fromEmail: "aj@gmail.com",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("createCampaign accepts a matching-domain fromEmail + fromName; updateCampaignMeta can clear it back to the org default", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
      fromName: "AJ",
      fromEmail: "aj@publicworship.life",
    });
    const created = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(created.fromName).toBe("AJ");
    expect(created.fromEmail).toBe("aj@publicworship.life");

    // null clears both fields back to "use the org default".
    await s.as.mutation(api.campaigns.updateCampaignMeta, {
      campaignId,
      fromName: null,
      fromEmail: null,
    });
    const cleared = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(cleared.fromName).toBeUndefined();
    expect(cleared.fromEmail).toBeUndefined();
  });

  test("updateCampaignMeta rejects a mismatched-domain fromEmail", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
    });
    await expect(
      s.as.mutation(api.campaigns.updateCampaignMeta, {
        campaignId,
        fromEmail: "someone@othersite.org",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("getSenderDefaults surfaces the org's configured from address + domain", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const defaults = await s.as.query(api.campaigns.getSenderDefaults, {});
    expect(defaults.orgFromAddress).toBe("Chapter OS <os@publicworship.life>");
    expect(defaults.orgDomain).toBe("publicworship.life");
  });

  test("delivery uses the per-campaign sender as the From line when set, falling back to the org default otherwise", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Reader",
          email: "reader@example.com",
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
        fromName: "AJ",
        fromEmail: "aj@publicworship.life",
      });
      await approveCampaignViaFlow(s, campaignId);

      let lastBatch: Array<{ from: string }> = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        lastBatch = init?.body ? JSON.parse(init.body) : [];
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(lastBatch).toHaveLength(1);
      expect(lastBatch[0].from).toBe("AJ <aj@publicworship.life>");
    } finally {
      vi.useRealTimers();
    }
  });

  test("sendTest also applies the per-campaign sender override", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
      fromEmail: "aj@publicworship.life", // no fromName — bare email in the From line
    });

    let capturedFrom: string | undefined;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      capturedFrom = body.from;
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as typeof fetch;

    await s.as.action(api.campaigns.sendTest, { campaignId, to: "preview@example.com" });
    expect(capturedFrom).toBe("aj@publicworship.life");
  });
});

// ── Audience cap surfaced (truncation) ───────────────────────────────────────

describe("audience cap surfaced", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("previewAudience reports untruncated for a normal-size audience (below the 5,000 cap)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedAudience(s, "people");
    const preview = await s.as.query(api.audiences.previewAudience, {
      scope: "central",
      source: "people",
      filters: {},
    });
    expect(preview.truncated).toBe(false);
    expect(preview.truncatedCount).toBe(0);
  });

  test("resolveAudienceRecipients reports truncated:true + an exact truncatedCount once matches exceed the cap", async () => {
    // `AUDIENCE_RESOLVE_LIMIT` (5,000) is too large to seed in a test, so this
    // exercises the same cap arithmetic `previewAudience`/`resolveAudienceForSend`
    // both call through, against a small limit passed directly — the
    // resolver's cap logic doesn't care what the number is.
    const t = newT();
    const s = await asSuperuser(t);
    await run(s.t, async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: `Person ${i}`,
          email: `person${i}@example.com`,
          status: "active",
          createdAt: Date.now(),
        });
      }
    });
    const resolution = await run(s.t, (ctx) =>
      resolveAudienceRecipients(ctx, { scope: "central", source: "people", filters: {} }, 3),
    );
    expect(resolution.recipients).toHaveLength(3);
    expect(resolution.truncated).toBe(true);
    expect(resolution.truncatedCount).toBe(2); // 5 matches - 3 cap
  });

  test("setRecipientCount persists audienceTruncated on the campaign row", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedSendingCampaign(s);
    await t.mutation(internal.campaigns.setRecipientCount, {
      campaignId,
      recipientCount: 5000,
      audienceTruncated: true,
    });
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.recipientCount).toBe(5000);
    expect(campaign?.audienceTruncated).toBe(true);
  });

  test("materializeRecipients stores audienceTruncated:false on a normal (under-cap) send", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
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
      await approveCampaignViaFlow(s, campaignId);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        text: async () => "{}",
      })) as unknown as typeof fetch;

      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.audienceTruncated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── applyDeliveryBatch — atomic continuation ─────────────────────────────────
// The delivery loop's crash-safety fix: `applyDeliveryBatch` decides, in the
// SAME mutation that persists a batch's results, whether to schedule the
// next batch or finalize the campaign — never as a separate action-side step
// that a crash could skip.

async function seedSendingCampaign(
  s: ChapterSetup,
  opts: { recipientCount?: number } = {},
): Promise<Id<"campaigns">> {
  const audienceId = await seedAudience(s);
  return await run(s.t, (ctx) =>
    ctx.db.insert("campaigns", {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
      status: "sending",
      recipientCount: opts.recipientCount,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedQueuedRecipient(
  s: ChapterSetup,
  campaignId: Id<"campaigns">,
  email: string,
): Promise<Id<"campaignRecipients">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("campaignRecipients", {
      campaignId,
      email,
      status: "queued",
      unsubscribeToken: `tok-${email}`,
    }),
  );
}

describe("applyDeliveryBatch — atomic continuation", () => {
  test("finalizes the campaign immediately when no queued rows remain — no scheduled hop needed", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedSendingCampaign(s, { recipientCount: 1 });
    const recipientId = await seedQueuedRecipient(s, campaignId, "only@example.com");

    await t.mutation(internal.campaigns.applyDeliveryBatch, {
      campaignId,
      results: [{ recipientId, outcome: "sent" }],
    });

    // Finalized synchronously, inside the same mutation — no need to drain
    // any scheduled function first.
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.status).toBe("sent");
    expect(campaign?.sentAt).toBeDefined();

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });

  test("schedules the next batch atomically when queued rows remain — campaign stays 'sending' until then", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedSendingCampaign(s, { recipientCount: 2 });
    const doneId = await seedQueuedRecipient(s, campaignId, "done@example.com");
    await seedQueuedRecipient(s, campaignId, "still-queued@example.com");

    await t.mutation(internal.campaigns.applyDeliveryBatch, {
      campaignId,
      results: [{ recipientId: doneId, outcome: "sent" }],
    });

    // Not finalized — one row is still "queued".
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.status).toBe("sending");
    expect(campaign?.sentCount).toBe(1);

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("deliverCampaignBatch");
    expect((scheduled[0].args[0] as { campaignId: Id<"campaigns"> }).campaignId).toBe(
      campaignId,
    );
  });
});

// ── sweepStuckSends — the safety-net cron ────────────────────────────────────

const TEN_MINUTES = 10 * 60 * 1000;

describe("sweepStuckSends", () => {
  test("reschedules a stale 'sending' campaign, and leaves a fresh one alone", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const now = Date.now();

    const staleId = await seedSendingCampaign(s, { recipientCount: 1 });
    await run(s.t, (ctx) =>
      ctx.db.patch(staleId, { updatedAt: now - TEN_MINUTES - 1 }),
    );
    const freshId = await seedSendingCampaign(s, { recipientCount: 1 });
    await run(s.t, (ctx) => ctx.db.patch(freshId, { updatedAt: now - 1000 }));

    const rescheduled = await t.mutation(internal.campaigns.sweepStuckSends, {});
    expect(rescheduled).toBe(1);

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("deliverCampaignBatch");
    expect((scheduled[0].args[0] as { campaignId: Id<"campaigns"> }).campaignId).toBe(
      staleId,
    );
  });

  test("reschedules materializeRecipients (not deliverCampaignBatch) when recipientCount never got set", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const staleId = await seedSendingCampaign(s); // recipientCount left unset
    await run(s.t, (ctx) =>
      ctx.db.patch(staleId, { updatedAt: Date.now() - TEN_MINUTES - 1 }),
    );

    const rescheduled = await t.mutation(internal.campaigns.sweepStuckSends, {});
    expect(rescheduled).toBe(1);

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("materializeRecipients");
  });

  test("no-ops when there's nothing stuck", async () => {
    const t = newT();
    const rescheduled = await t.mutation(internal.campaigns.sweepStuckSends, {});
    expect(rescheduled).toBe(0);
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

// ── Two-party approval (founder requirement, 2026-07-24) ─────────────────────

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as ConvexError<{ code?: string }>).data?.code ?? "ConvexError";
  }
  throw new Error("expected a rejection, but the call resolved");
}

/** Draft campaign + audience, ready to submit. */
async function seedDraftCampaign(s: ChapterSetup, name = "N"): Promise<Id<"campaigns">> {
  await configureResend(s);
  const audienceId = await seedAudience(s, "people");
  return s.as.mutation(api.campaigns.createCampaign, {
    scope: "central",
    name,
    subject: "Hi",
    audienceId,
    doc: heroDoc(),
  });
}

describe("two-party approval — happy path", () => {
  test("draft → submit (purpose+reviewer required) → approve (by a different person) → send", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      const campaignId = await seedDraftCampaign(s);
      // A real "people"-source audience member with an email. `seedSelfPerson`/
      // `seedReviewer` below deliberately have NO email (elsewhere in this
      // suite that keeps `sendApprovalTestPair`'s submit-time copies a no-op)
      // — without a real recipient, the audience resolves to ZERO matches and
      // the send finalizes "failed" (zero-recipients is a RECORDED failure,
      // not a thrown error — see `campaigns.ts#materializeRecipients`)
      // instead of "sent", even though approval itself succeeded cleanly.
      await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Reader Rae",
          email: "reader@example.com",
          status: "active",
          createdAt: Date.now(),
        }),
      );
      await seedSelfPerson(s);
      const reviewer = await seedReviewer(s);

      await s.as.mutation(api.campaigns.submitForApproval, {
        campaignId,
        purpose: "Announce the fall retreat",
        reviewerPersonId: reviewer.personId,
      });
      let campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("pending_approval");
      expect(campaign.purpose).toBe("Announce the fall retreat");
      expect(campaign.reviewerPersonId).toBe(reviewer.personId);

      const approvalAsReviewer = await reviewer.as.query(api.campaigns.getCampaignApproval, {
        campaignId,
      });
      expect(approvalAsReviewer.canDecide).toBe(true);
      expect(approvalAsReviewer.isSubmitter).toBe(false);

      await reviewer.as.mutation(api.campaigns.approveCampaign, { campaignId });
      campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("approved");
      expect(campaign.approvedByPersonId).toBe(reviewer.personId);
      expect(campaign.approvedRecipientCount).toBeDefined();

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        text: async () => "{}",
      })) as unknown as typeof fetch;
      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("sent");

      const log = await run(s.t, (ctx) =>
        ctx.db
          .query("campaignApprovalLog")
          .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
          .collect(),
      );
      expect(log.map((l) => l.action)).toEqual(["submitted", "approved"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("submitForApproval requires a non-empty purpose", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    expect(
      await errorCode(
        s.as.mutation(api.campaigns.submitForApproval, {
          campaignId,
          purpose: "   ",
          reviewerPersonId: reviewer.personId,
        }),
      ),
    ).toBe("EMPTY");
  });

  test("draft → sending is no longer possible — send() throws NOT_APPROVED on a plain draft", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    expect(await errorCode(s.as.mutation(api.campaigns.send, { campaignId }))).toBe(
      "NOT_APPROVED",
    );
  });
});

describe("two-party approval — reviewer eligibility & separation of duties", () => {
  test("SOD_VIOLATION when the submitter picks THEMSELVES as reviewer — even the ED", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    // The caller (superuser) IS itself an eligible reviewer once seated as
    // ED — this is the "even the Executive Director" case the founder named
    // verbatim: holding approval power doesn't let you approve your own send.
    const edPersonId = await seedSelfPerson(s, "Executive Director (self)");
    const seatDefId = await run(s.t, (ctx) =>
      ctx.db.insert("seatDefs", {
        slug: "test_ed_self",
        title: "Test ED",
        chart: "central",
        parentSlug: "root",
        maxHolders: 1,
        duties: [],
        capabilities: ["campaigns.approve"],
        sortOrder: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId,
        scope: "central",
        personId: edPersonId,
        createdAt: Date.now(),
      }),
    );

    expect(
      await errorCode(
        s.as.mutation(api.campaigns.submitForApproval, {
          campaignId,
          purpose: "Self-send attempt",
          reviewerPersonId: edPersonId,
        }),
      ),
    ).toBe("SOD_VIOLATION");
  });

  test("SOD_VIOLATION when a single user owns TWO people rows, both holding campaigns.approve, and picks the SECOND as reviewer", async () => {
    // Regression for a bypass found in adversarial review (2026-07-24):
    // `people.userId` has no uniqueness — one human can own several roster
    // rows. `resolveCampaignCallerPersonId` auto-picks ONE of them as
    // submitter; a same-id-only SOD check would then let the caller pass a
    // DIFFERENT one of their OWN rows as reviewer and self-approve. The real
    // guard rejects `reviewerPersonId` outright if it's ANY row the caller
    // controls, not just the one that got auto-picked.
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);

    // Row A — the one `resolveCampaignCallerPersonId` will auto-pick as
    // submitter (first capability-holding row, insertion order).
    const rowAId = await seedSelfPerson(s, "Row A");
    const seatDefA = await run(s.t, (ctx) =>
      ctx.db.insert("seatDefs", {
        slug: "test_dual_a",
        title: "Test Dual A",
        chart: "central",
        parentSlug: "root",
        maxHolders: 1,
        duties: [],
        capabilities: ["campaigns.approve"],
        sortOrder: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: seatDefA,
        scope: "central",
        personId: rowAId,
        createdAt: Date.now(),
      }),
    );

    // Row B — a SECOND people row for the SAME s.userId, also holding
    // campaigns.approve.
    const rowBId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Row B",
        userId: s.userId,
        createdAt: Date.now(),
      }),
    );
    const seatDefB = await run(s.t, (ctx) =>
      ctx.db.insert("seatDefs", {
        slug: "test_dual_b",
        title: "Test Dual B",
        chart: "central",
        parentSlug: "root",
        maxHolders: 1,
        duties: [],
        capabilities: ["campaigns.approve"],
        sortOrder: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: seatDefB,
        scope: "central",
        personId: rowBId,
        createdAt: Date.now(),
      }),
    );

    expect(
      await errorCode(
        s.as.mutation(api.campaigns.submitForApproval, {
          campaignId,
          purpose: "Self-approval laundered through a second row",
          reviewerPersonId: rowBId,
        }),
      ),
    ).toBe("SOD_VIOLATION");
  });

  test("SOD_VIOLATION at DECISION time when the submitter's OWN second people row ends up as the recorded reviewer", async () => {
    // Defense in depth: exercises `assertCallerIsChosenReviewer`'s own
    // independent check, bypassing `submitForApproval`'s guard entirely via
    // a direct db write (a row linked/created AFTER submission, or any other
    // path that could set `reviewerPersonId` outside the normal mutation).
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    const submitterId = await seedSelfPerson(s, "Submitter Row");
    const legitReviewer = await seedReviewer(s);
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P",
      reviewerPersonId: legitReviewer.personId,
    });

    // A SECOND people row for the SAME s.userId (the submitter's own user),
    // holding campaigns.approve — then the campaign's `reviewerPersonId` is
    // force-set to it directly, bypassing `submitForApproval`'s own guard
    // entirely, to isolate the decision-time defense in depth.
    const secondRowId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Submitter's Second Row",
        userId: s.userId,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) => ctx.db.patch(campaignId, { reviewerPersonId: secondRowId }));

    expect(
      await errorCode(s.as.mutation(api.campaigns.approveCampaign, { campaignId })),
    ).toBe("SOD_VIOLATION");
  });

  test("INVALID_REVIEWER — a compose-only holder can't be picked as reviewer", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    await seedSelfPerson(s);
    const composeOnlyUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "composer@publicworship.life" }),
    );
    const composeOnlyPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Compose Only",
        userId: composeOnlyUserId,
        createdAt: Date.now(),
      }),
    );
    const seatDefId = await run(s.t, (ctx) =>
      ctx.db.insert("seatDefs", {
        slug: "test_compose_only",
        title: "Compose Only",
        chart: "central",
        parentSlug: "root",
        maxHolders: 1,
        duties: [],
        capabilities: ["campaigns.compose"],
        sortOrder: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId,
        scope: "central",
        personId: composeOnlyPersonId,
        createdAt: Date.now(),
      }),
    );

    expect(
      await errorCode(
        s.as.mutation(api.campaigns.submitForApproval, {
          campaignId,
          purpose: "Needs an approver",
          reviewerPersonId: composeOnlyPersonId,
        }),
      ),
    ).toBe("INVALID_REVIEWER");
  });

  test("NOT_CHOSEN_REVIEWER — a DIFFERENT approval-power holder can't decide on someone else's pick", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    await seedSelfPerson(s);
    const chosenReviewer = await seedReviewer(s, "Chosen Reviewer");
    const otherReviewer = await seedReviewer(s, "Other Reviewer");

    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P",
      reviewerPersonId: chosenReviewer.personId,
    });

    expect(
      await errorCode(
        otherReviewer.as.mutation(api.campaigns.approveCampaign, { campaignId }),
      ),
    ).toBe("NOT_CHOSEN_REVIEWER");
  });
});

describe("two-party approval — content drift", () => {
  test("editing the audience's filters while pending → approve throws CONTENT_DRIFT", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s, "donors");
    await configureResend(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
    });
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P",
      reviewerPersonId: reviewer.personId,
    });

    // `audiences.updateAudience` is NOT status-locked — this is the gap the
    // hash exists to catch.
    await s.as.mutation(api.audiences.updateAudience, {
      audienceId,
      filters: { donorStatus: "active" },
    });

    expect(
      await errorCode(reviewer.as.mutation(api.campaigns.approveCampaign, { campaignId })),
    ).toBe("CONTENT_DRIFT");
  });

  test("approved, then the audience is edited afterward → send() RECORDS a failure (doesn't throw)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s, "donors");
    await configureResend(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: heroDoc(),
    });
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P",
      reviewerPersonId: reviewer.personId,
    });
    await reviewer.as.mutation(api.campaigns.approveCampaign, { campaignId });

    await s.as.mutation(api.audiences.updateAudience, {
      audienceId,
      filters: { donorStatus: "lapsed" },
    });

    await s.as.mutation(api.campaigns.send, { campaignId });
    const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("failed");
    expect(campaign.error).toMatch(/changed since it was approved/);
  });
});

describe("two-party approval — changes requested & deny", () => {
  test("requestCampaignChanges requires a note, re-enables editing, and resubmitting (a different reviewer) works", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    await seedSelfPerson(s);
    const reviewer1 = await seedReviewer(s, "Reviewer One");
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P",
      reviewerPersonId: reviewer1.personId,
    });

    expect(
      await errorCode(
        reviewer1.as.mutation(api.campaigns.requestCampaignChanges, {
          campaignId,
          note: "",
        }),
      ),
    ).toBe("EMPTY");

    await reviewer1.as.mutation(api.campaigns.requestCampaignChanges, {
      campaignId,
      note: "Fix the subject line",
    });
    let campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("changes_requested");
    expect(campaign.reviewNote).toBe("Fix the subject line");

    // Editing re-enabled.
    await s.as.mutation(api.campaigns.updateCampaignMeta, { campaignId, subject: "Fixed!" });

    // Resubmit with a DIFFERENT reviewer — the whole cycle restarts.
    const reviewer2 = await seedReviewer(s, "Reviewer Two");
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P again",
      reviewerPersonId: reviewer2.personId,
    });
    campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("pending_approval");
    expect(campaign.reviewerPersonId).toBe(reviewer2.personId);

    await reviewer2.as.mutation(api.campaigns.approveCampaign, { campaignId });
    campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("approved");
  });

  test("denyCampaign requires a note and is terminal; revertToDraft restores editability", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P",
      reviewerPersonId: reviewer.personId,
    });

    expect(
      await errorCode(
        reviewer.as.mutation(api.campaigns.denyCampaign, { campaignId, note: "" }),
      ),
    ).toBe("EMPTY");

    await reviewer.as.mutation(api.campaigns.denyCampaign, {
      campaignId,
      note: "Wrong audience entirely",
    });
    let campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("denied");
    expect(campaign.reviewNote).toBe("Wrong audience entirely");

    // Terminal: not editable, not submittable, not sendable.
    await expect(
      s.as.mutation(api.campaigns.updateCampaignMeta, { campaignId, name: "x" }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await errorCode(s.as.mutation(api.campaigns.send, { campaignId }))).toBe(
      "NOT_APPROVED",
    );

    await s.as.mutation(api.campaigns.revertToDraft, { campaignId });
    campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("draft");
    expect(campaign.reviewNote).toBeUndefined();
    expect(campaign.reviewerPersonId).toBeUndefined();
    // Editable again.
    await s.as.mutation(api.campaigns.updateCampaignMeta, { campaignId, name: "Reused" });
  });

  test("cancelApprovalRequest withdraws back to draft without logging a decision", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P",
      reviewerPersonId: reviewer.personId,
    });
    await s.as.mutation(api.campaigns.cancelApprovalRequest, { campaignId });
    const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("draft");
    expect(campaign.reviewerPersonId).toBeUndefined();

    const log = await run(s.t, (ctx) =>
      ctx.db
        .query("campaignApprovalLog")
        .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
        .collect(),
    );
    expect(log.map((l) => l.action)).toEqual(["submitted"]); // no "withdrawn" entry
  });
});

describe("two-party approval — sendTest is ungated by status", () => {
  test("sendTest succeeds even while a campaign is pending_approval", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s);
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "P",
      reviewerPersonId: reviewer.personId,
    });
    const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("pending_approval");

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
    })) as unknown as typeof fetch;
    await expect(
      s.as.action(api.campaigns.sendTest, { campaignId, to: "preview@example.com" }),
    ).resolves.toBeNull();
  });
});

describe("two-party approval — listPendingApprovals soft-gates on approval power", () => {
  // Regression for a crash found in adversarial review (2026-07-24):
  // `listPendingApprovals` used to THROW `FORBIDDEN` for a caller without
  // approval power — unhandled by the mobile strip that calls it
  // unconditionally, crashing the whole Campaigns tab for a compose-only
  // caller (this PR's own new, lower access tier). It must soft-gate
  // instead, mirroring `myCampaignsAccess`'s non-throwing shape.
  test("a compose-only caller gets [] back, not a thrown FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "composer@publicworship.life" });
    const composerId = await seedSelfPerson(s, "Composer");
    const seatDefId = await run(s.t, (ctx) =>
      ctx.db.insert("seatDefs", {
        slug: "test_compose_only_lpa",
        title: "Compose Only",
        chart: "central",
        parentSlug: "root",
        maxHolders: 1,
        duties: [],
        capabilities: ["campaigns.compose"],
        sortOrder: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId,
        scope: "central",
        personId: composerId,
        createdAt: Date.now(),
      }),
    );

    await expect(s.as.query(api.campaigns.listPendingApprovals, {})).resolves.toEqual([]);
  });

  test("a caller with no campaigns access at all also gets [] back (not FORBIDDEN)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(s.as.query(api.campaigns.listPendingApprovals, {})).resolves.toEqual([]);
  });

  test("a chosen reviewer sees their own pending campaign, and only that one", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await seedDraftCampaign(s, "Awaiting me");
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "Reach out",
      reviewerPersonId: reviewer.personId,
    });

    const mine = await reviewer.as.query(api.campaigns.listPendingApprovals, {});
    expect(mine.map((c) => c._id)).toEqual([campaignId]);

    // The submitter (a different identity) sees none pending for THEM.
    const submitterView = await s.as.query(api.campaigns.listPendingApprovals, {});
    expect(submitterView).toEqual([]);
  });
});

describe("two-party approval — legacy rows", () => {
  test("a legacy campaign row with none of the new fields is still readable", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await run(s.t, (ctx) =>
      ctx.db.insert("campaigns", {
        scope: "central",
        name: "Legacy",
        subject: "Old newsletter",
        audienceId,
        doc: heroDoc(),
        status: "sent",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
    expect(campaign.status).toBe("sent");
    expect(campaign.purpose).toBeUndefined();
    expect(campaign.reviewerPersonId).toBeUndefined();
  });
});

describe("two-party approval — notification emails", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("submitting sends a [Test] copy to the submitter and a [For Approval] copy (with a bottom review link) to the reviewer", async () => {
    vi.useFakeTimers();
    // `appUrl()` (`lib/siteUrl.ts`) needs APP_URL to render a real review
    // link — unset in the vitest env by default (no other test in this repo
    // configures it either; grepped for a precedent and found none — the
    // budget-approval email tests deliberately sidestep this by asserting on
    // the resolved CONTEXT data instead of the rendered HTML, but this test's
    // whole point IS the rendered link, so it sets the env itself here).
    const realAppUrl = process.env.APP_URL;
    process.env.APP_URL = "https://app.publicworship.life";
    try {
      const t = newT();
      const s = await asSuperuser(t);
      const campaignId = await seedDraftCampaign(s, "Fall Newsletter");

      // The caller's OWN roster profile, WITH an email —
      // `resolveCampaignCallerPersonId` picks this as the submitter.
      await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Sender Sam",
          email: "sam@publicworship.life",
          userId: s.userId,
          createdAt: Date.now(),
        }),
      );
      const reviewer = await seedReviewer(s, "Reviewer Rae");
      await run(s.t, (ctx) =>
        ctx.db.patch(reviewer.personId, { email: "rae@publicworship.life" }),
      );

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await s.as.mutation(api.campaigns.submitForApproval, {
        campaignId,
        purpose: "Announce it",
        reviewerPersonId: reviewer.personId,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(sent).toHaveLength(2);
      const testCopy = sent.find((item) => item.to === "sam@publicworship.life");
      const reviewCopy = sent.find((item) => item.to === "rae@publicworship.life");
      expect(testCopy?.subject).toBe("[Test] Hi");
      expect(reviewCopy?.subject).toBe("[For Approval] Hi");
      // The proof-of-read block is appended AFTER the real campaign content
      // on the reviewer's copy only — and it must land INSIDE the document
      // (before </body>), never concatenated after the closing </html> (that
      // would be invalid HTML, content outside the document root entirely).
      const reviewHtml = reviewCopy?.html ?? "";
      expect(reviewHtml).toContain("Review this campaign");
      // A real, clickable link — not just the label text — since APP_URL is
      // configured in this test.
      expect(reviewHtml).toMatch(/<a href="https:\/\/app\.publicworship\.life\/campaign\/[^"]+"[^>]*>Review this campaign/);
      // The document's root tag is still the very last thing in the string —
      // nothing was appended past it.
      expect(reviewHtml.trimEnd().endsWith("</html>")).toBe(true);
      // The review block appears BEFORE the closing body/html tags, i.e.
      // genuinely inside the body, not after it.
      const reviewIndex = reviewHtml.indexOf("Review this campaign");
      const bodyCloseIndex = reviewHtml.indexOf("</body>");
      expect(reviewIndex).toBeGreaterThan(-1);
      expect(bodyCloseIndex).toBeGreaterThan(-1);
      expect(reviewIndex).toBeLessThan(bodyCloseIndex);
      expect(testCopy?.html).not.toContain("Review this campaign");
    } finally {
      vi.useRealTimers();
      if (realAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = realAppUrl;
    }
  });

  test("approveCampaign/requestCampaignChanges/denyCampaign each email the submitter back", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Sender Sam",
          email: "sam@publicworship.life",
          userId: s.userId,
          createdAt: Date.now(),
        }),
      );
      const reviewer = await seedReviewer(s);

      const decisionSubjects: string[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (body.to === "sam@publicworship.life") decisionSubjects.push(body.subject as string);
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      const campaignId = await seedDraftCampaign(s, "Approve me");
      await s.as.mutation(api.campaigns.submitForApproval, {
        campaignId,
        purpose: "P",
        reviewerPersonId: reviewer.personId,
      });
      await reviewer.as.mutation(api.campaigns.approveCampaign, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(decisionSubjects.some((s2) => s2.includes("Campaign approved"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

