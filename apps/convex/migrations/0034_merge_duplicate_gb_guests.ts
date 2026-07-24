import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { RSVP_STATUSES } from "../schema/ticketing";

/**
 * Field Day duplicate-guest merge — one-time cleanup for 4 buyers who ended up
 * with TWO guest rows on the same event.
 *
 * Field Day's guest list was seeded by a historical backfill
 * (`lib/seed/historical/fieldDayTickets.ts`), keyed on the emails from a CSV
 * export. The live Givebutter ticket sync (`givebutterSync.ts`) later matched
 * or created `rsvps` by the buyer's LIVE Givebutter email — which, for these 4
 * buyers, differs from the email in the CSV backfill. Since `by_event_email`
 * dedup only catches an EXACT email match, the sync couldn't see the stale
 * backfilled row and created a second one instead. Each of the 4 people now
 * has: a stale row (source "ticket", has phone + a note like "General
 * Admission; $25.00", no `ticketOrders` attached) and a live synced row (the
 * one with the real order/ticket attached via `ticketOrders.rsvpId`). The
 * stale rows inflate `eventPages.goingCount` by 4 and clutter the guest list
 * with a phantom duplicate for each of these 4 names.
 *
 * This migration merges each pair: fold the stale row's phone/note onto the
 * live row (never clobbering something the live row already has), delete the
 * stale row, and decrement the page's status counter for whatever status the
 * stale row carried. The 4 (stale → live) email pairs and the event (matched
 * by `eventPages.givebutterCampaignId`) are HARDCODED — this is a targeted,
 * one-time fix for this specific backfill collision, not a general dedup pass.
 *
 * SAFETY GUARDS: before deleting a stale row, this checks that nothing else in
 * the app actually points at it — an attached `ticketOrders` row (would mean
 * it's NOT actually order-less and merging would silently drop a real order),
 * an `eventComments` row authored by it or replying to its RSVP-activity
 * entry, or a `pageReactions` row keyed by its id as `actorKey`. Any of those
 * mean the "stale" row has its own real-world activity, so the pair is
 * skipped (counted, never thrown) rather than merged.
 *
 * IDEMPOTENT: a re-run first re-looks-up both rows by email — once a stale row
 * is deleted, its email no longer resolves via `by_event_email`, so the pair
 * is counted as `skippedMissing` and touched no further. Also independently
 * idempotent against sync ordering: if the live sync hasn't run yet (no live
 * row), the pair is likewise `skippedMissing`. Bounded reads throughout
 * (`.take(500)` on `eventPages`/`ticketOrders`/`pageReactions`, `.take(200)` on
 * `eventComments` — same shape as `givebutterSync.listActiveGivebutterPages`),
 * and all `eventPages` counter deltas are accumulated across the 4 pairs and
 * applied in ONE patch at the end (the house pattern — see
 * `applyGivebutterTickets`).
 */

/** The event to fix, identified by its page's Givebutter campaign id. */
const TARGET_CAMPAIGN_ID = "686283";

/** Bounded scan size for locating the target `eventPages` row. */
const EVENT_PAGE_SCAN = 500;
/** Bounded reads for the "is this stale row actually referenced?" guards. */
const TICKET_ORDERS_SCAN = 500;
const EVENT_COMMENTS_SCAN = 200;
const PAGE_REACTIONS_SCAN = 500;

/** The 4 stale-backfill → live-Givebutter email pairs to merge. */
const DUPLICATE_PAIRS: Array<{
  name: string;
  staleEmail: string;
  liveEmail: string;
}> = [
  {
    name: "Deandre Brown",
    staleEmail: "deanb1262@gmail.com",
    liveEmail: "drelandstar943@gmail.com",
  },
  {
    name: "Olasubomi Olawepo",
    staleEmail: "olasubomiolawepo@icloud.com",
    liveEmail: "olasubomiolawepo@gmail.com",
  },
  {
    name: "Saphire Mars",
    staleEmail: "saphy.j.mars@gmail.com",
    liveEmail: "lovesaphy@outlook.com",
  },
  {
    name: "Kezia Jones",
    staleEmail: "norisajones@gmail.com",
    liveEmail: "keziajones008@gmail.com",
  },
];

/** Merge `addition` into `existing` idempotently (mirrors the
 *  `eventAttendanceImport.ts` `mergeNote` idiom — a re-run never re-appends). */
function mergeNote(
  existing: string | undefined,
  addition: string | undefined,
): string | undefined {
  const base = existing?.trim();
  const add = addition?.trim();
  if (!add) return base || undefined;
  if (!base) return add;
  if (base.includes(add)) return base;
  return `${base} · ${add}`;
}

export async function runMergeDuplicateGbGuests(ctx: MutationCtx) {
  const counters = { merged: 0, skippedMissing: 0, skippedReferenced: 0 };

  // 1. Find the event via its page's Givebutter campaign id.
  const pages = await ctx.db.query("eventPages").take(EVENT_PAGE_SCAN);
  const page = pages.find(
    (p) => p.givebutterCampaignId === TARGET_CAMPAIGN_ID,
  );
  if (!page) return counters; // no matching page → nothing to do (no-op).

  const eventId = page.eventId;

  // Accumulated across all 4 pairs, applied in ONE eventPages patch at the end.
  const counterDelta: Record<(typeof RSVP_STATUSES)[number], number> = {
    going: 0,
    maybe: 0,
    not_going: 0,
  };

  for (const pair of DUPLICATE_PAIRS) {
    const stale = await ctx.db
      .query("rsvps")
      .withIndex("by_event_email", (q) =>
        q.eq("eventId", eventId).eq("email", pair.staleEmail),
      )
      .first();
    const live = await ctx.db
      .query("rsvps")
      .withIndex("by_event_email", (q) =>
        q.eq("eventId", eventId).eq("email", pair.liveEmail),
      )
      .first();
    if (!stale || !live) {
      counters.skippedMissing++;
      continue;
    }

    // Safety guards — skip (never delete) if the stale row has real activity
    // of its own attached to it.
    const orders = await ctx.db
      .query("ticketOrders")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(TICKET_ORDERS_SCAN);
    if (orders.some((o) => o.rsvpId === stale._id)) {
      counters.skippedReferenced++;
      continue;
    }

    const comments = await ctx.db
      .query("eventComments")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(EVENT_COMMENTS_SCAN);
    if (
      comments.some(
        (c) => c.rsvpId === stale._id || c.replyToRsvpId === stale._id,
      )
    ) {
      counters.skippedReferenced++;
      continue;
    }

    const reactions = await ctx.db
      .query("pageReactions")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(PAGE_REACTIONS_SCAN);
    if (reactions.some((r) => r.actorKey === String(stale._id))) {
      counters.skippedReferenced++;
      continue;
    }

    // Merge stale's phone/note onto live, never clobbering what live already
    // has for phone; note is appended idempotently.
    const patch: { phone?: string; note?: string; updatedAt: number } = {
      updatedAt: Date.now(),
    };
    if (!live.phone && stale.phone) patch.phone = stale.phone;
    const mergedNote = mergeNote(live.note, stale.note);
    if (mergedNote !== undefined && mergedNote !== live.note) {
      patch.note = mergedNote;
    }
    await ctx.db.patch(live._id, patch);

    await ctx.db.delete(stale._id);
    counterDelta[stale.status] -= 1;
    counters.merged++;
  }

  // Single eventPages patch for the whole batch.
  if (
    counterDelta.going !== 0 ||
    counterDelta.maybe !== 0 ||
    counterDelta.not_going !== 0
  ) {
    await ctx.db.patch(page._id, {
      goingCount: Math.max(0, page.goingCount + counterDelta.going),
      maybeCount: Math.max(0, page.maybeCount + counterDelta.maybe),
      notGoingCount: Math.max(0, page.notGoingCount + counterDelta.not_going),
    });
  }

  return counters;
}

export const mergeDuplicateGbGuests: Migration = {
  name: "0034_merge_duplicate_gb_guests",
  run: runMergeDuplicateGbGuests,
};
