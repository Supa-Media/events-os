/**
 * "Which event pages should the outside world be shown right now?" — asked
 * once, answered here.
 *
 * This was `ticketing.listPublishedUpcoming`'s handler body. It got lifted out
 * when the homepage's Important Links grid gained real selection policy (a
 * count, a pin list, a hide list, set by the Marketing desk): the public feed
 * and the desk's own preview both need this list, inside a query, and calling
 * a query from a query for it would have meant a function-call boundary on the
 * homepage's hot path — and, worse, a second place the "is it still upcoming?"
 * rule could drift to.
 *
 * `listPublishedUpcoming` is now a thin wrapper over this, so its existing
 * callers (`GET /api/events/upcoming`) are unchanged.
 */
import { QueryCtx } from "../_generated/server";
import { startOfNextEasternDay } from "@events-os/shared";

/** One publishable event page, flattened with the bits its event doc holds. */
export interface UpcomingEventPage {
  slug: string;
  eventName: string;
  startDate: number;
  endDate: number | null;
  tagline: string | null;
  venueName: string | null;
  hasCover: boolean;
  /** Cover crop focal point (percent) so every marketing surface crops the
   *  cover the same way the landing page does. */
  coverFocalX: number;
  coverFocalY: number;
}

/** How many published pages to walk before filtering. Generous — the org has
 *  never had anywhere near this many live at once. */
const PAGE_SCAN_LIMIT = 100;

/**
 * Published, non-training event pages that have not finished yet, soonest
 * first, capped at `limit` (1–24).
 *
 * "Not finished yet" is `now < startOfNextEasternDay(endDate ?? eventDate)`:
 * the card stays up through the whole event day in Eastern time and drops only
 * once the next Eastern day has begun. That is deliberately generous — someone
 * checking the site on the way to a Saturday afternoon gathering should still
 * find it.
 */
export async function listUpcomingEventPages(
  ctx: QueryCtx,
  limit?: number,
): Promise<UpcomingEventPage[]> {
  const now = Date.now();
  const max = Math.max(1, Math.min(limit ?? 6, 24));

  const pages = await ctx.db
    .query("eventPages")
    .withIndex("by_published", (q) => q.eq("published", true))
    .order("desc")
    .take(PAGE_SCAN_LIMIT);

  const upcoming: UpcomingEventPage[] = [];
  for (const page of pages) {
    const event = await ctx.db.get(page.eventId);
    // Skip orphaned pages and the Academy's training sandbox events.
    if (!event || event.isTraining) continue;
    const endsAt = page.endDate ?? event.eventDate;
    if (now >= startOfNextEasternDay(endsAt)) continue;
    upcoming.push({
      slug: page.slug,
      eventName: event.name,
      startDate: event.eventDate,
      endDate: page.endDate ?? null,
      tagline: page.tagline ?? null,
      venueName: page.venueName ?? null,
      hasCover: !!page.coverImage,
      coverFocalX: page.coverFocalX ?? 50,
      coverFocalY: page.coverFocalY ?? 50,
    });
  }
  upcoming.sort((a, b) => a.startDate - b.startDate);
  return upcoming.slice(0, max);
}
