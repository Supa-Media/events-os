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
 *    merchant and date, the amount, and whether they've linked a bank account
 *    for the ACH rail. A manager can "Mark repaid" (confirm-first —
 *    `MarkRepaidModal`) or "Un-mark" a mis-flag.
 *  - **Repaid** — the settled history, so a confirmation visibly LANDS
 *    somewhere instead of the row just vanishing.
 *
 * Reads `api.cards.listPersonalRepayments` (viewer+). Settling is
 * manager-only server-side (`markRepaymentPaid` — a member must not be able to
 * flag their own charge and then zero it out); this screen hides the write
 * affordances for a non-manager rather than offering buttons that throw.
 *
 * A MEMBER paying their OWN charge doesn't come here — that's `OwedBanner`
 * ("Pay by card" / "Pay by bank (ACH)") on the Cards and Reimbursements tabs.
 * This is the collection side of the same debt.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
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
import { MarkRepaidModal } from "../modals/MarkRepaidModal";
import { shortDate } from "../reimbursements/helpers";
import { useActionRunner } from "../../../lib/useActionToast";

type Repayment = FunctionReturnType<
  typeof api.cards.listPersonalRepayments
>[number];

/** Status → badge, over the three `REPAYMENT_STATUSES`. `failed` is called out
 *  separately from plain `pending`: an attempted repayment that bounced needs
 *  a different conversation than one nobody has started yet. */
function statusBadge(
  r: Repayment,
): { label: string; tone: "warn" | "danger" | "success" } {
  if (r.status === "paid") return { label: "Repaid", tone: "success" };
  if (r.status === "failed") return { label: "Payment failed", tone: "danger" };
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
  onMarkRepaid,
  onUnmark,
  busy,
  isLast,
}: {
  row: Repayment;
  isManager: boolean;
  onMarkRepaid: () => void;
  onUnmark: () => void;
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

      {/* Actions — manager only (the server gates both again regardless). A
          settled row keeps no actions: `unflagPersonalCharge` refuses once the
          credit is posted, and re-confirming a paid repayment is a no-op. */}
      {isManager && !settled ? (
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text className="text-2xs text-faint">
            {row.hasExternalAccount
              ? "Bank account linked for ACH"
              : "No bank account linked yet"}
            {" · flagged "}
            {shortDate(row.flaggedAt)}
          </Text>
          <View className="flex-row gap-2">
            <Button
              title="Un-mark"
              variant="ghost"
              size="sm"
              disabled={busy}
              onPress={onUnmark}
            />
            <Button
              title="Mark repaid"
              size="sm"
              icon="check"
              disabled={busy}
              onPress={onMarkRepaid}
            />
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

  const markRepaid = useMutation(api.cards.markRepaymentPaid);
  const unflag = useMutation(api.cards.unflagPersonalCharge);
  const { run, toast, dismiss } = useActionRunner();

  const [confirming, setConfirming] = useState<Repayment | null>(null);
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

  async function confirmMarkRepaid() {
    if (!confirming) return;
    const id = confirming.id;
    setBusyId(id);
    await run(() => markRepaid({ repaymentId: id }), {
      errorTitle: "Couldn't mark it repaid",
      onSuccess: () => setConfirming(null),
    });
    setBusyId(null);
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
          cardholder pays from their own card or bank on their Cards tab; you
          confirm the money arrived here.
        </Text>

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
                onMarkRepaid={() => setConfirming(r)}
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
                  onMarkRepaid={() => {}}
                  onUnmark={() => {}}
                />
              ))}
            </View>
          </>
        ) : null}
      </View>

      {confirming ? (
        <MarkRepaidModal
          payerName={confirming.payerName}
          amount={formatCents(confirming.amountCents)}
          submitting={busyId === confirming.id}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void confirmMarkRepaid()}
        />
      ) : null}
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
