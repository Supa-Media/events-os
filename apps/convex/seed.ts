/**
 * Demo seed data for Events OS.
 *
 * Idempotent: no-ops if the demo chapter already exists. Builds a realistic
 * starting point — a chapter (linked to the caller), a small roster, the full
 * "Eden" template, a lightweight "Worship With Strangers" variant derived from
 * it, and one upcoming WwS event with partial readiness.
 */
import { mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { computeDueDate, computeReadiness, DAY_MS } from "@events-os/shared";
import { requireUserId } from "./lib/context";

const DEMO_CHAPTER_NAME = "Public Worship — Demo";

/** Kebab-case slug from a display name. */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Idempotently seed the demo chapter, roster, templates, and a sample event. */
export const seedDemoData = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();

    // Idempotency guard.
    const existing = await ctx.db
      .query("chapters")
      .withIndex("by_name", (q: any) => q.eq("name", DEMO_CHAPTER_NAME))
      .first();
    if (existing) {
      return { chapterId: existing._id, seeded: false };
    }

    // ── Chapter + caller membership ──────────────────────────────────────────
    const chapterId = (await ctx.db.insert("chapters", {
      name: DEMO_CHAPTER_NAME,
      slug: "demo",
      isActive: true,
      createdAt: now,
    })) as Id<"chapters">;

    const membership = await ctx.db
      .query("userChapters")
      .withIndex("by_userId", (q: any) => q.eq("userId", userId))
      .first();
    if (!membership) {
      await ctx.db.insert("userChapters", {
        userId: userId as Id<"users">,
        chapterId: chapterId as unknown as string,
        role: "lead",
        isActive: true,
        joinedAt: now,
      });
    }

    // ── People ───────────────────────────────────────────────────────────────
    const people = [
      {
        name: "Ada Okafor",
        email: "ada@example.com",
        skills: ["worship", "vocals"],
        vettingStatus: "vetted" as const,
      },
      {
        name: "Ben Carter",
        email: "ben@example.com",
        phone: "+15555550101",
        skills: ["audio", "logistics"],
        vettingStatus: "vetted" as const,
      },
      {
        name: "Chloe Martins",
        email: "chloe@example.com",
        skills: ["marketing"],
        vettingStatus: "pending" as const,
      },
      {
        name: "Diego Ramos",
        phone: "+15555550102",
        skills: ["logistics"],
        vettingStatus: "unvetted" as const,
      },
      {
        name: "Esi Mensah",
        email: "esi@example.com",
        skills: ["worship", "audio"],
        vettingStatus: "vetted" as const,
      },
    ];
    const peopleIds: Id<"people">[] = [];
    for (const p of people) {
      const id = await ctx.db.insert("people", {
        chapterId,
        name: p.name,
        email: (p as any).email,
        phone: (p as any).phone,
        skills: p.skills,
        vettingStatus: p.vettingStatus,
        isActive: true,
        createdAt: now,
      });
      peopleIds.push(id);
    }

    // ── Eden template (full) ─────────────────────────────────────────────────
    const edenId = (await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Eden",
      slug: toSlug("Eden"),
      description:
        "Full-scale flagship gathering: worship, message, ministry, and community activity.",
      roles: ["event_lead", "logistics", "marketing", "volunteer"],
      activeComponents: [
        "planning_doc",
        "run_of_show",
        "comms",
        "permits",
        "supplies",
        "retro",
        "volunteer_expectations",
        "day_of_roles",
      ],
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    const edenTasks: Array<{
      title: string;
      tMinusOffsetDays: number;
      owningRole: string;
    }> = [
      { title: "Confirm venue + file permits", tMinusOffsetDays: 21, owningRole: "logistics" },
      { title: "Draft planning doc + budget", tMinusOffsetDays: 21, owningRole: "event_lead" },
      { title: "Design promo graphic", tMinusOffsetDays: 14, owningRole: "marketing" },
      { title: "Open volunteer sign-ups", tMinusOffsetDays: 14, owningRole: "volunteer" },
      { title: "Flyer + social push", tMinusOffsetDays: 7, owningRole: "marketing" },
      { title: "Finalize run of show", tMinusOffsetDays: 7, owningRole: "event_lead" },
      { title: "Volunteer brief + role assignments", tMinusOffsetDays: 3, owningRole: "volunteer" },
      { title: "Confirm supplies + packing checklist", tMinusOffsetDays: 3, owningRole: "logistics" },
      { title: "Charge batteries + pack gear", tMinusOffsetDays: 1, owningRole: "logistics" },
      { title: "Day-of setup + soundcheck", tMinusOffsetDays: 0, owningRole: "event_lead" },
    ];
    for (let i = 0; i < edenTasks.length; i++) {
      const t = edenTasks[i];
      await ctx.db.insert("templateTasks", {
        eventTypeId: edenId,
        title: t.title,
        tMinusOffsetDays: t.tMinusOffsetDays,
        owningRole: t.owningRole,
        order: i,
      });
    }

    const edenRunOfShow: Array<{
      offsetMinutes: number;
      segment: string;
      owningRole?: string;
    }> = [
      { offsetMinutes: -120, segment: "Load-in / Setup", owningRole: "logistics" },
      { offsetMinutes: -75, segment: "Soundcheck", owningRole: "logistics" },
      { offsetMinutes: -30, segment: "Volunteer huddle", owningRole: "volunteer" },
      { offsetMinutes: 0, segment: "Doors / soft start", owningRole: "event_lead" },
      { offsetMinutes: 15, segment: "Worship set", owningRole: "event_lead" },
      { offsetMinutes: 45, segment: "Message / Scripture", owningRole: "event_lead" },
      { offsetMinutes: 70, segment: "Prayer / Ministry", owningRole: "event_lead" },
      { offsetMinutes: 90, segment: "Community activity", owningRole: "volunteer" },
      { offsetMinutes: 115, segment: "Closing / next steps", owningRole: "event_lead" },
      { offsetMinutes: 130, segment: "Strike / Load-out", owningRole: "logistics" },
    ];
    for (let i = 0; i < edenRunOfShow.length; i++) {
      const r = edenRunOfShow[i];
      await ctx.db.insert("templateRunOfShow", {
        eventTypeId: edenId,
        offsetMinutes: r.offsetMinutes,
        segment: r.segment,
        owningRole: r.owningRole,
        order: i,
      });
    }

    // ── Worship With Strangers (lightweight, derived from Eden) ──────────────
    const wwsId = (await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Worship With Strangers",
      slug: toSlug("Worship With Strangers"),
      description:
        "Lightweight pop-up worship — a ~10% scaled-down variant of Eden run by a 2-person team.",
      deriveFromEventTypeId: edenId,
      roles: ["event_lead", "logistics"],
      activeComponents: [
        "planning_doc",
        "run_of_show",
        "comms",
        "permits",
        "supplies",
        "retro",
      ],
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    // Copy Eden's tasks, reassigning owning roles to the 2 lightweight roles.
    const lightRole = (role: string) =>
      role === "logistics" ? "logistics" : "event_lead";
    for (let i = 0; i < edenTasks.length; i++) {
      const t = edenTasks[i];
      await ctx.db.insert("templateTasks", {
        eventTypeId: wwsId,
        title: t.title,
        tMinusOffsetDays: t.tMinusOffsetDays,
        owningRole: lightRole(t.owningRole),
        order: i,
      });
    }
    // Copy Eden's run-of-show, reassigning owning roles.
    for (let i = 0; i < edenRunOfShow.length; i++) {
      const r = edenRunOfShow[i];
      await ctx.db.insert("templateRunOfShow", {
        eventTypeId: wwsId,
        offsetMinutes: r.offsetMinutes,
        segment: r.segment,
        owningRole: r.owningRole ? lightRole(r.owningRole) : undefined,
        order: i,
      });
    }

    // ── Sample upcoming WwS event (~21 days out) ─────────────────────────────
    const eventDate = now + 21 * DAY_MS;
    const eventId = (await ctx.db.insert("events", {
      chapterId,
      eventTypeId: wwsId,
      templateVersion: 1,
      name: "Worship With Strangers — Riverside Park",
      eventDate,
      location: "Riverside Park Bandstand",
      status: "planning",
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"events">;

    // Clone WwS template tasks onto the event.
    const wwsTemplateTasks = await ctx.db
      .query("templateTasks")
      .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", wwsId))
      .collect();
    const sortedTasks = wwsTemplateTasks.sort(
      (a: any, b: any) => a.order - b.order,
    );
    const taskIds: Id<"tasks">[] = [];
    for (const t of sortedTasks) {
      const id = await ctx.db.insert("tasks", {
        eventId,
        chapterId,
        title: t.title,
        tMinusOffsetDays: t.tMinusOffsetDays,
        dueDate: computeDueDate(eventDate, t.tMinusOffsetDays),
        owningRole: t.owningRole,
        status: "not_started",
        order: t.order,
        createdAt: now,
      });
      taskIds.push(id);
    }
    // Mark the first 2 tasks done so readiness is non-zero.
    for (const id of taskIds.slice(0, 2)) {
      await ctx.db.patch(id, { status: "done" });
    }

    // Clone WwS run-of-show onto the event.
    const wwsRows = await ctx.db
      .query("templateRunOfShow")
      .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", wwsId))
      .collect();
    for (const r of wwsRows.sort((a: any, b: any) => a.order - b.order)) {
      await ctx.db.insert("eventRunOfShow", {
        eventId,
        offsetMinutes: r.offsetMinutes,
        segment: r.segment,
        owningRole: r.owningRole,
        notes: r.notes,
        order: r.order,
      });
    }

    // Assign the 2 lightweight roles.
    await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId,
      role: "event_lead",
      personId: peopleIds[0],
      createdAt: now,
    });
    await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId,
      role: "logistics",
      personId: peopleIds[1],
      createdAt: now,
    });

    return {
      chapterId,
      seeded: true,
      readiness: computeReadiness(taskIds.length, 2),
    };
  },
});
