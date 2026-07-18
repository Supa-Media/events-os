/**
 * Giving Platform (F-6, Phase 1) — the development team's donor CRM API.
 *
 * Reads (gated by `requireGivingView`): `listDonors` (top-donor ordering),
 * `getDonor` (identity + recent gifts), `givingDashboard` (scope aggregates from
 * the denormalized rollup, never a full scan), `myGivingAccess` (the client's
 * nav/desk gate, like `financeRoles.mySeats`).
 *
 * Writes (gated by `requireGivingManage`): `upsertDonor`, `recordGift` (manual
 * backfill), `removeGift`, `importGivebutterCsv` (dedup on `externalRef`,
 * re-runnable). Every rollup mutation goes through the shared primitives in
 * `lib/givingDonors.ts`, so the counters stay identical to the event-donation
 * dual-write path in `giving.ts`.
 *
 * Money is always integer cents; `transactions` stays the only actuals ledger
 * (PRD §7). See docs/plans/giving-platform.md §1.
 */
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { normalizeEmail } from "./lib/access";
import { requireUserId } from "./lib/context";
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
} from "./lib/givingDonors";
import {
  DONOR_KINDS,
  DONOR_SOURCES,
  GIFT_METHODS,
} from "./schema/givingPlatform";

// ── Validators ────────────────────────────────────────────────────────────────

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const donorKindValidator = v.union(...DONOR_KINDS.map((k) => v.literal(k)));
const donorSourceValidator = v.union(...DONOR_SOURCES.map((s) => v.literal(s)));
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
/** Rows processed per CSV-import / backfill transaction before self-reschedule
 *  (keeps each mutation within Convex's per-transaction document limits). */
const IMPORT_BATCH_SIZE = 100;
const BACKFILL_BATCH_SIZE = 100;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The scope's donors, strongest lifetime first (the "top donors" workflow). */
export const listDonors = query({
  args: { scope: scopeValidator },
  handler: async (ctx, { scope }) => {
    await requireGivingView(ctx, scope as GivingScope);
    return await ctx.db
      .query("donors")
      .withIndex("by_scope_and_lifetime", (q) => q.eq("scope", scope))
      .order("desc")
      .take(DONOR_LIST_LIMIT);
  },
});

/** One donor + their recent gift history (the donor detail screen). */
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
    return { donor, gifts: giftsWithReceipts };
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

    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const recent = await ctx.db
      .query("gifts")
      .withIndex("by_scope_and_received", (q) =>
        q.eq("scope", scope).gte("receivedAt", cutoff),
      )
      .take(GIFT_WINDOW_LIMIT);
    const last30Cents = recent.reduce((sum, g) => sum + g.amountCents, 0);

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
 */
export const myGivingAccess = query({
  args: {},
  returns: v.object({
    canView: v.boolean(),
    canManage: v.boolean(),
    scope: v.union(v.literal("central"), v.id("chapters"), v.null()),
    chapterName: v.union(v.string(), v.null()),
  }),
  handler: async (ctx) => {
    const access = await resolveGivingAccess(ctx);
    // Central lens wins when the caller has central reach.
    if (access.isSuperuser || access.centralView) {
      return {
        canView: true,
        canManage: access.isSuperuser || access.centralManage,
        scope: "central" as const,
        chapterName: null,
      };
    }
    // Otherwise a chapter lens — the first chapter the caller can view.
    const chapterKey = [...access.viewChapters][0];
    if (chapterKey) {
      const chapterId = chapterKey as Id<"chapters">;
      const chapter = await ctx.db.get(chapterId);
      return {
        canView: true,
        canManage: access.manageChapters.has(chapterKey),
        scope: chapterId,
        chapterName: chapter?.name ?? null,
      };
    }
    return {
      canView: false,
      canManage: false,
      scope: null,
      chapterName: null,
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
      return args.donorId;
    }

    const donorId = await matchOrCreateDonor(ctx, {
      scope,
      name,
      email,
      kind: args.kind,
      source: args.source ?? "manual",
      ownerPersonId: args.ownerPersonId,
    });
    await ctx.db.patch(donorId, patch);
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

// ── CSV import (Givebutter backfill) ─────────────────────────────────────────

const importRowValidator = v.object({
  name: v.string(),
  email: v.optional(v.string()),
  amountCents: v.number(),
  receivedAt: v.number(),
  externalRef: v.string(),
  recurring: v.optional(v.boolean()),
});

type ImportRow = {
  name: string;
  email?: string;
  amountCents: number;
  receivedAt: number;
  externalRef: string;
  recurring?: boolean;
};

/**
 * Process one batch of parsed Givebutter rows: match-or-create donors by
 * lowercased email (fallback: exact name), dedupe gifts on `externalRef` (so a
 * re-run is safe), and self-reschedule the remainder to stay within
 * per-transaction limits. Shared by the public `importGivebutterCsv` (gated) and
 * the internal continuation.
 */
async function importRows(
  ctx: MutationCtx,
  scope: GivingScope,
  rows: ImportRow[],
): Promise<{ imported: number; skipped: number; scheduledRemaining: number }> {
  const slice = rows.slice(0, IMPORT_BATCH_SIZE);
  let imported = 0;
  let skipped = 0;

  for (const row of slice) {
    if (row.amountCents <= 0 || !Number.isInteger(row.amountCents)) {
      skipped++;
      continue; // a malformed amount never blocks the rest of the import
    }
    // `externalRef` dedup — a re-run of the same export inserts nothing.
    const existing = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", row.externalRef))
      .first();
    if (existing) {
      skipped++;
      continue;
    }
    const donorId = await matchOrCreateDonor(ctx, {
      scope,
      name: row.name,
      email: row.email,
      source: "givebutter-import",
    });
    await recordGiftForDonor(ctx, {
      donorId,
      amountCents: row.amountCents,
      receivedAt: row.receivedAt,
      method: "imported",
      externalRef: row.externalRef,
      ...(row.recurring ? { note: "Recurring (Givebutter)" } : {}),
    });
    imported++;
  }

  const remaining = rows.slice(IMPORT_BATCH_SIZE);
  if (remaining.length > 0) {
    await ctx.scheduler.runAfter(0, internal.givingPlatform.importGivebutterRest, {
      scope,
      rows: remaining,
    });
  }
  return { imported, skipped, scheduledRemaining: remaining.length };
}

/**
 * Import parsed Givebutter rows (donors + gifts). Match-or-creates donors by
 * lowercased email, dedupes gifts on `externalRef` (re-runnable), and processes
 * in batches. Admin-gated (`giving.manage` at `scope`); the continuation runs
 * as an internal scheduled mutation.
 */
export const importGivebutterCsv = mutation({
  args: { scope: scopeValidator, rows: v.array(importRowValidator) },
  returns: v.object({
    imported: v.number(),
    skipped: v.number(),
    scheduledRemaining: v.number(),
  }),
  handler: async (ctx, { scope, rows }) => {
    await requireGivingManage(ctx, scope as GivingScope);
    return await importRows(ctx, scope as GivingScope, rows);
  },
});

/** Internal continuation of `importGivebutterCsv` (already gated when scheduled). */
export const importGivebutterRest = internalMutation({
  args: { scope: scopeValidator, rows: v.array(importRowValidator) },
  handler: async (ctx, { scope, rows }) => {
    await importRows(ctx, scope as GivingScope, rows);
    return null;
  },
});

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
