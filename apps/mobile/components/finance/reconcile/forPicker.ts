/**
 * The "For" picker (WP-U: one home per dollar) — ONE picker replacing the old
 * separate Budget + Link columns/pickers, grouped Events / Projects /
 * Recurring. Shared between the Reconcile grid (`ReconcileList`/`BulkBar`)
 * and `ManualTransactionModal`, so the option-building logic never drifts
 * between the two surfaces.
 *
 * WP-wave4 (item 5, owner addendum 2026-07-17): "only approved budgets can
 * have charges attached" retired the old "summon a $0 budget on pick" flow —
 * a picker VALUE is now ALWAYS a real, `budgets` `Id` (never a summon-
 * candidate encoding). `finances.forPickerOptions` and
 * `reconcileSuggest.rankForPicker` both filter to attributable (approved)
 * budgets server-side (`isAttributableBudget`), so a budget-less or
 * not-yet-approved ref simply never appears here — its spend stays visible
 * another way: the dashboard's "Needs budget" bucket. `resolveForPickerValue`/
 * `isSummonValue`/`parseSummonValue`/the "No budget yet" trailing subsection
 * are gone along with it; a picker value can be used as a `budgetId` directly.
 *
 * RANKING (reduce-the-scroll fix): `buildForPickerItems` is the STATIC
 * grouped list (`finances.forPickerOptions`), used wherever there's no single
 * transaction to rank for — `ManualTransactionModal` (creating a new txn) and
 * the multi-select bulk bar.
 *
 * `buildRankedForPickerItems` is the PER-ROW-transaction list, built from
 * `reconcileSuggest.rankForPicker`'s payload: a "Suggested" section (tiers
 * 1-3, each with its `reason` as a sublabel) ahead of the same grouped tail
 * (tier 4). In search mode it's a flat match-ranked list instead (see
 * `rankForPicker`'s module doc).
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { PickerItem } from "./ReconcileList";

export type ForPickerOptions = FunctionReturnType<typeof api.finances.forPickerOptions>;
export type RankForPickerResult = FunctionReturnType<typeof api.reconcileSuggest.rankForPicker>;
type RankedRow = RankForPickerResult["rows"][number];

/** Build the "For" picker's flattened option list from `forPickerOptions`,
 *  with a leading "None" clear row. Recurring budgets are grouped by level
 *  (Chapter / Central) — the same split the old Budget picker offered. Every
 *  event/project row here always carries a real, approved budget (item 5) —
 *  a ref with none is simply absent from `options`. */
export function buildForPickerItems(options: ForPickerOptions): PickerItem[] {
  const chapterRecurring = options.recurring.filter((r) => r.level === "chapter");
  const centralRecurring = options.recurring.filter((r) => r.level === "central");

  return [
    { value: "", label: "None" },
    ...(options.events.length > 0
      ? [{ value: "__grp_Events", label: "Events", header: true }]
      : []),
    ...options.events.map((e) => ({ value: e.budgetId, label: e.label })),
    ...(options.projects.length > 0
      ? [{ value: "__grp_Projects", label: "Projects", header: true }]
      : []),
    ...options.projects.map((p) => ({ value: p.budgetId, label: p.label })),
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
 * as each row's sublabel) ahead of the standard grouped tier-4 tail —
 * `rankForPicker` already returns tier 4 pre-sorted contiguously by group, so
 * a single header-on-change pass reproduces the same grouping
 * `buildForPickerItems` builds from scratch.
 */
export function buildRankedForPickerItems(ranked: RankForPickerResult): PickerItem[] {
  if (ranked.searching) {
    return ranked.rows.map((row) => ({
      value: row.budgetId,
      label: row.label,
      reason: row.reason ?? undefined,
    }));
  }

  const items: PickerItem[] = [{ value: "", label: "None" }];

  const suggested = ranked.rows.filter((r) => r.tier !== 4);
  if (suggested.length > 0) {
    items.push({ value: "__grp_suggested", label: "Suggested", header: true });
    for (const row of suggested) {
      items.push({ value: row.budgetId, label: row.label, reason: row.reason ?? undefined });
    }
  }

  let lastHeader: string | null = null;
  for (const row of ranked.rows) {
    if (row.tier !== 4) continue;
    const header = rankedGroupLabel(row);
    if (header !== lastHeader) {
      items.push({ value: `__grp_${header}`, label: header, header: true });
      lastHeader = header;
    }
    items.push({ value: row.budgetId, label: row.label });
  }

  return items;
}
