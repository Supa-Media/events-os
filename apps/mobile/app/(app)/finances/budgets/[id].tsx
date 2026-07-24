/**
 * BUDGET DETAIL — the shareable, deep-linkable "open one budget" page:
 * header (name, type/cadence, linked event/project, approval status + cap),
 * plan lines vs actuals, a category breakdown, every linked transaction, and
 * the durable approval history. Tapping a budget row's BODY on the finance
 * dashboard (`ChapterView`/`CentralView`'s `BudgetTableGroup`) navigates
 * here now, instead of straight into `BudgetCreateModal` — the chevron still
 * expands the row's category mini-bars in place, unchanged. This page's own
 * "Edit" button is the new way into that modal.
 *
 * Backed by `api.budgetDetail.getBudgetDetail` (its own file, not
 * `finances.ts` — see that query's module doc). Reuses `PlanGrid` (budget
 * mode) for the plan, `BudgetApprovalChip`/`BudgetApprovalActions` for the
 * workflow, and `ApprovalHistory` straight from `BudgetCreateModal` (now
 * exported) rather than forking any of that UI.
 */
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  BackLink,
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  Icon,
  Screen,
  SectionHeader,
  Narrow,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { formatDateTime } from "../../../../lib/format";
import {
  Money,
  BudgetBar,
  MiniBar,
  Chip,
  txnStatusTone,
  FinanceBoundary,
} from "../../../../components/finance/dashboard/parts";
import {
  BudgetApprovalChip,
  BudgetApprovalActions,
} from "../../../../components/finance/dashboard/BudgetApprovalActions";
import { PlanGrid } from "../../../../components/money/PlanGrid";
import {
  BudgetCreateModal,
  ApprovalHistory,
} from "../../../../components/finance/modals/BudgetCreateModal";

type Detail = FunctionReturnType<typeof api.budgetDetail.getBudgetDetail>;
type TxnRow = NonNullable<Detail>["transactions"][number];

const CADENCE_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  per_instance: "One-time",
  one_off: "One-time",
};

export default function BudgetDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const budgetId = id ? (id as Id<"budgets">) : undefined;

  return (
    <Screen>
      <Narrow>
        <BackLink fallback="/finances/budgets" />
        <FinanceBoundary
          fallback={
            <EmptyState
              icon="lock"
              title="Finance access needed"
              message="Ask a finance manager to grant you access to see this budget."
            />
          }
        >
          <BudgetDetailBody budgetId={budgetId} />
        </FinanceBoundary>
      </Narrow>
    </Screen>
  );
}

function BudgetDetailBody({ budgetId }: { budgetId: Id<"budgets"> | undefined }) {
  const detail = useQuery(api.budgetDetail.getBudgetDetail, budgetId ? { budgetId } : "skip");
  const [editing, setEditing] = useState(false);

  if (!budgetId || detail === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <Text className="text-sm text-muted">Loading budget…</Text>
      </View>
    );
  }

  if (detail === null) {
    return (
      <EmptyState
        title="Budget not found"
        message="It may have been deleted, or it belongs to another chapter."
      />
    );
  }

  const shareUrl =
    Platform.OS === "web" && typeof window !== "undefined" ? window.location.href : undefined;
  const cadenceLabel = CADENCE_LABEL[detail.cadence] ?? detail.cadence;
  const over = detail.remainingCents < 0;

  return (
    <View>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <View className="mb-4">
        <View className="flex-row items-start justify-between gap-3">
          <Text className="flex-1 font-display text-2xl text-ink">{detail.name}</Text>
          <View className="flex-row items-center gap-2">
            {shareUrl ? <CopyButton text={shareUrl} label /> : null}
            {detail.canEdit ? (
              <Button title="Edit" icon="edit-2" size="sm" variant="secondary" onPress={() => setEditing(true)} />
            ) : null}
          </View>
        </View>
        <View className="mt-1.5 flex-row flex-wrap items-center gap-2">
          {detail.level === "central" ? <Chip label="Central" /> : null}
          <Chip label={cadenceLabel} />
          {detail.categoryName ? <Chip label={detail.categoryName} /> : null}
          {detail.refDateLabel ? (
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {detail.refDateLabel}
            </Text>
          ) : null}
          <BudgetApprovalChip
            status={detail.approvalStatus}
            approvedCents={detail.approvedCents}
            requestedCents={detail.requestedCents}
          />
        </View>
        {detail.refKind && detail.scopeRefId && detail.refLive ? (
          <RefLink refKind={detail.refKind} scopeRefId={detail.scopeRefId} />
        ) : null}
      </View>

      {/* ── Approval actions (Submit / Approve / Request changes) ──────────── */}
      <View className="mb-3">
        <BudgetApprovalActions budgetId={detail.id} status={detail.approvalStatus} />
      </View>

      {/* ── Cap vs actual ────────────────────────────────────────────────────── */}
      <Card className="mt-3">
        <View className="flex-row items-baseline justify-between gap-2">
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Spent of cap
          </Text>
          <Text
            className={`text-xs font-semibold ${over ? "text-danger" : "text-muted"}`}
          >
            {over ? `${formatCents(-detail.remainingCents)} over` : `${formatCents(detail.remainingCents)} left`}
          </Text>
        </View>
        <Text className="mt-0.5 text-2xl font-display text-ink" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(detail.spentCents)}
          <Text className="text-base text-muted"> of {formatCents(detail.capCents)}</Text>
        </Text>
        <View className="mt-2">
          <BudgetBar pct={detail.pct} status={detail.status} />
        </View>
        {detail.reviewNote ? (
          <Text className="mt-2 text-xs text-danger">"{detail.reviewNote}"</Text>
        ) : null}
      </Card>

      {/* ── Where it went (category breakdown) ──────────────────────────────── */}
      {detail.categories.length > 0 ? (
        <View className="mt-5">
          <SectionHeader title="Where it went" count={detail.categories.length} />
          <Card className="gap-2.5">
            {detail.categories.map((c) => (
              <View key={c.name} className="gap-1">
                <View className="flex-row items-center justify-between gap-2">
                  <Text className="flex-1 text-xs text-ink" numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Money cents={c.spentCents} className="text-xs font-semibold" />
                </View>
                <MiniBar barPct={c.barPct} />
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {/* ── Plan (the SAME PlanGrid budget lines every "edit budget" modal
            already uses, budget mode) ──────────────────────────────────────── */}
      <PlanGrid source={{ kind: "budget" }} budgetId={detail.id} capCents={detail.capCents} />

      {/* ── Linked transactions ─────────────────────────────────────────────── */}
      <View className="mt-5">
        <SectionHeader
          title="Transactions"
          count={
            detail.transactionTotalCount > detail.transactions.length
              ? `${detail.transactions.length} of ${detail.transactionTotalCount}`
              : detail.transactionTotalCount
          }
        />
        {detail.transactions.length === 0 ? (
          <EmptyState
            icon="list"
            title="No transactions yet"
            message="Charges attributed to this budget will show up here."
          />
        ) : (
          <Card padding="none">
            {detail.transactions.map((tr, i) => (
              <TxnRowView key={tr.id} tr={tr} first={i === 0} />
            ))}
          </Card>
        )}
      </View>

      {/* ── Approval history ─────────────────────────────────────────────────── */}
      <View className="mt-5">
        <ApprovalHistory budgetId={detail.id} />
      </View>

      {editing ? (
        <BudgetCreateModal
          budgetId={detail.id}
          defaultYear={detail.year}
          defaultMonth={detail.month ?? new Date().getMonth() + 1}
          canCentral={detail.level === "central"}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </View>
  );
}

/** The "Open event/project" link — mirrors `BudgetTable`'s own `onOpenRef`
 *  affordance, just always-on here (this page has no peek-mode concept). */
function RefLink({ refKind, scopeRefId }: { refKind: "event" | "project"; scopeRefId: string }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(`/${refKind}/${scopeRefId}` as never)}
      className="mt-2 flex-row items-center gap-1 self-start active:opacity-70"
    >
      <Text className="text-sm font-medium text-accent">
        Open {refKind === "event" ? "event" : "project"}
      </Text>
      <Icon name="chevron-right" size={14} color={colors.accent} />
    </Pressable>
  );
}

function TxnRowView({ tr, first }: { tr: TxnRow; first: boolean }) {
  const { tone, label } = txnStatusTone(tr.status);
  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3 ${first ? "" : "border-t border-border"}`}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-ink" numberOfLines={1}>
          {tr.merchantName ?? tr.description ?? "Transaction"}
        </Text>
        <Text className="text-xs text-muted" numberOfLines={1}>
          {formatDateTime(tr.date)}
          {tr.personName ? ` · ${tr.personName}` : ""}
          {tr.categoryName ? ` · ${tr.categoryName}` : ""}
        </Text>
      </View>
      {tr.hasReceipt ? <Icon name="check-circle" size={13} color={colors.success} /> : null}
      <View className="items-end gap-1">
        <Text
          className={`text-sm font-semibold ${tr.flow === "inflow" ? "text-success" : "text-ink"}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {tr.flow === "outflow" ? "−" : tr.flow === "inflow" ? "+" : ""}
          {formatCents(tr.amountCents)}
        </Text>
        <Badge label={label} tone={tone} />
      </View>
    </View>
  );
}
