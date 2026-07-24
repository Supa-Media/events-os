/**
 * One-shot backfill: group every existing `donors` row into the cross-chapter
 * IDENTITY layer (donor-identity, 2026-07). For each donor it computes the
 * grouping key (normalized email → phone → exact normalized name — see
 * `lib/donorIdentity.ts#donorIdentityKey`), finds-or-creates the
 * `donorIdentities` row for that key, sets `donors.identityId`, and refreshes
 * the identity's recomputed aggregate (`lifetimeCents`/`giftCount`/`lastGiftAt`
 * + the `scopes` list). Uses the SAME `syncDonorIdentity` primitive the live
 * write paths use, so a backfilled identity is byte-identical to one built
 * incrementally.
 *
 * Internal only, invoked manually (the `reimbursementBackfill` / `financeGenesis`
 * precedent — the orchestrator runs it via the run-convex-function workflow
 * after a dry run). Nothing here is on the public API, nothing runs on a cron,
 * there is no UI.
 *
 * SAFE + IDEMPOTENT + ADDITIVE:
 *  - Dry-run by default (`execute:false` writes NOTHING and returns the counts a
 *    real run would produce).
 *  - Additive — it only sets `donors.identityId` and maintains the identity's
 *    OWN aggregate; a donor's per-scope money rollups (`lifetimeCents`/
 *    `giftCount`) are NEVER touched, no `donors`/`gifts` row is merged, deleted,
 *    moved, or re-keyed.
 *  - Idempotent — a donor already attached to the identity for its CURRENT key
 *    is skipped, so a second execute run creates no new identities and changes
 *    nothing.
 *  - Paginates `donors` and self-reschedules until done when executing.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { donorIdentityKey, syncDonorIdentity } from "./lib/donorIdentity";

const PAGE_SIZE = 100;

export const backfillDonorIdentities = internalMutation({
  args: {
    execute: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    scanned: v.number(),
    // Donors that needed attaching (were unattached, or attached to an identity
    // whose key no longer matches the donor's current fields).
    attached: v.number(),
    // Identities that would be / were newly created for a key with no existing
    // identity. In dry-run this dedupes keys within the page only (a rough
    // preview); in execute it's the exact count of inserts.
    identitiesCreated: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const execute = args.execute ?? false;
    const page = await ctx.db
      .query("donors")
      .paginate({ numItems: PAGE_SIZE, cursor: args.cursor ?? null });

    let scanned = 0;
    let attached = 0;
    let identitiesCreated = 0;
    // Dry-run only: keys we've already counted as "would create" in THIS page,
    // so two same-key donors in one page don't inflate the created count.
    const plannedKeys = new Set<string>();

    for (const donor of page.page) {
      scanned++;
      const key = donorIdentityKey(donor);

      // Already attached to the right identity? (idempotent skip.)
      if (donor.identityId) {
        const current = await ctx.db.get(donor.identityId);
        if (current && current.key === key) continue;
      }

      // Needs attaching. Does an identity for this key already exist?
      const existing = await ctx.db
        .query("donorIdentities")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (!existing && !plannedKeys.has(key)) {
        identitiesCreated++;
        plannedKeys.add(key);
      }
      attached++;

      // `syncDonorIdentity` find-or-creates the identity, sets `identityId`, and
      // recomputes the aggregate from all currently-attached rows. As the
      // backfill drains, the LAST donor of each identity to be processed
      // recomputes over every attached row, so the aggregate is correct once the
      // run completes (and a second run recomputes identically → no change).
      if (execute) await syncDonorIdentity(ctx, donor._id);
    }

    const continueCursor = page.isDone ? null : page.continueCursor;
    if (execute && !page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.donorIdentityBackfill.backfillDonorIdentities,
        { execute: true, cursor: continueCursor },
      );
    }

    return {
      scanned,
      attached,
      identitiesCreated,
      isDone: page.isDone,
      continueCursor,
    };
  },
});
