/**
 * Shared template helpers.
 *
 * Typed loosely (`ctx: any`) so this file doesn't depend on Convex's generated
 * types — it's pure helper code, not a registered function.
 */
import { Id } from "../_generated/dataModel";
import {
  DEFAULT_COLUMNS,
  DAY_OFFSET_MODULES,
  DEFAULT_ROLES,
  computeDueDate,
  defaultStatusValue,
  resolveActiveModules,
  type ColumnDef,
  type ModuleKey,
  type CustomModule,
  type ScopeModuleState,
  type ResolvedModule,
} from "@events-os/shared";

/** A role seed: a stable key + display label + optional description. */
type RoleSeedLike = { key: string; label: string; description?: string };
import { findUnlinkedPersonByLoginEmail, claimFields } from "./people";

/** Kebab-case slug from a display name. */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Max `order` over a list of rows (returns -1 when empty, so next = 0). */
export function maxOrder(rows: Array<{ order: number }>): number {
  return rows.reduce((max, r) => (r.order > max ? r.order : max), -1);
}

/** Bump a template's version and touch updatedAt. */
export async function bumpVersion(ctx: any, eventTypeId: Id<"eventTypes">) {
  const et = await ctx.db.get(eventTypeId);
  if (et) {
    await ctx.db.patch(eventTypeId, {
      version: (et.version ?? 1) + 1,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Seed a template module's columns. Defaults to the core module's shared
 * DEFAULT_COLUMNS, but a custom module passes its own `columns`
 * (DEFAULT_CUSTOM_COLUMNS). Used when a module is turned on / created.
 */
export async function seedModuleColumns(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  module: string,
  columns?: ColumnDef[],
) {
  const defaults = columns ?? DEFAULT_COLUMNS[module as ModuleKey] ?? [];
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
      isVisible: c.isVisible,
      order: i,
    });
  }
}

/** Map a templateModules / eventModules row to a shared CustomModule. */
function toCustomModule(row: any): CustomModule {
  return {
    key: row.key,
    label: row.label,
    surface: "grid",
    ownerRoleKey: row.ownerRoleKey,
    offsetMode: row.offsetMode ?? "none",
    order: row.order,
    isActive: row.isActive,
  };
}

/** Build a template's module-delta state for `resolveActiveModules`. */
export async function templateModuleState(
  ctx: any,
  eventType: any,
): Promise<ScopeModuleState> {
  const rows = await ctx.db
    .query("templateModules")
    .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventType._id))
    .collect();
  return {
    disabledCoreModules: eventType.disabledCoreModules ?? [],
    coreModuleOverrides: eventType.coreModuleOverrides ?? [],
    customModules: rows.map(toCustomModule),
  };
}

/** Build an event's module-delta state for `resolveActiveModules`. */
export async function eventModuleState(
  ctx: any,
  event: any,
): Promise<ScopeModuleState> {
  const rows = await ctx.db
    .query("eventModules")
    .withIndex("by_event", (q: any) => q.eq("eventId", event._id))
    .collect();
  return {
    disabledCoreModules: event.disabledCoreModules ?? [],
    coreModuleOverrides: event.coreModuleOverrides ?? [],
    customModules: rows.map(toCustomModule),
  };
}

/** Resolved active modules for a template. */
export async function templateActiveModules(
  ctx: any,
  eventType: any,
): Promise<ResolvedModule[]> {
  return resolveActiveModules(await templateModuleState(ctx, eventType));
}

/** Resolved active modules for an event. */
export async function eventActiveModules(
  ctx: any,
  event: any,
): Promise<ResolvedModule[]> {
  return resolveActiveModules(await eventModuleState(ctx, event));
}

/** The roster person for a user in a chapter, or null (no insert). */
export async function getPersonForUser(
  ctx: any,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
): Promise<Id<"people"> | null> {
  const existing = await ctx.db
    .query("people")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();
  if (existing && existing.chapterId === chapterId)
    return existing._id as Id<"people">;
  return null;
}

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

/**
 * Seed a template's roles from a seed list (defaults to DEFAULT_ROLES). Used on
 * template creation. Returns the created role ids keyed by role key.
 */
export async function seedTemplateRoles(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  seeds: RoleSeedLike[] = DEFAULT_ROLES,
): Promise<Record<string, Id<"templateRoles">>> {
  const byKey: Record<string, Id<"templateRoles">> = {};
  for (let i = 0; i < seeds.length; i++) {
    const r = seeds[i];
    byKey[r.key] = (await ctx.db.insert("templateRoles", {
      eventTypeId,
      key: r.key,
      label: r.label,
      description: r.description,
      order: i,
      isArchived: false,
    })) as Id<"templateRoles">;
  }
  return byKey;
}

/**
 * Clone a template's roles onto an event (`templateRoles` → `eventRoles`).
 * Returns a map from the template-role id (string) to the new event-role id, so
 * cloned items can remap their `roleId` from the template scope to the event
 * scope. (Keyed by id because that's what template items carry.)
 */
export async function cloneRolesToEvent(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  eventId: Id<"events">,
): Promise<Map<string, Id<"eventRoles">>> {
  const templateRoles = (
    await ctx.db
      .query("templateRoles")
      .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect()
  )
    .filter((r: any) => r.isArchived !== true)
    .sort((a: any, b: any) => a.order - b.order);

  const idMap = new Map<string, Id<"eventRoles">>();
  for (let i = 0; i < templateRoles.length; i++) {
    const r = templateRoles[i];
    const newId = (await ctx.db.insert("eventRoles", {
      eventId,
      key: r.key,
      label: r.label,
      description: r.description,
      order: i,
    })) as Id<"eventRoles">;
    idMap.set(String(r._id), newId);
  }
  return idMap;
}

/**
 * Materialize a template's PLACEHOLDER crew (templatePeople) into real chapter
 * `people` rows flagged `isPlaceholder`, one per template row. Returns a map
 * from the templatePerson id (string) to the new `people` id, so cloned event
 * Expectations items can repoint their owner from the placeholder reference
 * (stored in the template item's `fields.templateOwnerId`) to the real row. The
 * team then swaps each placeholder for a real volunteer later.
 */
export async function clonePlaceholderCrewToChapter(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  chapterId: Id<"chapters">,
  now: number,
): Promise<Map<string, Id<"people">>> {
  const rows = (
    await ctx.db
      .query("templatePeople")
      .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect()
  ).sort((a: any, b: any) => a.order - b.order);

  const idMap = new Map<string, Id<"people">>();
  for (const r of rows) {
    const newId = (await ctx.db.insert("people", {
      chapterId,
      name: r.name,
      role: r.role,
      isPlaceholder: true,
      isActive: true,
      createdAt: now,
    })) as Id<"people">;
    idMap.set(String(r._id), newId);
  }
  return idMap;
}

/**
 * Resolve the roster person for a user, creating one if they aren't on the
 * roster yet — so the event creator can always be set as the accountable owner.
 * The creator IS a team member; linking a `people` row (by `userId`) lets them
 * own events and hold roles like anyone else.
 */
export async function getOrCreateOwnerPerson(
  ctx: any,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  now: number,
): Promise<Id<"people">> {
  const existing = await ctx.db
    .query("people")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();
  if (existing && existing.chapterId === chapterId)
    return existing._id as Id<"people">;
  const user = await ctx.db.get(userId);
  const email = user?.email as string | undefined;
  const name = user?.name ?? email ?? "Event owner";

  // Adopt an existing unlinked roster row (matched by personal email OR the
  // publicworship pwEmail) instead of inserting a duplicate — keeps one person
  // row per human even when they were imported before they ever signed in.
  const unlinked = await findUnlinkedPersonByLoginEmail(ctx, chapterId, email ?? null);
  if (unlinked) {
    await ctx.db.patch(unlinked._id, claimFields(unlinked, userId, email));
    return unlinked._id as Id<"people">;
  }

  return (await ctx.db.insert("people", {
    chapterId,
    name,
    email,
    pwEmail: email,
    userId,
    isActive: true,
    isTeamMember: true,
    createdAt: now,
  })) as Id<"people">;
}

/**
 * THE TEMPLATING ENGINE. Snapshot a template into a live event: insert the
 * event, clone its columns onto the event, then clone its items (back-
 * calculating due dates for day-offset modules; tasks/comms start at their
 * status column's first option, supplies keep their template acquisition status
 * — which IS the "what do we still need" reset). Returns the new event id.
 */
export async function instantiateEvent(
  ctx: any,
  opts: {
    eventType: any;
    chapterId: Id<"chapters">;
    userId: Id<"users">;
    name: string;
    eventDate: number;
    location?: string;
    budget?: number;
    now?: number;
  },
): Promise<Id<"events">> {
  const now = opts.now ?? Date.now();
  // Never leave an event floating: the creator is the owner until they hand it
  // off (events.updateDetails). Creates a roster person for them if needed.
  const ownerPersonId = await getOrCreateOwnerPerson(
    ctx,
    opts.chapterId,
    opts.userId,
    now,
  );
  const eventId = (await ctx.db.insert("events", {
    chapterId: opts.chapterId,
    eventTypeId: opts.eventType._id,
    templateVersion: opts.eventType.version,
    name: opts.name,
    eventDate: opts.eventDate,
    location: opts.location,
    budget: opts.budget,
    ownerPersonId,
    // Clone the template's core-module deltas onto the event.
    disabledCoreModules: opts.eventType.disabledCoreModules ?? [],
    coreModuleOverrides: opts.eventType.coreModuleOverrides ?? [],
    status: "planning",
    createdBy: opts.userId,
    createdAt: now,
    updatedAt: now,
  })) as Id<"events">;

  // Clone the template's roles onto the event; remap item roleId via this map.
  const roleIdMap = await cloneRolesToEvent(ctx, opts.eventType._id, eventId);

  // Materialize the template's placeholder crew into real chapter people; map
  // templatePerson id → new people id so Expectations items can be pre-owned.
  const placeholderMap = await clonePlaceholderCrewToChapter(
    ctx,
    opts.eventType._id,
    opts.chapterId,
    now,
  );

  // Clone the template's custom modules onto the event.
  const templateMods = await ctx.db
    .query("templateModules")
    .withIndex("by_template", (q: any) =>
      q.eq("eventTypeId", opts.eventType._id),
    )
    .collect();
  for (const m of templateMods) {
    if (m.isActive === false) continue;
    await ctx.db.insert("eventModules", {
      eventId,
      key: m.key,
      label: m.label,
      ownerRoleKey: m.ownerRoleKey,
      offsetMode: m.offsetMode,
      order: m.order,
    });
  }

  const cols = await ctx.db
    .query("templateColumns")
    .withIndex("by_eventType", (q: any) =>
      q.eq("eventTypeId", opts.eventType._id),
    )
    .collect();
  for (const c of cols) {
    const { _id, _creationTime, eventTypeId: _e, ...rest } = c as any;
    await ctx.db.insert("eventColumns", { eventId, ...rest });
  }

  const items = await ctx.db
    .query("templateItems")
    .withIndex("by_eventType", (q: any) =>
      q.eq("eventTypeId", opts.eventType._id),
    )
    .collect();
  for (const it of items) {
    const dueDate =
      isDayOffsetModule(it.module) && it.offsetDays !== undefined
        ? computeDueDate(opts.eventDate, it.offsetDays)
        : undefined;
    // Expectations rows authored against a placeholder crew member carry the
    // templatePerson id in fields.templateOwnerId — repoint it to the real
    // materialized person and strip the now-stale template owner fields.
    let ownerPersonId: Id<"people"> | undefined;
    let fields = it.fields;
    const templateOwnerId = it.fields?.templateOwnerId;
    if (templateOwnerId) {
      ownerPersonId = placeholderMap.get(String(templateOwnerId));
      const { templateOwnerId: _o, templateOwnerName: _n, ...rest } =
        it.fields as Record<string, any>;
      fields = Object.keys(rest).length > 0 ? rest : undefined;
    }
    await ctx.db.insert("eventItems", {
      eventId,
      chapterId: opts.chapterId,
      module: it.module,
      title: it.title,
      order: it.order,
      offsetDays: it.offsetDays,
      offsetMinutes: it.offsetMinutes,
      dueDate,
      roleId: it.roleId ? roleIdMap.get(String(it.roleId)) : undefined,
      ownerPersonId,
      status: it.status ?? defaultStatusValue(it.module as ModuleKey),
      // Carry the template author's pre-plan cell marks onto the event so they
      // show up as check-off cells; nothing is checked yet (prePlanChecked unset).
      prePlanColumns: it.prePlanColumns,
      // `fields` is copied verbatim, which means any `how_to` cell's doc id is
      // carried over by reference — the template's How-To doc (`scope:
      // "template"`) is SHARED with every event spun up from it (and across
      // sibling events) at clone time. This is intentional: a How-To is a
      // canonical reference ("how to set up the PA").
      //
      // Editing follows a COPY-ON-WRITE model: the first edit of a shared doc
      // from an event forks a `scope: "event"` copy and repoints that event
      // item's cell at it (see `docs.forkForEventItem`), so the master and all
      // sibling events keep the original. Subsequent edits land on the copy.
      fields,
    });
  }

  // Clone the template's SITE MAP onto the event: the background image plus
  // every marker and shape (new event-scoped rows, same geometry/labels/colors).
  // Placements are deliberately NOT cloned — they reference per-event supplies/
  // volunteers that don't exist yet.
  if (opts.eventType.siteMapImage) {
    await ctx.db.patch(eventId, {
      siteMapImage: opts.eventType.siteMapImage,
      updatedAt: now,
    });
  }

  const templateMarkers = await ctx.db
    .query("siteMarkers")
    .withIndex("by_template", (q: any) =>
      q.eq("eventTypeId", opts.eventType._id),
    )
    .collect();
  for (const m of templateMarkers) {
    await ctx.db.insert("siteMarkers", {
      chapterId: opts.chapterId,
      eventId,
      x: m.x,
      y: m.y,
      label: m.label,
      color: m.color,
      category: m.category,
      createdAt: now,
    });
  }

  const templateShapes = await ctx.db
    .query("siteShapes")
    .withIndex("by_template", (q: any) =>
      q.eq("eventTypeId", opts.eventType._id),
    )
    .collect();
  for (const s of templateShapes) {
    await ctx.db.insert("siteShapes", {
      chapterId: opts.chapterId,
      eventId,
      type: s.type,
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      x2: s.x2,
      y2: s.y2,
      color: s.color,
      label: s.label,
      createdAt: now,
    });
  }

  return eventId;
}
