/**
 * Giving Platform (F-6, Phase 1) — the development team's donor CRM API.
 *
 * Reads (gated by `requireGivingView`): `listDonors` (top-donor ordering),
 * `getDonor` (identity + recent gifts), `givingDashboard` (scope aggregates from
 * the denormalized rollup, never a full scan), `myGivingAccess` (the client's
 * nav/desk gate, like `financeRoles.mySeats`).
 *
 * Writes (gated by `requireGivingManage`): `upsertDonor`, `recordGift` (manual
 * backfill), `removeGift`. Every rollup mutation goes through the shared
 * primitives in `lib/givingDonors.ts`, so the counters stay identical to the
 * event-donation dual-write path in `giving.ts`.
 *
 * Territories P6: bulk data-onboarding (one-time gifts, ticket-buyer history,
 * plain contacts, recurring pledges) moved OUT of this file and into
 * `givingImport.ts`'s canonical preview/commit import — see its header
 * comment. The legacy `importGivebutterCsv` is gone.
 *
 * Money is always integer cents; `transactions` stays the only actuals ledger
 * (PRD §7). See docs/plans/giving-platform.md §1.
 */
import {
  internalMutation,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { normalizeEmail } from "./lib/access";
import { requireUserId } from "./lib/context";
import { listActiveChapters } from "./lib/chapters";
import {
  requireGivingView,
  requireGivingManage,
  resolveGivingAccess,
  type GivingScope,
} from "./lib/givingAccess";
import {
  assertPositiveGiftCents,
  assertReceiptsBound,
  matchOrCreateDonor,
  recordGiftForDonor,
  removeGiftRow,
  editGiftRow,
  dualWriteGiftForDonation,
  linkDonorToPerson,
} from "./lib/givingDonors";
import {
  DONOR_KINDS,
  DONOR_SOURCES,
  DONOR_STATUSES,
  GIFT_METHODS,
  donorAddressValidator,
} from "./schema/givingPlatform";
import { BACKER_UNIT_CENTS } from "@events-os/shared";

// ── Validators ────────────────────────────────────────────────────────────────

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const donorKindValidator = v.union(...DONOR_KINDS.map((k) => v.literal(k)));
const donorSourceValidator = v.union(...DONOR_SOURCES.map((s) => v.literal(s)));
const donorStatusValidator = v.union(...DONOR_STATUSES.map((s) => v.literal(s)));
const giftMethodValidator = v.union(...GIFT_METHODS.map((m) => v.literal(m)));

/** A generous bound on a scope's donor list — mirrors `listDonationsAdmin`'s
 *  `.take(500)`; the top-donor workflow reads the strongest lifetimes first. */
const DONOR_LIST_LIMIT = 500;
/** Recent gifts shown on the donor detail screen. */
const DONOR_GIFTS_LIMIT = 100;
/** Bounded window scan for the dashboard's last-30-days sum (a range read, not
 *  a full table scan — see `by_scope_and_received`). */
const GIFT_WINDOW_LIMIT = 10000;
/** Top donors surfaced on the dashboard. */
const TOP_DONORS_LIMIT = 5;
/** Active chapters read for the org-wide fleet (`dashboardFleet`) + the
 *  all-scopes donor merge — bounded, shadow (prospect) chapters excluded via
 *  `listActiveChapters`. Same order of magnitude as finance's `chapterHealth`
 *  fleet scan. */
const FLEET_CHAPTER_LIMIT = 200;
/** Per-scope bound for `listDonors`'s central-only ALL-SCOPES merge: each scope
 *  contributes at most this many of its strongest-lifetime donors before the
 *  cross-scope merge. Keeps every per-scope read bounded (same index the
 *  single-scope path uses). */
const PER_SCOPE_ALL_LIMIT = 100;
/** Hard cap on the merged all-scopes donor list after sorting by lifetime desc
 *  — the CRM "All chapters" view is a top-donors list, not an export. A merge
 *  that would exceed this is truncated to the strongest `ALL_SCOPES_CAP`. */
const ALL_SCOPES_CAP = 500;
/** Rows processed per backfill transaction before self-reschedule (keeps each
 *  mutation within Convex's per-transaction document limits). The CSV-import
 *  batch size this comment used to describe now lives in `givingImport.ts`. */
const BACKFILL_BATCH_SIZE = 100;
/** Bounded per-donor pledge read for `giverMarks`' `isBacker` derivation — a
 *  donor realistically holds one or two pledges (re-signups after a lapse),
 *  so this stays a small, indexed `by_donor` read repeated per giver, never
 *  an unbounded scan. Mirrors the bounded-recompute precedent in
 *  `givingPledges.ts` (`BACKER_RECOUNT_LIMIT`), scaled down to "per donor". */
const GIVER_MARK_PLEDGE_LIMIT = 10;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A scope's last-30-days gift total — a BOUNDED range read over recent gifts
 * (`by_scope_and_received`), never a full scan. Extracted from `givingDashboard`
 * so the org-wide `dashboardFleet` computes it per scope the SAME way instead of
 * duplicating the window logic (keeps the bound in one place).
 */
async function last30CentsForScope(
  ctx: QueryCtx,
  scope: GivingScope,
): Promise<number> {
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const recent = await ctx.db
    .query("gifts")
    .withIndex("by_scope_and_received", (q) =>
      q.eq("scope", scope).gte("receivedAt", cutoff),
    )
    .take(GIFT_WINDOW_LIMIT);
  return recent.reduce((sum, g) => sum + g.amountCents, 0);
}

/** A scope's denormalized rollup totals (O(1), from `givingScopeRollups`),
 *  zero-filled when the scope has no rollup row yet. */
async function scopeRollupTotals(ctx: QueryCtx, scope: GivingScope) {
  const rollup = await ctx.db
    .query("givingScopeRollups")
    .withIndex("by_scope", (q) => q.eq("scope", scope))
    .unique();
  return {
    lifetimeCents: rollup?.lifetimeCents ?? 0,
    giftCount: rollup?.giftCount ?? 0,
    donorCount: rollup?.donorCount ?? 0,
    activeCount: rollup?.activeCount ?? 0,
    lapsedCount: rollup?.lapsedCount ?? 0,
    prospectCount: rollup?.prospectCount ?? 0,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * The scope's donors, strongest lifetime first by default (the "top donors"
 * workflow) — or, with `status` set, that status bucket via
 * `by_scope_and_status` (no lifetime ordering guarantee in that mode). Either
 * way the base read is bounded to `DONOR_LIST_LIMIT`; `kind`/`source`/
 * `minLifetimeCents` are refined IN-MEMORY within that same bounded window
 * (not a second indexed query — CRM filters compose, and Convex indexes only
 * cover one leading combination each). A scope with more than
 * `DONOR_LIST_LIMIT` donors matching the base read may undercount a narrow
 * kind/source/lifetime filter — acceptable for the CRM's current scale (see
 * `DONOR_LIST_LIMIT`'s own doc), same bound `listDonationsAdmin` already ships.
 */
export const listDonors = query({
  args: {
    scope: scopeValidator,
    status: v.optional(donorStatusValidator),
    kind: v.optional(donorKindValidator),
    source: v.optional(donorSourceValidator),
    minLifetimeCents: v.optional(v.number()),
    // CENTRAL-ONLY "All chapters" mode (giving-dashboard v2 CRM): merge every
    // active scope's strongest-lifetime donors into one cross-scope list. Gated
    // on `requireGivingView(ctx, "central")`; ignores `scope`. Each per-scope
    // read is bounded to `PER_SCOPE_ALL_LIMIT`, the merge is sorted by lifetime
    // desc, and the whole list is capped at `ALL_SCOPES_CAP` (a chapter with
    // more matching donors than its per-scope bound may undercount a narrow
    // kind/source/lifetime filter — same acceptable tradeoff the single-scope
    // path already ships, see `DONOR_LIST_LIMIT`). Each returned row carries a
    // `scopeLabel` (the chapter name, or "Central") for the row's chapter tag.
    allScopes: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { scope, status, kind, source, minLifetimeCents, allScopes },
  ) => {
    // The CRM refinements (kind / source / min-lifetime) compose IN-MEMORY
    // within the bounded index read — Convex indexes cover one leading
    // combination each, so these can't be a second indexed query.
    const matchesRefinements = (d: Doc<"donors">): boolean => {
      if (kind !== undefined && d.kind !== kind) return false;
      if (source !== undefined && d.source !== source) return false;
      if (minLifetimeCents !== undefined && d.lifetimeCents < minLifetimeCents) {
        return false;
      }
      return true;
    };

    if (allScopes) {
      // Central reach only — the fleet-wide donor book.
      await requireGivingView(ctx, "central");
      const chapters = await listActiveChapters(ctx, FLEET_CHAPTER_LIMIT);
      const nameByScope = new Map<string, string>([["central", "Central"]]);
      for (const c of chapters) nameByScope.set(c._id, c.name);
      const scopes: GivingScope[] = ["central", ...chapters.map((c) => c._id)];

      const merged: Array<Doc<"donors"> & { scopeLabel: string }> = [];
      for (const sc of scopes) {
        const scopeRows = status
          ? await ctx.db
              .query("donors")
              .withIndex("by_scope_and_status", (q) =>
                q.eq("scope", sc).eq("status", status),
              )
              .take(PER_SCOPE_ALL_LIMIT)
          : await ctx.db
              .query("donors")
              .withIndex("by_scope_and_lifetime", (q) => q.eq("scope", sc))
              .order("desc")
              .take(PER_SCOPE_ALL_LIMIT);
        for (const d of scopeRows) {
          if (!matchesRefinements(d)) continue;
          merged.push({ ...d, scopeLabel: nameByScope.get(d.scope) ?? "—" });
        }
      }
      merged.sort((a, b) => b.lifetimeCents - a.lifetimeCents);
      return merged.slice(0, ALL_SCOPES_CAP);
    }

    await requireGivingView(ctx, scope as GivingScope);
    const rows = status
      ? await ctx.db
          .query("donors")
          .withIndex("by_scope_and_status", (q) =>
            q.eq("scope", scope).eq("status", status),
          )
          .take(DONOR_LIST_LIMIT)
      : await ctx.db
          .query("donors")
          .withIndex("by_scope_and_lifetime", (q) => q.eq("scope", scope))
          .order("desc")
          .take(DONOR_LIST_LIMIT);
    return rows.filter(matchesRefinements);
  },
});

/** One donor + their recent gift history (the donor detail screen). `person`
 *  is the linked roster row (territories P5, chapter-scope donors only) — just
 *  the id + name, never a full people payload — present only when
 *  `donor.personId` resolves to a live row. */
export const getDonor = query({
  args: { donorId: v.id("donors") },
  handler: async (ctx, { donorId }) => {
    const donor = await ctx.db.get(donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    await requireGivingView(ctx, donor.scope);
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_donor", (q) => q.eq("donorId", donorId))
      .order("desc")
      .take(DONOR_GIFTS_LIMIT);
    // Resolve each gift's receipt storage ids to servable URLs for display
    // (mirrors how `people`/reimbursements resolve stored files). Missing files
    // resolve to null and are dropped, so a thumbnail row only shows real proof.
    const giftsWithReceipts = await Promise.all(
      gifts.map(async (g) => ({
        ...g,
        receiptUrls: g.receiptStorageIds
          ? (
              await Promise.all(
                g.receiptStorageIds.map((id) => ctx.storage.getUrl(id)),
              )
            ).filter((url): url is string => url !== null)
          : [],
      })),
    );
    const linkedPerson = donor.personId
      ? await ctx.db.get(donor.personId)
      : null;
    return {
      donor,
      gifts: giftsWithReceipts,
      person: linkedPerson ? { _id: linkedPerson._id, name: linkedPerson.name } : null,
    };
  },
});

/**
 * Territories P5 — the chapter's "givers": every linked donor (`personId`
 * set) who has actually given (`giftCount > 0` — a prospect with no gift
 * never marks the roster). Feeds the People tab's "Givers" overlay chip + the
 * per-row/detail giving marks, WITHOUT exposing full donor records — or
 * amounts — to the roster UI (owner privacy request: the People tab shows a
 * heart/building icon, never a dollar figure; amounts stay in the giving
 * desk, reached through the existing donor deep-link).
 *
 * `isBacker` mirrors `givingPledges.recomputeChapterBackerCount`'s EXACT
 * predicate (active pledge at/above `BACKER_UNIT_CENTS`) — same floor, same
 * status check — just evaluated per-donor instead of counted per-chapter.
 *
 * Access: requires `giving.view` at `chapterId` (or central reach) — but
 * degrades QUIETLY to `[]` for a caller without it (never throws), so the
 * People tab renders normally, with no giver marks, for everyone else. This
 * mirrors `myGivingAccess`'s no-throw-for-the-nav pattern rather than the
 * throwing `requireGivingView` callers elsewhere in this file.
 */
export const giverMarks = query({
  args: { chapterId: v.id("chapters") },
  returns: v.array(
    v.object({
      personId: v.id("people"),
      donorId: v.id("donors"),
      isBacker: v.boolean(),
    }),
  ),
  handler: async (ctx, { chapterId }) => {
    try {
      await requireGivingView(ctx, chapterId as GivingScope);
    } catch {
      return []; // quiet degrade — no giving access, no marks (not a throw)
    }
    const donors = await ctx.db
      .query("donors")
      .withIndex("by_scope_and_lifetime", (q) => q.eq("scope", chapterId))
      .order("desc")
      .take(DONOR_LIST_LIMIT);
    const givers = donors.filter(
      (d) => d.personId !== undefined && d.giftCount > 0,
    );
    return await Promise.all(
      givers.map(async (d) => {
        // Bounded, indexed per-donor read (never unbounded/`.filter()`-on-
        // query) — a donor realistically holds very few pledges.
        const pledges = await ctx.db
          .query("pledges")
          .withIndex("by_donor", (q) => q.eq("donorId", d._id))
          .take(GIVER_MARK_PLEDGE_LIMIT);
        const isBacker = pledges.some(
          (p) => p.status === "active" && p.amountCents >= BACKER_UNIT_CENTS,
        );
        return {
          personId: d.personId as Id<"people">,
          donorId: d._id,
          isBacker,
        };
      }),
    );
  },
});

/**
 * Scope totals for the development dashboard — all from the denormalized
 * rollup (O(1)) except the last-30-days sum, which is a bounded range read over
 * recent gifts (`by_scope_and_received`), never a full scan.
 */
export const givingDashboard = query({
  args: { scope: scopeValidator },
  handler: async (ctx, { scope }) => {
    await requireGivingView(ctx, scope as GivingScope);

    const rollup = await ctx.db
      .query("givingScopeRollups")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .unique();

    const last30Cents = await last30CentsForScope(ctx, scope as GivingScope);

    const topDonors = await ctx.db
      .query("donors")
      .withIndex("by_scope_and_lifetime", (q) => q.eq("scope", scope))
      .order("desc")
      .take(TOP_DONORS_LIMIT);

    return {
      lifetimeCents: rollup?.lifetimeCents ?? 0,
      last30Cents,
      giftCount: rollup?.giftCount ?? 0,
      donorCount: rollup?.donorCount ?? 0,
      activeCount: rollup?.activeCount ?? 0,
      lapsedCount: rollup?.lapsedCount ?? 0,
      prospectCount: rollup?.prospectCount ?? 0,
      topDonors,
    };
  },
});

/**
 * The caller's giving desk access — the client's nav/desk gate (mirrors
 * `financeRoles.mySeats` / `canViewAccounts`). Degrades quietly for a signed-out
 * or unprivileged caller (no throw) so the nav can decide whether to render the
 * Giving desk at all. `scope` names the lens to render: `"central"` for a
 * central holder, else the caller's own chapter when they hold a chapter view.
 *
 * `chapterId` (optional) is the app's chapter lens — `ChapterContext`'s active
 * seat/peek chapter, the SAME central-gated drill-down `finances.dashboardChapter`
 * takes. Before this arg existed, a superuser/central holder ALWAYS got
 * `scope: "central"` here regardless of the chapter switcher, so every giving
 * screen rendered central's book even while the app was scoped to a chapter
 * (the "No donors yet" bug — central's book can be empty while a chapter's
 * isn't). When `chapterId` is provided AND the caller may view it (superuser,
 * central view, or a chapter `giving.view` seat there), that chapter becomes
 * the lens. Otherwise (absent, or a chapter the caller can't view — e.g. a
 * foreign chapter under a chapter-only seat) this falls through to the
 * pre-existing default: central for central holders, else the caller's own
 * chapter. No enforcement risk either way — this query only ever picks WHICH
 * scope to show; every downstream giving query re-gates its own scope via
 * `requireGivingView`/`requireGivingManage` regardless of what this returns.
 */
export const myGivingAccess = query({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: v.object({
    canView: v.boolean(),
    canManage: v.boolean(),
    scope: v.union(v.literal("central"), v.id("chapters"), v.null()),
    chapterName: v.union(v.string(), v.null()),
    // Whether the caller has CENTRAL (org-wide) giving reach — independent of
    // which lens `scope` currently resolves to. The giving-dashboard-v2 CRM
    // uses this to decide whether to offer the org-wide fleet dashboard and the
    // "All chapters / Central / each chapter" scope dropdown; a chapter-only
    // holder gets `false` and never sees either.
    isCentral: v.boolean(),
  }),
  handler: async (ctx, { chapterId }) => {
    const access = await resolveGivingAccess(ctx);
    const isCentral = access.isSuperuser || access.centralView;

    // The app's chapter lens wins when the caller may actually view it.
    if (chapterId !== undefined) {
      const canViewRequested = isCentral || access.viewChapters.has(chapterId);
      if (canViewRequested) {
        const chapter = await ctx.db.get(chapterId);
        return {
          canView: true,
          canManage:
            access.isSuperuser ||
            access.centralManage ||
            access.manageChapters.has(chapterId),
          scope: chapterId,
          chapterName: chapter?.name ?? null,
          isCentral,
        };
      }
      // Not viewable (e.g. a foreign chapter under a chapter-only seat) —
      // fall through to the default-lens behavior below.
    }

    // Central lens wins when the caller has central reach.
    if (isCentral) {
      return {
        canView: true,
        canManage: access.isSuperuser || access.centralManage,
        scope: "central" as const,
        chapterName: null,
        isCentral: true,
      };
    }
    // Otherwise a chapter lens — the first chapter the caller can view.
    const chapterKey = [...access.viewChapters][0];
    if (chapterKey) {
      const ownChapterId = chapterKey as Id<"chapters">;
      const chapter = await ctx.db.get(ownChapterId);
      return {
        canView: true,
        canManage: access.manageChapters.has(chapterKey),
        scope: ownChapterId,
        chapterName: chapter?.name ?? null,
        isCentral: false,
      };
    }
    return {
      canView: false,
      canManage: false,
      scope: null,
      chapterName: null,
      isCentral: false,
    };
  },
});

// ── Org-wide fleet (giving-dashboard v2) ─────────────────────────────────────

const fleetScopeRow = v.object({
  scope: scopeValidator,
  name: v.string(),
  lifetimeCents: v.number(),
  last30Cents: v.number(),
  giftCount: v.number(),
  donorCount: v.number(),
  activeCount: v.number(),
  lapsedCount: v.number(),
  prospectCount: v.number(),
  // Manual-entry backer count (schema/chapters.ts: "Absent/0 = not yet set").
  // `null` until a chapter configures a nonzero count; always `null` for
  // central (no backer concept on central's own book).
  backerCount: v.union(v.number(), v.null()),
  // The linked territory's public backer goal (`territories.targetBackers`),
  // or `null` when the chapter has no territory / is central.
  targetBackers: v.union(v.number(), v.null()),
  // Cheap attention signals, rollups-only.
  hasLapsed: v.boolean(),
  backersBelowTarget: v.boolean(),
});

/**
 * The development director's org-wide FLEET view — every scope's giving at a
 * glance, for a CENTRAL holder only (`requireGivingView(ctx, "central")`; a
 * chapter-only caller is rejected). Mirrors finance's `dashboardCharts.chapterHealth`:
 * a "Central" row (central's own donor book) leads, then one row per ACTIVE
 * chapter (shadow/prospect chapters excluded via `listActiveChapters`).
 *
 * Every per-scope number is O(1) from `givingScopeRollups` EXCEPT `last30Cents`,
 * a bounded range read per scope (`last30CentsForScope`, `by_scope_and_received`).
 * `backerCount` comes off the chapter row; `targetBackers` is a single indexed
 * `territories.by_chapter` read. `org` totals are the SUM across every scope
 * row (central + chapters) — never a separate scan.
 *
 * Attention signals are rollups-only (cheap): `hasLapsed` (a reactivation
 * queue exists) and `backersBelowTarget` (backers below the territory goal).
 * The client derives the fleet attention RAIL from these (see
 * `components/giving/dashboard/fleetAttention.ts`).
 */
export const dashboardFleet = query({
  args: {},
  returns: v.object({
    org: v.object({
      lifetimeCents: v.number(),
      last30Cents: v.number(),
      giftCount: v.number(),
      donorCount: v.number(),
      activeCount: v.number(),
      lapsedCount: v.number(),
      prospectCount: v.number(),
      // Sum of every active chapter's backer count.
      backerCount: v.number(),
      // Sum of every linked territory's target (the org-wide backer goal).
      targetBackers: v.number(),
    }),
    scopes: v.array(fleetScopeRow),
  }),
  handler: async (ctx) => {
    await requireGivingView(ctx, "central");

    const scopes: Array<typeof fleetScopeRow.type> = [];

    // ── Central's own book (leads the fleet) ──
    const centralTotals = await scopeRollupTotals(ctx, "central");
    scopes.push({
      scope: "central",
      name: "Central",
      ...centralTotals,
      last30Cents: await last30CentsForScope(ctx, "central"),
      backerCount: null,
      targetBackers: null,
      hasLapsed: centralTotals.lapsedCount > 0,
      backersBelowTarget: false,
    });

    // ── One row per active chapter ──
    const chapters = await listActiveChapters(ctx, FLEET_CHAPTER_LIMIT);
    for (const chapter of chapters) {
      const totals = await scopeRollupTotals(ctx, chapter._id);
      const last30Cents = await last30CentsForScope(ctx, chapter._id);
      // 1:1 territory (if any) — the public backer goal lives there.
      const territory = await ctx.db
        .query("territories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .first();
      // "Absent/0 = not yet set" (schema/chapters.ts) — a zero count means
      // unconfigured, so it reads as `null` (no backer bar), never "0 backers".
      const rawBackers = chapter.backerCount ?? 0;
      const backerCount = rawBackers > 0 ? rawBackers : null;
      const targetBackers = territory ? territory.targetBackers : null;
      const backersBelowTarget =
        backerCount != null &&
        targetBackers != null &&
        backerCount < targetBackers;
      scopes.push({
        scope: chapter._id,
        name: chapter.name,
        ...totals,
        last30Cents,
        backerCount,
        targetBackers,
        hasLapsed: totals.lapsedCount > 0,
        backersBelowTarget,
      });
    }

    // ── Org totals = sum across every scope row ──
    const org = scopes.reduce(
      (acc, s) => ({
        lifetimeCents: acc.lifetimeCents + s.lifetimeCents,
        last30Cents: acc.last30Cents + s.last30Cents,
        giftCount: acc.giftCount + s.giftCount,
        donorCount: acc.donorCount + s.donorCount,
        activeCount: acc.activeCount + s.activeCount,
        lapsedCount: acc.lapsedCount + s.lapsedCount,
        prospectCount: acc.prospectCount + s.prospectCount,
        backerCount: acc.backerCount + (s.backerCount ?? 0),
        targetBackers: acc.targetBackers + (s.targetBackers ?? 0),
      }),
      {
        lifetimeCents: 0,
        last30Cents: 0,
        giftCount: 0,
        donorCount: 0,
        activeCount: 0,
        lapsedCount: 0,
        prospectCount: 0,
        backerCount: 0,
        targetBackers: 0,
      },
    );

    return { org, scopes };
  },
});

// ── Writes ─────────────────────────────────────────────────────────────────────

/**
 * Create or update a donor. With `donorId`, patches that donor (scope-checked);
 * otherwise match-or-creates by lowercased email (fallback: exact name) in
 * `scope`, then applies the provided fields. `status`/rollups are never set here
 * — status is derived on gift writes.
 */
export const upsertDonor = mutation({
  args: {
    scope: scopeValidator,
    donorId: v.optional(v.id("donors")),
    kind: v.optional(donorKindValidator),
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    ownerPersonId: v.optional(v.id("people")),
    notes: v.optional(v.string()),
    source: v.optional(donorSourceValidator),
    // Optional mailing address for postal outreach (F-6 donor address).
    address: v.optional(donorAddressValidator),
  },
  returns: v.id("donors"),
  handler: async (ctx, args) => {
    const scope = args.scope as GivingScope;
    await requireGivingManage(ctx, scope);

    const name = args.name.trim();
    if (!name) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A donor name is required.",
      });
    }
    const email = normalizeEmail(args.email) ?? undefined;

    // Editable fields common to both create + update.
    const patch = {
      name,
      ...(email !== undefined ? { email } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.phone !== undefined ? { phone: args.phone.trim() || undefined } : {}),
      ...(args.ownerPersonId !== undefined
        ? { ownerPersonId: args.ownerPersonId }
        : {}),
      ...(args.notes !== undefined ? { notes: args.notes.trim() || undefined } : {}),
      ...(args.source !== undefined ? { source: args.source } : {}),
      ...(args.address !== undefined ? { address: args.address } : {}),
    };

    if (args.donorId) {
      const donor = await ctx.db.get(args.donorId);
      if (!donor || donor.scope !== scope) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That donor isn't in this scope.",
        });
      }
      await ctx.db.patch(args.donorId, patch);
      // Territories P5: a CHAPTER-scope donor still unlinked (e.g. it was
      // created before an email/phone existed to match on, or the first
      // attempt found no roster match) gets a retry here — this edit may have
      // just supplied the email/phone that makes the match possible now. A
      // no-op for central donors (`linkDonorToPerson` short-circuits) and for
      // an already-linked donor (guarded below, so a re-edit never re-scans
      // the roster for nothing).
      if (scope !== "central" && donor.personId === undefined) {
        await linkDonorToPerson(ctx, { ...donor, ...patch });
      }
      return args.donorId;
    }

    const donorId = await matchOrCreateDonor(ctx, {
      scope,
      name,
      email,
      phone: args.phone,
      kind: args.kind,
      source: args.source ?? "manual",
      ownerPersonId: args.ownerPersonId,
    });
    await ctx.db.patch(donorId, patch);
    // `matchOrCreateDonor` already tried to link a BRAND-NEW donor (email,
    // phone, and name all considered — `phone` is passed through above so it
    // participates in that first match). This is a belt-and-suspenders retry
    // for the rare case it's still unlinked (e.g. `donorId` resolved to an
    // EXISTING donor that predates `personId` — a no-op once linked).
    if (scope !== "central") {
      const created = await ctx.db.get(donorId);
      if (created && created.personId === undefined) {
        await linkDonorToPerson(ctx, created);
      }
    }
    return donorId;
  },
});

/**
 * Record a manual/backfill gift for a donor ("they gave $500 by check in
 * March"). Validates cents, inserts the gift, bumps the donor + scope rollups,
 * and recomputes the donor's status.
 */
export const recordGift = mutation({
  args: {
    donorId: v.id("donors"),
    amountCents: v.number(),
    method: giftMethodValidator,
    receivedAt: v.optional(v.number()),
    note: v.optional(v.string()),
    eventId: v.optional(v.id("events")),
    externalRef: v.optional(v.string()),
    // P4: optional receipt proof captured at record time (bounded ≤ 10).
    receiptStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  returns: v.id("gifts"),
  handler: async (ctx, args) => {
    const donor = await ctx.db.get(args.donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    await requireGivingManage(ctx, donor.scope);
    assertPositiveGiftCents(args.amountCents);
    assertReceiptsBound(args.receiptStorageIds);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    return await recordGiftForDonor(ctx, {
      donorId: args.donorId,
      amountCents: args.amountCents,
      receivedAt: args.receivedAt ?? Date.now(),
      method: args.method,
      note: args.note?.trim() || undefined,
      eventId: args.eventId,
      externalRef: args.externalRef,
      receiptStorageIds: args.receiptStorageIds,
      recordedBy: userId,
    });
  },
});

/**
 * Edit a gift in place with delta-correct rollups (territories P4). A manual
 * correction to any of amount / date / source / note / receipts. Manage-gated
 * at the gift's scope; the money-field lock for system-written gifts (Stripe /
 * event donation) lives in `editGiftRow`, which throws `GIFT_LOCKED` when an
 * amount/date/source edit is attempted on one — note & receipts still succeed.
 */
export const editGift = mutation({
  args: {
    giftId: v.id("gifts"),
    amountCents: v.optional(v.number()),
    receivedAt: v.optional(v.number()),
    method: v.optional(giftMethodValidator),
    note: v.optional(v.string()),
    receiptStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const gift = await ctx.db.get(args.giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }
    await requireGivingManage(ctx, gift.scope);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await editGiftRow(ctx, {
      giftId: args.giftId,
      amountCents: args.amountCents,
      receivedAt: args.receivedAt,
      method: args.method,
      note: args.note,
      receiptStorageIds: args.receiptStorageIds,
      editedBy: userId,
    });
    return null;
  },
});

/**
 * Generate a short-lived receipt-upload URL for a gift under `donorId`'s scope
 * (manage-gated — mirrors how reimbursements gate their upload URL). The client
 * POSTs the file, then passes the returned `storageId` to `recordGift`
 * (record-time proof) or `editGift` (attaching to an existing gift).
 */
export const generateGiftReceiptUploadUrl = mutation({
  args: { donorId: v.id("donors") },
  handler: async (ctx, { donorId }) => {
    const donor = await ctx.db.get(donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    await requireGivingManage(ctx, donor.scope);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Remove a gift, reversing its rollups (clamped ≥ 0) + re-deriving status. */
export const removeGift = mutation({
  args: { giftId: v.id("gifts") },
  returns: v.null(),
  handler: async (ctx, { giftId }) => {
    const gift = await ctx.db.get(giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }
    await requireGivingManage(ctx, gift.scope);
    await removeGiftRow(ctx, giftId);
    return null;
  },
});

// Territories P6: the Givebutter-only `importGivebutterCsv`/`importRows`/
// `importGivebutterRest` trio (donors + gifts, `externalRef` dedup) is
// SUPERSEDED by the canonical import's `gift` row type
// (`givingImport.ts#previewImport` / `#importCanonical`) — same dedup rule,
// PLUS row-type classification so a Givebutter export's ticket-sale rows can
// no longer be mistakenly imported as gifts. See that file's header comment.

// ── Backfill migration (event donations → gifts) ─────────────────────────────

/**
 * One-time backfill: mirror every existing PAID event `donations` row into a
 * linked `gifts` row (+ its donor), idempotent via the `donationId` link (so a
 * re-run — or overlap with the live dual-write — inserts nothing new). Batches
 * over the `donations` table and self-reschedules to stay within transaction
 * limits. Internal-only; the orchestrator invokes it once post-deploy.
 */
export const backfillGiftsFromDonations = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("donations")
      .paginate({ numItems: BACKFILL_BATCH_SIZE, cursor: cursor ?? null });

    let backfilled = 0;
    for (const donation of page.page) {
      if (donation.status !== "paid") continue;
      const before = await ctx.db
        .query("gifts")
        .withIndex("by_donation", (q) => q.eq("donationId", donation._id))
        .first();
      if (before) continue; // already mirrored (dual-write or a prior run)
      await dualWriteGiftForDonation(ctx, donation);
      backfilled++;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.givingPlatform.backfillGiftsFromDonations,
        { cursor: page.continueCursor },
      );
    }
    return { backfilled, isDone: page.isDone };
  },
});
