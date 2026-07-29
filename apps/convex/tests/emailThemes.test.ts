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
 * Saved email themes (`emailThemes.ts`) — THEMES FREEZE (2026-07-29,
 * `docs/plans/maily-editor-overhaul.md`'s "Themes freeze"). Every WRITE
 * mutation here (`createTheme`/`updateTheme`/`setDefaultTheme`/
 * `archiveTheme`/`duplicateTheme`) throws `THEMES_RETIRED` unconditionally,
 * and `campaigns.setCampaignTheme`/`campaignTemplates.setTemplateTheme` do
 * the same for every row regardless of format or status — see
 * `emailThemes.ts#throwThemesRetired`'s doc.
 *
 * What's left to test:
 *  - Every retired mutation actually throws `THEMES_RETIRED`, not just some
 *    non-privileged-caller error that happens to also be a `ConvexError`.
 *  - `listThemes` (a READ — deliberately untouched) still merges saved rows
 *    with the code-shipped presets, including a row seeded before the
 *    newsletter-rebuild tokens existed (`normalizeEmailTheme`'s permissive
 *    read edge).
 *  - `campaigns.createCampaign` still stamps the scope's default theme onto a
 *    themeless BLOCKS document — that's `resolveScopeTheme`, a read, not one
 *    of the retired writes.
 *
 * Rows are seeded by inserting STRAIGHT into the table (`seedThemeRow`) —
 * `createTheme`/`setDefaultTheme` can no longer do it.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

/** Insert a theme row directly — the CRUD mutations are retired, so this is
 *  now the only way a test can put one on the table. */
async function seedThemeRow(
  s: ChapterSetup,
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  return run(s.t, (ctx) =>
    ctx.db.insert("emailThemes", {
      scope: "central",
      name: "Advent",
      accent: "#1f4a63",
      accentInk: "#ffffff",
      ink: "#0e1c24",
      muted: "#4e6672",
      canvas: "#f4f9fc",
      surface: "#ffffff",
      cream: "#f4f9fc",
      contrast: "#0e1c24",
      contrastInk: "#ffffff",
      hairline: "#c2ccd2",
      border: "#d3e2ea",
      link: "#1f4a63",
      headingFont: "Georgia,serif",
      bodyFont: "Inter,Arial,sans-serif",
      radius: 12,
      headingTracking: "-0.03em",
      bodyTracking: "-0.01em",
      wordmark: "PUBLIC WORSHIP",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }),
  );
}

/** A row inserted with only the columns that existed before the newsletter
 *  rebuild — i.e. what production actually holds. Used to prove the read
 *  edge fills the rest instead of throwing. */
async function seedLegacyThemeRow(s: ChapterSetup, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return run(s.t, (ctx) =>
    ctx.db.insert("emailThemes", {
      scope: "central",
      name: "Legacy",
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
      wordmark: "",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }),
  );
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
});

// ── Listing (a READ — untouched by the freeze) ──────────────────────────────

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
    const themeId = await seedThemeRow(s);
    const themes = await s.as.query(api.emailThemes.listThemes, { scope: "central" });

    expect(themes).toHaveLength(EMAIL_THEME_PRESETS.length + 1);
    expect(themes[0].themeId).toBe(themeId);
    expect(themes[0].isPreset).toBe(false);
    expect(themes[0].name).toBe("Advent");
    expect(themes.slice(1).every((x) => x.isPreset)).toBe(true);
    // Advisory only.
    expect(Array.isArray(themes[0].contrastWarnings)).toBe(true);
  });

  test("a theme saved under one scope isn't listed under another", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedThemeRow(s);
    const chapterThemes = await s.as.query(api.emailThemes.listThemes, {
      scope: s.chapterId,
    });
    expect(chapterThemes.every((x) => x.isPreset)).toBe(true);
  });

  test("a row stored before the newsletter-rebuild tokens existed reads back as a COMPLETE theme, filled from the default", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themeId = await seedLegacyThemeRow(s);
    // The row itself really is missing them — otherwise this proves nothing.
    const row = await run(s.t, (ctx) => ctx.db.get(themeId));
    expect(row?.cream).toBeUndefined();
    expect(row?.headingTracking).toBeUndefined();

    const view = (await s.as.query(api.emailThemes.listThemes, { scope: "central" })).find(
      (x) => x.themeId === themeId,
    );
    expect(view?.name).toBe("Legacy");
    expect(view?.accent).toBe("#1f4a63"); // its OWN tokens survive
    expect(view?.cream).toBe(DEFAULT_EMAIL_THEME.cream);
    expect(view?.contrast).toBe(DEFAULT_EMAIL_THEME.contrast);
    expect(view?.contrastInk).toBe(DEFAULT_EMAIL_THEME.contrastInk);
    expect(view?.hairline).toBe(DEFAULT_EMAIL_THEME.hairline);
    expect(view?.headingTracking).toBe(DEFAULT_EMAIL_THEME.headingTracking);
    expect(view?.bodyTracking).toBe(DEFAULT_EMAIL_THEME.bodyTracking);
  });
});

// ── The freeze itself ────────────────────────────────────────────────────

describe("the themes freeze — every write mutation is retired", () => {
  test("createTheme/updateTheme/setDefaultTheme/archiveTheme/duplicateTheme all throw THEMES_RETIRED", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const themeId = await seedThemeRow(s);

    await expect(
      s.as.mutation(api.emailThemes.createTheme, {
        scope: "central",
        name: "New",
        accent: "#1f4a63",
        accentInk: "#ffffff",
        ink: "#0e1c24",
        muted: "#4e6672",
        canvas: "#f4f9fc",
        surface: "#ffffff",
        cream: "#f4f9fc",
        contrast: "#0e1c24",
        contrastInk: "#ffffff",
        hairline: "#c2ccd2",
        border: "#d3e2ea",
        link: "#1f4a63",
        headingFont: "Georgia,serif",
        bodyFont: "Inter,Arial,sans-serif",
        radius: 12,
        headingTracking: "-0.03em",
        bodyTracking: "-0.01em",
        wordmark: "PUBLIC WORSHIP",
      }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });

    await expect(
      s.as.mutation(api.emailThemes.updateTheme, { themeId, name: "Renamed" }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });

    await expect(
      s.as.mutation(api.emailThemes.setDefaultTheme, { themeId }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });

    await expect(
      s.as.mutation(api.emailThemes.archiveTheme, { themeId }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });

    await expect(
      s.as.mutation(api.emailThemes.duplicateTheme, { scope: "central", presetName: "Summer" }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });

    // Nothing above actually wrote anything.
    const row = await run(s.t, (ctx) => ctx.db.get(themeId));
    expect(row?.name).toBe("Advent");
    expect(row?.isDefault).toBeUndefined();
    expect(row?.archived).toBeUndefined();
  });

  test("setCampaignTheme throws THEMES_RETIRED for every row, regardless of status", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    const draftId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Newsletter",
      subject: "Hi",
      audienceId,
      doc: { blocks: [] },
    });
    await expect(
      s.as.mutation(api.campaigns.setCampaignTheme, { campaignId: draftId, presetName: "Winter" }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });

    await run(s.t, (ctx) => ctx.db.patch(draftId, { status: "sent" }));
    await expect(
      s.as.mutation(api.campaigns.setCampaignTheme, { campaignId: draftId, presetName: "Winter" }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });
  });
});

// ── Stamping onto campaigns (createCampaign's own logic — untouched) ───────

describe("createCampaign stamps the scope's default theme", () => {
  test("a document with no theme gets the scope default", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    await seedThemeRow(s, { isDefault: true });

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
    await seedThemeRow(s, { isDefault: true });

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

  test("a legacy row stamps a COMPLETE theme (resolveScopeTheme's normalized read)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const audienceId = await seedAudience(s);
    await seedLegacyThemeRow(s, { isDefault: true });

    const campaignId = await s.as.mutation(api.campaigns.createCampaign, {
      scope: "central",
      name: "Newsletter",
      subject: "Hi",
      audienceId,
      doc: { blocks: [] },
    });
    const theme = (await run(s.t, (ctx) => ctx.db.get(campaignId)))?.doc.theme;
    expect(theme?.name).toBe("Legacy");
    expect(theme?.cream).toBe(DEFAULT_EMAIL_THEME.cream);
    expect(theme?.hairline).toBe(DEFAULT_EMAIL_THEME.hairline);
    expect(theme?.headingTracking).toBe(DEFAULT_EMAIL_THEME.headingTracking);
  });
});
