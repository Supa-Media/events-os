/**
 * Phase-based readiness for an event.
 *
 * Replaces the single readiness % with four phase numbers (pre-plan / planning /
 * day-of / post). Reads the event's active GRID modules, each module's status
 * column options (for `isComplete`), and all of its `eventItems`, then defers the
 * actual scoring to the pure `computePhaseScores` helper in @events-os/shared so
 * the rule lives in one place and is testable without a DB.
 *
 * Typed loosely (`ctx: any`) like the rest of `lib/` — it's helper code, not a
 * registered Convex function.
 */
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import {
  computePhaseScores,
  isCompleteStatus,
  MODULE_READY_PHASE,
  type PhaseScores,
  type SelectOption,
} from "@events-os/shared";
import { eventActiveModules } from "./templates";

/**
 * Load an event+module's STATUS column (the one whose `key === "status"`, which
 * carries the `isComplete` select options used to decide "done"). Returns the
 * column doc or null when the module has no status column. Uses the
 * `by_event_module` index — no full scan. This single query was duplicated
 * across event readiness, module summaries, and the pipeline; share it.
 */
export async function statusColumnFor(
  ctx: QueryCtx,
  eventId: Id<"events">,
  module: string,
): Promise<Doc<"eventColumns"> | null> {
  return await ctx.db
    .query("eventColumns")
    .withIndex("by_event_module", (q) =>
      q.eq("eventId", eventId).eq("module", module),
    )
    .filter((q) => q.eq(q.field("key"), "status"))
    .first();
}

/**
 * Load an event+module's items and its status column together, returning the
 * raw rows plus the complete/total counts (an item is complete when its status
 * matches a status-column option flagged `isComplete`). `hasStatus` is false
 * when the module has no status column (then `done` is 0). Bundles the two
 * `by_event_module` reads the readiness / module-summary / pipeline call sites
 * all perform.
 */
export async function statusCountsFor(
  ctx: QueryCtx,
  eventId: Id<"events">,
  module: string,
): Promise<{
  items: Doc<"eventItems">[];
  statusCol: Doc<"eventColumns"> | null;
  options: SelectOption[] | undefined;
  hasStatus: boolean;
  total: number;
  done: number;
}> {
  const items = await ctx.db
    .query("eventItems")
    .withIndex("by_event_module", (q) =>
      q.eq("eventId", eventId).eq("module", module),
    )
    .collect();
  const statusCol = await statusColumnFor(ctx, eventId, module);
  const options = statusCol?.options as SelectOption[] | undefined;
  const hasStatus = !!statusCol;
  const total = items.length;
  const done = hasStatus
    ? items.filter((it) => isCompleteStatus(options, it.status)).length
    : 0;
  return { items, statusCol, options, hasStatus, total, done };
}

/**
 * Compute the four phase scores for an event. Each value is 0..1, or null when
 * the phase has no items to measure (rendered "—", not "0%").
 */
export async function phaseReadiness(
  ctx: any,
  event: any,
): Promise<PhaseScores> {
  // Grid modules only — non-grid surfaces (site_map) have no status'd items.
  const resolved = await eventActiveModules(ctx, event);
  const gridModuleKeys = resolved
    .filter((m: any) => m.surface === "grid")
    .map((m: any) => m.key as string);

  const modules = await Promise.all(
    gridModuleKeys.map(async (module) => {
      const items = await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", event._id as Id<"events">).eq("module", module),
        )
        .collect();
      const statusCol = await statusColumnFor(
        ctx,
        event._id as Id<"events">,
        module,
      );
      const statusOptions = statusCol?.options as SelectOption[] | undefined;
      return {
        module,
        statusOptions,
        items: items.map((it: any) => ({
          status: it.status ?? null,
          offsetDays: it.offsetDays ?? null,
          offsetMinutes: it.offsetMinutes ?? null,
          prePlanColumns: it.prePlanColumns ?? undefined,
          prePlanChecked: it.prePlanChecked ?? undefined,
        })),
      };
    }),
  );

  // Pre-plan also counts setup work: assigning a person to each event ROLE and
  // giving each active module an OWNER (its owner role being assigned). Each is a
  // pre-plan item, equally weighted with the template-marked cell check-offs.
  const eventRoles = await ctx.db
    .query("eventRoles")
    .withIndex("by_event", (q: any) => q.eq("eventId", event._id as Id<"events">))
    .collect();
  const assignments = await ctx.db
    .query("roleAssignments")
    .withIndex("by_event", (q: any) => q.eq("eventId", event._id as Id<"events">))
    .collect();
  const assignedRoleIds = new Set(assignments.map((a: any) => String(a.roleId)));
  const roleByKey = new Map(eventRoles.map((r: any) => [r.key, r]));

  const totalRoles = eventRoles.length;
  const assignedRoles = eventRoles.filter((r: any) =>
    assignedRoleIds.has(String(r._id)),
  ).length;

  let ownerTotal = 0;
  let ownerDone = 0;
  for (const m of resolved) {
    if (!m.ownerRoleKey) continue;
    ownerTotal += 1;
    const role: any = roleByKey.get(m.ownerRoleKey);
    if (role && assignedRoleIds.has(String(role._id))) ownerDone += 1;
  }

  const prePlanExtra = {
    done: assignedRoles + ownerDone,
    total: totalRoles + ownerTotal,
  };

  // Module "mark as ready" gates feed their mapped phase, so marking a module
  // ready visibly moves that phase's ring. Covers non-grid modules too (site_map
  // has no items but still has a ready gate).
  const readyByKey = new Map<string, boolean>(
    (event.moduleReadiness ?? []).map((r: any) => [
      r.key as string,
      r.ready as boolean,
    ]),
  );
  const moduleReady = resolved
    .filter((m: any) => MODULE_READY_PHASE[m.key])
    .map((m: any) => ({
      phase: MODULE_READY_PHASE[m.key],
      ready: readyByKey.get(m.key) === true,
    }));

  return computePhaseScores(modules, prePlanExtra, moduleReady);
}
