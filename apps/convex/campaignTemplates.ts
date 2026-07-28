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
 * A template is just an `EmailDocument` with a name: `createCampaignFromTemplate`
 * copies it into a fresh draft campaign, and `createTemplateFromCampaign`
 * snapshots a campaign back the other way ("this month's came out well — make
 * it the starting point for next month"). Both directions COPY; a campaign
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
import { applyThemeToDoc, docHasTheme } from "./campaigns";
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
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found." });
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
      throw new ConvexError({ code: "EMPTY", message: "Name the campaign first." });
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
