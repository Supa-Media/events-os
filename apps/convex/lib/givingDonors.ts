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

  const personId =
    match?._id ??
    (await ctx.db.insert("people", {
      chapterId,
      name: donor.name,
      ...(donor.email ? { email: donor.email } : {}),
      ...(donor.phone ? { phone: donor.phone } : {}),
      isTeamMember: false,
      notes: "Added from Giving",
      createdAt: Date.now(),
    }));

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
  if (existing) return existing._id;

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

  // Territories launch pot: reverse ONLY a gift that was actually counted into
  // its territory's pot (`countedInLaunchFund`). `applyLaunchFundDelta` no-ops
  // if the territory has since launched (the freeze — a post-launch delete of a
  // pre-launch gift never un-bumps the frozen pot; the flag stays on the
  // deleted row's history, which is fine). See §D3.
  if (gift.countedInLaunchFund) {
    await applyLaunchFundDelta(ctx, gift.scope, -gift.amountCents);
  }
}

/**
 * Edit a gift IN PLACE, keeping every rollup delta-correct (territories P4).
 * The manual-correction counterpart to `recordGiftForDonor`/`removeGiftRow`:
 * rather than delete-and-re-add (which would churn `createdAt` ordering and the
 * launch-fund flag), it patches the existing row and applies only the deltas the
 * change actually implies.
 *
 * LOCK: a SYSTEM-WRITTEN gift — one carrying a `stripeInvoiceId` (a recurring
 * billing cycle) OR a `donationId` (an event donation dual-write) — is
 * NOTE/RECEIPT-ONLY here. Stripe / the event donation is the source of truth for
 * its money fields, so an edit that touches `amountCents`, `receivedAt`, or
 * `method` throws `GIFT_LOCKED`; a note/receipts-only edit is allowed.
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

  // Locked: Stripe / the event donation owns a system-written gift's money.
  const systemWritten =
    gift.stripeInvoiceId !== undefined || gift.donationId !== undefined;
  if (systemWritten && (amountChanging || receivedAtChanging || methodChanging)) {
    throw new ConvexError({
      code: "GIFT_LOCKED",
      message:
        "This gift was recorded by Stripe or an event donation — only its note and receipts can be edited here.",
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
    changed = true;
  }

  if (methodChanging) {
    giftPatch.method = args.method as Doc<"gifts">["method"];
    changed = true;
  }

  // Note + receipts are allowed even for a locked gift.
  if (args.note !== undefined) {
    const note = args.note.trim();
    giftPatch.note = note.length > 0 ? note : undefined;
    changed = true;
  }
  if (args.receiptStorageIds !== undefined) {
    giftPatch.receiptStorageIds =
      args.receiptStorageIds.length > 0 ? args.receiptStorageIds : undefined;
    changed = true;
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
