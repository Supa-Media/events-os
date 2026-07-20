/**
 * Email-campaign audiences — saved, reusable recipient definitions
 * (`schema/campaigns.ts#audiences`) that `campaigns.ts` sends against. See
 * `lib/audienceResolve.ts` for the actual per-source resolution logic; this
 * file is CRUD + access-gating + the two read surfaces that call it
 * (`previewAudience` for the composer, `resolveAudienceForSend` for
 * `campaigns.ts#materializeRecipients`).
 *
 * Access: the whole surface is CENTRAL-only (`lib/campaignsAccess.ts`) — see
 * that file's doc for why.
 */
import { internalQuery, mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { hasCampaignsAccess, requireCampaignsAccess } from "./lib/campaignsAccess";
import {
  AUDIENCE_RESOLVE_LIMIT,
  resolveAudienceRecipients,
} from "./lib/audienceResolve";
import { AUDIENCE_SOURCES, audienceFiltersValidator } from "./schema/campaigns";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const sourceValidator = v.union(...AUDIENCE_SOURCES.map((s) => v.literal(s)));

/** Soft visibility check for the campaigns nav entry — never throws, so a
 *  non-privileged user's screen just doesn't render the affordance instead of
 *  crashing. Every actual read/write below uses the throwing
 *  `requireCampaignsAccess` instead. */
export const myCampaignsAccess = query({
  args: {},
  returns: v.object({ canView: v.boolean() }),
  handler: async (ctx) => ({ canView: await hasCampaignsAccess(ctx) }),
});

export const listAudiences = query({
  args: { scope: v.optional(scopeValidator) },
  handler: async (ctx, { scope }) => {
    await requireCampaignsAccess(ctx);
    const rows = scope
      ? await ctx.db
          .query("audiences")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .take(500)
      : await ctx.db.query("audiences").take(500);
    return rows.filter((a) => a.archived !== true);
  },
});

export const getAudience = query({
  args: { audienceId: v.id("audiences") },
  handler: async (ctx, { audienceId }) => {
    await requireCampaignsAccess(ctx);
    const audience = await ctx.db.get(audienceId);
    if (!audience) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
    }
    return audience;
  },
});

export const createAudience = mutation({
  args: {
    scope: scopeValidator,
    name: v.string(),
    source: sourceValidator,
    filters: audienceFiltersValidator,
  },
  handler: async (ctx, { scope, name, source, filters }) => {
    await requireCampaignsAccess(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const trimmed = name.trim();
    if (!trimmed) {
      throw new ConvexError({ code: "EMPTY", message: "Name the audience first." });
    }
    const now = Date.now();
    return await ctx.db.insert("audiences", {
      scope,
      name: trimmed,
      source,
      filters,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateAudience = mutation({
  args: {
    audienceId: v.id("audiences"),
    name: v.optional(v.string()),
    filters: v.optional(audienceFiltersValidator),
  },
  handler: async (ctx, { audienceId, name, filters }) => {
    await requireCampaignsAccess(ctx);
    const existing = await ctx.db.get(audienceId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new ConvexError({ code: "EMPTY", message: "Name the audience first." });
      }
      patch.name = trimmed;
    }
    if (filters !== undefined) patch.filters = filters;
    await ctx.db.patch(audienceId, patch);
    return null;
  },
});

export const archiveAudience = mutation({
  args: { audienceId: v.id("audiences") },
  handler: async (ctx, { audienceId }) => {
    await requireCampaignsAccess(ctx);
    const existing = await ctx.db.get(audienceId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
    }
    await ctx.db.patch(audienceId, { archived: true, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Composer preview: resolves a (possibly unsaved draft) audience shape to a
 * bounded sample. `count` is the number of recipients that WOULD be sent to,
 * capped at `AUDIENCE_RESOLVE_LIMIT` — a preview against an audience larger
 * than the cap reports the cap, not the true size (documented, not silent:
 * the composer should show "5,000+" rather than a bare number in that case).
 */
export const previewAudience = query({
  args: {
    scope: scopeValidator,
    source: sourceValidator,
    filters: audienceFiltersValidator,
  },
  returns: v.object({
    count: v.number(),
    sample: v.array(v.object({ name: v.optional(v.string()), email: v.string() })),
    excludedSuppressed: v.number(),
    excludedUnverified: v.number(),
  }),
  handler: async (ctx, { scope, source, filters }) => {
    await requireCampaignsAccess(ctx);
    const resolution = await resolveAudienceRecipients(ctx, { scope, source, filters });
    return {
      count: resolution.recipients.length,
      sample: resolution.recipients.slice(0, 10),
      excludedSuppressed: resolution.excludedSuppressed,
      excludedUnverified: resolution.excludedUnverified,
    };
  },
});

/**
 * Send-time resolution: `campaigns.ts#materializeRecipients` (an action, no
 * `ctx.db`) calls this via `ctx.runQuery` to get the bounded, deduped,
 * suppression-filtered recipient list to materialize into `campaignRecipients`
 * rows. NEVER exposed as a public function — a send always goes through the
 * `campaigns.send` mutation's access gate first.
 */
export const resolveAudienceForSend = internalQuery({
  args: { audienceId: v.id("audiences") },
  returns: v.union(
    v.null(),
    v.array(v.object({ email: v.string(), name: v.optional(v.string()) })),
  ),
  handler: async (ctx, { audienceId }) => {
    const audience = await ctx.db.get(audienceId);
    if (!audience) return null;
    const resolution = await resolveAudienceRecipients(ctx, audience, AUDIENCE_RESOLVE_LIMIT);
    return resolution.recipients;
  },
});
