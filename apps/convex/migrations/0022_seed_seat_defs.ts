import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { SEAT_IDS, SEAT_DEFS } from "@events-os/shared";

/**
 * Org chart v1: seed `seatDefs` from the shared `SEAT_DEFS` template
 * (`packages/shared/src/seats.ts`) — one row per `SEAT_IDS` entry, in
 * declaration order (which becomes `sortOrder`).
 *
 * Idempotent by SLUG, not by ledger alone: matches an existing row by
 * `slug` (via `by_slug`) and skips it entirely if found, rather than
 * upserting/overwriting. A later PR's ED-gated editor lets an org edit a
 * seat's title/duties/capabilities at runtime — a re-run of this migration
 * (or a fresh deploy re-running `runPending` defensively) must NEVER clobber
 * those live edits. The ledger in `runPending` already guards against a
 * normal double-run; this per-row `by_slug` check is the belt-and-suspenders
 * guard for a hand invocation or a future migration that re-touches this
 * table.
 */
export async function runSeedSeatDefs(ctx: MutationCtx) {
  let inserted = 0;
  let skipped = 0;
  const now = Date.now();

  for (let i = 0; i < SEAT_IDS.length; i++) {
    const slug = SEAT_IDS[i];
    const existing = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (existing) {
      skipped++;
      continue;
    }

    const def = SEAT_DEFS[slug];
    await ctx.db.insert("seatDefs", {
      slug: def.id,
      title: def.title,
      chart: def.chart,
      parentSlug: def.parentId,
      maxHolders: def.maxHolders,
      duties: [...def.duties],
      capabilities: [...def.capabilities],
      sortOrder: i,
      ...(def.derived !== undefined ? { derived: def.derived } : {}),
      ...(def.legacyTitle !== undefined
        ? { legacyTitle: def.legacyTitle }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
    inserted++;
  }

  return { inserted, skipped };
}

export const seedSeatDefs: Migration = {
  name: "0022_seed_seat_defs",
  run: runSeedSeatDefs,
};
