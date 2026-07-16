/**
 * FINANCES · REIMBURSEMENTS — the in-app manager approval queue (Phase 3), plus
 * the no-finance-seat member's OWN reimbursements view (D3).
 *
 * Perspective resolves from `api.financeRoles.mySeats` (WP-0.2's REAL seats),
 * not the org-chart tier — same fix as the Cards tab (`cards.tsx`), for the
 * same reason: a tier=admin/lead caller with no financeRoles grant is exactly
 * the "member" this tab's D3 strip-down is for, and `api.reimbursements.list`
 * requires at least the viewer finance role, so routing on tier alone landed
 * them on a query that throws.
 *
 * **Seat holder**: the manager approval queue. Every request submitted through
 * the public /reimburse form: filter by state (All / Pre-approval / Submitted /
 * Paying), expand a request to its line items, and act on it — Reject,
 * Pre-approve, Approve all (`approve({})`), or Approve a subset of lines
 * (`approve({ approvedLineIds })`, partial approval). The backend enforces
 * separation of duties (an approver can't approve their own request); that
 * `SOD_VIOLATION` ConvexError is surfaced via the action runner.
 *
 * **No finance seat (member)**: just "submit + their own list" — a "Request a
 * reimbursement" CTA into the existing in-app submit form (`reimbursements/
 * new.tsx`, untouched — built in #133) and `api.reimbursements.myReimbursements`
 * (no finance-role gate — it's the caller's own history), the same content the
 * old Dashboard `MemberView` used to show.
 *
 * Built to `finances.html` (§ Reimbursements) and `docs/plans/finance.md`.
 */
import { useMemo, useState } from "react";
import { View, Text, Platform, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  HeaderCell,
  Narrow,
  Pill,
  Row,
  Screen,
  SectionHeader,
  Table,
  TableHeader,
  ToastView,
} from "../../../../components/ui";
import { useActionRunner } from "../../../../lib/useActionToast";
import { FinanceBoundary } from "../../../../components/finance/dashboard/parts";
import { HowItWorks } from "../../../../components/finance/reimbursements/HowItWorks";
import { RequestCard } from "../../../../components/finance/reimbursements/RequestCard";
import {
  FILTERS,
  isOpen,
  STATUS_BADGE,
  shortDate,
  type FilterKey,
} from "../../../../components/finance/reimbursements/helpers";

/** The no-finance-seat member's own reimbursements: submit + their own list.
 *  Identical content to the old Dashboard `MemberView`'s reimbursements
 *  section, just promoted to its own full tab now that members have one. */
function MemberReimbursementsScreen() {
  const router = useRouter();
  const reimbursements = useQuery(api.reimbursements.myReimbursements, {});

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <View className="mb-1">
          <Text className="font-display text-2xl text-ink">Reimbursements</Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Paid for something out of pocket? Submit a request and a finance
          manager will review and pay it by ACH.
        </Text>

        <SectionHeader
          title="My reimbursements"
          count={reimbursements?.length || undefined}
          right={
            <Button
              title="Request a reimbursement"
              size="sm"
              icon="plus"
              onPress={() => router.push("/finances/reimbursements/new")}
            />
          }
        />
        {reimbursements === undefined ? null : reimbursements.length === 0 ? (
          <EmptyState
            icon="file-text"
            title="No reimbursements yet"
            message="Paid for something out of pocket? Submit a request and a finance manager will review it."
          />
        ) : (
          <Table>
            <TableHeader>
              <HeaderCell flex={2}>Reference</HeaderCell>
              <HeaderCell width={110} align="right">
                Amount
              </HeaderCell>
              <HeaderCell width={130} align="right">
                Status
              </HeaderCell>
            </TableHeader>
            {reimbursements.map((r, i) => {
              const status = STATUS_BADGE[r.status];
              return (
                <Row key={r._id} last={i === reimbursements.length - 1}>
                  <Cell flex={2}>
                    <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                      {r.reference}
                    </Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {shortDate(r.submittedDate)} · {r.lineItemCount}{" "}
                      {r.lineItemCount === 1 ? "line item" : "line items"}
                    </Text>
                  </Cell>
                  <Cell width={110} align="right">
                    <Text className="text-sm font-semibold text-ink">
                      {formatCents(r.totalCents)}
                    </Text>
                  </Cell>
                  <Cell width={130} align="right">
                    <Badge label={r.statusBadge} tone={status.tone} icon={status.icon} />
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </Narrow>
    </Screen>
  );
}

/** Cross-platform, non-blocking notice for the info-only payout edge. */
function notify(title: string, message: string) {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

/** The seat holder's manager approval queue — all the finance-role-gated
 *  reads/writes live here, only ever mounted once `mySeats` confirms the
 *  caller holds a finance seat (see `ReimbursementsScreen` below). */
function ManagerReimbursementsScreen() {
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");

  const filter = FILTERS.find((f) => f.key === activeFilter)!;
  const rows = useQuery(api.reimbursements.list, { status: filter.status });

  // Payouts (viewer read) — used only to show a payout provider/status hint on
  // requests that have already been paid or are paying. Keyed by reimbursement.
  const payouts = useQuery(api.increase.listPayouts, {});
  const payoutByReimbursement = useMemo(() => {
    const map = new Map<
      Id<"reimbursementRequests">,
      FunctionReturnType<typeof api.increase.listPayouts>[number]
    >();
    // `listPayouts` is newest-first, so the first seen per reimbursement wins.
    for (const p of payouts ?? []) {
      if (!map.has(p.reimbursementId)) map.set(p.reimbursementId, p);
    }
    return map;
  }, [payouts]);

  const approve = useMutation(api.reimbursements.approve);
  const preApprove = useMutation(api.reimbursements.preApprove);
  const reject = useMutation(api.reimbursements.reject);
  const markPaid = useMutation(api.increase.markPaidManually);
  const { run, toast, dismiss } = useActionRunner();

  // Header "N open · $X" — non-terminal requests in the current view.
  const openStats = useMemo(() => {
    const open = (rows ?? []).filter((r) => isOpen(r.status));
    return {
      count: open.length,
      totalCents: open.reduce((sum, r) => sum + r.totalCents, 0),
    };
  }, [rows]);

  const handleApprove = (
    id: Id<"reimbursementRequests">,
    approvedLineIds?: Id<"reimbursementLineItems">[],
  ) =>
    run(() => approve({ reimbursementId: id, approvedLineIds }), {
      errorTitle: "Couldn't approve",
    }).then((res) => {
      if (res !== undefined) {
        notify(
          "Approved",
          "The ACH payout runs in a later phase — nothing has moved yet.",
        );
      }
    });

  const handlePreApprove = (id: Id<"reimbursementRequests">) =>
    run(() => preApprove({ reimbursementId: id }), {
      errorTitle: "Couldn't pre-approve",
    }).then(() => {});

  const handleReject = (id: Id<"reimbursementRequests">) =>
    run(() => reject({ reimbursementId: id }), {
      errorTitle: "Couldn't reject",
    }).then(() => {});

  // Pay an approved request. The working Phase-4 path is a manual payout
  // (`markPaidManually`): it marks the request `paid` and posts the ledger
  // transfer, so the list re-queries the card into a read-only paid state.
  // ACH auto-payout via Increase is a follow-up (destination-bank capture).
  const handleMarkPaid = (id: Id<"reimbursementRequests">) =>
    run(() => markPaid({ reimbursementId: id }), {
      errorTitle: "Couldn't mark paid",
    }).then(() => {});

  const loading = rows === undefined;

  return (
    <>
      <Screen maxWidth={1080}>
        <Narrow>
          {/* Header — queue title + "N open · $X". */}
          <View className="mb-1 flex-row items-baseline gap-2">
            <Text className="font-display text-2xl text-ink">Reimbursements</Text>
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {openStats.count} open · {formatCents(openStats.totalCents)}
            </Text>
          </View>
          <Text className="mb-4 text-sm text-muted">
            Approve what volunteers and card-less team members spent, then pay
            them by ACH from the chapter's Increase account.
          </Text>

          {/* Filter pills → list({status}). */}
          <View className="mb-4 flex-row flex-wrap gap-2">
            {FILTERS.map((f) => (
              <Pill
                key={f.key}
                label={f.label}
                selected={activeFilter === f.key}
                onPress={() => setActiveFilter(f.key)}
              />
            ))}
          </View>

          {/* Queue. */}
          {loading ? (
            <EmptyState title="Loading requests…" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="inbox"
              title="No requests in this view"
              message={
                activeFilter === "all"
                  ? "Submitted reimbursements appear here for a finance manager to approve and pay by ACH."
                  : "Nothing matches this filter right now. Try another."
              }
            />
          ) : (
            <View>
              {rows.map((row) => (
                <RequestCard
                  key={row._id}
                  row={row}
                  payout={payoutByReimbursement.get(row._id)}
                  onApprove={handleApprove}
                  onPreApprove={handlePreApprove}
                  onReject={handleReject}
                  onMarkPaid={handleMarkPaid}
                />
              ))}
            </View>
          )}

          {/* How it works — the submit → approve → payout explainer. */}
          <SectionHeader title="How reimbursements work" />
          <HowItWorks />
        </Narrow>
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Finance access needed"
      message="Ask a finance manager to grant you access to the reimbursements queue."
    />
  );
}

/** Perspective resolves from the caller's REAL finance seats (D3) — a seat
 *  holder gets the manager approval queue, no seat gets their own submit +
 *  history view. See the file-header comment for the tier-vs-seat rationale. */
export default function ReimbursementsScreen() {
  const seats = useQuery(api.financeRoles.mySeats, {});

  if (seats === undefined) return <Screen loading />;

  if (seats.length === 0) {
    return <MemberReimbursementsScreen />;
  }

  return (
    <FinanceBoundary fallback={<NoFinanceAccess />}>
      <ManagerReimbursementsScreen />
    </FinanceBoundary>
  );
}
