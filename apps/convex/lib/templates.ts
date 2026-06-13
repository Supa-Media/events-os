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
  computeDueDate,
  defaultStatusValue,
  type ModuleKey,
} from "@events-os/shared";

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
 * Seed a template module with its default columns (from shared DEFAULT_COLUMNS).
 * Used when a from-scratch template turns a module/component on.
 */
export async function seedModuleColumns(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  module: ModuleKey,
) {
  const defaults = DEFAULT_COLUMNS[module] ?? [];
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

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
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
  const eventId = (await ctx.db.insert("events", {
    chapterId: opts.chapterId,
    eventTypeId: opts.eventType._id,
    templateVersion: opts.eventType.version,
    name: opts.name,
    eventDate: opts.eventDate,
    location: opts.location,
    budget: opts.budget,
    status: "planning",
    createdBy: opts.userId,
    createdAt: now,
    updatedAt: now,
  })) as Id<"events">;

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
    await ctx.db.insert("eventItems", {
      eventId,
      chapterId: opts.chapterId,
      module: it.module,
      title: it.title,
      order: it.order,
      offsetDays: it.offsetDays,
      offsetMinutes: it.offsetMinutes,
      dueDate,
      roleId: it.roleId,
      status: it.status ?? defaultStatusValue(it.module as ModuleKey),
      fields: it.fields,
    });
  }

  return eventId;
}
