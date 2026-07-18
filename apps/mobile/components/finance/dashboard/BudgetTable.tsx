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
import type { BudgetApprovalStatus } from "@events-os/shared";
import { EmptyState, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { MiniBar, Money } from "./parts";
import { Meter, MeterDot, MeterPct, OverChip } from "./Meter";
import { BudgetApprovalActions } from "./BudgetApprovalActions";
import { awaitingApprovalZeroCapDisplay } from "./awaitingApproval";
import { orderRows } from "./rowOrdering";

export type BudgetTableRow = {
  id: Id<"budgets">;
  name: string;
  meta?: string | null;
  spentCents: number;
  budgetCents: number;
  pct: number;
  categories?: { name: string; spentCents: number; barPct: number }[];
  approvalStatus: BudgetApprovalStatus;
  approvedCents: number | null;
  requestedCents: number;
  reviewNote: string | null;
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

  const { pinned, visible, hidden } = orderRows(rows, showMore, FOLD_AFTER);

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
}: {
  row: BudgetTableRow;
  pinned: boolean;
  isDrilldown: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onPressRow?: (id: string) => void;
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
    : `${formatCents(row.spentCents)} / ${formatCents(row.budgetCents)}`;
  const hasCategories = row.categories && row.categories.length > 0;

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
        <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
          {row.name}
        </Text>
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
      {onPressRow && !isDrilldown ? (
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
      <Pressable onPress={onToggleExpand} hitSlop={8} accessibilityRole="button" accessibilityLabel="Expand categories">
        <Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} color={colors.muted} />
      </Pressable>
    </View>
  );

  return (
    <View className={pinned ? "border-l-4 border-warn bg-warn-bg/50" : ""}>
      {rowInner}

      {row.reviewNote && row.approvalStatus === "changes_requested" ? (
        <Text className="px-3 pb-1.5 text-2xs text-danger">"{row.reviewNote}"</Text>
      ) : null}

      {expanded && hasCategories ? (
        <View className="gap-2 border-b border-border bg-sunken/60 px-3 py-2.5">
          {row.categories!.map((c, i) => (
            <View key={i} className="gap-1">
              <View className="flex-row items-center justify-between">
                <Text className="text-2xs text-ink" numberOfLines={1}>
                  {c.name}
                </Text>
                <Money cents={c.spentCents} className="text-2xs text-muted" />
              </View>
              <MiniBar barPct={c.barPct} />
            </View>
          ))}
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
