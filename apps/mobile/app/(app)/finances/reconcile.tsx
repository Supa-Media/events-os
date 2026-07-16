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
 * Reconciliation is finance-manager/bookkeeper territory. Gated on the caller's
 * REAL finance seats (`financeRoles.mySeats`, WP-0.2) — same fix as the Cards
 * and Reimbursements tabs, and for the same reason: the queries this grid reads
 * (`listReconcile` / `listCategories` / `listBudgets`) require at least the
 * viewer finance role and THROW for anyone without one, and Convex queries fire
 * as soon as a component mounts regardless of any later conditional return in
 * its render. The former admin-or-lead org-tier gate didn't stop that — a
 * tier=admin/lead caller with no `financeRoles` grant (or any no-seat member
 * who deep-links straight to `/finances/reconcile`) still mounted this screen's
 * hooks and crashed on the throw (the [hotfix] crash class). `ReconcileGrid` is
 * the FinanceBoundary-wrapped inner component so a role throw degrades to a
 * friendly empty state instead of the root error boundary.
 */
import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { BUDGET_TYPE_LABELS, type BudgetType } from "@events-os/shared";
import {
  Button,
  EmptyState,
  FULL_WIDTH,
  Icon,
  Narrow,
  Pill,
  Screen,
  ToastView,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import {
  ReconcileList,
  type PickerItem,
} from "../../../components/finance/reconcile/ReconcileList";
import {
  FILTERS,
  filterReconcileRows,
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

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Reconcile is restricted"
      message="Only finance managers and bookkeepers can reconcile transactions."
    />
  );
}

/** Real gate: the caller's actual finance seats. No seat → an empty state,
 *  never `ReconcileGrid` (whose queries throw for a no-role caller). */
export default function ReconcileScreen() {
  const seats = useQuery(api.financeRoles.mySeats, {});

  if (seats === undefined) return <Screen loading />;

  if (seats.length === 0) {
    return (
      <Screen>
        <Narrow>
          <NoFinanceAccess />
        </Narrow>
      </Screen>
    );
  }

  return (
    <FinanceBoundary fallback={<NoFinanceAccess />}>
      <ReconcileGrid />
    </FinanceBoundary>
  );
}

function ReconcileGrid() {
  const [filter, setFilter] = useState<FilterKey>("needs_budget");
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // WP-2.1: central-seat holders can switch this grid to reconcile CENTRAL-owned
  // txns. `mySeats` resolves their real seats; a central seat unlocks the toggle.
  const seats = useQuery(api.financeRoles.mySeats, {}) ?? [];
  const hasCentralSeat = seats.some((s) => s.scope === "central");
  const [scope, setScope] = useState<"chapter" | "central">("chapter");
  const centralScope = scope === "central" && hasCentralSeat;

  const reconcile = useQuery(
    api.finances.listReconcile,
    centralScope ? { filter, scope: "central" as const } : { filter },
  );
  // All chapter categories (no fund filter — coding is category + budget only).
  const categories = useQuery(api.finances.listCategories, {}) ?? [];
  const budgets = useQuery(api.finances.listBudgets) ?? [];
  // Link picker sources — "what was it for": an event or a project.
  const events = useQuery(api.events.list, { scope: "all" }) ?? [];
  const projects = useQuery(api.projects.list) ?? [];

  const bulkCategorize = useMutation(api.finances.bulkCategorize);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const { run, toast, dismiss } = useActionRunner();

  const rows = reconcile?.rows ?? [];
  const counts = reconcile?.counts;

  // Search narrows the active pill's already-loaded rows, client-side.
  const displayed = useMemo(
    () => filterReconcileRows(rows, query),
    [rows, query],
  );
  const searching = query.trim().length > 0;

  // Category picker items — "None" (clears) + every chapter category.
  const categoryItems = useMemo<PickerItem[]>(
    () => [
      { value: "", label: "None" },
      ...categories.map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories],
  );

  // Budget picker items — "None" + budgets grouped under Chapter / Central. In
  // central scope (WP-2.1) only central budgets are offered — a central-owned
  // txn can't be attributed to a chapter budget (the backend rejects it).
  const budgetItems = useMemo<PickerItem[]>(() => {
    const central = budgets.filter((b) => b.level === "central");
    if (centralScope) {
      return [
        { value: "", label: "None" },
        ...central.map((b) => ({ value: b.id, label: budgetName(b) })),
      ];
    }
    const chapter = budgets.filter((b) => b.level === "chapter");
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
  }, [budgets, centralScope]);

  // Link picker items — "None" + events + projects, each under its own header.
  // Values are composite ("event:<id>" / "project:<id>") so one dropdown can
  // pick either kind of "what was it for" link.
  const linkItems = useMemo<PickerItem[]>(
    () => [
      { value: "", label: "None" },
      ...(events.length > 0
        ? [{ value: "__grp_events", label: "Events", header: true }]
        : []),
      ...events.map((e) => ({ value: `event:${e._id}`, label: e.name })),
      ...(projects.length > 0
        ? [{ value: "__grp_projects", label: "Projects", header: true }]
        : []),
      ...projects.map((p) => ({ value: `project:${p._id}`, label: p.name })),
    ],
    [events, projects],
  );

  // Selection lives in a Set keyed by txn id; "in view" = the searched set, so
  // bulk actions only ever touch the rows actually on screen.
  const visibleIds = useMemo(
    () => new Set<string>(displayed.map((r) => r.id)),
    [displayed],
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
      const allSelected =
        displayed.length > 0 && displayed.every((r) => prev.has(r.id));
      const next = new Set(prev);
      if (allSelected) displayed.forEach((r) => next.delete(r.id));
      else displayed.forEach((r) => next.add(r.id));
      return next;
    });
  }
  const clearSelection = () => setSelected(new Set());

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
          {/* Header — title + "N to clear" (or the searched result count). */}
          <View className="mb-1 flex-row items-baseline gap-2">
            <Text className="font-display text-2xl text-ink">Reconcile</Text>
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {searching
                ? `${displayed.length} of ${rows.length}`
                : `${toClear} to clear`}
            </Text>
          </View>

          {/* Scope toggle — central-seat holders switch between reconciling
              their chapter's money and CENTRAL-owned money (WP-2.1). */}
          {hasCentralSeat ? (
            <View className="mb-3 flex-row items-center gap-2">
              {(["chapter", "central"] as const).map((s) => (
                <Pill
                  key={s}
                  label={s === "chapter" ? "My chapter" : "Central"}
                  selected={scope === s}
                  onPress={() => {
                    setScope(s);
                    clearSelection();
                  }}
                />
              ))}
            </View>
          ) : null}
          <Text className="mb-4 text-sm text-muted">
            Code each charge to a category and budget, confirm the receipt, and
            mark it reconciled. Edit any cell inline.
          </Text>

          {/* Search — narrows the active pill's rows (merchant, cardholder,
              card last-4, amount) client-side. */}
          <View
            className={`mb-3 flex-row items-center rounded-md border bg-raised px-3 ${
              searchFocused ? "border-accent" : "border-border-strong"
            }`}
          >
            <Icon name="search" size={16} color={colors.faint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search merchant, cardholder, card, amount…"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              className="flex-1 px-2 py-2.5 text-base text-ink"
            />
            {query.length > 0 ? (
              <Pressable
                onPress={() => setQuery("")}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                className="rounded p-1 active:opacity-70"
              >
                <Icon name="x" size={16} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>

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
            hideCategory={centralScope}
          />
        ) : null}

        {loading ? (
          <View className="py-14">
            <EmptyState title="Loading transactions…" />
          </View>
        ) : displayed.length === 0 ? (
          searching ? (
            <EmptyState
              icon="search"
              title="No matches"
              message={`No charges in this view match “${query.trim()}”.`}
            />
          ) : (
            <EmptyState
              icon="check-circle"
              title="Nothing in this view"
              message="Try another filter — new charges land here to code and reconcile."
            />
          )
        ) : (
          <ReconcileList
            rows={displayed}
            categoryItems={categoryItems}
            budgetItems={budgetItems}
            linkItems={linkItems}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            centralScope={centralScope}
          />
        )}
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
