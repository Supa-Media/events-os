/**
 * Demo seed data for Events OS.
 *
 * Idempotent: no-ops if the demo chapter already exists. Builds a realistic
 * starting point on the unified items model — a chapter (linked to the caller),
 * the 4 editable roles, a roster, the full "Eden" template, a derived
 * "Love Thy Neighbor", a lightweight "Worship With Strangers" (with trimmed
 * supplies columns + the tiny gospel-ending run of show), and one upcoming WwS
 * event with partial readiness.
 *
 * Content here is representative across every module; Phase 5 enriches it to
 * fully mirror the Public Worship Notion docs.
 */
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  DEFAULT_ROLES,
  DEFAULT_COLUMNS,
  DAY_MS,
  MODULE_KEYS,
  DAY_OFFSET_MODULES,
  computeDueDate,
  defaultStatusValue,
  type ModuleKey,
} from "@events-os/shared";
import { requireUserId } from "./lib/context";
import { toSlug, instantiateEvent } from "./lib/templates";

/** The active list-backed modules for a template (activeComponents ∩ MODULE_KEYS). */
function activeModules(activeComponents: string[]): ModuleKey[] {
  return MODULE_KEYS.filter((m) => activeComponents.includes(m));
}

/** Seed item rows for the new modules, shared between seedDemoData and backfillNewModules. */
const PERMIT_ROWS: ItemRow[] = [
  { title: "Maria Hernandez Park Permit", offsetDays: -3, status: "approved", fields: { notes: "Park permit — holder must attend." } },
  { title: "Sound Permit", offsetDays: -3, status: "submitted", fields: { notes: "Amplified-sound permit via precinct officer ~3 days prior." } },
];

// Granular EXPECTATIONS — multiple per team, each tagged to a team value from
// VOLUNTEER_TEAM_OPTIONS. Distilled from eden.md §6 (per-team task lists) and the
// run-of-show setup notes. Columns are title / team / details (no status column).
const VOLUNTEER_ROWS: ItemRow[] = [
  // 💐 Flower Team
  { title: "Set up flower tables, vases, and linens", fields: { team: "flower", details: "Dress the tables with linens, fill vases, and arrange flowers before guests arrive." } },
  { title: "Lay out blankets + stones seating area", fields: { team: "flower", details: "Set the garden-picnic vibe: blankets and stones for guests to settle on." } },
  // 🍅 Food/Bev Team
  { title: "Set up the grazing table", fields: { team: "food_bev", details: "Arrange charcuterie, plates, napkins, and utensils on the grazing table." } },
  { title: "Keep food + drinks stocked through the event", fields: { team: "food_bev", details: "Monitor levels, refill as needed, and keep the area clean." } },
  // 👋 Welcome Team
  { title: "Greet and direct guests on arrival", fields: { team: "welcome", details: "Welcome people in, point them to food/seating, and keep the entrance flowing." } },
  { title: "Hand out connect cards", fields: { team: "welcome", details: "Offer connect cards to new guests and answer questions." } },
  { title: "Run the merch + QR / donations table", fields: { team: "welcome", details: "Staff the small merch table, take Square payments, share the donations QR." } },
  // 🙏 Prayer Team
  { title: "Hold the prayer station", fields: { team: "prayer", details: "Set up the prayer sign + spot and be available throughout the event." } },
  { title: "Pray with anyone who comes forward", fields: { team: "prayer", details: "Listen and pray one-on-one with guests who want prayer." } },
  // 📷 Content Team
  { title: "Capture photos + video clips throughout the day", fields: { team: "content", details: "Grab candid moments, worship, and setup for recap content." } },
  { title: "Get key b-roll for the recap reel", fields: { team: "content", details: "Wide shots, crowd, and the gospel moment for the post-event clip." } },
];

const RETRO_ROWS: ItemRow[] = [
  { title: "What went well?", status: "open" },
];

const DEMO_CHAPTER_NAME = "Public Worship — Demo";

interface ItemRow {
  title: string;
  offsetDays?: number;
  offsetMinutes?: number;
  roleId?: Id<"roles">;
  status?: string;
  fields?: Record<string, unknown>;
}

/**
 * Dev-only reset: wipe the demo chapter and everything scoped to it, so a fresh
 * `seedDemoData` (run from the app once logged in) starts clean. No auth — local
 * dev convenience only. (Orphaned pre-migration tables like `tasks` are no
 * longer in the schema and are left inert.)
 */
export const clearDemo = mutation({
  args: {},
  handler: async (ctx) => {
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_name", (q: any) => q.eq("name", DEMO_CHAPTER_NAME))
      .first();
    if (!chapter) return { cleared: false };
    const cid = chapter._id as Id<"chapters">;

    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", cid))
      .collect();
    for (const e of events) {
      for (const t of await ctx.db
        .query("eventItems")
        .withIndex("by_event", (q: any) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(t._id);
      for (const c of await ctx.db
        .query("eventColumns")
        .withIndex("by_event", (q: any) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(c._id);
      for (const a of await ctx.db
        .query("roleAssignments")
        .withIndex("by_event", (q: any) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(a._id);
      await ctx.db.delete(e._id);
    }

    const types = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", cid))
      .collect();
    for (const t of types) {
      for (const c of await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(c._id);
      for (const it of await ctx.db
        .query("templateItems")
        .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(it._id);
      await ctx.db.delete(t._id);
    }

    for (const r of await ctx.db
      .query("roles")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", cid))
      .collect())
      await ctx.db.delete(r._id);
    for (const p of await ctx.db
      .query("people")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", cid))
      .collect())
      await ctx.db.delete(p._id);
    for (const uc of await ctx.db
      .query("userChapters")
      .withIndex("by_chapterId", (q: any) => q.eq("chapterId", cid))
      .collect())
      await ctx.db.delete(uc._id);

    await ctx.db.delete(cid);
    return { cleared: true };
  },
});

/**
 * Dev-only backfill (no auth) for the modules added after some templates/events
 * were already created (permits, retro, volunteer_expectations). Without this,
 * those modules render empty grids on pre-existing data. Idempotent: only inserts
 * for a (template/event, module) pair that has zero columns yet.
 *
 * For each eventType: insert DEFAULT_COLUMNS + the seed items (PERMIT/VOLUNTEER/
 * RETRO rows) for any active-but-empty new module. For each event: clone the now-
 * present template columns + items for those modules onto the event (back-calc
 * dueDate for day-offset modules), mirroring instantiateEvent's clone shape.
 */
export const backfillNewModules = mutation({
  args: {},
  handler: async (ctx) => {
    const NEW_MODULES: ModuleKey[] = ["permits", "retro", "volunteer_expectations"];
    const seedRowsFor = (module: ModuleKey): ItemRow[] => {
      if (module === "permits") return PERMIT_ROWS;
      if (module === "volunteer_expectations") return VOLUNTEER_ROWS;
      if (module === "retro") return RETRO_ROWS;
      return [];
    };

    let templatesPatched = 0;
    let eventsPatched = 0;

    // ── Templates ────────────────────────────────────────────────────────────
    const eventTypes = await ctx.db.query("eventTypes").collect();
    for (const et of eventTypes) {
      let patched = false;
      for (const module of NEW_MODULES) {
        if (!(et.activeComponents ?? []).includes(module)) continue;
        const existing = await ctx.db
          .query("templateColumns")
          .withIndex("by_eventType_module", (q: any) =>
            q.eq("eventTypeId", et._id).eq("module", module),
          )
          .first();
        if (existing) continue;

        const defaults = DEFAULT_COLUMNS[module];
        for (let i = 0; i < defaults.length; i++) {
          const c = defaults[i];
          await ctx.db.insert("templateColumns", {
            eventTypeId: et._id,
            module,
            key: c.key,
            label: c.label,
            kind: c.kind,
            type: c.type,
            options: c.options,
            config: c.config,
            isVisible: c.isVisible,
            order: i,
          });
        }
        const rows = seedRowsFor(module);
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          await ctx.db.insert("templateItems", {
            eventTypeId: et._id,
            module,
            title: r.title,
            order: i,
            offsetDays: r.offsetDays,
            offsetMinutes: r.offsetMinutes,
            roleId: r.roleId,
            status: r.status,
            fields: r.fields,
          });
        }
        patched = true;
      }
      if (patched) templatesPatched++;
    }

    // ── Events ───────────────────────────────────────────────────────────────
    const events = await ctx.db.query("events").collect();
    for (const ev of events) {
      const et = await ctx.db.get(ev.eventTypeId);
      if (!et) continue;
      let patched = false;
      for (const module of NEW_MODULES) {
        if (!(et.activeComponents ?? []).includes(module)) continue;
        const existingCol = await ctx.db
          .query("eventColumns")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", ev._id).eq("module", module),
          )
          .first();
        if (existingCol) continue;

        // Clone the (now-present) template columns for this module.
        const cols = await ctx.db
          .query("templateColumns")
          .withIndex("by_eventType_module", (q: any) =>
            q.eq("eventTypeId", et._id).eq("module", module),
          )
          .collect();
        for (const c of cols) {
          const { _id, _creationTime, eventTypeId: _e, ...rest } = c as any;
          await ctx.db.insert("eventColumns", { eventId: ev._id, ...rest });
        }

        // Clone the template items for this module onto the event.
        const items = await ctx.db
          .query("templateItems")
          .withIndex("by_eventType_module", (q: any) =>
            q.eq("eventTypeId", et._id).eq("module", module),
          )
          .collect();
        const isDayOffset = DAY_OFFSET_MODULES.includes(module);
        for (const it of items) {
          const dueDate =
            isDayOffset && it.offsetDays !== undefined
              ? computeDueDate(ev.eventDate, it.offsetDays)
              : undefined;
          await ctx.db.insert("eventItems", {
            eventId: ev._id,
            chapterId: ev.chapterId,
            module: it.module,
            title: it.title,
            order: it.order,
            offsetDays: it.offsetDays,
            offsetMinutes: it.offsetMinutes,
            dueDate,
            roleId: it.roleId,
            status: it.status ?? defaultStatusValue(module),
            fields: it.fields,
          });
        }
        patched = true;
      }
      if (patched) eventsPatched++;
    }

    return { templatesPatched, eventsPatched };
  },
});

/**
 * Dev-only migration (no auth) for the RESHAPED volunteer_expectations module.
 * Rows used to be one-per-team engagements (Volunteer/Team, team, status,
 * call_time, phone, responsibilities, owner); they are now granular EXPECTATIONS
 * with columns title / team / details. This rebuilds the columns + items on every
 * template and event that has the module active, from DEFAULT_COLUMNS + the
 * granular VOLUNTEER_ROWS above. Mirrors clearDemo/backfillNewModules style.
 */
export const migrateVolunteerExpectations = mutation({
  args: {},
  handler: async (ctx) => {
    const MODULE: ModuleKey = "volunteer_expectations";
    let templatesPatched = 0;
    let eventsPatched = 0;

    // ── Templates ────────────────────────────────────────────────────────────
    const eventTypes = await ctx.db.query("eventTypes").collect();
    for (const et of eventTypes) {
      if (!(et.activeComponents ?? []).includes(MODULE)) continue;

      // Replace columns with the new DEFAULT_COLUMNS shape.
      for (const c of await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q: any) =>
          q.eq("eventTypeId", et._id).eq("module", MODULE),
        )
        .collect())
        await ctx.db.delete(c._id);

      const defaults = DEFAULT_COLUMNS[MODULE];
      for (let i = 0; i < defaults.length; i++) {
        const c = defaults[i];
        await ctx.db.insert("templateColumns", {
          eventTypeId: et._id,
          module: MODULE,
          key: c.key,
          label: c.label,
          kind: c.kind,
          type: c.type,
          options: c.options,
          config: c.config,
          isVisible: c.isVisible,
          order: i,
        });
      }

      // Replace items with the granular expectation rows.
      for (const it of await ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q: any) =>
          q.eq("eventTypeId", et._id).eq("module", MODULE),
        )
        .collect())
        await ctx.db.delete(it._id);

      for (let i = 0; i < VOLUNTEER_ROWS.length; i++) {
        const r = VOLUNTEER_ROWS[i];
        await ctx.db.insert("templateItems", {
          eventTypeId: et._id,
          module: MODULE,
          title: r.title,
          order: i,
          offsetDays: r.offsetDays,
          offsetMinutes: r.offsetMinutes,
          roleId: r.roleId,
          status: r.status,
          fields: r.fields,
        });
      }
      templatesPatched++;
    }

    // ── Events ───────────────────────────────────────────────────────────────
    const events = await ctx.db.query("events").collect();
    for (const ev of events) {
      const et = await ctx.db.get(ev.eventTypeId);
      if (!et || !(et.activeComponents ?? []).includes(MODULE)) continue;

      // Wipe the event's old volunteer_expectations columns + items.
      for (const c of await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", ev._id).eq("module", MODULE),
        )
        .collect())
        await ctx.db.delete(c._id);
      for (const it of await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", ev._id).eq("module", MODULE),
        )
        .collect())
        await ctx.db.delete(it._id);

      // Clone from the (now-updated) template.
      const cols = await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q: any) =>
          q.eq("eventTypeId", et._id).eq("module", MODULE),
        )
        .collect();
      for (const c of cols) {
        const { _id, _creationTime, eventTypeId: _e, ...rest } = c as any;
        await ctx.db.insert("eventColumns", { eventId: ev._id, ...rest });
      }

      // volunteer_expectations is not a day-offset module — no dueDate.
      const items = await ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q: any) =>
          q.eq("eventTypeId", et._id).eq("module", MODULE),
        )
        .collect();
      for (const it of items) {
        await ctx.db.insert("eventItems", {
          eventId: ev._id,
          chapterId: ev.chapterId,
          module: it.module,
          title: it.title,
          order: it.order,
          roleId: it.roleId,
          status: it.status,
          fields: it.fields,
        });
      }
      eventsPatched++;
    }

    return { templatesPatched, eventsPatched };
  },
});

/** Dev-only: row counts across the unified-model tables (no auth). */
export const health = query({
  args: {},
  handler: async (ctx) => {
    const count = async (table: any) =>
      (await ctx.db.query(table).collect()).length;
    return {
      chapters: await count("chapters"),
      roles: await count("roles"),
      eventTypes: await count("eventTypes"),
      templateColumns: await count("templateColumns"),
      templateItems: await count("templateItems"),
      events: await count("events"),
      eventColumns: await count("eventColumns"),
      eventItems: await count("eventItems"),
      roleAssignments: await count("roleAssignments"),
    };
  },
});

/**
 * Dev backfill: mark existing people as team members if they already hold a lead
 * role or own an event — so the owner/lead pickers (which now list team members
 * only) aren't empty for pre-existing data.
 */
export const backfillTeamMembers = mutation({
  args: {},
  handler: async (ctx) => {
    const ids = new Set<string>();
    for (const a of await ctx.db.query("roleAssignments").collect())
      ids.add(String(a.personId));
    for (const e of await ctx.db.query("events").collect())
      if (e.ownerPersonId) ids.add(String(e.ownerPersonId));
    let marked = 0;
    for (const id of ids) {
      const person = await ctx.db.get(id as Id<"people">);
      if (person && !person.isTeamMember) {
        await ctx.db.patch(person._id, { isTeamMember: true });
        marked++;
      }
    }
    return { marked };
  },
});

export const seedDemoData = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();

    const existing = await ctx.db
      .query("chapters")
      .withIndex("by_name", (q: any) => q.eq("name", DEMO_CHAPTER_NAME))
      .first();
    if (existing) return { chapterId: existing._id, seeded: false };

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
        chapterId,
        role: "lead",
        isActive: true,
        joinedAt: now,
      });
    }

    // ── Roles (the 4 editable defaults) ──────────────────────────────────────
    const roleId: Record<string, Id<"roles">> = {};
    for (let i = 0; i < DEFAULT_ROLES.length; i++) {
      const r = DEFAULT_ROLES[i];
      roleId[r.key] = (await ctx.db.insert("roles", {
        chapterId,
        key: r.key,
        label: r.label,
        description: r.description,
        order: i,
        isArchived: false,
        createdAt: now,
      })) as Id<"roles">;
    }
    const allRoleIds = DEFAULT_ROLES.map((r) => roleId[r.key]);
    const wwsRoleIds = [
      roleId.event_lead,
      roleId.comms_lead,
      roleId.logistics_lead,
    ];

    // ── People ───────────────────────────────────────────────────────────────
    const people = [
      { name: "Ada Okafor", email: "ada@example.com", skills: ["worship", "vocals"], vettingStatus: "vetted" as const },
      { name: "Ben Carter", email: "ben@example.com", phone: "+15555550101", skills: ["audio", "logistics"], vettingStatus: "vetted" as const },
      { name: "Chloe Martins", email: "chloe@example.com", skills: ["marketing"], vettingStatus: "pending" as const },
      { name: "Diego Ramos", phone: "+15555550102", skills: ["logistics"], vettingStatus: "unvetted" as const },
      { name: "Esi Mensah", email: "esi@example.com", skills: ["worship", "audio"], vettingStatus: "vetted" as const },
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

    // ── Helpers ───────────────────────────────────────────────────────────────
    const seedCols = async (
      eventTypeId: Id<"eventTypes">,
      module: ModuleKey,
      hideKeys: string[] = [],
    ) => {
      const defaults = DEFAULT_COLUMNS[module];
      for (let i = 0; i < defaults.length; i++) {
        const c = defaults[i];
        await ctx.db.insert("templateColumns", {
          eventTypeId,
          module,
          key: c.key,
          label: c.label,
          kind: c.kind,
          type: c.type,
          options: c.options,
          config: c.config,
          isVisible: hideKeys.includes(c.key) ? false : c.isVisible,
          order: i,
        });
      }
    };
    const addItems = async (
      eventTypeId: Id<"eventTypes">,
      module: ModuleKey,
      rows: ItemRow[],
    ) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        await ctx.db.insert("templateItems", {
          eventTypeId,
          module,
          title: r.title,
          order: i,
          offsetDays: r.offsetDays,
          offsetMinutes: r.offsetMinutes,
          roleId: r.roleId,
          status: r.status,
          fields: r.fields,
        });
      }
    };

    // ── Eden template (full) ─────────────────────────────────────────────────
    const edenId = (await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Eden",
      slug: toSlug("Eden"),
      description:
        "Full-scale flagship gathering: worship, message, ministry, and community activity.",
      activeRoleIds: allRoleIds,
      activeComponents: [
        "planning_doc", "run_of_show", "comms", "permits", "supplies", "retro",
        "volunteer_expectations",
      ],
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    for (const m of activeModules([
      "planning_doc", "run_of_show", "comms", "permits", "supplies", "retro",
      "volunteer_expectations",
    ])) {
      await seedCols(edenId, m);
    }

    await addItems(edenId, "planning_doc", [
      { title: "Draft planning doc + budget", offsetDays: -21, roleId: roleId.event_lead, fields: { details: "Spin up the doc, set the budget, line up the meeting cadence." } },
      { title: "Confirm venue + file permits", offsetDays: -21, roleId: roleId.event_lead, fields: { details: "Lock the park, file the sound permit, identify a weather backup." } },
      { title: "Reach out to music team for worship leaders + band", offsetDays: -14, roleId: roleId.comms_lead, fields: { details: "Confirm 1–2 worship leaders + instrumentalists; send the song bank." } },
      { title: "Open volunteer sign-ups + brief", offsetDays: -14, roleId: roleId.comms_lead },
      { title: "Flyer + social push", offsetDays: -7, roleId: roleId.comms_lead },
      { title: "Confirm production / AV plan", offsetDays: -7, roleId: roleId.production_lead, fields: { details: "Sound setup + power plan; contract videographer/photographer." } },
      { title: "Confirm supplies + packing checklist", offsetDays: -3, roleId: roleId.logistics_lead },
      { title: "Charge batteries + pack gear (night before)", offsetDays: -1, roleId: roleId.logistics_lead },
      { title: "Day-of setup + soundcheck", offsetDays: 0, roleId: roleId.production_lead },
      { title: "Retro + capture learnings", offsetDays: 2, roleId: roleId.event_lead },
    ]);

    await addItems(edenId, "supplies", [
      { title: "2 x Shure SM58 Mics", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", qty: 2, notes: "With WWS audio kit" } },
      { title: "Mixer", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", qty: 1 } },
      { title: "4 x XLR Cabling", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", qty: 4 } },
      { title: "1 x ALTO 600W Speaker", status: "pull_from_storage", fields: { source: "storage", container: "on_its_own", qty: 1 } },
      { title: "1 x Charged 200W Battery", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", qty: 1, notes: "Needs charging the night before" } },
      { title: "100 x Red Napkins", status: "need_to_buy", fields: { source: "buy_in_store", container: "cooler", qty: 100 } },
      { title: "Charcuterie supplies", status: "need_to_order", fields: { source: "order_online", container: "cooler" } },
    ]);

    await addItems(edenId, "comms", [
      { title: "Reach out to marketing for flyer", offsetDays: -14, roleId: roleId.comms_lead, fields: { channel: ["team_slack"], audience: ["leaders"], notes: "Hey [marketing], we're hosting Eden on [date] — can you create a flyer?" } },
      { title: "Ensure intro thread created", offsetDays: -13, roleId: roleId.comms_lead, fields: { channel: ["team_slack"], audience: ["leaders"] } },
      { title: "Announce event on socials", offsetDays: -7, roleId: roleId.comms_lead, fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
      { title: "Send a reminder to be on time", offsetDays: -3, roleId: roleId.comms_lead, fields: { channel: ["imessage_group", "team_slack"], audience: ["leaders", "musicians"] } },
      { title: "Location + how to find us (day-of)", offsetDays: 0, roleId: roleId.comms_lead, fields: { channel: ["ig_stories", "imessage_group"], audience: ["attendees", "general_public"] } },
      { title: "Post recap content", offsetDays: 3, roleId: roleId.comms_lead, fields: { channel: ["ig_post"], audience: ["general_public"], notes: "Marketing decides exact timing — record what landed." } },
    ]);

    await addItems(edenId, "run_of_show", [
      { title: "Load-in / Setup", offsetMinutes: -120, roleId: roleId.logistics_lead },
      { title: "Soundcheck", offsetMinutes: -75, roleId: roleId.production_lead },
      { title: "Volunteer huddle + prayer", offsetMinutes: -30, roleId: roleId.event_lead },
      { title: "Doors / soft start", offsetMinutes: 0, roleId: roleId.event_lead },
      { title: "Worship set", offsetMinutes: 15, roleId: roleId.production_lead },
      { title: "Message / Scripture", offsetMinutes: 45, roleId: roleId.event_lead },
      { title: "Prayer / Ministry", offsetMinutes: 70, roleId: roleId.event_lead },
      { title: "Community activity", offsetMinutes: 90, roleId: roleId.comms_lead },
      { title: "Closing / Gospel + next steps", offsetMinutes: 115, roleId: roleId.event_lead, fields: { notes: "Give the Gospel: we're all sinners; Jesus came and died for us so all who believe in Him are saved. Invite to connect + follow socials." } },
      { title: "Strike / Load-out", offsetMinutes: 130, roleId: roleId.logistics_lead },
    ]);

    await addItems(edenId, "permits", PERMIT_ROWS);
    await addItems(edenId, "volunteer_expectations", VOLUNTEER_ROWS);
    await addItems(edenId, "retro", RETRO_ROWS);

    // ── Love Thy Neighbor (derived from Eden — same structure) ───────────────
    const ltnId = (await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Love Thy Neighbor",
      slug: toSlug("Love Thy Neighbor"),
      description:
        "Annual neighbor-facing outreach — same structure as Eden, derived from it.",
      deriveFromEventTypeId: edenId,
      activeRoleIds: allRoleIds,
      activeComponents: [
        "planning_doc", "run_of_show", "comms", "permits", "supplies", "retro",
        "volunteer_expectations",
      ],
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;
    // Clone Eden's columns + items so LTN starts structurally aligned.
    const edenCols = await ctx.db
      .query("templateColumns")
      .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", edenId))
      .collect();
    for (const c of edenCols) {
      const { _id, _creationTime, eventTypeId: _e, ...rest } = c as any;
      await ctx.db.insert("templateColumns", { eventTypeId: ltnId, ...rest });
    }
    const edenItems = await ctx.db
      .query("templateItems")
      .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", edenId))
      .collect();
    for (const it of edenItems) {
      const { _id, _creationTime, eventTypeId: _e, ...rest } = it as any;
      await ctx.db.insert("templateItems", { eventTypeId: ltnId, ...rest });
    }

    // ── Worship With Strangers (lightweight; trimmed supplies columns) ───────
    const wwsId = (await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Worship With Strangers",
      slug: toSlug("Worship With Strangers"),
      description:
        "Lightweight pop-up worship — a ~10% scaled-down variant of Eden, run by a 2–3 person team. The most important, most repeatable event.",
      deriveFromEventTypeId: edenId,
      activeRoleIds: wwsRoleIds,
      activeComponents: ["planning_doc", "run_of_show", "comms", "permits", "supplies", "retro"],
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    await seedCols(wwsId, "planning_doc");
    // WWS trims supplies down to what the team actually tracks (per the convo).
    await seedCols(wwsId, "supplies", ["qty", "owner", "role"]);
    await seedCols(wwsId, "comms");
    await seedCols(wwsId, "run_of_show");
    await seedCols(wwsId, "permits");
    await seedCols(wwsId, "retro");

    await addItems(wwsId, "planning_doc", [
      { title: "Update event date + create thread", offsetDays: -14, roleId: roleId.event_lead, fields: { details: "Update the event date; start the WWS thread tagging owners." } },
      { title: "Highlight in monthly team meeting", offsetDays: -13, roleId: roleId.event_lead, fields: { details: "Where it's happening this month + who's leading." } },
      { title: "Scout + confirm location", offsetDays: -12, roleId: roleId.event_lead, fields: { details: "Identify a public spot + a weather/permitting backup; visit in person if possible (optional)." } },
      { title: "Check permits + public-space rules", offsetDays: -12, roleId: roleId.event_lead },
      { title: "Reach out to music leader to confirm worship leaders + band", offsetDays: -11, roleId: roleId.comms_lead, fields: { details: "1–2 worship leaders + instrumentalists (keyboard and/or guitar, cajon optional). Put names + numbers in notes. Send the song bank." } },
      { title: "Announce event on socials", offsetDays: -7, roleId: roleId.comms_lead },
      { title: "Get all items from storage", offsetDays: -1, roleId: roleId.logistics_lead, fields: { details: "Items live in the black/green luggage — just open and confirm everything's there." } },
      { title: "Make sure battery is charged", offsetDays: -1, roleId: roleId.logistics_lead, fields: { details: "After bringing the battery out of storage, someone takes it home to charge — there's no charger in storage." } },
      { title: "Assign someone to set up sound day-of", offsetDays: 0, roleId: roleId.event_lead },
      { title: "Bring water for worship leaders + band", offsetDays: 0, roleId: roleId.logistics_lead, fields: { cost: 20 } },
      { title: "Order food for worship leaders + volunteers", offsetDays: 0, roleId: roleId.comms_lead, fields: { details: "~$20/person.", cost: 80 } },
      { title: "Hire videographer for clips", offsetDays: -10, roleId: roleId.comms_lead, fields: { details: "iPhone footage is fine; ~$150 if hiring.", cost: 150 } },
    ]);

    await addItems(wwsId, "supplies", [
      { title: "2 x Shure SM58 Mics", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", notes: "With WWS audio kit" } },
      { title: "Mixer", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
      { title: "4 x XLR Cabling", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
      { title: "1 x ALTO 600W Speaker", status: "pull_from_storage", fields: { source: "storage", container: "on_its_own" } },
      { title: "1 x Charged 200W Battery", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", notes: "Charge the night before" } },
      { title: "Battery Charger", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
      { title: "2 x QR Code Signs", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
      { title: "Small table", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
    ]);

    await addItems(wwsId, "comms", [
      { title: "Reach out to marketing for flyer", offsetDays: -14, roleId: roleId.comms_lead, fields: { channel: ["team_slack"], audience: ["leaders"] } },
      { title: "Ensure intro thread created for WWS", offsetDays: -13, roleId: roleId.comms_lead, fields: { channel: ["team_slack"], audience: ["leaders"], notes: "New thread: \"WWS [date] @Owner1, @Owner2\"" } },
      { title: "Announce event on socials", offsetDays: -7, roleId: roleId.comms_lead, fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
      { title: "Reminder to be on time for leaders + musicians", offsetDays: -3, roleId: roleId.comms_lead, fields: { channel: ["imessage_group", "team_slack"], audience: ["leaders", "musicians"], notes: "Friendly reminder WWS is at [location] [time] — show up ready to help set up." } },
      { title: "Day-before reminder with call time", offsetDays: -1, roleId: roleId.comms_lead, fields: { channel: ["imessage_group"], audience: ["musicians"] } },
      { title: "Location + how to find us (day-of)", offsetDays: 0, roleId: roleId.comms_lead, fields: { channel: ["ig_stories", "imessage_group"], audience: ["attendees", "general_public"], notes: "Pin the exact meet spot, what to look for, start time." } },
      { title: "Post a clip from the day", offsetDays: 3, roleId: roleId.comms_lead, fields: { channel: ["ig_post"], audience: ["general_public"] } },
    ]);

    await addItems(wwsId, "run_of_show", [
      { title: "Load-in / Setup", offsetMinutes: -60, roleId: roleId.logistics_lead, fields: { notes: "Connect keyboard + recorder, then mics. Busking setup." } },
      { title: "Soundcheck", offsetMinutes: -30, roleId: roleId.event_lead, fields: { notes: "Track playback, mic check levels." } },
      { title: "Team huddle + prayer", offsetMinutes: -10, roleId: roleId.event_lead, fields: { notes: "Encouragement, have fun, worship boldly." } },
      { title: "Worship set", offsetMinutes: 0, roleId: roleId.event_lead, fields: { notes: "Spontaneous worship — no set list." } },
      { title: "Closing / Gospel + next steps", offsetMinutes: 40, roleId: roleId.event_lead, fields: { notes: "Give the Gospel: we're all sinners; Jesus came and died for us so all who believe in Him are saved. Invite to connect + follow socials." } },
      { title: "Strike / Load-out", offsetMinutes: 55, roleId: roleId.logistics_lead },
    ]);

    await addItems(wwsId, "permits", [
      { title: "Public-space / sound permit", offsetDays: -3, status: "to_apply", fields: { notes: "Check the park's amplified-sound rules; apply if required." } },
    ]);

    // ── Sample upcoming WwS event (~21 days out) ─────────────────────────────
    const eventDate = now + 21 * DAY_MS;
    const wwsType = await ctx.db.get(wwsId);
    const eventId = await instantiateEvent(ctx, {
      eventType: wwsType,
      chapterId,
      userId: userId as Id<"users">,
      name: "Worship With Strangers — Riverside Park",
      eventDate,
      location: "Riverside Park Bandstand",
      budget: 300,
      now,
    });

    // Mark the first 2 planning tasks done so readiness is non-zero.
    const eventTasks = (
      await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", "planning_doc"),
        )
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);
    for (const t of eventTasks.slice(0, 2)) {
      await ctx.db.patch(t._id, { status: "done" });
    }

    // Assign the lightweight roles.
    await ctx.db.insert("roleAssignments", {
      eventId, chapterId, roleId: roleId.event_lead, personId: peopleIds[0], createdAt: now,
    });
    await ctx.db.insert("roleAssignments", {
      eventId, chapterId, roleId: roleId.logistics_lead, personId: peopleIds[1], createdAt: now,
    });

    return { chapterId, seeded: true };
  },
});

/**
 * Dev-only migration (no auth): collapse the legacy single-`team` engagement
 * model into the multi-`teams` model.
 *
 * Volunteers used to be stored as one engagement PER team, so the same person on
 * two teams showed up as two rows. Now one engagement = one person's involvement
 * in an event, carrying an array of teams. This merges duplicate
 * (event, person, type) engagements into the earliest one, unioning their teams,
 * and clears the obsolete `team` field. Idempotent. Run once, then drop `team`
 * from the schema.
 */
export const mergeEngagementTeams = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("engagements").collect();

    // Group by (event, person, type); the earliest row is the survivor.
    const groups = new Map<string, typeof all>();
    for (const e of all) {
      const key = `${e.eventId}|${e.personId}|${e.type}`;
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }

    let merged = 0;
    let deleted = 0;
    for (const list of groups.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt);
      const [primary, ...dupes] = list;

      // Union teams from every row's legacy `team` + any existing `teams`.
      const teams = new Set<string>(primary.teams ?? []);
      const legacy = (primary as any).team;
      if (typeof legacy === "string" && legacy) teams.add(legacy);
      for (const d of dupes) {
        for (const t of d.teams ?? []) teams.add(t);
        const dl = (d as any).team;
        if (typeof dl === "string" && dl) teams.add(dl);
      }

      await ctx.db.patch(primary._id, {
        teams: Array.from(teams),
        team: undefined, // clear legacy field (no longer in schema)
      } as any);
      merged++;
      for (const d of dupes) {
        await ctx.db.delete(d._id);
        deleted++;
      }
    }

    return { groups: groups.size, merged, deletedDuplicates: deleted };
  },
});
