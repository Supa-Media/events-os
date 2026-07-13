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
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  canonicalColumnOrder,
  DEFAULT_COLUMNS,
  SUPPLY_STATUS_OPTIONS,
  type ModuleKey,
} from "@events-os/shared";
import { MIGRATIONS } from "./migrations/index";
import { runCleanupRenamedGuideSlugs } from "./migrations/0007_cleanup_renamed_guide_slugs";

/**
 * Backfill: ensure every template/event grid module has all of its current
 * DEFAULT_COLUMNS present.
 *
 * Columns are SNAPSHOTTED per scope — a template's columns are seeded from
 * DEFAULT_COLUMNS when the module is set up (`seedModuleColumns`), and an event
 * clones the template's columns at instantiation. They are NOT read live. So a
 * template/event created before a default column existed (e.g. supplies `qty`)
 * permanently lacks that column, and there's no way to surface it from the UI
 * (the Columns menu only lists columns that exist).
 *
 * This walks each (scope, module) group and INSERTS any DEFAULT_COLUMNS column
 * whose `key` is absent, copying label/kind/type/options/config/isVisible from
 * the shared default — then NORMALIZES the group's order to the canonical
 * rule (canonicalColumnOrder): Title, Details, Status, Timing, Due first,
 * everything else keeping its existing relative order. Without the
 * normalization, backfilled columns would land at the tail of every existing
 * grid (Timing/Due after Notes) and older scopes would keep pre-rule layouts
 * (comms' Status after its dates) forever.
 *
 * Idempotent: a second run inserts nothing and finds every order already
 * canonical.
 *
 * Run locally:   npx convex run migrations:backfillMissingDefaultColumns
 * Run on prod:   npx convex run --prod migrations:backfillMissingDefaultColumns
 */
export const backfillMissingDefaultColumns = internalMutation({
  args: {},
  handler: async (ctx) => {
    let templateColumnsAdded = 0;
    let eventColumnsAdded = 0;
    let columnsReordered = 0;

    /** Missing defaults for a group, as insertable field bags (sans scope). */
    const missingDefaults = (
      module: string,
      cols: Array<{ key: string }>,
    ): Array<Record<string, unknown>> => {
      const defaults = DEFAULT_COLUMNS[module as ModuleKey];
      if (!defaults) return [];
      const present = new Set(cols.map((c) => c.key));
      return defaults
        .filter((d) => !present.has(d.key))
        .map((d) => ({
          module,
          key: d.key,
          label: d.label,
          kind: d.kind,
          type: d.type,
          options: d.options,
          config: d.config,
          isVisible: d.isVisible,
        }));
    };

    /** Re-stamp `order` so the canonical leading columns come first and the
     *  rest keep their current relative order; patches only real changes. */
    const normalizeOrder = async (
      cols: Array<{ _id: Id<"templateColumns"> | Id<"eventColumns">; key: string; order: number }>,
    ) => {
      const sorted = [...cols].sort((a, b) => a.order - b.order);
      const finalOrder = canonicalColumnOrder(sorted);
      for (let i = 0; i < finalOrder.length; i++) {
        if (finalOrder[i].order === i) continue;
        await ctx.db.patch(finalOrder[i]._id as any, { order: i });
        columnsReordered++;
      }
    };

    // ── Templates ──────────────────────────────────────────────────────────
    const templateCols = await ctx.db.query("templateColumns").collect();
    const byTemplateModule = new Map<string, typeof templateCols>();
    for (const c of templateCols) {
      const k = `${String(c.eventTypeId)}::${c.module}`;
      (byTemplateModule.get(k) ?? byTemplateModule.set(k, []).get(k)!).push(c);
    }
    for (const [k, cols] of byTemplateModule) {
      const [eventTypeId, module] = k.split("::");
      if (!DEFAULT_COLUMNS[module as ModuleKey]) continue;
      let nextOrder = cols.reduce((m, c) => (c.order > m ? c.order : m), -1) + 1;
      const added: Array<{ _id: Id<"templateColumns">; key: string; order: number }> = [];
      for (const d of missingDefaults(module, cols)) {
        const order = nextOrder++;
        const _id = await ctx.db.insert("templateColumns", {
          eventTypeId: eventTypeId as Id<"eventTypes">,
          ...d,
          order,
        } as any);
        added.push({ _id, key: d.key as string, order });
        templateColumnsAdded++;
      }
      await normalizeOrder([...cols, ...added]);
    }

    // ── Events ─────────────────────────────────────────────────────────────
    const eventCols = await ctx.db.query("eventColumns").collect();
    const byEventModule = new Map<string, typeof eventCols>();
    for (const c of eventCols) {
      const k = `${String(c.eventId)}::${c.module}`;
      (byEventModule.get(k) ?? byEventModule.set(k, []).get(k)!).push(c);
    }
    for (const [k, cols] of byEventModule) {
      const [eventId, module] = k.split("::");
      if (!DEFAULT_COLUMNS[module as ModuleKey]) continue;
      let nextOrder = cols.reduce((m, c) => (c.order > m ? c.order : m), -1) + 1;
      const added: Array<{ _id: Id<"eventColumns">; key: string; order: number }> = [];
      for (const d of missingDefaults(module, cols)) {
        const order = nextOrder++;
        const _id = await ctx.db.insert("eventColumns", {
          eventId: eventId as Id<"events">,
          ...d,
          order,
        } as any);
        added.push({ _id, key: d.key as string, order });
        eventColumnsAdded++;
      }
      await normalizeOrder([...cols, ...added]);
    }

    return { templateColumnsAdded, eventColumnsAdded, columnsReordered };
  },
});

/**
 * Phase 3 migration: `eventTypes.activeComponents` (and the per-event copy via
 * its eventType) → the core-module DELTA model.
 *
 * Modules used to be an explicit `activeComponents: string[]` allow-list of the
 * 7 grid modules. They're now platform-wide CORE_MODULES with a per-scope
 * `disabledCoreModules` deny-list (+ overrides, + custom rows). The general rule
 * for introducing a new core module is that it's ABSENT from existing
 * `disabledCoreModules`, so it defaults to ENABLED everywhere — which is exactly
 * what we wanted for the then-new `site_map` module. (Historical: the standalone
 * `site_map` core module has since been folded into Supplies & Logistics; any
 * lingering `"site_map"` strings in `disabledCoreModules` are ignored by
 * `resolveActiveModules`.)
 *
 * So we set `disabledCoreModules = PRIOR_CORE_KEYS − activeComponents` (the OLD
 * 7-key set minus what was active). Cloned onto each event from its eventType.
 * `activeComponents` is then cleared.
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

/**
 * Cleanup after `migrateRolesToScoped`: the roles migration repoints references
 * but leaves two pieces of legacy state that the strict schema rejects —
 *   1. `eventTypes.activeRoleIds` (field no longer in the schema), and
 *   2. the orphaned old chapter `roles` table rows (table no longer in schema).
 * Run this LAST (after both migrations) so a strict schema push validates clean.
 * Idempotent: skips eventTypes already cleared; deletes whatever roles remain.
 */
export const cleanupLegacyRoles = internalMutation({
  args: {},
  handler: async (ctx) => {
    let eventTypesCleared = 0;
    let rolesDeleted = 0;

    for (const et of await ctx.db.query("eventTypes").collect()) {
      if ((et as any).activeRoleIds !== undefined) {
        await ctx.db.patch(et._id, { activeRoleIds: undefined } as any);
        eventTypesCleared++;
      }
    }

    // The old chapter-role table is gone from the schema; its rows are orphaned
    // once refs are repointed. Query/delete via `as any` since it's untyped now.
    for (const r of await (ctx.db as any).query("roles").collect()) {
      await ctx.db.delete(r._id);
      rolesDeleted++;
    }

    return { eventTypesCleared, rolesDeleted };
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

/**
 * Retire the supplies `packed` STATUS in favor of the Packing checklist.
 *
 * Supply status now tracks ACQUISITION only and terminates at `have_it`;
 * whether an item is packed is the `fields.packedIn` boolean the Packing
 * screen toggles. The old `packed` status duplicated that signal (a row could
 * read "Packed" while its packing checkbox said otherwise). For every scope
 * whose supplies STATUS column still carries the legacy `packed` option:
 *   1. drop `packed` and make `have_it` the canonical complete option
 *      (copied from SUPPLY_STATUS_OPTIONS so migrated and freshly-seeded
 *      columns can't drift; appended if an author had removed have_it, so
 *      the rewritten items below always land on a real option);
 *   2. rewrite items whose status is `packed` to `have_it`;
 *   3. on EVENT items, backfill `fields.packedIn = true` for any item whose
 *      status was complete under the OLD option set — under the old model a
 *      terminal supply status (packed, or an author-customized complete
 *      value) meant packed, and that fact now lives on the checklist.
 * Scopes already on the new vocabulary (no `packed` option) are untouched,
 * so have_it items on new events never get a phantom packedIn.
 *
 * Reads are scoped per template/event via the `by_*_module` indexes — only
 * supplies rows are ever read, keeping the single transaction proportional
 * to supplies data rather than every row in the database.
 *
 * Idempotent: a second run finds no `packed` options and changes nothing.
 * Finishes by scheduling `backfillMissingDefaultColumns`, which adds the new
 * supplies Timing/Due columns to existing scopes — one run leaves existing
 * data fully on the new model.
 *
 * Run locally:   npx convex run migrations:retireSuppliesPackedStatus
 * Run on prod:   npx convex run --prod migrations:retireSuppliesPackedStatus
 */
export const retireSuppliesPackedStatus = internalMutation({
  args: {},
  handler: async (ctx) => {
    let columnsUpdated = 0;
    let templateItemsUpdated = 0;
    let eventItemsUpdated = 0;

    const canonicalHaveIt = SUPPLY_STATUS_OPTIONS.find(
      (o) => o.value === "have_it",
    )!;

    // New options for a LEGACY set (has `packed`), or null to leave alone.
    const fixOptions = (options: any[] | undefined): any[] | null => {
      if (!options?.some((o) => o.value === "packed")) return null;
      const kept = options.filter((o) => o.value !== "packed");
      return kept.some((o) => o.value === "have_it")
        ? kept.map((o) =>
            o.value === "have_it" ? { ...o, ...canonicalHaveIt } : o,
          )
        : [...kept, { ...canonicalHaveIt }];
    };

    // ── Templates ──────────────────────────────────────────────────────────
    for (const et of await ctx.db.query("eventTypes").collect()) {
      const cols = await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", et._id).eq("module", "supplies"),
        )
        .collect();
      const statusCol = cols.find((c) => c.key === "status");
      const next = fixOptions(statusCol?.options as any[] | undefined);
      if (statusCol && next) {
        await ctx.db.patch(statusCol._id, { options: next });
        columnsUpdated++;
      }
      const items = await ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", et._id).eq("module", "supplies"),
        )
        .collect();
      for (const it of items) {
        if (it.status !== "packed") continue;
        await ctx.db.patch(it._id, { status: "have_it" });
        templateItemsUpdated++;
      }
    }

    // ── Events ─────────────────────────────────────────────────────────────
    for (const ev of await ctx.db.query("events").collect()) {
      const cols = await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", ev._id).eq("module", "supplies"),
        )
        .collect();
      const statusCol = cols.find((c) => c.key === "status");
      const original = (statusCol?.options ?? []) as any[];
      // Only legacy sets (still carrying `packed`) get the item backfill —
      // on a new-vocabulary event, have_it means in-hand, NOT packed.
      const isLegacySet = original.some((o) => o.value === "packed");
      const next = fixOptions(statusCol?.options as any[] | undefined);
      if (statusCol && next) {
        await ctx.db.patch(statusCol._id, { options: next });
        columnsUpdated++;
      }
      if (!isLegacySet) continue;

      const completeValues = new Set(
        original.filter((o) => o.isComplete === true).map((o) => o.value),
      );
      const items = await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", ev._id).eq("module", "supplies"),
        )
        .collect();
      for (const it of items) {
        const wasPacked =
          it.status === "packed" ||
          (it.status != null && completeValues.has(it.status));
        const rewriteStatus = it.status === "packed";
        const backfillPackedIn =
          wasPacked && (it.fields as any)?.packedIn !== true;
        if (!rewriteStatus && !backfillPackedIn) continue;
        await ctx.db.patch(it._id, {
          ...(rewriteStatus ? { status: "have_it" } : {}),
          ...(backfillPackedIn
            ? { fields: { ...((it.fields as any) ?? {}), packedIn: true } }
            : {}),
        });
        eventItemsUpdated++;
      }
    }

    // The new supplies Timing/Due columns are snapshot-seeded per scope —
    // chain the backfill so nobody has to remember the second migration.
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.backfillMissingDefaultColumns,
      {},
    );

    return { columnsUpdated, templateItemsUpdated, eventItemsUpdated };
  },
});

/**
 * Un-hide the supplies `qty` column wherever it was hidden.
 *
 * The "Worship With Strangers" template (and events cloned from it) shipped with
 * "trimmed" supplies columns — `qty` exists but `isVisible: false` — so it never
 * rendered. `qty` is a default-VISIBLE column, so this restores it: sets
 * isVisible=true for every supplies `qty` column (template + event) currently
 * false. Idempotent (a second run finds none false).
 *
 * Run locally:   npx convex run migrations:showSuppliesQty
 * Run on prod:   npx convex run --prod migrations:showSuppliesQty
 */
export const showSuppliesQty = internalMutation({
  args: {},
  handler: async (ctx) => {
    let templateShown = 0;
    let eventShown = 0;
    for (const c of await ctx.db.query("templateColumns").collect()) {
      if (c.module === "supplies" && c.key === "qty" && c.isVisible === false) {
        await ctx.db.patch(c._id, { isVisible: true });
        templateShown++;
      }
    }
    for (const c of await ctx.db.query("eventColumns").collect()) {
      if (c.module === "supplies" && c.key === "qty" && c.isVisible === false) {
        await ctx.db.patch(c._id, { isVisible: true });
        eventShown++;
      }
    }
    return { templateShown, eventShown };
  },
});

/**
 * Cleanup after the guide slug renames (workstream → area vocabulary):
 * docs/guides/so-you-own-a-workstream.md → so-you-own-an-area.md and
 * owning-the-comms-workstream.md → owning-the-comms-area.md. The seeder
 * upserts by (chapterId, slug), so every chapter re-seeds the guides under
 * the NEW slugs and the old-slug rows linger as orphaned platform docs.
 * This deletes the old-slug rows in every chapter.
 *
 * Idempotent: a second run finds nothing to delete.
 *
 * Run locally:   npx convex run migrations:cleanupRenamedGuideSlugs
 * Run on prod:   npx convex run --prod migrations:cleanupRenamedGuideSlugs
 */
export const cleanupRenamedGuideSlugs = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Body lives in the registry file so `runPending` and this manual
    // entrypoint share one implementation.
    return await runCleanupRenamedGuideSlugs(ctx);
  },
});

/**
 * Auto-migration runner.
 *
 * Walks the ordered `MIGRATIONS` registry (see `migrations/index.ts`) and, for
 * each entry not yet in the `schemaMigrations` ledger, runs it then records the
 * ledger row. Idempotent by construction: a name already in the ledger is
 * skipped, so re-running is a no-op and only genuinely-pending migrations fire.
 * Intended to be called post-deploy (CI runs `npx convex run migrations:runPending`).
 *
 * Run locally:   npx convex run migrations:runPending
 * Run on prod:   npx convex run --prod migrations:runPending
 */
export const runPending = internalMutation({
  args: {},
  handler: async (ctx) => {
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const migration of MIGRATIONS) {
      const existing = await ctx.db
        .query("schemaMigrations")
        .withIndex("by_name", (q) => q.eq("name", migration.name))
        .unique();
      if (existing) {
        skipped.push(migration.name);
        continue;
      }
      const result = await migration.run(ctx);
      await ctx.db.insert("schemaMigrations", {
        name: migration.name,
        ranAt: Date.now(),
        result:
          result === undefined || result === null
            ? undefined
            : JSON.stringify(result),
      });
      applied.push(migration.name);
    }
    return { applied, skipped };
  },
});
