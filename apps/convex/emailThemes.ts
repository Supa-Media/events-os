/**
 * Saved email themes — the design tokens every campaign send is painted with
 * (`@events-os/shared`'s `emailTheme.ts` + `emailRender.ts`). CENTRAL-only
 * (`lib/campaignsAccess.ts`).
 *
 * ── Who can do what here ───────────────────────────────────────────────────
 * A theme is the org's BRAND, shared by every future send, so every mutation
 * in this file requires the named `campaigns.design` power
 * (`requireCampaignDesign`) — the Graphic Designer / Social Media Manager /
 * Marketing Director / ED / FM. `listThemes` stays on plain
 * `requireCampaignsAccess`: a composer with no design power still has to be
 * able to SEE the themes in order to pick one for their campaign.
 *
 * ── Presets are code; saved themes are rows ─────────────────────────────────
 * `EMAIL_THEME_PRESETS` (Public Worship, Summer, Fall, Winter) live in the
 * shared package and are NEVER inserted here. `listThemes` returns them
 * alongside the org's rows, flagged `isPreset: true` with a null `themeId`, so
 * the picker shows one flat list; `duplicateTheme` is the ONLY way a preset
 * becomes editable — it copies the tokens into a fresh row the designer then
 * owns. That split means a preset can be improved in a release without
 * silently rewriting anyone's tweaked copy, and an org can never "edit" a
 * preset into a state a future release would fight over.
 *
 * ── Validation ─────────────────────────────────────────────────────────────
 * Every write runs the FULL token set through `validateEmailTheme` (the shared
 * strict WRITE gate) and throws `INVALID_THEME` with the validator's own
 * message on failure — a typo'd hex is reported, never silently repaired. The
 * permissive counterpart, `normalizeEmailTheme`, is used on the READ side
 * (`resolveScopeTheme`) so a row written before a token existed still renders.
 * Contrast warnings ride along on `listThemes` but are ADVISORY only: WCAG
 * legibility is a judgement the designer owns (see
 * `emailThemeContrastWarnings`'s own doc), so a warned theme still saves.
 *
 * ── Where a theme actually lands ───────────────────────────────────────────
 * Nothing renders from this table directly. `campaigns.ts` STAMPS the scope's
 * default theme into a campaign's `doc.theme` at create time
 * (`applyThemeToDoc`), and `setCampaignTheme` restamps it on demand — an
 * inline, resolved snapshot, so what a reviewer approved is what sends and an
 * already-sent campaign never restyles when the designer edits this table
 * months later. `resolveScopeTheme` (below) is the one place that decides what
 * "the scope's default" means.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { requireCampaignDesign, requireCampaignsAccess } from "./lib/campaignsAccess";
import {
  DEFAULT_EMAIL_THEME,
  EMAIL_THEME_PRESETS,
  emailThemeContrastWarnings,
  emailThemePreset,
  normalizeEmailTheme,
  validateEmailTheme,
  type EmailTheme,
} from "@events-os/shared";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

/**
 * ── Themes freeze (founder decision, 2026-07-29 — `docs/plans/maily-editor-
 * overhaul.md`'s "Themes freeze") ────────────────────────────────────────────
 * "The concept of themes is pretty dumb… no need as long as we have
 * templates." Every WRITE to the shared theme system is retired: every
 * mutation below (`createTheme`/`updateTheme`/`setDefaultTheme`/
 * `archiveTheme`/`duplicateTheme`) throws this, unconditionally, before doing
 * anything else. `listThemes` (a READ) is deliberately left alone — legacy
 * blocks-format campaigns still carry a baked theme snapshot in `doc.theme`
 * and the renderer still needs `resolveScopeTheme`/`normalizeEmailTheme` to
 * paint them, so the ROWS themselves must keep existing and reading; only
 * making or changing one is gone.
 *
 * `campaigns.ts#setCampaignTheme` and `campaignTemplates.ts#setTemplateTheme`
 * — "restyle this document" — throw the SAME code for the SAME reason, for
 * EVERY row regardless of format: a tiptap document carries no theme key at
 * all (there is nothing to restyle), and a blocks document keeps whatever
 * snapshot it was created with (restyling an existing campaign/template is
 * retired along with the picker that used to do it).
 */
export function throwThemesRetired(): never {
  throw new ConvexError({
    code: "THEMES_RETIRED",
    message:
      "Themes are retired — start from a template instead, or edit the document's own styling directly.",
  });
}

/** Bound on a single scope's saved themes. A design system with more than a
 *  couple of dozen themes isn't a design system; 200 is the same
 *  never-scan-unbounded discipline `listCampaigns`/`listAudiences` use, sized
 *  far above any real usage so the cap never silently hides a row. */
const THEME_SCAN_LIMIT = 200;

/** The `dark` PARTIAL override — every key optional, because a missing key
 *  means "don't move this token in dark mode" (see `emailTheme.ts`). Shared by
 *  the args of `createTheme`/`updateTheme` and the `listThemes` view so the
 *  three can never drift. */
const darkOverrideValidator = v.object({
  accent: v.optional(v.string()),
  accentInk: v.optional(v.string()),
  ink: v.optional(v.string()),
  muted: v.optional(v.string()),
  canvas: v.optional(v.string()),
  surface: v.optional(v.string()),
  cream: v.optional(v.string()),
  contrast: v.optional(v.string()),
  contrastInk: v.optional(v.string()),
  hairline: v.optional(v.string()),
  border: v.optional(v.string()),
  link: v.optional(v.string()),
  headingFont: v.optional(v.string()),
  bodyFont: v.optional(v.string()),
  // NOTE: no `headingTracking`/`bodyTracking` here, on purpose. The shared
  // `normalizeDarkOverride` carries only colour and font keys across, so a
  // dark tracking value would be accepted, stored, and then silently dropped
  // on every read — a field that looks like it works and doesn't. If dark
  // mode ever needs its own tracking, it goes into `emailTheme.ts` first.
});

const contrastWarningValidator = v.object({
  id: v.string(),
  label: v.string(),
  ratio: v.number(),
  required: v.number(),
  scheme: v.union(v.literal("light"), v.literal("dark")),
});

/** One row in the theme picker — a saved row OR a built-in preset. `themeId`
 *  is `null` for a preset (it has no row to point at), which is also how the
 *  UI knows to offer "Duplicate" instead of "Edit". */
const themeViewValidator = v.object({
  themeId: v.union(v.id("emailThemes"), v.null()),
  isPreset: v.boolean(),
  isDefault: v.boolean(),
  name: v.string(),
  accent: v.string(),
  accentInk: v.string(),
  ink: v.string(),
  muted: v.string(),
  canvas: v.string(),
  surface: v.string(),
  cream: v.string(),
  contrast: v.string(),
  contrastInk: v.string(),
  hairline: v.string(),
  border: v.string(),
  link: v.string(),
  headingFont: v.string(),
  bodyFont: v.string(),
  radius: v.number(),
  headingTracking: v.string(),
  bodyTracking: v.string(),
  wordmark: v.string(),
  dark: v.optional(darkOverrideValidator),
  /** Advisory WCAG AA failures, measured in BOTH schemes. Never blocks a save. */
  contrastWarnings: v.array(contrastWarningValidator),
});

type DarkOverride = {
  accent?: string;
  accentInk?: string;
  ink?: string;
  muted?: string;
  canvas?: string;
  surface?: string;
  cream?: string;
  contrast?: string;
  contrastInk?: string;
  hairline?: string;
  border?: string;
  link?: string;
  headingFont?: string;
  bodyFont?: string;
};

/** The twelve colour tokens, in the order `emailTheme.ts` documents them. */
const COLOR_KEYS = [
  "accent",
  "accentInk",
  "ink",
  "muted",
  "canvas",
  "surface",
  "cream",
  "contrast",
  "contrastInk",
  "hairline",
  "border",
  "link",
] as const;

/** The non-colour string tokens `updateTheme` merges the same way — letter
 *  spacing, validated by SHAPE (`safeTracking`) rather than as a hex. */
const TRACKING_KEYS = ["headingTracking", "bodyTracking"] as const;

/** The full stored token set, projected off a validated `EmailTheme`. Shared
 *  by `createTheme`'s insert, `updateTheme`'s patch and `duplicateTheme`'s
 *  copy so a token added to `emailTheme.ts` can never reach two of the three
 *  and be quietly dropped by the fourth. */
function themeColumns(theme: EmailTheme) {
  return {
    name: theme.name,
    accent: theme.accent,
    accentInk: theme.accentInk,
    ink: theme.ink,
    muted: theme.muted,
    canvas: theme.canvas,
    surface: theme.surface,
    cream: theme.cream,
    contrast: theme.contrast,
    contrastInk: theme.contrastInk,
    hairline: theme.hairline,
    border: theme.border,
    link: theme.link,
    headingFont: theme.headingFont,
    bodyFont: theme.bodyFont,
    radius: theme.radius,
    headingTracking: theme.headingTracking,
    bodyTracking: theme.bodyTracking,
    wordmark: theme.wordmark,
  };
}

// ── Read helpers ────────────────────────────────────────────────────────────

/** Every non-archived saved theme for `scope`, bounded. */
async function scopeThemeRows(
  ctx: QueryCtx,
  scope: Id<"chapters"> | "central",
): Promise<Doc<"emailThemes">[]> {
  const rows = await ctx.db
    .query("emailThemes")
    .withIndex("by_scope", (q) => q.eq("scope", scope))
    .take(THEME_SCAN_LIMIT);
  return rows.filter((r) => r.archived !== true);
}

/**
 * The `EmailTheme` a campaign in `scope` should be stamped with: the scope's
 * `isDefault` row, else `DEFAULT_EMAIL_THEME` (Public Worship's real brand).
 *
 * Exported (a plain helper, not a Convex function) because `campaigns.ts` and
 * `campaignTemplates.ts` both need it and neither should re-derive "what does
 * default mean" for itself — a second copy of this rule is how a template
 * silently ends up on a different theme than a campaign created the same day.
 * Reads through `normalizeEmailTheme`, the permissive edge, so a row missing a
 * token (written before that token existed, or by an import script) still
 * yields something renderable instead of painting `undefined` into a style
 * attribute on a real send.
 */
export async function resolveScopeTheme(
  ctx: QueryCtx,
  scope: Id<"chapters"> | "central",
): Promise<EmailTheme> {
  const rows = await scopeThemeRows(ctx, scope);
  const fallback = rows.find((r) => r.isDefault === true);
  return fallback ? normalizeEmailTheme(fallback) : DEFAULT_EMAIL_THEME;
}

/** Project an `EmailTheme` (row-derived or preset) into the picker's view. */
function toThemeView(
  theme: EmailTheme,
  opts: { themeId: Id<"emailThemes"> | null; isPreset: boolean; isDefault: boolean },
) {
  return {
    themeId: opts.themeId,
    isPreset: opts.isPreset,
    isDefault: opts.isDefault,
    ...themeColumns(theme),
    // Spread rather than `dark: theme.dark` — `undefined` is not a Convex
    // value, so an absent override must be an ABSENT KEY, not a present one
    // holding undefined.
    ...(theme.dark ? { dark: theme.dark as DarkOverride } : {}),
    contrastWarnings: emailThemeContrastWarnings(theme),
  };
}

/**
 * The scope's saved themes PLUS the built-in presets, in one list: rows first
 * (the designer's own work is what she's looking for), presets after.
 *
 * A preset whose NAME matches a saved row is still listed — deliberately. The
 * row is a divergent copy the moment it's edited, and hiding the original
 * would make "start over from Summer" impossible.
 */
export const listThemes = query({
  args: { scope: scopeValidator },
  returns: v.array(themeViewValidator),
  handler: async (ctx, { scope }) => {
    await requireCampaignsAccess(ctx);
    const rows = await scopeThemeRows(ctx, scope);
    const saved = rows.map((row) =>
      toThemeView(normalizeEmailTheme(row), {
        themeId: row._id,
        isPreset: false,
        isDefault: row.isDefault === true,
      }),
    );
    const presets = EMAIL_THEME_PRESETS.map((preset) =>
      toThemeView(preset, { themeId: null, isPreset: true, isDefault: false }),
    );
    return [...saved, ...presets];
  },
});

// ── Write gate ──────────────────────────────────────────────────────────────

/** Assemble a candidate theme and run it through the shared strict validator,
 *  translating a failure into this surface's `INVALID_THEME` ConvexError with
 *  the validator's own message (the designer sees "theme \"accent\" must be a
 *  hex colour like #891d1a", not a generic rejection). */
function assertValidTheme(candidate: Record<string, unknown>): EmailTheme {
  const result = validateEmailTheme(candidate);
  if (!result.ok) {
    throw new ConvexError({ code: "INVALID_THEME", message: result.error });
  }
  return result.theme;
}

/** Load a theme row or throw `NOT_FOUND` — the three edit mutations' shared
 *  first step, so they can never gate differently. */
async function loadTheme(
  ctx: MutationCtx,
  themeId: Id<"emailThemes">,
): Promise<Doc<"emailThemes">> {
  const row = await ctx.db.get(themeId);
  if (!row) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Theme not found." });
  }
  return row;
}

export const createTheme = mutation({
  args: {
    scope: scopeValidator,
    name: v.string(),
    accent: v.string(),
    accentInk: v.string(),
    ink: v.string(),
    muted: v.string(),
    canvas: v.string(),
    surface: v.string(),
    cream: v.string(),
    contrast: v.string(),
    contrastInk: v.string(),
    hairline: v.string(),
    border: v.string(),
    link: v.string(),
    headingFont: v.string(),
    bodyFont: v.string(),
    radius: v.number(),
    headingTracking: v.string(),
    bodyTracking: v.string(),
    wordmark: v.string(),
    dark: v.optional(darkOverrideValidator),
  },
  returns: v.id("emailThemes"),
  // Explicit return type — without it, a bare `return throwThemesRetired()`
  // (which returns `never`) makes TypeScript infer this handler's (and so
  // this MUTATION's) return type as `Promise<never>` rather than widening to
  // the declared `returns` validator's type, which then poisons every
  // downstream caller's inferred type (e.g. a test's
  // `const themeId = await t.mutation(api.emailThemes.createTheme, …)`)
  // instead of yielding `Id<"emailThemes">`.
  handler: async (ctx, args): Promise<Id<"emailThemes">> => {
    await requireCampaignDesign(ctx);
    return throwThemesRetired();
  },
});

/**
 * Edit a saved theme. Every field is optional and MERGED over the stored row
 * before validation — a designer nudging one colour must not have to resend
 * eleven others, but the validator still sees a COMPLETE token set (a partial
 * validate would happily accept a theme that's only valid in combination with
 * fields it never looked at).
 *
 * `dark: null` clears the override entirely; omitting it leaves the stored one
 * untouched (the `previewText` null-sentinel convention from
 * `campaigns.updateCampaignMeta`).
 */
export const updateTheme = mutation({
  args: {
    themeId: v.id("emailThemes"),
    name: v.optional(v.string()),
    accent: v.optional(v.string()),
    accentInk: v.optional(v.string()),
    ink: v.optional(v.string()),
    muted: v.optional(v.string()),
    canvas: v.optional(v.string()),
    surface: v.optional(v.string()),
    cream: v.optional(v.string()),
    contrast: v.optional(v.string()),
    contrastInk: v.optional(v.string()),
    hairline: v.optional(v.string()),
    border: v.optional(v.string()),
    link: v.optional(v.string()),
    headingFont: v.optional(v.string()),
    bodyFont: v.optional(v.string()),
    radius: v.optional(v.number()),
    headingTracking: v.optional(v.string()),
    bodyTracking: v.optional(v.string()),
    wordmark: v.optional(v.string()),
    dark: v.optional(v.union(darkOverrideValidator, v.null())),
  },
  returns: v.null(),
  // Explicit return type — see `createTheme`'s identical note.
  handler: async (ctx, { themeId, dark, ...fields }): Promise<null> => {
    await requireCampaignDesign(ctx);
    return throwThemesRetired();
  },
});

/**
 * Make `themeId` the scope's default, clearing the flag from every sibling in
 * the SAME transaction — "at most one default per scope" is an invariant this
 * mutation is solely responsible for, so it must never be two writes a crash
 * could land between.
 */
export const setDefaultTheme = mutation({
  args: { themeId: v.id("emailThemes") },
  returns: v.null(),
  // Explicit return type — see `createTheme`'s identical note.
  handler: async (ctx, { themeId }): Promise<null> => {
    await requireCampaignDesign(ctx);
    return throwThemesRetired();
  },
});

/** Soft-delete. Refuses the row currently holding `isDefault` — archiving the
 *  default would leave the scope stamping campaigns from a theme the designer
 *  believes she deleted (`resolveScopeTheme` skips archived rows, so it would
 *  silently fall back to `DEFAULT_EMAIL_THEME` instead). Pick a new default
 *  first; that's an explicit decision, not a side effect. */
export const archiveTheme = mutation({
  args: { themeId: v.id("emailThemes") },
  returns: v.null(),
  // Explicit return type — see `createTheme`'s identical note.
  handler: async (ctx, { themeId }): Promise<null> => {
    await requireCampaignDesign(ctx);
    return throwThemesRetired();
  },
});

/**
 * Copy a preset (`presetName`) or an existing row (`sourceThemeId`) into a new
 * EDITABLE row. This is how a designer starts from "Summer" and tweaks it —
 * presets themselves are code and can never be edited in place.
 *
 * The copy never inherits `isDefault` (a duplicate is a draft of an idea, not
 * a promotion) and gets a distinct name so the picker doesn't show two
 * identical labels.
 */
export const duplicateTheme = mutation({
  args: {
    scope: scopeValidator,
    sourceThemeId: v.optional(v.id("emailThemes")),
    presetName: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  returns: v.id("emailThemes"),
  // Explicit return type — see `createTheme`'s identical note.
  handler: async (ctx, { scope, sourceThemeId, presetName, name }): Promise<Id<"emailThemes">> => {
    await requireCampaignDesign(ctx);
    return throwThemesRetired();
  },
});
