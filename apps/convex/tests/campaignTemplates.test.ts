import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import {
  BUILT_IN_CAMPAIGN_TEMPLATES,
  DEFAULT_EMAIL_THEME,
  NEWSLETTER_ASSETS,
  PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE,
  PUBLIC_WORSHIP_NEWSLETTER_TIPTAP,
  PUBLIC_WORSHIP_THEME,
  TIPTAP_NEWSLETTER_ARTWORK_SLOTS,
  validateTiptapEmailDoc,
  type NewsletterTiptapDoc,
  type NewsletterTiptapNode,
} from "@events-os/shared";
import { runSeedBuiltInCampaignTemplates } from "../migrations/0049_seed_builtin_campaign_templates";
import { runUpgradeBuiltInNewsletterTiptap } from "../migrations/0056_upgrade_builtin_newsletter_tiptap";

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

/** Depth-first walk of a tiptap doc's node tree, visiting every node
 *  (including the top-level ones) exactly once — the test-side twin of
 *  `tiptapNewsletterTemplate.ts#fillNode`'s own recursion, used here to
 *  inspect rather than mutate. */
function walkTiptapNodes(
  doc: NewsletterTiptapDoc,
  visit: (node: NewsletterTiptapNode) => void,
): void {
  function walk(node: NewsletterTiptapNode): void {
    visit(node);
    for (const child of node.content ?? []) walk(child);
  }
  for (const node of doc.content) walk(node);
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

  // Themes freeze (2026-07-29, `docs/plans/maily-editor-overhaul.md`'s
  // "Themes freeze") — `setTemplateTheme` throws `THEMES_RETIRED` for every
  // row, unconditionally, before it would ever reach a preset/scope check.
  // See `emailThemes.ts#throwThemesRetired`'s doc.
  test("setTemplateTheme is retired — THEMES_RETIRED for every caller who could design, FORBIDDEN for one who can't", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Shell",
      doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello", level: 1 }] },
    });
    const before = await s.as.query(api.campaignTemplates.getTemplate, { templateId });

    const outsider = await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(
      outsider.as.mutation(api.campaignTemplates.setTemplateTheme, {
        templateId,
        presetName: PUBLIC_WORSHIP_THEME.name,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    await expect(
      s.as.mutation(api.campaignTemplates.setTemplateTheme, {
        templateId,
        presetName: PUBLIC_WORSHIP_THEME.name,
      }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });
    const row = await s.as.query(api.campaignTemplates.getTemplate, { templateId });
    // Nothing changed — the blocks AND the theme are untouched.
    expect(row.doc.blocks).toHaveLength(1);
    expect(row.doc.theme?.name).toBe(before.doc.theme?.name);
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
      ctx.db.insert("campaigns", {
        scope: "central",
        name: "Bare",
        subject: "",
        doc: { blocks: [{ id: "b1", kind: "divider" }] },
        kind: "template",
        status: "draft",
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

  test("the tiptap built-in copies verbatim — a tiptap document is never theme-stamped", async () => {
    // The built-in "Monthly newsletter" ships as the tiptap document
    // (`PUBLIC_WORSHIP_NEWSLETTER_TIPTAP`) since the WS4 seeding-path upgrade.
    // Unlike a blocks-format template, a tiptap doc carries no `theme` at all
    // — its own doc-level `attrs.pwCanvasColor` is the analogous "did this
    // survive the copy untouched" signal.
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
    expect(campaign?.docFormat).toBe("tiptap");
    expect((campaign?.doc as NewsletterTiptapDoc).attrs?.pwCanvasColor).toBe(
      PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.attrs?.pwCanvasColor,
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
        .query("campaigns")
        .withIndex("by_scope_kind", (q) => q.eq("scope", "central").eq("kind", "template"))
        .collect(),
    );
    expect(rows).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length);
    const newsletter = rows.find(
      (r) => r.name === PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.name,
    );
    expect(newsletter?.isBuiltIn).toBe(true);
    // The built-in ships as the tiptap document since the WS4 seeding-path
    // upgrade — see `lib/builtInTemplates.ts`'s module doc.
    expect(newsletter?.docFormat).toBe("tiptap");
    expect((newsletter?.doc as NewsletterTiptapDoc).content.length).toBe(
      PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content.length,
    );
    // The shipped template is itself a valid document — worth asserting here
    // since it lands in the table and eventually in an inbox.
    expect(validateTiptapEmailDoc(newsletter?.doc).ok).toBe(true);
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
      ctx.db.patch(templateId, { doc: { type: "doc", content: [{ type: "horizontalRule" }] } }),
    );
    await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    expect((row?.doc as NewsletterTiptapDoc).content.length).toBe(
      PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content.length,
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
    // The seeded document is the real newsletter, TIPTAP-format since the
    // WS4 seeding-path upgrade — no longer the legacy blocks document.
    expect(newsletter?.docFormat).toBe("tiptap");
    const validated = validateTiptapEmailDoc(newsletter?.doc);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      const nodeTypes = new Set<string>();
      const srcs: unknown[] = [];
      walkTiptapNodes(newsletter?.doc as NewsletterTiptapDoc, (node) => {
        nodeTypes.add(node.type);
        if (node.type === "image" || node.type === "pwBleedImage") {
          srcs.push(node.attrs?.src);
        }
      });
      // The vocabulary the newsletter is ACTUALLY built from — the tiptap
      // twin of the blocks vocabulary this test used to assert
      // (bleed_image/card/footer → pwBleedImage/section/footer).
      expect(nodeTypes.has("pwBleedImage")).toBe(true);
      expect(nodeTypes.has("section")).toBe(true);
      expect(nodeTypes.has("footer")).toBe(true);
      expect(nodeTypes.has("pwHeading")).toBe(true);
      expect(nodeTypes.has("button")).toBe(true);

      // No node may name an image URL this deployment doesn't own — the
      // template ships EMPTY slots the image library fills.
      expect(srcs.every((u) => !u)).toBe(true);
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

/**
 * The seeding path's blocks → tiptap upgrade (WS4 acceptance artefact). A
 * production deployment's built-in "Monthly newsletter" row was written by
 * the OLD `seedBuiltInTemplates` body — a blocks-format doc, `docFormat`
 * absent — before this release. These pin what happens the first time the
 * NEW body (this same change) sees that row: an in-place upgrade, exactly
 * once, never a duplicate row, and never applied to a row a human archived.
 */
describe("built-in newsletter: blocks → tiptap upgrade", () => {
  /** What a pre-upgrade deployment's built-in row looks like — written
   *  directly, standing in for what the OLD seeder body would have left
   *  behind (or what migration 0049 wrote before this release). */
  async function seedLegacyBlocksBuiltIn(
    s: ChapterSetup,
    opts: { archived?: boolean } = {},
  ): Promise<Id<"campaigns">> {
    const now = Date.now();
    return run(s.t, (ctx) =>
      ctx.db.insert("campaigns", {
        scope: "central",
        name: PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.name,
        description: PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.description,
        doc: PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.doc,
        // Absent — every row the old seeder ever wrote.
        docFormat: undefined,
        kind: "template",
        status: "draft",
        subject: "",
        isBuiltIn: true,
        archived: opts.archived,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  test("upgrades an existing blocks-format built-in row to tiptap IN PLACE, exactly once", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const legacyId = await seedLegacyBlocksBuiltIn(s);
    const before = await run(s.t, (ctx) => ctx.db.get(legacyId));

    await run(s.t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));

    const upgraded = await run(s.t, (ctx) => ctx.db.get(legacyId));
    // Patched IN PLACE — same row id, not a new one alongside it.
    expect(upgraded?._id).toBe(legacyId);
    expect(upgraded?.docFormat).toBe("tiptap");
    expect((upgraded?.doc as NewsletterTiptapDoc).content.length).toBe(
      PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content.length,
    );
    expect(upgraded?.updatedAt).not.toBe(before?.updatedAt);

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("campaigns")
        .withIndex("by_scope_kind", (q) => q.eq("scope", "central").eq("kind", "template"))
        .collect(),
    );
    expect(rows).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length); // no duplicate

    // "Exactly once": a sentinel makes a second patch unambiguous — the flip
    // already happened, so the ordinary no-churn diff takes back over.
    await run(s.t, (ctx) => ctx.db.patch(legacyId, { updatedAt: 1 }));
    await run(s.t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));
    expect((await run(s.t, (ctx) => ctx.db.get(legacyId)))?.updatedAt).toBe(1);
  });

  test("an archived blocks-format built-in stays archived and is never upgraded", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const legacyId = await seedLegacyBlocksBuiltIn(s, { archived: true });
    const before = await run(s.t, (ctx) => ctx.db.get(legacyId));

    await run(s.t, (ctx) => runSeedBuiltInCampaignTemplates(ctx));

    const row = await run(s.t, (ctx) => ctx.db.get(legacyId));
    expect(row?.archived).toBe(true);
    // Untouched, not just "still archived" — an archived row is never
    // patched again at all, so it keeps its legacy blocks doc forever.
    expect(row?.docFormat).toBeUndefined();
    expect(row?.updatedAt).toBe(before?.updatedAt);
    expect((row?.doc as { blocks?: unknown[] }).blocks).toBeDefined();
  });
});

/**
 * The DEPLOY-TIME wiring for the upgrade above — same relationship 0049's own
 * "the migration is what makes it exist in PRODUCTION" tests have to
 * `ensureBuiltInTemplates`. Shares its body with `runSeedBuiltInCampaignTemplates`
 * (see that migration's doc for why a NEW registered migration was needed at
 * all, given 0049 already ran and is ledgered), so this just proves the
 * wiring, not the upgrade mechanics themselves (pinned above).
 */
describe("0056_upgrade_builtin_newsletter_tiptap", () => {
  test("upgrades an existing blocks-format built-in the same way 0049's seeder does", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const now = Date.now();
    const legacyId = await run(s.t, (ctx) =>
      ctx.db.insert("campaigns", {
        scope: "central",
        name: PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.name,
        description: PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.description,
        doc: PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.doc,
        kind: "template",
        status: "draft",
        subject: "",
        isBuiltIn: true,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const result = await run(s.t, (ctx) => runUpgradeBuiltInNewsletterTiptap(ctx));
    expect(result.seeded).toBe(BUILT_IN_CAMPAIGN_TEMPLATES.length);

    const row = await run(s.t, (ctx) => ctx.db.get(legacyId));
    expect(row?.docFormat).toBe("tiptap");
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

  async function seed(s: ChapterSetup): Promise<Id<"campaigns">> {
    const [id] = await s.t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    return id;
  }

  /** The tiptap twin of the blocks-format helper this replaced: walks the
   *  doc's node tree for every `pwSlot`-tagged node and reads its `src`. An
   *  unfilled slot's node ships `src: ""` (never absent — see
   *  `tiptapNewsletterTemplate.ts`'s `cardImage`/`bleedBanner`), unlike the
   *  blocks format's `undefined` for the same case. */
  function slotUrls(doc: NewsletterTiptapDoc) {
    const sourceKeyByPwSlot = new Map(
      TIPTAP_NEWSLETTER_ARTWORK_SLOTS.map((slot) => [slot.pwSlot, slot.sourceKey]),
    );
    const urls = new Map<string, unknown>();
    for (const slot of TIPTAP_NEWSLETTER_ARTWORK_SLOTS) urls.set(slot.sourceKey, "");
    walkTiptapNodes(doc, (node) => {
      const pwSlot = typeof node.attrs?.pwSlot === "string" ? node.attrs.pwSlot : undefined;
      const sourceKey = pwSlot ? sourceKeyByPwSlot.get(pwSlot) : undefined;
      if (sourceKey) urls.set(sourceKey, node.attrs?.src);
    });
    return urls;
  }

  test("seeding with the artwork already on file fills every slot", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await importArtwork(s);

    const templateId = await seed(s);
    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    for (const [sourceKey, url] of slotUrls(row!.doc as NewsletterTiptapDoc)) {
      expect(url, sourceKey).toBe(`https://files.example.com/${sourceKey}.png`);
    }
  });

  test("with NO images the template seeds empty and a re-seed does not churn updatedAt", async () => {
    const t = newT();
    const s = await asSuperuser(t);

    const templateId = await seed(s);
    const first = await run(s.t, (ctx) => ctx.db.get(templateId));
    for (const [sourceKey, url] of slotUrls(first!.doc as NewsletterTiptapDoc)) {
      // Empty, not absent — every artwork node ships `src: ""` in the
      // shipped tiptap document (unlike the blocks format's undefined).
      expect(url, sourceKey).toBe("");
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
    expect([
      ...slotUrls((await run(s.t, (ctx) => ctx.db.get(templateId)))!.doc as NewsletterTiptapDoc).values(),
    ].every((u) => u === "")).toBe(true);

    // 2. The artwork arrives.
    await importArtwork(s);

    // 3. The next seed must notice. This is what was broken.
    await seed(s);
    const row = await run(s.t, (ctx) => ctx.db.get(templateId));
    for (const [sourceKey, url] of slotUrls(row!.doc as NewsletterTiptapDoc)) {
      expect(url, sourceKey).toBe(`https://files.example.com/${sourceKey}.png`);
    }
    expect(validateTiptapEmailDoc(row!.doc).ok).toBe(true);
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

    const urls = slotUrls((await run(s.t, (ctx) => ctx.db.get(templateId)))!.doc as NewsletterTiptapDoc);
    expect(urls.get("masthead")).toBe("https://files.example.com/masthead.png");
    expect(urls.get("footer-logo")).toBe("https://files.example.com/footer-logo.png");
    // Empty, not absent — see `slotUrls`'s own doc.
    expect(urls.get("hero-photo")).toBe("");
    expect(urls.get("banner-support")).toBe("");
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
        .query("campaigns")
        .withIndex("by_scope_kind", (q) => q.eq("scope", "central" as const).eq("kind", "template"))
        .collect(),
    ).then((rows) => rows.find((r) => r.isBuiltIn));
    let heroAlt: unknown;
    walkTiptapNodes(row!.doc as NewsletterTiptapDoc, (node) => {
      if (node.attrs?.pwSlot === "nl-hero") heroAlt = node.attrs?.alt;
    });
    expect(heroAlt).toBe("The team on the steps after the June night");
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
    for (const [sourceKey, url] of slotUrls(row!.doc as NewsletterTiptapDoc)) {
      expect(url, sourceKey).toBe("");
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
