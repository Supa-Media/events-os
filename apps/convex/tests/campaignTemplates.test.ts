import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import {
  BUILT_IN_CAMPAIGN_TEMPLATES,
  DEFAULT_EMAIL_THEME,
  PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE,
  PUBLIC_WORSHIP_THEME,
  validateEmailDocument,
} from "@events-os/shared";
import { runSeedBuiltInCampaignTemplates } from "../migrations/0049_seed_builtin_campaign_templates";

/**
 * Campaign templates (`campaignTemplates.ts`):
 *  - The round trip a designer actually uses: campaign → template → new
 *    campaign, with the document copied and no live link back.
 *  - `ensureBuiltInTemplates` is idempotent and refreshes in place.
 *  - A template with no theme of its own picks up the scope default on the way
 *    into a campaign, exactly like `createCampaign` does.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

function heroDoc() {
  return {
    blocks: [
      { id: "b1", kind: "heading", text: "Hi {{firstName}}" },
      { id: "b2", kind: "text", markdown: "Thanks for being part of this." },
    ],
  };
}

async function seedAudience(s: ChapterSetup): Promise<Id<"audiences">> {
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

async function seedCampaign(
  s: ChapterSetup,
  doc: unknown = heroDoc(),
): Promise<{ campaignId: Id<"campaigns">; audienceId: Id<"audiences"> }> {
  const audienceId = await seedAudience(s);
  const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
    scope: "central",
    name: "October newsletter",
    subject: "What's on this month",
    audienceId,
    doc,
  });
  return { campaignId, audienceId };
}

// ── Access ────────────────────────────────────────────────────────────────

describe("campaignTemplates access", () => {
  test("listTemplates throws for a non-privileged caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.query(api.campaignTemplates.listTemplates, { scope: "central" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("createTemplateFromCampaign throws for a non-privileged caller", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId } = await seedCampaign(s);
    const outsider = await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(
      outsider.as.mutation(api.campaignTemplates.createTemplateFromCampaign, {
        campaignId,
        name: "Monthly",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── Round trip ────────────────────────────────────────────────────────────

describe("template round-trip", () => {
  test("campaign → template → new campaign copies the document", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, audienceId } = await seedCampaign(s);

    const templateId = await s.as.mutation(
      api.campaignTemplates.createTemplateFromCampaign,
      { campaignId, name: "Monthly newsletter shell", description: "  Start here.  " },
    );
    // Built-ins are seeded opportunistically by `createCampaign`, so filter to
    // author-created rows rather than asserting a bare total.
    const listed = (
      await s.as.query(api.campaignTemplates.listTemplates, { scope: "central" })
    ).filter((row) => row.isBuiltIn !== true);
    expect(listed).toHaveLength(1);
    expect(listed[0]._id).toBe(templateId);
    expect(listed[0].description).toBe("Start here."); // trimmed

    const newCampaignId = await s.as.mutation(
      api.campaignTemplates.createCampaignFromTemplate,
      {
        templateId,
        name: "November newsletter",
        subject: "November",
        audienceId,
      },
    );
    const created = await run(s.t, (ctx) => ctx.db.get(newCampaignId));
    expect(created?.status).toBe("draft");
    expect(created?.name).toBe("November newsletter");
    expect(created?.subject).toBe("November");
    expect(created?.doc.blocks).toHaveLength(2);
    expect(created?.doc.blocks[0].text).toBe("Hi {{firstName}}");

    // The copy is a COPY — editing the template afterwards can't reach it.
    await s.as.mutation(api.campaignTemplates.updateTemplate, {
      templateId,
      doc: { blocks: [{ id: "x", kind: "divider" }] },
    });
    const stillTwo = await run(s.t, (ctx) => ctx.db.get(newCampaignId));
    expect(stillTwo?.doc.blocks).toHaveLength(2);
  });

  test("createCampaignFromTemplate validates its arguments", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, audienceId } = await seedCampaign(s);
    const templateId = await s.as.mutation(
      api.campaignTemplates.createTemplateFromCampaign,
      { campaignId, name: "Shell" },
    );
    await expect(
      s.as.mutation(api.campaignTemplates.createCampaignFromTemplate, {
        templateId,
        name: "   ",
        subject: "Hi",
        audienceId,
      }),
    ).rejects.toMatchObject({ data: { code: "EMPTY" } });
    await expect(
      s.as.mutation(api.campaignTemplates.createCampaignFromTemplate, {
        templateId,
        name: "Ok",
        subject: "  ",
        audienceId,
      }),
    ).rejects.toMatchObject({ data: { code: "EMPTY" } });
  });

  test("updateTemplate rejects an invalid document", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId } = await seedCampaign(s);
    const templateId = await s.as.mutation(
      api.campaignTemplates.createTemplateFromCampaign,
      { campaignId, name: "Shell" },
    );
    await expect(
      s.as.mutation(api.campaignTemplates.updateTemplate, {
        templateId,
        doc: { blocks: [{ id: "b", kind: "button", label: "Go", url: "javascript:alert(1)" }] },
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_DOC" } });
  });

  test("archiveTemplate drops it from the list", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId } = await seedCampaign(s);
    const templateId = await s.as.mutation(
      api.campaignTemplates.createTemplateFromCampaign,
      { campaignId, name: "Shell" },
    );
    await s.as.mutation(api.campaignTemplates.archiveTemplate, { templateId });
    expect(
      (
        await s.as.query(api.campaignTemplates.listTemplates, { scope: "central" })
      ).filter((row) => row.isBuiltIn !== true),
    ).toHaveLength(0);
  });
});

// ── Theme seeding ─────────────────────────────────────────────────────────

describe("createCampaignFromTemplate and themes", () => {
  test("a template with no theme picks up the scope default", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    // A template row written directly, with a themeless document — the shape a
    // pre-theming template (or an import) would have.
    const templateId = await run(s.t, (ctx) =>
      ctx.db.insert("campaignTemplates", {
        scope: "central",
        name: "Bare",
        doc: { blocks: [{ id: "b1", kind: "divider" }] },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const campaignId = await s.as.mutation(
      api.campaignTemplates.createCampaignFromTemplate,
      { templateId, name: "From bare", subject: "Hi", audienceId },
    );
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.doc.theme?.name).toBe(DEFAULT_EMAIL_THEME.name);
  });

  test("a template that carries its own theme keeps it", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const [builtInId] = await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    const campaignId = await s.as.mutation(
      api.campaignTemplates.createCampaignFromTemplate,
      { templateId: builtInId, name: "From newsletter", subject: "Hi", audienceId },
    );
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.doc.theme?.name).toBe(
      PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.doc.theme?.name,
    );
  });
});

// ── Built-ins ─────────────────────────────────────────────────────────────

describe("ensureBuiltInTemplates", () => {
  test("seeds the shipped templates and is idempotent", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const first = await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    const second = await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    expect(first).toEqual(second); // same rows, not new ones

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("campaignTemplates")
        .withIndex("by_scope", (q) => q.eq("scope", "central"))
        .collect(),
    );
    expect(rows).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length);
    const newsletter = rows.find(
      (r) => r.name === PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.name,
    );
    expect(newsletter?.isBuiltIn).toBe(true);
    expect(newsletter?.doc.blocks.length).toBe(
      PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.doc.blocks.length,
    );
    // The shipped template is itself a valid document — worth asserting here
    // since it lands in the table and eventually in an inbox.
    expect(newsletter?.doc.theme).toBeDefined();
  });

  test("refreshes a drifted built-in row in place", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const [templateId] = await t.mutation(
      internal.campaignTemplates.ensureBuiltInTemplates,
      { scope: "central", createdBy: s.userId },
    );
    await run(s.t, (ctx) =>
      ctx.db.patch(templateId, { doc: { blocks: [{ id: "stale", kind: "divider" }] } }),
    );
    await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    expect(row?.doc.blocks.length).toBe(
      PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.doc.blocks.length,
    );
  });

  test("leaves an archived built-in archived — a deletion sticks", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const [templateId] = await t.mutation(
      internal.campaignTemplates.ensureBuiltInTemplates,
      { scope: "central", createdBy: s.userId },
    );
    await s.as.mutation(api.campaignTemplates.archiveTemplate, { templateId });
    await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    expect((await run(s.t, (ctx) => ctx.db.get(templateId)))?.archived).toBe(true);
    expect(
      await s.as.query(api.campaignTemplates.listTemplates, { scope: "central" }),
    ).toHaveLength(0);
  });

  test("seeds per scope independently", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: s.chapterId,
      createdBy: s.userId,
    });
    expect(
      await s.as.query(api.campaignTemplates.listTemplates, { scope: "central" }),
    ).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length);
    expect(
      await s.as.query(api.campaignTemplates.listTemplates, { scope: s.chapterId }),
    ).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length);
  });
});

/**
 * The migration is what makes the seeded newsletter exist in PRODUCTION.
 * `ensureBuiltInTemplates` shipped as an internalMutation with no caller, so
 * every test above passed while a real deployment's template library stayed
 * empty — these cover the wiring, not just the helper.
 */
describe("0049_seed_builtin_campaign_templates", () => {
  test("seeds the monthly newsletter into the central scope", async () => {
    const t = newT();
    const s = await asSuperuser(t);

    const result = await run(s.t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));
    expect(result.seeded).toBe(BUILT_IN_CAMPAIGN_TEMPLATES.length);

    const templates = await s.as.query(api.campaignTemplates.listTemplates, {
      scope: "central",
    });
    const newsletter = templates.find(
      (row) => row.name === PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.name,
    );
    expect(newsletter).toBeDefined();
    expect(newsletter?.isBuiltIn).toBe(true);
    // The seeded document is the real newsletter, not an empty shell.
    const validated = validateEmailDocument(newsletter?.doc);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      const kinds = new Set(validated.doc.blocks.map((b) => b.kind));
      expect(kinds.has("eyebrow")).toBe(true);
      expect(kinds.has("columns")).toBe(true);
      expect(kinds.has("quote")).toBe(true);
      expect(validated.doc.theme?.accent).toBe(PUBLIC_WORSHIP_THEME.accent);
    }
  });

  test("re-running does not duplicate (idempotent on every deploy)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await run(s.t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));
    await run(s.t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));
    expect(
      await s.as.query(api.campaignTemplates.listTemplates, { scope: "central" }),
    ).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length);
  });

  test("an archived built-in stays archived rather than resurrecting on deploy", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await run(s.t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));
    const [row] = await s.as.query(api.campaignTemplates.listTemplates, {
      scope: "central",
    });
    await s.as.mutation(api.campaignTemplates.archiveTemplate, { templateId: row._id });

    await run(s.t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));
    expect(
      await s.as.query(api.campaignTemplates.listTemplates, { scope: "central" }),
    ).toHaveLength(0);
  });

  test("a deployment with no users is a safe no-op (re-runs next deploy)", async () => {
    const t = newT();
    const result = await run(t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe("no users");
  });
});
