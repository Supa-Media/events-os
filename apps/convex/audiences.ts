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
import { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import {
  hasCampaignApprovalPower,
  hasCampaignsAccess,
  requireCampaignsAccess,
} from "./lib/campaignsAccess";
import {
  AUDIENCE_RESOLVE_LIMIT,
  HAND_PICK_LOOKUP_LIMIT,
  resolveAudienceRecipients,
} from "./lib/audienceResolve";
import { listActiveChapters } from "./lib/chapters";
import { normalizeEmail } from "./lib/access";
import { AUDIENCE_SOURCES, audienceFiltersValidator } from "./schema/campaigns";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const sourceValidator = v.union(...AUDIENCE_SOURCES.map((s) => v.literal(s)));

/** Guard shared by create/update: `includePersonIds`/`excludePersonIds` are
 *  human-curated hand-pick lists (Phase 3), so an oversized array is almost
 *  certainly a bug on the caller's end rather than a real 2,000-person manual
 *  pick — reject outright rather than silently truncating someone's list (see
 *  `lib/audienceResolve.ts#HAND_PICK_LOOKUP_LIMIT`'s doc). Also rejects a
 *  personId appearing in BOTH lists at once — an unresolvable contradiction,
 *  not a "exclude wins" case worth guessing at silently. */
function assertValidHandPicks(
  includePersonIds?: Id<"people">[],
  excludePersonIds?: Id<"people">[],
): void {
  for (const [label, ids] of [
    ["includePersonIds", includePersonIds],
    ["excludePersonIds", excludePersonIds],
  ] as const) {
    if (ids && ids.length > HAND_PICK_LOOKUP_LIMIT) {
      throw new ConvexError({
        code: "TOO_MANY",
        message: `${label} can't exceed ${HAND_PICK_LOOKUP_LIMIT} people.`,
      });
    }
  }
  if (includePersonIds && excludePersonIds) {
    const excludeSet = new Set(excludePersonIds);
    if (includePersonIds.some((id) => excludeSet.has(id))) {
      throw new ConvexError({
        code: "CONFLICTING_PICKS",
        message: "A person can't be both included and excluded.",
      });
    }
  }
}

/** Soft visibility check for the campaigns nav entry — never throws, so a
 *  non-privileged user's screen just doesn't render the affordance instead of
 *  crashing. Every actual read/write below uses the throwing
 *  `requireCampaignsAccess` instead. `canApprove` (two-party approval,
 *  2026-07-24) lets the UI decide whether to offer the "pick a reviewer"
 *  dropdown / the reviewer-only decision surface without a separate query. */
export const myCampaignsAccess = query({
  args: {},
  returns: v.object({ canView: v.boolean(), canApprove: v.boolean() }),
  handler: async (ctx) => ({
    canView: await hasCampaignsAccess(ctx),
    canApprove: await hasCampaignApprovalPower(ctx),
  }),
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
    // Phase 3 (person_filters only — see schema doc; harmless-but-unused on
    // a legacy source, mirroring `filters`' own "fields the source ignores
    // sit unused" shape).
    includePersonIds: v.optional(v.array(v.id("people"))),
    excludePersonIds: v.optional(v.array(v.id("people"))),
  },
  handler: async (ctx, { scope, name, source, filters, includePersonIds, excludePersonIds }) => {
    await requireCampaignsAccess(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const trimmed = name.trim();
    if (!trimmed) {
      throw new ConvexError({ code: "EMPTY", message: "Name the audience first." });
    }
    assertValidHandPicks(includePersonIds, excludePersonIds);
    const now = Date.now();
    return await ctx.db.insert("audiences", {
      scope,
      name: trimmed,
      source,
      filters,
      includePersonIds,
      excludePersonIds,
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
    // Phase 3 — `undefined` leaves the stored list untouched; pass `[]`
    // explicitly to clear it (the same "must pass empty array, not omit"
    // convention `filters` doesn't need since it's always a full replace).
    includePersonIds: v.optional(v.array(v.id("people"))),
    excludePersonIds: v.optional(v.array(v.id("people"))),
  },
  handler: async (ctx, { audienceId, name, filters, includePersonIds, excludePersonIds }) => {
    await requireCampaignsAccess(ctx);
    const existing = await ctx.db.get(audienceId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
    }
    assertValidHandPicks(
      includePersonIds ?? existing.includePersonIds,
      excludePersonIds ?? existing.excludePersonIds,
    );
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new ConvexError({ code: "EMPTY", message: "Name the audience first." });
      }
      patch.name = trimmed;
    }
    if (filters !== undefined) patch.filters = filters;
    if (includePersonIds !== undefined) patch.includePersonIds = includePersonIds;
    if (excludePersonIds !== undefined) patch.excludePersonIds = excludePersonIds;
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
    // Phase 3 — a live composer draft's hand-picks, so the preview reflects
    // includes/excludes before the audience is even saved.
    includePersonIds: v.optional(v.array(v.id("people"))),
    excludePersonIds: v.optional(v.array(v.id("people"))),
  },
  returns: v.object({
    count: v.number(),
    sample: v.array(v.object({ name: v.optional(v.string()), email: v.string() })),
    excludedSuppressed: v.number(),
    excludedUnverified: v.number(),
    // Phase 3 (`person_filters` only — always 0 for legacy sources).
    excludedOptOut: v.number(),
    unlinkedCentralDonors: v.number(),
    // The 5,000-recipient cap (`AUDIENCE_RESOLVE_LIMIT`), surfaced instead of
    // silently truncated — `truncatedCount` is exact here (a live query, not
    // a stored snapshot), unlike the campaign row's boolean-only
    // `audienceTruncated` (see `schema/campaigns.ts`).
    truncated: v.boolean(),
    truncatedCount: v.number(),
  }),
  handler: async (ctx, { scope, source, filters, includePersonIds, excludePersonIds }) => {
    await requireCampaignsAccess(ctx);
    const resolution = await resolveAudienceRecipients(ctx, {
      scope,
      source,
      filters,
      includePersonIds,
      excludePersonIds,
    });
    return {
      count: resolution.recipients.length,
      sample: resolution.recipients.slice(0, 10),
      excludedSuppressed: resolution.excludedSuppressed,
      excludedUnverified: resolution.excludedUnverified,
      excludedOptOut: resolution.excludedOptOut,
      unlinkedCentralDonors: resolution.unlinkedCentralDonors,
      truncated: resolution.truncated,
      truncatedCount: resolution.truncatedCount,
    };
  },
});

/**
 * Hand-pick search (Phase 3): name/email PREFIX match across BOTH roster and
 * contacts (never `excludeContacts` — hand-picking is explicitly how a
 * contact becomes reachable, per the schema doc on `person_filters`), bounded
 * per active chapter like every other audience-resolution scan (never
 * `.collect()`). No search index exists on `people.name`/`email` today, so
 * this is an in-memory prefix filter over a bounded per-chapter read — the
 * same "small enough at this org's scale, documented bound" shape
 * `searchPeopleForAudience`'s siblings (`resolvePeople`, etc.) already use.
 */
export const searchPeopleForAudience = query({
  args: {
    search: v.string(),
    chapterId: v.optional(v.id("chapters")),
  },
  returns: v.array(
    v.object({
      personId: v.id("people"),
      name: v.string(),
      email: v.optional(v.string()),
      isContactOnly: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx, { search, chapterId }) => {
    await requireCampaignsAccess(ctx);
    const q = search.trim().toLowerCase();
    if (!q) return [];

    const chapterIds = chapterId ? [chapterId] : (await listActiveChapters(ctx)).map((c) => c._id);
    const results: {
      personId: Id<"people">;
      name: string;
      email?: string;
      isContactOnly?: boolean;
    }[] = [];

    for (const cId of chapterIds) {
      if (results.length >= SEARCH_RESULT_LIMIT) break;
      const rows: Doc<"people">[] = await ctx.db
        .query("people")
        .withIndex("by_chapter", (chapterQ) => chapterQ.eq("chapterId", cId))
        .take(SEARCH_SCAN_PER_CHAPTER_LIMIT);
      for (const p of rows) {
        if (results.length >= SEARCH_RESULT_LIMIT) break;
        if (p.isPlaceholder === true) continue;
        const nameMatch = p.name.trim().toLowerCase().startsWith(q);
        const emailMatch = normalizeEmail(p.email)?.startsWith(q) ?? false;
        if (!nameMatch && !emailMatch) continue;
        results.push({
          personId: p._id,
          name: p.name,
          email: p.email,
          isContactOnly: p.isContactOnly,
        });
      }
    }
    return results;
  },
});

/** Bounded scan-per-chapter and total result caps for `searchPeopleForAudience`
 *  — a hand-pick search box only ever needs "enough to recognize the person
 *  you're looking for," not exhaustive results. */
const SEARCH_SCAN_PER_CHAPTER_LIMIT = 1000;
const SEARCH_RESULT_LIMIT = 20;

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
    v.object({
      recipients: v.array(v.object({ email: v.string(), name: v.optional(v.string()) })),
      truncated: v.boolean(),
    }),
  ),
  handler: async (ctx, { audienceId }) => {
    const audience = await ctx.db.get(audienceId);
    if (!audience) return null;
    const resolution = await resolveAudienceRecipients(ctx, audience, AUDIENCE_RESOLVE_LIMIT);
    return { recipients: resolution.recipients, truncated: resolution.truncated };
  },
});
