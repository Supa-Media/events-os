/**
 * RECONCILE — the bookkeeper's inline-editable grid for coding & clearing charges.
 *
 * A single spreadsheet-style table (the `people.tsx` grid pattern): every charge
 * is a row whose Category / Budget / Status edit inline (dropdowns, commit per
 * row) and whose receipt uploads inline. Coding = Category + Budget only — the
 * fund is hidden and defaulted to the General Fund server-side.
 *
 * Filtering is SERVER-SIDE via `listReconcile({ filter })`, so each pill is
 * truthful across ALL of the chapter's charges (not just one page) and carries a
 * live count. Multi-select drives a bulk bar (set Category / set Budget / mark
 * Reconciled).
 *
 * Reconciliation is finance-manager/bookkeeper territory, so this screen is gated
 * admin-or-lead in-screen (mirroring the finances nav gate); the real, finer
 * finance-role check is enforced server-side on every mutation.
 */
import { useMemo, useState } from "react";
import { View, Text } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { BUDGET_TYPE_LABELS, type BudgetType } from "@events-os/shared";
import {
  Button,
  EmptyState,
  FULL_WIDTH,
  Narrow,
  Pill,
  Screen,
  ToastView,
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import {
  ReconcileList,
  type PickerItem,
} from "../../../components/finance/reconcile/ReconcileList";
import {
  FILTERS,
  type FilterKey,
} from "../../../components/finance/reconcile/helpers";
import { BulkBar } from "../../../components/finance/reconcile/BulkBar";

/** Human name for a budget in the picker (its label, else its type word). */
function budgetName(b: {
  label: string | null;
  type: BudgetType | null;
}): string {
  return b.label?.trim() || (b.type ? BUDGET_TYPE_LABELS[b.type] : "Budget");
}

export default function ReconcileScreen() {
  const org = useQuery(api.org.nav);
  const [filter, setFilter] = useState<FilterKey>("needs_budget");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reconcile = useQuery(api.finances.listReconcile, { filter });
  // All chapter categories (no fund filter — coding is category + budget only).
  const categories = useQuery(api.finances.listCategories, {}) ?? [];
  const budgets = useQuery(api.finances.listBudgets) ?? [];

  const bulkCategorize = useMutation(api.finances.bulkCategorize);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const { run, toast, dismiss } = useActionRunner();

  const rows = reconcile?.rows ?? [];
  const counts = reconcile?.counts;

  // Category picker items — "None" (clears) + every chapter category.
  const categoryItems = useMemo<PickerItem[]>(
    () => [
      { value: "", label: "None" },
      ...categories.map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories],
  );

  // Budget picker items — "None" + budgets grouped under Chapter / Central.
  const budgetItems = useMemo<PickerItem[]>(() => {
    const chapter = budgets.filter((b) => b.level === "chapter");
    const central = budgets.filter((b) => b.level === "central");
    return [
      { value: "", label: "None" },
      ...(chapter.length > 0
        ? [{ value: "__grp_chapter", label: "Chapter", header: true }]
        : []),
      ...chapter.map((b) => ({ value: b.id, label: budgetName(b) })),
      ...(central.length > 0
        ? [{ value: "__grp_central", label: "Central", header: true }]
        : []),
      ...central.map((b) => ({ value: b.id, label: budgetName(b) })),
    ];
  }, [budgets]);

  // Selection lives in a Set keyed by txn id; prune ids no longer in view.
  const visibleIds = useMemo(
    () => new Set<string>(rows.map((r) => r.id)),
    [rows],
  );
  const selectedInView = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const allSelected = rows.length > 0 && rows.every((r) => prev.has(r.id));
      const next = new Set(prev);
      if (allSelected) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  }
  const clearSelection = () => setSelected(new Set());

  // In-screen guard: reconcile is admin-or-lead (finance-manager/bookkeeper).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Reconcile is restricted"
            message="Only chapter admins and leads can reconcile transactions."
          />
        </Narrow>
      </Screen>
    );
  }
  if (org === undefined) return <Screen loading />;

  const loading = reconcile === undefined;
  // "N to clear" — everything not yet reconciled (the actionable backlog).
  const toClear = counts ? counts.all - counts.ready : 0;

  const bulkIds = selectedInView as Id<"transactions">[];

  async function bulkSetCategory(categoryId: string | null) {
    await run(
      () =>
        bulkCategorize({
          transactionIds: bulkIds,
          categoryId: categoryId as Id<"budgetCategories"> | null,
        }),
      { errorTitle: "Couldn't set category" },
    );
  }
  async function bulkSetBudget(budgetId: string | null) {
    await run(
      () =>
        bulkCategorize({
          transactionIds: bulkIds,
          budgetId: budgetId as Id<"budgets"> | null,
        }),
      { errorTitle: "Couldn't set budget" },
    );
  }
  async function bulkMarkReconciled() {
    await run(
      // No bulk-status mutation: a loop over the idempotent per-row setter is fine.
      () =>
        Promise.all(
          bulkIds.map((id) =>
            setStatus({ transactionId: id, status: "reconciled" }),
          ),
        ),
      { errorTitle: "Couldn't reconcile" },
    );
    clearSelection();
  }

  return (
    <>
      <Screen maxWidth={FULL_WIDTH}>
        <Narrow>
          {/* Header — title + "N to clear". */}
          <View className="mb-1 flex-row items-baseline gap-2">
            <Text className="font-display text-2xl text-ink">Reconcile</Text>
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {toClear} to clear
            </Text>
          </View>
          <Text className="mb-4 text-sm text-muted">
            Code each charge to a category and budget, confirm the receipt, and
            mark it reconciled. Edit any cell inline.
          </Text>

          {/* Server-side filter pills, each with its live count. */}
          <View className="mb-4 flex-row flex-wrap gap-2">
            {FILTERS.map((f) => (
              <Pill
                key={f.key}
                label={counts ? `${f.label}  ${counts[f.key]}` : f.label}
                selected={filter === f.key}
                onPress={() => setFilter(f.key)}
              />
            ))}
          </View>
        </Narrow>

        {/* Bulk action bar (multi-select). */}
        {selectedInView.length > 0 ? (
          <BulkBar
            count={selectedInView.length}
            categoryItems={categoryItems}
            budgetItems={budgetItems}
            onSetCategory={bulkSetCategory}
            onSetBudget={bulkSetBudget}
            onMarkReconciled={bulkMarkReconciled}
            onClear={clearSelection}
          />
        ) : null}

        {loading ? (
          <View className="py-14">
            <EmptyState title="Loading transactions…" />
          </View>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="check-circle"
            title="Nothing in this view"
            message="Try another filter — new charges land here to code and reconcile."
          />
        ) : (
          <ReconcileList
            rows={rows}
            categoryItems={categoryItems}
            budgetItems={budgetItems}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
          />
        )}
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
