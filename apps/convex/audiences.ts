/**
 * Email-campaign audiences — saved, reusable recipient definitions
 * (`schema/campaigns.ts#audiences`) that `campaigns.ts` sends against. See
 * `lib/audienceResolve.ts` for the actual per-source resolution logic; this
 * file is CRUD + access-gating + the two read surfaces that call it
 * (`previewAudience` for the composer, `resolveAudienceForSend` for
 * `campaigns.ts#materializeRecipients`).
 *
 * Access: the whole surface is CENTRAL-only (`lib/campaignsAccess.ts`) — see
 * that file's doc for why. READS (list/get/preview) are desk visibility
 * (`requireCampaignsAccess`); the three WRITES (create/update/archive) are
 * `requireCampaignCompose`, for the same reason every campaign write moved
 * there when the desk widened to the `campaigns.design` rung: an audience is
 * a SEND TARGET, and `campaigns.ts#computeCampaignSnapshotHash` covers an
 * audience's targeting, so editing one silently invalidates an
 * already-approved campaign (which then refuses to send). A design-only
 * holder who cannot create a campaign must not be able to re-aim one.
 */
import { internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { ConvexError, v, type Infer } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import {
  hasCampaignApprovalPower,
  hasCampaignCompose,
  hasCampaignDesign,
  hasCampaignsAccess,
  requireCampaignCompose,
  requireCampaignsAccess,
} from "./lib/campaignsAccess";
import {
  AUDIENCE_RESOLVE_LIMIT,
  HAND_PICK_LOOKUP_LIMIT,
  hasEffectiveExcludeCriteria,
  resolveAudienceRecipients,
  type AudienceFilters,
} from "./lib/audienceResolve";
import { listActiveChapters } from "./lib/chapters";
import { normalizeEmail } from "./lib/access";
import {
  AUDIENCE_SOURCES,
  audienceConditionValidator,
  audienceFiltersValidator,
  audienceTargetingValidator,
} from "./schema/campaigns";
import {
  explainTargetingForPerson,
  normalizeTargeting,
  validateTargeting,
} from "./lib/audienceTargeting";
import { suppressedEmailSet } from "./emailSuppressions";

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

/** Write-time normalization for `excludeFilters` (verification-round finding
 *  B): an INEFFECTIVE value — `undefined`, `{}`, or an object whose only set
 *  field is `verifiedEmailOnly` (never evaluated for excludeFilters — see
 *  `lib/audienceResolve.ts#hasEffectiveExcludeCriteria`'s doc) — is always
 *  stored as `undefined`, never a "shaped but empty" object. This keeps the
 *  picker UI's "seed an empty {} while a group is expanded but nothing's
 *  picked yet" behavior from ever landing in the database as something that
 *  LOOKS different from "no exclude block at all" — and, critically, keeps
 *  `campaigns.ts#computeCampaignSnapshotHash`'s key-omission rule airtight:
 *  that function only has to ask "is `excludeFilters` present," never
 *  re-derive effectiveness itself, because a stored row can never be
 *  present-but-ineffective. */
function normalizeExcludeFilters(excludeFilters: AudienceFilters | undefined): AudienceFilters | undefined {
  return hasEffectiveExcludeCriteria(excludeFilters) ? excludeFilters : undefined;
}

/** Soft visibility check for the campaigns nav entry — never throws, so a
 *  non-privileged user's screen just doesn't render the affordance instead of
 *  crashing. Every actual read/write below uses the throwing
 *  `requireCampaignsAccess` instead.
 *
 *  ONE query, one field per rung of the ladder (`lib/campaignsAccess.ts`'s
 *  module doc), so a screen never has to infer a power it doesn't hold:
 *
 *   - `canView`   — the desk opens at all (design-or-above, or the legacy
 *                   central-ED/FM title). UNCHANGED in meaning; several
 *                   screens gate their whole body on it.
 *   - `canDesign` — themes, saved templates, the image library are editable.
 *   - `canCompose`— campaigns can be created and edited. FALSE for a
 *                   design-only holder (the Graphic Designer), who opens the
 *                   desk for the design system, not for the send.
 *   - `canApprove`— (two-party approval, 2026-07-24) the UI can offer the
 *                   "pick a reviewer" dropdown / the reviewer-only decision
 *                   surface.
 *
 *  `canDesign`/`canCompose` were added 2026-07-28 with the `campaigns.design`
 *  rung: without them a design-only holder got a fully interactive campaign
 *  desk whose every write threw `FORBIDDEN` — a create form that refuses to
 *  create, a composer whose every keystroke fails to autosave. The client
 *  hides the compose-only affordances on `canCompose` instead. */
export const myCampaignsAccess = query({
  args: {},
  returns: v.object({
    canView: v.boolean(),
    canDesign: v.boolean(),
    canCompose: v.boolean(),
    canApprove: v.boolean(),
  }),
  handler: async (ctx) => ({
    canView: await hasCampaignsAccess(ctx),
    canDesign: await hasCampaignDesign(ctx),
    canCompose: await hasCampaignCompose(ctx),
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
    // sit unused" shape). `excludeFilters` is the property-level exclusion
    // block ("everyone matching filters, EXCEPT anyone matching
    // excludeFilters") — see `schema/campaigns.ts#audiences`'s doc.
    excludeFilters: v.optional(audienceFiltersValidator),
    // Targeting v2 (specs/audience-targeting-v2.md): when present it fully
    // defines property-based membership (`filters`/`excludeFilters` are
    // ignored by resolution — see `lib/audienceResolve.ts`); validated
    // structurally via `validateTargeting` before anything is stored.
    targeting: v.optional(audienceTargetingValidator),
    includePersonIds: v.optional(v.array(v.id("people"))),
    excludePersonIds: v.optional(v.array(v.id("people"))),
  },
  handler: async (
    ctx,
    { scope, name, source, filters, excludeFilters, targeting, includePersonIds, excludePersonIds },
  ) => {
    await requireCampaignCompose(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const trimmed = name.trim();
    if (!trimmed) {
      throw new ConvexError({ code: "EMPTY", message: "Name the audience first." });
    }
    assertValidHandPicks(includePersonIds, excludePersonIds);
    if (targeting) validateTargeting(targeting);
    const now = Date.now();
    return await ctx.db.insert("audiences", {
      scope,
      name: trimmed,
      source,
      filters,
      excludeFilters: normalizeExcludeFilters(excludeFilters),
      targeting: targeting ? normalizeTargeting(targeting) : undefined,
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
    // `undefined` leaves the stored excludeFilters untouched; pass `{}`
    // explicitly to clear every exclude criterion back to a no-op (same
    // "full replace" convention `filters` itself uses).
    excludeFilters: v.optional(audienceFiltersValidator),
    // Targeting v2 — `undefined` leaves the stored targeting untouched (no
    // way to CLEAR it back to the legacy model by design: once a row is on
    // v2 it stays there; migration 0042 only ever moves forward).
    targeting: v.optional(audienceTargetingValidator),
    // Phase 3 — `undefined` leaves the stored list untouched; pass `[]`
    // explicitly to clear it (the same "must pass empty array, not omit"
    // convention `filters` doesn't need since it's always a full replace).
    includePersonIds: v.optional(v.array(v.id("people"))),
    excludePersonIds: v.optional(v.array(v.id("people"))),
  },
  handler: async (
    ctx,
    { audienceId, name, filters, excludeFilters, targeting, includePersonIds, excludePersonIds },
  ) => {
    await requireCampaignCompose(ctx);
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
    // A caller passing `{}` (the picker's "cleared the exclude section back
    // to nothing" case) or a `verifiedEmailOnly`-only object must clear the
    // stored field to `undefined`, not persist a "shaped but ineffective"
    // object — see `normalizeExcludeFilters`'s doc. `ctx.db.patch` with an
    // explicit `undefined` value clears an optional field (the `personId`/
    // `isPrimary`-clearing precedent elsewhere in this codebase).
    if (excludeFilters !== undefined) patch.excludeFilters = normalizeExcludeFilters(excludeFilters);
    if (targeting !== undefined) {
      validateTargeting(targeting);
      patch.targeting = normalizeTargeting(targeting);
    }
    if (includePersonIds !== undefined) patch.includePersonIds = includePersonIds;
    if (excludePersonIds !== undefined) patch.excludePersonIds = excludePersonIds;
    await ctx.db.patch(audienceId, patch);
    return null;
  },
});

export const archiveAudience = mutation({
  args: { audienceId: v.id("audiences") },
  handler: async (ctx, { audienceId }) => {
    await requireCampaignCompose(ctx);
    const existing = await ctx.db.get(audienceId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
    }
    await ctx.db.patch(audienceId, { archived: true, updatedAt: Date.now() });
    return null;
  },
});

/** The shape BOTH audience previews return — `previewAudience` (a live,
 *  possibly-unsaved builder draft) and `previewAudienceById` (a saved row).
 *  Shared verbatim so the two can never drift into reporting different
 *  fields for the same underlying resolution. */
const audiencePreviewValidator = v.object({
    count: v.number(),
    // `groups` — targeting-v2 drafts only: which include-group indexes this
    // sample row matched (empty for hand-pick-only members and legacy rows).
    sample: v.array(
      v.object({
        name: v.optional(v.string()),
        email: v.string(),
        groups: v.optional(v.array(v.number())),
      }),
    ),
    excludedSuppressed: v.number(),
    excludedUnverified: v.number(),
    // `person_filters` AND `people` (data-trust fix — previously always 0 for
    // `people`, a silent drop; see `lib/audienceResolve.ts#resolvePeople`'s
    // doc). Always 0 for `guests`/`donors`.
    excludedOptOut: v.number(),
    unlinkedCentralDonors: v.number(),
    // ── Additive data-trust counters (below) — every existing field above is
    // unchanged; these are new optional-shaped signals so an older client
    // that doesn't render them yet loses nothing. See
    // `lib/audienceResolve.ts#AudienceResolution`'s doc for each field. ──
    centralDonorsExcludedByChapterFilter: v.number(),
    unlinkedGuests: v.number(),
    unlinkedGuestsIsLowerBound: v.boolean(),
    handPickedUnverified: v.number(),
    // `person_filters` only — how many otherwise-matching people were
    // removed by `excludeFilters` (primary count) and, of those, how many
    // were ALSO a hand-picked include (diagnostic — an exclusion beating a
    // hand-pick). See `lib/audienceResolve.ts#AudienceResolution`'s doc.
    excludedByFilters: v.number(),
    handPickedExcludedByFilters: v.number(),
    // The 5,000-recipient cap (`AUDIENCE_RESOLVE_LIMIT`), surfaced instead of
    // silently truncated — `truncatedCount` is exact here (a live query, not
    // a stored snapshot), unlike the campaign row's boolean-only
    // `audienceTruncated` (see `schema/campaigns.ts`).
    truncated: v.boolean(),
    truncatedCount: v.number(),
    // Targeting-v2 drafts only (always `[]` for legacy shapes): per-group
    // match counts for the builder's group cards, and per-exclude-group
    // removal counts for its skip lists. Groups overlap — the sum can exceed
    // `count`; the UI labels that.
    perGroupCounts: v.array(v.number()),
    perExcludeGroupCounts: v.array(v.number()),
  });

export const previewAudience = query({
  args: {
    scope: scopeValidator,
    source: sourceValidator,
    filters: audienceFiltersValidator,
    // Property-level exclusions ("everyone matching filters, EXCEPT anyone
    // matching excludeFilters") — a live composer draft's exclude block, so
    // the preview reflects it before the audience is even saved. Same shape
    // as `filters`, `person_filters` only — see `schema/campaigns.ts#audiences`.
    excludeFilters: v.optional(audienceFiltersValidator),
    // Targeting v2 — a live builder draft's groups, previewed before saving
    // (validated structurally first, same as create/update).
    targeting: v.optional(audienceTargetingValidator),
    // Phase 3 — a live composer draft's hand-picks, so the preview reflects
    // includes/excludes before the audience is even saved.
    includePersonIds: v.optional(v.array(v.id("people"))),
    excludePersonIds: v.optional(v.array(v.id("people"))),
  },
  returns: audiencePreviewValidator,
  handler: async (
    ctx,
    { scope, source, filters, excludeFilters, targeting, includePersonIds, excludePersonIds },
  ) => {
    await requireCampaignsAccess(ctx);
    if (targeting) validateTargeting(targeting);
    return await buildAudiencePreview(ctx, {
      scope,
      source,
      filters,
      excludeFilters,
      targeting,
      includePersonIds,
      excludePersonIds,
    });
  },
});

/**
 * Preview a SAVED audience by id — the same numbers `previewAudience`
 * produces, resolved from the stored row itself.
 *
 * ── Why this exists (founder bug, 2026-07-30) ──────────────────────────────
 * The campaign record page hand-assembled `previewAudience` args off the
 * audience row: `{ scope, source, filters, excludeFilters }`. That list was
 * complete when it was written, and then two more targeting dimensions
 * shipped — hand-picks (`includePersonIds`/`excludePersonIds`, Phase 3) and
 * `targeting` (v2) — and nothing updated the call site. A segment defined
 * ENTIRELY by hand-picks therefore previewed as its bare source with no
 * criteria at all: a 4-person "Marketing Team" segment read "Reaches 440
 * people" on the very screen you decide to send from. (The SEND was always
 * correct — it resolves the stored row via `resolveAudienceForSend` — so this
 * was a lie in the UI, not a mis-send. It still sat directly above "Request
 * approval", and it was also the number the reviewer saw.)
 *
 * Taking the id instead of a field list is what makes that class of bug
 * impossible here: a future targeting dimension lands in the stored row and
 * flows through automatically, with no call site left to forget it. The
 * draft-shaped `previewAudience` above stays exactly as it is — the audience
 * BUILDER genuinely needs to preview a shape that isn't saved yet.
 *
 * `null` when the audience no longer exists (deleted out from under a
 * campaign that still references it) — the caller renders "Segment deleted"
 * rather than a stale count.
 */
export const previewAudienceById = query({
  args: { audienceId: v.id("audiences") },
  returns: v.union(audiencePreviewValidator, v.null()),
  handler: async (ctx, { audienceId }) => {
    await requireCampaignsAccess(ctx);
    const audience = await ctx.db.get(audienceId);
    if (!audience) return null;
    // The whole row goes to the resolver — the same thing
    // `resolveAudienceForSend` and `campaigns.ts#liveAudienceCount` do, and
    // the entire point of this query.
    return await buildAudiencePreview(ctx, audience);
  },
});

/** The shared body of both previews above. Split out so the by-id variant
 *  can't drift from the draft variant in what it counts or reports. */
async function buildAudiencePreview(
  ctx: QueryCtx,
  definition: Parameters<typeof resolveAudienceRecipients>[1],
): Promise<Infer<typeof audiencePreviewValidator>> {
  {
    const { targeting } = definition;
    // `includeDiagnostics: true` — these are the ONLY callers that should pay
    // for the extra data-trust transparency scans (`unlinkedGuests`/
    // `centralDonorsExcludedByChapterFilter`); the send path
    // (`resolveAudienceForSend` below) and `campaigns.ts#liveAudienceCount`
    // deliberately leave it at its `false` default — see
    // `lib/audienceResolve.ts#resolveAudienceRecipients`'s doc.
    const resolution = await resolveAudienceRecipients(
      ctx,
      definition,
      AUDIENCE_RESOLVE_LIMIT,
      true,
    );
    return {
      count: resolution.recipients.length,
      sample: resolution.recipients.slice(0, 10).map((r) => ({
        ...r,
        groups: targeting ? (resolution.matchedGroupsByEmail[r.email] ?? []) : undefined,
      })),
      excludedSuppressed: resolution.excludedSuppressed,
      excludedUnverified: resolution.excludedUnverified,
      excludedOptOut: resolution.excludedOptOut,
      unlinkedCentralDonors: resolution.unlinkedCentralDonors,
      centralDonorsExcludedByChapterFilter: resolution.centralDonorsExcludedByChapterFilter,
      unlinkedGuests: resolution.unlinkedGuests,
      unlinkedGuestsIsLowerBound: resolution.unlinkedGuestsIsLowerBound,
      handPickedUnverified: resolution.handPickedUnverified,
      excludedByFilters: resolution.excludedByFilters,
      handPickedExcludedByFilters: resolution.handPickedExcludedByFilters,
      truncated: resolution.truncated,
      truncatedCount: resolution.truncatedCount,
      perGroupCounts: resolution.perGroupCounts,
      perExcludeGroupCounts: resolution.perExcludeGroupCounts,
    };
  }
}

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

const groupVerdictValidator = v.object({
  matched: v.boolean(),
  conditions: v.array(v.object({ condition: audienceConditionValidator, pass: v.boolean() })),
});

/**
 * "Check a person" (targeting v2's trust feature — spec §"Explainability"):
 * per-condition pass/fail for ONE person against a (possibly unsaved draft)
 * targeting shape, plus the final verdict in the same decision order the real
 * resolution applies — powered by `lib/audienceTargeting.ts#
 * explainTargetingForPerson`, the SAME evaluator resolution uses, so this can
 * never disagree with the actual send. Single-person read cost (see that
 * function's doc) — fine for a live search box.
 */
export const explainAudiencePerson = query({
  args: {
    scope: scopeValidator,
    targeting: audienceTargetingValidator,
    includePersonIds: v.optional(v.array(v.id("people"))),
    excludePersonIds: v.optional(v.array(v.id("people"))),
    personId: v.id("people"),
  },
  returns: v.object({
    verdict: v.union(
      v.literal("recipient"),
      v.literal("no_match"),
      v.literal("excluded"),
      v.literal("hand_pick_excluded"),
      v.literal("opted_out"),
      v.literal("suppressed"),
      v.literal("no_address"),
    ),
    groups: v.array(groupVerdictValidator),
    excludeGroups: v.array(groupVerdictValidator),
    handPicked: v.boolean(),
  }),
  handler: async (ctx, { scope, targeting, includePersonIds, excludePersonIds, personId }) => {
    await requireCampaignsAccess(ctx);
    validateTargeting(targeting);
    const person = await ctx.db.get(personId);
    if (!person || person.isPlaceholder === true) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Person not found." });
    }
    const suppressed = await suppressedEmailSet(ctx);
    return explainTargetingForPerson(
      ctx,
      { scope, targeting, includePersonIds, excludePersonIds },
      person,
      suppressed,
    );
  },
});

/**
 * Send-time resolution: `campaigns.ts#materializeRecipients` (an action, no
 * `ctx.db`) calls this via `ctx.runQuery` to get the bounded, deduped,
 * suppression-filtered recipient list to materialize into `campaignRecipients`
 * rows. NEVER exposed as a public function — a send always goes through the
 * `campaigns.send` mutation's access gate first.
 *
 * Deliberately leaves `resolveAudienceRecipients`'s `includeDiagnostics` at
 * its `false` default — the data-trust transparency counters are a preview
 * affordance, not a send-time one, and the extra bounded scans they cost
 * have no business running against a real send's read budget (see that
 * function's doc — the read-budget incident class hotfix #414 addressed).
 * The returned shape only ever carries `recipients`/`truncated` anyway, so
 * the diagnostic fields wouldn't even be surfaced if computed.
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
