/**
 * Territories (giving-territories addendum — supersedes `cityCampaigns.ts`).
 * A territory maps 1:1 with a real `chapters` row: creating a prospect
 * territory CREATES a "shadow chapter" (`isActive: false`) in the same
 * mutation, and prospect pledges/donors/gifts scope DIRECTLY to that chapter.
 * Launch is a flag-flip (`chapters.isActive: true`) — no re-scope. See
 * `docs/plans/giving-territories.md`.
 *
 * Three parts:
 *  - ADMIN (gated `giving.manage`/`giving.view` at central — the map is a
 *    central surface, like the milestone ladder): create/edit + stage
 *    transitions + the desk list.
 *  - PUBLIC (no auth — aggregates only, mirrors `giving.ts`'s public reads):
 *    the map's dot list and one territory's page data.
 *  - `resolveTerritoryForCheckout` (internal): slug → the chapter to back.
 *
 * Money/PII discipline: public queries here NEVER return a donor name, email,
 * or gift-level detail — only the aggregates the map/territory page renders.
 * A territory carries NO backer counter of its own: the backer count is ALWAYS
 * read from its linked `chapter.backerCount` (derived by
 * `givingPledges.recomputeChapterBackerCount`), so there is one number per
 * place and it can never drift.
 */
import { internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  AFFORDABILITY_TIERS,
  affordabilityTierLabel,
  easternParts,
  financeRoleAtLeast,
  launchTemplateTotalCents,
  type TierLike,
} from "@events-os/shared";
import {
  requireGivingManage,
  requireGivingView,
  resolveGivingAccess,
} from "./lib/givingAccess";
import { getChapterIdOrNull, requireUserId } from "./lib/context";
import { getFinanceRole } from "./lib/finance";
import { TERRITORY_STAGES } from "./schema/territories";
import { MAX_MILESTONES } from "./backerMilestones";
import { buildChapterRolesAndTemplates } from "./lib/seed/templates";

const stageValidator = v.union(...TERRITORY_STAGES.map((s) => v.literal(s)));
type TerritoryStage = (typeof TERRITORY_STAGES)[number];

/** A generous bound on the admin territory list — the map is a handful of
 *  places at a time, nowhere near this. */
const TERRITORY_LIST_LIMIT = 500;

/** Bounded window scan for the public pot's month series + the readiness
 *  desk's per-chapter pledge sum (range/index reads, never a full scan). */
const GIFT_WINDOW_LIMIT = 10000;
const PLEDGE_SCAN_LIMIT = 5000;

/** A hair over 12 months so the earliest month-of-interest is fully covered by
 *  the `receivedAt` lower bound; buckets outside the 12 labels are dropped. */
const TWELVE_MONTHS_MS = 375 * 24 * 60 * 60 * 1000;

/** `"YYYY-MM"` (Eastern) for a timestamp — the pot's month-bucket key. */
function monthKey(ts: number): string {
  const { year, month } = easternParts(ts);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The last 12 Eastern month labels, oldest→newest, ending in `now`'s month. */
function lastTwelveMonthLabels(now: number): string[] {
  const { year, month } = easternParts(now); // 1-based month
  const labels: string[] = [];
  for (let i = 11; i >= 0; i--) {
    let y = year;
    let m = month - i;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    labels.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return labels;
}

/** The tier ladder finance uses (configured `backerMilestones`, else the shared
 *  `AFFORDABILITY_TIERS` fallback) — resolved exactly like
 *  `finances.chapterAffordability`. Returns `undefined` to let
 *  `affordabilityTierLabel` fall back to its own default. */
async function resolveTierLadder(
  ctx: QueryCtx,
): Promise<readonly TierLike[] | undefined> {
  const milestoneRows = await ctx.db
    .query("backerMilestones")
    .withIndex("by_minBackers")
    .order("asc")
    .take(MAX_MILESTONES + 1);
  return milestoneRows.length > 0
    ? milestoneRows.map((m) => ({ minBackers: m.minBackers, label: m.label }))
    : undefined;
}

/** Sum of a chapter's ACTIVE monthly pledge amounts (bounded index read). */
async function activePledgeMonthlyCents(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<number> {
  const active = await ctx.db
    .query("pledges")
    .withIndex("by_scope_and_status", (q) =>
      q.eq("scope", chapterId).eq("status", "active"),
    )
    .take(PLEDGE_SCAN_LIMIT);
  return active.reduce((sum, p) => sum + p.amountCents, 0);
}

/** `<slug>` — lowercase letters/digits, dash-separated, no leading/trailing/
 *  double dashes. The `/give/<slug>` URL segment. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Validation guards ────────────────────────────────────────────────────────

function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new ConvexError({
      code: "INVALID_SLUG",
      message:
        "Slug must be lowercase letters, numbers, and single dashes (e.g. \"queens-ny\").",
    });
  }
}

function assertValidLatLng(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ConvexError({
      code: "INVALID_LAT",
      message: "Latitude must be between -90 and 90.",
    });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new ConvexError({
      code: "INVALID_LNG",
      message: "Longitude must be between -180 and 180.",
    });
  }
}

function assertPositiveTarget(targetBackers: number): void {
  if (!Number.isInteger(targetBackers) || targetBackers <= 0) {
    throw new ConvexError({
      code: "INVALID_TARGET",
      message: "Target backers must be a positive whole number.",
    });
  }
}

function assertNonNegativeCents(cents: number): void {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "Launch-fund target must be a whole number of cents ≥ 0.",
    });
  }
}

/** The ladder's lowest `minBackers` rung — the default `targetBackers` for a
 *  freshly created territory (falls back to `AFFORDABILITY_TIERS` when the
 *  configurable ladder, `backerMilestones`, is empty — the same fallback rule
 *  `chapterAffordability` uses). */
async function defaultTargetBackers(ctx: MutationCtx): Promise<number> {
  const rows = await ctx.db
    .query("backerMilestones")
    .withIndex("by_minBackers")
    .order("asc")
    .take(1);
  if (rows.length > 0) return rows[0].minBackers;
  const lowest = [...AFFORDABILITY_TIERS].sort(
    (a, b) => a.minBackers - b.minBackers,
  )[0];
  return lowest?.minBackers ?? 20;
}

/**
 * A slug is available iff it collides with NO other territory AND no other
 * chapter (a shadow chapter carries the territory's slug, and a launched
 * chapter's slug — e.g. "new-york" — must never be re-taken). `territoryId` /
 * `chapterId` exclude the territory's own rows on an edit.
 */
async function assertSlugAvailable(
  ctx: MutationCtx,
  slug: string,
  self: { territoryId?: Id<"territories">; chapterId?: Id<"chapters"> },
): Promise<void> {
  const territory = await ctx.db
    .query("territories")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .first();
  if (territory && territory._id !== self.territoryId) {
    throw new ConvexError({
      code: "SLUG_TAKEN",
      message: `The slug "${slug}" is already in use by another territory.`,
    });
  }
  const chapter = await ctx.db
    .query("chapters")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .first();
  if (chapter && chapter._id !== self.chapterId) {
    throw new ConvexError({
      code: "SLUG_TAKEN",
      message: `The slug "${slug}" is already in use by a chapter.`,
    });
  }
}

/** The territory linked to a chapter (1:1 by convention), or null. */
export async function territoryForChapter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"territories"> | null> {
  return await ctx.db
    .query("territories")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .first();
}

// ── Checkout routing (internal — used by the public /api/give/pledge route) ──

/**
 * Resolve a territory slug to the chapter a pledge should back. Prospect/
 * raising territories resolve to their (inactive) shadow chapter — the
 * `preparePledge` guard is what confirms the territory is publicly backable;
 * launched territories resolve to their live chapter. Returns `null` for an
 * unknown or hidden slug — the HTTP route surfaces that as a friendly
 * "not available", never a 500.
 */
export const resolveTerritoryForCheckout = internalQuery({
  args: { slug: v.string() },
  returns: v.union(v.object({ chapterId: v.id("chapters") }), v.null()),
  handler: async (ctx, { slug }) => {
    const territory = await ctx.db
      .query("territories")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!territory || !territory.publiclyVisible) return null;
    return { chapterId: territory.chapterId };
  },
});

// ── Admin (gated at central) ─────────────────────────────────────────────────

const territoryAdminValidator = v.object({
  _id: v.id("territories"),
  chapterId: v.id("chapters"),
  name: v.string(),
  region: v.string(),
  lat: v.number(),
  lng: v.number(),
  slug: v.string(),
  stage: stageValidator,
  targetBackers: v.number(),
  story: v.union(v.string(), v.null()),
  publiclyVisible: v.boolean(),
  launchFundCents: v.number(),
  launchFundTargetCents: v.number(),
  launchedAt: v.union(v.number(), v.null()),
  // Joined from the linked chapter — the single source of truth for the count.
  backerCount: v.number(),
  chapterIsActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

async function toAdminRow(ctx: QueryCtx, row: Doc<"territories">) {
  const chapter = await ctx.db.get(row.chapterId);
  return {
    _id: row._id,
    chapterId: row.chapterId,
    name: row.name,
    region: row.region,
    lat: row.lat,
    lng: row.lng,
    slug: row.slug,
    stage: row.stage,
    targetBackers: row.targetBackers,
    story: row.story ?? null,
    publiclyVisible: row.publiclyVisible,
    launchFundCents: row.launchFundCents,
    launchFundTargetCents: row.launchFundTargetCents,
    launchedAt: row.launchedAt ?? null,
    backerCount: chapter?.backerCount ?? 0,
    chapterIsActive: chapter?.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every territory, newest first — the Territories desk list, each joined with
 *  its chapter's live backer count + the launch-pot fields. Central
 *  `giving.view` (the map is a central surface, not a per-chapter one). */
export const listTerritoriesAdmin = query({
  args: {},
  returns: v.array(territoryAdminValidator),
  handler: async (ctx) => {
    await requireGivingView(ctx, "central");
    const rows = await ctx.db
      .query("territories")
      .order("desc")
      .take(TERRITORY_LIST_LIMIT);
    return await Promise.all(rows.map((r) => toAdminRow(ctx, r)));
  },
});

/**
 * Create or update a territory (central `giving.manage`).
 *
 * CREATE inserts BOTH a shadow chapter (`isActive: false`, `backerCount: 0`)
 * AND the territory row in ONE mutation — this is THE chapter-creation flow the
 * `seed.ts:ensureChapters` comment promised. Increase provisioning is NOT
 * scheduled here; that happens at launch (`setTerritoryStage`).
 *
 * EDIT patches territory fields (and the chapter's name if the territory was
 * renamed). Slug is validated for format + uniqueness against BOTH tables.
 */
export const saveTerritory = mutation({
  args: {
    territoryId: v.optional(v.id("territories")),
    name: v.string(),
    region: v.string(),
    lat: v.number(),
    lng: v.number(),
    slug: v.string(),
    targetBackers: v.optional(v.number()),
    story: v.optional(v.string()),
    publiclyVisible: v.boolean(),
    launchFundTargetCents: v.optional(v.number()),
  },
  returns: v.id("territories"),
  handler: async (ctx, args) => {
    await requireGivingManage(ctx, "central");

    const name = args.name.trim();
    const region = args.region.trim();
    if (!name) {
      throw new ConvexError({
        code: "INVALID_NAME",
        message: "A territory name is required.",
      });
    }
    if (!region) {
      throw new ConvexError({
        code: "INVALID_REGION",
        message: "A region (state/province) is required.",
      });
    }
    const slug = args.slug.trim().toLowerCase();
    assertValidSlug(slug);
    assertValidLatLng(args.lat, args.lng);
    const story = args.story?.trim() || undefined;
    const now = Date.now();

    if (args.territoryId) {
      const existing = await ctx.db.get(args.territoryId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "Territory not found.",
        });
      }
      await assertSlugAvailable(ctx, slug, {
        territoryId: existing._id,
        chapterId: existing.chapterId,
      });
      const targetBackers = args.targetBackers ?? existing.targetBackers;
      assertPositiveTarget(targetBackers);
      const launchFundTargetCents =
        args.launchFundTargetCents ?? existing.launchFundTargetCents;
      assertNonNegativeCents(launchFundTargetCents);

      await ctx.db.patch(existing._id, {
        name,
        region,
        lat: args.lat,
        lng: args.lng,
        slug,
        targetBackers,
        story,
        publiclyVisible: args.publiclyVisible,
        launchFundTargetCents,
        updatedAt: now,
      });
      // Keep the linked chapter's display name in step with a rename.
      const chapter = await ctx.db.get(existing.chapterId);
      if (chapter && chapter.name !== name) {
        await ctx.db.patch(existing.chapterId, { name });
      }
      return existing._id;
    }

    // CREATE: shadow chapter + territory, atomically.
    const targetBackers =
      args.targetBackers ?? (await defaultTargetBackers(ctx));
    assertPositiveTarget(targetBackers);
    const launchFundTargetCents =
      args.launchFundTargetCents ?? launchTemplateTotalCents();
    assertNonNegativeCents(launchFundTargetCents);
    await assertSlugAvailable(ctx, slug, {});
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const chapterId = (await ctx.db.insert("chapters", {
      name,
      slug,
      isActive: false, // shadow chapter — launch flips this true
      backerCount: 0,
      createdAt: now,
    })) as Id<"chapters">;

    return await ctx.db.insert("territories", {
      chapterId,
      name,
      region,
      lat: args.lat,
      lng: args.lng,
      slug,
      stage: "prospect",
      targetBackers,
      story,
      publiclyVisible: args.publiclyVisible,
      launchFundCents: 0,
      launchFundTargetCents,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
    });
  },
});

/**
 * Transition a territory's stage (central `giving.manage`).
 *
 * `prospect` ⇄ `raising` are free moves. `launched` needs NOTHING extra — the
 * chapter already exists — so it just: flips the shadow chapter live
 * (`isActive: true`), stamps `launchedAt`, schedules the Increase
 * provisioning, and seeds the chapter's default roles/templates (mirroring
 * `seed.ensureChapters`). `launched` is TERMINAL in v1 — a reverse transition
 * is rejected. Re-launching an already-launched territory is a safe no-op.
 */
export const setTerritoryStage = mutation({
  args: { territoryId: v.id("territories"), stage: stageValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGivingManage(ctx, "central");
    const territory = await ctx.db.get(args.territoryId);
    if (!territory) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Territory not found." });
    }

    const stage: TerritoryStage = args.stage;
    const now = Date.now();

    if (territory.stage === "launched") {
      // Terminal: launched only ever re-affirms launched (idempotent no-op).
      if (stage !== "launched") {
        throw new ConvexError({
          code: "INVALID_TRANSITION",
          message: "A launched territory can't move back to prospect or raising.",
        });
      }
      return null;
    }

    if (stage === "launched") {
      const chapter = await ctx.db.get(territory.chapterId);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
      }
      // Flip the shadow chapter live + stamp the launch.
      await ctx.db.patch(territory.chapterId, { isActive: true });
      await ctx.db.patch(territory._id, {
        stage: "launched",
        launchedAt: now,
        updatedAt: now,
      });
      // Provision banking (mirrors `ensureChapters`' scheduled provisioning).
      await ctx.scheduler.runAfter(
        0,
        internal.increase.provisionAccountForScope,
        { scope: territory.chapterId },
      );
      // Seed the chapter's default roles + templates (mirrors `ensureChapters`).
      // The shadow chapter had none while prospect; this launch transition runs
      // exactly once (launched is terminal + idempotent above).
      const userId = (await requireUserId(ctx)) as Id<"users">;
      await buildChapterRolesAndTemplates(
        ctx,
        territory.chapterId,
        userId,
        now,
      );
      return null;
    }

    // prospect ⇄ raising
    await ctx.db.patch(territory._id, { stage, updatedAt: now });
    return null;
  },
});

// ── Public (no auth — aggregates only, never donor PII) ──────────────────────

const publicMapRowValidator = v.object({
  name: v.string(),
  region: v.string(),
  lat: v.number(),
  lng: v.number(),
  slug: v.string(),
  stage: stageValidator,
  backerCount: v.number(),
  targetBackers: v.number(),
});

/**
 * Every `publiclyVisible` territory's map dot: name/region/lat/lng/slug/stage/
 * backerCount/targetBackers — nothing else. `backerCount` is ALWAYS the linked
 * chapter's live count (a prospect's shadow chapter carries it just as a
 * launched chapter does). No auth: this is the `/give` map's data source.
 */
export const getPublicMapData = query({
  args: {},
  returns: v.array(publicMapRowValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query("territories").take(TERRITORY_LIST_LIMIT);
    const visible = rows.filter((r) => r.publiclyVisible);
    const out: Array<{
      name: string;
      region: string;
      lat: number;
      lng: number;
      slug: string;
      stage: TerritoryStage;
      backerCount: number;
      targetBackers: number;
    }> = [];
    for (const row of visible) {
      const chapter = await ctx.db.get(row.chapterId);
      out.push({
        name: row.name,
        region: row.region,
        lat: row.lat,
        lng: row.lng,
        slug: row.slug,
        stage: row.stage,
        backerCount: chapter?.backerCount ?? 0,
        targetBackers: row.targetBackers,
      });
    }
    return out;
  },
});

const milestoneRungValidator = v.object({
  minBackers: v.number(),
  label: v.string(),
  commitment: v.string(),
  description: v.optional(v.string()),
});

const publicTerritoryValidator = v.union(
  v.object({
    name: v.string(),
    region: v.string(),
    slug: v.string(),
    stage: stageValidator,
    backerCount: v.number(),
    targetBackers: v.number(),
    story: v.union(v.string(), v.null()),
    milestones: v.array(milestoneRungValidator),
    nextMilestone: v.union(milestoneRungValidator, v.null()),
    // The pre-launch launch pot (docs/plans/giving-territories.md §D3), or
    // `null` once the territory has launched (the pot is frozen + the live
    // chapter funds itself). `months` is the last-12 Eastern-month gift series
    // ("watch the pot go up"), oldest→newest.
    launchFund: v.union(
      v.object({
        cents: v.number(),
        targetCents: v.number(),
        months: v.array(
          v.object({ month: v.string(), cents: v.number() }),
        ),
      }),
      v.null(),
    ),
  }),
  v.null(),
);

/**
 * One territory's public page data (by slug): the map-row aggregates + its
 * story + the milestone ladder (configured `backerMilestones`, falling back to
 * `AFFORDABILITY_TIERS` exactly like `chapterAffordability`) with the
 * next-unlock rung computed against the live `backerCount` (from the chapter).
 * Returns `null` for an unknown or hidden slug — the HTTP route renders a 404
 * either way, so a hidden territory is indistinguishable from a nonexistent one.
 */
export const getPublicTerritory = query({
  args: { slug: v.string() },
  returns: publicTerritoryValidator,
  handler: async (ctx, { slug }) => {
    const territory = await ctx.db
      .query("territories")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!territory || !territory.publiclyVisible) return null;

    const chapter = await ctx.db.get(territory.chapterId);
    const backerCount = chapter?.backerCount ?? 0;

    const milestoneRows = await ctx.db
      .query("backerMilestones")
      .withIndex("by_minBackers")
      .order("asc")
      .take(MAX_MILESTONES + 1);
    const milestones =
      milestoneRows.length > 0
        ? milestoneRows.map((m) => ({
            minBackers: m.minBackers,
            label: m.label,
            commitment: m.commitment,
            description: m.description,
          }))
        : [...AFFORDABILITY_TIERS]
            .sort((a, b) => a.minBackers - b.minBackers)
            .map((t) => ({
              minBackers: t.minBackers,
              label: t.label,
              commitment: t.label,
              description: undefined,
            }));

    const nextMilestone =
      milestones.find((m) => m.minBackers > backerCount) ?? null;

    // The launch pot — only while pre-launch; a launched territory freezes it
    // and returns `null` (the public page renders the launched state instead).
    let launchFund: {
      cents: number;
      targetCents: number;
      months: Array<{ month: string; cents: number }>;
    } | null = null;
    if (territory.stage !== "launched") {
      const now = Date.now();
      const labels = lastTwelveMonthLabels(now);
      const recent = await ctx.db
        .query("gifts")
        .withIndex("by_scope_and_received", (q) =>
          q.eq("scope", territory.chapterId).gte("receivedAt", now - TWELVE_MONTHS_MS),
        )
        .take(GIFT_WINDOW_LIMIT);
      const byMonth = new Map<string, number>();
      for (const g of recent) {
        const key = monthKey(g.receivedAt);
        byMonth.set(key, (byMonth.get(key) ?? 0) + g.amountCents);
      }
      launchFund = {
        cents: territory.launchFundCents,
        targetCents: territory.launchFundTargetCents,
        months: labels.map((m) => ({ month: m, cents: byMonth.get(m) ?? 0 })),
      };
    }

    return {
      name: territory.name,
      region: territory.region,
      slug: territory.slug,
      stage: territory.stage,
      backerCount,
      targetBackers: territory.targetBackers,
      story: territory.story ?? null,
      milestones,
      nextMilestone,
      launchFund,
    };
  },
});

// ── Pre-launch readiness (central finance's launch-decision surface) ─────────

const prelaunchReadinessRow = v.object({
  territoryId: v.id("territories"),
  chapterId: v.id("chapters"),
  name: v.string(),
  region: v.string(),
  slug: v.string(),
  stage: stageValidator, // always "prospect" | "raising" here
  createdAt: v.number(),
  // Age since creation (ms) — how long this territory has been raising.
  ageMs: v.number(),
  // The launch pot + what central would still have to cover to hit the grant.
  potCents: v.number(),
  potTargetCents: v.number(),
  remainingCentralBurdenCents: v.number(),
  // Backers: the chapter's live derived count vs the territory's public goal.
  backerCount: v.number(),
  targetBackers: v.number(),
  // Sum of ACTIVE monthly pledges on the chapter (the recurring run-rate).
  activeMonthlyCents: v.number(),
  // The affordability tier the chapter would START at, at its current backers.
  tierLabel: v.string(),
});

/**
 * The financial manager's launch-decision surface: one row per `prospect`/
 * `raising` territory with everything needed to decide whether to launch —
 * name/region/slug, stage, age, the launch pot (`cents`/`target`/what central
 * would still owe to hit the grant), backers (live vs goal), the active
 * monthly pledge run-rate, and the milestone tier the chapter would start at.
 *
 * ACCESS (dual gate, owner requirement): passes for EITHER central finance
 * viewer rank (`getFinanceRole(...).isCentral` at ≥ viewer, resolved through
 * the caller's own chapter like every finance dashboard) OR central
 * `giving.view` — this is the launch call the financial manager makes, and
 * either hat qualifies. A caller with ONLY chapter-scope reach (giving OR
 * finance) gets an empty list (quiet degrade — the card simply doesn't render),
 * never another scope's data.
 */
export const prelaunchReadiness = query({
  args: {},
  returns: v.array(prelaunchReadinessRow),
  handler: async (ctx) => {
    // Gate 1: central giving.view (or superuser). Quiet — no throw.
    const giving = await resolveGivingAccess(ctx);
    let allowed = giving.isSuperuser || giving.centralView;
    // Gate 2: central finance viewer rank, resolved through the caller's own
    // chapter (the same path every finance dashboard uses for central reach).
    if (!allowed) {
      const ownChapterId = await getChapterIdOrNull(ctx);
      if (ownChapterId) {
        const fin = await getFinanceRole(ctx, ownChapterId as Id<"chapters">);
        allowed = fin.isCentral && financeRoleAtLeast(fin.role, "viewer");
      }
    }
    if (!allowed) return [];

    const tiers = await resolveTierLadder(ctx);
    const now = Date.now();

    const territories: Doc<"territories">[] = [];
    for (const stage of ["prospect", "raising"] as const) {
      const rows = await ctx.db
        .query("territories")
        .withIndex("by_stage", (q) => q.eq("stage", stage))
        .take(TERRITORY_LIST_LIMIT);
      territories.push(...rows);
    }

    const out: Array<typeof prelaunchReadinessRow.type> = [];
    for (const t of territories) {
      const chapter = await ctx.db.get(t.chapterId);
      const backerCount = chapter?.backerCount ?? 0;
      const activeMonthlyCents = await activePledgeMonthlyCents(ctx, t.chapterId);
      out.push({
        territoryId: t._id,
        chapterId: t.chapterId,
        name: t.name,
        region: t.region,
        slug: t.slug,
        stage: t.stage,
        createdAt: t.createdAt,
        ageMs: Math.max(0, now - t.createdAt),
        potCents: t.launchFundCents,
        potTargetCents: t.launchFundTargetCents,
        remainingCentralBurdenCents: Math.max(
          0,
          t.launchFundTargetCents - t.launchFundCents,
        ),
        backerCount,
        targetBackers: t.targetBackers,
        activeMonthlyCents,
        tierLabel: affordabilityTierLabel(backerCount, tiers),
      });
    }
    // Newest-raising context first (largest pot at the top reads better for the
    // launch decision); stable, deterministic ordering.
    out.sort((a, b) => b.potCents - a.potCents || b.createdAt - a.createdAt);
    return out;
  },
});
