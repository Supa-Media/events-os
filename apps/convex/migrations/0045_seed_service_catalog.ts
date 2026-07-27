import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { ensureOrgWideServiceCatalog, resolveLegacyServiceStrings } from "../lib/serviceCatalog";

/**
 * Service Catalog seed + backfill (Service Catalog PR): seed the
 * founder-specified canonical catalog
 * (`lib/serviceCatalog.ts#CANONICAL_SERVICE_CATALOG`, 47 rows) ONCE, ORG-WIDE
 * (`serviceOptions.chapterId` absent — shared by every chapter, not one copy
 * per chapter: a Tenor is a Tenor in any chapter), then backfill
 * `people.serviceIds` for EVERY chapter's roster from each person's legacy
 * free-text `services` strings via `LEGACY_SERVICE_STRING_MAP` (the 13
 * distinct strings actually observed across prod's 21 tagged people at the
 * time of writing).
 *
 * IDEMPOTENT on both halves:
 *  - `ensureOrgWideServiceCatalog` only inserts rows that don't already exist
 *    by name+parent AMONG THE ORG-WIDE ROWS (`chapterId` absent), so
 *    re-running never duplicates the catalog.
 *  - A person with `serviceIds` ALREADY SET is skipped outright — a person
 *    with `serviceIds: []` counts as "already set" too (this migration never
 *    writes an empty array; see below), so a genuinely re-run is a no-op.
 *
 * A legacy string with NO map entry is left OUT of `serviceIds` (never
 * guessed) and reported in `unmapped` for human triage. If EVERY one of a
 * person's strings is unmapped, `serviceIds` is deliberately left UNSET
 * (not patched to `[]`) rather than marked "done" — this keeps that person
 * eligible for a FUTURE re-run once `LEGACY_SERVICE_STRING_MAP` is extended
 * to cover whatever string tripped them up, instead of silently locking them
 * out via the "already set" skip above.
 *
 * ── Org-wide correction (this migration originally seeded PER-CHAPTER) ─────
 * An earlier draft of this migration seeded one copy of the canonical catalog
 * per chapter (`serviceOptions.chapterId` required). That made `has_service`
 * targeting unusable for its main use case — campaigns are central-only, and
 * a per-chapter catalog means a central audience's `has_service` condition
 * can only ever reference ONE chapter's row id, silently missing every other
 * chapter's people tagged with "the same" service under a different id. This
 * version corrects that before it ever shipped to a real deployment (this
 * migration has NOT run against staging or production — only ad hoc local/
 * test backends during development, which are not persisted). Because of
 * that, `ensureOrgWideServiceCatalog`'s existence check ONLY looks at
 * org-wide rows: it does not attempt to detect or fold in a stray per-chapter
 * row that might exist from an earlier partial run of the old code, because
 * "is this per-chapter row a leftover duplicate of the canonical catalog, or
 * a legitimate local addition someone made on purpose" is NOT decidable from
 * the data alone (the founder could deliberately create a chapter-local
 * option with the same name as a canonical one — see
 * `serviceOptions.ts#create`'s `scope` argument). If a real environment DID
 * already run the old per-chapter version, re-running THIS migration is safe
 * (it never touches existing per-chapter rows, only ensures the org-wide set
 * exists and backfills `serviceIds` for people who don't have any yet), but
 * cleaning up any now-redundant per-chapter duplicates of canonical names is
 * a manual, human-reviewed follow-up, not something this migration attempts
 * — the clean, correct state for a fresh environment (which is the only kind
 * this has ever run against) is what running it from an empty table produces.
 */

const CHAPTERS_SCAN_LIMIT = 500;
/** Bound on the per-chapter roster scan — well above the ~305 prod people
 *  across every chapter combined at the time of writing. */
const PEOPLE_PER_CHAPTER_SCAN_LIMIT = 5000;

export type SeedServiceCatalogResult = {
  /** Org-wide catalog rows inserted this run (0 on a re-run — idempotent). */
  catalogRowsCreated: number;
  chaptersScanned: number;
  peopleBackfilled: number;
  peopleSkippedAlreadySet: number;
  peopleSkippedNoServices: number;
  /** Legacy strings with no `LEGACY_SERVICE_STRING_MAP` entry — never
   *  guessed, surfaced here for a human to triage (extend the map, or leave
   *  as-is). */
  unmapped: { personId: Id<"people">; chapterId: Id<"chapters">; value: string }[];
};

export async function runSeedServiceCatalog(
  ctx: MutationCtx,
): Promise<SeedServiceCatalogResult> {
  const { labelToId, created } = await ensureOrgWideServiceCatalog(ctx);
  const result: SeedServiceCatalogResult = {
    catalogRowsCreated: created,
    chaptersScanned: 0,
    peopleBackfilled: 0,
    peopleSkippedAlreadySet: 0,
    peopleSkippedNoServices: 0,
    unmapped: [],
  };

  const chapters = await ctx.db.query("chapters").take(CHAPTERS_SCAN_LIMIT);
  for (const chapter of chapters) {
    result.chaptersScanned++;

    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
      .take(PEOPLE_PER_CHAPTER_SCAN_LIMIT);

    for (const person of people) {
      if (person.serviceIds !== undefined) {
        result.peopleSkippedAlreadySet++;
        continue;
      }
      const legacy = person.services;
      if (!legacy || legacy.length === 0) {
        result.peopleSkippedNoServices++;
        continue;
      }
      const { serviceIds, unmapped } = resolveLegacyServiceStrings(labelToId, legacy);
      for (const value of unmapped) {
        result.unmapped.push({ personId: person._id, chapterId: chapter._id, value });
      }
      if (serviceIds.length > 0) {
        await ctx.db.patch(person._id, { serviceIds });
        result.peopleBackfilled++;
      }
    }
  }

  return result;
}

export const seedServiceCatalog: Migration = {
  name: "0045_seed_service_catalog",
  run: runSeedServiceCatalog,
};
