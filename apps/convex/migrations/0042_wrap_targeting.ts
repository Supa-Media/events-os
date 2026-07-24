import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { AudienceFilters } from "../lib/audienceResolve";
import type { AudienceCondition, AudienceTargeting } from "../lib/audienceTargeting";

/**
 * Targeting v2 wrap migration (specs/audience-targeting-v2.md "Schema/
 * migration"): stamp a `targeting` block onto every audience row that doesn't
 * have one yet, translated from its legacy shape, so the Phase C builder UI
 * only ever has to render ONE model. The legacy `source`/`filters`/
 * `excludeFilters` fields are deliberately LEFT IN PLACE (resolution ignores
 * them once `targeting` is present — see `lib/audienceResolve.ts`'s branch),
 * so rolling back is "stop reading `targeting`," never a data restore; the
 * legacy-path deletion is its own later PR, after prod shows zero unwrapped
 * rows (spec Phase D).
 *
 * ── Shape translations ─────────────────────────────────────────────────────
 *  - `person_filters` → one include group carrying one condition per SET
 *    filter criterion (`filtersToConditions` below — the exact field-by-field
 *    mapping); `excludeFilters` (when effective) → one exclude group the same
 *    way, minus `verifiedEmailOnly` (never evaluated on the exclude side —
 *    `lib/audienceResolve.ts#hasEffectiveExcludeCriteria`'s rule, so dropping
 *    it changes nothing). Empty `filters` `{}` → an empty-conditions group,
 *    the explicit "everyone" reading `validateTargeting` allows include-side.
 *    Attendance criteria fold JOINTLY onto one condition (`attendedEventId` +
 *    `attendedWithinDays` + `rsvpStatus` all qualify a single rsvp row in the
 *    legacy matcher, and `attended_event`/`attended_any` carry qualifiers for
 *    exactly this reason — see `schema/campaigns.ts`'s condition doc).
 *  - unscoped `"guests"` (no `filters.eventId` — the one shape 0041 couldn't
 *    represent) → `[[attended_any has]]` (+ its `chapterId` qualifier when the
 *    legacy row had a chapter filter): the `attended_any` primitive is exactly
 *    the "attended anything, ever, in scope" reading these rows always meant.
 *    KNOWN DELTA, counted not silent: the legacy resolver reached rsvps by
 *    raw email regardless of person-linkage; `attended_any` only sees LINKED
 *    rows — post-0037 that residue is the 22 deliberately-unmerged rows
 *    org-wide (see 0041's "Known-drift caveat"), and the composer preview's
 *    `unlinkedGuests` diagnostic surfaces it live on every edit.
 *  - leftover `"people"`/`"donors"` rows (0040 should have claimed them all)
 *    → counted `skippedOther`, NOT wrapped — if one ever shows up something
 *    upstream went wrong and a loud count beats a guessy translation.
 *
 * ── Semantic deltas on wrapped person_filters rows (documented, accepted) ──
 *  1. Donor criteria evaluate PER-CONDITION (∃ some donor row each) instead
 *     of jointly on one row — identical for single-book givers (nearly
 *     everyone); a multi-chapter giver can now satisfy two criteria via two
 *     books. See `lib/audienceTargeting.ts`'s module doc.
 *  2. Central-fallback donors now fail person-linked POSITIVE conditions
 *     (attendance/seat/kind/chapter/email_verified) instead of sailing past
 *     them (#424 finding A applied from day one — the legacy include side
 *     never evaluated those against fallback rows at all, a quirk this
 *     migration deliberately does not preserve).
 *
 * ── In-flight approvals are never invalidated by deploy ────────────────────
 * `computeCampaignSnapshotHash` includes `audienceTargeting` the moment the
 * field is present (key-omission rule, `campaigns.ts`), so wrapping an
 * audience CHANGES the hash of any campaign pointing at it. A campaign
 * sitting in `pending_approval`/`approved` would fail its approve/send-time
 * drift check from this migration alone — so any audience referenced by one
 * is SKIPPED (counted via `skippedPendingApproval`) and picked up by a later
 * re-run (`migrations:runWrapTargeting` can be invoked manually once those
 * campaigns land — the migration is idempotent, only unwrapped rows are ever
 * touched).
 *
 * IDEMPOTENT: rows with `targeting` already present are skipped every run.
 */

/**
 * ============================================================================
 * ONE `.paginate()` PER INVOCATION — same rule as 0040/0041 (see 0041's
 * banner; `convex-test` does not enforce it, prod does). The registry entry
 * runs the first page; `runWrapTargetingPage` schedules
 * `internal.migrations.continueWrapTargeting` to drain the rest.
 *
 * BOUNDED READS PER INVOCATION: the audiences page itself (`PAGE_SIZE`) plus
 * TWO bounded `campaigns.by_status` reads (`PENDING_CAMPAIGNS_CAP` each) to
 * build the skip set — no per-row nested reads at all (translation is pure
 * compute), so `PAGE_SIZE` can sit at 0040's 200 comfortably:
 *   reads(page) ≈ 200 + 2 × 500 = 1,200 — far inside the 32k cap.
 * ============================================================================
 */
const PAGE_SIZE = 200;

/** Bound on the in-flight-approval skip-set reads. If an org somehow has more
 *  than 500 campaigns sitting in ONE of pending_approval/approved, the set is
 *  incomplete and a wrapped audience could drift an unseen campaign's hash —
 *  at this org's scale (a handful of campaigns total) that's a theoretical
 *  bound, and the failure mode is a loud CONTENT_DRIFT on approve/send, never
 *  a silent mis-send. */
const PENDING_CAMPAIGNS_CAP = 500;

export type WrapTargetingPageResult = {
  scanned: number;
  wrappedPersonFilters: number;
  wrappedGuests: number;
  /** Rows already carrying `targeting` — nothing to do. */
  skippedAlreadyWrapped: number;
  /** Audiences referenced by a `pending_approval`/`approved` campaign this
   *  run — deliberately untouched so the deploy alone never invalidates an
   *  in-flight approval (see the module doc). Re-run the migration manually
   *  once those campaigns send. */
  skippedPendingApproval: number;
  /** Leftover legacy `"people"`/`"donors"` rows (0040's job) and `"guests"`
   *  rows WITH an eventId (0041's job) — never wrapped here; a non-zero count
   *  means an upstream migration didn't finish. */
  skippedOther: number;
  isDone: boolean;
  continueCursor: string | null;
};

/** Field-by-field translation of a legacy `AudienceFilters` object into v2
 *  conditions — one condition per SET criterion, attendance criteria folded
 *  jointly onto a single condition (see the module doc). `excludeSide` drops
 *  `verifiedEmailOnly` (never evaluated there in the legacy model, and
 *  `validateTargeting` rejects it in exclude groups). Exported for the wrap
 *  test's use. */
export function filtersToConditions(
  filters: AudienceFilters,
  opts: { excludeSide?: boolean } = {},
): AudienceCondition[] {
  const conditions: AudienceCondition[] = [];
  if (filters.chapterId) {
    conditions.push({ field: "chapter", op: "is", chapterId: filters.chapterId });
  }
  if (filters.teamOnly === true) conditions.push({ field: "kind", op: "is", kind: "team" });
  if (filters.contactsOnly === true) conditions.push({ field: "kind", op: "is", kind: "contact" });
  if (filters.donorStatus) {
    conditions.push({ field: "donor_status", op: "is", status: filters.donorStatus });
  }
  if (filters.givingLifetimeMinCents != null) {
    conditions.push({ field: "giving_lifetime", op: "gte", cents: filters.givingLifetimeMinCents });
  }
  if (filters.givingLifetimeMaxCents != null) {
    conditions.push({ field: "giving_lifetime", op: "lte", cents: filters.givingLifetimeMaxCents });
  }
  if (filters.giftCountMin != null) {
    conditions.push({ field: "gift_count", op: "gte", count: filters.giftCountMin });
  }
  if (filters.gaveWithinDays != null) {
    conditions.push({ field: "last_gift", op: "within_days", days: filters.gaveWithinDays });
  }
  if (filters.backerStatus) {
    conditions.push({ field: "backer", op: "is", status: filters.backerStatus });
  }
  if (filters.attendedEventId) {
    conditions.push({
      field: "attended_event",
      op: "has",
      eventId: filters.attendedEventId,
      ...(filters.rsvpStatus ? { rsvpStatus: filters.rsvpStatus } : {}),
      ...(filters.attendedWithinDays != null ? { withinDays: filters.attendedWithinDays } : {}),
    });
  } else if (filters.attendedWithinDays != null || filters.rsvpStatus) {
    conditions.push({
      field: "attended_any",
      op: "has",
      ...(filters.rsvpStatus ? { rsvpStatus: filters.rsvpStatus } : {}),
      ...(filters.attendedWithinDays != null ? { withinDays: filters.attendedWithinDays } : {}),
    });
  }
  if (filters.seatId) conditions.push({ field: "seat", op: "holds", seatId: filters.seatId });
  if (filters.verifiedEmailOnly === true && opts.excludeSide !== true) {
    conditions.push({ field: "email_verified", op: "is" });
  }
  return conditions;
}

/** The audienceIds referenced by any campaign currently sitting in
 *  `pending_approval` or `approved` — the rows this run must not touch. Two
 *  bounded indexed reads, built once per page invocation. */
async function pendingApprovalAudienceIds(ctx: MutationCtx): Promise<Set<Id<"audiences">>> {
  const ids = new Set<Id<"audiences">>();
  for (const status of ["pending_approval", "approved"] as const) {
    const rows: Doc<"campaigns">[] = await ctx.db
      .query("campaigns")
      .withIndex("by_status", (q) => q.eq("status", status))
      .take(PENDING_CAMPAIGNS_CAP);
    for (const c of rows) ids.add(c.audienceId);
  }
  return ids;
}

/** Process exactly ONE page — exactly one `.paginate()` call. `pageSize` is a
 *  TEST-ONLY override, same convention as 0040/0041. */
export async function runWrapTargetingPage(
  ctx: MutationCtx,
  cursor: string | null,
  pageSize?: number,
): Promise<WrapTargetingPageResult> {
  const skipIds = await pendingApprovalAudienceIds(ctx);
  const page = await ctx.db.query("audiences").paginate({ numItems: pageSize ?? PAGE_SIZE, cursor });

  const result = {
    scanned: 0,
    wrappedPersonFilters: 0,
    wrappedGuests: 0,
    skippedAlreadyWrapped: 0,
    skippedPendingApproval: 0,
    skippedOther: 0,
  };

  for (const audience of page.page) {
    result.scanned++;
    if (audience.targeting !== undefined) {
      result.skippedAlreadyWrapped++;
      continue;
    }
    if (skipIds.has(audience._id)) {
      result.skippedPendingApproval++;
      console.log(
        `migrations/0042_wrap_targeting: audience ${audience._id} ("${audience.name}") ` +
          `skipped — referenced by an in-flight approval; re-run runWrapTargeting ` +
          `after that campaign sends.`,
      );
      continue;
    }

    let targeting: AudienceTargeting | null = null;
    if (audience.source === "person_filters") {
      const excludeConditions = audience.excludeFilters
        ? filtersToConditions(audience.excludeFilters, { excludeSide: true })
        : [];
      targeting = {
        groups: [{ conditions: filtersToConditions(audience.filters) }],
        ...(excludeConditions.length > 0
          ? { excludeGroups: [{ conditions: excludeConditions }] }
          : {}),
      };
      result.wrappedPersonFilters++;
    } else if (audience.source === "guests" && audience.filters.eventId === undefined) {
      targeting = {
        groups: [
          {
            conditions: [
              {
                field: "attended_any",
                op: "has",
                ...(audience.filters.chapterId ? { chapterId: audience.filters.chapterId } : {}),
              },
            ],
          },
        ],
      };
      result.wrappedGuests++;
    } else {
      result.skippedOther++;
      console.log(
        `migrations/0042_wrap_targeting: audience ${audience._id} ("${audience.name}", ` +
          `source ${audience.source}) not wrapped — an upstream migration (0040/0041) ` +
          `owns this shape and apparently hasn't claimed it.`,
      );
      continue;
    }

    await ctx.db.patch(audience._id, { targeting });
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.migrations.continueWrapTargeting, {
      cursor: page.continueCursor,
    });
  }

  return {
    ...result,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

/** Registry entry point — first page only; the scheduled continuation drains
 *  the rest (same `runPending`-transaction shape as 0040/0041, and safe for
 *  the same reason: every branch above only touches a row still missing
 *  `targeting`). */
export async function runWrapTargeting(ctx: MutationCtx) {
  return await runWrapTargetingPage(ctx, null);
}

export const wrapTargeting: Migration = {
  name: "0042_wrap_targeting",
  run: runWrapTargeting,
};
