/**
 * Demo seed data for Chapter OS.
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
 *
 * The bulk builder logic + large seed-data literals live in `lib/seed/*`; this
 * file holds the thin registered mutations/queries that call them.
 */
import { mutation, internalMutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { Id, TableNames } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROLES,
  GRID_CORE_MODULE_KEYS,
  DAY_MS,
  DAY_OFFSET_MODULES,
  VOLUNTEER_TEAM_OPTIONS,
  computeDueDate,
  defaultStatusValue,
  type ModuleKey,
} from "@events-os/shared";
import { requireUserId } from "./lib/context";
import { isSuperuser } from "./lib/superuser";
import { instantiateEvent, toSlug, seedTemplateRoles } from "./lib/templates";
import { seedPlatformGuidesForChapter } from "./lib/platformGuides";
import {
  type ItemRow,
  phoneKey,
  seedTemplateCols,
  addTemplateItems,
} from "./lib/seed/helpers";
import {
  PERMIT_ROWS,
  VOLUNTEER_ROWS,
  RETRO_ROWS,
  buildChapterRolesAndTemplates,
} from "./lib/seed/templates";
import {
  FIELD_DAY_COMMS,
  FIELD_DAY_PLANNING,
  FIELD_DAY_RUN_OF_SHOW,
  FIELD_DAY_VOLUNTEER,
  FIELD_DAY_PERMITS,
} from "./lib/seed/fieldDay";
import {
  NY_CHAPTER_NAME,
  CORE_TEAM,
  VOLUNTEERS,
  type RosterStatus,
  type RosterPerson,
} from "./lib/seed/roster";

const DEMO_CHAPTER_NAME = "Public Worship — Demo";

/** The one real (non-demo) chapter users pick during onboarding. */
const NEW_YORK_CHAPTER_NAME = "The New York Chapter";
const NEW_YORK_CHAPTER_SLUG = "new-york";

/**
 * Dev-only reset: wipe the demo chapter and everything scoped to it, so a fresh
 * `seedDemoData` (run from the app once logged in) starts clean.
 *
 * SECURITY: converted from a public `mutation` to `internalMutation` — it is
 * destructive (cascade-deletes a whole chapter) and is NOT called from the UI
 * (grep of apps/mobile finds no caller). Now reachable only from the Convex
 * dashboard / CLI (`npx convex run seed:clearDemo`), never from the public API.
 * (Orphaned pre-migration tables like `tasks` are no longer in the schema and
 * are left inert.)
 */
export const clearDemo = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_name", (q) => q.eq("name", DEMO_CHAPTER_NAME))
      .first();
    if (!chapter) return { cleared: false };
    const cid = chapter._id;

    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", cid))
      .collect();
    for (const e of events) {
      for (const t of await ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(t._id);
      for (const c of await ctx.db
        .query("eventColumns")
        .withIndex("by_event", (q) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(c._id);
      for (const a of await ctx.db
        .query("roleAssignments")
        .withIndex("by_event", (q) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(a._id);
      for (const r of await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(r._id);
      for (const m of await ctx.db
        .query("eventModules")
        .withIndex("by_event", (q) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(m._id);
      await ctx.db.delete(e._id);
    }

    const types = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter", (q) => q.eq("chapterId", cid))
      .collect();
    for (const t of types) {
      for (const c of await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType", (q) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(c._id);
      for (const it of await ctx.db
        .query("templateItems")
        .withIndex("by_eventType", (q) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(it._id);
      for (const r of await ctx.db
        .query("templateRoles")
        .withIndex("by_template", (q) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(r._id);
      for (const m of await ctx.db
        .query("templateModules")
        .withIndex("by_template", (q) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(m._id);
      await ctx.db.delete(t._id);
    }

    for (const p of await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", cid))
      .collect())
      await ctx.db.delete(p._id);
    for (const pr of await ctx.db
      .query("projects")
      .withIndex("by_chapter", (q) => q.eq("chapterId", cid))
      .collect())
      await ctx.db.delete(pr._id);
    for (const uc of await ctx.db
      .query("userChapters")
      .withIndex("by_chapterId", (q) => q.eq("chapterId", cid))
      .collect())
      await ctx.db.delete(uc._id);

    await ctx.db.delete(cid);
    return { cleared: true };
  },
});

/**
 * Dev-only backfill for the modules added after some templates/events were
 * already created (permits, retro, volunteer_expectations). Without this, those
 * modules render empty grids on pre-existing data. Idempotent: only inserts for a
 * (template/event, module) pair that has zero columns yet.
 *
 * For each eventType: insert DEFAULT_COLUMNS + the seed items (PERMIT/VOLUNTEER/
 * RETRO rows) for any active-but-empty new module. For each event: clone the now-
 * present template columns + items for those modules onto the event (back-calc
 * dueDate for day-offset modules), mirroring instantiateEvent's clone shape.
 *
 * SECURITY: converted from a public `mutation` to `internalMutation` — it
 * bulk-overwrites template/event grid data and is not called from the UI.
 * Dashboard/CLI only.
 */
export const backfillNewModules = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
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
      const etDisabled = new Set(et.disabledCoreModules ?? []);
      for (const module of NEW_MODULES) {
        if (etDisabled.has(module)) continue;
        const existing = await ctx.db
          .query("templateColumns")
          .withIndex("by_eventType_module", (q) =>
            q.eq("eventTypeId", et._id).eq("module", module),
          )
          .first();
        if (existing) continue;

        const defaults = DEFAULT_COLUMNS[module] ?? [];
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
            // These backfilled modules (permits/retro/volunteer_expectations)
            // carry no role on their seed rows.
            roleId: undefined,
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
      const evDisabled = new Set(ev.disabledCoreModules ?? []);
      for (const module of NEW_MODULES) {
        if (evDisabled.has(module)) continue;
        const existingCol = await ctx.db
          .query("eventColumns")
          .withIndex("by_event_module", (q) =>
            q.eq("eventId", ev._id).eq("module", module),
          )
          .first();
        if (existingCol) continue;

        // Clone the (now-present) template columns for this module.
        const cols = await ctx.db
          .query("templateColumns")
          .withIndex("by_eventType_module", (q) =>
            q.eq("eventTypeId", et._id).eq("module", module),
          )
          .collect();
        for (const c of cols) {
          const { _id, _creationTime, eventTypeId: _e, ...rest } = c;
          await ctx.db.insert("eventColumns", { eventId: ev._id, ...rest });
        }

        // Clone the template items for this module onto the event.
        const items = await ctx.db
          .query("templateItems")
          .withIndex("by_eventType_module", (q) =>
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
            // These backfilled modules carry no role on their items.
            roleId: undefined,
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
 * Dev-only migration for the RESHAPED volunteer_expectations module. Rows used to
 * be one-per-team engagements (Volunteer/Team, team, status, call_time, phone,
 * responsibilities, owner); they are now granular EXPECTATIONS with columns title
 * / team / details. This rebuilds the columns + items on every template and event
 * that has the module active, from DEFAULT_COLUMNS + the granular VOLUNTEER_ROWS
 * above. Mirrors clearDemo/backfillNewModules style.
 *
 * SECURITY: converted from a public `mutation` to `internalMutation` — it
 * destructively rebuilds grid data and is not called from the UI. Dashboard/CLI
 * only.
 */
export const migrateVolunteerExpectations = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    const MODULE: ModuleKey = "volunteer_expectations";
    let templatesPatched = 0;
    let eventsPatched = 0;

    // ── Templates ────────────────────────────────────────────────────────────
    const eventTypes = await ctx.db.query("eventTypes").collect();
    for (const et of eventTypes) {
      if ((et.disabledCoreModules ?? []).includes(MODULE)) continue;

      // Replace columns with the new DEFAULT_COLUMNS shape.
      for (const c of await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", et._id).eq("module", MODULE),
        )
        .collect())
        await ctx.db.delete(c._id);

      const defaults = DEFAULT_COLUMNS[MODULE] ?? [];
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
        .withIndex("by_eventType_module", (q) =>
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
          // volunteer_expectations rows carry no role.
          roleId: undefined,
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
      if (!et || (ev.disabledCoreModules ?? []).includes(MODULE)) continue;

      // Wipe the event's old volunteer_expectations columns + items.
      for (const c of await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", ev._id).eq("module", MODULE),
        )
        .collect())
        await ctx.db.delete(c._id);
      for (const it of await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", ev._id).eq("module", MODULE),
        )
        .collect())
        await ctx.db.delete(it._id);

      // Clone from the (now-updated) template.
      const cols = await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", et._id).eq("module", MODULE),
        )
        .collect();
      for (const c of cols) {
        const { _id, _creationTime, eventTypeId: _e, ...rest } = c;
        await ctx.db.insert("eventColumns", { eventId: ev._id, ...rest });
      }

      // volunteer_expectations is not a day-offset module — no dueDate.
      const items = await ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) =>
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
          // volunteer_expectations items carry no role.
          roleId: undefined,
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
  handler: async (ctx: QueryCtx) => {
    const count = async (table: TableNames) =>
      (await ctx.db.query(table).collect()).length;
    return {
      chapters: await count("chapters"),
      templateRoles: await count("templateRoles"),
      eventRoles: await count("eventRoles"),
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
 *
 * SECURITY: converted from a public `mutation` to `internalMutation` — it mass-
 * patches roster rows and is not called from the UI. Dashboard/CLI only.
 */
export const backfillTeamMembers = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
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
  handler: async (ctx: MutationCtx) => {
    const userId = await requireUserId(ctx);
    // Gate: seeding demo data is allowed only for a superuser, UNLESS the
    // deployment explicitly opts into open seeding via `IS_DEV="true"`.
    // Prevents an authenticated non-admin from spraying a demo chapter + roster
    // into a live deployment via the public API. The pipeline empty-state
    // "Seed demo data" button stays functional for admins everywhere, and for
    // everyone on dev/staging deployments that set `IS_DEV=true`.
    //
    // Fail-CLOSED by default: an unconfigured deployment (no `IS_DEV` env var)
    // requires a superuser — so production is safe even if no env var is set.
    // Dev deployments set `IS_DEV=true` to keep open seeding.
    const isDev = process.env.IS_DEV === "true";
    if (!isDev && !(await isSuperuser(ctx))) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message:
          "Seeding demo data requires admin access on this deployment.",
      });
    }
    const now = Date.now();

    const existing = await ctx.db
      .query("chapters")
      .withIndex("by_name", (q) => q.eq("name", DEMO_CHAPTER_NAME))
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
      .withIndex("by_userId", (q) => q.eq("userId", userId as Id<"users">))
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

    // ── Roles + templates (shared with ensureChapters) ───────────────────────
    const { wwsId } = await buildChapterRolesAndTemplates(
      ctx,
      chapterId,
      userId as Id<"users">,
      now,
    );

    // ── People ───────────────────────────────────────────────────────────────
    type SeedPerson = {
      name: string;
      email?: string;
      phone?: string;
      skills: string[];
      vettingStatus: "vetted" | "pending" | "unvetted";
    };
    const people: SeedPerson[] = [
      { name: "Ada Okafor", email: "ada@example.com", skills: ["worship", "vocals"], vettingStatus: "vetted" },
      { name: "Ben Carter", email: "ben@example.com", phone: "+15555550101", skills: ["audio", "logistics"], vettingStatus: "vetted" },
      { name: "Chloe Martins", email: "chloe@example.com", skills: ["marketing"], vettingStatus: "pending" },
      { name: "Diego Ramos", phone: "+15555550102", skills: ["logistics"], vettingStatus: "unvetted" },
      { name: "Esi Mensah", email: "esi@example.com", skills: ["worship", "audio"], vettingStatus: "vetted" },
    ];
    const peopleIds: Id<"people">[] = [];
    for (const p of people) {
      const id = await ctx.db.insert("people", {
        chapterId,
        name: p.name,
        email: p.email,
        phone: p.phone,
        services: p.skills,
        vettingStatus: p.vettingStatus,
        status: "active",
        createdAt: now,
      });
      peopleIds.push(id);
    }

    // ── Platform enablement guides (docs/guides/*.md → markdown docs) ────────
    await seedPlatformGuidesForChapter(ctx, chapterId);

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
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "planning_doc"),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);
    for (const t of eventTasks.slice(0, 2)) {
      await ctx.db.patch(t._id, { status: "done" });
    }

    // Assign the lightweight roles. The event's roles were cloned from the
    // template by instantiateEvent, so look them up by key on the event.
    const eventRoles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const eventRoleByKey = new Map<string, Id<"eventRoles">>(
      eventRoles.map((r) => [r.key, r._id]),
    );
    const eventLeadRole = eventRoleByKey.get("event_lead");
    const logisticsRole = eventRoleByKey.get("logistics_lead");
    if (eventLeadRole) {
      await ctx.db.insert("roleAssignments", {
        eventId, chapterId, roleId: eventLeadRole, personId: peopleIds[0], createdAt: now,
      });
    }
    if (logisticsRole) {
      await ctx.db.insert("roleAssignments", {
        eventId, chapterId, roleId: logisticsRole, personId: peopleIds[1], createdAt: now,
      });
    }

    // ── Song library + a sample setlist on the WwS event ─────────────────────
    // Lyrics here are public-domain hymns/doxologies. The `doxology`-tagged ones
    // surface as default suggestions on the public request page.
    const songSeeds: {
      title: string;
      author?: string;
      tags: string[];
      lyrics: string;
    }[] = [
      {
        title: "Doxology (Praise God, from Whom All Blessings Flow)",
        author: "Thomas Ken",
        tags: ["doxology", "hymn"],
        lyrics:
          "Praise God, from whom all blessings flow;\nPraise Him, all creatures here below;\nPraise Him above, ye heavenly host;\nPraise Father, Son, and Holy Ghost. Amen.",
      },
      {
        title: "Gloria Patri",
        tags: ["doxology"],
        lyrics:
          "Glory be to the Father, and to the Son, and to the Holy Ghost;\nAs it was in the beginning, is now, and ever shall be,\nworld without end. Amen, amen.",
      },
      {
        title: "Holy, Holy, Holy",
        author: "Reginald Heber",
        tags: ["hymn"],
        lyrics:
          "Holy, holy, holy! Lord God Almighty!\nEarly in the morning our song shall rise to Thee;\nHoly, holy, holy! merciful and mighty!\nGod in three Persons, blessèd Trinity!",
      },
      {
        title: "Amazing Grace",
        author: "John Newton",
        tags: ["hymn"],
        lyrics:
          "Amazing grace! how sweet the sound,\nThat saved a wretch like me!\nI once was lost, but now am found,\nWas blind, but now I see.",
      },
      {
        title: "It Is Well With My Soul",
        author: "Horatio Spafford",
        tags: ["hymn"],
        lyrics:
          "When peace like a river attendeth my way,\nWhen sorrows like sea billows roll;\nWhatever my lot, Thou hast taught me to say,\nIt is well, it is well with my soul.",
      },
    ];
    const songIds: Id<"songs">[] = [];
    for (const s of songSeeds) {
      songIds.push(
        await ctx.db.insert("songs", {
          chapterId,
          title: s.title,
          author: s.author,
          tags: s.tags,
          lyrics: s.lyrics,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    // First three songs onto the event setlist; mark the third "current" so the
    // public page has live lyrics. Requests default to open.
    const setlistSongs = songIds.slice(0, 3);
    for (let i = 0; i < setlistSongs.length; i++) {
      await ctx.db.insert("setlistEntries", {
        eventId,
        chapterId,
        songId: setlistSongs[i],
        order: i,
        isCurrent: i === setlistSongs.length - 1,
        createdAt: now,
      });
    }
    await ctx.db.patch(eventId, { songRequestsOpen: true });
    // A couple of sample requests so the performer view isn't empty.
    await ctx.db.insert("songRequests", {
      eventId,
      chapterId,
      songId: songIds[0],
      songTitle: songSeeds[0].title,
      requesterName: "Maria",
      status: "new",
      createdAt: now,
    });
    await ctx.db.insert("songRequests", {
      eventId,
      chapterId,
      songTitle: "Way Maker",
      requesterName: "Guest",
      note: "If you all know it!",
      status: "new",
      createdAt: now,
    });

    return { chapterId, seeded: true };
  },
});

/**
 * Bootstrap the one real (non-demo) chapter — "The New York Chapter" — that
 * users pick during onboarding. Idempotent: no-ops if a chapter with slug
 * "new-york" already exists.
 *
 * Creates the chapter + the 4 default roles + the 3 default templates (Eden,
 * Love Thy Neighbor, Worship With Strangers) exactly as `seedDemoData` does.
 * Creates NO userChapters membership — membership is established when a user
 * completes onboarding (profiles.completeOnboarding).
 *
 * `createdBy` on the templates needs a real user id; we use the first user in
 * the deployment. If there are no users yet, the chapter + roles are created and
 * templates are skipped (re-run after a user signs in to fill them in).
 *
 * SECURITY: converted from a public `mutation` to `internalMutation` — it had no
 * auth and is not called from the UI (it's a one-time bootstrap run via the CLI:
 * `npx convex run seed:ensureChapters`). Keeping it public let any client create
 * chapters anonymously.
 */
export const ensureChapters = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    const existing = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (existing) {
      return { chapterId: existing._id, created: false };
    }

    const now = Date.now();
    const chapterId = (await ctx.db.insert("chapters", {
      name: NEW_YORK_CHAPTER_NAME,
      slug: NEW_YORK_CHAPTER_SLUG,
      isActive: true,
      createdAt: now,
    })) as Id<"chapters">;

    // Templates require a createdBy user; use any existing user.
    const firstUser = await ctx.db.query("users").first();
    if (firstUser) {
      await buildChapterRolesAndTemplates(
        ctx,
        chapterId,
        firstUser._id as Id<"users">,
        now,
      );
      return { chapterId, created: true, templatesSeeded: true };
    }

    return { chapterId, created: true, templatesSeeded: false };
  },
});

/**
 * Dev-only reseed of "The New York Chapter" for demoing. Cascade-deletes the
 * chapter's existing events/templates/docs/site-map data, rebuilds the templates
 * from `buildChapterRolesAndTemplates` (so they pick up the latest
 * DEFAULT_COLUMNS — incl. Expectations' new Owner + How-To columns), ensures a
 * handful of people, then instantiates one sample Eden event populated with
 * volunteers-on-teams + a site map (shapes + placements) so the share page /
 * site map / crew / Expectations surfaces are visibly demoable.
 *
 * Runnable with `npx convex run seed:reseedNyDemo`. Creates the chapter if it's
 * missing (mirrors `ensureChapters`). Needs at least one `users` row for
 * template `createdBy` / event creator.
 *
 * SECURITY: converted from a public `mutation` to `internalMutation` — it had no
 * auth and is hugely destructive (cascade-deletes a chapter's events, templates,
 * docs, and site-map). Not called from the UI. Dashboard/CLI only.
 */
export const reseedNyDemo = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    const now = Date.now();

    // ── Chapter (create if missing, mirroring ensureChapters) ────────────────
    let chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) {
      const chapterId = (await ctx.db.insert("chapters", {
        name: NEW_YORK_CHAPTER_NAME,
        slug: NEW_YORK_CHAPTER_SLUG,
        isActive: true,
        createdAt: now,
      })) as Id<"chapters">;
      chapter = await ctx.db.get(chapterId);
    }
    const nyChapterId = chapter!._id as Id<"chapters">;

    const firstUser = await ctx.db.query("users").first();
    if (!firstUser) {
      return { ok: false, reason: "no users — sign in once, then re-run" };
    }

    // ── Cascade-delete the chapter's existing content ────────────────────────
    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", nyChapterId))
      .collect();
    for (const e of events) {
      // Generic helper over the per-event child tables (all share a `by_event`
      // index keyed on `eventId`). The `table as any` is genuine: the table name
      // is a runtime string spanning heterogeneous tables, so the index/query
      // types can't be narrowed statically here.
      const byEvent = (table: string) =>
        ctx.db
          .query(table as any)
          .withIndex("by_event", (q: any) => q.eq("eventId", e._id))
          .collect();
      for (const t of await byEvent("eventItems")) await ctx.db.delete(t._id);
      for (const c of await byEvent("eventColumns")) await ctx.db.delete(c._id);
      for (const r of await byEvent("roleAssignments"))
        await ctx.db.delete(r._id);
      for (const r of await byEvent("eventRoles")) await ctx.db.delete(r._id);
      for (const m of await byEvent("eventModules")) await ctx.db.delete(m._id);
      for (const g of await byEvent("engagements")) await ctx.db.delete(g._id);
      for (const s of await byEvent("siteMarkers")) await ctx.db.delete(s._id);
      for (const s of await byEvent("siteShapes")) await ctx.db.delete(s._id);
      for (const p of await byEvent("siteMapPlacements"))
        await ctx.db.delete(p._id);
      // Projects linked to the event survive the reseed — just unlink them.
      for (const pr of await byEvent("projects"))
        await ctx.db.patch(pr._id, { eventId: undefined, updatedAt: Date.now() });
      await ctx.db.delete(e._id);
    }

    for (const d of await ctx.db
      .query("docs")
      .withIndex("by_chapter", (q) => q.eq("chapterId", nyChapterId))
      .collect())
      await ctx.db.delete(d._id);

    const types = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter", (q) => q.eq("chapterId", nyChapterId))
      .collect();
    for (const t of types) {
      for (const c of await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType", (q) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(c._id);
      for (const it of await ctx.db
        .query("templateItems")
        .withIndex("by_eventType", (q) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(it._id);
      for (const r of await ctx.db
        .query("templateRoles")
        .withIndex("by_template", (q) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(r._id);
      for (const m of await ctx.db
        .query("templateModules")
        .withIndex("by_template", (q) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(m._id);
      await ctx.db.delete(t._id);
    }

    // ── Rebuild templates (picks up the latest DEFAULT_COLUMNS) ───────────────
    const { edenId } = await buildChapterRolesAndTemplates(
      ctx,
      nyChapterId,
      firstUser._id as Id<"users">,
      now,
    );

    // ── People (ensure ~5) ───────────────────────────────────────────────────
    let people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", nyChapterId))
      .collect();
    if (people.length < 5) {
      const seed = [
        { name: "Ada Okafor", vettingStatus: "vetted" as const },
        { name: "Ben Carter", vettingStatus: "vetted" as const },
        { name: "Chloe Martins", vettingStatus: "pending" as const },
        { name: "Diego Ramos", vettingStatus: "pending" as const },
        { name: "Esi Mensah", vettingStatus: "vetted" as const },
      ];
      for (const p of seed) {
        await ctx.db.insert("people", {
          chapterId: nyChapterId,
          name: p.name,
          vettingStatus: p.vettingStatus,
          status: "active",
          createdAt: now,
        });
      }
      people = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", nyChapterId))
        .collect();
    }
    const peopleIds = people.map((p) => p._id);

    // ── Platform enablement guides (recreated — the wipe above removed docs) ──
    await seedPlatformGuidesForChapter(ctx, nyChapterId);

    // ── Sample Eden event (~30 days out) ─────────────────────────────────────
    const edenType = await ctx.db.get(edenId);
    const edenEventId = await instantiateEvent(ctx, {
      eventType: edenType,
      chapterId: nyChapterId,
      userId: firstUser._id as Id<"users">,
      name: "Eden — Central Park Great Lawn",
      eventDate: now + 30 * DAY_MS,
      location: "Central Park, Great Lawn",
      budget: 1200,
      now,
    });

    // ── Volunteers on teams (~4 engagements; one on two teams) ───────────────
    const teamValues = VOLUNTEER_TEAM_OPTIONS.map((t) => t.value);
    const engagementSpecs: { personId: Id<"people">; teams: string[] }[] = [
      { personId: peopleIds[0], teams: [teamValues[0], teamValues[2]] }, // flower + welcome
      { personId: peopleIds[1], teams: [teamValues[1]] }, // food_bev
      { personId: peopleIds[2], teams: [teamValues[3]] }, // prayer
      { personId: peopleIds[3], teams: [teamValues[4]] }, // content
    ];
    const engagementIds: Id<"engagements">[] = [];
    for (const spec of engagementSpecs) {
      const id = (await ctx.db.insert("engagements", {
        chapterId: nyChapterId,
        eventId: edenEventId,
        personId: spec.personId,
        type: "volunteer" as const,
        teams: spec.teams,
        status: "confirmed" as const,
        createdAt: now,
      })) as Id<"engagements">;
      engagementIds.push(id);
    }

    // ── Site map: a couple shapes + two volunteer placements ──────────────────
    await ctx.db.insert("siteShapes", {
      chapterId: nyChapterId,
      eventId: edenEventId,
      type: "rect" as const,
      x: 0.35,
      y: 0.15,
      w: 0.3,
      h: 0.15,
      color: "amber",
      label: "Stage",
      createdAt: now,
    });
    await ctx.db.insert("siteShapes", {
      chapterId: nyChapterId,
      eventId: edenEventId,
      type: "circle" as const,
      x: 0.1,
      y: 0.7,
      w: 0.12,
      h: 0.12,
      color: "teal",
      label: "Check-in",
      createdAt: now,
    });
    await ctx.db.insert("siteMapPlacements", {
      chapterId: nyChapterId,
      eventId: edenEventId,
      kind: "volunteer" as const,
      refId: String(engagementIds[0]),
      x: 0.4,
      y: 0.55,
      createdAt: now,
    });
    await ctx.db.insert("siteMapPlacements", {
      chapterId: nyChapterId,
      eventId: edenEventId,
      kind: "volunteer" as const,
      refId: String(engagementIds[1]),
      x: 0.6,
      y: 0.6,
      createdAt: now,
    });

    return {
      ok: true,
      chapterId: nyChapterId,
      edenEventId,
      eventsDeleted: events.length,
      templatesDeleted: types.length,
      people: peopleIds.length,
      engagements: engagementIds.length,
    };
  },
});

/**
 * Dev-only migration: collapse the legacy single-`team` engagement model into
 * the multi-`teams` model.
 *
 * Volunteers used to be stored as one engagement PER team, so the same person on
 * two teams showed up as two rows. Now one engagement = one person's involvement
 * in an event, carrying an array of teams. This merges duplicate
 * (event, person, type) engagements into the earliest one, unioning their teams,
 * and clears the obsolete `team` field. Idempotent. Run once, then drop `team`
 * from the schema.
 *
 * SECURITY: converted from a public `mutation` to `internalMutation` — it had no
 * auth and destructively merges/deletes engagement rows. Not called from the UI.
 * Dashboard/CLI only.
 */
export const mergeEngagementTeams = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
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

// ---------------------------------------------------------------------------
// Roster import — Public Worship core team + vetted volunteers.
//
// One-shot, idempotent backfill of the real Public Worship roster into the
// people table (transcribed from the team's Notion lists, in `lib/seed/roster`).
// Personas are not a rigid kind: core team is flagged `isTeamMember`, vendors
// are signalled by a `usualRateUsd` (added later), and everyone else is a
// volunteer — so the same person can vendor on one event and volunteer on
// another.
//
// Runnable with `npx convex run seed:importRoster` (add `--prod` to target
// production). Safe to re-run: matches existing rows by phone (last 10 digits)
// or email and enriches them in place rather than duplicating.
//
// SECURITY: this is an `internalMutation` — it had no auth and bulk-writes the
// roster, so it must not be reachable from the public API. Dashboard/CLI only.
// ---------------------------------------------------------------------------

export const importRoster = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    let chapter = await ctx.db
      .query("chapters")
      .withIndex("by_name", (q) => q.eq("name", NY_CHAPTER_NAME))
      .first();
    if (!chapter) chapter = await ctx.db.query("chapters").first();
    if (!chapter)
      throw new ConvexError({
        code: "NO_CHAPTER",
        message: "No chapter found — run seed:ensureChapters first.",
      });
    const chapterId = chapter._id;
    const now = Date.now();

    const existing = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect();
    const byPhone = new Map<string, (typeof existing)[number]>();
    const byEmail = new Map<string, (typeof existing)[number]>();
    for (const p of existing) {
      const key = phoneKey(p.phone);
      if (key) byPhone.set(key, p);
      // Index BOTH addresses so we also adopt a row created by an earlier
      // sign-in (which stores the publicworship login email on pwEmail).
      for (const e of [p.email, p.pwEmail]) {
        const ek = e?.trim().toLowerCase();
        if (ek) byEmail.set(ek, p);
      }
    }

    const roster: RosterPerson[] = [...CORE_TEAM, ...VOLUNTEERS];
    let inserted = 0;
    let updated = 0;
    for (const r of roster) {
      const key = phoneKey(r.phone);
      const emailMatch = [r.email, r.pwEmail]
        .map((e) => (e ? byEmail.get(e.trim().toLowerCase()) : undefined))
        .find(Boolean);
      // Match ONLY on the strong identity keys (phone, then email/pwEmail).
      // We deliberately do NOT fall back to a case-folded NAME match: two
      // distinct people can share a name, and a name-merge would silently
      // overwrite one person's row with another's. An unmatched roster entry is
      // inserted as a new person instead.
      const match = (key ? byPhone.get(key) : undefined) ?? emailMatch;
      const status: RosterStatus = r.status ?? "active";
      // Build the doc with only defined fields, so an enrich-patch never wipes
      // existing data (e.g. it won't downgrade a team member's isTeamMember).
      const doc: Record<string, unknown> = {
        name: r.name,
        status,
        vettingStatus: "vetted",
      };
      if (r.email !== undefined) doc.email = r.email;
      if (r.phone !== undefined) doc.phone = r.phone;
      if (r.pwEmail !== undefined) doc.pwEmail = r.pwEmail;
      if (r.role !== undefined) doc.role = r.role;
      if (r.gender !== undefined) doc.gender = r.gender;
      if (r.skills !== undefined) doc.services = r.skills;
      if (r.projects !== undefined) doc.projects = r.projects;
      if (r.commsPreferences !== undefined)
        doc.commsPreferences = r.commsPreferences;
      if (r.pocName !== undefined) doc.pocName = r.pocName;
      if (r.notes !== undefined) doc.notes = r.notes;
      if (r.isTeamMember) doc.isTeamMember = true;

      if (match) {
        await ctx.db.patch(match._id, doc);
        updated++;
      } else {
        await ctx.db.insert("people", {
          chapterId: chapterId as Id<"chapters">,
          createdAt: now,
          ...(doc as any),
        });
        inserted++;
      }
    }
    return {
      chapter: chapter.name,
      inserted,
      updated,
      total: roster.length,
    };
  },
});

/**
 * Dev mutation: create a NEAR-date Eden event with its roles assigned to OTHER
 * team members, so the signed-in user (the event owner) can test the
 * "Overseeing" view. The event is tomorrow, so day-of items read "soon" and the
 * planning items read "overdue" — everything is at-risk and surfaces.
 *
 * Run AFTER `reseedNyDemo` (it needs the NY chapter + Eden template + people).
 *
 * SECURITY: converted from a public `mutation` to `internalMutation` — it had no
 * auth and creates events + assignments. Not called from the UI. Dashboard/CLI
 * only.
 */
export const seedOverseeingDemo = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    const now = Date.now();
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) return { ok: false, reason: "run reseedNyDemo first" };
    const nyChapterId = chapter._id;

    const firstUser = await ctx.db.query("users").first();
    if (!firstUser) return { ok: false, reason: "no users — sign in once" };

    const edenType = (
      await ctx.db
        .query("eventTypes")
        .withIndex("by_chapter", (q) => q.eq("chapterId", nyChapterId))
        .collect()
    ).find((t) => t.name === "Eden");
    if (!edenType) return { ok: false, reason: "no Eden template — run reseedNyDemo" };

    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", nyChapterId))
      .collect();
    type PersonDoc = (typeof people)[number];
    const byName = (n: string): PersonDoc | undefined =>
      people.find((p) => p.name === n);
    // The event owner = the person linked to the signed-in user.
    const mePerson = people.find(
      (p) => String(p.userId) === String(firstUser._id),
    );

    // Near-date event so day-of items are "soon" and planning items "overdue".
    const eventId = await instantiateEvent(ctx, {
      eventType: edenType,
      chapterId: nyChapterId,
      userId: firstUser._id as Id<"users">,
      name: "Eden — Overseeing test (tomorrow)",
      eventDate: now + DAY_MS,
      location: "Central Park, Great Lawn",
      budget: 1200,
      now,
    });

    // Assign module-owning roles to OTHER people (so you oversee their work);
    // Event Lead → you, so you also get a populated "Yours".
    const eventRoles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const roleIdByKey = new Map(eventRoles.map((r) => [r.key, r._id]));
    const assign = async (
      roleKey: string,
      person: PersonDoc | undefined,
    ) => {
      const roleId = roleIdByKey.get(roleKey);
      if (!roleId || !person) return;
      await ctx.db.insert("roleAssignments", {
        eventId,
        chapterId: nyChapterId,
        roleId,
        personId: person._id,
        createdAt: now,
      });
    };
    await assign("event_lead", mePerson ?? byName("Ada Okafor"));
    await assign("comms_lead", byName("Ada Okafor"));
    await assign("logistics_lead", byName("Ben Carter"));
    await assign("production_lead", byName("Chloe Martins"));

    return {
      ok: true,
      eventId,
      eventOwnerIsSignedInUser: !!mePerson,
      assigned: ["event_lead→you", "comms→Ada", "logistics→Ben", "production→Chloe"],
    };
  },
});

/**
 * Add the "Field Day" event template (ported from the Notion Field Day 2026
 * plan) to an existing chapter. Creates one eventType with the default roles +
 * all grid-core module columns, then fills Comms, Planning Doc, Run of Show,
 * Volunteer Expectations, and Permits from `lib/seed/fieldDay`. Timing is
 * event-relative, so the template reuses each year.
 *
 * Runnable with `npx convex run seed:fieldDayTemplate` (add `--prod` to target
 * production). Defaults to the first chapter/user; pass `chapterId`/`createdBy`
 * to target a specific one. NOT idempotent — running twice creates two copies.
 *
 * SECURITY: `internalMutation` — no auth, bulk-writes template data, not called
 * from the UI. Dashboard/CLI only.
 */
export const fieldDayTemplate = internalMutation({
  args: {
    chapterId: v.optional(v.id("chapters")),
    createdBy: v.optional(v.id("users")),
    name: v.optional(v.string()),
  },
  handler: async (ctx: MutationCtx, args) => {
    const chapter = args.chapterId
      ? await ctx.db.get(args.chapterId)
      : await ctx.db.query("chapters").first();
    if (!chapter)
      throw new ConvexError({
        code: "NO_CHAPTER",
        message: "No chapter found — pass chapterId explicitly.",
      });
    const user = args.createdBy
      ? await ctx.db.get(args.createdBy)
      : await ctx.db.query("users").first();
    if (!user)
      throw new ConvexError({
        code: "NO_USER",
        message: "No user found — pass createdBy explicitly.",
      });

    const name = args.name ?? "Field Day";
    const now = Date.now();

    const eventTypeId = (await ctx.db.insert("eventTypes", {
      chapterId: chapter._id,
      name,
      slug: toSlug(name),
      description:
        "Public Worship Field Day — a park cookout + games gathering. Ported from the Notion Field Day 2026 plan; timing is relative to the event day.",
      disabledCoreModules: [],
      version: 1,
      isArchived: false,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    const roleIdByKey = await seedTemplateRoles(ctx, eventTypeId, DEFAULT_ROLES);
    for (const m of GRID_CORE_MODULE_KEYS) {
      await seedTemplateCols(ctx, eventTypeId, m);
    }

    const rowsByModule: Record<string, ItemRow[]> = {
      comms: FIELD_DAY_COMMS,
      planning_doc: FIELD_DAY_PLANNING,
      run_of_show: FIELD_DAY_RUN_OF_SHOW,
      volunteer_expectations: FIELD_DAY_VOLUNTEER,
      permits: FIELD_DAY_PERMITS,
    };
    let itemsInserted = 0;
    for (const [module, rows] of Object.entries(rowsByModule)) {
      await addTemplateItems(
        ctx,
        eventTypeId,
        module as ModuleKey,
        rows,
        roleIdByKey,
      );
      itemsInserted += rows.length;
    }

    return { eventTypeId, name, chapter: chapter.name, itemsInserted };
  },
});
