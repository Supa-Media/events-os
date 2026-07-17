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
 *  differs from its RAW `requestedCents` (the current `amountCents` — a card's
 *  own `budgetCents` is the EFFECTIVE cap now, B1 review, so it can't be used
 *  here), the chip's own label makes BOTH numbers explicit — "Awaiting
 *  approval — approved $X, requested $Y" — so the increase-retrigger rule is
 *  visible right on the card, not just in a tooltip somewhere.
 *
 * WP-wave4 (item 3): a `"draft"` budget is now ALWAYS a deliberate,
 * not-yet-sent state (new or increased — see `finances.ts#setBudgetAmount`'s
 * retrigger doc) — never silently identical to "nothing's happening". The
 * chip reads "Draft — not sent" so it's never hidden. A DRAFT INCREASE
 * (`approvedCents` set and different from `requestedCents` — the OLD approved
 * cap is still what's enforced, see `effectiveCapCents`) gets the same
 * both-numbers treatment the pending-submitted case already uses.
 *
 * WP-wave4 (item 8): an `"approved"` budget shows "1-party approved" instead
 * of the plain "Approved" label when `approvalParty === "single"` — the
 * TEMPORARY superuser self-approval bypass (`finances.ts#approveBudget`) —
 * so a solo-approved decision is never visually indistinguishable from a
 * normal two-person one. `null`/`"two_party"` render the unchanged default
 * label. */
export function BudgetApprovalChip({
  status,
  approvedCents,
  requestedCents,
  approvalParty,
}: {
  status: BudgetApprovalStatus;
  approvedCents: number | null;
  requestedCents: number;
  /** Optional so existing callers (not yet threading the field through)
   *  still compile — absent renders exactly like `null`/`"two_party"`. */
  approvalParty?: "single" | "two_party" | null;
}) {
  const pendingIncrease = approvedCents != null && approvedCents !== requestedCents;
  const label =
    status === "submitted" && pendingIncrease
      ? `Awaiting approval — approved ${formatCents(approvedCents!)}, requested ${formatCents(requestedCents)}`
      : status === "draft" && pendingIncrease
        ? `Draft — not sent (approved ${formatCents(approvedCents!)}, requesting ${formatCents(requestedCents)})`
        : status === "draft"
          ? "Draft — not sent"
          : status === "approved" && approvalParty === "single"
            ? "1-party approved"
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
        title="Send for review"
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
