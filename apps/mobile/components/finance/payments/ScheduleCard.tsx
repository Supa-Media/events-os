/**
 * FINANCES · PAYMENTS · The payment schedule, as a treasurer reads and works it.
 *
 * THE FOUNDER'S ACTUAL ASK, 2026-08-28: "so we can go to the same place and be
 * like, oh, we know we've paid this halfway, and then we can go manually in
 * there and pay the full thing." Both halves are here — the running total at
 * the top answers the first, and each row's own Pay button is the second.
 *
 * WHY EVERY TRANCHE HAS ITS OWN BUTTON rather than one "pay the next one":
 * milestones genuinely complete out of order (the delivery lands before the
 * revision date), the server does not enforce an order, and a single Next
 * button would quietly pick for the treasurer. Releasing money is a decision
 * somebody makes about a specific tranche, so they point at the one they mean.
 *
 * DUE IS A PROMPT, NEVER A PERMISSION. A `due` row is styled to be noticed and
 * nothing more: a date arriving does not make the work done, and the person
 * pressing the button is still the one deciding. Milestone rows never mark
 * themselves due at all — no clock can know whether a record was delivered.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  CONTRACTOR_INSTALLMENT_STATUS_LABELS,
  describeContractorInstallmentTiming,
  formatCents,
  type ContractorInstallmentStatus,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Icon,
  SectionHeader,
  TextField,
  type BadgeTone,
} from "../../ui";
import type { IconName } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate, formatDateTime } from "../../../lib/format";

export type ScheduleView = FunctionReturnType<
  typeof api.contractorInstallments.listForPayment
>;
export type ScheduleRow = ScheduleView["installments"][number];

/** A tranche's state as a chip. `scheduled` is deliberately quiet — most rows
 *  of a healthy schedule are scheduled, and a screen where the normal case
 *  shouts has no room left to flag the one that matters. */
const INSTALLMENT_BADGE: Record<
  ContractorInstallmentStatus,
  { tone: BadgeTone; icon: IconName }
> = {
  scheduled: { tone: "neutral", icon: "clock" },
  paying: { tone: "info", icon: "refresh-cw" },
  paid: { tone: "success", icon: "check-circle" },
  canceled: { tone: "neutral", icon: "slash" },
};

export function ScheduleCard({
  schedule,
  canPay,
  onPay,
  onMarkPaid,
  onCancelInstallment,
  busyInstallmentId,
}: {
  schedule: ScheduleView;
  /** The caller holds approve rights AND the agreement is in a state money can
   *  leave from. Both are the server's rules; this only decides what to offer. */
  canPay: boolean;
  onPay: (id: Id<"contractorPaymentInstallments">) => void;
  onMarkPaid: (id: Id<"contractorPaymentInstallments">) => void;
  onCancelInstallment: (
    id: Id<"contractorPaymentInstallments">,
    reason: string,
  ) => void;
  busyInstallmentId: Id<"contractorPaymentInstallments"> | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!schedule.scheduled) return null;

  const { summary, agreedAmountCents } = schedule;
  const settled = summary.paidCents + summary.canceledCents;
  // Progress against what will ACTUALLY be sent, not against the agreed total:
  // once a tranche is canceled the agreement will never pay its full amount,
  // and a bar that keeps measuring against it would read as permanently
  // unfinished on an engagement that is complete.
  const commitmentCents = agreedAmountCents - summary.canceledCents;
  const pct =
    commitmentCents > 0
      ? Math.min(100, Math.round((summary.paidCents / commitmentCents) * 100))
      : 0;

  return (
    <>
      <SectionHeader title="Payment schedule" />
      <View className="rounded-lg border border-border bg-raised px-4 py-3.5">
        {/* ── "We know we've paid this halfway" ───────────────────────────── */}
        <View className="mb-1 flex-row flex-wrap items-end justify-between gap-2">
          <Text
            className="font-display text-xl text-ink"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {formatCents(summary.paidCents)}{" "}
            <Text className="text-sm text-muted">
              paid of {formatCents(agreedAmountCents)}
            </Text>
          </Text>
          <Text className="text-xs text-muted">
            {summary.paidCount} of {summary.count} payments sent
          </Text>
        </View>
        <View className="mb-3 h-1.5 overflow-hidden rounded-full bg-sunken">
          <View
            className="h-full rounded-full bg-success"
            style={{ width: `${pct}%` }}
          />
        </View>
        {summary.remainingCents > 0 ? (
          <Text className="mb-3 text-xs text-muted">
            {formatCents(summary.remainingCents)} still to go out.
          </Text>
        ) : settled === agreedAmountCents ? (
          <Text className="mb-3 text-xs text-success">
            Everything on this agreement has been settled.
          </Text>
        ) : null}
        {summary.canceledCents > 0 ? (
          <Text className="mb-3 text-xs text-warn">
            {formatCents(summary.canceledCents)} was canceled and will never be
            sent.
          </Text>
        ) : null}

        {schedule.installments.map((row) => (
          <InstallmentRow
            key={row._id}
            row={row}
            canPay={canPay}
            busy={busyInstallmentId === row._id}
            expanded={expanded === row._id}
            onToggle={() =>
              setExpanded((e) => (e === row._id ? null : String(row._id)))
            }
            onPay={() => onPay(row._id)}
            onMarkPaid={() => onMarkPaid(row._id)}
            onCancel={(reason) => onCancelInstallment(row._id, reason)}
          />
        ))}
      </View>
    </>
  );
}

function InstallmentRow({
  row,
  canPay,
  busy,
  expanded,
  onToggle,
  onPay,
  onMarkPaid,
  onCancel,
}: {
  row: ScheduleRow;
  canPay: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPay: () => void;
  onMarkPaid: () => void;
  onCancel: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const badge = INSTALLMENT_BADGE[row.status];
  const timing = describeContractorInstallmentTiming(row, formatDate);
  const releasable = canPay && row.status === "scheduled";

  return (
    <View
      className={`mb-2 rounded-md border px-3 py-2.5 ${
        row.due
          ? "border-warn bg-warn-bg"
          : row.status === "canceled"
            ? "border-border bg-sunken opacity-70"
            : "border-border bg-sunken"
      }`}
    >
      <View className="flex-row flex-wrap items-start justify-between gap-2">
        <View className="min-w-[140px] flex-1">
          <Text className="text-sm font-semibold text-ink">
            {row.seq}. {row.label}
          </Text>
          <Text className="mt-0.5 text-xs text-muted">{timing}</Text>
          {row.due ? (
            <View className="mt-1 flex-row items-center gap-1">
              <Icon name="alert-triangle" size={11} color={colors.warn} />
              <Text className="text-xs font-semibold text-warn">
                Due now — release it when you&apos;re satisfied it&apos;s earned
              </Text>
            </View>
          ) : null}
          {row.status === "paid" && row.paidAt != null ? (
            <Text className="mt-0.5 text-xs text-success">
              Sent {formatDateTime(row.paidAt)}
            </Text>
          ) : null}
          {row.status === "canceled" && row.canceledReason ? (
            <Text className="mt-0.5 text-xs italic text-muted">
              Canceled — {row.canceledReason}
            </Text>
          ) : null}
          {row.releaseNote ? (
            <Text className="mt-0.5 text-xs italic text-muted">
              “{row.releaseNote}”
            </Text>
          ) : null}
        </View>
        <View className="items-end gap-1">
          <Text
            className="text-sm font-semibold text-ink"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {formatCents(row.amountCents)}
          </Text>
          <Badge
            label={CONTRACTOR_INSTALLMENT_STATUS_LABELS[row.status]}
            tone={badge.tone}
            icon={badge.icon}
          />
        </View>
      </View>

      {releasable ? (
        <View className="mt-2.5 flex-row flex-wrap gap-2">
          <Button
            title="Pay by ACH"
            icon="send"
            size="sm"
            loading={busy}
            onPress={onPay}
          />
          <Button
            title="Mark paid"
            variant="secondary"
            size="sm"
            icon="check"
            onPress={onMarkPaid}
          />
          <Button
            title={expanded ? "Never mind" : "Won't be paid"}
            variant="ghost"
            size="sm"
            icon="slash"
            onPress={onToggle}
          />
        </View>
      ) : null}

      {/* Cancelling a tranche is a second click behind a disclosure rather than
          a button sitting beside Pay: the two do opposite things to somebody's
          income, and putting them side by side is how the wrong one gets hit. */}
      {releasable && expanded ? (
        <View className="mt-2 rounded-md bg-raised px-3 py-2.5">
          <Text className="mb-2 text-xs text-muted">
            Call this payment off — the contractor will not be sent it, and this
            agreement will settle for less than the agreed amount.
          </Text>
          {/* The reason is REQUIRED by the server, and it is the right call:
              the agreed total and the amount actually paid now disagree
              permanently, and a record that can't say why reads as an
              underpayment nobody can account for. */}
          <TextField
            label="Why?"
            value={reason}
            onChangeText={setReason}
            placeholder="The second shoot was cancelled"
          />
          <View className="items-start">
            <Button
              title="Cancel this payment"
              variant="ghost"
              size="sm"
              icon="slash"
              disabled={!reason.trim()}
              onPress={() => onCancel(reason.trim())}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
