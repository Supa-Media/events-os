import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * PR 2 of the founder's editor feedback ("Paste HTML", 2026-07-30) —
 * `docFormat: "html"` end to end. Mirrors `campaignsTiptap.test.ts`'s
 * structure/coverage exactly (create → autosave → submit → approve → send,
 * `sendTest`, the postal-address gate, `emailPreview`) for the third format,
 * plus the write-time hazard backstop (`validateEmailHtmlDocument`) that's
 * unique to this format.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

const SAFE_HTML =
  '<table width="600" style="background:#fff"><tr><td style="padding:16px;font-family:Arial"><h1>Hi {firstName}</h1><p>Thanks for being part of this.</p><img src="https://cdn.example.com/rehosted.png" alt="Banner"></td></tr></table>';

async function seedAudience(s: ChapterSetup) {
  return run(s.t, (ctx) =>
    ctx.db.insert("audiences", {
      scope: "central",
      name: "Everyone",
      source: "people",
      filters: {},
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function configureResend(s: ChapterSetup): Promise<void> {
  await s.as.mutation(api.integrationSettings.setResendSettings, {
    apiKey: "re_test_key",
    fromAddress: "Chapter OS <os@publicworship.life>",
  });
  await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
    orgMailingAddress: "Public Worship, 123 Main St, Brooklyn, NY 11201",
  });
}

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, name, userId: s.userId, createdAt: Date.now() }),
  );
}

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
      slug: `test_reviewer_html_${reviewerUserId}`,
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

async function approveCampaignViaFlow(s: ChapterSetup, campaignId: Id<"campaigns">): Promise<void> {
  await seedSelfPerson(s);
  const reviewer = await seedReviewer(s);
  await s.as.mutation(api.campaigns.submitForApproval, {
    campaignId,
    purpose: "Sending the update",
    reviewerPersonId: reviewer.personId,
  });
  await reviewer.as.mutation(api.campaigns.approveCampaign, { campaignId });
}

// ── create / write-gate ──────────────────────────────────────────────────

describe("html-format campaigns — write gate", () => {
  test("createCampaign accepts docFormat: 'html' and stamps it on the row", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pasted newsletter",
      subject: "Hello!",
      audienceId,
      doc: { html: SAFE_HTML },
      docFormat: "html",
    });
    const row = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(row?.docFormat).toBe("html");
    expect((row?.doc as { html: string }).html).toBe(SAFE_HTML);
  });

  test("updateCampaignDoc re-validates against the html gate on every autosave", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pasted newsletter",
      subject: "Hello!",
      audienceId,
      doc: { html: SAFE_HTML },
      docFormat: "html",
    });
    const revised = '<p>Revised paste</p>';
    await s.as.mutation(api.campaigns.updateCampaignDoc, { campaignId, doc: { html: revised } });
    const row = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect((row?.doc as { html: string }).html).toBe(revised);
  });

  test("docFormat is immutable — updateCampaignDoc can't smuggle a different shape in", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pasted newsletter",
      subject: "Hello!",
      audienceId,
      doc: { html: SAFE_HTML },
      docFormat: "html",
    });
    // Handing it a tiptap-shaped doc should fail the html validator (no
    // `html` string field) rather than silently being accepted as tiptap.
    await expect(
      s.as.mutation(api.campaigns.updateCampaignDoc, {
        campaignId,
        doc: { type: "doc", content: [] },
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_DOC" } });
  });

  test("REJECTS hostile html at the write gate even bypassing the import action (createCampaign)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    await expect(
      s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "Hostile",
        subject: "Hello!",
        audienceId,
        doc: { html: "<p>hi</p><script>alert(1)</script>" },
        docFormat: "html",
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_DOC" } });
  });

  test("REJECTS hostile html at the write gate on updateCampaignDoc too", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pasted newsletter",
      subject: "Hello!",
      audienceId,
      doc: { html: SAFE_HTML },
      docFormat: "html",
    });
    await expect(
      s.as.mutation(api.campaigns.updateCampaignDoc, {
        campaignId,
        doc: { html: '<img src=x onerror="alert(1)">' },
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_DOC" } });
    // The prior SAFE content is untouched — a rejected write never partially
    // lands.
    const row = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect((row?.doc as { html: string }).html).toBe(SAFE_HTML);
  });

  test("accepts an empty paste at CREATE time — a fresh row starts empty, same as blocks/tiptap; submit is where empty is blocked (see the send-pipeline describe below)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Blank",
      subject: "Hello!",
      audienceId,
      doc: { html: "" },
      docFormat: "html",
    });
    const row = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(row?.docFormat).toBe("html");
  });
});

// ── create → autosave → submit → approve → send ────────────────────────────

describe("html send pipeline", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("draft → autosave → submit → approve → send to 2 recipients: every recipient gets the SAME pasted body (no merge tags), their own unsubscribe URL, and the postal address; plaintext carries the footer too", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      await run(s.t, (ctx) =>
        Promise.all([
          ctx.db.insert("people", {
            chapterId: s.chapterId,
            name: "Riley Reader",
            email: "riley@example.com",
            status: "active",
            createdAt: Date.now(),
          }),
          ctx.db.insert("people", {
            chapterId: s.chapterId,
            name: "Jamie Writer",
            email: "jamie@example.com",
            status: "active",
            createdAt: Date.now(),
          }),
        ]),
      );
      const audienceId = await seedAudience(s);

      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "Pasted newsletter",
        subject: "Hello!",
        audienceId,
        doc: { html: "<p>placeholder</p>" },
        docFormat: "html",
      });
      expect((await run(s.t, (ctx) => ctx.db.get(campaignId)))?.docFormat).toBe("html");

      // Autosave-shaped update — the "re-paste to change" story.
      await s.as.mutation(api.campaigns.updateCampaignDoc, { campaignId, doc: { html: SAFE_HTML } });

      const sends: { to: string; html: string; text: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const items: Record<string, unknown>[] = init?.body ? JSON.parse(init.body) : [];
        for (const item of items) {
          sends.push({ to: item.to as string, html: item.html as string, text: item.text as string });
        }
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await approveCampaignViaFlow(s, campaignId);
      await s.as.mutation(api.campaigns.send, { campaignId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("sent");
      expect(campaign.recipientCount).toBe(2);
      expect(campaign.sentCount).toBe(2);
      expect(sends).toHaveLength(2);

      const recipients = await run(s.t, (ctx) =>
        ctx.db
          .query("campaignRecipients")
          .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
          .collect(),
      );
      expect(recipients).toHaveLength(2);

      for (const recipient of recipients) {
        const send = sends.find((x) => x.to === recipient.email);
        expect(send).toBeDefined();
        // The pasted content itself — no merge tags to substitute, so the
        // literal "{firstName}" text is untouched (not a real variable in
        // this format).
        expect(send!.html).toContain("Hi {firstName}");
        expect(send!.html).toContain("https://cdn.example.com/rehosted.png");
        // Their own unsubscribe URL (their own token, not anyone else's).
        expect(send!.html).toContain(`/unsubscribe/${recipient.unsubscribeToken}`);
        for (const other of recipients) {
          if (other._id === recipient._id) continue;
          expect(send!.html).not.toContain(other.unsubscribeToken);
        }
        // The org's postal address + compliance signoff.
        expect(send!.html).toContain("123 Main St");
        expect(send!.html).toContain("Sent with love by Public Worship");

        // The plaintext part carries the compliance footer too.
        expect(send!.text).toContain("123 Main St");
        expect(send!.text).toContain("Sent with love by Public Worship");
        expect(send!.text).toContain(`/unsubscribe/${recipient.unsubscribeToken}`);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("sendTest dispatches through the html renderer with the dummy test unsubscribe URL", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pasted newsletter",
      subject: "Hello!",
      audienceId,
      doc: { html: SAFE_HTML },
      docFormat: "html",
    });

    let capturedHtml = "";
    let capturedText = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      capturedHtml = body.html ?? "";
      capturedText = body.text ?? "";
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as typeof fetch;
    try {
      await s.as.action(api.campaigns.sendTest, { campaignId, to: "preview@example.com" });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(capturedHtml).toContain("/unsubscribe/test");
    expect(capturedHtml).toContain("https://cdn.example.com/rehosted.png");
    expect(capturedText.length).toBeGreaterThan(0);
  });

  test("an empty html document is refused at submit, just like an empty blocks/tiptap one", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pasted newsletter",
      subject: "Hello!",
      audienceId,
      doc: { html: SAFE_HTML },
      docFormat: "html",
    });
    // Force the row's doc back to something that fails validation, the same
    // way an earlier row from before validation existed might look (write
    // directly, since `updateCampaignDoc` itself would refuse this).
    await run(s.t, (ctx) => ctx.db.patch(campaignId, { doc: { html: "" } }));
    const reviewer = await seedReviewer(s);
    await expect(
      s.as.mutation(api.campaigns.submitForApproval, {
        campaignId,
        purpose: "x",
        reviewerPersonId: reviewer.personId,
      }),
    ).rejects.toMatchObject({ data: { code: "EMPTY" } });
  });

  test("the postal-address gate blocks an html send at BOTH layers — deliverCampaignBatch halts it before Resend is ever called", async () => {
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
      const audienceId = await seedAudience(s);
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "Pasted newsletter",
        subject: "Hello!",
        audienceId,
        doc: { html: SAFE_HTML },
        docFormat: "html",
      });
      await approveCampaignViaFlow(s, campaignId);

      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await s.as.mutation(api.campaigns.send, { campaignId });
      await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
        orgMailingAddress: null,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("failed");
      expect(campaign.error).toMatch(/postal mailing address/i);
      expect(fetchCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── emailPreview.renderCampaignPreview ──────────────────────────────────────

describe("emailPreview.renderCampaignPreview — html format", () => {
  test("renders a pasted-html campaign's saved doc with a dummy unsubscribe URL and the real org address", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
      orgMailingAddress: "Public Worship, 123 Main St, Brooklyn, NY 11201",
    });
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pasted newsletter",
      subject: "Hello!",
      audienceId,
      doc: { html: SAFE_HTML },
      docFormat: "html",
    });

    const result = await s.as.action(api.emailPreview.renderCampaignPreview, { campaignId });
    expect(result.html).toContain("https://cdn.example.com/rehosted.png");
    expect(result.html).toContain("/unsubscribe/test");
    expect(result.html).toContain("123 Main St");
    expect(result.text.length).toBeGreaterThan(0);
  });

  test("never throws on an unconfigured org — the footer shows fallback text instead", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pasted newsletter",
      subject: "Hello!",
      audienceId,
      doc: { html: SAFE_HTML },
      docFormat: "html",
    });

    const result = await s.as.action(api.emailPreview.renderCampaignPreview, { campaignId });
    expect(result.html).toContain("Profile → Integrations");
  });
});
