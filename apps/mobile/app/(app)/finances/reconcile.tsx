/**
 * RECONCILE — the bookkeeper's inline-editable grid for coding & clearing charges.
 *
 * A single spreadsheet-style table (the `people.tsx` grid pattern): every charge
 * is a row whose Category / For / Status edit inline (dropdowns, commit per
 * row) and whose receipt uploads inline. Coding = Category + For only — the
 * fund is hidden and defaulted to the General Fund server-side.
 *
 * The "For" picker (WP-U: one home per dollar) replaces the old separate
 * Budget + Link pickers with ONE picker, grouped Events / Projects / Recurring
 * — built from `finances.forPickerOptions` (see `forPicker.ts`). WP-wave4
 * (item 5, owner addendum 2026-07-17): only a ref with an APPROVED budget is
 * ever offered — `forPickerOptions` filters server-side
 * (`isAttributableBudget`), so a picked value is always a real `budgetId`
 * already; the old "summon a $0 budget on pick" flow is retired.
 *
 * Filtering is SERVER-SIDE via `listReconcile({ filter })`, so each pill is
 * truthful across ALL of the chapter's charges (not just one page) and carries a
 * live count. Multi-select drives a bulk bar (set Category / set For / mark
 * Reconciled).
 *
 * Reconciliation is finance-manager/bookkeeper territory. Gated on the caller's
 * REAL finance seats (`financeRoles.mySeats`, WP-0.2) — same fix as the Cards
 * and Reimbursements tabs, and for the same reason: the queries this grid reads
 * (`listReconcile` / `listCategories` / `forPickerOptions`) require at least the
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Button,
  EmptyState,
  FULL_WIDTH,
  Icon,
  InfoTooltip,
  Narrow,
  Pill,
  Screen,
  ToastView,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { useChapterContext } from "../../../lib/ChapterContext";
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
import { buildForPickerItems } from "../../../components/finance/reconcile/forPicker";

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

const FILTER_KEYS = new Set<FilterKey>([
  "all",
  "needs_budget",
  "missing_receipt",
  "uncategorized",
  "ready",
]);

function ReconcileGrid() {
  // WP-dashboard-drill: optional deep-link params (e.g. from the central
  // dashboard's "Reconcile centrally →" affordance) — override the initial
  // state only; the pills/toggle remain fully interactive afterward. Unknown
  // or malformed values fall back to the existing defaults, never throw.
  const params = useLocalSearchParams<{ filter?: string; scope?: string }>();
  const router = useRouter();
  const initialFilter: FilterKey =
    params.filter && FILTER_KEYS.has(params.filter as FilterKey)
      ? (params.filter as FilterKey)
      : "needs_budget";

  const [filter, setFilter] = useState<FilterKey>(initialFilter);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // WP-2.1: central-seat holders can switch this grid to reconcile CENTRAL-owned
  // txns. `mySeats` resolves their real seats; a central seat unlocks the toggle.
  const seats = useQuery(api.financeRoles.mySeats, {}) ?? [];
  const hasCentralSeat = seats.some((s) => s.scope === "central");
  const [scope, setScope] = useState<"chapter" | "central">(
    params.scope === "central" ? "central" : "chapter",
  );
  // A non-central caller passing `?scope=central` harmlessly falls back to
  // chapter scope here, same as the toggle already does — no new authz
  // surface (the server still gates `scope:"central"` on central reach).
  const centralScope = scope === "central" && hasCentralSeat;
  // R1b: "Mark personal" (cards.flagPersonalCharge's manager path) is a
  // manager-only action — a bookkeeper has full Reconcile access but not this.
  // A caller has at most one chapter seat (their home chapter, MVP — see
  // `requireChapterId`), so this is unambiguous. `ReconcileList` ALSO widens
  // the same button to a cardholder's OWN row (founder feedback review) via
  // `reconcile.viewerPersonId` below — that's the other half of
  // `flagPersonalCharge`'s server-side OR-gate, unrelated to this flag.
  const isManager = seats.some((s) => s.scope === "chapter" && s.role === "manager");

  // WP-dashboard-drill Phase 2: a central caller PEEKING into a chapter that
  // isn't their own home chapter — `listReconcile`'s `chapterId` arg (added
  // by #228) reads THAT chapter's queue, server-side re-verified against
  // central reach exactly like `dashboardChapter`'s own drill-down. Peek is
  // READ-ONLY everywhere else in the app (see `ChapterContext`'s module doc),
  // and the reconcile WRITE mutations `ReconcileList` calls
  // (`categorizeTransaction`/`setStatus`/etc.) are NOT peek-aware —
  // `requireReconcileTxn` still scopes every write to the caller's own home
  // chapter, so it safely rejects (`NOT_FOUND`, never silently misattributes)
  // an attempt to edit a peeked chapter's row. The bulk bar below is hidden
  // in that state to avoid a confusing failed-write toast; single-row inline
  // edits in `ReconcileList` aren't (that file is unmodified here) — a
  // deliberate, minimal read-only affordance rather than a full write-through
  // peek mode, which is its own product decision.
  const { context } = useChapterContext();
  const peekedChapterId = context?.kind === "peek" ? context.chapterId : undefined;
  const viewingPeekedChapter = peekedChapterId != null && !centralScope;

  const reconcile = useQuery(
    api.finances.listReconcile,
    centralScope
      ? { filter, scope: "central" as const }
      : peekedChapterId
        ? { filter, chapterId: peekedChapterId }
        : { filter },
  );
  // The Chase-receipts destination, carrying this grid's CURRENT scope as
  // route params — mirrors the args object above (minus `filter`, which
  // `receipt-chase.tsx` has no use for) so `receiptChase` resolves the exact
  // same bucket `listReconcile` just counted for the missing_receipt pill.
  const chaseHref = centralScope
    ? "/finances/receipt-chase?scope=central"
    : peekedChapterId
      ? `/finances/receipt-chase?chapterId=${peekedChapterId}`
      : "/finances/receipt-chase";
  // All chapter categories (no fund filter — coding is category + For only).
  const categories = useQuery(api.finances.listCategories, {}) ?? [];
  // The "For" picker's option groups (WP-U) — events/projects + recurring
  // budgets by level, every row carrying a real, APPROVED budget (item 5).
  const forOptions = useQuery(api.finances.forPickerOptions, {});

  const bulkCategorize = useMutation(api.finances.bulkCategorize);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const reassignTransactions = useMutation(api.finances.reassignTransactions);
  const { run, toast, dismiss } = useActionRunner();

  // WP-2.2: the chapters a central caller may reassign money to/from. Only
  // mounted for central-seat holders (the query is central-gated and throws
  // otherwise) — chapter-only reconcilers skip it.
  const reassignChapters = useQuery(
    api.finances.reassignTargets,
    hasCentralSeat ? {} : "skip",
  );

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

  // "For" picker items (WP-U) — grouped Events / Projects / Recurring. In
  // central scope (WP-2.1) only Recurring · Central budgets are offered — a
  // central-owned txn can't attribute to an event/project or a chapter budget
  // (the backend rejects it; those are chapter-only).
  const forItems = useMemo<PickerItem[]>(() => {
    if (!forOptions) return [{ value: "", label: "None" }];
    if (centralScope) {
      const central = forOptions.recurring.filter((r) => r.level === "central");
      return [
        { value: "", label: "None" },
        ...central.map((r) => ({ value: r.budgetId, label: r.label })),
      ];
    }
    return buildForPickerItems(forOptions);
  }, [forOptions, centralScope]);

  // Reassign targets — "Central" + every active chapter (WP-2.2). Only built for
  // central-seat holders; `undefined` hides the "Reassign to" action entirely.
  const reassignItems = useMemo<PickerItem[] | undefined>(() => {
    if (!hasCentralSeat) return undefined;
    return [
      { value: "central", label: "Central" },
      ...(reassignChapters ?? []).map((c) => ({ value: c.id, label: c.name })),
    ];
  }, [hasCentralSeat, reassignChapters]);

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
  async function bulkSetFor(value: string | null) {
    await run(
      () =>
        bulkCategorize({
          transactionIds: bulkIds,
          budgetId: value ? (value as Id<"budgets">) : null,
        }),
      { errorTitle: "Couldn't set budget" },
    );
  }
  async function bulkReassign(target: string | null) {
    if (!target) return;
    await run(
      () =>
        reassignTransactions({
          transactionIds: bulkIds,
          target:
            target === "central"
              ? ("central" as const)
              : (target as Id<"chapters">),
        }),
      { errorTitle: "Couldn't reassign" },
    );
    clearSelection();
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
            Code each charge to a category and what it was for, confirm the
            receipt, and mark it reconciled. Edit any cell inline.
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

          {/* Server-side filter pills, each with its live count — plus the
              jump to the by-cardholder Chase receipts list (who still owes a
              receipt, biggest first) whenever any receipt is outstanding.
              `chaseHref` carries the grid's CURRENT scope (central / peeked
              chapter / the caller's own chapter) through as route params —
              `receiptChase` takes the same `scope`/`chapterId` args as
              `listReconcile`, so the list this button opens always reads the
              SAME bucket the pill's count just came from. */}
          <View className="mb-4 flex-row flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <Pill
                key={f.key}
                label={counts ? `${f.label}  ${counts[f.key]}` : f.label}
                selected={filter === f.key}
                onPress={() => setFilter(f.key)}
              />
            ))}
            <InfoTooltip
              text="Needs budget: categorized but no budget linked. Missing receipt: no receipt uploaded. Uncategorized: no category assigned. Ready: receipt + category + budget all present."
              size={14}
            />
            {counts && counts.missing_receipt > 0 ? (
              <Button
                title="Chase receipts"
                variant="ghost"
                size="sm"
                icon="bell"
                onPress={() => router.navigate(chaseHref as never)}
              />
            ) : null}
          </View>
        </Narrow>

        {/* Bulk action bar (multi-select) — hidden while viewing a peeked
            chapter's queue (see the `viewingPeekedChapter` doc comment
            above): the bulk mutations would safely reject every row anyway,
            so surfacing the bar here would just invite a failed-write toast. */}
        {selectedInView.length > 0 && !viewingPeekedChapter ? (
          <BulkBar
            count={selectedInView.length}
            categoryItems={categoryItems}
            forItems={forItems}
            onSetCategory={bulkSetCategory}
            onSetFor={bulkSetFor}
            onMarkReconciled={bulkMarkReconciled}
            onClear={clearSelection}
            hideCategory={centralScope}
            reassignItems={reassignItems}
            onReassign={hasCentralSeat ? bulkReassign : undefined}
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
            forItems={forItems}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            centralScope={centralScope}
            isManager={isManager}
            viewerPersonId={reconcile?.viewerPersonId ?? null}
          />
        )}
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
