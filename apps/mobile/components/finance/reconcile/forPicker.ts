/**
 * The "For" picker (WP-U: one home per dollar) — ONE picker replacing the old
 * separate Budget + Link columns/pickers, grouped Events / Projects /
 * Recurring. Shared between the Reconcile grid (`ReconcileList`/`BulkBar`)
 * and `ManualTransactionModal`, so the option-building + summon-on-pick logic
 * never drifts between the two surfaces.
 *
 * Value encoding:
 *  - an EXISTING budget (event/project/recurring) → its `budgetId` directly.
 *  - a budget-less event/project (a summon-candidate) → `summon:event:<id>` /
 *    `summon:project:<id>`. Picking one of these must first call
 *    `finances.summonBudgetForRef` to create its $0 "plan" budget, THEN
 *    categorize/create using the returned real `budgetId` — see
 *    `resolveForPickerValue`.
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { PickerItem } from "./ReconcileList";

export type ForPickerOptions = FunctionReturnType<typeof api.finances.forPickerOptions>;

const SUMMON_PREFIX = "summon:";

/** Build the "For" picker's flattened option list from `forPickerOptions`,
 *  with a leading "None" clear row. Recurring budgets are grouped by level
 *  (Chapter / Central) — the same split the old Budget picker offered. */
export function buildForPickerItems(options: ForPickerOptions): PickerItem[] {
  const chapterRecurring = options.recurring.filter((r) => r.level === "chapter");
  const centralRecurring = options.recurring.filter((r) => r.level === "central");

  return [
    { value: "", label: "None" },
    ...(options.events.length > 0
      ? [{ value: "__grp_events", label: "Events", header: true }]
      : []),
    ...options.events.map((e) => ({
      value: e.budgetId ?? `${SUMMON_PREFIX}event:${e.eventId}`,
      label: e.label,
    })),
    ...(options.projects.length > 0
      ? [{ value: "__grp_projects", label: "Projects", header: true }]
      : []),
    ...options.projects.map((p) => ({
      value: p.budgetId ?? `${SUMMON_PREFIX}project:${p.projectId}`,
      label: p.label,
    })),
    ...(chapterRecurring.length > 0
      ? [{ value: "__grp_recurring_chapter", label: "Recurring · Chapter", header: true }]
      : []),
    ...chapterRecurring.map((r) => ({ value: r.budgetId, label: r.label })),
    ...(centralRecurring.length > 0
      ? [{ value: "__grp_recurring_central", label: "Recurring · Central", header: true }]
      : []),
    ...centralRecurring.map((r) => ({ value: r.budgetId, label: r.label })),
  ];
}

/** Whether a picker value is a summon-candidate (a budget-less event/project),
 *  rather than a real `budgetId`. */
export function isSummonValue(value: string): boolean {
  return value.startsWith(SUMMON_PREFIX);
}

/** Parse a `summon:<refKind>:<id>` value into its ref. Returns `null` for a
 *  real budgetId (not a summon value) — callers check `isSummonValue` first,
 *  but this stays defensive. */
export function parseSummonValue(
  value: string,
): { refKind: "event" | "project"; scopeRefId: string } | null {
  if (!isSummonValue(value)) return null;
  const rest = value.slice(SUMMON_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const refKind = rest.slice(0, sep);
  const scopeRefId = rest.slice(sep + 1);
  if (refKind !== "event" && refKind !== "project") return null;
  return { refKind, scopeRefId };
}

/**
 * Resolve a "For" picker selection to a real `budgetId`, summoning the ref's
 * budget first when the pick was a summon-candidate. `summon` is the caller's
 * bound `api.finances.summonBudgetForRef` mutation (kept as a parameter so
 * this stays a plain function, not a hook).
 */
export async function resolveForPickerValue(
  value: string,
  summon: (args: {
    refKind: "event" | "project";
    scopeRefId: string;
  }) => Promise<Id<"budgets">>,
): Promise<Id<"budgets">> {
  const summonRef = parseSummonValue(value);
  if (summonRef) return await summon(summonRef);
  return value as Id<"budgets">;
}
