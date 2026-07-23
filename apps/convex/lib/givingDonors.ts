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
import { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeEmail } from "./access";
import type { GivingScope } from "./givingAccess";
import { territoryForChapter } from "../territories";
import { chapterRoster } from "./org";
import { syncDonorIdentity } from "./donorIdentity";

/** The 90-day lapse window (the AJ donor system's rule, PRD §1). */
export const LAPSE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** A gift's receipt array is bounded (territories P4) — proof, not an archive.
 *  Enforced at every write path (the schema validator can't cap array length). */
export const MAX_GIFT_RECEIPTS = 10;

/** Guard: a receipts array never exceeds `MAX_GIFT_RECEIPTS`. */
export function assertReceiptsBound(
  receiptStorageIds: readonly Id<"_storage">[] | undefined,
): void {
  if (receiptStorageIds && receiptStorageIds.length > MAX_GIFT_RECEIPTS) {
    throw new ConvexError({
      code: "TOO_MANY_RECEIPTS",
      message: `A gift can have at most ${MAX_GIFT_RECEIPTS} receipts.`,
    });
  }
}

export type DonorStatus = "prospect" | "active" | "lapsed";

/**
 * A gift whose MONEY IS OWNED BY ITS SOURCE — an event donation dual-write
 * (`donationId`), a Stripe recurring billing cycle (`stripeInvoiceId`), a
 * sponsorship agreement payment (`sponsorshipId`), or a matched/confirmed bank
 * credit (`transactionId`). Such a gift is the mirror of an external record, so
 * the desk must NOT rewrite its money, delete it, split it, reassign it, or move
 * its book here — those would desync the giving ledger from the source of truth
 * (`transactions`/`sponsorships`/the event donation/Stripe). The single shared
 * predicate, so every write path (`editGiftRow` lock + the `removeGift` /
 * `splitGift` / `reassignGift` / `moveGiftScope` mutations + the read-side
 * `systemWritten` flag) agrees on exactly which four fields lock a gift.
 */
export function isSystemWrittenGift(gift: Doc<"gifts">): boolean {
  return (
    gift.donationId !== undefined ||
    gift.stripeInvoiceId !== undefined ||
    gift.sponsorshipId !== undefined ||
    gift.transactionId !== undefined
  );
}

/**
 * OWNER RULE (Attendance C — people/donor dedup): a `people` roster row must
 * NEVER be created from an AUTOMATED giving path without at least ONE contact
 * identifier — an email OR a phone. A name-only record is a guest, not a roster
 * person: names collide constantly (so it can't be safely deduped), it can't be
 * contacted, and it silently inflates the roster with rows the cleanup tool then
 * has to chase. Matching an EXISTING roster row (by email, phone, OR name) stays
 * allowed everywhere — only INSERTS are gated. Enforced at the two automated
 * creation sources: `linkDonorToPerson` (below) and
 * `givingImport.ts#matchOrCreatePersonContact`. Manual `people.create` (a
 * deliberate admin add) is intentionally NOT gated here.
 */
export function hasPersonIdentifier(opts: {
  email?: string | null;
  phone?: string | null;
}): boolean {
  const email = normalizeEmail(opts.email) ?? undefined;
  const phone = opts.phone?.trim() || undefined;
  return Boolean(email || phone);
}

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
 * Territories launch pot (docs/plans/giving-territories.md §D3) — the ONE
 * choke point that moves a territory's `launchFundCents`. Returns `true` iff
 * `scope` is a chapter whose linked territory (via `territoryForChapter`) is
 * still `prospect`/`raising`; in that case it patches the territory's pot by
 * `deltaCents` (clamped ≥ 0) and returns `true`. Returns `false` — patching
 * NOTHING — for the `"central"` scope, a chapter with no territory, or a
 * territory that has already `launched`.
 *
 * That `launched` short-circuit IS the freeze: pre-launch giving accrues 100%
 * to the pot, but once the chapter goes live the pot stops moving in BOTH
 * directions — a positive delta (a new gift) never bumps a launched pot, and a
 * negative delta (a reversal of an old pre-launch gift) never un-bumps it
 * either. The pot is a frozen snapshot of what was raised before launch.
 *
 * Callers: `recordGiftForDonor` (positive `amountCents` after insert) and
 * `removeGiftRow` (negative, only for a gift that was actually counted). No
 * other site may touch `launchFundCents` — keep pot math here.
 */
export async function applyLaunchFundDelta(
  ctx: MutationCtx,
  scope: GivingScope,
  deltaCents: number,
): Promise<boolean> {
  if (scope === "central") return false;
  const territory = await territoryForChapter(ctx, scope);
  if (!territory) return false;
  if (territory.stage !== "prospect" && territory.stage !== "raising") {
    return false; // frozen at launch — no accrual, no reversal
  }
  const next = Math.max(0, territory.launchFundCents + deltaCents);
  await ctx.db.patch(territory._id, {
    launchFundCents: next,
    updatedAt: Date.now(),
  });
  return true;
}

/**
 * Find a donor in `scope` by lowercased email (the primary dedup key), falling
 * back to exact phone, then exact trimmed name — the match-or-create rule the
 * canonical import (territories P6), the legacy CSV import, and the event
 * dual-write all share. Phone is a read-only-safe fallback (the
 * `by_scope_and_phone` index, otherwise unused until P6) for a row that has no
 * email but does have a phone number. `ctx` is typed `QueryCtx` — every branch
 * only reads — so this is callable from a `query` (the import preview) as well
 * as every existing `MutationCtx` caller (a `MutationCtx` satisfies `QueryCtx`
 * structurally). Returns the existing donor doc, or `null`.
 */
export async function findDonorInScope(
  ctx: QueryCtx,
  scope: GivingScope,
  opts: { email?: string; phone?: string; name?: string },
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
  const phone = opts.phone?.trim() || undefined;
  if (phone) {
    const byPhone = await ctx.db
      .query("donors")
      .withIndex("by_scope_and_phone", (q) =>
        q.eq("scope", scope).eq("phone", phone),
      )
      .first();
    if (byPhone) return byPhone;
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
 * Territories P5 — link a CHAPTER-scope donor to its 1:1 `people` roster row,
 * patching `donor.personId` and returning the linked id. Returns `null` — no
 * roster read, no write — for a `"central"` donor: central donors have no
 * chapter roster to link into and stay CRM-only (documented on the schema
 * field). Idempotent to call repeatedly: a donor that's already linked is
 * simply re-matched/re-patched to the same result by its callers, who guard
 * on `personId === undefined` before invoking this.
 *
 * Match order within the donor's chapter roster (`lib/org.ts#chapterRoster`,
 * which already excludes `isPlaceholder`/`isSamplePerson` rows — a bounded
 * read, one chapter's roster):
 *  1. normalized-lowercase email (both sides case-insensitive),
 *  2. exact phone (both sides trimmed),
 *  3. exact trimmed name.
 *
 * No match → insert a minimal roster row for this donor (mirrors the shape
 * `people.create` writes: chapter, name, optional email/phone, `createdAt`)
 * flagged `isTeamMember: false` and noted `"Added from Giving"` so it reads
 * clearly as CRM-originated on the roster, not a manual add.
 */
export async function linkDonorToPerson(
  ctx: MutationCtx,
  donor: Doc<"donors">,
): Promise<Id<"people"> | null> {
  if (donor.scope === "central") return null; // no chapter roster to link into
  const chapterId = donor.scope;
  const roster = await chapterRoster(ctx, chapterId);

  const email = normalizeEmail(donor.email) ?? undefined;
  const phone = donor.phone?.trim() || undefined;
  const name = donor.name.trim();

  const match =
    (email && roster.find((p) => normalizeEmail(p.email) === email)) ||
    (phone && roster.find((p) => p.phone?.trim() === phone)) ||
    (name && roster.find((p) => p.name.trim() === name)) ||
    null;

  let personId: Id<"people">;
  if (match) {
    personId = match._id;
  } else {
    // OWNER RULE (Attendance C): never INSERT an identifier-less roster row from
    // the donor link — a name-only donor stays UNLINKED (personId undefined). A
    // later edit that adds an email/phone retries the link via `upsertDonor`'s
    // edit-path retry. Name-only MATCHING above is still honored; only the
    // insert below is gated. See `hasPersonIdentifier`.
    if (!hasPersonIdentifier({ email: donor.email, phone: donor.phone })) {
      return null;
    }
    personId = await ctx.db.insert("people", {
      chapterId,
      name: donor.name,
      ...(donor.email ? { email: donor.email } : {}),
      ...(donor.phone ? { phone: donor.phone } : {}),
      isTeamMember: false,
      notes: "Added from Giving",
      createdAt: Date.now(),
    });
  }

  await ctx.db.patch(donor._id, { personId });
  return personId;
}

/**
 * Match-or-create a donor in `scope`. Dedups by lowercased email, then exact
 * phone, then exact name (see `findDonorInScope`); a fresh donor starts as a
 * `prospect` with zeroed rollups and bumps the scope's donor + prospect
 * counts. Returns the donor id (existing rows are left untouched — callers
 * patch fields explicitly).
 *
 * A brand-new CHAPTER-scope donor is linked to the roster immediately
 * (`linkDonorToPerson`) — central-scope creates no-op there. `phone` is an
 * OPTIONAL arg (most callers — the event dual-write, legacy CSV import — never
 * had one; territories P6's canonical import always passes it through)
 * specifically so it's part of the first-insert record and therefore both the
 * MATCH step above (the phone fallback) and the first link attempt's
 * phone-match branch; a caller that learns the phone only AFTER this call (or
 * omits it here) relies on `upsertDonor`'s edit-path retry to pick up the link
 * later (see its own doc comment).
 */
export async function matchOrCreateDonor(
  ctx: MutationCtx,
  args: {
    scope: GivingScope;
    name: string;
    email?: string;
    phone?: string;
    kind?: Doc<"donors">["kind"];
    source?: Doc<"donors">["source"];
    ownerPersonId?: Id<"people">;
  },
): Promise<Id<"donors">> {
  const name = args.name.trim() || "Anonymous";
  const email = normalizeEmail(args.email) ?? undefined;
  const phone = args.phone?.trim() || undefined;

  const existing = await findDonorInScope(ctx, args.scope, {
    email,
    phone,
    name,
  });
  if (existing) {
    // Cross-chapter identity layer: keep the existing donor attached to its
    // identity (attaches it lazily if it predates the layer / the backfill).
    // Additive — never touches the donor's own per-scope rollups.
    await syncDonorIdentity(ctx, existing._id);
    return existing._id;
  }

  const now = Date.now();
  const donorId = await ctx.db.insert("donors", {
    scope: args.scope,
    kind: args.kind ?? "individual",
    name,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
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
  if (args.scope !== "central") {
    const inserted = await ctx.db.get(donorId);
    if (inserted) await linkDonorToPerson(ctx, inserted);
  }
  // Cross-chapter identity layer: attach the brand-new donor to its identity
  // (creating the identity if this is the first row for the person), adding this
  // scope to the identity's `scopes`. Done after the person-link so the fresh
  // donor doc is read inside `syncDonorIdentity`.
  await syncDonorIdentity(ctx, donorId);
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
 * write path for recorded gifts (manual entry, CSV import, event dual-write,
 * Givebutter donation sync).
 *
 * EVENT "GIVEN" ROLLUP: a gift TAGGED to an event that is NOT an on-page
 * donation (`eventId` set, `donationId` unset) also rolls into that event's
 * `externalGiftsCents`/`externalGiftsCount` — see the guarded bump at the end.
 * This is the fix for the historical gap where a gift carrying an `eventId`
 * (manual `recordGift`, the Givebutter donation sync) never actually counted
 * toward the event's Given total unless it was later run through
 * `attachGiftToEvent`.
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
    // P4: optional receipt proof captured at record time (bounded ≤ 10).
    receiptStorageIds?: Id<"_storage">[];
    // P7: set when this gift is CONFIRMED from a bank-credit candidate — the
    // evidence link back to the `transactions` row (see
    // `schema/givingPlatform.ts`'s `gifts.transactionId` doc).
    transactionId?: Id<"transactions">;
  },
): Promise<Id<"gifts">> {
  assertPositiveGiftCents(args.amountCents);
  assertReceiptsBound(args.receiptStorageIds);
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
    ...(args.receiptStorageIds && args.receiptStorageIds.length > 0
      ? { receiptStorageIds: args.receiptStorageIds }
      : {}),
    ...(args.transactionId ? { transactionId: args.transactionId } : {}),
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
  // Cross-chapter identity layer: the donor's lifetime/count/lastGift just
  // moved, so refresh its identity's recomputed aggregate. Additive — the
  // donor's own rollups above are untouched.
  await syncDonorIdentity(ctx, args.donorId);

  // Territories launch pot: a gift landing on a pre-launch territory's chapter
  // accrues 100% to that territory's `launchFundCents`. `applyLaunchFundDelta`
  // returns true only in that case; stamp the flag so the removal path can
  // reverse EXACTLY this gift (and only it) later. See §D3.
  const countedInLaunchFund = await applyLaunchFundDelta(
    ctx,
    donor.scope,
    args.amountCents,
  );
  if (countedInLaunchFund) {
    await ctx.db.patch(giftId, { countedInLaunchFund: true });
  }

  // Event fundraiser "Given" rollup: a gift TAGGED to an event that is NOT an
  // on-page donation dual-write (`eventId` set, `donationId` UNSET) rolls into
  // that event's `externalGiftsCents`/`externalGiftsCount` — the SAME rollup
  // `attachGiftToEvent` maintains — so a gift born with an `eventId` (manual
  // `recordGift`, the Givebutter donation sync) counts toward the event's Given
  // total immediately, closing the gap where it only counted after a manual
  // re-attach. The `donationId` guard is the double-count firewall: an on-page
  // donation's dual-written gift is already in `donationsCents`, so it must
  // never also land here (mirrors `bumpEventExternalGifts`'s contract +
  // `attachGiftToEvent`'s guard). `removeGiftRow` reverses this exact
  // (eventId && !donationId) case, and `attachGiftToEvent`'s same-event no-op
  // guard prevents a later re-attach from double-bumping. See
  // `schema/ticketing.ts`'s `externalGiftsCents` doc.
  if (args.eventId !== undefined && args.donationId === undefined) {
    await bumpEventExternalGifts(ctx, args.eventId, args.amountCents, 1);
  }
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
  // Cross-chapter identity layer: the donor's aggregate just shrank — refresh
  // its identity's recomputed totals to match.
  await syncDonorIdentity(ctx, donor._id);

  // Territories launch pot: reverse ONLY a gift that was actually counted into
  // its territory's pot (`countedInLaunchFund`). `applyLaunchFundDelta` no-ops
  // if the territory has since launched (the freeze — a post-launch delete of a
  // pre-launch gift never un-bumps the frozen pot; the flag stays on the
  // deleted row's history, which is fine). See §D3.
  if (gift.countedInLaunchFund) {
    await applyLaunchFundDelta(ctx, gift.scope, -gift.amountCents);
  }

  // Gift→event attach: a MANUALLY attached external gift (`eventId` set, NO
  // `donationId` — an on-page donation's dual-write is never un-bumped here,
  // it's owned by `giving.ts#bumpGivingRollup`/`removeDonation` instead) was
  // counted in that event's `externalGiftsCents`/`externalGiftsCount` — reverse
  // it so a delete stays consistent with `attachGiftToEvent`'s bookkeeping.
  if (gift.eventId !== undefined && gift.donationId === undefined) {
    await bumpEventExternalGifts(ctx, gift.eventId, -gift.amountCents, -1);
  }
}

/**
 * Edit a gift IN PLACE, keeping every rollup delta-correct (territories P4).
 * The manual-correction counterpart to `recordGiftForDonor`/`removeGiftRow`:
 * rather than delete-and-re-add (which would churn `createdAt` ordering and the
 * launch-fund flag), it patches the existing row and applies only the deltas the
 * change actually implies.
 *
 * LOCK: a SYSTEM-WRITTEN gift (`isSystemWrittenGift` — a Stripe billing cycle,
 * an event donation dual-write, a sponsorship payment, OR a matched bank credit)
 * is NOTE/RECEIPT-ONLY here. That source is the truth for its money fields, so an
 * edit that touches `amountCents`, `receivedAt`, or `method` throws `GIFT_LOCKED`;
 * a note/receipts-only edit is allowed.
 *
 * AMOUNT: patches the gift, then moves the donor `lifetimeCents`, the scope
 * rollup (`applyScopeDelta({lifetimeDelta})`), and — for a gift flagged
 * `countedInLaunchFund` — the territory pot (`applyLaunchFundDelta`) by the SAME
 * signed delta, exactly once each. The pot move respects the launch freeze:
 * `applyLaunchFundDelta` no-ops on a launched territory, so a post-launch amount
 * correction never disturbs the frozen pot. The `countedInLaunchFund` flag is
 * NEVER cleared or set by an edit — it stays whatever the original record made
 * it, so a later `removeGiftRow` still reverses the right rows.
 *
 * receivedAt: patches the gift, then recomputes the donor `first`/`lastGiftAt`
 * bookends from the SAME two bounded `by_donor` reads `removeGiftRow` uses, and
 * re-derives status (the new date may cross the 90-day lapse window).
 *
 * Any change stamps `editedAt`/`editedBy`. Validates cents (int > 0) and the
 * receipts bound (≤ 10). A no-op edit (nothing actually changed) writes nothing.
 */
export async function editGiftRow(
  ctx: MutationCtx,
  args: {
    giftId: Id<"gifts">;
    amountCents?: number;
    receivedAt?: number;
    method?: Doc<"gifts">["method"];
    note?: string;
    receiptStorageIds?: Id<"_storage">[];
    editedBy: Id<"users">;
  },
): Promise<void> {
  const gift = await ctx.db.get(args.giftId);
  if (!gift) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
  }
  const donor = await ctx.db.get(gift.donorId);
  if (!donor) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
  }

  const amountChanging =
    args.amountCents !== undefined && args.amountCents !== gift.amountCents;
  const receivedAtChanging =
    args.receivedAt !== undefined && args.receivedAt !== gift.receivedAt;
  const methodChanging =
    args.method !== undefined && args.method !== gift.method;

  // Locked: the money of a system-written gift is owned by its SOURCE — a Stripe
  // cycle, an event donation, a sponsorship payment, OR a matched bank credit.
  // A bank-confirmed (`transactionId`) or sponsorship (`sponsorshipId`) gift
  // carries neither `stripeInvoiceId` nor `donationId`, so the old two-field
  // check let its money be rewritten and desynced from `transactions`/the
  // sponsorship — `isSystemWrittenGift` covers all four (review finding).
  if (
    isSystemWrittenGift(gift) &&
    (amountChanging || receivedAtChanging || methodChanging)
  ) {
    throw new ConvexError({
      code: "GIFT_LOCKED",
      message:
        "This gift's money is owned by its source (Stripe, an event donation, a sponsorship, or a matched bank credit) — only its note and receipts can be edited here.",
    });
  }

  assertReceiptsBound(args.receiptStorageIds);
  if (amountChanging) assertPositiveGiftCents(args.amountCents as number);

  const giftPatch: Partial<Doc<"gifts">> = {};
  const donorPatch: Partial<Doc<"donors">> = {};
  let changed = false;

  // ── Amount: patch + move donor/scope/pot by the same delta, once each. ──
  if (amountChanging) {
    const delta = (args.amountCents as number) - gift.amountCents;
    giftPatch.amountCents = args.amountCents as number;
    donorPatch.lifetimeCents = Math.max(0, donor.lifetimeCents + delta);
    await applyScopeDelta(ctx, donor.scope, { lifetimeDelta: delta });
    // Only a gift that was actually counted moves the pot; the freeze (a
    // launched territory) is respected inside `applyLaunchFundDelta`. The
    // `countedInLaunchFund` flag stays as-is — an edit never re-flags a gift.
    if (gift.countedInLaunchFund) {
      await applyLaunchFundDelta(ctx, gift.scope, delta);
    }
    // An event-attached external gift's amount also feeds the event's
    // `externalGiftsCents` fundraiser rollup — keep it in lockstep so the public
    // "raised" total doesn't drift (and a later detach reverses the right
    // amount). Count is unchanged (still one gift). A `donationId` gift is
    // system-written and can't reach this branch (blocked above), so the only
    // gifts here that carry `eventId` are manually-attached external ones.
    if (gift.eventId && gift.donationId === undefined) {
      await bumpEventExternalGifts(ctx, gift.eventId, delta, 0);
    }
    changed = true;
  }

  if (methodChanging) {
    giftPatch.method = args.method as Doc<"gifts">["method"];
    changed = true;
  }

  // Note + receipts are allowed even for a locked gift. Compare to the CURRENT
  // value before flagging a change — a no-op resubmit must NOT stamp `editedAt`
  // (which would show the gift "edited" forever while `editGift`'s audit diff is
  // empty, so no breadcrumb — the stamp and the audit row must stay in lockstep;
  // review finding).
  if (args.note !== undefined) {
    const note = args.note.trim();
    const nextNote = note.length > 0 ? note : undefined;
    if (nextNote !== gift.note) {
      giftPatch.note = nextNote;
      changed = true;
    }
  }
  if (args.receiptStorageIds !== undefined) {
    const nextReceipts =
      args.receiptStorageIds.length > 0 ? args.receiptStorageIds : undefined;
    const current = gift.receiptStorageIds ?? [];
    const next = nextReceipts ?? [];
    const receiptsChanged =
      current.length !== next.length ||
      current.some((id, i) => id !== next[i]);
    if (receiptsChanged) {
      giftPatch.receiptStorageIds = nextReceipts;
      changed = true;
    }
  }

  if (receivedAtChanging) {
    giftPatch.receivedAt = args.receivedAt as number;
    changed = true;
  }

  if (!changed) return; // a no-op edit writes nothing.

  giftPatch.editedAt = Date.now();
  giftPatch.editedBy = args.editedBy;
  await ctx.db.patch(args.giftId, giftPatch);

  // receivedAt moved: recompute the bookends from the (now-patched) gift set,
  // mirroring `removeGiftRow`'s two bounded `by_donor` reads.
  if (receivedAtChanging) {
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
    donorPatch.lastGiftAt = newest?.receivedAt;
    donorPatch.firstGiftAt = oldest?.receivedAt;
  }

  if (Object.keys(donorPatch).length > 0) {
    await ctx.db.patch(donor._id, donorPatch);
  }

  // Status can only move when the last-gift date did (giftCount is unchanged).
  if (receivedAtChanging) {
    await recomputeDonorStatus(ctx, donor, {
      giftCount: donor.giftCount,
      lastGiftAt: donorPatch.lastGiftAt,
    });
  }

  // Cross-chapter identity layer: a money-field edit (amount or date) moved the
  // donor's lifetime / lastGift — refresh its identity aggregate. Note/receipt/
  // method-only edits don't touch the aggregate, so they skip this.
  if (amountChanging || receivedAtChanging) {
    await syncDonorIdentity(ctx, donor._id);
  }
}

/**
 * Recompute a donor's rollups after ONE gift leaves it (reassigned to another
 * donor or moved to another scope — the gift row is NOT deleted, only
 * re-pointed). The gift must ALREADY have been re-pointed away before calling,
 * so the `by_donor` bookend reads see only what remains. Mirrors
 * `removeGiftRow`'s donor-side math (lifetime −amount clamped, count −1,
 * bookends from the two bounded reads, status re-derived) WITHOUT the delete,
 * the scope delta, or the pot reversal — the caller owns those. Pure donor doc.
 */
async function recomputeDonorAfterGiftLeft(
  ctx: MutationCtx,
  donor: Doc<"donors">,
  amountCents: number,
): Promise<void> {
  const giftCount = Math.max(0, donor.giftCount - 1);
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
  await ctx.db.patch(donor._id, {
    lifetimeCents: Math.max(0, donor.lifetimeCents - amountCents),
    giftCount,
    lastGiftAt,
    firstGiftAt: oldest?.receivedAt,
  });
  await recomputeDonorStatus(ctx, donor, { giftCount, lastGiftAt });
  // Cross-chapter identity layer: this donor lost a gift (reassigned/moved) —
  // refresh its identity aggregate (a scope may drop out if this was the
  // donor's only tie, once the row's own totals recompute).
  await syncDonorIdentity(ctx, donor._id);
}

/**
 * Apply ONE gift's contribution to a donor that just gained it (the inverse of
 * `recomputeDonorAfterGiftLeft`). Mirrors `recordGiftForDonor`'s donor-side math
 * (lifetime +amount, count +1, bookends widened by `receivedAt`, status
 * re-derived) WITHOUT inserting a gift, moving a scope rollup, or touching the
 * pot — the caller owns those. Pure donor doc.
 */
async function applyGiftToDonor(
  ctx: MutationCtx,
  donor: Doc<"donors">,
  amountCents: number,
  receivedAt: number,
): Promise<void> {
  const giftCount = donor.giftCount + 1;
  const lastGiftAt = Math.max(donor.lastGiftAt ?? 0, receivedAt);
  const firstGiftAt = Math.min(
    donor.firstGiftAt ?? Number.POSITIVE_INFINITY,
    receivedAt,
  );
  await ctx.db.patch(donor._id, {
    lifetimeCents: Math.max(0, donor.lifetimeCents + amountCents),
    giftCount,
    lastGiftAt,
    firstGiftAt,
  });
  await recomputeDonorStatus(ctx, donor, { giftCount, lastGiftAt });
  // Cross-chapter identity layer: this donor gained a gift (reassigned/moved
  // in) — refresh its identity aggregate + `scopes`.
  await syncDonorIdentity(ctx, donor._id);
}

/**
 * Reassign a gift to a DIFFERENT donor in the SAME scope (gifts ledger cleanup,
 * owner request #2 — "two people giving under one name … merge their gifts").
 * The scope rollup is untouched (the money never leaves the book, it only moves
 * donors), and the launch pot is untouched (same scope, same territory, the
 * `countedInLaunchFund` flag stays as-is). Both donors' lifetime / count /
 * bookends / status re-derive exactly from actuals via the shared helpers.
 * Throws on a cross-scope target (use `moveGiftToScope` for that) or a no-op
 * same-donor target. Returns the display facts the audit line needs.
 */
export async function reassignGiftToDonor(
  ctx: MutationCtx,
  args: { giftId: Id<"gifts">; toDonorId: Id<"donors"> },
): Promise<{
  fromDonorId: Id<"donors">;
  fromDonorName: string;
  toDonorName: string;
  scope: GivingScope;
}> {
  const gift = await ctx.db.get(args.giftId);
  if (!gift) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
  }
  const fromDonor = await ctx.db.get(gift.donorId);
  const toDonor = await ctx.db.get(args.toDonorId);
  if (!fromDonor || !toDonor) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
  }
  if (fromDonor._id === toDonor._id) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That gift is already on this donor.",
    });
  }
  if (fromDonor.scope !== toDonor.scope) {
    throw new ConvexError({
      code: "CROSS_SCOPE",
      message: "Both donors must be in the same book to reassign a gift.",
    });
  }

  // Re-point first so the bookend reads exclude this gift from the old donor.
  await ctx.db.patch(args.giftId, { donorId: toDonor._id });
  await recomputeDonorAfterGiftLeft(ctx, fromDonor, gift.amountCents);
  await applyGiftToDonor(ctx, toDonor, gift.amountCents, gift.receivedAt);

  return {
    fromDonorId: fromDonor._id,
    fromDonorName: fromDonor.name,
    toDonorName: toDonor.name,
    scope: fromDonor.scope,
  };
}

/**
 * Move a gift to a DIFFERENT scope/book (owner request #4a — central↔chapter,
 * chapter↔chapter). The gift's donor must EXIST in the target scope: we
 * match-or-create a donor there for the SAME identity as the source donor
 * (`matchOrCreateDonor`, which also person-links a chapter donor), then apply
 * paired rollup updates so BOTH scope rollups net EXACTLY:
 *   - old scope: lifetime −amount, gift −1, and the old donor's status shift;
 *   - new scope: lifetime +amount, gift +1, the new donor (created → donor+1),
 *     and its status shift.
 * The launch pot follows the money: the OLD scope's pot is un-bumped iff the
 * gift was `countedInLaunchFund` (respecting the launch freeze via
 * `applyLaunchFundDelta`), the flag is cleared, then the NEW scope's pot is
 * bumped iff its territory is still pre-launch — and the flag re-set to match.
 *
 * Returns the target donor id + the display facts the audit line needs. The
 * caller gates this (cross-book move = central manage) and blocks system-written
 * gifts (event donation / Stripe / sponsorship / bank-credit), whose scope is
 * owned elsewhere.
 */
export async function moveGiftToScope(
  ctx: MutationCtx,
  args: { giftId: Id<"gifts">; toScope: GivingScope },
): Promise<{
  toDonorId: Id<"donors">;
  fromScope: GivingScope;
  donorName: string;
}> {
  const gift = await ctx.db.get(args.giftId);
  if (!gift) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Gift not found." });
  }
  const fromScope = gift.scope as GivingScope;
  if (fromScope === args.toScope) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That gift is already in this book.",
    });
  }
  const fromDonor = await ctx.db.get(gift.donorId);
  if (!fromDonor) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
  }

  // The gift's donor must exist in the target scope — match-or-create the same
  // identity there (also person-links a new chapter donor).
  const toDonorId = await matchOrCreateDonor(ctx, {
    scope: args.toScope,
    name: fromDonor.name,
    email: fromDonor.email,
    phone: fromDonor.phone,
    kind: fromDonor.kind,
    source: fromDonor.source,
  });
  const toDonor = await ctx.db.get(toDonorId);
  if (!toDonor) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
  }

  const amountCents = gift.amountCents;
  const wasCounted = gift.countedInLaunchFund === true;

  // Old-scope pot reversal FIRST (uses the gift's original scope). Freeze-safe.
  if (wasCounted) {
    await applyLaunchFundDelta(ctx, fromScope, -amountCents);
  }

  // Re-point the gift onto the new donor + new scope; clear the pot flag (the
  // new-scope pot re-decides it below).
  await ctx.db.patch(args.giftId, {
    donorId: toDonor._id,
    scope: args.toScope,
    countedInLaunchFund: false,
  });

  // Old donor + old scope rollup lose exactly this gift.
  await recomputeDonorAfterGiftLeft(ctx, fromDonor, amountCents);
  await applyScopeDelta(ctx, fromScope, {
    lifetimeDelta: -amountCents,
    giftDelta: -1,
  });

  // New donor + new scope rollup gain exactly this gift.
  await applyGiftToDonor(ctx, toDonor, amountCents, gift.receivedAt);
  await applyScopeDelta(ctx, args.toScope, {
    lifetimeDelta: amountCents,
    giftDelta: 1,
  });

  // New-scope pot: accrue iff its territory is still pre-launch, and stamp the
  // flag to match so a later removal reverses the right pot.
  const countedNow = await applyLaunchFundDelta(ctx, args.toScope, amountCents);
  if (countedNow) {
    await ctx.db.patch(args.giftId, { countedInLaunchFund: true });
  }

  return { toDonorId: toDonor._id, fromScope, donorName: fromDonor.name };
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
      return "other"; // a manual entry with no better channel
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

/**
 * Bump `eventPages.externalGiftsCents`/`externalGiftsCount` by the given
 * deltas (clamped ≥ 0), for an event's `by_event` page row. Mirrors
 * `giving.ts#bumpGivingRollup`'s pattern exactly, but for the SIBLING counter
 * that tracks donor-CRM gifts attributed to an event (Givebutter donations /
 * offline gifts given "toward the fundraiser"), never the on-page donation
 * flow's `donationsCents`. Callers: `recordGiftForDonor` (a gift born with an
 * `eventId`), `attachGiftToEvent`/detach, `editGiftRow` (amount change), and
 * `removeGiftRow` (reversal). Callers MUST only invoke this for a gift with
 * `donationId === undefined` — an on-page donation's dual-written gift is
 * already counted in `donationsCents`, and folding it into `externalGiftsCents`
 * too would double-count (see `schema/ticketing.ts`'s `externalGiftsCents`
 * doc). No-op (no write) if the event has no `eventPages` row.
 */
export async function bumpEventExternalGifts(
  ctx: MutationCtx,
  eventId: Id<"events">,
  deltaCents: number,
  deltaCount: number,
): Promise<void> {
  const page = await ctx.db
    .query("eventPages")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .unique();
  if (!page) return;
  await ctx.db.patch(page._id, {
    externalGiftsCents: Math.max(0, (page.externalGiftsCents ?? 0) + deltaCents),
    externalGiftsCount: Math.max(0, (page.externalGiftsCount ?? 0) + deltaCount),
    updatedAt: Date.now(),
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
