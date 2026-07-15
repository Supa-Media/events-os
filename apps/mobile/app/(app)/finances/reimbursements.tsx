/**
 * FINANCES · REIMBURSEMENTS — the in-app manager approval queue (Phase 3).
 *
 * Replaces the Phase-1 shell now that `api.reimbursements` is live. Managers see
 * every request submitted through the public /reimburse form: filter by state
 * (All / Pre-approval / Submitted / Paying), expand a request to its line items,
 * and act on it — Reject, Pre-approve, Approve all (`approve({})`), or Approve a
 * subset of lines (`approve({ approvedLineIds })`, partial approval). The
 * backend enforces separation of duties (an approver can't approve their own
 * request); that `SOD_VIOLATION` ConvexError is surfaced via the action runner.
 *
 * Guarded admin-or-lead in-screen (mirrors the finances nav gate); the finer
 * finance-role check runs server-side on every query/mutation. Built to
 * `finances.html` (§ Reimbursements) and `docs/plans/finance.md`.
 */
import { useMemo, useState } from "react";
import { View, Text, Platform, Alert } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { formatCents } from "@events-os/shared";
import {
  EmptyState,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
  ToastView,
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { HowItWorks } from "../../../components/finance/reimbursements/HowItWorks";
import { RequestCard } from "../../../components/finance/reimbursements/RequestCard";
import {
  FILTERS,
  isOpen,
  type FilterKey,
} from "../../../components/finance/reimbursements/helpers";

/** Cross-platform, non-blocking notice for the info-only payout edge. */
function notify(title: string, message: string) {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

export default function ReimbursementsScreen() {
  const org = useQuery(api.org.nav);
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

  // In-screen guard: approving reimbursements is a finance-manager action
  // (admin or lead for now, mirroring the nav gate).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Reimbursements are restricted"
            message="Only chapter admins and finance managers can review reimbursement requests."
          />
        </Narrow>
      </Screen>
    );
  }

  if (org === undefined) return <Screen loading />;

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
