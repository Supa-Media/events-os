/**
 * PersonalChargesView — the screen behind the `/finances/personal-charges`
 * route (a thin re-export), i.e. the drill-in behind the "Personal charges
 * outstanding" / "Personal to repay" tiles on the Reimbursements and Cards
 * tabs.
 *
 * Founder feedback that created this screen: "it shows the things flagged as
 * personal expenses, but there's no way for me to click and see the line items
 * or even pay it off." Both tiles were dead numbers — the rows behind them
 * existed only in the Reconcile grid's `personal_unpaid` pill, which can flag
 * and un-flag but has no way to SETTLE one, and `cards.markRepaymentPaid` had
 * no caller in the app at all. This screen is that missing surface:
 *
 *  - **Outstanding** — every flagged, not-yet-repaid charge: who owes it, the
 *    merchant and date, the amount, and whether a payment is already in
 *    flight. A manager can "Un-mark" a mis-flag.
 *  - **Repaid** — the settled history, so a payment visibly LANDS somewhere
 *    instead of the row just vanishing.
 *
 * ── THIS SCREEN CANNOT SETTLE A DEBT (founder, 2026-08-14) ──────────────────
 * "We should only mark repaid when you actually pay through the platform. No
 * manual mark as paid."
 *
 * It used to carry a "Mark repaid" button (confirm-first, via a modal) backed
 * by `cards.markRepaymentPaid`. Both are deleted. A repayment reaches `paid`
 * only when a rail this app started reports money landing — Stripe Checkout
 * today, the Increase debit when its bounce handling exists — which is what
 * makes a settled row provable rather than remembered, and what removes the
 * race where a manager cleared a debt while its payer sat in checkout.
 *
 * So this is a COLLECTIONS desk, not a settlement one. What a manager can
 * still do here is un-flag a charge that was never personal, which reverses
 * the flag rather than asserting a payment. Someone who genuinely handed over
 * cash pays through the app instead; there is deliberately no button for
 * asserting otherwise.
 *
 * Reads `api.cards.listPersonalRepayments` (viewer+); un-flagging is
 * manager-gated server-side and hidden here for a non-manager rather than
 * offered as a button that throws.
 *
 * A MEMBER paying their OWN charge doesn't come here — that's
 * `/finances/repayments`. This is the collection side of the same debt.
 */
import { useMemo, useState } from "react";
import { Alert, Platform, Text, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { formatCents } from "@events-os/shared";
import {
  Avatar,
  BackLink,
  Badge,
  Button,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  ToastView,
} from "../../ui";
import { FinanceBoundary } from "../dashboard/parts";
import { shortDate } from "../reimbursements/helpers";
import { useActionRunner } from "../../../lib/useActionToast";

/** Cross-platform "here's what happened" notice. `useActionRunner` surfaces
 *  FAILURES only; the reminder batch's outcome is a success worth reporting
 *  precisely (see `handleNudge`), so it gets its own notice rather than a
 *  silent completion that leaves a manager guessing how many went out. */
function notifyResult(message: string) {
  if (Platform.OS === "web") window.alert(message);
  else Alert.alert("Reminders sent", message);
}

type Repayment = FunctionReturnType<
  typeof api.cards.listPersonalRepayments
>[number];

/** Status → badge, over all four `REPAYMENT_STATUSES`. Each of the three
 *  unpaid ones is called out separately because each is a different
 *  conversation: nobody has started (`pending`), the bank is still moving it
 *  (`processing`), or an attempt bounced (`failed`). */
function statusBadge(
  r: Repayment,
): { label: string; tone: "warn" | "danger" | "success" | "info" } {
  if (r.status === "paid") return { label: "Repaid", tone: "success" };
  if (r.status === "failed") return { label: "Payment failed", tone: "danger" };
  // A bank debit the payer has authorised and the bank hasn't yet delivered.
  // Its own badge on purpose: a collector chasing this row would be chasing
  // somebody who has already paid, which is the fastest way to make the
  // person who did the right thing feel accused.
  if (r.status === "processing") return { label: "Clearing", tone: "info" };
  return { label: "Owed", tone: "warn" };
}

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Finance access needed"
      message="Ask a finance manager to grant you access to the chapter's personal charges."
    />
  );
}

function RepaymentRow({
  row,
  isManager,
  onUnmark,
  onRemind,
  busy,
  isLast,
}: {
  row: Repayment;
  isManager: boolean;
  onUnmark: () => void;
  onRemind: () => void;
  busy: boolean;
  isLast: boolean;
}) {
  const badge = statusBadge(row);
  const settled = row.status === "paid";
  return (
    <View
      className={`gap-2 px-4 py-3 ${isLast ? "" : "border-b border-border"}`}
    >
      <View className="flex-row flex-wrap items-center gap-3">
        <Avatar name={row.payerName} uri={row.payerImageUrl} size={32} />
        <View className="min-w-[140px] flex-1">
          <Text className="font-semibold text-ink">{row.payerName}</Text>
          <Text className="text-xs text-muted">
            {row.merchantName ?? row.description ?? "Card charge"} ·{" "}
            {shortDate(row.postedAt)}
          </Text>
        </View>
        <Text
          className="text-sm font-semibold text-ink"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(row.amountCents)}
        </Text>
        <Badge label={badge.label} tone={badge.tone} />
      </View>

      {/* The one action left — manager only, and the server gates it again
          regardless. A settled row keeps none: `unflagPersonalCharge` refuses
          once the credit is posted. */}
      {isManager && !settled ? (
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text className="text-2xs text-faint">
            {row.status === "processing"
              ? "Bank payment clearing — usually about 4 business days"
              : row.status === "failed"
                ? "Their last payment attempt was refused"
                : "Not paid yet"}
            {" · flagged "}
            {shortDate(row.flaggedAt)}
            {row.lastNudgedAt ? ` · reminded ${shortDate(row.lastNudgedAt)}` : ""}
          </Text>
          <View className="flex-row gap-2">
            <View className="flex-row flex-wrap items-center gap-2">
              {/* Chasing ONE person, from the row you're looking at. The
                  batch button at the top is for a sweep; this is for "I'm
                  looking at Dana's $101 right now and I want to send her the
                  link." Both go through the same cooldown, so using one after
                  the other can't double-email anybody. Hidden once a bank
                  transfer is clearing — they've already paid. */}
              {row.status !== "processing" ? (
                <Button
                  title="Send pay link"
                  variant="secondary"
                  size="sm"
                  icon="send"
                  disabled={busy}
                  onPress={onRemind}
                />
              ) : null}
              {/* Un-flagging is the only write left here — see the file
                  header on why there is no "Mark repaid". */}
              <Button
                title="Not personal"
                variant="ghost"
                size="sm"
                icon="rotate-ccw"
                disabled={busy}
                onPress={onUnmark}
              />
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PersonalChargesBody() {
  const rows = useQuery(api.cards.listPersonalRepayments, {});
  const seats = useQuery(api.financeRoles.mySeats, {}) ?? [];
  // Same manager test the Reconcile grid uses for its own manager-only row
  // actions (`reconcile.tsx`) — a bookkeeper reads this screen but doesn't
  // settle debts.
  const isManager = seats.some((s) => s.role === "manager");

  const unflag = useMutation(api.cards.unflagPersonalCharge);
  // Chasing is a rung above reading this screen (`lib/repaymentsAccess.ts`) —
  // a reminder is an outbound email with somebody's name and an amount on it.
  const nudge = useAction(api.cards.nudgeOutstandingRepayments);
  const { run, toast, dismiss } = useActionRunner();
  const [nudging, setNudging] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);

  const { outstanding, repaid, owedCents } = useMemo(() => {
    const all = rows ?? [];
    const out = all.filter((r) => r.status !== "paid");
    return {
      outstanding: out,
      repaid: all.filter((r) => r.status === "paid"),
      owedCents: out.reduce((sum, r) => sum + r.amountCents, 0),
    };
  }, [rows]);

  /** Fire the reminder batch and report what actually happened — a toast that
   *  said "sent" while three people were skipped would make the cooldown feel
   *  like a bug. */
  async function handleNudge() {
    setNudging(true);
    const result = await run(() => nudge({}), {
      errorTitle: "Couldn't send reminders",
    });
    setNudging(false);
    if (!result) return;
    const parts = [`${result.notified} reminded`];
    if (result.cooledDown > 0) {
      parts.push(`${result.cooledDown} skipped (reminded recently)`);
    }
    if (result.unreachable > 0) parts.push(`${result.unreachable} with no email`);
    if (result.failed > 0) parts.push(`${result.failed} failed to send`);
    notifyResult(parts.join(" · "));
  }

  /** Email ONE person their own pay link. Same action, same cooldown, as the
   *  batch button — `payerPersonId` just narrows who it reaches. */
  async function handleRemind(row: Repayment) {
    setBusyId(row.id);
    const result = await run(() => nudge({ payerPersonId: row.payerPersonId }), {
      errorTitle: "Couldn't send the link",
    });
    setBusyId(null);
    if (!result) return;
    notifyResult(
      result.notified > 0
        ? `Sent ${row.payerName} a link to pay.`
        : result.cooledDown > 0
          ? `${row.payerName} was reminded in the last few days — not sending another yet.`
          : result.unreachable > 0
            ? `${row.payerName} has no email address on file.`
            : "Nothing to send.",
    );
  }

  async function handleUnmark(row: Repayment) {
    setBusyId(row.id);
    await run(
      () => unflag({ transactionId: row.transactionId as Id<"transactions"> }),
      { errorTitle: "Couldn't un-mark this charge" },
    );
    setBusyId(null);
  }

  if (rows === undefined) {
    return <Text className="text-sm text-muted">Loading personal charges…</Text>;
  }

  return (
    <>
      <View>
        <BackLink fallback="/finances/cards" label="Back to Cards" />
        <View className="mb-1 mt-2 flex-row items-baseline gap-2">
          <Text className="font-display text-2xl text-ink">
            Personal charges
          </Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {outstanding.length} outstanding · {formatCents(owedCents)}
          </Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Charges on chapter cards that turned out to be personal — flagged by
          the cardholder or by a manager, and owed back to Public Worship. The
          cardholder pays from their own card or bank on their repayments page;
          a charge clears here on its own the moment that payment lands.
        </Text>

        {/* Chasing, in one button. Emails everyone who owes — ONE message per
            person listing all their charges, never one per charge — and skips
            anybody already reminded in the last few days or whose bank
            transfer is already clearing. See
            `cards.nudgeOutstandingRepayments`. */}
        {isManager && outstanding.length > 0 ? (
          <View className="mb-4 flex-row flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-raised px-4 py-3">
            <Text className="flex-1 text-xs text-muted">
              Send everyone who owes a reminder with what they owe and a link
              to pay it. One email per person, and nobody gets chased twice in
              the same few days.
            </Text>
            <Button
              title="Send reminders"
              size="sm"
              icon="send"
              loading={nudging}
              onPress={() => void handleNudge()}
            />
          </View>
        ) : null}

        {/* The founder's second question, answered on the screen itself
            rather than only in the confirm modal. */}
        <View className="mb-4 rounded-lg border border-border bg-sunken px-4 py-3">
          <Text className="text-xs text-muted">
            <Text className="font-semibold text-ink">
              What happens when it's repaid:
            </Text>{" "}
            nothing gets deleted. The charge stays on the ledger with its
            receipt and coding intact, and an offsetting credit is posted
            against it — the two net to zero in category and budget spend. The
            row shows “Repaid” in Reconcile and leaves the outstanding total.
          </Text>
        </View>

        <SectionHeader
          title="Outstanding"
          count={outstanding.length || undefined}
        />
        {outstanding.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing outstanding"
            message="No personal charges are waiting to be paid back."
          />
        ) : (
          <View className="mb-1 overflow-hidden rounded-lg border border-border bg-raised shadow-card">
            {outstanding.map((r, i) => (
              <RepaymentRow
                key={r.id}
                row={r}
                isManager={isManager}
                busy={busyId === r.id}
                isLast={i === outstanding.length - 1}
                onRemind={() => void handleRemind(r)}
                onUnmark={() => void handleUnmark(r)}
              />
            ))}
          </View>
        )}

        {repaid.length > 0 ? (
          <>
            <SectionHeader title="Repaid" count={repaid.length} />
            <View className="mb-1 overflow-hidden rounded-lg border border-border bg-raised shadow-card">
              {repaid.map((r, i) => (
                <RepaymentRow
                  key={r.id}
                  row={r}
                  isManager={isManager}
                  busy={false}
                  isLast={i === repaid.length - 1}
                  onRemind={() => {}}
                  onUnmark={() => {}}
                />
              ))}
            </View>
          </>
        ) : null}
      </View>

      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

export function PersonalChargesView() {
  // `listPersonalRepayments` is viewer+ gated server-side; catch the role
  // throw locally instead of blanking the screen (same pattern as the Cards
  // tab's manager view).
  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <FinanceBoundary fallback={<NoFinanceAccess />}>
          <PersonalChargesBody />
        </FinanceBoundary>
      </Narrow>
    </Screen>
  );
}
