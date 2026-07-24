import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

/**
 * Legacy "guests" audience → `person_filters` migration (person-centric
 * audiences Phase 3 item 5 — specs/person-centric-audiences.md "Phase 3",
 * point 5; the second half of the job `migrations/0040_migrate_legacy_
 * audiences.ts` deliberately left undone).
 *
 * 0040 migrated "people"/"donors"-sourced audiences to `person_filters` but
 * left every "guests" row on its legacy source, because the attendance
 * criteria `person_filters` resolves through (`attendedEventId`/
 * `attendedWithinDays`/`rsvpStatus`, via `lib/audienceResolve.ts#
 * personAttendsMatch`) go through `rsvps.personId` — Phase 1's guest→person
 * link — and that link was NOT guaranteed to be backfilled for every
 * historical rsvp yet (`migrations/0037_link_rsvp_people.ts` is a manual,
 * human-reviewed backfill, not auto-registered — see its own doc). Migrating
 * "guests" audiences before 0037 had actually run would have silently
 * UNDER-resolved them (a real guest the legacy resolver reached would vanish
 * from the migrated audience with no signal).
 *
 * That blocker is gone: 0037 was fully executed in production on 2026-07-24
 * (all 1,640 historical rsvps processed; 4 linked; 0 failures — the remaining
 * unlinked rows are either identifier-less (nothing to match/create from) or
 * the deliberately-unmerged divergent-name shared-email groups, 22 rows
 * org-wide — see 0037's own doc on why those stay unlinked by design, not by
 * omission). This migration is the follow-up 0040's doc promised: "re-run
 * this migration (or write a follow-up) once 0037 has executed in every
 * environment that matters."
 *
 * ── "guests" → person_filters {attendedEventId, chapterId?} ────────────────
 * `lib/audienceResolve.ts#resolveGuests` interprets a legacy "guests" row as:
 *   - `filters.eventId` set → scan JUST that event's rsvps (`chapterId`, even
 *     if also set, is never consulted in this branch — `resolveGuestEventIds`
 *     returns `[filters.eventId]` outright, and an event only ever belongs to
 *     one chapter, so a `chapterId` alongside a matching `eventId` is
 *     redundant, never contradictory, in every real row this app can produce).
 *   - `filters.eventId` UNSET → scan every event across `targetChapterIds`
 *     (just `filters.chapterId`'s events when set, else every active
 *     chapter's) — i.e. "this guest attended ANYTHING, ever, in scope," with
 *     no time bound and no per-event narrowing.
 * `person_filters`' attendance criteria have no primitive for that second
 * shape: `hasAttendanceCriteria` (`resolvePersonFilters`) only activates when
 * `attendedEventId`/`attendedWithinDays`/`rsvpStatus` is actually SET, and
 * none of those three means "attended anything, ever, no window" —
 * `attendedWithinDays` is a RELATIVE rolling window keyed off `rsvps.
 * createdAt`, not an unbounded "ever." Stuffing an arbitrarily huge
 * `attendedWithinDays` in to fake "ever" would misrepresent the audience's
 * own stored definition (a human editing it later sees a nonsense "attended
 * within 36,500 days" filter) for a semantic that was never actually a
 * rolling window — worse than leaving it alone. Per this app's task scope,
 * adding a new filter primitive to `lib/audienceResolve.ts` is explicitly
 * OUT of scope for this migration (that file gets, at most, a comment).
 * So:
 *   - `filters.eventId` SET → migrated: `attendedEventId: filters.eventId`,
 *     carrying `filters.chapterId` over unchanged when present (harmless per
 *     the redundancy noted above, and mirrors 0040's "carry chapterId over
 *     when set" mapping style for `people`/`donors`).
 *   - `filters.eventId` UNSET → deliberately left unmigrated, counted via
 *     `skippedGuestsUnscoped` — the same "leave it alone rather than ship an
 *     under- or mis-specified audience" call 0040 made for every "guests" row,
 *     just narrowed now to the one shape that's still unrepresentable.
 *
 * ── Known-drift caveat (accepted, honestly counted) ─────────────────────────
 * `resolveGuests` scans `rsvps` by raw email — it reaches a guest with an
 * email on file REGARDLESS of whether that rsvp is linked to a `people` row.
 * `personAttendsMatch` (the migrated representation's resolver) can only ever
 * reach a LINKED rsvp (`rsvps.by_person`). So a migrated "guests" audience
 * loses exactly the guests who have an email but no `personId` — after 0037,
 * that's no longer "most of the guest list" (the pre-0037 state 0040's doc
 * worried about), it's specifically the deliberately-unmerged divergent-name
 * group members (22 rows org-wide, per 0037's production run) plus any rsvp
 * created after 0037 ran but before its own write-through link fired (an
 * unlikely race, not a systemic gap — every live insert site calls
 * `lib/rsvpPeople.ts#linkRsvpToPerson` synchronously). This migration
 * QUANTIFIES that residue per migrated audience — `unlinkedGuestResidue` in
 * the page result, plus a per-audience `console.log` when it's non-zero — so
 * the gap is a counted, visible fact, not a silent shrink. The composer
 * preview's `unlinkedGuests` diagnostic (`lib/audienceResolve.ts#
 * countUnlinkedGuests`, shipped in #417) surfaces this SAME residue on an
 * ongoing basis to whoever edits the migrated audience afterward — this
 * migration's count is a one-time snapshot at migration time, that preview
 * field is the live, permanent signal.
 *
 * ── Legacy resolvers stay ────────────────────────────────────────────────
 * `resolveGuests`/`resolveDonors`/`resolvePeople` (`lib/audienceResolve.ts`)
 * are NOT deleted here — a "guests" row with no `eventId` (see above) still
 * resolves through `resolveGuests` indefinitely, and removal is only safe
 * once zero legacy-sourced rows remain across every deployment (see that
 * file's own comment, added alongside this migration). Tracked as a
 * follow-up PR once this migration is verified complete in prod.
 *
 * IDEMPOTENT: only rows whose CURRENT `source` is still `"guests"` AND carry
 * an `eventId` are touched; an already-`person_filters` row, a `"guests"` row
 * with no `eventId`, and (defensively) any leftover `"people"`/`"donors"` row
 * this migration doesn't own are all skipped every run — so re-running
 * changes nothing beyond what's still eligible.
 */

/**
 * ============================================================================
 * ONE `.paginate()` PER INVOCATION — same hotfix class as `0037`/`0039`/`0040`
 * (prod incident, 2026-07-24): Convex hard-fails a query/mutation that calls
 * `.paginate()` more than once in a single execution; `convex-test` does NOT
 * enforce this. `runMigrateGuestAudiencesPage` calls `.paginate()` exactly
 * ONCE per invocation; the registry entry runs the first page and, if more
 * remain, schedules `internal.migrations.continueMigrateGuestAudiences` to
 * drain the rest — the same scheduler-continuation shape `0035`/`0040`
 * established. Do NOT wrap the `.paginate()` call in a loop.
 *
 * BOUNDED READS PER INVOCATION — the 32k-doc-read-per-execution cap (the
 * `0037`-roster-reads / "0414" incident class): each migrated row triggers
 * one EXTRA bounded read (the residue scan below, `RESIDUE_SCAN_CAP` rows via
 * `rsvps.by_event`) on top of the audiences page itself, so `PAGE_SIZE` is
 * kept deliberately small here (unlike 0040's 200 — that migration never
 * issues a per-row nested read). Worst case, every row on the page is a
 * "guests" audience WITH an `eventId` (the expensive path):
 *   reads(page) ≈ PAGE_SIZE                          // the audiences page
 *              + PAGE_SIZE × RESIDUE_SCAN_CAP         // one residue scan/row
 * At `PAGE_SIZE = 25`, `RESIDUE_SCAN_CAP = 1000`: 25 + 25×1000 = 25,025 —
 * comfortably inside the 32,000 cap with margin for whatever else this
 * mutation execution touches. Raise either constant only after re-doing this
 * math.
 * ============================================================================
 */
const PAGE_SIZE = 25;

/** Cap for the per-audience unlinked-guest-residue scan (`rsvps.by_event`) —
 *  same order of magnitude as `lib/audienceResolve.ts#RSVPS_PER_EVENT_LIMIT`
 *  (that file's own per-event rsvp cap), chosen independently here per this
 *  migration's own read-budget math above (see the banner). Flagged as a
 *  lower bound via `unlinkedGuestResidueIsLowerBound` when it binds. */
const RESIDUE_SCAN_CAP = 1000;

export type MigrateGuestAudiencesPageResult = {
  scanned: number;
  migratedFromGuests: number;
  /** "guests" rows with no `filters.eventId` — left on the legacy source;
   *  see the module doc's "eventId UNSET" branch for why. */
  skippedGuestsUnscoped: number;
  /** Rows this migration doesn't own at all (already `person_filters`, or a
   *  leftover `"people"`/`"donors"` row 0040 should have already claimed —
   *  kept as a defensive, honestly-counted bucket rather than silently
   *  falling through). */
  skippedOther: number;
  /** Sum, across every "guests" row migrated THIS page, of rsvps for that
   *  audience's event with an email on file (and not explicitly
   *  `emailVerified: false`) but no `personId` — guests the legacy resolver
   *  reached that the migrated attendance filter can no longer see. See the
   *  module doc's "Known-drift caveat" section. */
  unlinkedGuestResidue: number;
  /** True iff ANY single audience's own residue scan hit `RESIDUE_SCAN_CAP`
   *  this page — `unlinkedGuestResidue` is then a lower bound, not exact. */
  unlinkedGuestResidueIsLowerBound: boolean;
  /** `true` only once the FINAL page has been processed. */
  isDone: boolean;
  /** What to pass as the next invocation's cursor; `null` iff `isDone`. */
  continueCursor: string | null;
};

/** How many of `eventId`'s rsvps are exactly the "legacy resolver would have
 *  reached them, the migrated filter can't" gap: email present, not
 *  explicitly unverified (mirrors `resolveGuests`'s own two checks), but no
 *  `personId`. Bounded, single indexed `.take()` — never `.paginate()` (see
 *  the module doc's read-budget banner). */
async function countUnlinkedGuestResidue(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<{ count: number; isLowerBound: boolean }> {
  const rows: Doc<"rsvps">[] = await ctx.db
    .query("rsvps")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .take(RESIDUE_SCAN_CAP);
  let count = 0;
  for (const r of rows) {
    if (!r.email) continue;
    if (r.emailVerified === false) continue;
    if (r.personId !== undefined) continue;
    count++;
  }
  return { count, isLowerBound: rows.length >= RESIDUE_SCAN_CAP };
}

/** Process exactly ONE page — i.e. exactly one `.paginate()` call.
 *  `pageSize` is a TEST-ONLY override (defaults to `PAGE_SIZE`; the scheduler
 *  continuation never passes it) — lets `tests/migrations0041.test.ts` force a
 *  page boundary with a handful of seeded rows instead of seeding hundreds. */
export async function runMigrateGuestAudiencesPage(
  ctx: MutationCtx,
  cursor: string | null,
  pageSize?: number,
): Promise<MigrateGuestAudiencesPageResult> {
  const page = await ctx.db.query("audiences").paginate({ numItems: pageSize ?? PAGE_SIZE, cursor });

  const result = {
    scanned: 0,
    migratedFromGuests: 0,
    skippedGuestsUnscoped: 0,
    skippedOther: 0,
    unlinkedGuestResidue: 0,
    unlinkedGuestResidueIsLowerBound: false,
  };

  for (const audience of page.page) {
    result.scanned++;
    if (audience.source !== "guests") {
      result.skippedOther++;
      continue;
    }
    const eventId = audience.filters.eventId;
    if (eventId === undefined) {
      result.skippedGuestsUnscoped++;
      continue;
    }

    const residue = await countUnlinkedGuestResidue(ctx, eventId);
    if (residue.isLowerBound) result.unlinkedGuestResidueIsLowerBound = true;
    result.unlinkedGuestResidue += residue.count;
    if (residue.count > 0) {
      console.log(
        `migrations/0041_migrate_guest_audiences: audience ${audience._id} ` +
          `("${audience.name}") migrated with ${residue.count} unlinked-guest ` +
          `residue row(s) (email on file, no personId) for event ${eventId} — ` +
          `the composer preview's unlinkedGuests diagnostic surfaces this same ` +
          `gap going forward.`,
      );
    }

    await ctx.db.patch(audience._id, {
      source: "person_filters",
      filters: {
        ...(audience.filters.chapterId ? { chapterId: audience.filters.chapterId } : {}),
        attendedEventId: eventId,
      },
    });
    result.migratedFromGuests++;
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.migrations.continueMigrateGuestAudiences, {
      cursor: page.continueCursor,
    });
  }

  return {
    ...result,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

/**
 * Registry entry point — runs ONLY the first page inside `runPending`'s
 * transaction; when more work remains, `runMigrateGuestAudiencesPage` (above)
 * has already scheduled `internal.migrations.continueMigrateGuestAudiences`
 * to drain the rest. Same shape as `0040_migrate_legacy_audiences.ts#
 * runMigrateLegacyAudiences`: `migrations.runPending` ledgers this migration
 * as applied once THIS call returns, not once the whole scan finishes — the
 * scheduled continuation completes it afterward, and is itself idempotent/
 * resumable (every branch above only touches a row whose CURRENT `source`
 * still needs migrating), so that's safe even if a deploy's `runPending`
 * invocation is the last thing that runs before something else goes wrong.
 */
export async function runMigrateGuestAudiences(ctx: MutationCtx) {
  return await runMigrateGuestAudiencesPage(ctx, null);
}

export const migrateGuestAudiences: Migration = {
  name: "0041_migrate_guest_audiences",
  run: runMigrateGuestAudiences,
};
