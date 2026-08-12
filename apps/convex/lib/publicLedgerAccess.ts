/**
 * Public-ledger authorization — who may prepare a month's statement, and who
 * may put it in front of the world.
 *
 * House rule ("Gate It Behind a Power, Even When It's Open Today"):
 * `publicLedger.ts` calls ONLY these pairs and never checks a seat or a
 * finance role inline. Three powers, because they have three genuinely
 * different blast radii — and because this is the feature where getting that
 * wrong is most expensive. Publishing is irreversible in the way that
 * matters: you can amend a published month, but you cannot make the internet
 * un-see it.
 *
 *  - PREPARE (`requireLedgerPrepare`) — build and submit a book's working
 *    snapshot. Today: finance MANAGER at that book (central reach for a
 *    central-owned or foreign book), i.e. the same people who already
 *    reconcile it. Manager rather than the bookkeeper floor `listReconcile`
 *    uses, deliberately: assembling the artifact that will be published is a
 *    step beyond working the queue, even though every number in it came from
 *    that queue.
 *
 *  - PUBLISH (`requireLedgerPublish`) — approve a submitted snapshot and make
 *    it (or an amendment to it) public. Gated on the `finance.publish` seat
 *    capability, NOT on a finance role, and that asymmetry is the point: this
 *    is the one finance action whose audience is everyone, so it should be
 *    grantable and revocable per SEAT at runtime rather than implied by
 *    holding the finance-manager ladder. Same reasoning — and the same
 *    mechanism — as `campaigns.approve`, the other power that publishes to an
 *    outside audience.
 *
 *  - CONSOLE (`requireLedgerConsole`) — read the publish console: statuses,
 *    working snapshots, the amendment log. Finance VIEWER+ at the book, so
 *    the treasurer and the bookkeeper doing the close can see what's about to
 *    be said about their work without being able to say it.
 *
 * SEPARATION OF DUTIES is enforced in `publicLedger.ts` (via
 * `lib/finance.ts#assertSeparationOfDuties`), not here — same division as the
 * budget and campaign approval flows, where the access module answers "may
 * this person ever do this?" and the mutation answers "may they do it to THIS
 * row, given who submitted it?"
 *
 * NOTHING GATES THE PUBLIC READ. `publicLedger.publicStatement` and the
 * `/finances` route are anonymous by design — that is the feature. What
 * protects them is that they read `financePublicationEntries`, which contains
 * only what a human approved for publication and, for gifts, never contained
 * donor-identifying fields in the first place (see `schema/publicLedger.ts`).
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CENTRAL, expandPowers } from "@events-os/shared";
import {
  getFinanceRole,
  requireFinanceCentral,
  requireFinanceRole,
  type FinanceAccess,
  type FinanceScope,
} from "./finance";
import { isSuperuser } from "./superuser";

/** Bound on how many seat assignments a single person can hold — mirrors
 *  `lib/seats.ts#PERSON_SEAT_ASSIGNMENT_LIMIT` and
 *  `lib/campaignsAccess.ts#holdsCampaignCapabilityAt`. */
const PERSON_SEAT_ASSIGNMENT_LIMIT = 200;

/**
 * `homeChapterId` is always the CALLER's own chapter — a central grant is
 * scope-wide regardless of which chapter it resolves against, but
 * `getFinanceRole` only finds a roster row in the chapter passed in. `book` is
 * what they're asking to act on. (The note `publishabilityAccess.ts` carries,
 * for the same reason.)
 */

// ── Prepare ──────────────────────────────────────────────────────────────────

/** Whether the caller may build/submit a book's working statement. */
export async function hasLedgerPrepare(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  book: FinanceScope,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, homeChapterId);
  if (book === CENTRAL || book !== homeChapterId) return access.isCentral;
  return access.isManager;
}

/** The `require` half of {@link hasLedgerPrepare}. Returns the resolved access
 *  so the caller doesn't re-resolve it. */
export async function requireLedgerPrepare(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  book: FinanceScope,
): Promise<FinanceAccess> {
  if (book === CENTRAL || book !== homeChapterId) {
    return requireFinanceCentral(ctx, homeChapterId);
  }
  return requireFinanceRole(ctx, homeChapterId, "manager");
}

// ── Publish ──────────────────────────────────────────────────────────────────

/**
 * True iff `personId` holds a seat AT `scope` carrying `finance.publish`.
 *
 * Modelled on `lib/campaignsAccess.ts#holdsCampaignCapabilityAt` (indexed
 * `by_person` scan, skip `derived` seats — computed/rolled-up seats are never
 * real occupancy). There is no implication ladder to walk: `finance.publish`
 * is a leaf power that nothing else implies, deliberately. A finance manager
 * reconciles; publishing is a separate decision, and the whole reason this is
 * a seat capability is so it can be handed to exactly the people the org
 * means to trust with an outside audience.
 */
async function holdsPublishSeatAt(
  ctx: QueryCtx,
  personId: Id<"people">,
  scope: FinanceScope,
): Promise<boolean> {
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(PERSON_SEAT_ASSIGNMENT_LIMIT);
  for (const assignment of assignments) {
    if (assignment.scope !== scope) continue;
    const def = await ctx.db.get(assignment.seatDefId);
    if (!def || def.derived) continue;
    if (expandPowers(def.capabilities).has("finance.ledger.publish")) return true;
  }
  return false;
}

/**
 * Whether the caller holds the power to make a statement public.
 *
 * `finance.publish` is a SEAT capability, resolved through the seat chart, so
 * "who can publish the books?" is answered by the org chart rather than by a
 * finance-role grant nobody outside the finance desk can see.
 *
 * A CENTRAL-scope publish seat authorizes publishing ANY book. That is not a
 * shortcut around the usual "central reach for a foreign book" rule — it IS
 * that rule, expressed on the seat chart: a central seat is exactly what
 * central reach means here. A chapter-scope publish seat authorizes only that
 * chapter's own book.
 *
 * Superusers short-circuit, the same solo-operator relaxation `getFinanceRole`
 * already applies — the org has one person in it today, and a two-party gate
 * with nobody to be the second party is a gate that stops the work rather
 * than a gate that protects anything. `assertLedgerSeparationOfDuties` in
 * `publicLedger.ts` records which way each decision went (`approvalParty`), so
 * the relaxation is a stated fact on every revision rather than a silent one.
 */
export async function hasLedgerPublish(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  book: FinanceScope,
): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  const access = await getFinanceRole(ctx, homeChapterId);
  if (!access.personId) return false;
  if (await holdsPublishSeatAt(ctx, access.personId, CENTRAL)) return true;
  // A chapter-scope publish seat reaches its OWN book only.
  if (book === CENTRAL || book !== homeChapterId) return false;
  return holdsPublishSeatAt(ctx, access.personId, book);
}

/** The `require` half of {@link hasLedgerPublish}. */
export async function requireLedgerPublish(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  book: FinanceScope,
): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, homeChapterId);
  if (!(await hasLedgerPublish(ctx, homeChapterId, book))) {
    // `ConvexError({ code, message })` is the app-wide refusal shape the
    // mobile `FinanceBoundary` / `AuthErrorBoundary` read.
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Publishing a month to the public finances page needs a seat that carries the Publish finances power.",
    });
  }
  return access;
}

// ── Console ──────────────────────────────────────────────────────────────────

/** Whether the caller may read the publish console for a book. */
export async function hasLedgerConsole(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  book: FinanceScope,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, homeChapterId);
  if (book === CENTRAL || book !== homeChapterId) return access.isCentral;
  return access.role != null;
}

/** The `require` half of {@link hasLedgerConsole}. */
export async function requireLedgerConsole(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  book: FinanceScope,
): Promise<FinanceAccess> {
  if (book === CENTRAL || book !== homeChapterId) {
    return requireFinanceCentral(ctx, homeChapterId);
  }
  return requireFinanceRole(ctx, homeChapterId, "viewer");
}
