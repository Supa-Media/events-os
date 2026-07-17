/**
 * Chapter perspective of the finance dashboard — one chapter's money this month:
 * the affordability header (WP-4.3), KPI tiles, the AI auto-coding banner,
 * event/project budget cards, recurring buckets (with a "New budget" action),
 * the recent-transactions table (with an "Add transaction" action and
 * AI-suggestion Accept), and the attention queue.
 *
 * Figures come straight from `api.finances.dashboardChapter` (the bulk of the
 * view) and `api.finances.chapterAffordability` (the header strip) — this
 * view is pure presentation over those two contracts.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  HeaderCell,
  Icon,
  Row,
  SectionHeader,
  Table,
  TableHeader,
} from "../../ui";
import { colors } from "../../../lib/theme";
import {
  AiCodingBanner,
  BudgetBar,
  Chip,
  MiniBar,
  Money,
  SignedMoney,
  Tile,
  TileRow,
  txnStatusTone,
  type DashPeriodMode,
} from "./parts";
import { TagRollupSection, type TagRollup } from "./TagRollup";
import { BudgetApprovalActions, BudgetApprovalChip } from "./BudgetApprovalActions";

type ChapterDash = FunctionReturnType<typeof api.finances.dashboardChapter>;
type ProjectBudget = ChapterDash["oneTimeBudgets"][number];
type RecurringBudget = ChapterDash["recurringBudgets"][number];
type RecentTxn = ChapterDash["recentTransactions"][number];
type Attention = ChapterDash["attention"][number];
type Affordability = FunctionReturnType<typeof api.finances.chapterAffordability>;

export function ChapterView({
  data,
  affordability,
  year,
  month,
  period,
  chapterId,
  onNewBudget,
  onEditBudget,
  onAddTransaction,
  onAttentionAction,
  onEditBackerCount,
  isDrilldown = false,
}: {
  data: ChapterDash;
  /** WP-4.3's affordability header data. `undefined` while its (separate)
   *  query is still loading — the header renders nothing until then rather
   *  than blocking the rest of the dashboard on it. */
  affordability: Affordability | undefined;
  /** The dashboard's currently-selected year/(through-)month/mode — passed
   *  straight through to the tag-detail sheet's `tagDrilldown` query so its
   *  numbers stay scoped to whatever `data` itself was fetched with. */
  year: number;
  month: number;
  period: DashPeriodMode;
  /** The chapter this dashboard is showing — the caller's own, or (while
   *  peeking, `isDrilldown`) a different one. Threaded into `tagDrilldown` so
   *  its drill-down sheet resolves the chapter actually being VIEWED, not the
   *  caller's own (mirrors `dashboardChapter`'s own `chapterId` arg). */
  chapterId?: Id<"chapters">;
  onNewBudget: () => void;
  onEditBudget: (budgetId: string) => void;
  onAddTransaction: () => void;
  /** Navigate for an attention row's action (`a.kind`: "reimbursements" → the
   *  Reimbursements tab, "cards" → the Cards tab, "needs_budget" → Reconcile
   *  pre-filtered to unattributed spend). */
  onAttentionAction: (kind: string) => void;
  /** Open the backer-count edit modal. Only ever called when
   *  `affordability.canEdit` is true (the affordance is hidden otherwise). */
  onEditBackerCount: () => void;
  /**
   * True while a central viewer is drilled into a chapter that ISN'T their
   * own (see finances/index.tsx). Every write action here — "New budget",
   * "Add transaction" — resolves to the CALLER's own chapter server-side
   * (`requireChapterId`, no chapterId arg), so offering them while viewing a
   * different chapter would silently write to the wrong place. Drill-down is
   * read-only: hide the write actions, and the attention queue's "Review"
   * action (it navigates to the caller's OWN reimbursements/cards tab, not
   * this chapter's).
   */
  isDrilldown?: boolean;
}) {
  const needsReview = data.recentTransactions.filter(
    (t) => txnStatusTone(t.status).label === "Needs review",
  ).length;

  // The tag-detail sheet's open/selected tag — CONTROLLED here (not owned by
  // `TagRollupSection`) so its `tagDrilldown` query only runs while the sheet
  // is actually open.
  const [selectedTag, setSelectedTag] = useState<TagRollup | null>(null);

  return (
    <View>
      {/* Affordability header (WP-4.3): "can we afford this?" in one line. */}
      <AffordabilityHeader data={affordability} onEdit={onEditBackerCount} />

      {/* KPI tiles */}
      <TileRow>
        {data.tiles.map((t, i) => (
          <Tile key={i} label={t.label} value={t.value} meta={t.meta} />
        ))}
      </TileRow>

      <View className="mt-3">
        <AiCodingBanner />
      </View>

      {/* Events & projects */}
      <SectionHeader title="Events & projects" count={data.oneTimeBudgets.length} />
      {data.oneTimeBudgets.length === 0 ? (
        <EmptyState
          title="No event or project budgets yet"
          message="Budget an event or project to track its spend against a plan."
        />
      ) : (
        <View className="gap-3">
          {data.oneTimeBudgets.map((b) => (
            <ProjectBudgetCard
              key={b.id}
              b={b}
              onPress={isDrilldown ? undefined : () => onEditBudget(b.id)}
            />
          ))}
        </View>
      )}

      {/* Recurring buckets */}
      <SectionHeader
        title="Recurring buckets"
        count="monthly · quarterly · yearly"
        right={
          isDrilldown ? undefined : (
            <Button title="New budget" icon="plus" size="sm" onPress={onNewBudget} />
          )
        }
      />
      {data.recurringBudgets.length === 0 ? (
        <EmptyState
          title="No recurring buckets"
          message="Create a monthly, quarterly, or yearly budget for a team or category."
          action={
            isDrilldown ? undefined : (
              <Button title="New budget" icon="plus" size="sm" onPress={onNewBudget} />
            )
          }
        />
      ) : (
        <View className="flex-row flex-wrap gap-3">
          {data.recurringBudgets.map((b) => (
            <RecurringBudgetCard
              key={b.id}
              b={b}
              onPress={isDrilldown ? undefined : () => onEditBudget(b.id)}
            />
          ))}
        </View>
      )}

      {/* By tag — interactive rollup ("spent on Fundraisers") */}
      <TagRollupSection
        rollups={data.tagRollups}
        scope="chapter"
        year={year}
        month={month}
        period={period}
        chapterId={chapterId}
        selected={selectedTag}
        onSelect={setSelectedTag}
      />

      {/* Recent transactions */}
      <SectionHeader
        title="Recent transactions"
        count={needsReview > 0 ? `${needsReview} need review` : undefined}
        right={
          isDrilldown ? undefined : (
            <Button
              title="Add transaction"
              icon="plus"
              size="sm"
              variant="secondary"
              onPress={onAddTransaction}
            />
          )
        }
      />
      {data.recentTransactions.length === 0 ? (
        <EmptyState
          title="No transactions yet"
          message="Charges and manual entries show up here as they land."
          action={
            isDrilldown ? undefined : (
              <Button title="Add transaction" icon="plus" size="sm" onPress={onAddTransaction} />
            )
          }
        />
      ) : (
        <TransactionsTable rows={data.recentTransactions} />
      )}

      {/* Needs your attention */}
      {(() => {
        // Period-scoped (matches `unattributedCents`'s scope + "this period"
        // copy) — NOT `toBudgetCount` (all-time), which could show "$0.00"
        // over "N transactions need a budget this period".
        const needsBudget = data.unattributedCount;
        const attentionCount = data.attention.length + (needsBudget > 0 ? 1 : 0);
        return (
          <>
            <SectionHeader
              title="Needs your attention"
              count={attentionCount || undefined}
            />
            {attentionCount === 0 ? (
              <EmptyState
                icon="check-circle"
                title="All clear"
                message="No reimbursements to approve or cards nearing a receipt lock."
              />
            ) : (
              <View className="gap-3">
                {needsBudget > 0 ? (
                  <NeedsBudgetCard
                    count={needsBudget}
                    unattributedCents={data.unattributedCents}
                    onPress={isDrilldown ? undefined : () => onAttentionAction("needs_budget")}
                  />
                ) : null}
                {data.attention.map((a, i) => {
                  // M3 (review): "budget_approvals" has no real destination —
                  // `onAttentionAction` doesn't handle that kind (the decision
                  // happens right on the budget card below, per
                  // `chapterAttentionQueue`'s own doc comment) — so it must
                  // never render as a tappable dead click.
                  const navigable = !isDrilldown && a.kind !== "budget_approvals";
                  return (
                    <AttentionCard
                      key={i}
                      a={a}
                      onPress={navigable ? () => onAttentionAction(a.kind) : undefined}
                      inertHint={
                        isDrilldown
                          ? "switch chapters to act on this"
                          : a.kind === "budget_approvals"
                            ? "decide right on the budget card below"
                            : undefined
                      }
                    />
                  );
                })}
              </View>
            )}
            {/* Coded-to-central — info-tier (not a warning): spend that's
                legitimately linked to a central budget, so it's excluded from
                Unattributed above but wouldn't otherwise appear anywhere on
                this chapter's dashboard. */}
            {data.centralLinkedCents > 0 ? (
              <View className="mt-3 flex-row items-center gap-2 rounded-md bg-info-bg px-3 py-2">
                <Icon name="info" size={14} color={colors.info} />
                <Text className="flex-1 text-xs text-info">
                  Coded to central budgets:{" "}
                  <Money cents={data.centralLinkedCents} className="text-xs font-semibold text-info" />{" "}
                  — tracked on the central dashboard, not a chapter card.
                </Text>
              </View>
            ) : null}
          </>
        );
      })()}
    </View>
  );
}

// ── Affordability header (WP-4.3) ────────────────────────────────────────────
// "Can we afford this event?" in one line: backers → tier → monthly revenue →
// floor + skim → discretionary. Zero/unset backers get a gentle prompt instead
// of a $0-everywhere row (a manager-only "Set backers" action; nothing at all
// for a plain viewer, so the row disappears rather than reading as broken).
function AffordabilityHeader({
  data,
  onEdit,
}: {
  data: Affordability | undefined;
  onEdit: () => void;
}) {
  if (!data) return null; // its own query — never blocks the rest of the dashboard

  if (data.backerCount === 0) {
    return (
      <View className="mb-3 flex-row flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-raised px-4 py-3">
        <Text className="text-sm text-muted">
          Set your backer count to see affordability.
        </Text>
        {data.canEdit ? (
          <Button title="Set backers" size="sm" variant="secondary" onPress={onEdit} />
        ) : null}
      </View>
    );
  }

  const underwater = data.discretionaryCents < 0;

  return (
    <View className="mb-3 flex-row flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-border bg-raised px-4 py-3">
      <Text className="text-sm text-ink">
        <Text className="font-semibold">{data.backerCount}</Text>{" "}
        {data.backerCount === 1 ? "backer" : "backers"}
      </Text>
      <Text className="text-sm text-muted">·</Text>
      <Text className="text-sm text-ink">
        Tier: <Text className="font-semibold">{data.tierLabel}</Text>
      </Text>
      <Text className="text-sm text-muted">·</Text>
      <Money cents={data.monthlyRevenueCents} className="text-sm font-semibold text-ink" />
      <Text className="text-sm text-muted">/mo revenue →</Text>
      <Money cents={data.floorCents} className="text-sm text-ink" />
      <Text className="text-sm text-muted">floor +</Text>
      <Money cents={data.skimCents} className="text-sm text-ink" />
      <Text className="text-sm text-muted">skim →</Text>
      {underwater ? (
        <Text className="text-sm font-semibold text-danger">
          under water by{" "}
          <Money cents={-data.discretionaryCents} className="text-sm font-semibold text-danger" />
        </Text>
      ) : (
        <Text className="text-sm font-semibold text-ink">
          <Money cents={data.discretionaryCents} className="text-sm font-semibold text-ink" />{" "}
          discretionary
        </Text>
      )}
      {data.canEdit ? (
        <Pressable
          onPress={onEdit}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Edit backer count"
          className="ml-auto flex-row items-center gap-1 rounded-md px-1.5 py-0.5 active:bg-sunken"
        >
          <Icon name="edit-2" size={12} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ── Event / project budget card ──────────────────────────────────────────────
// `onPress` is omitted during a central drill-down (`isDrilldown` at the call
// site) — both the "Edit budget" button and the approval actions below write
// through mutations that resolve the CALLER's own chapter server-side
// (`requireChapterId`/`requireInCallerChapter`), which isn't the chapter
// being peeked, so they'd fail with a confusing "not found" error. Hiding the
// affordance is simpler and clearer than letting the user hit that.
function ProjectBudgetCard({ b, onPress }: { b: ProjectBudget; onPress?: () => void }) {
  const meta = [b.dateLabel, b.subtitle].filter(Boolean).join(" · ");
  return (
    <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="font-display text-lg text-ink" numberOfLines={1}>
              {b.name}
            </Text>
            <Chip label={b.cadence === "per_instance" ? "Per instance" : "One-off"} />
            {b.sourceBadge ? <Badge label={b.sourceBadge} tone="info" /> : null}
            <BudgetApprovalChip
              status={b.approvalStatus}
              approvedCents={b.approvedCents}
              requestedCents={b.requestedCents}
            />
          </View>
          {meta ? <Text className="mt-0.5 text-xs text-muted">{meta}</Text> : null}
        </View>
        <Text
          className="text-sm text-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(b.spentCents)} / {formatCents(b.budgetCents)}
        </Text>
      </View>

      <BudgetBar pct={b.pct} status={b.status} />

      <View className="mt-1.5 flex-row items-center justify-between">
        <Text className="text-xs text-muted">{b.pct}% spent</Text>
        <Text className="text-xs text-muted">
          <Money cents={b.remainingCents} className="text-xs text-muted" /> left
        </Text>
      </View>

      {b.reviewNote && b.approvalStatus === "changes_requested" ? (
        <Text className="mt-2 text-xs text-danger">"{b.reviewNote}"</Text>
      ) : null}

      {b.categories.length > 0 ? (
        <View className="mt-3 gap-2 border-t border-border pt-3">
          {b.categories.map((c, i) => (
            <View key={i} className="gap-1">
              <View className="flex-row items-center justify-between">
                <Text className="text-xs text-ink" numberOfLines={1}>
                  {c.name}
                </Text>
                <Money cents={c.spentCents} className="text-xs text-muted" />
              </View>
              <MiniBar barPct={c.barPct} />
            </View>
          ))}
        </View>
      ) : null}

      {onPress ? (
        <View className="mt-3 flex-row items-center justify-between gap-2">
          <Button title="Edit budget" variant="ghost" size="sm" onPress={onPress} />
          <BudgetApprovalActions budgetId={b.id} status={b.approvalStatus} />
        </View>
      ) : null}
    </View>
  );
}

// ── Recurring bucket card ────────────────────────────────────────────────────
// See `ProjectBudgetCard`'s doc comment above — same drill-down gating, same
// reason (approval mutations resolve the caller's own chapter too).
function RecurringBudgetCard({ b, onPress }: { b: RecurringBudget; onPress?: () => void }) {
  const cadenceLabel =
    b.cadence === "monthly" ? "Monthly" : b.cadence === "quarterly" ? "Quarterly" : "Yearly";
  return (
    <View className="min-w-[260px] flex-1 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {b.name}
          </Text>
          <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
            <Chip label={cadenceLabel} />
            <BudgetApprovalChip
              status={b.approvalStatus}
              approvedCents={b.approvedCents}
              requestedCents={b.requestedCents}
            />
          </View>
        </View>
        <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(b.spentCents)} / {formatCents(b.budgetCents)}
        </Text>
      </View>

      <BudgetBar pct={b.pct} status={b.status} />
      <View className="mt-1.5 flex-row items-center justify-between">
        <Text className="text-xs text-muted">{b.pct}% spent</Text>
        {b.note ? <Text className="text-xs text-muted">{b.note}</Text> : null}
      </View>

      {b.reviewNote && b.approvalStatus === "changes_requested" ? (
        <Text className="mt-2 text-xs text-danger">"{b.reviewNote}"</Text>
      ) : null}

      {b.categories && b.categories.length > 0 ? (
        <View className="mt-3 gap-2 border-t border-border pt-3">
          {b.categories.map((c, i) => (
            <View key={i} className="gap-1">
              <View className="flex-row items-center justify-between">
                <Text className="text-xs text-ink" numberOfLines={1}>
                  {c.name}
                </Text>
                <Money cents={c.spentCents} className="text-xs text-muted" />
              </View>
              <MiniBar barPct={c.barPct} />
            </View>
          ))}
        </View>
      ) : null}

      {onPress ? (
        <View className="mt-3 flex-row items-center justify-between gap-2">
          <Button title="Edit budget" variant="ghost" size="sm" onPress={onPress} />
          <BudgetApprovalActions budgetId={b.id} status={b.approvalStatus} />
        </View>
      ) : null}
    </View>
  );
}

// ── Recent transactions table ────────────────────────────────────────────────
function TransactionsTable({ rows }: { rows: RecentTxn[] }) {
  return (
    <Table>
      <TableHeader>
        <HeaderCell flex={2}>Transaction</HeaderCell>
        <HeaderCell flex={2}>Coded to</HeaderCell>
        <HeaderCell width={110} align="right">
          Amount
        </HeaderCell>
        <HeaderCell width={120} align="right">
          Status
        </HeaderCell>
      </TableHeader>
      {rows.map((t, i) => {
        const status = txnStatusTone(t.status);
        const spender = [t.spenderName, t.cardLast4 ? `•• ${t.cardLast4}` : null]
          .filter(Boolean)
          .join(" · ");
        return (
          <Row key={t.id} last={i === rows.length - 1}>
            <Cell flex={2}>
              <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                {t.merchant ?? "—"}
              </Text>
              <Text className="text-xs text-muted" numberOfLines={1}>
                {[t.date, spender || null, t.timeOrNote || null]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </Cell>
            <Cell flex={2}>
              {t.codedTo ? (
                <>
                  <Text className="text-sm text-ink" numberOfLines={1}>
                    {t.codedTo.projectOrEvent || "—"}
                  </Text>
                  {t.codedTo.category ? (
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {t.codedTo.category}
                    </Text>
                  ) : null}
                </>
              ) : t.aiSuggestion ? (
                <View className="gap-1">
                  <Badge
                    label={`AI: ${t.aiSuggestion.category || "—"}`}
                    tone="lavender"
                    icon="sparkles"
                  />
                </View>
              ) : (
                <Text className="text-xs text-faint">Uncoded</Text>
              )}
            </Cell>
            <Cell width={110} align="right">
              <SignedMoney cents={t.amountCents} flow={t.flow} className="text-sm font-semibold" />
            </Cell>
            <Cell width={120} align="right">
              <Badge label={status.label} tone={status.tone} />
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

// ── Needs-a-budget / Unattributed attention row ──────────────────────────────
// Un-budgeted spend nudged to Reconcile so each charge gets tagged to a
// budget. `count` (`dashboardChapter.unattributedCount`) and `unattributedCents`
// share the same THIS-PERIOD scope + predicate — the dollar figure every
// budget card on the dashboard is blind to (no derive-matching fallback
// exists — see WP-0.1). Hidden when the count is 0 (caller-gated). Tappable
// (unless drilled into another chapter) → Reconcile's `needs_budget` filter.
function NeedsBudgetCard({
  count,
  unattributedCents,
  onPress,
}: {
  count: number;
  unattributedCents: number;
  onPress?: () => void;
}) {
  const content = (
    <>
      <View className="h-9 min-w-[36px] items-center justify-center rounded-pill bg-warn-soft px-2">
        <Text
          className="text-sm font-bold text-warn"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {count}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-ink">
          Unattributed: <Money cents={unattributedCents} className="text-sm font-semibold text-ink" />
        </Text>
        <Text className="text-xs text-muted">
          {count === 1
            ? "1 transaction needs a budget this period"
            : `${count} transactions need a budget this period`}{" "}
          — tag each charge so it counts against a plan.
        </Text>
      </View>
      {onPress ? <Icon name="chevron-right" size={16} color={colors.muted} /> : null}
      <Badge label="Reconcile" tone="warn" icon="tag" />
    </>
  );

  if (!onPress) {
    return (
      <View className="flex-row items-center gap-3 rounded-lg border border-warn bg-warn-bg p-4 shadow-card">
        {content}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-lg border border-warn bg-warn-bg p-4 shadow-card active:opacity-80"
    >
      {content}
    </Pressable>
  );
}

// ── Attention card ───────────────────────────────────────────────────────────
// `onPress` is omitted while drilled into another chapter — the target tabs
// (Reimbursements / Cards) are hard-scoped to the CALLER's own chapter, so
// "Review" would silently act on the wrong chapter's queue — and also (M3,
// review) for a "budget_approvals" row, which has no destination at all (the
// decision happens right on the budget card, not a nav target). Renders as an
// inert row with a note instead of a live nav action either way; `inertHint`
// lets the caller explain WHY (different wording for the two cases).
function AttentionCard({
  a,
  onPress,
  inertHint,
}: {
  a: Attention;
  onPress?: () => void;
  /** Appended to `a.detail` when this card renders inert (no `onPress`). */
  inertHint?: string;
}) {
  const content = (
    <>
      <View className="h-9 min-w-[36px] items-center justify-center rounded-pill bg-accent-soft px-2">
        <Text className="text-sm font-bold text-accent" style={{ fontVariant: ["tabular-nums"] }}>
          {a.badgeCount}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-ink">{a.title}</Text>
        <Text className="text-xs text-muted">
          {onPress ? a.detail : inertHint ? `${a.detail} · ${inertHint}` : a.detail}
        </Text>
      </View>
      {onPress ? (
        <>
          <Badge label={a.actionLabel} tone="accent" />
          <Icon name="chevron-right" size={16} color={colors.muted} />
        </>
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View className="flex-row items-center gap-3 rounded-lg border border-border bg-raised p-4 shadow-card opacity-70">
        {content}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-lg border border-border bg-raised p-4 shadow-card active:bg-sunken web:hover:border-border-strong"
    >
      {content}
    </Pressable>
  );
}
