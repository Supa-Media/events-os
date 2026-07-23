/**
 * MoneyView (WP-3.3, evolved by PR4) — "what's this thing costing?" ONE money
 * surface per event/project (`moneyViews.refMoney` assembles the same shape
 * for either `refKind`): budget header (approval-aware cap + approval chip),
 * planned-vs-actual by category, the unplanned-spend bucket, a money-IN
 * summary (tickets + donations), and a recent linked-transactions list.
 *
 * PR4 ("the plan IS the database"): the plan is no longer edited through a
 * separate "Edit plan" modal onto `BudgetLineItemsEditor` — for an EVENT ref,
 * `PlanGrid` (below) IS the plan, an always-visible inline database with its
 * own [+ Add] row.
 *
 * PR5: a PROJECT ref now gets the SAME inline plan, just in `PlanGrid`'s
 * budget-only mode (`kind: "budget"`) — a project has no `eventItems`/
 * `engagements` to unify (schema-level), so its plan is budget LINES only,
 * same data `BudgetLineItemsEditor` (retired) used to edit in a separate
 * Finances modal. Every OTHER write still happens in Finances (the budget's
 * amount/approval) or Reconcile (attributing a transaction to a budget).
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Badge, Button, Card, EmptyState, Icon, SectionHeader, Select } from "../ui";
import { Money, BudgetBar, txnStatusTone } from "../finance/dashboard/parts";
import { BudgetApprovalChip } from "../finance/dashboard/BudgetApprovalActions";
import { PlanGrid } from "./PlanGrid";
import { TransactionNoteModal } from "../finance/modals/TransactionNoteModal";
import { ReceiptCell } from "../finance/reconcile/ReconcileList";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";
import { alertError } from "../../lib/errors";

type MoneyData = FunctionReturnType<typeof api.moneyViews.refMoney>;
type CategoryRowData = MoneyData["categories"][number];
type TxnRowData = MoneyData["transactions"][number];

export function MoneyView({
  refKind,
  refId,
}: {
  refKind: "event" | "project";
  refId: string;
}) {
  const router = useRouter();
  const data = useQuery(api.moneyViews.refMoney, { refKind, refId });
  const summonBudget = useMutation(api.finances.summonBudgetForRef);
  // WP-wave4 (HIGH, opus review 2026-07-17): auto-created budgets (a real
  // amount entered on this event/project's own header) now start in
  // "draft" too (never born approved) — this entity's own Money surface
  // needs the SAME deliberate send affordance the Finances dashboard
  // cards already have, or a draft born here has no way to ever become
  // attributable without leaving this screen.
  const submitForReview = useMutation(api.finances.submitBudgetForApproval);
  const [editingTxn, setEditingTxn] = useState<TxnRowData | null>(null);
  const [summoning, setSummoning] = useState(false);
  const [sending, setSending] = useState(false);

  async function handleSendForReview(budgetId: Id<"budgets">) {
    setSending(true);
    try {
      await submitForReview({ budgetId });
    } catch (err) {
      alertError(err);
    } finally {
      setSending(false);
    }
  }

  // Deep-links straight to this budget's own shareable detail page
  // (`apps/mobile/app/(app)/finances/budgets/[id].tsx`) rather than the
  // generic Finances dashboard — "View in Finances" used to drop you at the
  // top of the dashboard with no way back to THIS budget specifically.
  function openBudget(budgetId: Id<"budgets">) {
    router.push(`/finances/budgets/${budgetId}` as never);
  }

  async function handleAddBudget() {
    setSummoning(true);
    try {
      // No modal to open afterward (PR4 retired `EditPlanModal`) — summoning
      // makes `budget` non-null on the next query tick, which alone swaps
      // this view over to the normal header + `PlanGrid` render below.
      await summonBudget({ refKind, scopeRefId: refId });
    } catch (err) {
      alertError(err);
    } finally {
      setSummoning(false);
    }
  }

  if (data === undefined) {
    return (
      <View className="py-10">
        <Text className="text-base text-muted">Loading money…</Text>
      </View>
    );
  }

  const {
    budget,
    categories,
    unplannedCents,
    unallocatedPlannedCents,
    transactions,
    totalPlannedCents,
    totalActualCents,
    totalRemainingCents,
    lineCount,
    incomeCents,
    canSummonBudget,
    canEditTransactions,
  } = data;

  if (!budget) {
    return (
      <>
        <EmptyState
          icon="dollar-sign"
          title="No budget yet"
          message={
            canSummonBudget
              ? "Start a plan to track this event's spend against a budget."
              : "Add a budget amount to start planning — enter it in the budget field above (or on the project card)."
          }
          action={
            canSummonBudget ? (
              <Button
                title="Add budget"
                icon="plus"
                size="sm"
                loading={summoning}
                onPress={() => void handleAddBudget()}
              />
            ) : undefined
          }
        />
        {refKind === "event" ? (
          <PlanGrid
            source={{ kind: "event", eventId: refId as Id<"events"> }}
            budgetId={null}
            capCents={null}
          />
        ) : (
          // PR5: a budget-less project plans through budget-only mode too —
          // its own "+ Add" row lazily summons the project's budget on first
          // add, mirroring the event path's lazy summon above.
          <PlanGrid
            source={{
              kind: "budget",
              summon: { refKind: "project", scopeRefId: refId as Id<"projects"> },
            }}
            budgetId={null}
            capCents={null}
          />
        )}
      </>
    );
  }

  const pct =
    totalPlannedCents > 0
      ? Math.round((totalActualCents / totalPlannedCents) * 100)
      : 0;
  const shownTransactions = transactions.slice(0, 10);
  const netCents = incomeCents - totalActualCents;

  return (
    <View>
      {/* ── Budget header ─────────────────────────────────────────────────── */}
      <Card>
        <View className="flex-row items-start justify-between gap-3">
          <View className="flex-1">
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              Budget
            </Text>
            <Money
              cents={budget.amountCents}
              className="mt-0.5 font-display text-2xl text-ink"
            />
            {budget.label ? (
              <Text className="mt-0.5 text-sm text-muted" numberOfLines={1}>
                {budget.label}
              </Text>
            ) : null}
          </View>
          <View className="items-end gap-2">
            <BudgetApprovalChip
              status={budget.approvalStatus}
              approvedCents={budget.approvedCents}
              requestedCents={budget.requestedCents}
              approvalParty={budget.approvalParty}
            />
            {/* WP-wave4 (HIGH): a draft (or changes-requested) budget born
                HERE — from a real amount entered on this event/project —
                needs the same deliberate "Send for review" the Finances
                dashboard cards offer, or it can never become attributable. */}
            {budget.canEditPlan &&
            (budget.approvalStatus === "draft" || budget.approvalStatus === "changes_requested") ? (
              <Button
                title="Send for review"
                size="sm"
                variant="secondary"
                loading={sending}
                onPress={() => void handleSendForReview(budget.id)}
              />
            ) : null}
            <Pressable
              onPress={() => openBudget(budget.id)}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Text className="text-sm font-medium text-accent">Open budget</Text>
              <Icon name="chevron-right" size={14} color={colors.accent} />
            </Pressable>
          </View>
        </View>

        <View className="mt-3">
          <BudgetBar pct={pct} status={pct >= 80 ? "warn" : "ok"} />
          <View className="mt-1.5 flex-row items-center justify-between">
            <Text className="text-xs text-muted">
              <Money cents={totalActualCents} className="text-xs text-muted" /> spent of{" "}
              <Money cents={totalPlannedCents} className="text-xs text-muted" />
            </Text>
            <Text
              className={`text-xs font-semibold ${
                totalRemainingCents < 0 ? "text-danger" : "text-muted"
              }`}
            >
              {totalRemainingCents < 0
                ? `Over by ${formatCents(-totalRemainingCents)}`
                : `${formatCents(totalRemainingCents)} remaining`}
            </Text>
          </View>
        </View>
      </Card>

      {/* ── Money IN (tickets + donations) — a summary alongside the spend-side
            plan above, not a second reconciliation surface. ─────────────── */}
      {refKind === "event" && incomeCents > 0 ? (
        <Card className="mt-3">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                Income
              </Text>
              <Money cents={incomeCents} className="mt-0.5 text-lg font-semibold text-ink" />
            </View>
            <View className="items-end">
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                Net
              </Text>
              <Money
                cents={netCents}
                className={`mt-0.5 text-lg font-semibold ${netCents < 0 ? "text-danger" : "text-ink"}`}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {/* ── Plan: THE plan, an always-visible inline database (PR4, extended
            to projects by PR5) — every cost-bearing row (event: items ∪
            vendors ∪ budget lines; project: budget lines only), not just the
            category breakdown below. ─────────────────────────────────────── */}
      {refKind === "event" ? (
        <PlanGrid
          source={{ kind: "event", eventId: refId as Id<"events"> }}
          budgetId={budget.id}
          capCents={budget.amountCents}
        />
      ) : (
        <PlanGrid source={{ kind: "budget" }} budgetId={budget.id} capCents={budget.amountCents} />
      )}

      {/* ── Planned vs actual by category (derived from the plan above) ──── */}
      {lineCount === 0 ? (
        <View className="mt-4">
          <EmptyState
            icon="list"
            title="No plan yet"
            message="Add a cost above and it'll show up here, broken down by category."
          />
        </View>
      ) : (
        <>
          <SectionHeader title="Planned vs actual" count={categories.length} />
          <View className="gap-3">
            {categories.map((c) => (
              <CategoryRow key={c.categoryId ?? "uncategorized"} row={c} />
            ))}
            {/* Subtle reconciliation row: the budget header's total planned
                amount can exceed the sum of category rows above when not all
                of it has been broken into a line yet — keep that gap visible
                rather than letting the two numbers silently disagree. */}
            {unallocatedPlannedCents > 0 ? (
              <View className="flex-row items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-2.5">
                <Text className="text-xs text-muted">Unallocated</Text>
                <Text
                  className="text-xs text-muted"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {formatCents(unallocatedPlannedCents)}
                </Text>
              </View>
            ) : null}
          </View>
        </>
      )}

      {/* ── Unplanned-spend bucket ────────────────────────────────────────── */}
      {unplannedCents > 0 ? (
        <Pressable
          onPress={() => router.navigate("/finances/reconcile" as never)}
          className="mt-4 flex-row items-center gap-3 rounded-lg border border-warn bg-warn-bg p-4 shadow-card active:opacity-90"
        >
          <Icon name="alert-triangle" size={18} color={colors.warn} />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink">
              Unplanned spend:{" "}
              <Money cents={unplannedCents} className="text-sm font-semibold text-ink" />
            </Text>
            <Text className="text-xs text-muted">
              Spend in categories with no planned line — not counted toward any
              category above.
            </Text>
          </View>
          <Icon name="chevron-right" size={16} color={colors.muted} />
        </Pressable>
      ) : null}

      {/* ── Recent linked transactions ────────────────────────────────────── */}
      {transactions.length > 0 ? (
        <>
          <SectionHeader
            title="Recent transactions"
            // The header count matches what's actually rendered below —
            // "10 of 42" rather than a bare 42 that implies every row is on
            // screen when only the first page is.
            count={
              transactions.length > shownTransactions.length
                ? `${shownTransactions.length} of ${transactions.length}`
                : shownTransactions.length
            }
          />
          <Card padding="none">
            {shownTransactions.map((tr, i) => (
              <TxnRow
                key={tr.id}
                tr={tr}
                first={i === 0}
                onPress={canEditTransactions ? () => setEditingTxn(tr) : undefined}
              />
            ))}
          </Card>
        </>
      ) : totalActualCents === 0 && lineCount > 0 ? (
        <Text className="mt-4 text-sm text-muted">
          No spend yet — this is the plan so far.
        </Text>
      ) : null}

      {editingTxn ? (
        <TxnEditModal tr={editingTxn} onClose={() => setEditingTxn(null)} />
      ) : null}
    </View>
  );
}

function CategoryRow({ row }: { row: CategoryRowData }) {
  const pct =
    row.plannedCents > 0 ? Math.round((row.actualCents / row.plannedCents) * 100) : 0;
  return (
    <View className="gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={1}>
          {row.categoryName}
        </Text>
        <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(row.actualCents)} / {formatCents(row.plannedCents)}
        </Text>
      </View>
      <BudgetBar pct={pct} status={pct >= 80 ? "warn" : "ok"} />
    </View>
  );
}

function TxnRow({
  tr,
  first,
  onPress,
}: {
  tr: TxnRowData;
  first: boolean;
  /** Present only when `canEditTransactions` — opens `TxnEditModal`. Reconciled
   *  status (shown via the badge below) stays DISPLAY-ONLY either way — this
   *  never lets a tap change it, only note/receipt/category inside the modal. */
  onPress?: () => void;
}) {
  const { tone, label } = txnStatusTone(tr.status);
  const Wrapper = onPress ? Pressable : View;
  return (
    <Wrapper
      onPress={onPress}
      className={`flex-row items-center justify-between gap-3 px-4 py-3 ${
        first ? "" : "border-t border-border"
      } ${onPress ? "active:opacity-70 web:hover:bg-sunken" : ""}`}
    >
      <View className="flex-1">
        <Text className="text-sm text-ink" numberOfLines={1}>
          {tr.merchantName ?? tr.description ?? "Transaction"}
        </Text>
        <Text className="text-xs text-muted">
          {formatDate(tr.postedAt)}
          {tr.note ? " · has a note" : ""}
        </Text>
      </View>
      <View className="items-end gap-1">
        <Text className="text-sm font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(tr.amountCents)}
        </Text>
        <Badge label={label} tone={tone} />
      </View>
    </Wrapper>
  );
}

/**
 * Reconcile-lite (owner decision, 2026-07-17): note/receipt/category for a
 * transaction attributed to THIS event's budget, WITHOUT the finance-role
 * gate — for whoever has `canEditTransactions` (bookkeeper+, or the event's
 * own owner/lead). The "For" bucket is a LOCKED display-only chip (never a
 * picker) — reattribution stays Finances/Reconcile's bookkeeper+ power, never
 * reachable from here. Reconciled status is likewise display-only (the
 * Treasurer's job) — this modal has no status control at all.
 */
function TxnEditModal({ tr, onClose }: { tr: TxnRowData; onClose: () => void }) {
  const setCategory = useMutation(api.finances.setTransactionCategory);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const categories = useQuery(api.finances.listCategories, {}) ?? [];
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [savingCategory, setSavingCategory] = useState(false);
  const { tone, label } = txnStatusTone(tr.status);

  const categoryOptions = [
    { value: "", label: "— No category —" },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  async function handleCategoryChange(value: string) {
    setSavingCategory(true);
    try {
      await setCategory({
        transactionId: tr.id,
        categoryId: (value || null) as Id<"budgetCategories"> | null,
      });
    } catch (err) {
      alertError(err);
    } finally {
      setSavingCategory(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Transaction</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="gap-4 px-5 py-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-1">
                <Text className="text-sm font-medium text-ink" numberOfLines={1}>
                  {tr.merchantName ?? tr.description ?? "Transaction"}
                </Text>
                <Text className="text-xs text-muted">{formatDate(tr.postedAt)}</Text>
              </View>
              <Text className="text-base font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
                {formatCents(tr.amountCents)}
              </Text>
            </View>

            <View className="flex-row items-center gap-2">
              <Badge label={label} tone={tone} />
              {/* LOCKED bucket chip — never a picker here; reattribution stays
                  a Finances/Reconcile bookkeeper+ power. */}
              <Badge label="This event" tone="neutral" />
            </View>

            <Select
              label="Category"
              value={tr.categoryId ?? ""}
              options={categoryOptions}
              onChange={(v) => void handleCategoryChange(v)}
              placeholder="— No category —"
            />
            {savingCategory ? <Text className="text-xs text-muted">Saving…</Text> : null}

            <Pressable
              onPress={() => setNoteModalOpen(true)}
              className="rounded-md border border-border-strong bg-sunken px-3 py-2.5 active:opacity-70"
            >
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                Note
              </Text>
              <Text className="mt-0.5 text-sm text-ink" numberOfLines={2}>
                {tr.note || "Who was this for, and why? Tap to add a note."}
              </Text>
            </Pressable>

            <View>
              <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-muted">
                Receipt
              </Text>
              <View className="rounded-md border border-border-strong bg-sunken">
                <ReceiptCell
                  hasReceipt={tr.hasReceipt}
                  reminderStage={tr.reminderStage}
                  onUpload={async (storageId) => {
                    try {
                      await attachReceipt({ transactionId: tr.id, storageId });
                    } catch (err) {
                      alertError(err);
                    }
                  }}
                  generateUploadUrl={generateUploadUrl}
                />
              </View>
            </View>
          </View>

          <View className="flex-row justify-end border-t border-border px-5 py-4">
            <Button title="Done" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>

      {noteModalOpen ? (
        <TransactionNoteModal
          transactionId={tr.id}
          currentNote={tr.note}
          onClose={() => setNoteModalOpen(false)}
        />
      ) : null}
    </Modal>
  );
}
