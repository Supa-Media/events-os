/**
 * Giving Platform (F-6 P1) — the donor/gift/rollup write primitives shared by
 * `givingPlatform.ts` (the CRM's own mutations + CSV import) and `giving.ts`
 * (the event-donation dual-write). Centralized here so BOTH paths maintain the
 * denormalized counters identically — the house pattern from
 * `giving.ts#bumpGivingRollup`: bump on write, clamp ≥ 0, never count at read.
 *
 * Every helper is a plain async function on `MutationCtx` (not a registered
 * function), so callers invoke them directly without a `ctx.runMutation` hop.
 */
import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "./access";
import type { GivingScope } from "./givingAccess";

/** The 90-day lapse window (the AJ donor system's rule, PRD §1). */
export const LAPSE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type DonorStatus = "prospect" | "active" | "lapsed";

/** Guard: gift amounts are whole cents strictly greater than zero (mirrors
 *  `giving.ts#assertPositiveCents`). */
export function assertPositiveGiftCents(amountCents: number): void {
  if (amountCents <= 0 || !Number.isInteger(amountCents)) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "Amount must be a whole number of cents greater than zero.",
    });
  }
}

/**
 * Derive a donor's status from their rollups (PRD §1): no gifts → `prospect`;
 * a gift within the last 90 days → `active`; otherwise → `lapsed`. Pure.
 */
export function deriveDonorStatus(
  giftCount: number,
  lastGiftAt: number | undefined,
  now: number,
): DonorStatus {
  if (giftCount <= 0 || lastGiftAt === undefined) return "prospect";
  return now - lastGiftAt <= LAPSE_WINDOW_MS ? "active" : "lapsed";
}

type StatusCountField = "prospectCount" | "activeCount" | "lapsedCount";
const STATUS_COUNT_FIELD: Record<DonorStatus, StatusCountField> = {
  prospect: "prospectCount",
  active: "activeCount",
  lapsed: "lapsedCount",
};

/**
 * Apply a delta to a scope's rollup doc (creating it if missing), clamping
 * every counter at ≥ 0. `statusFrom`/`statusTo` shift the per-status counts on
 * a donor status transition (pass the same value for both, or omit, for none).
 */
export async function applyScopeDelta(
  ctx: MutationCtx,
  scope: GivingScope,
  delta: {
    lifetimeDelta?: number;
    giftDelta?: number;
    donorDelta?: number;
    statusFrom?: DonorStatus;
    statusTo?: DonorStatus;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("givingScopeRollups")
    .withIndex("by_scope", (q) => q.eq("scope", scope))
    .unique();
  const now = Date.now();
  const base = existing ?? {
    lifetimeCents: 0,
    giftCount: 0,
    donorCount: 0,
    activeCount: 0,
    lapsedCount: 0,
    prospectCount: 0,
  };

  const next = {
    lifetimeCents: Math.max(0, base.lifetimeCents + (delta.lifetimeDelta ?? 0)),
    giftCount: Math.max(0, base.giftCount + (delta.giftDelta ?? 0)),
    donorCount: Math.max(0, base.donorCount + (delta.donorDelta ?? 0)),
    activeCount: base.activeCount,
    lapsedCount: base.lapsedCount,
    prospectCount: base.prospectCount,
  };

  // A status transition moves one donor between the per-status buckets (or a
  // brand-new donor, `statusFrom` omitted, just increments the `statusTo` one).
  if (delta.statusFrom && delta.statusFrom !== delta.statusTo) {
    const from = STATUS_COUNT_FIELD[delta.statusFrom];
    next[from] = Math.max(0, next[from] - 1);
  }
  if (delta.statusTo && delta.statusTo !== delta.statusFrom) {
    const to = STATUS_COUNT_FIELD[delta.statusTo];
    next[to] = next[to] + 1;
  }

  if (existing) {
    await ctx.db.patch(existing._id, { ...next, updatedAt: now });
  } else {
    await ctx.db.insert("givingScopeRollups", {
      scope,
      ...next,
      updatedAt: now,
    });
  }
}

/**
 * Find a donor in `scope` by lowercased email (the primary dedup key), falling
 * back to an exact trimmed name match when no email is given — the same
 * match-or-create rule the CSV import + event dual-write share. Returns the
 * existing donor doc, or `null`.
 */
export async function findDonorInScope(
  ctx: MutationCtx,
  scope: GivingScope,
  opts: { email?: string; name?: string },
): Promise<Doc<"donors"> | null> {
  const email = normalizeEmail(opts.email) ?? undefined;
  if (email) {
    const byEmail = await ctx.db
      .query("donors")
      .withIndex("by_scope_and_email", (q) =>
        q.eq("scope", scope).eq("email", email),
      )
      .first();
    if (byEmail) return byEmail;
  }
  const name = opts.name?.trim();
  if (name) {
    const byName = await ctx.db
      .query("donors")
      .withIndex("by_scope_and_name", (q) =>
        q.eq("scope", scope).eq("name", name),
      )
      .first();
    if (byName) return byName;
  }
  return null;
}

/**
 * Match-or-create a donor in `scope`. Dedups by lowercased email then exact
 * name (see `findDonorInScope`); a fresh donor starts as a `prospect` with
 * zeroed rollups and bumps the scope's donor + prospect counts. Returns the
 * donor id (existing rows are left untouched — callers patch fields explicitly).
 */
export async function matchOrCreateDonor(
  ctx: MutationCtx,
  args: {
    scope: GivingScope;
    name: string;
    email?: string;
    kind?: Doc<"donors">["kind"];
    source?: Doc<"donors">["source"];
    ownerPersonId?: Id<"people">;
  },
): Promise<Id<"donors">> {
  const name = args.name.trim() || "Anonymous";
  const email = normalizeEmail(args.email) ?? undefined;

  const existing = await findDonorInScope(ctx, args.scope, { email, name });
  if (existing) return existing._id;

  const now = Date.now();
  const donorId = await ctx.db.insert("donors", {
    scope: args.scope,
    kind: args.kind ?? "individual",
    name,
    ...(email ? { email } : {}),
    status: "prospect",
    ...(args.ownerPersonId ? { ownerPersonId: args.ownerPersonId } : {}),
    ...(args.source ? { source: args.source } : {}),
    lifetimeCents: 0,
    giftCount: 0,
    createdAt: now,
  });
  await applyScopeDelta(ctx, args.scope, {
    donorDelta: 1,
    statusTo: "prospect",
  });
  return donorId;
}

/** Recompute + persist a donor's status from its current rollups, shifting the
 *  scope per-status counts if it changed. */
async function recomputeDonorStatus(
  ctx: MutationCtx,
  donor: Doc<"donors">,
  next: { giftCount: number; lastGiftAt: number | undefined },
): Promise<void> {
  const newStatus = deriveDonorStatus(
    next.giftCount,
    next.lastGiftAt,
    Date.now(),
  );
  if (newStatus !== donor.status) {
    await ctx.db.patch(donor._id, { status: newStatus });
    await applyScopeDelta(ctx, donor.scope, {
      statusFrom: donor.status,
      statusTo: newStatus,
    });
  }
}

/**
 * Insert a gift for a donor and bump every rollup: the donor's lifetime/count/
 * first/last, the donor's derived status, and the scope aggregates. The single
 * write path for recorded gifts (manual entry, CSV import, event dual-write).
 */
export async function recordGiftForDonor(
  ctx: MutationCtx,
  args: {
    donorId: Id<"donors">;
    amountCents: number;
    receivedAt: number;
    method: Doc<"gifts">["method"];
    eventId?: Id<"events">;
    donationId?: Id<"donations">;
    externalRef?: string;
    note?: string;
    recordedBy?: Id<"users">;
    // P2 recurring: a gift written from a Stripe subscription billing cycle
    // carries its `pledgeId` + the `stripeInvoiceId` (the cycle idempotency key).
    pledgeId?: Id<"pledges">;
    stripeInvoiceId?: string;
  },
): Promise<Id<"gifts">> {
  assertPositiveGiftCents(args.amountCents);
  const donor = await ctx.db.get(args.donorId);
  if (!donor) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
  }

  const now = Date.now();
  const giftId = await ctx.db.insert("gifts", {
    donorId: args.donorId,
    scope: donor.scope,
    amountCents: args.amountCents,
    currency: "usd",
    receivedAt: args.receivedAt,
    method: args.method,
    ...(args.eventId ? { eventId: args.eventId } : {}),
    ...(args.donationId ? { donationId: args.donationId } : {}),
    ...(args.externalRef ? { externalRef: args.externalRef } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(args.recordedBy ? { recordedBy: args.recordedBy } : {}),
    ...(args.pledgeId ? { pledgeId: args.pledgeId } : {}),
    ...(args.stripeInvoiceId ? { stripeInvoiceId: args.stripeInvoiceId } : {}),
    createdAt: now,
  });

  const giftCount = donor.giftCount + 1;
  const lastGiftAt = Math.max(donor.lastGiftAt ?? 0, args.receivedAt);
  const firstGiftAt = Math.min(
    donor.firstGiftAt ?? Number.POSITIVE_INFINITY,
    args.receivedAt,
  );
  await ctx.db.patch(args.donorId, {
    lifetimeCents: Math.max(0, donor.lifetimeCents + args.amountCents),
    giftCount,
    lastGiftAt,
    firstGiftAt,
  });
  await applyScopeDelta(ctx, donor.scope, {
    lifetimeDelta: args.amountCents,
    giftDelta: 1,
  });
  await recomputeDonorStatus(ctx, donor, { giftCount, lastGiftAt });
  return giftId;
}

/**
 * Remove a gift and reverse every rollup it contributed (clamped ≥ 0). The
 * donor's `first`/`lastGiftAt` are recomputed from the remaining gifts (a
 * bounded 1-row lookup each way), and status re-derived. The inverse of
 * `recordGiftForDonor`.
 */
export async function removeGiftRow(
  ctx: MutationCtx,
  giftId: Id<"gifts">,
): Promise<void> {
  const gift = await ctx.db.get(giftId);
  if (!gift) return;
  const donor = await ctx.db.get(gift.donorId);
  await ctx.db.delete(giftId);

  if (!donor) return;

  const giftCount = Math.max(0, donor.giftCount - 1);
  // Recompute the first/last bookends from the donor's REMAINING gifts.
  const newest = await ctx.db
    .query("gifts")
    .withIndex("by_donor", (q) => q.eq("donorId", donor._id))
    .order("desc")
    .first();
  const oldest = await ctx.db
    .query("gifts")
    .withIndex("by_donor", (q) => q.eq("donorId", donor._id))
    .order("asc")
    .first();
  const lastGiftAt = newest?.receivedAt;
  const firstGiftAt = oldest?.receivedAt;

  await ctx.db.patch(donor._id, {
    lifetimeCents: Math.max(0, donor.lifetimeCents - gift.amountCents),
    giftCount,
    lastGiftAt,
    firstGiftAt,
  });
  await applyScopeDelta(ctx, donor.scope, {
    lifetimeDelta: -gift.amountCents,
    giftDelta: -1,
  });
  await recomputeDonorStatus(ctx, donor, { giftCount, lastGiftAt });
}

/** Map an event `donations.method` to the giving `gifts.method` vocabulary. */
function donationMethodToGift(
  method: Doc<"donations">["method"],
): Doc<"gifts">["method"] {
  switch (method) {
    case "card":
      return "stripe";
    case "cash":
      return "cash";
    default:
      return "imported"; // "other" — a manual entry with no better channel
  }
}

/**
 * Dual-write a linked `gifts` row for a PAID event donation (PRD §1, B2):
 * match-or-create a donor scoped to the event's chapter (by email, else name)
 * and insert a gift with `donationId` set. Idempotent on the `donationId` link
 * — a second call (webhook retry, re-run migration) no-ops. Additive only: the
 * `donations` table + its event rollups are untouched.
 */
export async function dualWriteGiftForDonation(
  ctx: MutationCtx,
  donation: Doc<"donations">,
): Promise<void> {
  const existing = await ctx.db
    .query("gifts")
    .withIndex("by_donation", (q) => q.eq("donationId", donation._id))
    .first();
  if (existing) return; // already mirrored — idempotent

  const donorId = await matchOrCreateDonor(ctx, {
    scope: donation.chapterId,
    name: donation.name,
    email: donation.email,
    source: "event-donation",
  });
  await recordGiftForDonor(ctx, {
    donorId,
    amountCents: donation.amountCents,
    receivedAt: donation.createdAt,
    method: donationMethodToGift(donation.method),
    eventId: donation.eventId,
    donationId: donation._id,
    ...(donation.note ? { note: donation.note } : {}),
    ...(donation.recordedBy ? { recordedBy: donation.recordedBy } : {}),
  });
}

/** Remove the `gifts` row linked to an event donation (if any), reversing its
 *  rollups. The inverse of `dualWriteGiftForDonation`, for `removeDonation`. */
export async function removeGiftForDonation(
  ctx: MutationCtx,
  donationId: Id<"donations">,
): Promise<void> {
  const gift = await ctx.db
    .query("gifts")
    .withIndex("by_donation", (q) => q.eq("donationId", donationId))
    .first();
  if (gift) await removeGiftRow(ctx, gift._id);
}
