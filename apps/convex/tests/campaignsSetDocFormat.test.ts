import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * `campaigns.setDocFormat` — the ONE sanctioned exception to `docFormat`
 * immutability (see the mutation's own doc in `campaigns.ts`). Founder's
 * primary fix for "Paste HTML is unreachable" (PR 2, 2026-07-30): switch an
 * EMPTY draft between the maily editor (`"tiptap"`) and Paste HTML
 * (`"html"`) from inside the composer, instead of only at creation.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
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
): Promise<{ personId: Id<"people">; as: ReturnType<ChapterSetup["t"]["withIdentity"]> }> {
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
      slug: `test_reviewer_setformat_${reviewerUserId}`,
      title: "Test Reviewer",
      chart: "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities: ["email.campaigns.approve"],
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

describe("setDocFormat — the sanctioned immutability exception", () => {
  test("switches an empty tiptap draft to html, resetting doc to { html: \"\" }", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Fresh",
      subject: "Hello!",
      audienceId,
      doc: { type: "doc", content: [] },
      docFormat: "tiptap",
    });
    await s.as.mutation(api.campaigns.setDocFormat, { campaignId, docFormat: "html" });
    const row = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(row?.docFormat).toBe("html");
    expect(row?.doc).toEqual({ html: "" });
  });

  test("switches an empty html draft to tiptap, resetting doc to the standard starter seed", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Fresh paste",
      subject: "Hello!",
      audienceId,
      doc: { html: "" },
      docFormat: "html",
    });
    await s.as.mutation(api.campaigns.setDocFormat, { campaignId, docFormat: "tiptap" });
    const row = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(row?.docFormat).toBe("tiptap");
    expect(row?.doc).toMatchObject({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
        { type: "paragraph", content: [] },
      ],
    });
  });

  test("REJECTS switching a tiptap draft that already has content", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Has content",
      subject: "Hello!",
      audienceId,
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Real content" }] }],
      },
      docFormat: "tiptap",
    });
    await expect(
      s.as.mutation(api.campaigns.setDocFormat, { campaignId, docFormat: "html" }),
    ).rejects.toMatchObject({ data: { code: "NOT_EMPTY" } });
    const row = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(row?.docFormat).toBe("tiptap");
  });

  test("REJECTS switching an html draft that already has content", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Has content",
      subject: "Hello!",
      audienceId,
      doc: { html: "<p>Real content</p>" },
      docFormat: "html",
    });
    await expect(
      s.as.mutation(api.campaigns.setDocFormat, { campaignId, docFormat: "tiptap" }),
    ).rejects.toMatchObject({ data: { code: "NOT_EMPTY" } });
  });

  test("REJECTS once the email has been submitted, even after cancelApprovalRequest returns it to draft", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Once submitted",
      subject: "Hello!",
      audienceId,
      // Real content — `submitForApproval` itself blocks an empty doc, so
      // this has to have something in it to reach `pending_approval` at all.
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hi there" }] }],
      },
      docFormat: "tiptap",
    });
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "Testing",
      reviewerPersonId: reviewer.personId,
    });
    await s.as.mutation(api.campaigns.cancelApprovalRequest, { campaignId });
    // Clear the content back to genuinely empty too — `cancelApprovalRequest`
    // itself clears `submittedAt`, so the row's OWN mutable fields now read
    // exactly like a virgin draft. Only `campaignApprovalLog`'s permanent
    // "submitted" row (never touched by the cancel) should still catch this.
    await s.as.mutation(api.campaigns.updateCampaignDoc, {
      campaignId,
      doc: { type: "doc", content: [] },
    });
    const row = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(row?.status).toBe("draft");
    expect(row?.submittedAt).toBeUndefined();
    await expect(
      s.as.mutation(api.campaigns.setDocFormat, { campaignId, docFormat: "html" }),
    ).rejects.toMatchObject({ data: { code: "NOT_EDITABLE" } });
  });

  test("REJECTS once status isn't draft (pending_approval)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureResend(s);
    const audienceId = await seedAudience(s);
    await seedSelfPerson(s);
    const reviewer = await seedReviewer(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Pending",
      subject: "Hello!",
      audienceId,
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hi there" }] }],
      },
      docFormat: "tiptap",
    });
    await s.as.mutation(api.campaigns.submitForApproval, {
      campaignId,
      purpose: "Testing",
      reviewerPersonId: reviewer.personId,
    });
    await expect(
      s.as.mutation(api.campaigns.setDocFormat, { campaignId, docFormat: "html" }),
    ).rejects.toMatchObject({ data: { code: "NOT_EDITABLE" } });
  });

  test("REJECTS switching to the same format", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Same",
      subject: "Hello!",
      audienceId,
      doc: { type: "doc", content: [] },
      docFormat: "tiptap",
    });
    await expect(
      s.as.mutation(api.campaigns.setDocFormat, { campaignId, docFormat: "tiptap" }),
    ).rejects.toMatchObject({ data: { code: "SAME_FORMAT" } });
  });

  test("REJECTS a caller without compose power", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Guarded",
      subject: "Hello!",
      audienceId,
      doc: { type: "doc", content: [] },
      docFormat: "tiptap",
    });
    const outsiderUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "outsider@publicworship.life" }),
    );
    const outsider = s.t.withIdentity({ subject: `${outsiderUserId}|session`, issuer: "test" });
    await expect(
      outsider.mutation(api.campaigns.setDocFormat, { campaignId, docFormat: "html" }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});
