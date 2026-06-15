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
 *
 * The bulk builder logic + large seed-data literals live in `lib/seed/*`; this
 * file holds the thin registered mutations/queries that call them.
 */
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  DEFAULT_COLUMNS,
  DAY_MS,
  DAY_OFFSET_MODULES,
  VOLUNTEER_TEAM_OPTIONS,
  computeDueDate,
  defaultStatusValue,
  type ModuleKey,
} from "@events-os/shared";
import { requireUserId } from "./lib/context";
import { instantiateEvent } from "./lib/templates";
import { type ItemRow, phoneKey } from "./lib/seed/helpers";
import {
  PERMIT_ROWS,
  VOLUNTEER_ROWS,
  RETRO_ROWS,
  buildChapterRolesAndTemplates,
} from "./lib/seed/templates";
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
      for (const r of await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q: any) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(r._id);
      for (const m of await ctx.db
        .query("eventModules")
        .withIndex("by_event", (q: any) => q.eq("eventId", e._id))
        .collect())
        await ctx.db.delete(m._id);
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
      for (const r of await ctx.db
        .query("templateRoles")
        .withIndex("by_template", (q: any) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(r._id);
      for (const m of await ctx.db
        .query("templateModules")
        .withIndex("by_template", (q: any) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(m._id);
      await ctx.db.delete(t._id);
    }

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
      const etDisabled = new Set(et.disabledCoreModules ?? []);
      for (const module of NEW_MODULES) {
        if (etDisabled.has(module)) continue;
        const existing = await ctx.db
          .query("templateColumns")
          .withIndex("by_eventType_module", (q: any) =>
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
      if ((et.disabledCoreModules ?? []).includes(MODULE)) continue;

      // Replace columns with the new DEFAULT_COLUMNS shape.
      for (const c of await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q: any) =>
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
  handler: async (ctx) => {
    const count = async (table: any) =>
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

    // ── Roles + templates (shared with ensureChapters) ───────────────────────
    const { wwsId } = await buildChapterRolesAndTemplates(
      ctx,
      chapterId,
      userId as Id<"users">,
      now,
    );

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

    // Assign the lightweight roles. The event's roles were cloned from the
    // template by instantiateEvent, so look them up by key on the event.
    const eventRoles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const eventRoleByKey = new Map<string, Id<"eventRoles">>(
      eventRoles.map((r: any) => [r.key, r._id]),
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

    return { chapterId, seeded: true };
  },
});

/**
 * Bootstrap the one real (non-demo) chapter — "The New York Chapter" — that
 * users pick during onboarding. No auth (dev-style, like the migrations above);
 * idempotent: no-ops if a chapter with slug "new-york" already exists.
 *
 * Creates the chapter + the 4 default roles + the 3 default templates (Eden,
 * Love Thy Neighbor, Worship With Strangers) exactly as `seedDemoData` does.
 * Creates NO userChapters membership — membership is established when a user
 * completes onboarding (profiles.completeOnboarding).
 *
 * `createdBy` on the templates needs a real user id; we use the first user in
 * the deployment. If there are no users yet, the chapter + roles are created and
 * templates are skipped (re-run after a user signs in to fill them in).
 */
export const ensureChapters = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q: any) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
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
 * Dev-only reseed (no auth) of "The New York Chapter" for demoing. Cascade-
 * deletes the chapter's existing events/templates/docs/site-map data, rebuilds
 * the templates from `buildChapterRolesAndTemplates` (so they pick up the latest
 * DEFAULT_COLUMNS — incl. Expectations' new Owner + How-To columns), ensures a
 * handful of people, then instantiates one sample Eden event populated with
 * volunteers-on-teams + a site map (shapes + placements) so the share page /
 * site map / crew / Expectations surfaces are visibly demoable.
 *
 * Runnable with `npx convex run seed:reseedNyDemo`. Creates the chapter if it's
 * missing (mirrors `ensureChapters`). Needs at least one `users` row for
 * template `createdBy` / event creator.
 */
export const reseedNyDemo = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // ── Chapter (create if missing, mirroring ensureChapters) ────────────────
    let chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q: any) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
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
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", nyChapterId))
      .collect();
    for (const e of events) {
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
      await ctx.db.delete(e._id);
    }

    for (const d of await ctx.db
      .query("docs")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", nyChapterId))
      .collect())
      await ctx.db.delete(d._id);

    const types = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", nyChapterId))
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
      for (const r of await ctx.db
        .query("templateRoles")
        .withIndex("by_template", (q: any) => q.eq("eventTypeId", t._id))
        .collect())
        await ctx.db.delete(r._id);
      for (const m of await ctx.db
        .query("templateModules")
        .withIndex("by_template", (q: any) => q.eq("eventTypeId", t._id))
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
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", nyChapterId))
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
          isActive: true,
          createdAt: now,
        });
      }
      people = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q: any) => q.eq("chapterId", nyChapterId))
        .collect();
    }
    const peopleIds = people.map((p: any) => p._id as Id<"people">);

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
// No auth — runnable with `npx convex run seed:importRoster` (add `--prod`
// to target production). Safe to re-run: matches existing rows by phone (last
// 10 digits), falling back to name, and enriches them in place rather than
// duplicating.
// ---------------------------------------------------------------------------

export const importRoster = mutation({
  args: {},
  handler: async (ctx) => {
    let chapter = await ctx.db
      .query("chapters")
      .withIndex("by_name", (q: any) => q.eq("name", NY_CHAPTER_NAME))
      .first();
    if (!chapter) chapter = await ctx.db.query("chapters").first();
    if (!chapter)
      throw new Error("No chapter found — run seed:ensureChapters first.");
    const chapterId = chapter._id;
    const now = Date.now();

    const existing = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const byPhone = new Map<string, (typeof existing)[number]>();
    const byEmail = new Map<string, (typeof existing)[number]>();
    const byName = new Map<string, (typeof existing)[number]>();
    for (const p of existing) {
      const key = phoneKey(p.phone);
      if (key) byPhone.set(key, p);
      // Index BOTH addresses so we also adopt a row created by an earlier
      // sign-in (which stores the publicworship login email on pwEmail).
      for (const e of [p.email, p.pwEmail]) {
        const ek = e?.trim().toLowerCase();
        if (ek) byEmail.set(ek, p);
      }
      byName.set(p.name.trim().toLowerCase(), p);
    }

    const roster: RosterPerson[] = [...CORE_TEAM, ...VOLUNTEERS];
    let inserted = 0;
    let updated = 0;
    for (const r of roster) {
      const key = phoneKey(r.phone);
      const emailMatch = [r.email, r.pwEmail]
        .map((e) => (e ? byEmail.get(e.trim().toLowerCase()) : undefined))
        .find(Boolean);
      const match =
        (key ? byPhone.get(key) : undefined) ??
        emailMatch ??
        byName.get(r.name.trim().toLowerCase());
      const status: RosterStatus = r.status ?? "active";
      // Build the doc with only defined fields, so an enrich-patch never wipes
      // existing data (e.g. it won't downgrade a team member's isTeamMember).
      const doc: Record<string, unknown> = {
        name: r.name,
        status,
        isActive: status !== "inactive",
        vettingStatus: "vetted",
      };
      if (r.email !== undefined) doc.email = r.email;
      if (r.phone !== undefined) doc.phone = r.phone;
      if (r.pwEmail !== undefined) doc.pwEmail = r.pwEmail;
      if (r.role !== undefined) doc.role = r.role;
      if (r.gender !== undefined) doc.gender = r.gender;
      if (r.skills !== undefined) doc.skills = r.skills;
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
