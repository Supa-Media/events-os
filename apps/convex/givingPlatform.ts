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
  reassignGiftToDonor,
  moveGiftToScope,
  dualWriteGiftForDonation,
  linkDonorToPerson,
  isSystemWrittenGift,
  bumpEventExternalGifts,
} from "./lib/givingDonors";
import {
  writeGiftAudit,
  auditCents,
  GIFT_AUDIT_READ_CAP,
  type GiftFieldChange,
} from "./lib/giftAudit";
import {
  writeDonorAudit,
  diffFields,
  GIVING_AUDIT_READ_CAP,
} from "./lib/givingAudit";
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

/** Rows the chronological gifts ledger shows in a SINGLE scope (newest-first) —
 *  a generous bound mirroring `DONOR_LIST_LIMIT`; client-side search filters
 *  within this window (server search comes later). */
const GIFT_LEDGER_LIMIT = 250;
/** Per-book cap in the central all-scopes ledger: read this many newest gifts
 *  from EACH book (`by_scope_and_received` desc), then merge + re-sort in
 *  memory and slice to `GIFT_LEDGER_LIMIT`. Bounded per-scope reads (the house
 *  pattern); a book with more than this many gifts inside the merged window may
 *  have its oldest rows fall off the combined page — acceptable for a cleanup
 *  feed, and documented like `DONOR_LIST_LIMIT`. */
const GIFT_LEDGER_PER_SCOPE = 100;
/** Per-scope donor cap for the org-wide identity-grouped view (mirrors
 *  `DONOR_LIST_LIMIT`; strongest lifetimes first via `by_scope_and_lifetime`). */
const ORG_DONORS_PER_SCOPE = 500;
/** How many identity-grouped org donors to return (strongest total first). */
const ORG_DONORS_LIMIT = 200;

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
/**
 * Attach `linkedPersonName` (owner feedback #3c — the grid's "Linked person"
 * column) to each donor row. `personId` already rides on the donor doc; this
 * resolves the roster name with a bounded, deduped batch of `.get`s (one per
 * distinct linked person — well under the list caps). Unlinked (or a dangling
 * link) resolves to `null`.
 */
async function withLinkedPersonNames<T extends Doc<"donors">>(
  ctx: QueryCtx,
  rows: T[],
): Promise<(T & { linkedPersonName: string | null })[]> {
  const names = new Map<string, string>();
  for (const id of new Set(
    rows.map((r) => r.personId).filter((id): id is Id<"people"> => !!id),
  )) {
    const person = await ctx.db.get(id);
    if (person) names.set(id, person.name);
  }
  return rows.map((r) => ({
    ...r,
    linkedPersonName: r.personId ? names.get(r.personId) ?? null : null,
  }));
}

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
      return await withLinkedPersonNames(ctx, merged.slice(0, ALL_SCOPES_CAP));
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
    return await withLinkedPersonNames(ctx, rows.filter(matchesRefinements));
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

// ── Gifts ledger (owner request #1) ──────────────────────────────────────────

/** normalized-lowercase name key (mirrors `dataHygiene.ts#normName`) — the
 *  weakest identity-grouping fallback for the org-wide donor roll-up. */
function normNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Display label for a gift's source/method literal (mirrors the mobile
 *  `SOURCE_LABELS`; `stripe` reads as "Chapter OS", our own rails). */
const GIFT_METHOD_LABELS: Record<string, string> = {
  stripe: "Chapter OS",
  cash: "Cash",
  check: "Check",
  wire: "Wire",
  in_kind: "In-kind",
  zelle: "Zelle",
  venmo: "Venmo",
  givebutter: "Givebutter",
  cash_app: "Cash App",
  other: "Other",
};
function methodLabel(method: string): string {
  return GIFT_METHOD_LABELS[method] ?? method;
}

/** The audit `changes` for a freshly-recorded gift (amount / date / source). */
function giftCreatedChanges(
  amountCents: number,
  receivedAt: number,
  method: string,
): GiftFieldChange[] {
  return [
    { field: "Amount", to: auditCents(amountCents) },
    { field: "Date", to: new Date(receivedAt).toLocaleDateString() },
    { field: "Source", to: methodLabel(method) },
  ];
}

/** Resolve a scope to its display "book" label (chapter name, or "Central").
 *  `chapterNames` is an optional prebuilt map to avoid a per-row `.get`. */
async function bookLabel(
  ctx: QueryCtx,
  scope: GivingScope,
  chapterNames?: Map<string, string>,
): Promise<string> {
  if (scope === "central") return "Central";
  if (chapterNames?.has(scope)) return chapterNames.get(scope) as string;
  const chapter = await ctx.db.get(scope);
  return chapter?.name ?? "Chapter";
}

/**
 * The chronological GIFTS LEDGER (owner request #1) — every gift in a book,
 * NEWEST-FIRST, the feed the giving desk lives in during cleanup. Reads
 * `by_scope_and_received` descending (bounded, never a scan). With
 * `allScopes: true` a CENTRAL holder gets the all-books feed: the newest gifts
 * from every active book AND central, each row tagged with its book — merged +
 * re-sorted in memory, capped per `GIFT_LEDGER_PER_SCOPE`. Donor names are
 * resolved from a bounded batch of `.get`s. Manage-gating lives on the write
 * paths; this read only needs `requireGivingView` on the scope (or central).
 *
 * `from`/`to` (giving CRM v2, owner request #2 — grid filtering): an optional
 * received-at range, applied ON the same `by_scope_and_received` index read —
 * a legitimate cheap server-side narrowing (the alternative is the client
 * widening its already-bounded window and filtering in memory, which would
 * silently drop older rows a date-range preset like "this year" needs to see).
 * Both bounds are inclusive; omit either for an open range.
 */
export const listGifts = query({
  args: {
    scope: scopeValidator,
    allScopes: v.optional(v.boolean()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: async (ctx, { scope, allScopes, from, to }) => {
    const typedScope = scope as GivingScope;

    // Gather the raw gift rows + the set of books they span.
    let rows: { gift: Doc<"gifts">; scope: GivingScope }[] = [];
    const chapterNames = new Map<string, string>();

    if (allScopes) {
      // All-books feed — central reach only.
      await requireGivingView(ctx, "central");
      const chapters = await listActiveChapters(ctx);
      for (const c of chapters) chapterNames.set(c._id, c.name);
      const scopes: GivingScope[] = ["central", ...chapters.map((c) => c._id)];
      for (const s of scopes) {
        const page = await ctx.db
          .query("gifts")
          .withIndex("by_scope_and_received", (q) => {
            const withScope = q.eq("scope", s);
            const withFrom = from !== undefined ? withScope.gte("receivedAt", from) : withScope;
            return to !== undefined ? withFrom.lte("receivedAt", to) : withFrom;
          })
          .order("desc")
          .take(GIFT_LEDGER_PER_SCOPE);
        for (const gift of page) rows.push({ gift, scope: s });
      }
      rows.sort((a, b) => b.gift.receivedAt - a.gift.receivedAt);
      rows = rows.slice(0, GIFT_LEDGER_LIMIT);
    } else {
      await requireGivingView(ctx, typedScope);
      const page = await ctx.db
        .query("gifts")
        .withIndex("by_scope_and_received", (q) => {
          const withScope = q.eq("scope", typedScope);
          const withFrom = from !== undefined ? withScope.gte("receivedAt", from) : withScope;
          return to !== undefined ? withFrom.lte("receivedAt", to) : withFrom;
        })
        .order("desc")
        .take(GIFT_LEDGER_LIMIT);
      for (const gift of page) rows.push({ gift, scope: typedScope });
    }

    // Batch-resolve donor names (dedup the ids first).
    const donorIds = [...new Set(rows.map((r) => r.gift.donorId))];
    const donorNames = new Map<string, string>();
    for (const id of donorIds) {
      const donor = await ctx.db.get(id);
      if (donor) donorNames.set(id, donor.name);
    }

    // Batch-resolve attached-event names (gift→event attach feature) — dedup
    // first so a page with many gifts on the same event only reads it once.
    const eventIds = [
      ...new Set(
        rows
          .map((r) => r.gift.eventId)
          .filter((id): id is Id<"events"> => id !== undefined),
      ),
    ];
    const eventNames = new Map<string, string>();
    for (const id of eventIds) {
      const event = await ctx.db.get(id);
      if (event) eventNames.set(id, event.name);
    }

    return {
      allScopes: allScopes === true,
      gifts: await Promise.all(
        rows.map(async (r) => ({
          _id: r.gift._id,
          donorId: r.gift.donorId,
          donorName: donorNames.get(r.gift.donorId) ?? "Unknown donor",
          amountCents: r.gift.amountCents,
          receivedAt: r.gift.receivedAt,
          method: r.gift.method,
          note: r.gift.note ?? null,
          scope: r.scope,
          bookLabel: await bookLabel(ctx, r.scope, chapterNames),
          hasReceipts: (r.gift.receiptStorageIds?.length ?? 0) > 0,
          edited: r.gift.editedAt !== undefined,
          // A gift whose money is owned elsewhere (event donation / Stripe /
          // sponsorship / bank-credit) — the client hides destructive edits.
          systemWritten: isSystemWrittenGift(r.gift),
          // Gift→event attach (fundraiser attribution) — null when unattached.
          eventId: r.gift.eventId ?? null,
          eventName: r.gift.eventId
            ? (eventNames.get(r.gift.eventId) ?? "Unknown event")
            : null,
          // Whether this attachment came from the on-page donation dual-write
          // (locked — see `attachGiftToEvent`) vs a manual attach.
          hasEventSource: r.gift.donationId !== undefined,
        })),
      ),
    };
  },
});

/**
 * One gift's full detail for the ledger sheet: the gift (with resolved receipt
 * URLs), its donor, the book label, and the AUDIT TRAIL (owner request #4b) —
 * every human change newest-first, with the actor's name resolved. Read-gated
 * on the gift's scope; bounded `by_gift` audit read.
 */
export const getGift = query({
  args: { giftId: v.id("gifts") },
  handler: async (ctx, { giftId }) => {
    const gift = await ctx.db.get(giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }
    await requireGivingView(ctx, gift.scope);
    const donor = await ctx.db.get(gift.donorId);
    const event = gift.eventId ? await ctx.db.get(gift.eventId) : null;

    const receiptUrls = gift.receiptStorageIds
      ? (
          await Promise.all(
            gift.receiptStorageIds.map((id) => ctx.storage.getUrl(id)),
          )
        ).filter((url): url is string => url !== null)
      : [];

    const auditRows = await ctx.db
      .query("giftAudit")
      .withIndex("by_gift", (q) => q.eq("giftId", giftId))
      .order("desc")
      .take(GIFT_AUDIT_READ_CAP);

    // Resolve each actor to a display name (userProfiles → users.email).
    const actorNames = new Map<string, string>();
    for (const id of new Set(auditRows.map((a) => a.actorUserId))) {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", id))
        .unique();
      if (profile?.name) {
        actorNames.set(id, profile.name);
      } else {
        const user = await ctx.db.get(id);
        actorNames.set(id, user?.email ?? "Someone");
      }
    }

    return {
      gift: { ...gift, receiptUrls },
      donorName: donor?.name ?? "Unknown donor",
      eventName: event?.name ?? null,
      bookLabel: await bookLabel(ctx, gift.scope),
      systemWritten: isSystemWrittenGift(gift),
      audit: auditRows.map((a) => ({
        _id: a._id,
        at: a.at,
        action: a.action,
        changes: a.changes ?? [],
        note: a.note ?? null,
        actorName: actorNames.get(a.actorUserId) ?? "Someone",
      })),
    };
  },
});

/**
 * The books the caller can act in (owner request #3/#4 scope choice + move
 * target + the ledger's all-scopes toggle). A central holder gets Central plus
 * every active chapter (all manageable when they hold central manage); a
 * chapter holder gets only their own chapter(s). Quiet — never throws — so the
 * client can render an add-gift/move affordance conditionally.
 */
export const givingScopeOptions = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveGivingAccess(ctx);
    const centralView = access.isSuperuser || access.centralView;
    const centralManage = access.isSuperuser || access.centralManage;
    const options: { scope: GivingScope; label: string; canManage: boolean }[] =
      [];

    if (centralView) {
      options.push({ scope: "central", label: "Central", canManage: centralManage });
      const chapters = await listActiveChapters(ctx);
      for (const c of chapters) {
        options.push({ scope: c._id, label: c.name, canManage: centralManage });
      }
      return {
        canSeeAllScopes: true,
        canManageCentral: centralManage,
        options,
      };
    }

    for (const key of access.viewChapters) {
      const chapter = await ctx.db.get(key as Id<"chapters">);
      options.push({
        scope: key as GivingScope,
        label: chapter?.name ?? "Chapter",
        canManage: access.manageChapters.has(key),
      });
    }
    return { canSeeAllScopes: false, canManageCentral: false, options };
  },
});

/**
 * ORG-WIDE donors grouped by IDENTITY (owner request #6) — "who are the biggest
 * donors" when a donor can give centrally AND toward multiple chapters. Central
 * reach only. Reads each book's donors (bounded, strongest-lifetime first),
 * then groups IN MEMORY by identity: linked `personId` first (the strongest
 * cross-book key), else normalized email, else exact normalized name. Each
 * group sums lifetime across books and carries a per-book breakdown for
 * drill-in. Sorted by combined lifetime desc, capped at `ORG_DONORS_LIMIT`.
 */
export const listOrgDonorsByIdentity = query({
  args: {},
  handler: async (ctx) => {
    await requireGivingView(ctx, "central");
    const chapters = await listActiveChapters(ctx);
    const chapterNames = new Map<string, string>();
    for (const c of chapters) chapterNames.set(c._id, c.name);
    const scopes: GivingScope[] = ["central", ...chapters.map((c) => c._id)];

    type Entry = {
      donorId: Id<"donors">;
      scope: GivingScope;
      bookLabel: string;
      lifetimeCents: number;
    };
    type Group = {
      key: string;
      name: string;
      lifetimeCents: number;
      giftCount: number;
      books: Entry[];
    };
    const groups = new Map<string, Group>();

    for (const s of scopes) {
      const donors = await ctx.db
        .query("donors")
        .withIndex("by_scope_and_lifetime", (q) => q.eq("scope", s))
        .order("desc")
        .take(ORG_DONORS_PER_SCOPE);
      const label = await bookLabel(ctx, s, chapterNames);
      for (const d of donors) {
        // Identity key: personId (strongest) → normalized email → exact name.
        const key = d.personId
          ? `p:${d.personId}`
          : normalizeEmail(d.email)
            ? `e:${normalizeEmail(d.email)}`
            : `n:${normNameKey(d.name)}`;
        const entry: Entry = {
          donorId: d._id,
          scope: s,
          bookLabel: label,
          lifetimeCents: d.lifetimeCents,
        };
        const existing = groups.get(key);
        if (existing) {
          existing.lifetimeCents += d.lifetimeCents;
          existing.giftCount += d.giftCount;
          existing.books.push(entry);
          // Prefer a non-empty display name (a person-linked group keeps the
          // first real name it saw).
          if (!existing.name && d.name) existing.name = d.name;
        } else {
          groups.set(key, {
            key,
            name: d.name,
            lifetimeCents: d.lifetimeCents,
            giftCount: d.giftCount,
            books: [entry],
          });
        }
      }
    }

    const ranked = [...groups.values()]
      .sort((a, b) => b.lifetimeCents - a.lifetimeCents)
      .slice(0, ORG_DONORS_LIMIT)
      .map((g) => ({
        key: g.key,
        name: g.name,
        lifetimeCents: g.lifetimeCents,
        giftCount: g.giftCount,
        bookCount: g.books.length,
        books: g.books
          .slice()
          .sort((a, b) => b.lifetimeCents - a.lifetimeCents),
      }));
    return { donors: ranked };
  },
});

/**
 * Preview a manual donor merge (owner request #5) — "what will move" before
 * `dataHygiene.mergeDonors` runs. Both donors must be in `scope` (manage-gated).
 * Reports the duplicate's gift/pledge/sponsorship counts + lifetime that will
 * fold into the survivor, and the survivor's resulting lifetime/gift totals.
 * Bounded `by_donor` counts (capped — a preview only needs "how many").
 */
export const previewDonorMerge = query({
  args: {
    scope: scopeValidator,
    survivorId: v.id("donors"),
    duplicateId: v.id("donors"),
  },
  handler: async (ctx, { scope, survivorId, duplicateId }) => {
    const typedScope = scope as GivingScope;
    await requireGivingManage(ctx, typedScope);
    if (survivorId === duplicateId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Pick two different donors.",
      });
    }
    const survivor = await ctx.db.get(survivorId);
    const duplicate = await ctx.db.get(duplicateId);
    if (!survivor || !duplicate) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    if (survivor.scope !== typedScope || duplicate.scope !== typedScope) {
      throw new ConvexError({
        code: "CROSS_SCOPE",
        message: "Both donors must belong to this book to merge.",
      });
    }
    const PREVIEW_CAP = 500;
    const dupPledges = await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", duplicateId))
      .take(PREVIEW_CAP);
    const dupSponsorships = await ctx.db
      .query("sponsorships")
      .withIndex("by_donor", (q) => q.eq("donorId", duplicateId))
      .take(PREVIEW_CAP);
    return {
      survivor: {
        _id: survivor._id,
        name: survivor.name,
        lifetimeCents: survivor.lifetimeCents,
        giftCount: survivor.giftCount,
      },
      duplicate: {
        _id: duplicate._id,
        name: duplicate.name,
        lifetimeCents: duplicate.lifetimeCents,
        giftCount: duplicate.giftCount,
        pledgeCount: dupPledges.length,
        sponsorshipCount: dupSponsorships.length,
      },
      // What the survivor becomes (gifts move; lifetime is recomputed from
      // actuals by `mergeDonors`, which equals the sum for non-negative gifts).
      resulting: {
        lifetimeCents: survivor.lifetimeCents + duplicate.lifetimeCents,
        giftCount: survivor.giftCount + duplicate.giftCount,
      },
    };
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
    // Owner feedback #4: the actor's optional "why", recorded on the donor-edit
    // audit breadcrumb (name/email/phone changes only).
    why: v.optional(v.string()),
  },
  returns: v.id("donors"),
  handler: async (ctx, args) => {
    const scope = args.scope as GivingScope;
    await requireGivingManage(ctx, scope);
    const actorUserId = (await requireUserId(ctx)) as Id<"users">;

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
      // Owner feedback #4: narrate a name/email/phone change on the donor audit
      // trail (the identity fields — never the address/notes churn). `patch`
      // only carries fields the caller sent, so an untouched field's "after" is
      // the donor's existing value.
      const contactChanges = diffFields(
        { name: "Name", email: "Email", phone: "Phone" },
        { name: donor.name, email: donor.email, phone: donor.phone },
        {
          name: patch.name,
          email: "email" in patch ? patch.email : donor.email,
          phone: "phone" in patch ? patch.phone : donor.phone,
        },
      );
      if (contactChanges.length > 0) {
        await writeDonorAudit(ctx, {
          donorId: args.donorId,
          scope,
          actorUserId,
          action: "edited",
          changes: contactChanges,
          note: args.why,
        });
      }
      // Territories P5: a CHAPTER-scope donor still unlinked (e.g. it was
      // created before an email/phone existed to match on, or the first
      // attempt found no roster match) gets a retry here — this edit may have
      // just supplied the email/phone that makes the match possible now. A
      // no-op for central donors (`linkDonorToPerson` short-circuits) and for
      // an already-linked donor (guarded below, so a re-edit never re-scans
      // the roster for nothing).
      if (scope !== "central" && donor.personId === undefined) {
        const linkedId = await linkDonorToPerson(ctx, { ...donor, ...patch });
        // A retry that actually established the link leaves its own breadcrumb.
        if (linkedId) {
          const person = await ctx.db.get(linkedId);
          await writeDonorAudit(ctx, {
            donorId: args.donorId,
            scope,
            actorUserId,
            action: "linkedPerson",
            changes: [{ field: "Linked person", to: person?.name ?? "—" }],
          });
        }
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
 * Set (or clear) a donor's linked roster PERSON — the manual repair for owner
 * feedback #3 (a merge, or a bad auto-link, left a chapter donor pointing at the
 * wrong person or none). Manage-gated at the donor's scope.
 *
 *  - `personId` a live people row → link. A CHAPTER donor may only link to a
 *    person on ITS OWN chapter's roster (the 1:1 invariant `linkDonorToPerson`
 *    enforces); a CENTRAL donor has no chapter roster and can never be linked
 *    (CRM-only), so a non-null personId is refused for central.
 *  - `personId: null` → unlink (always allowed).
 *
 * Writes a `linkedPerson` / `unlinkedPerson` donor-audit breadcrumb.
 */
export const setDonorPerson = mutation({
  args: {
    donorId: v.id("donors"),
    personId: v.union(v.id("people"), v.null()),
    why: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { donorId, personId, why }) => {
    const donor = await ctx.db.get(donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    await requireGivingManage(ctx, donor.scope);
    const actorUserId = (await requireUserId(ctx)) as Id<"users">;

    if (personId !== null) {
      if (donor.scope === "central") {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message:
            "A central donor is CRM-only and can't link to a chapter roster person.",
        });
      }
      const person = await ctx.db.get(personId);
      if (!person) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That person isn't on the roster.",
        });
      }
      if (person.chapterId !== donor.scope) {
        throw new ConvexError({
          code: "CROSS_CHAPTER",
          message: "A chapter donor can only link to a person on its own roster.",
        });
      }
      if (donor.personId === personId) return null; // already linked here
      await ctx.db.patch(donorId, { personId });
      await writeDonorAudit(ctx, {
        donorId,
        scope: donor.scope,
        actorUserId,
        action: "linkedPerson",
        changes: [
          {
            field: "Linked person",
            from: donor.personId
              ? (await ctx.db.get(donor.personId))?.name ?? "—"
              : "—",
            to: person.name,
          },
        ],
        note: why,
      });
      return null;
    }

    // Unlink.
    if (donor.personId === undefined) return null; // already unlinked
    const prior = await ctx.db.get(donor.personId);
    await ctx.db.patch(donorId, { personId: undefined });
    await writeDonorAudit(ctx, {
      donorId,
      scope: donor.scope,
      actorUserId,
      action: "unlinkedPerson",
      changes: [{ field: "Linked person", from: prior?.name ?? "—", to: "—" }],
      note: why,
    });
    return null;
  },
});

/**
 * A donor's audit trail (owner feedback #4) — every human change to its identity
 * fields + person link, newest-first, with the actor's name resolved. Read-gated
 * on the donor's scope; bounded `by_donor`. Mirrors `getGift`'s audit render.
 */
export const listDonorAudit = query({
  args: { donorId: v.id("donors") },
  handler: async (ctx, { donorId }) => {
    const donor = await ctx.db.get(donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    await requireGivingView(ctx, donor.scope);
    const rows = await ctx.db
      .query("donorAudit")
      .withIndex("by_donor", (q) => q.eq("donorId", donorId))
      .order("desc")
      .take(GIVING_AUDIT_READ_CAP);
    const actorNames = new Map<string, string>();
    for (const id of new Set(rows.map((a) => a.actorUserId))) {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", id))
        .unique();
      actorNames.set(
        id,
        profile?.name ?? (await ctx.db.get(id))?.email ?? "Someone",
      );
    }
    return rows.map((a) => ({
      _id: a._id,
      at: a.at,
      action: a.action,
      changes: a.changes ?? [],
      note: a.note ?? null,
      actorName: actorNames.get(a.actorUserId) ?? "Someone",
    }));
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

    const receivedAt = args.receivedAt ?? Date.now();
    const giftId = await recordGiftForDonor(ctx, {
      donorId: args.donorId,
      amountCents: args.amountCents,
      receivedAt,
      method: args.method,
      note: args.note?.trim() || undefined,
      eventId: args.eventId,
      externalRef: args.externalRef,
      receiptStorageIds: args.receiptStorageIds,
      recordedBy: userId,
    });
    await writeGiftAudit(ctx, {
      giftId,
      scope: donor.scope,
      actorUserId: userId,
      action: "created",
      changes: giftCreatedChanges(args.amountCents, receivedAt, args.method),
    });
    return giftId;
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
    // The actor's optional "why", recorded on the audit breadcrumb.
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const gift = await ctx.db.get(args.giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }
    await requireGivingManage(ctx, gift.scope);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    // Field-level diff computed from the PRE-edit gift (editGiftRow throws
    // GIFT_LOCKED before any write for an illegal money edit, so a change here
    // implies it actually committed).
    const changes: GiftFieldChange[] = [];
    if (args.amountCents !== undefined && args.amountCents !== gift.amountCents) {
      changes.push({
        field: "Amount",
        from: auditCents(gift.amountCents),
        to: auditCents(args.amountCents),
      });
    }
    if (args.receivedAt !== undefined && args.receivedAt !== gift.receivedAt) {
      changes.push({
        field: "Date",
        from: new Date(gift.receivedAt).toLocaleDateString(),
        to: new Date(args.receivedAt).toLocaleDateString(),
      });
    }
    if (args.method !== undefined && args.method !== gift.method) {
      changes.push({
        field: "Source",
        from: methodLabel(gift.method),
        to: methodLabel(args.method),
      });
    }
    if (args.note !== undefined) {
      const nextNote = args.note.trim();
      if (nextNote !== (gift.note ?? "")) {
        changes.push({
          field: "Note",
          from: gift.note ?? "—",
          to: nextNote || "—",
        });
      }
    }
    if (args.receiptStorageIds !== undefined) {
      const before = gift.receiptStorageIds?.length ?? 0;
      const after = args.receiptStorageIds.length;
      if (before !== after) {
        changes.push({
          field: "Receipts",
          from: `${before}`,
          to: `${after}`,
        });
      }
    }

    await editGiftRow(ctx, {
      giftId: args.giftId,
      amountCents: args.amountCents,
      receivedAt: args.receivedAt,
      method: args.method,
      note: args.note,
      receiptStorageIds: args.receiptStorageIds,
      editedBy: userId,
    });

    // Only narrate a real field change (a no-op edit writes no breadcrumb).
    if (changes.length > 0) {
      await writeGiftAudit(ctx, {
        giftId: args.giftId,
        scope: gift.scope,
        actorUserId: userId,
        action: "edited",
        changes,
        note: args.reason,
      });
    }
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

/**
 * Receipt-upload URL gated by SCOPE rather than an existing donor — for the
 * ledger's "Add gift" flow (owner request #3), where the donor is match-or-
 * created only at record time and so has no id to gate on when the receipt is
 * picked. Manage-gated at `scope`; the client passes the returned `storageId`
 * to `addGift`.
 */
export const generateGiftReceiptUploadUrlForScope = mutation({
  args: { scope: scopeValidator },
  handler: async (ctx, { scope }) => {
    await requireGivingManage(ctx, scope as GivingScope);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Remove a gift, reversing its rollups (clamped ≥ 0) + re-deriving status.
 *
 * Owner feedback #1 — deleting has EFFECTS, so it now REQUIRES a `why`
 * (non-empty): the real cases are a Givebutter "donation" that was actually a
 * ticket-sale payout (not a gift) and stray ticket purchases. Before the row is
 * gone, a `deleted` audit breadcrumb is written carrying a self-contained
 * SNAPSHOT (donor, amount, date, book, source) plus the reason — so the trail
 * stays legible AFTER the gift doc no longer exists (read book-level via
 * `giftAudit.by_scope_and_at`, since a deleted gift has no detail screen).
 */
export const removeGift = mutation({
  args: { giftId: v.id("gifts"), why: v.string() },
  returns: v.null(),
  handler: async (ctx, { giftId, why }) => {
    const gift = await ctx.db.get(giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }
    await requireGivingManage(ctx, gift.scope);
    // A system-written gift is the mirror of an external record — deleting it
    // here would desync the ledger from its source. Remove the source instead
    // (delete the event donation, cancel the pledge, void the bank match).
    if (isSystemWrittenGift(gift)) {
      throw new ConvexError({
        code: "GIFT_LOCKED",
        message:
          "This gift's money is owned by its source (an event, Stripe, a sponsorship, or a matched bank credit) — remove it from there, not here.",
      });
    }
    const reason = why.trim();
    if (!reason) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message: "Say why you're removing this gift — it has effects.",
      });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;

    // Snapshot BEFORE the row is gone (donor name resolved for readability).
    const donor = await ctx.db.get(gift.donorId);
    const snapshot: GiftFieldChange[] = [
      { field: "Donor", to: donor?.name ?? "Unknown donor" },
      { field: "Amount", to: auditCents(gift.amountCents) },
      { field: "Date", to: new Date(gift.receivedAt).toLocaleDateString() },
      { field: "Book", to: await bookLabel(ctx, gift.scope as GivingScope) },
      { field: "Source", to: methodLabel(gift.method) },
    ];

    await removeGiftRow(ctx, giftId);
    await writeGiftAudit(ctx, {
      giftId,
      scope: gift.scope as GivingScope,
      actorUserId: userId,
      action: "deleted",
      changes: snapshot,
      note: reason,
    });
    return null;
  },
});

/**
 * Add a MANUAL / external gift straight from the ledger (owner request #3 —
 * "Add gift"): the direct wires to the Relay account, Zelle/Cash App gifts,
 * things paid on behalf of the org. Match-or-creates the donor in the chosen
 * `scope` (central manager may pick any book; a chapter manager, their own),
 * records the gift (past dates + the full source vocabulary + receipts all
 * supported), and writes a `created` audit breadcrumb. Manage-gated at `scope`.
 */
export const addGift = mutation({
  args: {
    scope: scopeValidator,
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    kind: v.optional(donorKindValidator),
    amountCents: v.number(),
    method: giftMethodValidator,
    receivedAt: v.optional(v.number()),
    note: v.optional(v.string()),
    receiptStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  returns: v.object({ giftId: v.id("gifts"), donorId: v.id("donors") }),
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
    assertPositiveGiftCents(args.amountCents);
    assertReceiptsBound(args.receiptStorageIds);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const donorId = await matchOrCreateDonor(ctx, {
      scope,
      name,
      email: args.email,
      phone: args.phone,
      kind: args.kind,
      source: "manual",
    });
    const receivedAt = args.receivedAt ?? Date.now();
    const giftId = await recordGiftForDonor(ctx, {
      donorId,
      amountCents: args.amountCents,
      receivedAt,
      method: args.method,
      note: args.note?.trim() || undefined,
      receiptStorageIds: args.receiptStorageIds,
      recordedBy: userId,
    });
    await writeGiftAudit(ctx, {
      giftId,
      scope,
      actorUserId: userId,
      action: "created",
      changes: giftCreatedChanges(args.amountCents, receivedAt, args.method),
    });
    return { giftId, donorId };
  },
});

/**
 * Reassign a gift to a different donor in the SAME book (owner request #2 —
 * donor cleanup from the ledger). Manage-gated at the gift's scope; the target
 * donor must be in that same scope (enforced in `reassignGiftToDonor`). Keeps
 * both donors' rollups exact and the scope rollup neutral, then writes a
 * `reassignedDonor` audit breadcrumb.
 */
export const reassignGift = mutation({
  args: {
    giftId: v.id("gifts"),
    toDonorId: v.id("donors"),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const gift = await ctx.db.get(args.giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }
    await requireGivingManage(ctx, gift.scope);
    // A system-written gift's donor identity comes from its source; reassigning
    // it here would desync the mirror from that record (review finding).
    if (isSystemWrittenGift(gift)) {
      throw new ConvexError({
        code: "GIFT_LOCKED",
        message:
          "This gift's donor is owned by its source (an event, Stripe, a sponsorship, or a matched bank credit) and can't be reassigned here.",
      });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const result = await reassignGiftToDonor(ctx, {
      giftId: args.giftId,
      toDonorId: args.toDonorId,
    });
    await writeGiftAudit(ctx, {
      giftId: args.giftId,
      scope: result.scope,
      actorUserId: userId,
      action: "reassignedDonor",
      changes: [
        { field: "Donor", from: result.fromDonorName, to: result.toDonorName },
      ],
      note: args.reason,
    });
    return null;
  },
});

/**
 * Move a gift to a different BOOK (owner request #4a — central↔chapter,
 * chapter↔chapter). CENTRAL-MANAGE gated (a cross-book move is an org-level
 * action): `requireGivingManage(ctx, "central")` passes only for a central
 * manager / superuser. A SYSTEM-WRITTEN gift (event donation / Stripe cycle /
 * sponsorship payment / confirmed bank credit) is refused — its book is owned
 * by that source. The target donor is match-or-created in the destination book
 * (with a person link for a chapter); both books' rollups net exactly. Writes a
 * `movedScope` audit breadcrumb.
 */
export const moveGiftScope = mutation({
  args: {
    giftId: v.id("gifts"),
    toScope: scopeValidator,
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const gift = await ctx.db.get(args.giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }
    // Cross-book move is a central-manage action.
    await requireGivingManage(ctx, "central");

    if (isSystemWrittenGift(gift)) {
      throw new ConvexError({
        code: "GIFT_LOCKED",
        message:
          "This gift's book is managed by its source (an event, Stripe, a sponsorship, or a matched bank credit) and can't be moved here.",
      });
    }

    const toScope = args.toScope as GivingScope;
    if (toScope !== "central") {
      const chapter = await ctx.db.get(toScope);
      if (!chapter || chapter.isActive === false) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "Pick an active chapter (or Central) to move this gift to.",
        });
      }
    }

    const fromLabel = await bookLabel(ctx, gift.scope as GivingScope);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await moveGiftToScope(ctx, { giftId: args.giftId, toScope });
    const toLabel = await bookLabel(ctx, toScope);
    await writeGiftAudit(ctx, {
      giftId: args.giftId,
      scope: toScope,
      actorUserId: userId,
      action: "movedScope",
      changes: [{ field: "Book", from: fromLabel, to: toLabel }],
      note: args.reason,
    });
    return null;
  },
});

/**
 * Attach (or detach, `eventId: null`) a gift to an event — the fundraiser
 * attribution flow. Some Givebutter-imported/offline gifts were given "toward
 * the fundraiser" but land unattached; this lets an admin tag which event's
 * goal a gift counts toward. Manage-gated at the gift's OWN scope (same reach
 * as `editGift`) — attaching doesn't move money across books, only tags it.
 *
 * DOUBLE-COUNT GUARD (the CONTRACT invariant): a SYSTEM-WRITTEN on-page
 * donation (`donationId` set) is refused with `GIFT_HAS_EVENT_SOURCE` — its
 * `eventId` is already stamped by the dual-write and it's already counted in
 * that event's `donationsCents`; re-pointing it here would ALSO land it in
 * `externalGiftsCents`, double-counting the same dollar. Only a
 * `donationId === undefined` gift (manual entry, CSV import, bank-credit
 * match, etc.) is eligible.
 *
 * A chapter-scope gift may only attach to an event in that SAME chapter (an
 * event belongs to exactly one chapter, and a chapter caller's reach stops
 * there — mirrors `listForGiftAttach`'s picker); a central-scope gift may
 * attach to any active chapter's event (central-wide reach).
 *
 * Rollup bookkeeping goes entirely through `bumpEventExternalGifts`: the OLD
 * event (if any) loses `amountCents`/1, the NEW event (if any) gains it — so a
 * re-attach (old → new) nets to exactly the right totals on both events, never
 * touching `donationsCents`. Stamps `editedAt`/`editedBy` and a `edited` audit
 * breadcrumb, like `editGift`.
 */
export const attachGiftToEvent = mutation({
  args: {
    giftId: v.id("gifts"),
    eventId: v.union(v.id("events"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const gift = await ctx.db.get(args.giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }
    await requireGivingManage(ctx, gift.scope);

    if (gift.donationId !== undefined) {
      throw new ConvexError({
        code: "GIFT_HAS_EVENT_SOURCE",
        message:
          "This gift is an on-page donation — it's already auto-attributed to its event and can't be re-attached here.",
      });
    }

    const oldEventId = gift.eventId;
    const newEventId = args.eventId ?? undefined;
    if (oldEventId === newEventId) return null; // no-op transition

    let newEvent: Doc<"events"> | null = null;
    if (newEventId !== undefined) {
      newEvent = await ctx.db.get(newEventId);
      if (!newEvent) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
      }
      // A chapter-scope gift stays within its own chapter's events; central
      // reach may attach to any active chapter's event.
      if (gift.scope !== "central" && newEvent.chapterId !== gift.scope) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "Pick an event in this gift's own chapter.",
        });
      }
    }

    const userId = (await requireUserId(ctx)) as Id<"users">;
    const oldEvent = oldEventId !== undefined ? await ctx.db.get(oldEventId) : null;

    if (oldEventId !== undefined) {
      await bumpEventExternalGifts(ctx, oldEventId, -gift.amountCents, -1);
    }
    if (newEventId !== undefined) {
      await bumpEventExternalGifts(ctx, newEventId, gift.amountCents, 1);
    }

    await ctx.db.patch(args.giftId, {
      eventId: newEventId,
      editedAt: Date.now(),
      editedBy: userId,
    });

    await writeGiftAudit(ctx, {
      giftId: args.giftId,
      scope: gift.scope as GivingScope,
      actorUserId: userId,
      action: "edited",
      changes: [
        {
          field: "Event",
          from: oldEvent?.name ?? "—",
          to: newEvent?.name ?? "—",
        },
      ],
    });
    return null;
  },
});

/**
 * Split ONE gift into ≥2 per-part gifts across books (owner feedback #2 — his
 * use case: splitting a single wire between Central and New York while keeping
 * the underlying-transaction story). CENTRAL-MANAGE gated (a cross-book action).
 *
 * Rules:
 *  - ≥ 2 parts; each part's `amountCents` is a whole positive number of cents;
 *    the parts sum EXACTLY to the original amount (no money invented or lost).
 *  - A SYSTEM-WRITTEN gift (event donation / Stripe cycle / sponsorship / matched
 *    bank credit) is refused — its money is owned by that source.
 *  - Each part becomes its own gift: the SAME donor identity is matched-or-
 *    created in the part's book (person-linked for a chapter, via
 *    `matchOrCreateDonor`), with the original's date / method / receipts, and a
 *    note suffixed "(split i/N)". The original is then removed.
 *  - Rollups net EXACTLY: the original's contribution is reversed and the parts'
 *    contributions are added, so every book + donor total balances to the penny.
 *
 * Audit: a `split` breadcrumb on the ORIGINAL (snapshot + the per-part book/amount
 * refs) and a `createdBySplit` breadcrumb on EACH child (referencing the original).
 */
export const splitGift = mutation({
  args: {
    giftId: v.id("gifts"),
    parts: v.array(v.object({ scope: scopeValidator, amountCents: v.number() })),
    why: v.string(),
  },
  returns: v.object({ childGiftIds: v.array(v.id("gifts")) }),
  handler: async (ctx, { giftId, parts, why }) => {
    // A split can move money across books, so it's a central-manage action.
    await requireGivingManage(ctx, "central");
    const reason = why.trim();
    if (!reason) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message: "Say why you're splitting this gift.",
      });
    }

    const gift = await ctx.db.get(giftId);
    if (!gift) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
    }

    if (isSystemWrittenGift(gift)) {
      throw new ConvexError({
        code: "GIFT_LOCKED",
        message:
          "This gift's money is owned by its source (an event, Stripe, a sponsorship, or a matched bank credit) and can't be split here.",
      });
    }

    if (parts.length < 2) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A split needs at least two parts.",
      });
    }
    let sum = 0;
    for (const p of parts) {
      assertPositiveGiftCents(p.amountCents); // whole cents > 0
      if (p.scope !== "central") {
        const chapter = await ctx.db.get(p.scope as Id<"chapters">);
        if (!chapter || chapter.isActive === false) {
          throw new ConvexError({
            code: "INVALID_INPUT",
            message: "Each part must target an active chapter (or Central).",
          });
        }
      }
      sum += p.amountCents;
    }
    if (sum !== gift.amountCents) {
      throw new ConvexError({
        code: "SPLIT_MISMATCH",
        message: `The parts must sum to exactly ${auditCents(
          gift.amountCents,
        )} (they sum to ${auditCents(sum)}).`,
      });
    }

    const userId = (await requireUserId(ctx)) as Id<"users">;
    const sourceDonor = await ctx.db.get(gift.donorId);
    if (!sourceDonor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    const baseNote = gift.note?.trim();

    // Create each part's gift (donor matched-or-created + person-linked per book).
    const n = parts.length;
    const childGiftIds: Id<"gifts">[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const partScope = part.scope as GivingScope;
      const donorId = await matchOrCreateDonor(ctx, {
        scope: partScope,
        name: sourceDonor.name,
        email: sourceDonor.email,
        phone: sourceDonor.phone,
        kind: sourceDonor.kind,
        source: sourceDonor.source,
      });
      const partNote = `${baseNote ? `${baseNote} ` : ""}(split ${i + 1}/${n})`;
      const childId = await recordGiftForDonor(ctx, {
        donorId,
        amountCents: part.amountCents,
        receivedAt: gift.receivedAt,
        method: gift.method,
        note: partNote,
        recordedBy: userId,
        ...(gift.receiptStorageIds && gift.receiptStorageIds.length > 0
          ? { receiptStorageIds: gift.receiptStorageIds }
          : {}),
      });
      childGiftIds.push(childId);
      await writeGiftAudit(ctx, {
        giftId: childId,
        scope: partScope,
        actorUserId: userId,
        action: "createdBySplit",
        changes: [
          { field: "Amount", to: auditCents(part.amountCents) },
          { field: "Book", to: await bookLabel(ctx, partScope) },
          {
            field: "Split from",
            to: `${sourceDonor.name} · ${auditCents(gift.amountCents)}`,
          },
        ],
        note: reason,
      });
    }

    // Narrate the split on the original, then remove it (its rollups reverse).
    await writeGiftAudit(ctx, {
      giftId,
      scope: gift.scope as GivingScope,
      actorUserId: userId,
      action: "split",
      changes: [
        { field: "Donor", to: sourceDonor.name },
        { field: "Amount", to: auditCents(gift.amountCents) },
        { field: "Date", to: new Date(gift.receivedAt).toLocaleDateString() },
        { field: "Book", to: await bookLabel(ctx, gift.scope as GivingScope) },
        {
          field: "Split into",
          to: `${n} parts (${(
            await Promise.all(
              parts.map(
                async (p) =>
                  `${await bookLabel(ctx, p.scope as GivingScope)} ${auditCents(
                    p.amountCents,
                  )}`,
              ),
            )
          ).join(", ")})`,
        },
      ],
      note: reason,
    });
    await removeGiftRow(ctx, giftId);

    return { childGiftIds };
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
