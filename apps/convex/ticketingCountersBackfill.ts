/**
 * One-shot backfill: recompute each `eventPages` row's denormalized RSVP/ticket
 * counters (`goingCount` / `maybeCount` / `ticketsSoldCount`) from the true
 * underlying `rsvps` / `tickets` rows, and clean up the orphaned "maybe"
 * placeholder RSVPs an abandoned ticket checkout used to leave behind.
 *
 * WHY THIS EXISTS: `prepareOrder` pre-creates a buyer's RSVP as
 * source:"ticket" / status:"maybe" and bumps `maybeCount` for an UNPAID order;
 * `fulfill` flips it to "going" on payment, but a never-completed checkout left
 * a permanent counted "maybe" phantom. `cancelPendingOrder` now reverts that at
 * expiry, but historical prod data already drifted — this reconciles it.
 *
 * Internal only, invoked manually (the `reimbursementBackfill` precedent — the
 * orchestrator runs it via the run-convex-function workflow after a dry run).
 * Nothing here is on the public API, nothing runs on a cron, there is no UI.
 *
 * SAFE + IDEMPOTENT: dry-run by default (`execute:false` writes NOTHING and
 * returns the counts a real run would produce). A real run recomputes counters
 * to match the rows and deletes orphaned ticket placeholders; a second execute
 * run finds everything already consistent and patches/deletes nothing.
 * Paginates `eventPages` and self-reschedules until done when executing.
 *
 * The recompute matches the public surfaces' new semantics exactly:
 *   - goingCount     = non-archived RSVPs with status "going".
 *   - maybeCount     = non-archived RSVPs with status "maybe" that are NOT
 *                      ticket placeholders (source !== "ticket") — a completed
 *                      ticket buyer is "going", and a ticket-source "maybe" is
 *                      only ever an abandoned/in-flight checkout, which never
 *                      reads as a guest.
 *   - ticketsSoldCount = non-void `tickets` rows for the event.
 * An orphaned ticket placeholder (source "ticket" / status "maybe" with NO live
 * pending/paid order) is deleted on a real run. `notGoingCount` and money
 * rollups are intentionally left untouched.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const PAGE_SIZE = 25;
// Per-event bounded reads. Public Worship events hold at most a few thousand
// guests/tickets; a page whose event somehow exceeds these caps would recompute
// from a truncated read, so the caps are generous.
const RSVP_CAP = 5000;
const TICKET_CAP = 5000;

export const backfillTicketingCounters = internalMutation({
  args: {
    execute: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    scannedPages: v.number(),
    patchedPages: v.number(),
    orphansRemoved: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const execute = args.execute ?? false;
    const page = await ctx.db
      .query("eventPages")
      .paginate({ numItems: PAGE_SIZE, cursor: args.cursor ?? null });

    let scannedPages = 0;
    let patchedPages = 0;
    let orphansRemoved = 0;

    for (const ep of page.page) {
      scannedPages++;

      const rsvps = await ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", ep.eventId))
        .take(RSVP_CAP);

      let going = 0;
      let maybe = 0;
      const orphans: Id<"rsvps">[] = [];
      for (const r of rsvps) {
        if (r.archivedAt != null) continue;
        const isTicket = (r.source ?? "rsvp") === "ticket";
        if (isTicket && r.status === "maybe") {
          // A ticket placeholder: real only while a live order backs it.
          const orders = await ctx.db
            .query("ticketOrders")
            .withIndex("by_rsvp", (q) => q.eq("rsvpId", r._id))
            .take(50);
          const hasLive = orders.some(
            (o) => o.status === "pending" || o.status === "paid",
          );
          if (!hasLive) orphans.push(r._id);
          // Whether orphaned (deleted below) or an in-flight checkout, a ticket
          // "maybe" never counts toward maybeCount.
          continue;
        }
        if (r.status === "going") going++;
        else if (r.status === "maybe") maybe++;
      }

      const tickets = await ctx.db
        .query("tickets")
        .withIndex("by_event", (q) => q.eq("eventId", ep.eventId))
        .take(TICKET_CAP);
      let ticketsSold = 0;
      for (const tk of tickets) {
        if (tk.status !== "void") ticketsSold++;
      }

      const countsDrifted =
        ep.goingCount !== going ||
        ep.maybeCount !== maybe ||
        ep.ticketsSoldCount !== ticketsSold;
      if (countsDrifted || orphans.length > 0) {
        patchedPages++;
        orphansRemoved += orphans.length;
        if (execute) {
          for (const id of orphans) await ctx.db.delete(id);
          if (countsDrifted) {
            const patch: Partial<Doc<"eventPages">> = {
              goingCount: going,
              maybeCount: maybe,
              ticketsSoldCount: ticketsSold,
              updatedAt: Date.now(),
            };
            await ctx.db.patch(ep._id, patch);
          }
        }
      }
    }

    const continueCursor = page.isDone ? null : page.continueCursor;
    // Drain the rest of the table on a real run so one invocation finishes it.
    if (execute && !page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.ticketingCountersBackfill.backfillTicketingCounters,
        { execute: true, cursor: continueCursor },
      );
    }

    return {
      scannedPages,
      patchedPages,
      orphansRemoved,
      isDone: page.isDone,
      continueCursor,
    };
  },
});
