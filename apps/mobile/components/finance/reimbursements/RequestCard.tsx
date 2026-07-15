/**
 * One reimbursement in the manager approval queue (built to the `finances.html`
 * Reimbursements tab). Shows the requester, a status + receipts badge, and the
 * total; expands to the line-item table; and offers the state-appropriate
 * manager actions:
 *   - submitted / preapproved → Reject · Approve lines… · Approve & pay
 *   - pending_preapproval      → Decline · Pre-approve
 *   - approved                 → Mark paid (`markPaidManually`), with a note
 *                                that ACH auto-payout via Increase is coming
 *   - everything else          → read-only (a status note)
 *
 * "Approve lines…" opens an inline per-line checkbox selector that submits
 * `approve({ approvedLineIds })` (partial approval); "Approve & pay" submits
 * `approve({})` (all lines). Both surface the server-side separation-of-duties
 * error via the parent's action runner.
 */
import { useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Avatar, Badge, Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  STATUS_BADGE,
  RECEIPTS_BADGE,
  canApprove,
  canPreApprove,
  canMarkPaid,
  isActionable,
  shortDate,
  type ReimbursementRow,
  type ReimbursementDetail,
} from "./helpers";

/** A payout summary as returned by `api.increase.listPayouts` (optional hint). */
type Payout = FunctionReturnType<typeof api.increase.listPayouts>[number];

type Props = {
  row: ReimbursementRow;
  /** The live payout for this request, if any (drives the read-only hint). */
  payout?: Payout;
  /** Approve all lines (omit ids) or a subset. Returns once the run settles. */
  onApprove: (
    id: Id<"reimbursementRequests">,
    approvedLineIds?: Id<"reimbursementLineItems">[],
  ) => Promise<void>;
  onPreApprove: (id: Id<"reimbursementRequests">) => Promise<void>;
  onReject: (id: Id<"reimbursementRequests">) => Promise<void>;
  /** Mark an approved request paid (`markPaidManually`). */
  onMarkPaid: (id: Id<"reimbursementRequests">) => Promise<void>;
};

export function RequestCard({
  row,
  payout,
  onApprove,
  onPreApprove,
  onReject,
  onMarkPaid,
}: Props) {
  // `expanded` shows the read-only line table; `selecting` swaps it for the
  // per-line checkbox approve selector. Either mode needs the request's lines.
  const [expanded, setExpanded] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [busy, setBusy] = useState(false);

  const detail = useQuery(
    api.reimbursements.get,
    expanded || selecting ? { reimbursementId: row._id } : "skip",
  );

  const status = STATUS_BADGE[row.status];
  const receipts = RECEIPTS_BADGE[row.receiptsState];
  const actionable = isActionable(row.status);
  const partiallyApproved =
    row.approvedCents != null && row.approvedCents !== row.totalCents;

  async function runBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="mb-3.5 rounded-lg border border-border bg-raised p-4 shadow-card">
      {/* Header — requester + status/total. */}
      <View className="flex-row flex-wrap items-start justify-between gap-3">
        <View className="flex-1 flex-row items-center gap-3">
          <Avatar name={row.requesterName} size={36} />
          <View className="flex-1">
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="text-base font-semibold text-ink">
                {row.requesterName}
              </Text>
              <Badge
                label={row.requesterType === "team" ? "Team" : "Volunteer"}
              />
            </View>
            <Text className="mt-0.5 text-xs text-muted">
              Submitted {shortDate(row.submittedDate)} · {row.reference} ·{" "}
              {row.lineItemCount}{" "}
              {row.lineItemCount === 1 ? "line item" : "line items"}
            </Text>
          </View>
        </View>
        <View className="items-end gap-1.5">
          <Badge label={row.statusBadge} tone={status.tone} icon={status.icon} />
          <Text className="text-base font-bold text-ink">
            {formatCents(row.totalCents)}
          </Text>
          {partiallyApproved ? (
            <Text className="text-xs text-muted">
              Approved {formatCents(row.approvedCents!)}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Receipts + expand toggle. */}
      <View className="mt-3 flex-row items-center justify-between gap-2">
        <Badge label={receipts.label} tone={receipts.tone} icon={receipts.icon} />
        {row.lineItemCount > 0 ? (
          <Pressable
            onPress={() => setExpanded((v) => !v)}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Text className="text-sm font-medium text-accent">
              {expanded ? "Hide line items" : "View line items"}
            </Text>
            <Icon
              name={expanded ? "chevron-up" : "chevron-down"}
              size={15}
              color={colors.accent}
            />
          </Pressable>
        ) : null}
      </View>

      {/* Read-only line table (when expanded and not selecting). */}
      {expanded && !selecting ? (
        <LineTable detail={detail} />
      ) : null}

      {/* Per-line approve selector. */}
      {selecting ? (
        <ApproveSelector
          detail={detail}
          busy={busy}
          onCancel={() => setSelecting(false)}
          onConfirm={(lineIds) =>
            runBusy(async () => {
              await onApprove(row._id, lineIds);
              setSelecting(false);
            })
          }
        />
      ) : null}

      {/* SoD strip — only where an approval decision is on offer. */}
      {actionable ? (
        <View className="mt-3 flex-row items-center gap-2 rounded-md bg-warn-bg px-3 py-2">
          <Icon name="alert-triangle" size={14} color={colors.warn} />
          <Text className="flex-1 text-xs text-warn">
            Separation of duties — you can't approve your own request.
          </Text>
        </View>
      ) : null}

      {/* Pay note — approved requests are paid manually for now; ACH is next. */}
      {canMarkPaid(row.status) ? (
        <View className="mt-3 flex-row items-center gap-2 rounded-md bg-info-bg px-3 py-2">
          <Icon name="info" size={14} color={colors.info} />
          <Text className="flex-1 text-xs text-info">
            Send the ACH transfer from the chapter's Increase account, then mark
            it paid here. Auto-payout via Increase is coming — destination bank
            capture is a follow-up.
          </Text>
        </View>
      ) : null}

      {/* Actions. */}
      {!selecting ? (
        <View className="mt-3 flex-row flex-wrap justify-end gap-2">
          {canPreApprove(row.status) ? (
            <>
              <Button
                title="Decline"
                variant="danger"
                size="sm"
                icon="x"
                disabled={busy}
                onPress={() => runBusy(() => onReject(row._id))}
              />
              <Button
                title="Pre-approve"
                variant="primary"
                size="sm"
                icon="check"
                loading={busy}
                onPress={() => runBusy(() => onPreApprove(row._id))}
              />
            </>
          ) : canApprove(row.status) ? (
            <>
              <Button
                title="Reject"
                variant="danger"
                size="sm"
                icon="x"
                disabled={busy}
                onPress={() => runBusy(() => onReject(row._id))}
              />
              <Button
                title="Approve lines…"
                variant="secondary"
                size="sm"
                disabled={busy}
                onPress={() => {
                  setExpanded(false);
                  setSelecting(true);
                }}
              />
              <Button
                title={`Approve & pay ${formatCents(row.totalCents)}`}
                variant="primary"
                size="sm"
                icon="check"
                loading={busy}
                onPress={() => runBusy(() => onApprove(row._id))}
              />
            </>
          ) : canMarkPaid(row.status) ? (
            <Button
              title={`Mark paid ${formatCents(row.approvedCents ?? row.totalCents)}`}
              variant="primary"
              size="sm"
              icon="check-circle"
              loading={busy}
              onPress={() => runBusy(() => onMarkPaid(row._id))}
            />
          ) : (
            <ReadOnlyNote status={row.status} payout={payout} />
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The status-appropriate read-only footnote for non-actionable requests.
 *  When a payout exists, its provider ("Increase ACH" vs a manual transfer) is
 *  reflected so a manager can tell how a paid/paying request was settled. */
function ReadOnlyNote({
  status,
  payout,
}: {
  status: ReimbursementRow["status"];
  payout?: Payout;
}) {
  const via = payout?.provider === "increase" ? "Increase ACH" : "a bank transfer";
  const text =
    status === "paying"
      ? "ACH transfer initiated from the chapter's Increase account."
      : status === "paid"
        ? `Paid out via ${via}.`
        : "No further action needed.";
  return <Text className="text-xs text-muted">{text}</Text>;
}

/** Shared line-item table used by both the read-only view and the selector. */
function LineTable({
  detail,
}: {
  detail: ReimbursementDetail | undefined;
}) {
  if (detail === undefined) {
    return <Text className="mt-3 text-sm text-muted">Loading line items…</Text>;
  }
  return (
    <View className="mt-3 overflow-hidden rounded-md border border-border">
      <View className="flex-row bg-sunken px-3 py-2">
        <Text className="flex-1 text-2xs font-bold uppercase tracking-wider text-muted">
          Line item
        </Text>
        <Text className="w-16 text-center text-2xs font-bold uppercase tracking-wider text-muted">
          Receipt
        </Text>
        <Text className="w-24 text-right text-2xs font-bold uppercase tracking-wider text-muted">
          Amount
        </Text>
      </View>
      {detail.lines.map((line) => (
        <View
          key={line._id}
          className="flex-row items-center border-t border-border px-3 py-2"
        >
          <View className="flex-1 pr-2">
            <Text className="text-sm font-medium text-ink">
              {line.description}
            </Text>
            {line.fund || line.category ? (
              <Text className="text-xs text-muted">
                {[line.fund, line.category].filter(Boolean).join(" › ")}
              </Text>
            ) : null}
          </View>
          <View className="w-16 items-center">
            {line.hasReceipt ? (
              <Icon name="check" size={15} color={colors.success} />
            ) : (
              <Icon name="minus" size={15} color={colors.faint} />
            )}
          </View>
          <Text className="w-24 text-right text-sm font-semibold text-ink">
            {formatCents(line.amountCents)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Per-line checkbox selector for partial approval (defaults to every line). */
function ApproveSelector({
  detail,
  busy,
  onCancel,
  onConfirm,
}: {
  detail: ReimbursementDetail | undefined;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (lineIds: Id<"reimbursementLineItems">[]) => void;
}) {
  const lineIds = useMemo(
    () => (detail ? detail.lines.map((l) => l._id) : []),
    [detail],
  );
  // Default selection = all lines; keyed by line id.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const active = selected ?? new Set(lineIds.map(String));

  if (detail === undefined) {
    return <Text className="mt-3 text-sm text-muted">Loading line items…</Text>;
  }

  const chosen = detail.lines.filter((l) => active.has(String(l._id)));
  const chosenCents = chosen.reduce((sum, l) => sum + l.amountCents, 0);

  function toggle(id: Id<"reimbursementLineItems">) {
    const next = new Set(active);
    const key = String(id);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  }

  return (
    <View className="mt-3 rounded-md border border-border-strong bg-sunken p-3">
      <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">
        Select lines to approve
      </Text>
      <View className="gap-1">
        {detail.lines.map((line) => {
          const on = active.has(String(line._id));
          return (
            <Pressable
              key={line._id}
              onPress={() => toggle(line._id)}
              className="flex-row items-center gap-2.5 rounded-md bg-raised px-2.5 py-2 active:opacity-80"
            >
              <View
                className={`h-5 w-5 items-center justify-center rounded border ${
                  on ? "border-accent bg-accent" : "border-border-strong bg-raised"
                }`}
              >
                {on ? <Icon name="check" size={13} color="#FFFFFF" /> : null}
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-ink">
                  {line.description}
                </Text>
                {line.fund || line.category ? (
                  <Text className="text-xs text-muted">
                    {[line.fund, line.category].filter(Boolean).join(" › ")}
                    {line.hasReceipt ? " · receipt ✓" : ""}
                  </Text>
                ) : null}
              </View>
              <Text className="text-sm font-semibold text-ink">
                {formatCents(line.amountCents)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View className="mt-3 flex-row flex-wrap items-center justify-between gap-2">
        <Text className="text-sm text-muted">
          {chosen.length} of {detail.lines.length} ·{" "}
          <Text className="font-bold text-ink">{formatCents(chosenCents)}</Text>
        </Text>
        <View className="flex-row gap-2">
          <Button
            title="Cancel"
            variant="ghost"
            size="sm"
            disabled={busy}
            onPress={onCancel}
          />
          <Button
            title={`Approve ${formatCents(chosenCents)}`}
            variant="primary"
            size="sm"
            icon="check"
            loading={busy}
            disabled={chosen.length === 0}
            onPress={() => onConfirm(chosen.map((l) => l._id))}
          />
        </View>
      </View>
    </View>
  );
}
