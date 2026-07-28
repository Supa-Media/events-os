import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import {
  BUILT_IN_CAMPAIGN_TEMPLATES,
  DEFAULT_EMAIL_THEME,
  NEWSLETTER_ASSETS,
  NEWSLETTER_TEMPLATE_SLOTS,
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

// ── Authoring one from scratch (the design-only door) ─────────────────────

/**
 * `createTemplate` — the mutation that makes "designers can create and update
 * templates" true. `createTemplateFromCampaign` starts from a CAMPAIGN, so it
 * needs compose power a design-only Graphic Designer deliberately doesn't
 * hold; without this she could only rename and archive other people's work.
 * (The design-only holder's end-to-end path is asserted in
 * `campaignPower.test.ts`, which has the seat machinery.)
 */
describe("createTemplate", () => {
  test("throws for a non-privileged caller", async () => {
    const t = newT();
    const outsider = await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(
      outsider.as.mutation(api.campaignTemplates.createTemplate, {
        scope: "central",
        name: "Mine",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("an unnamed template is refused", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await expect(
      s.as.mutation(api.campaignTemplates.createTemplate, { scope: "central", name: "   " }),
    ).rejects.toMatchObject({ data: { code: "EMPTY" } });
  });

  test("starts EMPTY, themed with the scope default, and is readable", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "  Blank shell  ",
      description: "  Start here.  ",
    });

    const row = await s.as.query(api.campaignTemplates.getTemplate, { templateId });
    expect(row.name).toBe("Blank shell");
    expect(row.description).toBe("Start here.");
    expect(row.isBuiltIn).toBeUndefined();
    expect(row.doc.blocks).toEqual([]);
    // A template with no theme of its own would be stamped on the way into a
    // campaign; stamping it HERE means the composer's preview is right from
    // the first block rather than after the first send.
    expect(row.doc.theme?.name).toBe(DEFAULT_EMAIL_THEME.name);
  });

  test("a supplied document is validated like any other write", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await expect(
      s.as.mutation(api.campaignTemplates.createTemplate, {
        scope: "central",
        name: "Bad",
        doc: { blocks: [{ id: "b", kind: "button", label: "Go", url: "javascript:alert(1)" }] },
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_DOC" } });
  });

  test("a document that carries its own theme keeps it", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Themed",
      doc: { blocks: [], theme: PUBLIC_WORSHIP_THEME },
    });
    const row = await s.as.query(api.campaignTemplates.getTemplate, { templateId });
    expect(row.doc.theme?.accent).toBe(PUBLIC_WORSHIP_THEME.accent);
  });

  test("a fresh template lands in the library it was made for", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Blank shell",
    });
    const listed = (
      await s.as.query(api.campaignTemplates.listTemplates, { scope: "central" })
    ).filter((row) => row.isBuiltIn !== true);
    expect(listed.map((r) => r.name)).toEqual(["Blank shell"]);
  });
});

// ── Editing the document (the composer's autosave target) ─────────────────

describe("the template composer's write path", () => {
  test("getTemplate throws NOT_FOUND for a missing row and FORBIDDEN for an outsider", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Shell",
    });
    const outsider = await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(
      outsider.as.query(api.campaignTemplates.getTemplate, { templateId }),
    ).rejects.toBeInstanceOf(ConvexError);

    await run(s.t, (ctx) => ctx.db.delete(templateId));
    await expect(
      s.as.query(api.campaignTemplates.getTemplate, { templateId }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("a saved document ROUND-TRIPS its theme", async () => {
    // The composer autosaves `history.present` wholesale. A template has no
    // theme of its own beyond `doc.theme`, so a save that dropped the key
    // would silently un-brand the template — and the campaigns made from it.
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Shell",
    });
    const before = await s.as.query(api.campaignTemplates.getTemplate, { templateId });

    await s.as.mutation(api.campaignTemplates.updateTemplate, {
      templateId,
      doc: {
        ...before.doc,
        blocks: [{ id: "b1", kind: "heading", text: "Hello", level: 1 }],
      },
    });

    const after = await s.as.query(api.campaignTemplates.getTemplate, { templateId });
    expect(after.doc.blocks).toHaveLength(1);
    expect(after.doc.theme?.name).toBe(before.doc.theme?.name);
    expect(after.doc.theme?.accent).toBe(before.doc.theme?.accent);
  });

  test("setTemplateTheme restyles the stored document, and only a designer may", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Shell",
      doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello", level: 1 }] },
    });

    const outsider = await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(
      outsider.as.mutation(api.campaignTemplates.setTemplateTheme, {
        templateId,
        presetName: PUBLIC_WORSHIP_THEME.name,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    await s.as.mutation(api.campaignTemplates.setTemplateTheme, {
      templateId,
      presetName: PUBLIC_WORSHIP_THEME.name,
    });
    const row = await s.as.query(api.campaignTemplates.getTemplate, { templateId });
    expect(row.doc.theme?.accent).toBe(PUBLIC_WORSHIP_THEME.accent);
    // The blocks are untouched — restyling is not a rewrite.
    expect(row.doc.blocks).toHaveLength(1);
  });

  test("setTemplateTheme demands exactly one of a saved theme or a preset", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Shell",
    });
    await expect(
      s.as.mutation(api.campaignTemplates.setTemplateTheme, { templateId }),
    ).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
    await expect(
      s.as.mutation(api.campaignTemplates.setTemplateTheme, {
        templateId,
        presetName: "no such preset",
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("a saved theme from another scope is refused", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Shell",
    });
    const themeId = await run(s.t, (ctx) =>
      ctx.db.insert("emailThemes", {
        ...PUBLIC_WORSHIP_THEME,
        scope: s.chapterId,
        name: "Chapter look",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.campaignTemplates.setTemplateTheme, { templateId, themeId }),
    ).rejects.toMatchObject({ data: { code: "SCOPE_MISMATCH" } });
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

  test("an unchanged re-seed does not touch the row", async () => {
    // The seeder promises it patches ONLY when the shipped content differs.
    // That promise was false: Convex normalizes object key order on write, so
    // the stored document never string-matched the in-memory one and every
    // deploy rewrote the row. The comparison is key-order-insensitive now.
    const t = newT();
    const s = await asSuperuser(t);
    const [templateId] = await t.mutation(
      internal.campaignTemplates.ensureBuiltInTemplates,
      { scope: "central", createdBy: s.userId },
    );
    await run(s.t, (ctx) => ctx.db.patch(templateId, { updatedAt: 1 }));
    await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    expect((await run(s.t, (ctx) => ctx.db.get(templateId)))?.updatedAt).toBe(1);
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
      // The vocabulary the newsletter is ACTUALLY built from. It used to be
      // asserted as eyebrow/columns/quote — the generic stand-ins from before
      // the layout was rebuilt against the real design. The banners now carry
      // the section headings as artwork, and the sections are card variants.
      const kinds = new Set(validated.doc.blocks.map((b) => b.kind));
      expect(kinds.has("bleed_image")).toBe(true);
      expect(kinds.has("card")).toBe(true);
      expect(kinds.has("footer")).toBe(true);

      const variants = new Set(
        validated.doc.blocks
          .filter((b): b is Extract<typeof b, { kind: "card" }> => b.kind === "card")
          .map((b) => b.variant),
      );
      for (const v of ["hero", "feature", "outlined", "testimonial"] as const) {
        expect(variants.has(v)).toBe(true);
      }
      expect(validated.doc.theme?.accent).toBe(PUBLIC_WORSHIP_THEME.accent);

      // No block may name an image URL this deployment doesn't own — the
      // template ships EMPTY slots the image library fills.
      const urls = validated.doc.blocks.flatMap((b) =>
        b.kind === "bleed_image" ? [b.url] : b.kind === "card" ? [b.imageUrl] : [],
      );
      expect(urls.every((u) => !u)).toBe(true);
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

// ── Artwork ───────────────────────────────────────────────────────────────

/**
 * The seam PR #455 (import the artwork, keyed by `sourceKey`) and PR #460
 * (rebuild the template with empty slots) left open: nothing read `sourceKey`
 * to fill a slot, so a completed import produced a template that still
 * rendered blank.
 *
 * The ORDERING is the part that actually broke it — the images land AFTER the
 * template is already seeded, and the seeder compares documents to avoid
 * churning `updatedAt`. If the artwork were resolved after that comparison,
 * every subsequent seed would decide "unchanged" and never fill anything.
 */
describe("seedBuiltInTemplates — artwork from the image library", () => {
  async function fakeStorageId(t: ReturnType<typeof newT>): Promise<Id<"_storage">> {
    return (await run(t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob([new Uint8Array(64)]),
      ),
    )) as Id<"_storage">;
  }

  /** Stand in for what `migrations/0052` writes: one library row per asset. */
  async function importArtwork(
    s: ChapterSetup,
    opts: { alt?: string; only?: string[] } = {},
  ) {
    for (const asset of NEWSLETTER_ASSETS) {
      if (opts.only && !opts.only.includes(asset.sourceKey)) continue;
      const storageId = await fakeStorageId(s.t);
      await run(s.t, (ctx) =>
        ctx.db.insert("emailImages", {
          scope: "central" as const,
          storageId,
          url: `https://files.example.com/${asset.sourceKey}.png`,
          alt: opts.alt ?? "",
          label: asset.label,
          sourceKey: asset.sourceKey,
          createdBy: s.userId,
          createdAt: Date.now(),
        }),
      );
    }
  }

  async function seed(s: ChapterSetup): Promise<Id<"campaignTemplates">> {
    const [id] = await s.t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    return id;
  }

  function slotUrls(doc: { blocks: { id: string; kind: string }[] }) {
    const urls = new Map<string, unknown>();
    for (const slot of NEWSLETTER_TEMPLATE_SLOTS) {
      const block = doc.blocks.find((b) => b.id === slot.blockId) as
        | Record<string, unknown>
        | undefined;
      urls.set(
        slot.sourceKey,
        block?.kind === "bleed_image"
          ? block.url
          : block?.kind === "card"
            ? block.imageUrl
            : block?.kind === "footer"
              ? block.logoUrl
              : undefined,
      );
    }
    return urls;
  }

  test("seeding with the artwork already on file fills every slot", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await importArtwork(s);

    const templateId = await seed(s);
    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    for (const [sourceKey, url] of slotUrls(row!.doc)) {
      expect(url, sourceKey).toBe(`https://files.example.com/${sourceKey}.png`);
    }
  });

  test("with NO images the template seeds empty and a re-seed does not churn updatedAt", async () => {
    const t = newT();
    const s = await asSuperuser(t);

    const templateId = await seed(s);
    const first = await run(s.t, (ctx) => ctx.db.get(templateId));
    for (const [sourceKey, url] of slotUrls(first!.doc)) {
      expect(url, sourceKey).toBeUndefined();
    }

    // A sentinel makes "was it patched?" unambiguous rather than depending on
    // two Date.now() calls landing in different milliseconds.
    await run(s.t, (ctx) => ctx.db.patch(templateId, { updatedAt: 1 }));
    await seed(s);
    expect((await run(s.t, (ctx) => ctx.db.get(templateId)))?.updatedAt).toBe(1);
  });

  test("seed empty → import → re-seed FILLS it (the ordering hazard)", async () => {
    const t = newT();
    const s = await asSuperuser(t);

    // 1. The template is seeded first, with an empty library — the real
    //    sequence, since 0049 runs on deploy and the import is run by hand.
    const templateId = await seed(s);
    expect([...slotUrls((await run(s.t, (ctx) => ctx.db.get(templateId)))!.doc).values()]
      .every((u) => u === undefined)).toBe(true);

    // 2. The artwork arrives.
    await importArtwork(s);

    // 3. The next seed must notice. This is what was broken.
    await seed(s);
    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    for (const [sourceKey, url] of slotUrls(row!.doc)) {
      expect(url, sourceKey).toBe(`https://files.example.com/${sourceKey}.png`);
    }
    expect(validateEmailDocument(row!.doc).ok).toBe(true);
  });

  test("a re-seed once the artwork is in place is a no-op", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await importArtwork(s);
    const templateId = await seed(s);

    await run(s.t, (ctx) => ctx.db.patch(templateId, { updatedAt: 1 }));
    await seed(s);
    expect((await run(s.t, (ctx) => ctx.db.get(templateId)))?.updatedAt).toBe(1);
  });

  test("a partial import fills only what it has — the rest stay empty, not blank strings", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await importArtwork(s, { only: ["masthead", "footer-logo"] });
    const templateId = await seed(s);

    const urls = slotUrls((await run(s.t, (ctx) => ctx.db.get(templateId)))!.doc);
    expect(urls.get("masthead")).toBe("https://files.example.com/masthead.png");
    expect(urls.get("footer-logo")).toBe("https://files.example.com/footer-logo.png");
    expect(urls.get("hero-photo")).toBeUndefined();
    expect(urls.get("banner-support")).toBeUndefined();
  });

  test("alt text comes off the library row, so a human's edit reaches the template", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await importArtwork(s);

    // A human writes the alt text the import deliberately left empty.
    const heroImage = await run(s.t, (ctx) =>
      ctx.db
        .query("emailImages")
        .withIndex("by_scope", (q) => q.eq("scope", "central" as const))
        .collect(),
    ).then((rows) => rows.find((r) => r.sourceKey === "hero-photo")!);
    await s.as.mutation(api.emailImages.updateImage, {
      imageId: heroImage._id,
      alt: "The team on the steps after the June night",
    });

    await seed(s);
    const row = await run(s.t, (ctx) =>
      ctx.db
        .query("campaignTemplates")
        .withIndex("by_scope", (q) => q.eq("scope", "central" as const))
        .collect(),
    ).then((rows) => rows.find((r) => r.isBuiltIn));
    const hero = row!.doc.blocks.find(
      (b: { id: string }) => b.id === "blk_nl-hero",
    ) as { imageAlt?: string };
    expect(hero.imageAlt).toBe("The team on the steps after the June night");
  });

  test("an archived built-in stays archived AND unfilled", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await seed(s);
    await s.as.mutation(api.campaignTemplates.archiveTemplate, { templateId });

    await importArtwork(s);
    await seed(s);

    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    expect(row?.archived).toBe(true);
    // Deliberate: a row someone deleted is never patched again, so it never
    // receives the artwork either.
    for (const [sourceKey, url] of slotUrls(row!.doc)) {
      expect(url, sourceKey).toBeUndefined();
    }
  });

  test("a hand-uploaded image with no sourceKey is never placed", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const storageId = await fakeStorageId(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("emailImages", {
        scope: "central" as const,
        storageId,
        url: "https://files.example.com/someones-snapshot.png",
        alt: "A snapshot",
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const templateId = await seed(s);
    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    expect(JSON.stringify(row!.doc)).not.toContain("someones-snapshot");
  });

  test("artwork is resolved per scope — a chapter's library never leaks into central", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const storageId = await fakeStorageId(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("emailImages", {
        scope: s.chapterId,
        storageId,
        url: "https://files.example.com/chapter-masthead.png",
        alt: "",
        sourceKey: "masthead",
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const templateId = await seed(s);
    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    expect(JSON.stringify(row!.doc)).not.toContain("chapter-masthead");
  });
});
