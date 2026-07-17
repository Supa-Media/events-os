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
 *
 * RANKING (reduce-the-scroll fix): `buildForPickerItems` is the STATIC
 * grouped list (`finances.forPickerOptions`), used wherever there's no single
 * transaction to rank for — `ManualTransactionModal` (creating a new txn) and
 * the multi-select bulk bar. Budget-less refs are demoted to a trailing
 * "· No budget yet" subsection per group (the owner's complaint was
 * PLACEMENT — an unranked flood of task-shaped budget-less projects — not
 * that summon-candidates shouldn't be offered at all).
 *
 * `buildRankedForPickerItems` is the PER-ROW-transaction list, built from
 * `reconcileSuggest.rankForPicker`'s payload: a "Suggested" section (tiers
 * 1-3, each with its `reason` as a sublabel) ahead of the same grouped/
 * demoted tail (tier 4). In search mode it's a flat match-ranked list
 * instead (see `rankForPicker`'s module doc).
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { PickerItem } from "./ReconcileList";

export type ForPickerOptions = FunctionReturnType<typeof api.finances.forPickerOptions>;
export type RankForPickerResult = FunctionReturnType<typeof api.reconcileSuggest.rankForPicker>;
type RankedRow = RankForPickerResult["rows"][number];

const SUMMON_PREFIX = "summon:";

/** A group's items split into "has a budget" (shown under the plain group
 *  header) and "budget-less" (demoted to a trailing "· No budget yet"
 *  subsection) — the placement fix both `buildForPickerItems` and
 *  `buildRankedForPickerItems`'s tier-4 tail apply identically. */
function refGroupSections<T extends { label: string }>(
  groupLabel: string,
  refs: T[],
  getValue: (ref: T) => string,
  hasBudget: (ref: T) => boolean,
): PickerItem[] {
  if (refs.length === 0) return [];
  const budgeted = refs.filter(hasBudget);
  const budgetless = refs.filter((r) => !hasBudget(r));
  const items: PickerItem[] = [];
  if (budgeted.length > 0) {
    items.push({ value: `__grp_${groupLabel}`, label: groupLabel, header: true });
    items.push(...budgeted.map((r) => ({ value: getValue(r), label: r.label })));
  }
  if (budgetless.length > 0) {
    const noBudgetLabel = `${groupLabel} · No budget yet`;
    items.push({ value: `__grp_${noBudgetLabel}`, label: noBudgetLabel, header: true });
    items.push(...budgetless.map((r) => ({ value: getValue(r), label: r.label })));
  }
  return items;
}

/** Build the "For" picker's flattened option list from `forPickerOptions`,
 *  with a leading "None" clear row. Recurring budgets are grouped by level
 *  (Chapter / Central) — the same split the old Budget picker offered.
 *  Budget-less events/projects trail their group in a "No budget yet"
 *  subsection instead of interleaving unranked among the budgeted ones. */
export function buildForPickerItems(options: ForPickerOptions): PickerItem[] {
  const chapterRecurring = options.recurring.filter((r) => r.level === "chapter");
  const centralRecurring = options.recurring.filter((r) => r.level === "central");

  return [
    { value: "", label: "None" },
    ...refGroupSections(
      "Events",
      options.events,
      (e) => e.budgetId ?? `${SUMMON_PREFIX}event:${e.eventId}`,
      (e) => e.budgetId != null,
    ),
    ...refGroupSections(
      "Projects",
      options.projects,
      (p) => p.budgetId ?? `${SUMMON_PREFIX}project:${p.projectId}`,
      (p) => p.budgetId != null,
    ),
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

/** A ranked row's picker VALUE — a real `budgetId`, or a summon-candidate
 *  encoding for a budget-less event/project (recurring rows always carry a
 *  real `budgetId` — the ref IS the budget). */
function rankedRowValue(row: RankedRow): string {
  return row.budgetId ?? `${SUMMON_PREFIX}${row.refKind}:${row.refId}`;
}

function rankedGroupLabel(row: RankedRow): string {
  if (row.refKind === "event") return "Events";
  if (row.refKind === "project") return "Projects";
  return row.level === "central" ? "Recurring · Central" : "Recurring · Chapter";
}

/**
 * Build the "For" picker's option list from `reconcileSuggest.rankForPicker`
 * — the PER-TRANSACTION ranked view (Reconcile grid rows only; there's no
 * single txn to rank for in the bulk bar or the "add transaction" modal, so
 * they stay on `buildForPickerItems`).
 *
 * `ranked.searching` (a non-empty `search` arg was sent) renders a FLAT
 * match-ranked list — no "None" row, no section headers; the match-quality
 * order IS the point. Otherwise: a "Suggested" section (tiers 1-3, `reason`
 * as each row's sublabel) ahead of the standard grouped tier-4 tail, with
 * budget-less refs demoted to their group's "No budget yet" subsection —
 * `rankForPicker` already returns tier 4 pre-sorted contiguously by group +
 * budget-having, so a single header-on-change pass reproduces the same
 * grouping `buildForPickerItems` builds from scratch.
 */
export function buildRankedForPickerItems(ranked: RankForPickerResult): PickerItem[] {
  if (ranked.searching) {
    return ranked.rows.map((row) => ({
      value: rankedRowValue(row),
      label: row.label,
      reason: row.reason ?? undefined,
    }));
  }

  const items: PickerItem[] = [{ value: "", label: "None" }];

  const suggested = ranked.rows.filter((r) => r.tier !== 4);
  if (suggested.length > 0) {
    items.push({ value: "__grp_suggested", label: "Suggested", header: true });
    for (const row of suggested) {
      items.push({ value: rankedRowValue(row), label: row.label, reason: row.reason ?? undefined });
    }
  }

  let lastHeader: string | null = null;
  for (const row of ranked.rows) {
    if (row.tier !== 4) continue;
    const groupLabel = rankedGroupLabel(row);
    const header = row.hasBudget ? groupLabel : `${groupLabel} · No budget yet`;
    if (header !== lastHeader) {
      items.push({ value: `__grp_${header}`, label: header, header: true });
      lastHeader = header;
    }
    items.push({ value: rankedRowValue(row), label: row.label });
  }

  return items;
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
