import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Legacy audience → `person_filters` migration (person-centric audiences
 * Phase 3 item 5 — specs/person-centric-audiences.md "Phase 3", point 5).
 *
 * `schema/campaigns.ts#AUDIENCE_SOURCES` gained `"person_filters"` in this
 * same deploy — new UI-created audiences default to it (see
 * `AudiencesView.tsx`), but every PRE-EXISTING row still carries one of the
 * three legacy sources. This is the one-time catch-up that maps as many of
 * them onto the new model as can be done WITHOUT changing what an existing
 * audience actually resolves to — `source` is normally immutable after
 * creation (`audiences.ts#updateAudience` has no `source` arg — a human can
 * never repoint one), but a MIGRATION repointing a row to an equivalent
 * `person_filters` shape is a different thing: the resolved recipient set
 * stays the same, only the REPRESENTATION changes.
 *
 * ── "people" → person_filters {teamOnly: true} ─────────────────────────────
 * `lib/audienceResolve.ts#resolvePeople` is roster-only (excludes
 * `isContactOnly === true`, `isPlaceholder`, `status === "inactive"`,
 * `marketingOptOut`) — `resolvePersonFilters` with `teamOnly: true` applies
 * the EXACT same four exclusions (see that function's per-candidate checks),
 * so this is a faithful 1:1 remap. `filters.chapterId` (if set) carries over
 * unchanged.
 *
 * ── "donors" → person_filters {donorStatus, gaveWithinDays, ...} ───────────
 * `resolveDonors` scans `donors` rows directly (chapter fan-out +
 * `"central"` sentinel for a central-scoped audience — `targetDonorScopes`,
 * reused VERBATIM by `resolvePersonFilters`'s donor-matching path, so the
 * scope fan-out is identical). The one representational gap: an EMPTY-filter
 * "donors" audience (no `donorStatus`, no `gaveWithinDays` — "every donor,
 * any status, including prospects who've never given") has no filter criterion
 * in the new model that means "just: is a donor" — `person_filters`' donor
 * scan only activates when SOME donor-derived field is set
 * (`lib/audienceResolve.ts#hasDonorCriteria`). Fixed with an inert sentinel:
 * `giftCountMin: 0` activates the donor scan while excluding NOTHING on
 * count (every donor's `giftCount >= 0`), so the resolved set is unchanged.
 * Central-scope unlinked donor rows move from being silently folded into the
 * main list (the legacy behavior) to the new, separately-COUNTED
 * `unlinkedCentralDonors` fallback bucket (spec §3.4) — still included in the
 * resolved recipients, just now honestly reported; not a regression.
 *
 * ── "guests" → LEFT UNMIGRATED (deliberate) ─────────────────────────────────
 * `person_filters`' attendance criteria (`attendedEventId`/
 * `attendedWithinDays`/`rsvpStatus`) resolve via `rsvps.personId` (Phase 1's
 * guest→person link), NOT the legacy `resolveGuests`' direct `rsvps.email`
 * scan. That link is populated by `migrations/0037_link_rsvp_people.ts` —
 * which, UNLIKE this migration and unlike 0032/0038/0039, is DELIBERATELY
 * NOT in the auto-registry (`migrations/index.ts`): it makes a judgment call
 * on divergent-name groups that needs a human dry-run first (see that file's
 * own doc). So at the moment THIS migration runs, on ANY given deployment,
 * there is NO guarantee every `rsvps` row is linked — an unlinked rsvp would
 * make a migrated "guests" audience silently under-resolve (miss real guests
 * it used to correctly reach), which is worse than leaving it alone. Two
 * options were on the table:
 *   (a) migrate anyway, unioning in unlinked rsvps' raw emails as a fallback
 *       (mirrors the central-donor fallback shape); or
 *   (b) leave every "guests" row on the legacy source/resolver, permanently
 *       correct via `resolveGuests`, until 0037 has actually run.
 * (b) is the safer choice and what this migration does: a fallback union (a)
 * would need to keep BOTH code paths alive forever anyway (an unlinked-guest
 * fallback is itself only correct pre-0037; post-0037 it's dead weight that
 * still has to be maintained and tested), for a payoff that's just "one
 * fewer legacy resolver a bit sooner" — not worth the correctness risk of
 * silently shipping an under-resolving audience to a live campaign send in
 * the meantime. `resolveGuests`/`AUDIENCE_SOURCES`'s `"guests"` literal stay
 * exactly as they are; this migration's `skippedGuests` count is the honest
 * record of how many rows it deliberately left alone. Re-run this migration
 * (or write a follow-up) once 0037 has executed in every environment that
 * matters — nothing here blocks that; it simply isn't automatic.
 *
 * IDEMPOTENT: only rows whose CURRENT `source` is still `"guests"`/`"donors"`/
 * `"people"` are touched; a row already `"person_filters"` (from a prior run,
 * or created that way from the start) is skipped outright, and "guests" rows
 * are skipped every run by design (see above) — so re-running changes nothing
 * beyond what's still eligible.
 */

/** Rows per page — bounded reads over the (small) audiences table.
 *
 * PRODUCTION CONSTRAINT (learned from the 0039 hotfix): Convex's runtime
 * enforces at most ONE `.paginate()` call per query/mutation execution —
 * `convex-test` does NOT enforce this, so a violation passes the local/CI
 * suite and only fails against a real deployment. This migration calls
 * `.paginate()` exactly ONCE, over exactly one table (`audiences`) — do NOT
 * add a second `.paginate()` call (over this or any other table) to this
 * function; if a future change needs a second source table, use a
 * stage-encoded cursor (drain table A to completion, then table B, resuming
 * via a single re-entrant cursor param) or split into a scheduler
 * continuation instead, the way `migrations/0035_backfill_receipt_documents.ts`
 * /`migrations.ts#continueReceiptBackfill` already does for a similar bound. */
const PAGE_SIZE = 200;

export async function runMigrateLegacyAudiences(ctx: MutationCtx) {
  const result = {
    scanned: 0,
    migratedFromPeople: 0,
    migratedFromDonors: 0,
    skippedGuests: 0,
    alreadyPersonFilters: 0,
  };
  let cursor: string | null = null;

  for (;;) {
    const page = await ctx.db.query("audiences").paginate({ numItems: PAGE_SIZE, cursor });

    for (const audience of page.page) {
      result.scanned++;
      if (audience.source === "person_filters") {
        result.alreadyPersonFilters++;
        continue;
      }
      if (audience.source === "guests") {
        // Deliberately unmigrated this run — see the module doc's "guests"
        // section for why.
        result.skippedGuests++;
        continue;
      }

      if (audience.source === "people") {
        await ctx.db.patch(audience._id, {
          source: "person_filters",
          filters: {
            ...(audience.filters.chapterId ? { chapterId: audience.filters.chapterId } : {}),
            teamOnly: true,
          },
        });
        result.migratedFromPeople++;
        continue;
      }

      if (audience.source === "donors") {
        const hadDonorCriterion =
          audience.filters.donorStatus != null || audience.filters.gaveWithinDays != null;
        await ctx.db.patch(audience._id, {
          source: "person_filters",
          filters: {
            ...(audience.filters.chapterId ? { chapterId: audience.filters.chapterId } : {}),
            ...(audience.filters.donorStatus ? { donorStatus: audience.filters.donorStatus } : {}),
            ...(audience.filters.gaveWithinDays != null
              ? { gaveWithinDays: audience.filters.gaveWithinDays }
              : {}),
            // Inert sentinel forcing the donor scan when neither real
            // criterion was set — see the module doc's "donors" section.
            ...(hadDonorCriterion ? {} : { giftCountMin: 0 }),
          },
        });
        result.migratedFromDonors++;
        continue;
      }
      // Exhaustive per `AUDIENCE_SOURCES` at the time this migration was
      // written (person_filters/guests/people/donors are all handled above)
      // — nothing falls through to here.
    }

    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  return result;
}

export const migrateLegacyAudiences: Migration = {
  name: "0040_migrate_legacy_audiences",
  run: runMigrateLegacyAudiences,
};
