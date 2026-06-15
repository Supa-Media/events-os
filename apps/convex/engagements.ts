/**
 * Engagements — who is involved in an event, and on what terms.
 *
 * One engagement = one person × one event, typed `volunteer` or `paid`. The same
 * person can volunteer at one event and be a paid vendor at another; that's two
 * engagements with different `type`, never a change to the person. The event UI
 * splits engagements into two lists (Volunteers / Vendors); paid engagements
 * carry an amount + payment status and roll into the event budget.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";

const engagementType = v.union(v.literal("volunteer"), v.literal("paid"));
const engagementStatus = v.union(
  v.literal("invited"),
  v.literal("confirmed"),
  v.literal("declined"),
);
const paymentStatus = v.union(
  v.literal("unpaid"),
  v.literal("invoiced"),
  v.literal("paid"),
);

/** Engagements for an event (optionally one type), joined with each person. */
export const listForEvent = query({
  args: { eventId: v.id("events"), type: v.optional(engagementType) },
  handler: async (ctx, { eventId, type }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return [];

    const rows = await ctx.db
      .query("engagements")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const filtered = type ? rows.filter((r: any) => r.type === type) : rows;

    const withPerson = await Promise.all(
      filtered.map(async (e: any) => {
        const person = await ctx.db.get(e.personId as Id<"people">);
        return {
          ...e,
          person: person
            ? {
                _id: person._id,
                name: person.name,
                email: person.email ?? null,
                phone: person.phone ?? null,
                skills: person.skills ?? [],
                isPlaceholder: (person as any).isPlaceholder === true,
              }
            : null,
        };
      }),
    );
    return withPerson.sort((a: any, b: any) => a.createdAt - b.createdAt);
  },
});

/** Total paid-vendor spend committed on an event (sums paid engagements). */
export async function paidTotalForEvent(
  ctx: any,
  eventId: Id<"events">,
): Promise<number> {
  const rows = await ctx.db
    .query("engagements")
    .withIndex("by_event_type", (q: any) =>
      q.eq("eventId", eventId).eq("type", "paid"),
    )
    .collect();
  return rows.reduce(
    (sum: number, e: any) => sum + (Number.isFinite(e.amountUsd) ? e.amountUsd : 0),
    0,
  );
}

/** Add a person to an event as a volunteer or paid vendor. */
export const add = mutation({
  args: {
    eventId: v.id("events"),
    personId: v.id("people"),
    type: engagementType,
    teams: v.optional(v.array(v.string())),
    service: v.optional(v.string()),
    amountUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(args.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const person = await ctx.db.get(args.personId);
    await requireInChapter(ctx, chapterId, person, "Person");
    return await ctx.db.insert("engagements", {
      chapterId: chapterId as Id<"chapters">,
      eventId: args.eventId,
      personId: args.personId,
      type: args.type,
      teams: args.teams,
      service: args.service,
      status: "invited",
      amountUsd: args.type === "paid" ? args.amountUsd : undefined,
      paymentStatus: args.type === "paid" ? "unpaid" : undefined,
      createdAt: Date.now(),
    });
  },
});

/** Edit an engagement — including flipping volunteer ↔ paid. */
export const update = mutation({
  args: {
    engagementId: v.id("engagements"),
    type: v.optional(engagementType),
    teams: v.optional(v.union(v.array(v.string()), v.null())),
    service: v.optional(v.union(v.string(), v.null())),
    status: v.optional(engagementStatus),
    callTime: v.optional(v.union(v.string(), v.null())),
    responsibilities: v.optional(v.union(v.string(), v.null())),
    amountUsd: v.optional(v.union(v.number(), v.null())),
    paymentStatus: v.optional(paymentStatus),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { engagementId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const eng = await ctx.db.get(engagementId);
    await requireInChapter(ctx, chapterId, eng, "Engagement");
    const fields: Record<string, unknown> = {};
    if (patch.type !== undefined) {
      fields.type = patch.type;
      // Leaving paid clears payment fields; entering paid seeds unpaid.
      if (patch.type === "volunteer") {
        fields.amountUsd = undefined;
        fields.paymentStatus = undefined;
      } else if (eng!.paymentStatus === undefined) {
        fields.paymentStatus = "unpaid";
      }
    }
    if (patch.teams !== undefined) fields.teams = patch.teams ?? undefined;
    if (patch.service !== undefined) fields.service = patch.service ?? undefined;
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.callTime !== undefined) fields.callTime = patch.callTime ?? undefined;
    if (patch.responsibilities !== undefined)
      fields.responsibilities = patch.responsibilities ?? undefined;
    if (patch.amountUsd !== undefined)
      fields.amountUsd = patch.amountUsd ?? undefined;
    if (patch.paymentStatus !== undefined) fields.paymentStatus = patch.paymentStatus;
    if (patch.notes !== undefined) fields.notes = patch.notes ?? undefined;
    await ctx.db.patch(engagementId, fields);
    return engagementId;
  },
});

/**
 * Swap a placeholder volunteer for a real person on an event.
 *
 * The placeholder (`engagement.personId`) is a stand-in materialized from a
 * template's crew at event creation; this repoints the engagement at a real
 * roster person AND remaps every Expectations item the placeholder owned to that
 * person. If the placeholder row is no longer referenced by any engagement, it's
 * deleted (it only existed as a stand-in). Returns the engagement id.
 */
export const replacePlaceholderVolunteer = mutation({
  args: {
    engagementId: v.id("engagements"),
    personId: v.id("people"),
  },
  handler: async (ctx, { engagementId, personId }) => {
    const chapterId = await requireChapterId(ctx);
    const eng = await ctx.db.get(engagementId);
    await requireInChapter(ctx, chapterId, eng, "Engagement");
    // The engagement's event must be in this chapter.
    const event = await ctx.db.get(eng!.eventId as Id<"events">);
    await requireInChapter(ctx, chapterId, event, "Event");
    // The real replacement person must be in this chapter.
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");

    const oldPersonId = eng!.personId as Id<"people">;

    // Repoint the engagement at the real person.
    await ctx.db.patch(engagementId, { personId });

    // Remap every Expectations (and any other) item this placeholder owned in
    // the same event to the real person.
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eng!.eventId))
      .collect();
    for (const it of items) {
      if (it.ownerPersonId === oldPersonId) {
        await ctx.db.patch(it._id, { ownerPersonId: personId });
      }
    }

    // If the old row was a placeholder and nothing else references it anymore,
    // delete it — it only ever existed as a stand-in.
    if (oldPersonId !== personId) {
      const oldPerson = await ctx.db.get(oldPersonId);
      if (oldPerson && (oldPerson as any).isPlaceholder === true) {
        const remaining = await ctx.db
          .query("engagements")
          .withIndex("by_person", (q: any) => q.eq("personId", oldPersonId))
          .collect();
        if (remaining.length === 0) {
          await ctx.db.delete(oldPersonId);
        }
      }
    }

    return engagementId;
  },
});

/** Remove an engagement. */
export const remove = mutation({
  args: { engagementId: v.id("engagements") },
  handler: async (ctx, { engagementId }) => {
    const chapterId = await requireChapterId(ctx);
    const eng = await ctx.db.get(engagementId);
    await requireInChapter(ctx, chapterId, eng, "Engagement");
    await ctx.db.delete(engagementId);
    return engagementId;
  },
});

/**
 * A person's engagement history across events — for the directory detail:
 * how often they've served, volunteer vs paid, and what they've been paid.
 */
export const historyForPerson = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const chapterId = await requireChapterId(ctx);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");

    const rows = await ctx.db
      .query("engagements")
      .withIndex("by_person", (q: any) => q.eq("personId", personId))
      .collect();

    const history = await Promise.all(
      rows.map(async (e: any) => {
        const event = await ctx.db.get(e.eventId as Id<"events">);
        return {
          engagementId: e._id,
          eventId: e.eventId,
          eventName: event?.name ?? "Unknown event",
          eventDate: event?.eventDate ?? 0,
          type: e.type,
          service: e.service ?? null,
          status: e.status,
          amountUsd: e.amountUsd ?? null,
          paymentStatus: e.paymentStatus ?? null,
        };
      }),
    );
    history.sort((a, b) => b.eventDate - a.eventDate);

    const paidTotal = history.reduce(
      (s, h) => s + (h.type === "paid" && Number.isFinite(h.amountUsd) ? (h.amountUsd as number) : 0),
      0,
    );
    return {
      count: history.length,
      volunteerCount: history.filter((h) => h.type === "volunteer").length,
      paidCount: history.filter((h) => h.type === "paid").length,
      paidTotal,
      history,
    };
  },
});
