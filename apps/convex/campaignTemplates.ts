/**
 * Campaign templates — saved starting documents for the composer
 * (`schema/campaigns.ts#campaignTemplates`). CENTRAL-only
 * (`lib/campaignsAccess.ts`).
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
 * A template is just an `EmailDocument` with a name. THREE doors make one:
 * `createTemplate` builds one from scratch (the design-only door — see its
 * doc), `createTemplateFromCampaign` snapshots a campaign back the other way
 * ("this month's came out well — make it the starting point for next month"),
 * and `updateTemplate`/`setTemplateTheme` edit one in place from the template
 * composer (`app/(app)/campaign-template/[id].tsx`), which autosaves through
 * `updateTemplate({ templateId, doc })` exactly as the campaign composer
 * autosaves through `campaigns.updateCampaignDoc`.
 * `createCampaignFromTemplate` goes the other way, copying a template into a
 * fresh draft campaign. Both directions COPY; a campaign
 * created from a template has no live link back to it, so editing the template
 * afterwards can never alter a draft someone is mid-way through, let alone
 * something already approved or sent.
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
import { applyThemeToDoc, docHasTheme, resolveThemeChoice } from "./campaigns";
import { resolveScopeTheme } from "./emailThemes";
import { validateEmailDocument } from "@events-os/shared";
import {
  assertValidTemplateDoc,
  seedBuiltInTemplates,
  TEMPLATE_SCAN_LIMIT,
} from "./lib/builtInTemplates";

// Re-exported so the migration and existing tests keep one import path.
export { seedBuiltInTemplates };

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

/** Load a template row or throw `NOT_FOUND` — shared so every mutation gates
 *  identically. */
async function loadTemplate(
  ctx: MutationCtx,
  templateId: Id<"campaignTemplates">,
): Promise<Doc<"campaignTemplates">> {
  const row = await ctx.db.get(templateId);
  if (!row) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Template not found." });
  }
  return row;
}

/** Run a document through the shared write gate, raising this surface's
 *  `INVALID_DOC` (the same code `campaigns.ts` uses, so a client can handle
 *  one shape). */
function assertValidDoc(doc: unknown) {
  const validated = validateEmailDocument(doc);
  if (!validated.ok) {
    throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
  }
  return validated.doc;
}

export const listTemplates = query({
  args: { scope: v.optional(scopeValidator) },
  handler: async (ctx, { scope }) => {
    await requireCampaignsAccess(ctx);
    const rows = scope
      ? await ctx.db
          .query("campaignTemplates")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .take(TEMPLATE_SCAN_LIMIT)
      : await ctx.db.query("campaignTemplates").take(TEMPLATE_SCAN_LIMIT);
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
 * `campaigns.getCampaign`.
 */
export const getTemplate = query({
  args: { templateId: v.id("campaignTemplates") },
  handler: async (ctx, { templateId }) => {
    await requireCampaignsAccess(ctx);
    const row = await ctx.db.get(templateId);
    if (!row) {
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
 * `campaigns.createCampaign`, so a template's look never depends on which door
 * it came in through.
 */
export const createTemplate = mutation({
  args: {
    scope: scopeValidator,
    name: v.string(),
    description: v.optional(v.string()),
    doc: v.optional(v.any()),
  },
  returns: v.id("campaignTemplates"),
  handler: async (ctx, { scope, name, description, doc }) => {
    await requireCampaignDesign(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ConvexError({ code: "EMPTY", message: "Name the template first." });
    }

    const starting = doc ?? { blocks: [] };
    const themed = docHasTheme(starting)
      ? starting
      : applyThemeToDoc(starting, await resolveScopeTheme(ctx, scope));
    const validated = assertValidDoc(themed);

    const now = Date.now();
    return await ctx.db.insert("campaignTemplates", {
      scope,
      name: trimmedName,
      description: description?.trim() || undefined,
      doc: validated,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Snapshot a campaign's current document into a new template. Takes the
 *  campaign's `scope` too, so a template is saved in the same place the
 *  campaign that produced it lives. */
export const createTemplateFromCampaign = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("campaignTemplates"),
  handler: async (ctx, { campaignId, name, description }) => {
    await requireCampaignDesign(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ConvexError({ code: "EMPTY", message: "Name the template first." });
    }
    const doc = assertValidDoc(campaign.doc);

    const now = Date.now();
    return await ctx.db.insert("campaignTemplates", {
      scope: campaign.scope,
      name: trimmedName,
      description: description?.trim() || undefined,
      doc,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Start a new DRAFT campaign from a template.
 *
 * The template's document is copied verbatim, except that a template with no
 * theme of its own is stamped with the scope's current default
 * (`applyThemeToDoc` + `resolveScopeTheme`) — identical to what
 * `campaigns.createCampaign` does for a hand-built document, so a campaign's
 * look never depends on which door it came in through. A template that DOES
 * carry a theme keeps it: that theme is part of what was saved.
 */
export const createCampaignFromTemplate = mutation({
  args: {
    templateId: v.id("campaignTemplates"),
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

    const seeded = docHasTheme(template.doc)
      ? template.doc
      : applyThemeToDoc(template.doc, await resolveScopeTheme(ctx, template.scope));
    const doc = assertValidDoc(seeded);

    const now = Date.now();
    return await ctx.db.insert("campaigns", {
      scope: template.scope,
      name: trimmedName,
      subject: trimmedSubject,
      audienceId,
      doc,
      status: "draft",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateTemplate = mutation({
  args: {
    templateId: v.id("campaignTemplates"),
    name: v.optional(v.string()),
    // `null` clears the description; `undefined` leaves it untouched — the
    // `previewText` null-sentinel convention from `campaigns.ts`.
    description: v.optional(v.union(v.string(), v.null())),
    doc: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, { templateId, name, description, doc }) => {
    await requireCampaignDesign(ctx);
    await loadTemplate(ctx, templateId);

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new ConvexError({ code: "EMPTY", message: "Name the template first." });
      }
      patch.name = trimmed;
    }
    if (description !== undefined) patch.description = description?.trim() || undefined;
    if (doc !== undefined) patch.doc = assertValidDoc(doc);
    await ctx.db.patch(templateId, patch);
    return null;
  },
});

/**
 * Restyle a template — the template twin of `campaigns.setCampaignTheme`, and
 * the reason a template's theme ROUND-TRIPS instead of quietly reverting.
 *
 * A template has no theme of its own beyond what's in `doc.theme`, so
 * restyling one is a document edit: resolve the choice (`resolveThemeChoice`,
 * shared with the campaign side so the two can never accept different things),
 * stamp it, revalidate, patch. There's no `assertEditable` twin here — a
 * template is never "in flight"; that guard exists on the campaign side
 * because a reviewer approved a particular-looking email.
 */
export const setTemplateTheme = mutation({
  args: {
    templateId: v.id("campaignTemplates"),
    themeId: v.optional(v.id("emailThemes")),
    presetName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { templateId, themeId, presetName }) => {
    await requireCampaignDesign(ctx);
    const template = await loadTemplate(ctx, templateId);
    const theme = await resolveThemeChoice(ctx, template.scope, { themeId, presetName });
    const doc = assertValidDoc(applyThemeToDoc(template.doc, theme));
    await ctx.db.patch(templateId, { doc, updatedAt: Date.now() });
    return null;
  },
});

/** Soft-delete. A built-in row archives like any other — `ensureBuiltInTemplates`
 *  deliberately does NOT resurrect it (see that mutation's doc), so an org that
 *  doesn't want the newsletter template can actually get rid of it. */
export const archiveTemplate = mutation({
  args: { templateId: v.id("campaignTemplates") },
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
  returns: v.array(v.id("campaignTemplates")),
  handler: async (ctx, { scope, createdBy }) =>
    seedBuiltInTemplates(ctx, scope, createdBy),
});
