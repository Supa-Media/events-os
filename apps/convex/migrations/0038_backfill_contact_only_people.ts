import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Contact/roster discriminator backfill (person-centric audiences Phase 1
 * item 1 — specs/person-centric-audiences.md).
 *
 * `people.isContactOnly` shipped in the same deploy as this migration. Every
 * EXISTING donor/import-auto-created roster row already carries the same two
 * tells the live write paths stamp today (never touched by this backfill —
 * new rows get `isContactOnly: true` directly at insert time, see
 * `lib/givingDonors.ts#linkDonorToPerson` and
 * `givingImport.ts#matchOrCreatePersonContact`): `isTeamMember: false` AND a
 * `notes` of EXACTLY `"Added from Giving"` or `"Added from import"` — the two
 * literal strings those two insert paths write, and ONLY those paths (a
 * manual `people.create`/edit is never auto-tagged this way, so a real
 * person who happens to share that exact notes string by coincidence is not
 * a realistic risk — see the OWNER RULE doc on `hasPersonIdentifier`).
 *
 * A row where the founder or a chapter admin has since edited `notes` (or
 * flipped `isTeamMember` to true, promoting a contact onto the real team) no
 * longer matches and is correctly left alone — this backfill is a POINT-IN-
 * TIME classification of what already exists today, not an ongoing rule.
 *
 * IDEMPOTENT: a row already `isContactOnly: true` is skipped, so a re-run
 * touches nothing. Simple auto-registry migration (unlike the sibling
 * `0037_link_rsvp_people`, which needs a human dry-run first because it makes
 * a judgment call on divergent names — this one is a deterministic tag on an
 * exact, unambiguous string match, safe to run unattended on every deploy
 * like the rest of this registry).
 */

/** Notes strings the two automated contact-creation paths write verbatim. */
const AUTO_CONTACT_NOTES = new Set(["Added from Giving", "Added from import"]);

/** Rows per page — bounded reads over the chapter roster table. */
const PAGE_SIZE = 500;

export async function runBackfillContactOnlyPeople(ctx: MutationCtx) {
  const result = { scanned: 0, flagged: 0, alreadyFlagged: 0 };
  let cursor: string | null = null;

  for (;;) {
    const page = await ctx.db.query("people").paginate({ numItems: PAGE_SIZE, cursor });

    for (const person of page.page) {
      result.scanned++;
      if (person.isContactOnly === true) {
        result.alreadyFlagged++;
        continue;
      }
      if (person.isTeamMember !== false) continue;
      if (!person.notes || !AUTO_CONTACT_NOTES.has(person.notes)) continue;
      await ctx.db.patch(person._id, { isContactOnly: true });
      result.flagged++;
    }

    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  return result;
}

export const backfillContactOnlyPeople: Migration = {
  name: "0038_backfill_contact_only_people",
  run: runBackfillContactOnlyPeople,
};
