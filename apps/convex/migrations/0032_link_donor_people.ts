import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { linkDonorToPerson } from "../lib/givingDonors";

/**
 * Donor↔People link backfill (docs/plans/giving-territories.md — territories
 * P5).
 *
 * `donors.personId` shipped in the same deploy as this migration, so every
 * pre-existing CHAPTER-scope donor (`scope !== "central"`) needs its 1:1
 * `people` roster link stamped retroactively — new donors get it for free at
 * write time (`matchOrCreateDonor`/`upsertDonor`, see `lib/givingDonors.ts`).
 * `"central"` donors are skipped entirely: they have no chapter roster to
 * link into and stay CRM-only by design (`linkDonorToPerson` documents this).
 *
 * Uses the SAME matching primitive the live write paths call
 * (`linkDonorToPerson`: normalized-lowercase email, then exact phone, then
 * exact trimmed name, against the donor's chapter roster — placeholders/
 * sample rows excluded) so a donor backfilled here links to EXACTLY the
 * person a fresh create would have.
 *
 * IDEMPOTENT: a donor with `personId` already set is skipped outright (never
 * re-matched, never re-inserts a duplicate roster row), so a re-run touches
 * nothing new. Bounded single pass over `donors` via pagination — mirrors
 * 0031's shape; the CRM's donor count is small at this stage (same footing as
 * every other territories-era migration's note on prod data volume).
 */

/** Rows per page — bounded reads over the (small) donors table. */
const PAGE_SIZE = 500;

export async function runLinkDonorPeople(ctx: MutationCtx) {
  const result = {
    scanned: 0,
    linked: 0,
    skippedCentral: 0,
    alreadyLinked: 0,
  };
  let cursor: string | null = null;

  for (;;) {
    const page = await ctx.db
      .query("donors")
      .paginate({ numItems: PAGE_SIZE, cursor });

    for (const donor of page.page) {
      result.scanned++;
      if (donor.scope === "central") {
        result.skippedCentral++;
        continue;
      }
      if (donor.personId !== undefined) {
        result.alreadyLinked++;
        continue;
      }
      const personId = await linkDonorToPerson(ctx, donor);
      if (personId) result.linked++;
    }

    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  return result;
}

export const linkDonorPeople: Migration = {
  name: "0032_link_donor_people",
  run: runLinkDonorPeople,
};
