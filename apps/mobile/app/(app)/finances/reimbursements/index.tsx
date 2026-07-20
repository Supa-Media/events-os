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
 * A seat holder is ALSO a chapter member who can incur their own out-of-pocket
 * spend, so the queue header carries the same "Request a reimbursement"/"Share
 * request link" CTAs the member view offers below — this view has no OWN
 * request/history section (they use `myReimbursements` from the member
 * perspective if they ever switch seats, same as anyone else).
 *
 * **No finance seat (member)**: two clear directions (D4), plus submit:
 *  - "You owe Public Worship" — `OwedBanner` (shared with the Cards-tab owe
 *    banner; see its doc comment), sourced from `api.cards.myPersonalRepayments`.
 *  - "Public Worship owes you" — their non-terminal reimbursements (pending
 *    pre-approval / submitted / preapproved / approved / paying / failed —
 *    see `OWED_TO_MEMBER_STATUSES`'s doc comment for why `pending_preapproval`
 *    and `failed` both live here, not in History), grouped from the same
 *    `api.reimbursements.myReimbursements` read the old Dashboard `MemberView`
 *    used (no finance-role gate — it's the caller's own history).
 *  - "History" — their terminal reimbursements (paid / rejected / canceled —
 *    `isTerminal`/`REIMBURSEMENT_TERMINAL_STATUSES`, the codebase's one source
 *    of truth for "finished"), same data, filtered the other way, so nothing
 *    that used to be visible on this screen disappears.
 *  - "Request a reimbursement" CTA into the shared `ReimbursementRequestForm`
 *    (`components/finance/reimbursements/RequestForm.tsx`, built in #133,
 *    extracted + given an optional "For" event/project picker here).
 *  - "Share request link" — copies/shares the `/reimburse-request` page (a
 *    sign-in-gated standalone form for anyone who hasn't found this tab yet).
 *
 * Built to `finances.html` (§ Reimbursements) and `docs/plans/finance.md`.
 */
import { useMemo, useState } from "react";
import { View, Text, Platform, Alert, Share } from "react-native";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useAction } from "convex/react";
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
  isTerminal,
  STATUS_BADGE,
  shortDate,
  type FilterKey,
} from "../../../../components/finance/reimbursements/helpers";

type MyReimbursement = FunctionReturnType<
  typeof api.reimbursements.myReimbursements
>[number];

/** Cross-platform, non-blocking notice for the info-only payout edge (and the
 *  "link copied" confirmation below). */
function notify(title: string, message: string) {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

/** After a successful `api.increase.payReimbursement` call, tell the manager
 *  plainly whether the ACH transfer actually started or the request degraded
 *  to the manual fallback (no linked destination / no active Increase account
 *  / Increase env not wired) — never a fake "paid". Shared by the auto-pay
 *  follow-up in `handleApprove` and the explicit "Pay by ACH" retry. */
function notifyPayoutOutcome(payout: { provider: string; status: string }) {
  if (payout.provider === "increase" && payout.status === "processing") {
    notify(
      "Paying",
      "ACH transfer initiated from the chapter's Increase account.",
    );
  } else {
    notify(
      "Couldn't pay by ACH automatically",
      "This request needs a manual payout — send the transfer from the chapter's Increase account, then use \"Mark paid\" (or retry \"Pay by ACH\" once the destination/account issue is fixed).",
    );
  }
}

/** The `/reimburse-request` share-link page's URL. Web: the current origin —
 *  the page lives in this SAME Expo app, so wherever it's being viewed from
 *  IS where the link resolves (mirrors `EventHeader.tsx`'s `shareCrew` link).
 *  Native has no equivalent "this app's own web origin" signal, so it falls
 *  back to the app's own URL scheme (`Linking.createURL` — openable only by
 *  someone who already has the app installed; there's no universal-link
 *  domain configured yet, see `app.config.js`'s `intentFilters`). */
function reimburseRequestUrl(): string {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `${window.location.origin}/reimburse-request`;
  }
  return Linking.createURL("/reimburse-request");
}

/** "Share request link" — copies (web) or opens the native share sheet
 *  (native) for the reimbursement request page, so a member can text/email it
 *  to someone who hasn't found it in the app yet. */
async function shareRequestLink() {
  const url = reimburseRequestUrl();
  if (Platform.OS === "web") {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      notify("Link copied", url);
    } else if (typeof window !== "undefined") {
      window.prompt("Share this reimbursement request link:", url);
    }
    return;
  }
  try {
    await Share.share({ message: url });
  } catch {
    // User dismissed the share sheet — nothing to do.
  }
}

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
  // `OwedBanner` tracks its own "initiated this session" state that this raw
  // filter can't see — after initiating the LAST repayment, `owedToMe` still
  // shows a stale count/section while the banner itself renders nothing. This
  // mirrors the banner's reported emptiness (via `onEmptyChange`) so the
  // header + section hide together with it instead of drifting out of sync.
  const [owedBannerEmpty, setOwedBannerEmpty] = useState(false);
  const owedEmpty =
    owedToMe === undefined ? undefined : owedToMe.length === 0 || owedBannerEmpty;

  const owedToMember = reimbursements?.filter((r) => isOwedToMember(r.status));
  // History = the codebase's terminal source of truth (paid/rejected/canceled
  // — see `isTerminal`/`REIMBURSEMENT_TERMINAL_STATUSES`), NOT `!isOwedToMember`.
  // `pending_preapproval` and `failed` are both non-terminal — they belong in
  // "owes you" (see `OWED_TO_MEMBER_STATUSES`'s doc comment) — so a plain NOT
  // would have wrongly dropped them into History next to paid/rejected.
  const history = reimbursements?.filter((r) => isTerminal(r.status));

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <View className="mb-1 flex-row items-center justify-between gap-2">
          <Text className="font-display text-2xl text-ink">Reimbursements</Text>
          <View className="flex-row gap-2">
            <Button
              title="Share request link"
              variant="secondary"
              size="sm"
              icon="share"
              onPress={() => void shareRequestLink()}
            />
            <Button
              title="Request a reimbursement"
              size="sm"
              icon="plus"
              onPress={() => router.push("/finances/reimbursements/new")}
            />
          </View>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Paid for something out of pocket? Submit a request and a finance
          manager will review and pay it by ACH.
        </Text>

        {/* "You owe Public Worship" — flagged personal-card charges. Shared
            banner + pay-back flow with the Cards tab (`OwedBanner`). */}
        <SectionHeader
          title="You owe Public Worship"
          count={owedEmpty ? undefined : owedToMe?.length}
        />
        {owedEmpty === undefined ? null : owedEmpty ? (
          <EmptyState
            icon="check"
            title="Nothing outstanding"
            message="No personal charges are flagged against your card right now."
          />
        ) : null}
        {/* Stays mounted whenever anything is (raw-)owed, independent of
            `owedEmpty` — its own effect is what flips `owedEmpty` true/false
            above as its "initiated this session" state changes, and re-syncs
            itself the moment a NEW charge is flagged. */}
        {owedToMe !== undefined && owedToMe.length > 0 ? (
          <OwedBanner onEmptyChange={setOwedBannerEmpty} />
        ) : null}

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

/** The seat holder's manager approval queue — all the finance-role-gated
 *  reads/writes live here, only ever mounted once `mySeats` confirms the
 *  caller holds a finance seat (see `ReimbursementsScreen` below). */
function ManagerReimbursementsScreen() {
  const router = useRouter();
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

  // Whether "Approve & pay" should auto-initiate the ACH payout right after
  // approving (`approvalPolicy.autoPayOnApproval`, defaults ON — see
  // `api.reimbursements.autoPayEnabled`'s doc comment). `undefined` while
  // loading; `handleApprove` treats that the same as `true` (auto-pay is the
  // default, and the query resolves almost immediately after `mySeats`/`list`
  // already have).
  const autoPayEnabled = useQuery(api.reimbursements.autoPayEnabled, {});
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
  const payReimbursement = useAction(api.increase.payReimbursement);
  const { run, toast, dismiss } = useActionRunner();

  // Header "N open · $X" — non-terminal requests in the current view.
  const openStats = useMemo(() => {
    const open = (rows ?? []).filter((r) => isOpen(r.status));
    return {
      count: open.length,
      totalCents: open.reduce((sum, r) => sum + r.totalCents, 0),
    };
  }, [rows]);

  // Approve (full "Approve & pay" or a partial "Approve lines…" selection),
  // then — unless the chapter has opted out via
  // `approvalPolicy.autoPayOnApproval:false` — immediately follow with
  // `api.increase.payReimbursement` to auto-initiate the ACH payout. The
  // approve step already committed independently by the time we get here:
  // if the payout call fails (Increase down, no env key, no linked
  // destination) it degrades to a `manual`/`pending` payout server-side and
  // the request STAYS `approved` — `run`'s error toast (or
  // `notifyPayoutOutcome`'s honest fallback notice) tells the manager to use
  // "Mark paid" / retry "Pay by ACH" instead of silently pretending it paid.
  const handleApprove = (
    id: Id<"reimbursementRequests">,
    approvedLineIds?: Id<"reimbursementLineItems">[],
  ) =>
    run(() => approve({ reimbursementId: id, approvedLineIds }), {
      errorTitle: "Couldn't approve",
    }).then(async (res) => {
      if (res === undefined) return; // approve itself failed — already surfaced.
      if (autoPayEnabled === false) {
        notify(
          "Approved",
          "Automatic ACH payout is turned off for this chapter — send the transfer from the chapter's Increase account, then use \"Mark paid\".",
        );
        return;
      }
      const payout = await run(() => payReimbursement({ reimbursementId: id }), {
        errorTitle: "Approved, but the ACH payout couldn't start",
      });
      if (payout !== undefined) notifyPayoutOutcome(payout);
    });

  const handlePreApprove = (id: Id<"reimbursementRequests">) =>
    run(() => preApprove({ reimbursementId: id }), {
      errorTitle: "Couldn't pre-approve",
    }).then(() => {});

  const handleReject = (id: Id<"reimbursementRequests">) =>
    run(() => reject({ reimbursementId: id }), {
      errorTitle: "Couldn't reject",
    }).then(() => {});

  // Pay an approved request by hand — the fallback for when auto-pay (above)
  // couldn't start the ACH transfer (no linked destination, no active
  // Increase account, or Increase itself unreachable). Marks the request
  // `paid` and posts the ledger transfer, so the list re-queries the card
  // into a read-only paid state.
  const handleMarkPaid = (id: Id<"reimbursementRequests">) =>
    run(() => markPaid({ reimbursementId: id }), {
      errorTitle: "Couldn't mark paid",
    }).then(() => {});

  // Retry the ACH payout on a request stuck `approved` because auto-pay
  // didn't take the real branch (idempotent — `beginPayout` never double-pays,
  // so this is safe to press again after fixing whatever degraded it, e.g.
  // linking a destination or bringing Increase back).
  const handleRetryPayout = (id: Id<"reimbursementRequests">) =>
    run(() => payReimbursement({ reimbursementId: id }), {
      errorTitle: "Couldn't start the ACH payout",
    }).then((payout) => {
      if (payout !== undefined) notifyPayoutOutcome(payout);
    });

  const loading = rows === undefined;

  return (
    <>
      <Screen maxWidth={1080}>
        <Narrow>
          {/* Header — queue title + "N open · $X", plus a seat holder's own
              submit CTAs (they're a chapter member too — see the file header
              comment on the D3/D4 split). */}
          <View className="mb-1 flex-row flex-wrap items-center justify-between gap-2">
            <View className="flex-row items-baseline gap-2">
              <Text className="font-display text-2xl text-ink">Reimbursements</Text>
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                {openStats.count} open · {formatCents(openStats.totalCents)}
              </Text>
            </View>
            <View className="flex-row gap-2">
              <Button
                title="Share request link"
                variant="secondary"
                size="sm"
                icon="share"
                onPress={() => void shareRequestLink()}
              />
              <Button
                title="Request a reimbursement"
                variant="secondary"
                size="sm"
                icon="plus"
                onPress={() => router.push("/finances/reimbursements/new")}
              />
            </View>
          </View>
          <Text className="mb-4 text-sm text-muted">
            Approve what volunteers and card-less team members spent — the ACH
            payout to their bank starts automatically from the chapter's
            Increase account.
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
                  ? "Submitted reimbursements appear here for a finance manager to approve — the ACH payout starts automatically once approved."
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
                  onRetryPayout={handleRetryPayout}
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
