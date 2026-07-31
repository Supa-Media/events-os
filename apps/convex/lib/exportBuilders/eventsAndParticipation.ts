/**
 * Export builders for `events` and `event_participation`. Both are declared
 * `supportsCentral: false` in the registry, so `bctx.chapterId` is always the
 * real chapter for a run the runner actually dispatches — the `null` guard
 * below is defensive (a caller that somehow reaches this builder at central
 * gets an empty, correctly-terminated file rather than a crash).
 *
 * See `./types.ts` for the one-`.paginate()`-per-`page()` rule this follows.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { isoDateOrBlank, isoOrBlank, type CsvColumn, type CsvValue } from "@events-os/shared";
import type { ExportBuilder, ExportBuilderContext, ExportPage } from "./types";

const EMPTY_PAGE: ExportPage = { rows: [], cursor: null, isDone: true };

async function namesFor(
  ctx: QueryCtx,
  ids: Iterable<Id<"people"> | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set([...ids].filter((id): id is Id<"people"> => !!id))) {
    const person = await ctx.db.get(id);
    if (person) names.set(id, person.name);
  }
  return names;
}

// ── events ───────────────────────────────────────────────────────────────────

const EVENT_COLUMNS: CsvColumn[] = [
  { key: "event_id", label: "Event ID" },
  { key: "name", label: "Name" },
  { key: "event_date", label: "Event date" },
  { key: "location", label: "Location" },
  { key: "status", label: "Status" },
  { key: "owner_person_id", label: "Owner ID" },
  { key: "owner_name", label: "Owner name" },
  { key: "event_type_id", label: "Event type ID" },
  { key: "event_type_name", label: "Event type" },
  { key: "budget", label: "Budget ($ estimated)" },
];

const eventsBuilder: ExportBuilder = {
  datasetId: "events",
  async columns(): Promise<CsvColumn[]> {
    return EVENT_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    if (bctx.chapterId === null) return EMPTY_PAGE;
    const chapterId = bctx.chapterId;
    const { from, to } = bctx.filters;

    const result = await ctx.db
      .query("events")
      .withIndex("by_chapter_date", (q) => {
        const withChapter = q.eq("chapterId", chapterId);
        const withFrom = from !== undefined ? withChapter.gte("eventDate", from) : withChapter;
        return to !== undefined ? withFrom.lte("eventDate", to) : withFrom;
      })
      .paginate({ numItems, cursor });

    // `activeOnly` drops cancelled events (stated in the task contract).
    const kept = bctx.filters.activeOnly
      ? result.page.filter((e) => e.status !== "cancelled")
      : result.page;

    const ownerNames = await namesFor(ctx, kept.map((e) => e.ownerPersonId));
    const eventTypeIds = [...new Set(kept.map((e) => e.eventTypeId))];
    const eventTypeNames = new Map<string, string>();
    for (const id of eventTypeIds) {
      const et = await ctx.db.get(id);
      if (et) eventTypeNames.set(id, et.name);
    }

    const rows: Record<string, CsvValue>[] = kept.map((e) => ({
      event_id: e._id,
      name: e.name,
      event_date: isoDateOrBlank(e.eventDate),
      location: e.location ?? "",
      status: e.status,
      owner_person_id: e.ownerPersonId ?? "",
      owner_name: e.ownerPersonId ? (ownerNames.get(e.ownerPersonId) ?? "") : "",
      event_type_id: e.eventTypeId,
      event_type_name: eventTypeNames.get(e.eventTypeId) ?? "",
      // `budget` is already whole ESTIMATED dollars on the events row (unlike
      // `transactions.amountCents`) — see `schema/finances.ts`'s module doc.
      // Never run through `centsToDollars`.
      budget: e.budget ?? "",
    }));

    return { rows, cursor: result.continueCursor, isDone: result.isDone };
  },
};

// ── event_participation ─────────────────────────────────────────────────────

const PARTICIPATION_COLUMNS: CsvColumn[] = [
  { key: "person_id", label: "Person ID" },
  { key: "person_name", label: "Person name" },
  { key: "event_id", label: "Event ID" },
  { key: "event_name", label: "Event name" },
  { key: "event_date", label: "Event date" },
  { key: "rsvp_status", label: "RSVP status" },
  { key: "responded_at", label: "Responded" },
  { key: "ticket_status", label: "Ticket status" },
  { key: "checked_in_at", label: "Checked in" },
  { key: "volunteer_role", label: "Volunteer role" },
];

/** Caps on the bounded per-row joins below — generous relative to real usage
 *  (a guest realistically holds one or two orders; a person a handful of
 *  engagements across events) while keeping every read indexed and bounded. */
const ORDERS_PER_RSVP_CAP = 10;
const TICKETS_PER_ORDER_CAP = 25;
const ENGAGEMENTS_PER_PERSON_CAP = 25;

/** Ticket-derived attendance for one rsvp: walks `orderId -> ticketOrders`
 *  (via `by_rsvp`, bounded) then `orderId -> tickets` (via `by_order`,
 *  bounded per order) — the chain the task calls out. Both hops are indexed
 *  and capped, so this is a legal per-row join, not a second `.paginate()`.
 *  Returns `null` status when the guest never purchased/claimed a ticket
 *  (a bare RSVP) — that's a real "no ticket" answer, not an omission. */
async function ticketAttendanceFor(
  ctx: QueryCtx,
  rsvpId: Id<"rsvps">,
): Promise<{ status: string; checkedInAt: number | undefined }> {
  const orders = await ctx.db
    .query("ticketOrders")
    .withIndex("by_rsvp", (q) => q.eq("rsvpId", rsvpId))
    .take(ORDERS_PER_RSVP_CAP);
  if (orders.length === 0) return { status: "", checkedInAt: undefined };

  let sawValid = false;
  let sawVoid = false;
  let checkedInAt: number | undefined;
  for (const order of orders) {
    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .take(TICKETS_PER_ORDER_CAP);
    for (const t of tickets) {
      if (t.status === "checked_in") {
        if (checkedInAt === undefined || (t.checkedInAt ?? 0) < checkedInAt) {
          checkedInAt = t.checkedInAt;
        }
      } else if (t.status === "valid") {
        sawValid = true;
      } else if (t.status === "void") {
        sawVoid = true;
      }
    }
  }
  if (checkedInAt !== undefined) return { status: "checked_in", checkedInAt };
  if (sawValid) return { status: "valid", checkedInAt: undefined };
  if (sawVoid) return { status: "void", checkedInAt: undefined };
  return { status: "", checkedInAt: undefined };
}

/** The volunteer role a person served in on one event, if any — an indexed
 *  `by_person` read (bounded) filtered in memory to this row's event (a
 *  person realistically holds very few engagements, never a table scan). */
async function volunteerRoleFor(
  ctx: QueryCtx,
  personId: Id<"people">,
  eventId: Id<"events">,
): Promise<string> {
  const engagements = await ctx.db
    .query("engagements")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(ENGAGEMENTS_PER_PERSON_CAP);
  const match = engagements.find((e) => e.eventId === eventId);
  if (!match) return "";
  return match.service ?? match.type;
}

const eventParticipationBuilder: ExportBuilder = {
  datasetId: "event_participation",
  async columns(): Promise<CsvColumn[]> {
    return PARTICIPATION_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    if (bctx.chapterId === null) return EMPTY_PAGE;
    const chapterId = bctx.chapterId;

    const result = await ctx.db
      .query("rsvps")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .paginate({ numItems, cursor });

    // Archived rsvps (event switched RSVP -> ticketed) are excluded from
    // every guest list app-wide; the export follows the same rule so a row
    // count here matches what the app itself would ever show.
    const live = result.page.filter((r) => r.archivedAt === undefined);

    // Batch-resolve the events these rows belong to (dedup first) — also
    // where `dateRange` is applied, since rsvps carry no event-date field of
    // their own.
    const eventIds = [...new Set(live.map((r) => r.eventId))];
    const events = new Map<string, Doc<"events">>();
    for (const id of eventIds) {
      const event = await ctx.db.get(id);
      if (event) events.set(id, event);
    }

    const { from, to } = bctx.filters;
    const kept = live.filter((r) => {
      const event = events.get(r.eventId);
      if (!event) return false; // dangling ref — nothing to report against
      if (from !== undefined && event.eventDate < from) return false;
      if (to !== undefined && event.eventDate > to) return false;
      return true;
    });

    const personNames = await namesFor(ctx, kept.map((r) => r.personId));

    const rows: Record<string, CsvValue>[] = await Promise.all(
      kept.map(async (r) => {
        const event = events.get(r.eventId);
        const ticket = await ticketAttendanceFor(ctx, r._id);
        const volunteerRole = r.personId
          ? await volunteerRoleFor(ctx, r.personId, r.eventId)
          : "";
        return {
          person_id: r.personId ?? "",
          // Fall back to the guest's own submitted name when unlinked to a
          // roster person — a guest is still a participation row.
          person_name: r.personId ? (personNames.get(r.personId) ?? r.name) : r.name,
          event_id: r.eventId,
          event_name: event?.name ?? "",
          event_date: isoDateOrBlank(event?.eventDate),
          rsvp_status: r.status,
          responded_at: isoOrBlank(r.createdAt),
          ticket_status: ticket.status,
          checked_in_at: isoOrBlank(ticket.checkedInAt),
          volunteer_role: volunteerRole,
        };
      }),
    );

    return { rows, cursor: result.continueCursor, isDone: result.isDone };
  },
};

export const eventsAndParticipationBuilders: ExportBuilder[] = [
  eventsBuilder,
  eventParticipationBuilder,
];
