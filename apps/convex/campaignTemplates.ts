/**
 * Campaign templates — saved starting documents for the composer. Since the
 * templates merge (2026-07-29, founder decision — see `schema/campaigns.ts`'s
 * `kind` doc and `docs/plans/maily-editor-overhaul.md`'s §Data model), a
 * template is a `kind: "template"` row in the `campaigns` table, NOT a row
 * in the (now-frozen) `campaignTemplates` table this module is named after —
 * the module keeps its name and public function signatures so every existing
 * caller (mobile, tests) keeps working, but every function below reads and
 * writes `campaigns` rows. `lib/campaignKind.ts#isTemplateRow` is the ONE
 * predicate that classifies a row; every function here uses it (via
 * `loadTemplate`) rather than re-deriving "is this a template" itself.
 * CENTRAL-only (`lib/campaignsAccess.ts`).
 *
 * ── Who can do what here ───────────────────────────────────────────────────
 * Templates are SHARED — archiving the built-in newsletter takes it away from
 * everyone — so writing one is the named `campaigns.design` power
 * (`requireCampaignDesign`), not a side effect of being able to see the desk.
 * `listTemplates` stays on plain `requireCampaignsAccess`: a composer with no
 * design power must still be able to read the list they start from.
 * `createCampaignFromTemplate` is the odd one out — it lives here but CREATES
 * A CAMPAIGN, so it requires `campaigns.compose` (`requireCampaignCompose`),
 * which a design-only Graphic Designer deliberately does NOT hold.
 *
 * ── The row-kind boundary (Run-10 escalation class, designed in this time) ──
 * Before the merge, the TABLE a row lived in was doing this work for free: a
 * `campaignTemplates` row simply couldn't be reached by anything in
 * `campaigns.ts`, and vice versa. Now both kinds share one table, so every
 * function below that loads a row BY ID re-asserts its kind explicitly
 * (`loadTemplate` → `requireTemplateKindRow`) before doing anything with it —
 * a design-only holder who somehow got hold of an EMAIL's id (e.g. by reusing
 * a `campaignId` argument shape) must be refused here exactly as if the row
 * had never existed, the same as `campaigns.ts`'s own functions refuse a
 * template-kind row (`requireEmailKindRow`, that module's own doc).
 *
 * A template is just an `EmailDocument` with a name. THREE doors make one:
 * `createTemplate` builds one from scratch (the design-only door — see its
 * doc), `createTemplateFromCampaign` snapshots a campaign back the other way
 * ("this month's came out well — make it the starting point for next month"),
 * and `updateTemplate`/`setTemplateTheme` edit one in place from the template
 * composer (`app/(app)/campaign-template/[id].tsx`), which autosaves through
 * `updateTemplate({ templateId, doc })` exactly as the campaign composer
 * autosaves through `campaigns.updateCampaignDoc`.
 * `createCampaignFromTemplate` goes the other way, copying a template into a
 * fresh draft campaign. Both directions are the SAME duplication core
 * (`duplicateCampaignRow`, below) run in opposite directions — "start from
 * template" and "save as template" are one operation, not two — and both
 * COPY; a campaign created from a template has no live link back to it, so
 * editing the template afterwards can never alter a draft someone is
 * mid-way through, let alone something already approved or sent.
 *
 * `ensureBuiltInTemplates` idempotently seeds the built-ins that ship in code
 * (`@events-os/shared`'s `BUILT_IN_CAMPAIGN_TEMPLATES`, today just
 * `PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE` — the real monthly newsletter, rebuilt
 * block-for-block) as ordinary rows flagged `isBuiltIn`, keyed by NAME per
 * scope. Modelled on `lib/seed/templates.ts#ensureTrainingTemplate`: safe to
 * run repeatedly, refreshes a stale row in place, and never duplicates.
 *
 * Every write revalidates the document with `validateEmailDocument` — a
 * template is a document that will eventually be SENT, so it goes through the
 * same gate a campaign's own `doc` does rather than being trusted because it
 * came from a campaign that was already validated (a row could have been
 * written before a validation rule existed).
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import {
  requireCampaignCompose,
  requireCampaignDesign,
  requireCampaignsAccess,
} from "./lib/campaignsAccess";
import { isTemplateRow } from "./lib/campaignKind";
import { applyThemeToDoc, docHasTheme } from "./campaigns";
import { resolveScopeTheme, throwThemesRetired } from "./emailThemes";
import { emailDocFormatOf, validateEmailDocument, validateTiptapEmailDoc } from "@events-os/shared";
import type { EmailDocFormat } from "@events-os/shared";
import {
  assertValidTemplateDoc,
  seedBuiltInTemplates,
  TEMPLATE_SCAN_LIMIT,
} from "./lib/builtInTemplates";

// Re-exported so the migration and existing tests keep one import path.
export { seedBuiltInTemplates };

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

/** Load a template-kind `campaigns` row or throw `NOT_FOUND` — shared so
 *  every mutation gates identically. A row that exists but is EMAIL-kind is
 *  treated exactly like a missing row (`NOT_FOUND`, not the louder
 *  `IS_TEMPLATE`/`requireTemplateKindRow` throw) — from this module's callers'
 *  point of view a wrong-kind id simply doesn't resolve, the same as it
 *  wouldn't have before the merge when the two kinds lived in different
 *  tables. */
async function loadTemplate(ctx: MutationCtx, templateId: Id<"campaigns">): Promise<Doc<"campaigns">> {
  const row = await ctx.db.get(templateId);
  if (!row || !isTemplateRow(row)) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Template not found." });
  }
  return row;
}

/** Run a document through the write gate its `docFormat` names, raising this
 *  surface's `INVALID_DOC` (the same code `campaigns.ts` uses, so a client
 *  can handle one shape) — the templates-side twin of
 *  `campaigns.ts#validateDocForFormat`. Pure dispatch only, no theme
 *  stamping — see that function's own doc for why theme-stamping is each
 *  CREATE-time call site's own concern rather than folded in here. */
function assertValidDoc(docFormat: EmailDocFormat, doc: unknown) {
  if (docFormat === "tiptap") {
    const validated = validateTiptapEmailDoc(doc);
    if (!validated.ok) {
      throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
    }
    return doc;
  }
  const validated = validateEmailDocument(doc);
  if (!validated.ok) {
    throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
  }
  return validated.doc;
}

/**
 * THE duplication core — "start from template" and "save as template" are
 * the same operation (copy a document into a fresh row) run in opposite
 * directions; see this module's doc. Copies the SOURCE row's `docFormat`
 * (`schema/campaigns.ts`'s doc: set once at create time — a duplicate is a
 * fresh row, so it re-derives its own format the same way, from what it was
 * built FROM) — for a blocks-format source, stamps the scope's default theme
 * onto a themeless source doc BEFORE validating (exactly like
 * `campaigns.createCampaign` does for a hand-built document), so the copy's
 * look never depends on which direction it came from; a tiptap-format source
 * is never theme-stamped (tiptap docs carry no theme at all). `subject` is
 * always caller-supplied rather than defaulted from `source.subject`: an
 * email-kind target needs a real subject the caller (or the UI) has already
 * required, and a template-kind target deliberately never carries one
 * (`SaveAsTemplateAction`'s own promise: "not its segment or subject").
 */
async function duplicateCampaignRow(
  ctx: MutationCtx,
  source: Doc<"campaigns">,
  opts: {
    kind: "email" | "template";
    scope: Id<"chapters"> | "central";
    name: string;
    subject: string;
    createdBy: Id<"users">;
    audienceId?: Id<"audiences">; // required (by the caller) when kind === "email"
    description?: string; // template only
  },
): Promise<Id<"campaigns">> {
  const format = emailDocFormatOf(source);
  const seeded =
    format === "blocks" && !docHasTheme(source.doc)
      ? applyThemeToDoc(source.doc, await resolveScopeTheme(ctx, opts.scope))
      : source.doc;
  const doc = assertValidDoc(format, seeded);

  const now = Date.now();
  const shared = {
    scope: opts.scope,
    name: opts.name,
    subject: opts.subject,
    previewText: source.previewText,
    doc,
    // Absent-means-"blocks" — only stamp the column when it's actually
    // "tiptap", matching `createCampaign`/`createTemplate`'s own rule.
    docFormat: format === "tiptap" ? ("tiptap" as const) : undefined,
    status: "draft" as const,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  if (opts.kind === "email") {
    return await ctx.db.insert("campaigns", {
      ...shared,
      kind: "email",
      audienceId: opts.audienceId as Id<"audiences">,
    });
  }
  return await ctx.db.insert("campaigns", {
    ...shared,
    kind: "template",
    description: opts.description,
  });
}

export const listTemplates = query({
  args: { scope: v.optional(scopeValidator) },
  handler: async (ctx, { scope }) => {
    await requireCampaignsAccess(ctx);
    const rows = scope
      ? await ctx.db
          .query("campaigns")
          .withIndex("by_scope_kind", (q) => q.eq("scope", scope).eq("kind", "template"))
          .take(TEMPLATE_SCAN_LIMIT)
      : await ctx.db
          .query("campaigns")
          .withIndex("by_kind", (q) => q.eq("kind", "template"))
          .take(TEMPLATE_SCAN_LIMIT);
    return rows.filter((t) => t.archived !== true);
  },
});

/**
 * One template, for the editor (`app/(app)/campaign-template/[id].tsx`).
 *
 * `requireCampaignsAccess`, not `requireCampaignDesign`, for the same reason
 * `listTemplates` is: READING a template is what a composer does before
 * starting a campaign from it. The editor screen is what checks `canDesign`
 * before offering to write, and every WRITE below re-checks it server-side.
 * Throws `NOT_FOUND` rather than returning null, mirroring
 * `campaigns.getCampaign` — including for an id that resolves to a real,
 * EMAIL-kind row (see `loadTemplate`'s doc).
 */
export const getTemplate = query({
  args: { templateId: v.id("campaigns") },
  handler: async (ctx, { templateId }) => {
    await requireCampaignsAccess(ctx);
    const row = await ctx.db.get(templateId);
    if (!row || !isTemplateRow(row)) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Template not found." });
    }
    return row;
  },
});

/**
 * Create a template FROM SCRATCH — the designer's own door in.
 *
 * `createTemplateFromCampaign` (below) needs a campaign to snapshot, and
 * minting a campaign requires `campaigns.compose`, which a design-only
 * Graphic Designer deliberately does NOT hold. So without this, the person
 * whose whole job is the design system could only ever rename and archive
 * templates other people had made. This is `campaigns.design` like every other
 * write to the shared design system.
 *
 * `doc` is optional: omitted, the template starts EMPTY (`{ blocks: [] }`) and
 * is opened straight in the composer. Either way it goes through the same
 * write gate a campaign's document does (`assertValidTemplateDoc`) — a
 * template that saves but can never be sent is a trap — and picks up the
 * scope's default theme when it brought none, exactly like
 * `campaigns.createCampaign`, so a template's look never depends on which
 * door it came in through.
 */
export const createTemplate = mutation({
  args: {
    scope: scopeValidator,
    name: v.string(),
    description: v.optional(v.string()),
    doc: v.optional(v.any()),
    // Set ONCE, here, and IMMUTABLE thereafter — see `schema/campaigns.ts`'s
    // `docFormat` doc. Absent (or `"blocks"`) behaves exactly as it always
    // has; `"tiptap"` is the maily editor's document shape.
    docFormat: v.optional(v.union(v.literal("blocks"), v.literal("tiptap"))),
  },
  returns: v.id("campaigns"),
  handler: async (ctx, { scope, name, description, doc, docFormat }) => {
    await requireCampaignDesign(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ConvexError({ code: "EMPTY", message: "Name the template first." });
    }

    const format: EmailDocFormat = docFormat === "tiptap" ? "tiptap" : "blocks";
    const starting = doc ?? (format === "tiptap" ? { type: "doc", content: [] } : { blocks: [] });
    // Theme-stamp BLOCKS only — see `duplicateCampaignRow`'s identical rule;
    // a tiptap document is never theme-stamped.
    const themed =
      format === "blocks" && !docHasTheme(starting)
        ? applyThemeToDoc(starting, await resolveScopeTheme(ctx, scope))
        : starting;
    const validated = assertValidDoc(format, themed);

    const now = Date.now();
    return await ctx.db.insert("campaigns", {
      scope,
      name: trimmedName,
      subject: "",
      description: description?.trim() || undefined,
      doc: validated,
      docFormat: format === "tiptap" ? "tiptap" : undefined,
      kind: "template",
      status: "draft",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Snapshot a campaign's current document into a new template. Takes the
 *  campaign's `scope` too, so a template is saved in the same place the
 *  campaign that produced it lives. The source must be an EMAIL-kind row —
 *  "snapshot a template into a template" isn't a real request, and treating a
 *  template-kind `campaignId` as `NOT_FOUND` here matches `loadTemplate`'s own
 *  wrong-kind-is-missing convention (the flip side of the same boundary). */
export const createTemplateFromCampaign = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("campaigns"),
  handler: async (ctx, { campaignId, name, description }) => {
    await requireCampaignDesign(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const campaign = await ctx.db.get(campaignId);
    if (!campaign || isTemplateRow(campaign)) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ConvexError({ code: "EMPTY", message: "Name the template first." });
    }

    return await duplicateCampaignRow(ctx, campaign, {
      kind: "template",
      scope: campaign.scope,
      name: trimmedName,
      // Templates never carry a subject — see `duplicateCampaignRow`'s doc.
      subject: "",
      createdBy: userId,
      description: description?.trim() || undefined,
    });
  },
});

/**
 * Start a new DRAFT campaign from a template.
 *
 * The template's document is copied verbatim, except that a template with no
 * theme of its own is stamped with the scope's current default — identical to
 * what `campaigns.createCampaign` does for a hand-built document, via the
 * SAME duplication core `createTemplateFromCampaign` uses in the other
 * direction (`duplicateCampaignRow`). A template that DOES carry a theme
 * keeps it: that theme is part of what was saved.
 */
export const createCampaignFromTemplate = mutation({
  args: {
    templateId: v.id("campaigns"),
    name: v.string(),
    subject: v.string(),
    audienceId: v.id("audiences"),
  },
  returns: v.id("campaigns"),
  handler: async (ctx, { templateId, name, subject, audienceId }) => {
    // COMPOSE, not design: this mints a draft campaign. A design-only holder
    // may edit the template all day and still never start a send from it.
    await requireCampaignCompose(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const template = await loadTemplate(ctx, templateId);

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ConvexError({ code: "EMPTY", message: "Name the email first." });
    }
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) {
      throw new ConvexError({ code: "EMPTY", message: "Write a subject line first." });
    }
    const audience = await ctx.db.get(audienceId);
    if (!audience) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
    }

    return await duplicateCampaignRow(ctx, template, {
      kind: "email",
      scope: template.scope,
      name: trimmedName,
      subject: trimmedSubject,
      createdBy: userId,
      audienceId,
    });
  },
});

export const updateTemplate = mutation({
  args: {
    templateId: v.id("campaigns"),
    name: v.optional(v.string()),
    // `null` clears the description; `undefined` leaves it untouched — the
    // `previewText` null-sentinel convention from `campaigns.ts`.
    description: v.optional(v.union(v.string(), v.null())),
    doc: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, { templateId, name, description, doc }) => {
    await requireCampaignDesign(ctx);
    const existing = await loadTemplate(ctx, templateId);

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new ConvexError({ code: "EMPTY", message: "Name the template first." });
      }
      patch.name = trimmed;
    }
    if (description !== undefined) patch.description = description?.trim() || undefined;
    // `docFormat` is IMMUTABLE — never accepted as an argument here. Validate
    // against whatever format THIS row was created with, exactly like
    // `campaigns.ts#updateCampaignDoc`.
    if (doc !== undefined) patch.doc = assertValidDoc(emailDocFormatOf(existing), doc);
    await ctx.db.patch(templateId, patch);
    return null;
  },
});

/**
 * Themes freeze (2026-07-29) — retired, for EVERY row regardless of format.
 * See `emailThemes.ts#throwThemesRetired`'s doc: a tiptap template carries no
 * theme at all, and a blocks template keeps whatever snapshot it was created
 * with.
 */
export const setTemplateTheme = mutation({
  args: {
    templateId: v.id("campaigns"),
    themeId: v.optional(v.id("emailThemes")),
    presetName: v.optional(v.string()),
  },
  returns: v.null(),
  // Explicit return type — a bare `return throwThemesRetired()` (which
  // returns `never`) would otherwise make TypeScript infer this handler's
  // return type as `Promise<never>` instead of widening to the declared
  // `returns` validator's type, poisoning downstream callers' inferred types
  // (see `emailThemes.ts#createTheme`'s identical note).
  handler: async (ctx, { templateId, themeId, presetName }): Promise<null> => {
    await requireCampaignDesign(ctx);
    return throwThemesRetired();
  },
});

/** Soft-delete. A built-in row archives like any other — `ensureBuiltInTemplates`
 *  deliberately does NOT resurrect it (see that mutation's doc), so an org that
 *  doesn't want the newsletter template can actually get rid of it. */
export const archiveTemplate = mutation({
  args: { templateId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, { templateId }) => {
    await requireCampaignDesign(ctx);
    await loadTemplate(ctx, templateId);
    await ctx.db.patch(templateId, { archived: true, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Seed (or refresh) the code-shipped templates for one scope. Idempotent —
 * safe to run on every deploy, from a migration, or on demand.
 *
 * Keyed by `isBuiltIn === true` AND `name`, the
 * `lib/seed/templates.ts#ensureTrainingTemplate` pattern: an existing row is
 * PATCHED in place when the shipped content has moved on (so a released
 * improvement to the newsletter reaches every deployment) and left alone
 * otherwise; a missing one is inserted. An ARCHIVED built-in row is left
 * archived rather than resurrected — an org that deleted the template meant
 * it, and un-deleting it on every deploy would be unfixable from the UI.
 *
 * `createdBy` is PROVENANCE, not authorization: this is an `internalMutation`
 * with no public entry point, so there is no caller identity to derive and
 * nothing is being authorized by it. (The guidelines' "never accept a userId
 * as an argument" rule is about auth decisions, which this makes none of —
 * same shape `ensureTrainingTemplate` already uses.)
 *
 * Returns the ids of every built-in row for this scope, for tests and callers
 * that want to point a picker straight at one.
 */
export const ensureBuiltInTemplates = internalMutation({
  args: { scope: scopeValidator, createdBy: v.id("users") },
  returns: v.array(v.id("campaigns")),
  handler: async (ctx, { scope, createdBy }) =>
    seedBuiltInTemplates(ctx, scope, createdBy),
});
