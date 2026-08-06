import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * The `events.checkin` power (door check-in / QR scanner access, 2026-08-06)
 * — mirrors `0036_add_campaign_power_defaults.ts` / `0058_add_data_export_defaults.ts`
 * exactly, for the same reason: check-in access is seat-capability-derived
 * (`apps/convex/lib/ticketingAccess.ts` off `lib/seats.ts#holdsCheckInSeatAt`,
 * which reads a seat def's `capabilities` array), so making a NEW capability
 * live on an already-seeded org's `seatDefs` rows is a data change, not an
 * enforcement one. Without this, the template change in
 * `packages/shared/src/seats.ts` (`events.checkin` appended to four seats'
 * default capabilities) only reaches BRAND-NEW orgs — every existing
 * deployment's seatDefs rows were stamped by `0022_seed_seat_defs` before this
 * capability existed, and `0022` is skip-by-slug (never re-touches an
 * existing row), so nothing else would ever carry it forward.
 *
 * Seats granted `events.checkin` (verbatim, see `seats.ts`'s own per-seat
 * `2026-08-06` comments): chapter_director, event_lead, event_organizers,
 * production_coordinator.
 *
 * ADDITIVE-ONLY, same safety argument as 0036/0058: only appends
 * `events.checkin` to a row that lacks it; a row already carrying it (freshly
 * seeded orgs, or a re-run) is skipped untouched. Never removes a
 * capability, so a future runtime edit that revokes door access from one of
 * these seats is never silently re-granted by a later re-run — the ledger
 * guarantees this migration itself only ever fires once, but content-
 * idempotency is the belt-and-suspenders here exactly as it is in both
 * precedents.
 *
 * Idempotent: a row already carrying `events.checkin` is skipped, so a
 * re-run touches nothing.
 */
const TARGET_SLUGS = [
  "chapter_director",
  "event_lead",
  "event_organizers",
  "production_coordinator",
] as const;

export async function runAddEventsCheckinDefaults(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;

  for (const slug of TARGET_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();

    for (const row of rows) {
      if (row.capabilities.includes("events.checkin")) {
        skipped++;
        continue;
      }
      await ctx.db.patch(row._id, {
        capabilities: [...row.capabilities, "events.checkin"],
        updatedAt: Date.now(),
      });
      patched++;
    }
  }

  return { patched, skipped };
}

export const addEventsCheckinDefaults: Migration = {
  name: "0060_add_events_checkin_defaults",
  run: runAddEventsCheckinDefaults,
};
