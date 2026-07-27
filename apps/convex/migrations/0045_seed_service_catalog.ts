import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { ensureServiceCatalogForChapter, resolveLegacyServiceStrings } from "../lib/serviceCatalog";

/**
 * Service Catalog seed + backfill (Service Catalog PR): for EVERY chapter,
 * seed the founder-specified canonical catalog
 * (`lib/serviceCatalog.ts#CANONICAL_SERVICE_CATALOG`) if it isn't already
 * there, then backfill `people.serviceIds` from each person's legacy
 * free-text `services` strings via `LEGACY_SERVICE_STRING_MAP` (the 13
 * distinct strings actually observed across prod's 21 tagged people at the
 * time of writing).
 *
 * IDEMPOTENT on both halves:
 *  - `ensureServiceCatalogForChapter` only inserts rows that don't already
 *    exist by name+parent, so re-running never duplicates the catalog.
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
 */

const CHAPTERS_SCAN_LIMIT = 500;
/** Bound on the per-chapter roster scan — well above the ~305 prod people
 *  across every chapter combined at the time of writing. */
const PEOPLE_PER_CHAPTER_SCAN_LIMIT = 5000;

export type SeedServiceCatalogResult = {
  chaptersSeeded: number;
  catalogRowsCreated: number;
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
  const result: SeedServiceCatalogResult = {
    chaptersSeeded: 0,
    catalogRowsCreated: 0,
    peopleBackfilled: 0,
    peopleSkippedAlreadySet: 0,
    peopleSkippedNoServices: 0,
    unmapped: [],
  };

  const chapters = await ctx.db.query("chapters").take(CHAPTERS_SCAN_LIMIT);
  for (const chapter of chapters) {
    const { labelToId, created } = await ensureServiceCatalogForChapter(ctx, chapter._id);
    result.chaptersSeeded++;
    result.catalogRowsCreated += created;

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
