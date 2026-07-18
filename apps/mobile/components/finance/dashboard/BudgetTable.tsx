/**
 * DASH-2 dense budget table — replaces `ChapterView`'s old always-open
 * `ProjectBudgetCard`/`RecurringBudgetCard` list with ~34px rows: a status
 * dot, name, a slim `Meter`, $spent/$cap, %, and a chevron. Used twice by
 * `ChapterView` — once for "Events & projects", once (as a collapsible
 * "Recurring buckets ▾" group) for the recurring cards — "the same row
 * treatment" per the brief.
 *
 * Row behavior:
 *  - Awaiting-approval rows (`approvalStatus === "submitted"`) PIN to the
 *    top (see `rowOrdering.ts`) with an amber stripe/tint, "$X requested"
 *    phrasing (reusing `awaitingApprovalZeroCapDisplay`'s same-cards logic
 *    the old `ProjectBudgetCard` used), and inline Approve/Request-changes
 *    (`BudgetApprovalActions`) — hidden during a central drill-down, same
 *    gate every other write action on this dashboard uses.
 *  - Tapping the CHEVRON expands the row in place to show its category
 *    mini-bars (today always rendered open; folded behind the chevron now).
 *  - Tapping the REST of the row opens the budget for editing (unchanged
 *    from the old cards' `onPress`) — hidden during a drill-down.
 *  - Beyond `foldAfter` non-pinned rows, a "Show N more ▾" toggle reveals
 *    the rest.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { BudgetApprovalStatus, BudgetRefKind } from "@events-os/shared";
import { EmptyState, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { Chip, MiniBar, Money } from "./parts";
import { Meter, MeterDot, MeterPct, OverChip } from "./Meter";
import { BudgetApprovalActions } from "./BudgetApprovalActions";
import { awaitingApprovalZeroCapDisplay } from "./awaitingApproval";
import { orderRows } from "./rowOrdering";
import { TransactionList, type DrilldownTxn } from "./TransactionList";

/**
 * The `{year, month?}` (or wider) window a category→transactions drill-down
 * requests — see `dashboardCharts.budgetTransactions`'s own doc for exactly
 * what each field means. `rangeNote` (review fix, finding #1) is a small
 * "this quarter"/"this year" label shown in the drilled-down list's header
 * when this period is WIDER than the dashboard's own selected month, so it's
 * clear why a row from outside the visible month bar shows up.
 */
export type DrilldownPeriod = {
  year: number;
  month?: number;
  quarter?: number;
  rangeNote?: string;
};

export type BudgetTableRow = {
  id: Id<"budgets">;
  name: string;
  meta?: string | null;
  spentCents: number;
  budgetCents: number;
  pct: number;
  categories?: {
    name: string;
    spentCents: number;
    barPct: number;
  }[];
  approvalStatus: BudgetApprovalStatus;
  approvedCents: number | null;
  requestedCents: number;
  reviewNote: string | null;
  /** DASH-3 additive: a small chip rendered after the name (e.g. "chapter" /
   *  "tag") for a synthetic rollup row that isn't a real budget. Absent for
   *  every existing `ChapterView` row — no visual change there. */
  chip?: string;
  /** DASH-3 additive: overrides the trailing chevron's default "toggle
   *  category expand" behavior with a navigation action (peek into a
   *  chapter / open the tag-drill sheet) — renders a plain right chevron
   *  instead of the up/down expand icon. Absent for every existing
   *  `ChapterView` row — no behavior change there. */
  onChevronPress?: () => void;
  /** DASH-3 additive: a rollup row (chapter/tag) isn't a real budget, so
   *  tapping the row body must not call the group's `onPressRow(id)` (which
   *  would try to open a nonexistent budget for editing) — true disables
   *  that tap target for this row only. Absent/false for every existing
   *  `ChapterView` row — no behavior change there. */
  disableRowPress?: boolean;
  /** DASH-2.1 UI additive: replaces the plain "$spent / $cap" cap label with
   *  a month-honest composite for a quarterly/yearly recurring row viewed in
   *  month mode (`ChapterView`'s `recurringRows` builder) — ignored while
   *  `showRequested` (an awaiting-approval row) is true, which keeps its own
   *  "$spent / $requested requested" phrasing unconditionally. */
  capLabelOverride?: string;
  /** Review fix (finding #1) additive: this ROW's own effective drill-down
   *  period, overriding the group-level `drilldownPeriod` prop below —
   *  `ChapterView`'s `recurringRows` builder sets this to the budget's
   *  cadence-widened period (quarter/year, see `recurringDrilldownPeriod`);
   *  absent for one-time rows, which stay on the group default. */
  drilldownPeriod?: DrilldownPeriod;
  /** WP-wave4 (item 4 — deep links), restored: a one-time budget's linked
   *  event/project (see `projectBudgetCard`/`centralBudgetCard` in
   *  `finances.ts`). `null`/absent for a recurring row, or a one-time budget
   *  with no live ref — no open affordance renders either way. */
  refKind?: BudgetRefKind | null;
  scopeRefId?: string | null;
};

const FOLD_AFTER = 5;

export function BudgetTableGroup({
  title,
  rows,
  isDrilldown,
  emptyTitle,
  emptyMessage,
  onPressRow,
  collapsible = false,
  foldAfter = FOLD_AFTER,
  drilldownPeriod,
  onOpenTransaction,
  onOpenRef,
}: {
  title: string;
  rows: BudgetTableRow[];
  isDrilldown: boolean;
  emptyTitle: string;
  emptyMessage: string;
  onPressRow?: (id: string) => void;
  /** The "Recurring buckets ▾" group can collapse entirely; the primary
   *  "Events & projects" panel can't (it's the page's main content). */
  collapsible?: boolean;
  /** DASH-3 additive: how many non-pinned rows show before "Show N more ▾" —
   *  defaults to `FOLD_AFTER` (5, ChapterView's existing behavior)
   *  unmodified. The central dashboard's single combined table (central
   *  budgets + chapter/tag rollup rows) passes a larger value so its
   *  rollup rows aren't folded away by default. */
  foldAfter?: number;
  /** DASH-2.1 UI additive: the DEFAULT drill-down period for rows that don't
   *  set their own `row.drilldownPeriod` (one-time "Events & projects" rows —
   *  see `BudgetTableRow.drilldownPeriod`'s own doc for the recurring-row
   *  override). A category row only offers its chevron when a period (row or
   *  group) AND `onOpenTransaction` are both set — `CentralView`'s rows never
   *  wire either today, so passing this there is harmless but inert. */
  drilldownPeriod?: DrilldownPeriod;
  /** DASH-2.1 UI additive: open the transaction detail modal for one row —
   *  bubbled up from a category's transaction list. The trailing `refKind`/
   *  `scopeRefId` mirror the OWNING row's own fields (WP-wave4 item 4 restore)
   *  so the modal can offer the same "Part of: <name> ›" link the row itself
   *  offers. */
  onOpenTransaction?: (
    txn: DrilldownTxn,
    budgetName: string,
    refKind: BudgetRefKind | null,
    scopeRefId: string | null,
  ) => void;
  /** WP-wave4 (item 4 — deep links), restored: open the row's linked event/
   *  project page. Absent on `CentralView` (see that file's own doc — a
   *  central one-time budget's ref can belong to ANY chapter, and the event/
   *  project detail screens are hard-scoped to the CALLER's own chapter via
   *  `requireOwned`, so there's no safe way to offer this link there without
   *  a central-reach bypass to that foundational primitive — flagged for the
   *  owner rather than invented, mirrors `ChapterContext`'s own precedent for
   *  peek). Wired by `ChapterView` only, and only outside a peeked drilldown.
   */
  onOpenRef?: (refKind: BudgetRefKind, scopeRefId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const { pinned, visible, hidden } = orderRows(rows, showMore, foldAfter);

  return (
    <View className="mt-4 overflow-hidden rounded-lg border border-border bg-raised shadow-card">
      <Pressable
        onPress={collapsible ? () => setOpen((o) => !o) : undefined}
        className="flex-row items-center justify-between border-b border-border bg-sunken px-3 py-2.5"
      >
        <View className="flex-row items-baseline gap-2">
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">{title}</Text>
          <Text className="text-2xs font-semibold text-faint">{rows.length}</Text>
        </View>
        {collapsible ? (
          <Icon name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.muted} />
        ) : null}
      </Pressable>

      {open ? (
        rows.length === 0 ? (
          <View className="p-3">
            <EmptyState title={emptyTitle} message={emptyMessage} />
          </View>
        ) : (
          <View>
            {pinned.map((r) => (
              <BudgetRow
                key={r.id}
                row={r}
                pinned
                isDrilldown={isDrilldown}
                expanded={expanded.has(r.id)}
                onToggleExpand={() => toggleExpanded(r.id)}
                onPressRow={onPressRow}
                drilldownPeriod={drilldownPeriod}
                onOpenTransaction={onOpenTransaction}
                onOpenRef={onOpenRef}
              />
            ))}
            {visible.map((r) => (
              <BudgetRow
                key={r.id}
                row={r}
                pinned={false}
                isDrilldown={isDrilldown}
                expanded={expanded.has(r.id)}
                onToggleExpand={() => toggleExpanded(r.id)}
                onPressRow={onPressRow}
                drilldownPeriod={drilldownPeriod}
                onOpenTransaction={onOpenTransaction}
                onOpenRef={onOpenRef}
              />
            ))}
            {hidden.length > 0 ? (
              <Pressable
                onPress={() => setShowMore(true)}
                className="flex-row items-center justify-center gap-1.5 border-t border-border py-2 web:hover:bg-sunken"
              >
                <Text className="text-xs font-semibold text-accent">
                  Show {hidden.length} more
                </Text>
                <Icon name="chevron-down" size={12} color={colors.accent} />
              </Pressable>
            ) : null}
          </View>
        )
      ) : null}
    </View>
  );
}

function BudgetRow({
  row,
  pinned,
  isDrilldown,
  expanded,
  onToggleExpand,
  onPressRow,
  drilldownPeriod,
  onOpenTransaction,
  onOpenRef,
}: {
  row: BudgetTableRow;
  pinned: boolean;
  isDrilldown: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onPressRow?: (id: string) => void;
  drilldownPeriod?: DrilldownPeriod;
  onOpenTransaction?: (
    txn: DrilldownTxn,
    budgetName: string,
    refKind: BudgetRefKind | null,
    scopeRefId: string | null,
  ) => void;
  onOpenRef?: (refKind: BudgetRefKind, scopeRefId: string) => void;
}) {
  const display = awaitingApprovalZeroCapDisplay({
    approvalStatus: row.approvalStatus,
    approvedCents: row.approvedCents,
    requestedCents: row.requestedCents,
    spentCents: row.spentCents,
    budgetCents: row.budgetCents,
    pct: row.pct,
    status: row.pct >= 80 ? "warn" : "ok",
  });
  // Pinned (submitted) rows always show "$spent / $requested requested" —
  // so the % next to it MUST be computed against that SAME requestedCents
  // denominator, never the server's `pct` (which is spent / effectiveCapCents,
  // i.e. the OLD approved cap for a resubmitted increase — see
  // `finances.ts#effectiveCapCents`). Using `display.pct` here would only be
  // correct for the zero-cap shape (`awaitingApprovalZeroCapDisplay` computes
  // the identical spent/requested ratio); for every other pinned row the two
  // diverge and the % would contradict the label right next to it.
  const showRequested = pinned || display.isAwaitingApproval;
  const pct = showRequested
    ? row.requestedCents > 0
      ? Math.round((row.spentCents / row.requestedCents) * 100)
      : 0
    : row.pct;
  const capLabel = showRequested
    ? `${formatCents(row.spentCents)} / ${formatCents(row.requestedCents)} requested`
    : (row.capLabelOverride ?? `${formatCents(row.spentCents)} / ${formatCents(row.budgetCents)}`);
  const hasCategories = row.categories && row.categories.length > 0;
  // WP-wave4 (item 4 — deep links), restored: only offer the link when the
  // CALLER wired `onOpenRef` (ChapterView, outside a peeked drilldown — see
  // that prop's own doc comment) AND the row actually carries a live ref.
  const openRef =
    onOpenRef && row.refKind && row.scopeRefId
      ? { refKind: row.refKind, scopeRefId: row.scopeRefId }
      : null;

  // The row's content EXCLUDING the trailing chevron — that chevron is a
  // SEPARATE sibling Pressable below (not nested inside this one). Nesting
  // two `accessibilityRole="button"` Pressables renders as `<button>` inside
  // `<button>` on web, which is invalid HTML and threw a hydration error
  // (caught live via the DASH-2 Playwright smoke pass) — this is why the
  // chevron sits OUTSIDE the row-tap target instead.
  const rowContent = (
    <View className="min-w-0 flex-1 flex-row items-center gap-2.5">
      <MeterDot pct={pct} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-1.5">
          <Text className="min-w-0 shrink text-xs font-semibold text-ink" numberOfLines={1}>
            {row.name}
          </Text>
          {row.chip ? <Chip label={row.chip} /> : null}
        </View>
        {row.meta ? (
          <Text className="text-2xs text-muted" numberOfLines={1}>
            {row.meta}
          </Text>
        ) : null}
      </View>
      <View style={{ width: 56 }}>
        <Meter pct={pct} size="sm" />
      </View>
      <Text
        className="text-2xs text-muted"
        style={{ fontVariant: ["tabular-nums"] }}
        numberOfLines={1}
      >
        {capLabel}
      </Text>
      {pct > 100 ? <OverChip pct={pct} /> : <MeterPct pct={pct} />}
    </View>
  );

  const rowInner = (
    <View
      className={`flex-row items-center gap-2.5 px-3 py-1.5 ${pinned ? "" : "border-b border-border"}`}
    >
      {onPressRow && !isDrilldown && !row.disableRowPress ? (
        <Pressable
          onPress={() => onPressRow(row.id)}
          accessibilityRole="button"
          className="min-w-0 flex-1 flex-row items-center web:hover:opacity-80"
        >
          {rowContent}
        </Pressable>
      ) : (
        rowContent
      )}
      {openRef ? (
        // WP-wave4 (item 4 — deep links), restored: a SEPARATE sibling
        // Pressable (same "no nested buttons" rule as the chevron below —
        // see that Pressable's own doc comment) so a row keeps its normal
        // "expand categories" chevron even when it's also ref-linked.
        <Pressable
          onPress={() => onOpenRef!(openRef.refKind, openRef.scopeRefId)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Open ${openRef.refKind}`}
        >
          <Icon name="external-link" size={13} color={colors.muted} />
        </Pressable>
      ) : null}
      <Pressable
        onPress={row.onChevronPress ?? onToggleExpand}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={row.onChevronPress ? "Open" : "Expand categories"}
      >
        <Icon
          name={row.onChevronPress ? "chevron-right" : expanded ? "chevron-up" : "chevron-down"}
          size={14}
          color={colors.muted}
        />
      </Pressable>
    </View>
  );

  return (
    <View className={pinned ? "border-l-4 border-warn bg-warn-bg/50" : ""}>
      {rowInner}

      {row.reviewNote && row.approvalStatus === "changes_requested" ? (
        <Text className="px-3 pb-1.5 text-2xs text-danger">"{row.reviewNote}"</Text>
      ) : null}

      {expanded && (hasCategories || openRef) ? (
        <View className="gap-2 border-b border-border bg-sunken/60 px-3 py-2.5">
          {openRef ? (
            <Pressable
              onPress={() => onOpenRef!(openRef.refKind, openRef.scopeRefId)}
              accessibilityRole="button"
              className="flex-row items-center gap-1 self-start active:opacity-70 web:hover:opacity-90"
            >
              <Text className="text-2xs font-semibold text-accent">
                Open {openRef.refKind}
              </Text>
              <Icon name="chevron-right" size={11} color={colors.accent} />
            </Pressable>
          ) : null}
          {hasCategories
            ? row.categories!.map((c) => (
                // Keyed by NAME, not array index: `spendBreakdownFor`
                // (finances.ts) re-sorts categories by spend on every write,
                // so an index key would let a DIFFERENT category inherit
                // this row's `open` state across a reorder (caught live:
                // editing a transaction's category out of the top bar left
                // the NEW top bar showing as expanded). Category names are
                // the server's own grouping key, so they're stable across
                // reorders.
                <CategoryRow
                  key={c.name}
                  budgetId={row.id}
                  budgetName={row.name}
                  refKind={row.refKind ?? null}
                  scopeRefId={row.scopeRefId ?? null}
                  category={c}
                  drilldownPeriod={row.drilldownPeriod ?? drilldownPeriod}
                  onOpenTransaction={onOpenTransaction}
                />
              ))
            : null}
        </View>
      ) : null}

      {pinned && !isDrilldown ? (
        <View className="border-b border-border px-3 pb-2 pl-8">
          <BudgetApprovalActions budgetId={row.id} status={row.approvalStatus} />
        </View>
      ) : null}
    </View>
  );
}

// ── Category row — DASH-2.1 UI's one-more-level drill-down: tapping a
// category mini-bar's OWN chevron expands a lazy `TransactionList` right
// below it (only mounted while open — "skip until expanded"). No chevron
// (plain mini-bar, unchanged from before this PR) when the caller didn't
// wire `drilldownPeriod`/`onOpenTransaction` (e.g. `CentralView`'s rows,
// which never carry either today). Review fix (finding #2): drills by the
// category's own NAME (`category.name` — the server's own grouping key for
// this bar, `finances.ts#spendBreakdownFor`) rather than a client-resolved
// id, so it can never miss a same-named category in a different fund — see
// `dashboardCharts.budgetTransactions`'s own doc for the matching semantics.
// This also means a category bar's drill-down works even while a central
// caller is PEEKING a chapter (previously disabled — the old id-resolution
// path could point at the WRONG chapter's category while peeking; a NAME
// can't, since `budgetTransactions` resolves it against the budget's own
// chapter server-side). ───────────────────────────────────────────────────
function CategoryRow({
  budgetId,
  budgetName,
  refKind,
  scopeRefId,
  category,
  drilldownPeriod,
  onOpenTransaction,
}: {
  budgetId: Id<"budgets">;
  budgetName: string;
  refKind: BudgetRefKind | null;
  scopeRefId: string | null;
  category: NonNullable<BudgetTableRow["categories"]>[number];
  drilldownPeriod?: DrilldownPeriod;
  onOpenTransaction?: (
    txn: DrilldownTxn,
    budgetName: string,
    refKind: BudgetRefKind | null,
    scopeRefId: string | null,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const drillable = drilldownPeriod != null && onOpenTransaction != null;

  return (
    <View className="gap-1">
      <Pressable
        onPress={drillable ? () => setOpen((o) => !o) : undefined}
        disabled={!drillable}
        accessibilityRole={drillable ? "button" : undefined}
        className="flex-row items-center justify-between"
      >
        <Text className="min-w-0 flex-1 text-2xs text-ink" numberOfLines={1}>
          {category.name}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <Money cents={category.spentCents} className="text-2xs text-muted" />
          {drillable ? (
            <Icon name={open ? "chevron-up" : "chevron-down"} size={11} color={colors.muted} />
          ) : null}
        </View>
      </Pressable>
      <MiniBar barPct={category.barPct} />
      {open && drillable ? (
        <TransactionList
          budgetId={budgetId}
          categoryName={category.name}
          year={drilldownPeriod!.year}
          month={drilldownPeriod!.month}
          quarter={drilldownPeriod!.quarter}
          rangeNote={drilldownPeriod!.rangeNote}
          onOpenTransaction={(txn) => onOpenTransaction!(txn, budgetName, refKind, scopeRefId)}
        />
      ) : null}
    </View>
  );
}
