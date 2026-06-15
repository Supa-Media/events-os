/**
 * One-off data migrations for the roles re-scoping (Phase 2).
 *
 * Roles used to be chapter-scoped (`roles` table) and a template referenced a
 * subset via `eventTypes.activeRoleIds`; items + roleAssignments pointed at those
 * chapter roles. Roles are now template-owned (`templateRoles`) and cloned to
 * each event (`eventRoles`); item/assignment role refs are scoped accordingly.
 *
 * `migrateRolesToScoped` reads the OLD shape (via `(... as any)`, since the new
 * schema no longer types those fields) and creates the new rows + repoints
 * references. It is designed to run **once, to completion**: re-running after a
 * COMPLETE run is a no-op (every template/event is skipped — it already has
 * scoped roles). It is NOT safe to resume after a PARTIALLY-applied run: the
 * skip branch for an already-scoped template does not rebuild the old
 * key→id map, so events under it wouldn't get their item roleIds remapped. If a
 * run is interrupted, restore from backup before retrying. It does NOT need to
 * run as part of this task — dev uses a reseed.
 */
import { internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Phase 3 migration: `eventTypes.activeComponents` (and the per-event copy via
 * its eventType) → the core-module DELTA model.
 *
 * Modules used to be an explicit `activeComponents: string[]` allow-list of the
 * 7 grid modules. They're now platform-wide CORE_MODULES with a per-scope
 * `disabledCoreModules` deny-list (+ overrides, + custom rows). The general rule
 * for introducing a new core module is that it's ABSENT from existing
 * `disabledCoreModules`, so it defaults to ENABLED everywhere — which is exactly
 * what we want for `site_map` (turns on for all existing templates/events).
 *
 * So we set `disabledCoreModules = PRIOR_CORE_KEYS − activeComponents` (the OLD
 * 7-key set minus what was active — NOT including site_map). Cloned onto each
 * event from its eventType. `activeComponents` is then cleared.
 *
 * Reads the OLD shape via `(... as any)`. Idempotent-ish: skips a row that
 * already has `disabledCoreModules` set. Does NOT need to run for this task.
 */
const PRIOR_CORE_KEYS = [
  "planning_doc",
  "run_of_show",
  "comms",
  "permits",
  "supplies",
  "retro",
  "volunteer_expectations",
];

export const migrateModulesToDeltas = internalMutation({
  args: {},
  handler: async (ctx) => {
    let templatesMigrated = 0;
    let eventsMigrated = 0;

    // Map eventTypeId → its computed disabledCoreModules, so events can inherit.
    const disabledByType = new Map<string, string[]>();

    const eventTypes = await ctx.db.query("eventTypes").collect();
    for (const et of eventTypes) {
      const active: string[] = (et as any).activeComponents ?? [];
      const disabled = PRIOR_CORE_KEYS.filter((k) => !active.includes(k));
      disabledByType.set(String(et._id), disabled);

      // Idempotent: skip a template already on the delta model.
      if ((et as any).disabledCoreModules !== undefined) {
        disabledByType.set(
          String(et._id),
          (et as any).disabledCoreModules ?? [],
        );
        continue;
      }
      await ctx.db.patch(et._id, {
        disabledCoreModules: disabled,
        activeComponents: undefined,
      } as any);
      templatesMigrated++;
    }

    const events = await ctx.db.query("events").collect();
    for (const ev of events) {
      if ((ev as any).disabledCoreModules !== undefined) continue;
      const disabled = disabledByType.get(String(ev.eventTypeId)) ?? [];
      await ctx.db.patch(ev._id, { disabledCoreModules: disabled } as any);
      eventsMigrated++;
    }

    return { templatesMigrated, eventsMigrated };
  },
});

export const migrateRolesToScoped = internalMutation({
  args: {},
  handler: async (ctx) => {
    let templatesMigrated = 0;
    let eventsMigrated = 0;
    let assignmentsRepointed = 0;

    // ── Templates: chapter roles (via activeRoleIds) → templateRoles ──────────
    // Per eventType, build a map from the OLD chapter-role id → its key, so we
    // can also remap template item roleIds onto the new templateRoles ids.
    const eventTypeRoleMap = new Map<
      string,
      { keyById: Map<string, string>; idByKey: Map<string, Id<"templateRoles">> }
    >();

    const eventTypes = await ctx.db.query("eventTypes").collect();
    for (const et of eventTypes) {
      // Idempotent: skip templates that already have scoped roles.
      const existing = await ctx.db
        .query("templateRoles")
        .withIndex("by_template", (q: any) => q.eq("eventTypeId", et._id))
        .first();

      const keyById = new Map<string, string>();
      const idByKey = new Map<string, Id<"templateRoles">>();

      if (existing) {
        const rows = await ctx.db
          .query("templateRoles")
          .withIndex("by_template", (q: any) => q.eq("eventTypeId", et._id))
          .collect();
        for (const r of rows) idByKey.set(r.key, r._id as Id<"templateRoles">);
        eventTypeRoleMap.set(String(et._id), { keyById, idByKey });
        continue;
      }

      const activeRoleIds: any[] = (et as any).activeRoleIds ?? [];
      let order = 0;
      for (const rid of activeRoleIds) {
        const old = await ctx.db.get(rid as Id<any>);
        if (!old) continue;
        const oldRole = old as any;
        keyById.set(String(rid), oldRole.key);
        const newId = (await ctx.db.insert("templateRoles", {
          eventTypeId: et._id,
          key: oldRole.key,
          label: oldRole.label,
          description: oldRole.description,
          order: order++,
          isArchived: oldRole.isArchived === true ? true : undefined,
        })) as Id<"templateRoles">;
        idByKey.set(oldRole.key, newId);
      }
      eventTypeRoleMap.set(String(et._id), { keyById, idByKey });

      // Remap this template's item roleIds (old chapter-role id → new template
      // role id, matched by key).
      const items = await ctx.db
        .query("templateItems")
        .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", et._id))
        .collect();
      for (const it of items) {
        const oldRoleId = (it as any).roleId;
        if (!oldRoleId) continue;
        const key = keyById.get(String(oldRoleId));
        const newId = key ? idByKey.get(key) : undefined;
        await ctx.db.patch(it._id, { roleId: newId } as any);
      }
      templatesMigrated++;
    }

    // ── Events: clone template roles ∪ roles referenced by assignments ───────
    const events = await ctx.db.query("events").collect();
    for (const ev of events) {
      // Idempotent: skip events that already have scoped roles.
      const existingEventRole = await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q: any) => q.eq("eventId", ev._id))
        .first();
      if (existingEventRole) continue;

      const tmplMap = eventTypeRoleMap.get(String(ev.eventTypeId));

      // Roles referenced by this event's assignments (old chapter-role ids).
      const assignments = await ctx.db
        .query("roleAssignments")
        .withIndex("by_event", (q: any) => q.eq("eventId", ev._id))
        .collect();

      // Build the union of role keys: template roles + assignment roles.
      const keyToOldRole = new Map<
        string,
        { label: string; description?: string }
      >();
      const orderedKeys: string[] = [];
      if (tmplMap) {
        // Use the template's role order as the base.
        const tmplRoles = await ctx.db
          .query("templateRoles")
          .withIndex("by_template", (q: any) =>
            q.eq("eventTypeId", ev.eventTypeId),
          )
          .collect();
        for (const r of tmplRoles.sort((a, b) => a.order - b.order)) {
          if (r.isArchived === true) continue;
          if (!keyToOldRole.has(r.key)) {
            keyToOldRole.set(r.key, { label: r.label, description: r.description });
            orderedKeys.push(r.key);
          }
        }
      }
      // Pull in any assignment-referenced chapter roles not already covered.
      const oldRoleIdToKey = new Map<string, string>();
      for (const a of assignments) {
        const old = await ctx.db.get((a as any).roleId as Id<any>);
        if (!old) continue;
        const oldRole = old as any;
        oldRoleIdToKey.set(String((a as any).roleId), oldRole.key);
        if (!keyToOldRole.has(oldRole.key)) {
          keyToOldRole.set(oldRole.key, {
            label: oldRole.label,
            description: oldRole.description,
          });
          orderedKeys.push(oldRole.key);
        }
      }

      // Create the event roles and index by key.
      const eventRoleByKey = new Map<string, Id<"eventRoles">>();
      let order = 0;
      for (const key of orderedKeys) {
        const meta = keyToOldRole.get(key)!;
        const newId = (await ctx.db.insert("eventRoles", {
          eventId: ev._id,
          key,
          label: meta.label,
          description: meta.description,
          order: order++,
        })) as Id<"eventRoles">;
        eventRoleByKey.set(key, newId);
      }

      // Repoint each assignment's roleId to the matching new eventRole.
      for (const a of assignments) {
        const key = oldRoleIdToKey.get(String((a as any).roleId));
        const newId = key ? eventRoleByKey.get(key) : undefined;
        if (newId) {
          await ctx.db.patch(a._id, { roleId: newId } as any);
          assignmentsRepointed++;
        }
      }

      // Remap this event's item roleIds (old chapter-role id → new event role
      // id, matched by key via the template map + assignment map).
      const items = await ctx.db
        .query("eventItems")
        .withIndex("by_event", (q: any) => q.eq("eventId", ev._id))
        .collect();
      for (const it of items) {
        const oldRoleId = (it as any).roleId;
        if (!oldRoleId) continue;
        const key =
          tmplMap?.keyById.get(String(oldRoleId)) ??
          oldRoleIdToKey.get(String(oldRoleId));
        const newId = key ? eventRoleByKey.get(key) : undefined;
        await ctx.db.patch(it._id, { roleId: newId } as any);
      }
      eventsMigrated++;
    }

    return { templatesMigrated, eventsMigrated, assignmentsRepointed };
  },
});
