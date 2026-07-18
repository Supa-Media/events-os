/**
 * DASH-2 right-column "Needs your attention" rail — the same underlying
 * signals `ChapterView`'s old attention queue showed (reimbursements, cards
 * nearing receipt lock, unattributed spend, budgets awaiting approval,
 * central-linked spend), restyled: an amber left stripe, a count chip, one
 * line, one action per row.
 *
 * The "budget_approvals" kind from `data.attention` is INFORMATIONAL only
 * (no `budgetId` — see `chapterAttentionQueue`'s doc comment in
 * `finances.ts`), so it can't drive an inline Approve on its own. This rail
 * instead derives the actionable submitted budgets straight from
 * `oneTimeBudgets`/`recurringBudgets` (which DO carry an `id`) — the same
 * budgets pinned atop the dense table below. When there's exactly one, its
 * `BudgetApprovalActions` render inline right here (the common case — "one
 * action"). With more than one, a single button can't disambiguate WHICH
 * budget to decide, so the row reads as a count + a pointer to the pinned
 * rows below rather than a broken multi-target action.
 */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { BudgetApprovalStatus } from "@events-os/shared";
import { Badge, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { Money } from "./parts";
import { BudgetApprovalActions } from "./BudgetApprovalActions";

type Attention = {
  kind: string;
  title: string;
  badgeCount: number;
  detail: string;
  actionLabel: string;
};

type PendingApproval = {
  id: Id<"budgets">;
  name: string;
  requestedCents: number;
  approvalStatus: BudgetApprovalStatus;
};

export function AttentionRail({
  attention,
  unattributedCount,
  unattributedCents,
  centralLinkedCents,
  pendingApprovals,
  isDrilldown,
  onAttentionAction,
}: {
  attention: Attention[];
  unattributedCount: number;
  unattributedCents: number;
  centralLinkedCents: number;
  pendingApprovals: PendingApproval[];
  isDrilldown: boolean;
  onAttentionAction: (kind: string) => void;
}) {
  // The generic queue items MINUS "budget_approvals" (handled below, from
  // the actual budgets rather than the count-only attention row).
  const otherItems = attention.filter((a) => a.kind !== "budget_approvals");
  const rowCount =
    otherItems.length + (unattributedCount > 0 ? 1 : 0) + (pendingApprovals.length > 0 ? 1 : 0);

  if (rowCount === 0 && centralLinkedCents <= 0) {
    return (
      <View className="flex-row items-center gap-2 rounded-lg border border-border bg-raised p-3">
        <Icon name="check-circle" size={14} color={colors.success} />
        <Text className="text-xs text-muted">All clear — nothing needs attention.</Text>
      </View>
    );
  }

  return (
    <View className="gap-2">
      {pendingApprovals.length === 1 ? (
        <ApprovalRow budget={pendingApprovals[0]} isDrilldown={isDrilldown} />
      ) : pendingApprovals.length > 1 ? (
        <RailRow
          count={pendingApprovals.length}
          title="Budgets awaiting approval"
          detail={`${pendingApprovals.length} decisions needed`}
          actionLabel={isDrilldown ? undefined : "See rows below"}
          onPress={undefined}
        />
      ) : null}

      {unattributedCount > 0 ? (
        <RailRow
          count={unattributedCount}
          title="Unattributed"
          detail={<Money cents={unattributedCents} className="text-2xs font-semibold text-ink" />}
          actionLabel={isDrilldown ? undefined : "Reconcile"}
          onPress={isDrilldown ? undefined : () => onAttentionAction("needs_budget")}
        />
      ) : null}

      {otherItems.map((a, i) => (
        <RailRow
          key={i}
          count={a.badgeCount}
          title={a.title}
          detail={a.detail}
          actionLabel={isDrilldown ? undefined : a.actionLabel}
          onPress={isDrilldown ? undefined : () => onAttentionAction(a.kind)}
        />
      ))}

      {centralLinkedCents > 0 ? (
        <View className="mt-1 flex-row items-center gap-1.5 px-1">
          <Icon name="info" size={11} color={colors.faint} />
          <Text className="flex-1 text-2xs text-faint">
            Coded to central: <Money cents={centralLinkedCents} className="text-2xs text-faint" />
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One compact attention row: amber left stripe, count chip, one line, one action. */
function RailRow({
  count,
  title,
  detail,
  actionLabel,
  onPress,
}: {
  count: number;
  title: string;
  detail: string | ReactNode;
  actionLabel?: string;
  onPress?: () => void;
}) {
  const content = (
    <>
      <View className="w-1 self-stretch rounded-pill bg-warn" />
      <View className="h-6 min-w-[24px] items-center justify-center rounded-pill bg-warn-soft px-1.5">
        <Text className="text-2xs font-bold text-warn" style={{ fontVariant: ["tabular-nums"] }}>
          {count}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
          {title}
        </Text>
        {typeof detail === "string" ? (
          <Text className="text-2xs text-muted" numberOfLines={1}>
            {detail}
          </Text>
        ) : (
          detail
        )}
      </View>
      {actionLabel ? <Badge label={actionLabel} tone="warn" /> : null}
    </>
  );

  const rowClass = "flex-row items-center gap-2 overflow-hidden rounded-lg border border-warn/40 bg-warn-bg/60 py-2 pr-3";

  if (!onPress) {
    return <View className={`${rowClass} opacity-90`}>{content}</View>;
  }
  return (
    <Pressable onPress={onPress} accessibilityRole="button" className={`${rowClass} active:opacity-80`}>
      {content}
    </Pressable>
  );
}

/** The single-pending-approval case: the rail row IS the decision — inline
 *  Approve / Request-changes via `BudgetApprovalActions`, hidden entirely
 *  during a central drill-down (mirrors every other write action in
 *  `ChapterView`). */
function ApprovalRow({ budget, isDrilldown }: { budget: PendingApproval; isDrilldown: boolean }) {
  return (
    <View className="gap-2 overflow-hidden rounded-lg border border-warn/40 bg-warn-bg/60 p-3">
      <View className="flex-row items-center gap-2">
        <View className="h-6 min-w-[24px] items-center justify-center rounded-pill bg-warn-soft px-1.5">
          <Text className="text-2xs font-bold text-warn" style={{ fontVariant: ["tabular-nums"] }}>
            1
          </Text>
        </View>
        <View className="flex-1">
          <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
            {budget.name} awaiting approval
          </Text>
          <Text className="text-2xs text-muted">
            <Money cents={budget.requestedCents} className="text-2xs text-muted" /> requested
          </Text>
        </View>
      </View>
      {!isDrilldown ? (
        <View className="pl-8">
          <BudgetApprovalActions budgetId={budget.id} status={budget.approvalStatus} />
        </View>
      ) : null}
    </View>
  );
}
