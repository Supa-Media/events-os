import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import {
  DEFAULT_EMAIL_THEME,
  EMAIL_THEME_PRESETS,
  PUBLIC_WORSHIP_THEME,
} from "@events-os/shared";

/**
 * Saved email themes (`emailThemes.ts`):
 *  - `listThemes` merges the org's rows with the code-shipped presets.
 *  - The `validateEmailTheme` write gate actually rejects bad input.
 *  - "At most one default per scope" holds across `setDefaultTheme` calls, and
 *    `archiveTheme` refuses to break it.
 *  - `duplicateTheme` is the preset → editable-row path the designer uses.
 *  - `createCampaign` stamps the scope's default theme into the document.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

/** A complete, valid token set — the shape `createTheme` demands. */
function themeArgs(overrides: Record<string, unknown> = {}) {
  return {
    scope: "central" as const,
    name: "Advent",
    accent: "#1f4a63",
    accentInk: "#ffffff",
    ink: "#0e1c24",
    muted: "#4e6672",
    canvas: "#f4f9fc",
    surface: "#ffffff",
    border: "#d3e2ea",
    link: "#1f4a63",
    headingFont: "Georgia,serif",
    bodyFont: "Inter,Arial,sans-serif",
    radius: 12,
    wordmark: "PUBLIC WORSHIP",
    ...overrides,
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

// ── Access ────────────────────────────────────────────────────────────────

describe("emailThemes access", () => {
  test("listThemes throws for a non-privileged caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.query(api.emailThemes.listThemes, { scope: "central" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("createTheme throws for a non-privileged caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.emailThemes.createTheme, themeArgs()),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── Listing ───────────────────────────────────────────────────────────────

describe("listThemes", () => {
  test("returns the built-in presets even with no saved rows", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themes = await s.as.query(api.emailThemes.listThemes, { scope: "central" });
    expect(themes).toHaveLength(EMAIL_THEME_PRESETS.length);
    expect(themes.every((x) => x.isPreset)).toBe(true);
    // A preset is code, not a row — it has no id to edit.
    expect(themes.every((x) => x.themeId === null)).toBe(true);
    const pw = themes.find((x) => x.name === PUBLIC_WORSHIP_THEME.name);
    expect(pw?.accent).toBe(PUBLIC_WORSHIP_THEME.accent);
  });

  test("saved rows come first, presets after, and carry contrast warnings", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    const themes = await s.as.query(api.emailThemes.listThemes, { scope: "central" });

    expect(themes).toHaveLength(EMAIL_THEME_PRESETS.length + 1);
    expect(themes[0].themeId).toBe(themeId);
    expect(themes[0].isPreset).toBe(false);
    expect(themes[0].name).toBe("Advent");
    expect(themes.slice(1).every((x) => x.isPreset)).toBe(true);
    // Advisory only — the theme above saved fine either way.
    expect(Array.isArray(themes[0].contrastWarnings)).toBe(true);
  });

  test("a theme saved under one scope isn't listed under another", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    const chapterThemes = await s.as.query(api.emailThemes.listThemes, {
      scope: s.chapterId,
    });
    expect(chapterThemes.every((x) => x.isPreset)).toBe(true);
  });
});

// ── CRUD + validation ─────────────────────────────────────────────────────

describe("theme CRUD", () => {
  test("create → update → archive round-trip", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());

    await s.as.mutation(api.emailThemes.updateTheme, {
      themeId,
      name: "Advent (warmer)",
      accent: "#891d1a",
    });
    let saved = (await s.as.query(api.emailThemes.listThemes, { scope: "central" })).find(
      (x) => x.themeId === themeId,
    );
    expect(saved?.name).toBe("Advent (warmer)");
    expect(saved?.accent).toBe("#891d1a");
    // Untouched fields survive the partial update.
    expect(saved?.canvas).toBe("#f4f9fc");
    expect(saved?.radius).toBe(12);

    await s.as.mutation(api.emailThemes.archiveTheme, { themeId });
    saved = (await s.as.query(api.emailThemes.listThemes, { scope: "central" })).find(
      (x) => x.themeId === themeId,
    );
    expect(saved).toBeUndefined();
  });

  test("createTheme rejects a malformed hex colour with INVALID_THEME", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await expect(
      s.as.mutation(api.emailThemes.createTheme, themeArgs({ accent: "maroon" })),
    ).rejects.toMatchObject({ data: { code: "INVALID_THEME" } });
    const themes = await s.as.query(api.emailThemes.listThemes, { scope: "central" });
    expect(themes.every((x) => x.isPreset)).toBe(true); // nothing was written
  });

  test("createTheme rejects a font stack that could break out of the declaration", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await expect(
      s.as.mutation(
        api.emailThemes.createTheme,
        themeArgs({ bodyFont: "Inter;}body{display:none" }),
      ),
    ).rejects.toMatchObject({ data: { code: "INVALID_THEME" } });
  });

  test("updateTheme validates the MERGED token set, not just the changed field", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    await expect(
      s.as.mutation(api.emailThemes.updateTheme, { themeId, ink: "#nothex" }),
    ).rejects.toMatchObject({ data: { code: "INVALID_THEME" } });
    // The stored row is untouched by the rejected write.
    const row = await run(s.t, (ctx) => ctx.db.get(themeId));
    expect(row?.ink).toBe("#0e1c24");
  });

  test("dark overrides round-trip, and `dark: null` clears them", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themeId = await s.as.mutation(
      api.emailThemes.createTheme,
      themeArgs({ dark: { accent: "#7db6d6", canvas: "#060f14" } }),
    );
    expect((await run(s.t, (ctx) => ctx.db.get(themeId)))?.dark).toEqual({
      accent: "#7db6d6",
      canvas: "#060f14",
    });

    await s.as.mutation(api.emailThemes.updateTheme, { themeId, dark: null });
    expect((await run(s.t, (ctx) => ctx.db.get(themeId)))?.dark).toBeUndefined();
  });
});

// ── Default exclusivity ───────────────────────────────────────────────────

describe("setDefaultTheme", () => {
  test("only one theme per scope is ever the default", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const first = await s.as.mutation(api.emailThemes.createTheme, themeArgs({ name: "One" }));
    const second = await s.as.mutation(api.emailThemes.createTheme, themeArgs({ name: "Two" }));

    await s.as.mutation(api.emailThemes.setDefaultTheme, { themeId: first });
    await s.as.mutation(api.emailThemes.setDefaultTheme, { themeId: second });

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("emailThemes")
        .withIndex("by_scope", (q) => q.eq("scope", "central"))
        .collect(),
    );
    expect(rows.filter((r) => r.isDefault === true).map((r) => r._id)).toEqual([second]);
  });

  test("a default in ANOTHER scope isn't cleared", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const central = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    const chapter = await s.as.mutation(
      api.emailThemes.createTheme,
      themeArgs({ scope: s.chapterId, name: "Chapter theme" }),
    );
    await s.as.mutation(api.emailThemes.setDefaultTheme, { themeId: chapter });
    await s.as.mutation(api.emailThemes.setDefaultTheme, { themeId: central });

    expect((await run(s.t, (ctx) => ctx.db.get(chapter)))?.isDefault).toBe(true);
    expect((await run(s.t, (ctx) => ctx.db.get(central)))?.isDefault).toBe(true);
  });

  test("archiveTheme refuses the current default (IS_DEFAULT)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    await s.as.mutation(api.emailThemes.setDefaultTheme, { themeId });
    await expect(
      s.as.mutation(api.emailThemes.archiveTheme, { themeId }),
    ).rejects.toMatchObject({ data: { code: "IS_DEFAULT" } });
    expect((await run(s.t, (ctx) => ctx.db.get(themeId)))?.archived).toBeUndefined();
  });
});

// ── Duplicate ─────────────────────────────────────────────────────────────

describe("duplicateTheme", () => {
  test("copies a built-in preset into an editable row", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themeId = await s.as.mutation(api.emailThemes.duplicateTheme, {
      scope: "central",
      presetName: "Summer",
      name: "Summer 2026",
    });
    const row = await run(s.t, (ctx) => ctx.db.get(themeId));
    const summer = EMAIL_THEME_PRESETS.find((p) => p.name === "Summer");
    expect(row?.name).toBe("Summer 2026");
    expect(row?.accent).toBe(summer?.accent); // the preset's accent, copied verbatim
    expect(row?.isDefault).toBeUndefined(); // a copy is never a promotion

    // …and it's now editable, which the preset itself never is.
    await s.as.mutation(api.emailThemes.updateTheme, { themeId, accent: "#ff8800" });
    expect((await run(s.t, (ctx) => ctx.db.get(themeId)))?.accent).toBe("#ff8800");
  });

  test("copies an existing row, defaulting the name", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const sourceThemeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    const copyId = await s.as.mutation(api.emailThemes.duplicateTheme, {
      scope: "central",
      sourceThemeId,
    });
    expect(copyId).not.toBe(sourceThemeId);
    expect((await run(s.t, (ctx) => ctx.db.get(copyId)))?.name).toBe("Advent copy");
  });

  test("rejects naming both a preset and a row, or neither", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const sourceThemeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    await expect(
      s.as.mutation(api.emailThemes.duplicateTheme, {
        scope: "central",
        sourceThemeId,
        presetName: "Summer",
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
    await expect(
      s.as.mutation(api.emailThemes.duplicateTheme, { scope: "central" }),
    ).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
  });

  test("rejects an unknown preset name", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await expect(
      s.as.mutation(api.emailThemes.duplicateTheme, {
        scope: "central",
        presetName: "Autumnal Equinox",
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});

// ── Stamping onto campaigns ───────────────────────────────────────────────

describe("createCampaign stamps the scope's default theme", () => {
  test("a document with no theme gets the scope default", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const themeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    await s.as.mutation(api.emailThemes.setDefaultTheme, { themeId });

    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Newsletter",
      subject: "Hi",
      audienceId,
      doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello" }] },
    });
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.doc.theme?.name).toBe("Advent");
    expect(campaign?.doc.theme?.accent).toBe("#1f4a63");
  });

  test("with no saved default, the shared DEFAULT_EMAIL_THEME is stamped", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Newsletter",
      subject: "Hi",
      audienceId,
      doc: { blocks: [] },
    });
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.doc.theme?.name).toBe(DEFAULT_EMAIL_THEME.name);
    expect(campaign?.doc.theme?.accent).toBe(DEFAULT_EMAIL_THEME.accent);
  });

  test("a document that already names a theme is never overridden", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const themeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    await s.as.mutation(api.emailThemes.setDefaultTheme, { themeId });

    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Newsletter",
      subject: "Hi",
      audienceId,
      doc: { blocks: [], theme: { ...PUBLIC_WORSHIP_THEME } },
    });
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.doc.theme?.name).toBe(PUBLIC_WORSHIP_THEME.name);
  });
});

describe("setCampaignTheme", () => {
  test("restyles a draft from a preset", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Newsletter",
      subject: "Hi",
      audienceId,
      doc: { blocks: [] },
    });
    await s.as.mutation(api.campaigns.setCampaignTheme, { campaignId, presetName: "Winter" });
    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.doc.theme?.name).toBe("Winter");
  });

  test("restyles a draft from a saved theme, and rejects one from another scope", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Newsletter",
      subject: "Hi",
      audienceId,
      doc: { blocks: [] },
    });
    const central = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    await s.as.mutation(api.campaigns.setCampaignTheme, { campaignId, themeId: central });
    expect((await run(s.t, (ctx) => ctx.db.get(campaignId)))?.doc.theme?.name).toBe("Advent");

    const chapterTheme = await s.as.mutation(
      api.emailThemes.createTheme,
      themeArgs({ scope: s.chapterId, name: "Chapter theme" }),
    );
    await expect(
      s.as.mutation(api.campaigns.setCampaignTheme, { campaignId, themeId: chapterTheme }),
    ).rejects.toMatchObject({ data: { code: "SCOPE_MISMATCH" } });
  });

  test("refuses a campaign that's no longer editable", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Newsletter",
      subject: "Hi",
      audienceId,
      doc: { blocks: [] },
    });
    await run(s.t, (ctx) => ctx.db.patch(campaignId, { status: "sent" }));
    await expect(
      s.as.mutation(api.campaigns.setCampaignTheme, { campaignId, presetName: "Winter" }),
    ).rejects.toMatchObject({ data: { code: "NOT_EDITABLE" } });
  });
});
