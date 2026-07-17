/**
 * BudgetApprovalActions — WP-3.2's on-card approval workflow chip + actions,
 * shared by every budget card (`ProjectBudgetCard` / `RecurringBudgetCard` in
 * `ChapterView.tsx`, `CentralBudgetCard` in `CentralView.tsx`). Deliberately
 * lean per the WP: no dedicated approval screen — a chip for the status, and
 * inline Submit / Approve / Request-changes buttons right on the existing
 * card. The mutations enforce the real gates (scope + separation of duties)
 * server-side; this component shows the actions to anyone with dashboard
 * access and surfaces a rejection (wrong role, self-approval, wrong state)
 * as a plain alert rather than trying to duplicate that logic client-side.
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BUDGET_APPROVAL_STATUS_LABELS,
  formatCents,
  type BudgetApprovalStatus,
} from "@events-os/shared";
import { Badge, Button, Icon, TextField, type BadgeTone } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

const STATUS_TONE: Record<BudgetApprovalStatus, BadgeTone> = {
  draft: "neutral",
  submitted: "warn",
  approved: "success",
  changes_requested: "danger",
};

/** The approval-status chip. When a `"submitted"` budget's `approvedCents`
 *  differs from its (already-bumped) `amountCents`, the chip's own label
 *  makes the still-in-force cap explicit — "Awaiting approval (approved at
 *  $X)" — so the increase-retrigger rule is visible right on the card, not
 *  just in a tooltip somewhere. */
export function BudgetApprovalChip({
  status,
  approvedCents,
  amountCents,
}: {
  status: BudgetApprovalStatus;
  approvedCents: number | null;
  amountCents: number;
}) {
  const pending =
    status === "submitted" && approvedCents != null && approvedCents !== amountCents;
  const label = pending
    ? `Awaiting approval (approved at ${formatCents(approvedCents!)})`
    : BUDGET_APPROVAL_STATUS_LABELS[status];
  return <Badge label={label} tone={STATUS_TONE[status]} />;
}

/** Submit / Approve / Request-changes actions for one budget, keyed off its
 *  effective `approvalStatus`. Renders nothing once a budget is plainly
 *  `"approved"` (the chip alone says enough) — the chip is rendered
 *  separately by the caller so it can sit next to the card's cadence chip. */
export function BudgetApprovalActions({
  budgetId,
  status,
}: {
  budgetId: Id<"budgets">;
  status: BudgetApprovalStatus;
}) {
  const submit = useMutation(api.finances.submitBudgetForApproval);
  const approve = useMutation(api.finances.approveBudget);
  const requestChanges = useMutation(api.finances.requestBudgetChanges);
  const [busy, setBusy] = useState(false);
  const [showReasonModal, setShowReasonModal] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      alertError(err);
    } finally {
      setBusy(false);
    }
  }

  if (status === "draft" || status === "changes_requested") {
    return (
      <Button
        title="Submit for approval"
        variant="secondary"
        size="sm"
        loading={busy}
        onPress={() => run(() => submit({ budgetId }))}
      />
    );
  }

  if (status === "submitted") {
    return (
      <>
        <View className="flex-row gap-2">
          <Button
            title="Approve"
            size="sm"
            loading={busy}
            onPress={() => run(() => approve({ budgetId }))}
          />
          <Button
            title="Request changes"
            variant="secondary"
            size="sm"
            disabled={busy}
            onPress={() => setShowReasonModal(true)}
          />
        </View>
        {showReasonModal ? (
          <RequestChangesModal
            onCancel={() => setShowReasonModal(false)}
            onSubmit={async (note) => {
              await run(() => requestChanges({ budgetId, note }));
              setShowReasonModal(false);
            }}
          />
        ) : null}
      </>
    );
  }

  return null;
}

/** A small reason prompt for "Request changes" — mirrors
 *  `TransactionNoteModal`'s pattern (the app has no cross-platform
 *  `Alert.prompt`, so a lightweight modal + `TextField` stands in). */
function RequestChangesModal({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!note.trim()) return;
    setSaving(true);
    try {
      await onSubmit(note.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Request changes</Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="px-5 py-4">
            <Text className="mb-3 text-xs text-muted">
              What needs to change before this budget can be approved?
            </Text>
            <TextField
              value={note}
              onChangeText={setNote}
              placeholder="e.g. Break the equipment line out separately"
              multiline
              numberOfLines={4}
              autoFocus
            />
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title="Send"
              onPress={submit}
              loading={saving}
              disabled={!note.trim()}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
