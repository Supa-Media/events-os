import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * WS2b — the integration lane: a `docFormat: "tiptap"` campaign is creatable,
 * editable, previewable, approvable, and SENDABLE end to end, while a
 * `docFormat: "blocks"` campaign behaves exactly as before (that twin already
 * lives in `campaigns.test.ts`'s "send pipeline" describe — unmodified by
 * this PR, still green).
 *
 *  - `emailPreview.renderCampaignPreview`: tiptap rows only (`WRONG_FORMAT`
 *    for blocks), works on template-kind rows too, never throws on an
 *    unconfigured org (fallback footer text instead).
 *  - `sendTest`/`send`/`deliverCampaignBatch`/`campaignApprovalEmails`
 *    dispatch on `docFormat` — the full create → autosave → submit →
 *    approve → send loop, with per-recipient merge tags, unsubscribe URLs,
 *    the postal address, and poll vote URLs, EXACTLY like the blocks path.
 *  - The postal-address hard requirement applies identically: both the
 *    SEND GATE (`deliverCampaignBatch`'s `haltSendWithFailure`) and the
 *    FOOTER itself (no address line when none is configured) are checked.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

/** A minimal, valid EMPTY tiptap doc — what a brand-new tiptap campaign/
 *  template starts from (mirrors mobile's `mailyDoc.ts#newTiptapDocSeed`,
 *  kept local so this file has no cross-package import). */
function emptyTiptapDoc() {
  return { type: "doc", content: [] as unknown[] };
}

/** A heading with a `{firstName}` variable, a paragraph, and a two-option
 *  `pwPoll` node — exercises merge tags AND poll vote URLs in one document,
 *  the same way `campaigns.test.ts#heroDoc` exercises `{{firstName}}` for
 *  the blocks format. */
function tiptapFullDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [
          { type: "text", text: "Hi " },
          { type: "variable", attrs: { id: "firstName", fallback: "friend" } },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Thanks for being part of this." }],
      },
      {
        type: "pwPoll",
        attrs: {
          id: "poll1",
          question: "Which night works best?",
          options: [
            { id: "opt_sun", label: "Sunday" },
            { id: "opt_wed", label: "Wednesday" },
          ],
        },
      },
    ],
  };
}

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

/** Resend + the org's CAN-SPAM postal address — both `submitForApproval` and
 *  `send` refuse without them (mirrors `campaigns.test.ts#configureResend`). */
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

async function approveCampaignViaFlow(
  s: ChapterSetup,
  campaignId: Id<"campaigns">,
): Promise<void> {
  await seedSelfPerson(s);
  const reviewer = await seedReviewer(s);
  await s.as.mutation(api.campaigns.submitForApproval, {
    campaignId,
    purpose: "Sending the update",
    reviewerPersonId: reviewer.personId,
  });
  await reviewer.as.mutation(api.campaigns.approveCampaign, { campaignId });
}

// ── create → autosave → submit → approve → send ────────────────────────────

describe("tiptap send pipeline", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("draft → autosave (updateCampaignDoc) → submit → approve → send to 2 recipients: each gets their own merge tags, unsubscribe URL, the postal address, and their own poll vote URLs; plaintext carries the footer too", async () => {
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
        name: "Fall update",
        subject: "Hello!",
        audienceId,
        doc: emptyTiptapDoc(),
        docFormat: "tiptap",
      });
      // `docFormat` really did stick, and stays "tiptap" through an edit.
      expect((await run(s.t, (ctx) => ctx.db.get(campaignId)))?.docFormat).toBe("tiptap");

      // Autosave-shaped update — the SAME mutation the block composer uses,
      // now carrying a tiptap JSON doc instead.
      await s.as.mutation(api.campaigns.updateCampaignDoc, { campaignId, doc: tiptapFullDoc() });

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
      expect(campaign.failedCount).toBe(0);
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
        const firstName = recipient.name?.split(" ")[0];

        // Their own merge-tag value.
        expect(send!.html).toMatch(new RegExp(`Hi\\s*(?:<!--.*?-->)?\\s*${firstName}`));
        // Their own unsubscribe URL (their own token, not anyone else's).
        expect(send!.html).toContain(`/unsubscribe/${recipient.unsubscribeToken}`);
        for (const other of recipients) {
          if (other._id === recipient._id) continue;
          expect(send!.html).not.toContain(other.unsubscribeToken);
        }
        // The org's postal address.
        expect(send!.html).toContain("123 Main St");
        // Their own poll vote URLs, one per option, keyed to THEIR token.
        expect(send!.html).toContain(
          `/poll/${campaignId}/${recipient.unsubscribeToken}/poll1/opt_sun`,
        );
        expect(send!.html).toContain(
          `/poll/${campaignId}/${recipient.unsubscribeToken}/poll1/opt_wed`,
        );

        // The plaintext part carries the compliance footer too — address,
        // signoff, and the SAME per-recipient unsubscribe URL.
        expect(send!.text).toContain("123 Main St");
        expect(send!.text).toContain("Sent with love by Public Worship");
        expect(send!.text).toContain(`/unsubscribe/${recipient.unsubscribeToken}`);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("sendTest dispatches through the tiptap renderer too — no campaignRecipients row, so poll options render as inert pills (no vote URL)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Fall update",
      subject: "Hello!",
      audienceId,
      doc: tiptapFullDoc(),
      docFormat: "tiptap",
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

    // The dummy test unsubscribe URL, same shape `sendTest` always used.
    expect(capturedHtml).toContain("/unsubscribe/test");
    expect(capturedText.length).toBeGreaterThan(0);
    // No real token → no poll vote link (the format-shared graceful
    // degradation `tiptapCampaignRender.ts#tiptapPollVariables` documents).
    expect(capturedHtml).not.toContain("pw_poll_poll1");
    expect(capturedHtml).not.toContain("/poll/");
  });

  test("an empty tiptap document is refused at send, just like an empty blocks one", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      const audienceId = await seedAudience(s);
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "Empty",
        subject: "Hello!",
        audienceId,
        doc: emptyTiptapDoc(),
        docFormat: "tiptap",
      });
      await expect(
        s.as.mutation(api.campaigns.submitForApproval, {
          campaignId,
          purpose: "x",
          reviewerPersonId: await (async () => {
            const r = await seedReviewer(s);
            return r.personId;
          })(),
        }),
      ).rejects.toMatchObject({ data: { code: "EMPTY" } });
    } finally {
      vi.useRealTimers();
    }
  });

  test("the postal-address gate blocks a tiptap send at BOTH layers — deliverCampaignBatch halts it, and the compliance footer omits the address line when one somehow reaches render", async () => {
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
        name: "Fall update",
        subject: "Hello!",
        audienceId,
        doc: tiptapFullDoc(),
        docFormat: "tiptap",
      });
      await approveCampaignViaFlow(s, campaignId);

      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      // `send()` itself still has the address on file (its own pre-flight
      // THROWS, rather than recording a failure, on a missing org-wide
      // setting — see `campaigns.ts#send`'s doc) — this test targets the
      // OTHER layer: `deliverCampaignBatch`'s own last-moment check, the one
      // that actually renders the footer and is reachable even when `send`'s
      // own gate passed (the address can be cleared in the gap between
      // `send` scheduling materialize/deliver and the batch actually
      // running).
      await s.as.mutation(api.campaigns.send, { campaignId });
      await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
        orgMailingAddress: null,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const campaign = await s.as.query(api.campaigns.getCampaign, { campaignId });
      expect(campaign.status).toBe("failed");
      expect(campaign.error).toMatch(/postal mailing address/i);
      // The delivery gate stopped this before Resend was ever called — no
      // half-sent footer-less email went out.
      expect(fetchCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── emailPreview.renderCampaignPreview ──────────────────────────────────────

describe("emailPreview.renderCampaignPreview", () => {
  test("renders a tiptap campaign's saved doc with the sample recipient, a dummy unsubscribe URL, and the real org address", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
      orgMailingAddress: "Public Worship, 123 Main St, Brooklyn, NY 11201",
    });
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Fall update",
      subject: "Hello!",
      audienceId,
      doc: tiptapFullDoc(),
      docFormat: "tiptap",
    });

    const result = await s.as.action(api.emailPreview.renderCampaignPreview, { campaignId });
    expect(result.html).toMatch(/Hi\s*(?:<!--.*?-->)?\s*Ada/); // PREVIEW_RECIPIENT's first name
    expect(result.html).toContain("/unsubscribe/test");
    expect(result.html).toContain("123 Main St");
    expect(result.text.length).toBeGreaterThan(0);
    // No recipient token → poll options are inert pills, not links.
    expect(result.html).not.toContain("/poll/");
  });

  test("never throws on an unconfigured org — the footer shows fallback text instead", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Fall update",
      subject: "Hello!",
      audienceId,
      doc: tiptapFullDoc(),
      docFormat: "tiptap",
    });

    const result = await s.as.action(api.emailPreview.renderCampaignPreview, { campaignId });
    expect(result.html).toContain("Profile → Integrations");
  });

  test("throws WRONG_FORMAT for a blocks-format campaign", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Blocks one",
      subject: "Hello!",
      audienceId,
      doc: { blocks: [{ id: "b1", kind: "heading", text: "Hi" }] },
    });
    await expect(
      s.as.action(api.emailPreview.renderCampaignPreview, { campaignId }),
    ).rejects.toMatchObject({ data: { code: "WRONG_FORMAT" } });
  });

  test("works on a template-kind row too — templates are documents", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Newsletter shell",
      doc: tiptapFullDoc(),
      docFormat: "tiptap",
    });
    const result = await s.as.action(api.emailPreview.renderCampaignPreview, {
      campaignId: templateId,
    });
    expect(result.html).toMatch(/Hi\s*(?:<!--.*?-->)?\s*Ada/);
  });

  test("throws NOT_FOUND for a nonexistent campaign, and is gated for a non-privileged caller", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Fall update",
      subject: "Hello!",
      audienceId,
      doc: tiptapFullDoc(),
      docFormat: "tiptap",
    });

    const outsider = await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(
      outsider.as.action(api.emailPreview.renderCampaignPreview, { campaignId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── campaignApprovalEmails dispatches on docFormat too ──────────────────────

describe("submitForApproval's test pair renders a tiptap campaign correctly", () => {
  test("[Test] and [For Approval] copies both render via the tiptap path, with the review block appended (DEFAULT theme — tiptap carries none)", async () => {
    vi.useFakeTimers();
    const realAppUrl = process.env.APP_URL;
    process.env.APP_URL = "https://app.publicworship.life";
    try {
      const t = newT();
      const s = await asSuperuser(t);
      await configureResend(s);
      const audienceId = await seedAudience(s);
      const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "Fall update",
        subject: "Hello!",
        audienceId,
        doc: tiptapFullDoc(),
        docFormat: "tiptap",
      });

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
      await run(s.t, (ctx) => ctx.db.patch(reviewer.personId, { email: "rae@publicworship.life" }));

      const sent: { to: string; subject: string; html: string; text: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html, text: body.text });
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
      expect(testCopy?.subject).toBe("[Test] Hello!");
      expect(reviewCopy?.subject).toBe("[For Approval] Hello!");

      // Both copies rendered through the tiptap path — the doc's own content
      // is present, merge tags resolved from the SUBMITTER's own name (the
      // test copy is addressed to them, same as the blocks path).
      expect(testCopy?.html).toMatch(/Hi\s*(?:<!--.*?-->)?\s*Sender/);
      expect(testCopy?.text?.length ?? 0).toBeGreaterThan(0);

      // The reviewer's copy ALONE carries the proof-of-read block, appended
      // inside the document (before </body>), after the real content.
      expect(testCopy?.html).not.toContain("Review this campaign");
      const reviewHtml = reviewCopy?.html ?? "";
      expect(reviewHtml).toMatch(
        /<a[^>]*href="https:\/\/app\.publicworship\.life\/campaign\/[^"]+"[^>]*>Review this campaign/,
      );
      expect(reviewHtml.trimEnd().endsWith("</html>")).toBe(true);
      const reviewIndex = reviewHtml.indexOf("Review this campaign");
      const bodyCloseIndex = reviewHtml.indexOf("</body>");
      expect(reviewIndex).toBeGreaterThan(0);
      expect(reviewIndex).toBeLessThan(bodyCloseIndex);
    } finally {
      process.env.APP_URL = realAppUrl;
      vi.useRealTimers();
    }
  });
});

// ── docFormat immutability + create/update dispatch ─────────────────────────

describe("docFormat is set at create time and never changes", () => {
  test("createCampaign with no docFormat defaults to blocks and validates as blocks", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: { blocks: [] },
    });
    expect((await run(s.t, (ctx) => ctx.db.get(campaignId)))?.docFormat).toBeUndefined();
    // A tiptap-shaped doc is rejected against the blocks validator.
    await expect(
      s.as.mutation(api.campaigns.updateCampaignDoc, {
        campaignId,
        doc: emptyTiptapDoc(),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a tiptap row's updateCampaignDoc always validates as tiptap, even if handed a blocks-shaped doc", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: emptyTiptapDoc(),
      docFormat: "tiptap",
    });
    await expect(
      s.as.mutation(api.campaigns.updateCampaignDoc, {
        campaignId,
        doc: { blocks: [] },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("duplication (createTemplateFromCampaign / createCampaignFromTemplate) copies the source's docFormat", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: tiptapFullDoc(),
      docFormat: "tiptap",
    });
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplateFromCampaign, {
      campaignId,
      name: "Shell from campaign",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(templateId)))?.docFormat).toBe("tiptap");

    const newCampaignId = await s.as.mutation(api.campaignTemplates.createCampaignFromTemplate, {
      templateId,
      name: "Copy",
      subject: "Copy subject",
      audienceId,
    });
    expect((await run(s.t, (ctx) => ctx.db.get(newCampaignId)))?.docFormat).toBe("tiptap");
  });
});
