/**
 * FINANCES · REIMBURSEMENTS — the in-app manager approval queue (Phase 3), plus
 * the no-finance-seat member's OWN bidirectional owe view (D3 + D4).
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
 * `SOD_VIOLATION` ConvexError is surfaced via the action runner. Also shows a
 * "personal charges outstanding" tile (D4) — `api.cards.personalRepaymentsOutstanding`,
 * the same aggregate the manager Cards view's "Personal to repay" tile uses.
 *
 * **No finance seat (member)**: two clear directions (D4), plus submit:
 *  - "You owe Public Worship" — `OwedBanner` (shared with the Cards-tab owe
 *    banner; see its doc comment), sourced from `api.cards.myPersonalRepayments`.
 *  - "Public Worship owes you" — their OPEN reimbursements (submitted /
 *    preapproved / approved / paying), grouped from the same
 *    `api.reimbursements.myReimbursements` read the old Dashboard `MemberView`
 *    used (no finance-role gate — it's the caller's own history).
 *  - "History" — their terminal reimbursements (paid / rejected / failed /
 *    canceled), same data, filtered the other way, so nothing that used to be
 *    visible on this screen disappears.
 *  - "Request a reimbursement" CTA into the existing in-app submit form
 *    (`reimbursements/new.tsx`, untouched — built in #133).
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
import { OwedBanner } from "../../../../components/finance/cards/OwedBanner";
import { CardTile } from "../../../../components/finance/cards/CardTile";
import {
  FILTERS,
  isOpen,
  isOwedToMember,
  STATUS_BADGE,
  shortDate,
  type FilterKey,
} from "../../../../components/finance/reimbursements/helpers";

type MyReimbursement = FunctionReturnType<
  typeof api.reimbursements.myReimbursements
>[number];

/** A reimbursements table — shared between the "Public Worship owes you" and
 *  "History" sections below (identical shape, different status filter). */
function ReimbursementTable({ rows }: { rows: MyReimbursement[] }) {
  return (
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
      {rows.map((r, i) => {
        const status = STATUS_BADGE[r.status];
        return (
          <Row key={r._id} last={i === rows.length - 1}>
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
  );
}

/** The no-finance-seat member's bidirectional owe view (D4): "You owe Public
 *  Worship" (personal-charge repayments, the Cards-tab twin) and "Public
 *  Worship owes you" (their own open reimbursements) — plus a History section
 *  and the "Request a reimbursement" submit CTA, exactly as the old Dashboard
 *  `MemberView` offered. */
function MemberReimbursementsScreen() {
  const router = useRouter();
  const reimbursements = useQuery(api.reimbursements.myReimbursements, {});
  // Only for the section header's count/empty-state — `OwedBanner` re-reads
  // this same query itself (Convex dedupes the subscription; see its doc
  // comment for why the pay-back flow lives there and not here).
  const myRepayments = useQuery(api.cards.myPersonalRepayments, {});
  const owedToMe = myRepayments?.filter((r) => r.status !== "paid");

  const owedToMember = reimbursements?.filter((r) => isOwedToMember(r.status));
  const history = reimbursements?.filter((r) => !isOwedToMember(r.status));

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <View className="mb-1 flex-row items-center justify-between">
          <Text className="font-display text-2xl text-ink">Reimbursements</Text>
          <Button
            title="Request a reimbursement"
            size="sm"
            icon="plus"
            onPress={() => router.push("/finances/reimbursements/new")}
          />
        </View>
        <Text className="mb-4 text-sm text-muted">
          Paid for something out of pocket? Submit a request and a finance
          manager will review and pay it by ACH.
        </Text>

        {/* "You owe Public Worship" — flagged personal-card charges. Shared
            banner + pay-back flow with the Cards tab (`OwedBanner`). */}
        <SectionHeader
          title="You owe Public Worship"
          count={owedToMe?.length || undefined}
        />
        {owedToMe === undefined ? null : owedToMe.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing outstanding"
            message="No personal charges are flagged against your card right now."
          />
        ) : (
          <OwedBanner />
        )}

        {/* "Public Worship owes you" — open reimbursement requests. */}
        <SectionHeader
          title="Public Worship owes you"
          count={owedToMember?.length || undefined}
        />
        {owedToMember === undefined ? null : owedToMember.length === 0 ? (
          <EmptyState
            icon="file-text"
            title="Nothing pending"
            message="Paid for something out of pocket? Submit a request and a finance manager will review it."
          />
        ) : (
          <ReimbursementTable rows={owedToMember} />
        )}

        {/* History — paid / rejected / failed / canceled. */}
        {history && history.length > 0 ? (
          <>
            <SectionHeader title="History" count={history.length} />
            <ReimbursementTable rows={history} />
          </>
        ) : null}
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

  // "Personal charges outstanding" (D4) — the same chapter-scope aggregate the
  // manager Cards view's "Personal to repay" tile uses. Reimbursements doesn't
  // own personal-charge repayments (Cards does); this is purely a heads-up
  // pointer over to the Cards tab, not a duplicate data model.
  const personalToRepay = useQuery(api.cards.personalRepaymentsOutstanding, {});

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

          {/* "Personal charges outstanding" (D4) — same aggregate as the
              manager Cards view's "Personal to repay" tile. */}
          <View className="mb-4 flex-row flex-wrap gap-3">
            <CardTile
              label="Personal charges outstanding"
              value={
                personalToRepay === undefined
                  ? undefined
                  : formatCents(personalToRepay.totalCents)
              }
              valueClassName={
                personalToRepay && personalToRepay.count > 0
                  ? "text-warn"
                  : "text-ink"
              }
              meta={
                personalToRepay === undefined
                  ? "flagged card charges"
                  : `${personalToRepay.count} on the Cards tab`
              }
            />
          </View>

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
