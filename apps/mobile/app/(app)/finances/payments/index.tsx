/**
 * FINANCES · PAYMENTS — the contractor-payment queue.
 *
 * Paying someone who is NOT being reimbursed: a sound engineer, a designer, a
 * session player. A reimbursement pays back money a member already spent (the
 * receipt is the substantiation and it isn't income); this is the opposite on
 * both counts — nothing has been spent, the AGREEMENT is the substantiation,
 * and the money is reportable income to the person receiving it. Hence its own
 * vocabulary, its own queue, and its own tab.
 *
 * TWO ENTRY POINTS, ONE QUEUE (see `CONTRACTOR_PAYMENT_STATUSES`' doc): a
 * staffer pre-fills an agreement and sends a link (`draft` → `sent` →
 * `submitted`), or a stranger files a request through the public page (born
 * `submitted`). From `submitted` on they are indistinguishable and take the
 * identical approval → payout route, which is the point — a treasurer reviews
 * ONE queue, not two. The origin badge on every row is what keeps that
 * legible: "Agreement sent" is the org's own testimony, "Payment requested" is
 * somebody's claim, and the second one always arrives uncoded.
 *
 * THE SCREEN'S ONE JOB is the "needs review" band at the top. Everything else
 * here is a filter over a list; that band is the answer to "is a person
 * waiting on money right now", and it is deliberately the loudest thing on the
 * page and reachable in one tap. It counts the WHOLE queue, not the current
 * filter, so a reviewer who has drilled into "Paid" still can't lose sight of
 * the four people waiting.
 *
 * Every affordance is gated on the flags the server itself returns
 * (`canCompose` / `canApprove` from `api.contractorPayments.list`) — never on a
 * rank this screen re-derives.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  CONTRACTOR_PAYMENT_ORIGIN_LABELS,
  CONTRACTOR_PAYMENT_STATUS_LABELS,
  formatCents,
} from "@events-os/shared";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Narrow,
  Pill,
  Screen,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { formatDate } from "../../../../lib/format";
import { FinanceBoundary } from "../../../../components/finance/dashboard/parts";
import {
  FILTERS,
  ORIGIN_BADGE,
  STATUS_BADGE,
  type ContractorPaymentRow,
  financeScopeOf,
  type FilterKey,
} from "../../../../components/finance/payments/helpers";
import { useChapterContext } from "../../../../lib/ChapterContext";

/** Mirrors the 200-row ceiling `api.contractorPayments.list` clamps `limit` to,
 *  so the "showing the most recent N" notice can never quote a number the
 *  backend doesn't actually use. */
const QUEUE_READ_CAP = 200;

function PaymentsQueue() {
  const router = useRouter();
  const [filterKey, setFilterKey] = useState<FilterKey>("all");
  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0];

  // WHOSE QUEUE — the active desk's, not the caller's roster chapter's. A
  // central desk asked for payments and got its operator's home chapter's,
  // which is the "when I tried to view payments" half of the 2026-08-28 report.
  const { context } = useChapterContext();
  const scope = financeScopeOf(context);

  // Built as a ternary rather than a spread with a possibly-`undefined`
  // `status`: the arg is optional, and "absent" is not the same thing as
  // "present and undefined" to Convex's validator.
  const data = useQuery(
    api.contractorPayments.list,
    scope == null
      ? "skip"
      : filter.status
        ? { status: filter.status, limit: QUEUE_READ_CAP, scope }
        : { limit: QUEUE_READ_CAP, scope },
  );

  // The review band's own read — the WHOLE queue's `submitted` rows, so the
  // count stays true no matter which filter is showing. Convex dedupes the
  // subscription when the filter happens to be "Needs review" too.
  const review = useQuery(
    api.contractorPayments.list,
    scope == null
      ? "skip"
      : { status: "submitted", limit: QUEUE_READ_CAP, scope },
  );

  const reviewStats = useMemo(() => {
    const rows = review?.payments ?? [];
    return {
      count: rows.length,
      totalCents: rows.reduce((sum, r) => sum + r.agreedAmountCents, 0),
    };
  }, [review]);

  const rows = data?.payments;
  const canCompose = data?.canCompose === true;

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <View className="mb-1 flex-row flex-wrap items-center justify-between gap-2">
          <Text className="font-display text-2xl text-ink">Payments</Text>
          <View className="flex-row flex-wrap items-center gap-2">
            {/* The people behind the queue. Gated on the same server flag as
                composing — the roster read demands the finance-manager rung,
                so offering it to a viewer would be a button that only ever
                lands on a permission wall. */}
            {canCompose ? (
              <Button
                title="Contractors"
                size="sm"
                variant="secondary"
                icon="users"
                onPress={() =>
                  router.push("/finances/payments/contractors" as never)
                }
              />
            ) : null}
            {canCompose ? (
              <Button
                title="New agreement"
                size="sm"
                icon="plus"
                onPress={() => router.push("/finances/payments/new" as never)}
              />
            ) : null}
          </View>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Paying a contractor — someone doing work for the chapter who
          isn&apos;t claiming money back. Pre-fill the agreement, send them the
          link, and approve it once they&apos;ve signed and filed their tax
          form.
        </Text>

        {/* ── The band this screen exists for ───────────────────────────── */}
        <NeedsReviewBand
          loading={review === undefined}
          count={reviewStats.count}
          totalCents={reviewStats.totalCents}
          active={filterKey === "submitted"}
          onPress={() => setFilterKey("submitted")}
        />

        {/* ── Filters ───────────────────────────────────────────────────── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
          className="mb-3"
        >
          {FILTERS.map((f) => (
            <Pill
              key={f.key}
              label={f.label}
              selected={filterKey === f.key}
              onPress={() => setFilterKey(f.key)}
            />
          ))}
        </ScrollView>

        {/* ── The list ──────────────────────────────────────────────────── */}
        {rows === undefined ? (
          <EmptyState title="Loading payments…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={
              filterKey === "all"
                ? "No contractor payments yet"
                : `Nothing ${filter.label.toLowerCase()}`
            }
            message={
              filterKey === "all"
                ? "Pre-fill an agreement and send the contractor their link — they sign it, file a W-9, and you approve the payment here."
                : "Try another filter, or All to see everything."
            }
          />
        ) : (
          <View className="gap-2">
            {rows.map((row) => (
              <PaymentRow
                key={row._id}
                row={row}
                onPress={() =>
                  router.push(`/finances/payments/${row._id}` as never)
                }
              />
            ))}
            {rows.length >= QUEUE_READ_CAP ? (
              <Text className="mt-2 text-xs text-muted">
                Showing the most recent {QUEUE_READ_CAP} payments. Older ones
                aren&apos;t listed here yet.
              </Text>
            ) : null}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}

/**
 * "Someone is waiting on money." Loud when there is work, calm when there
 * isn't — and always present, so its absence never has to be interpreted.
 */
function NeedsReviewBand({
  loading,
  count,
  totalCents,
  active,
  onPress,
}: {
  loading: boolean;
  count: number;
  totalCents: number;
  active: boolean;
  onPress: () => void;
}) {
  if (loading) {
    return (
      <View className="mb-3 rounded-lg border border-border bg-raised px-4 py-3">
        <Text className="text-sm text-muted">Checking what needs review…</Text>
      </View>
    );
  }

  if (count === 0) {
    return (
      <View className="mb-3 flex-row items-center gap-2 rounded-lg border border-border bg-raised px-4 py-3">
        <Icon name="check-circle" size={15} color={colors.success} />
        <Text className="flex-1 text-sm text-muted">
          Nothing needs review — nobody is waiting on a decision from you.
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Show the ${count} payments that need review`}
      className={`mb-3 rounded-lg border px-4 py-3.5 active:opacity-80 ${
        active ? "border-warn bg-warn-bg" : "border-warn/50 bg-warn-bg"
      }`}
    >
      <View className="flex-row items-center gap-2">
        <Icon name="alert-circle" size={16} color={colors.warn} />
        <Text className="flex-1 font-display text-lg text-ink">
          {count} {count === 1 ? "payment needs" : "payments need"} review
        </Text>
        <Text
          className="text-base font-semibold text-ink"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(totalCents)}
        </Text>
      </View>
      <Text className="mt-1 text-xs text-warn">
        {count === 1 ? "Someone has" : "These people have"} done their part and{" "}
        {count === 1 ? "is" : "are"} waiting on the money.{" "}
        {active ? "Showing them now." : "Tap to see them."}
      </Text>
    </Pressable>
  );
}

/** One row: who, what for, how much, where it is, and where it came from. */
function PaymentRow({
  row,
  onPress,
}: {
  row: ContractorPaymentRow;
  onPress: () => void;
}) {
  const status = STATUS_BADGE[row.status];
  const origin = ORIGIN_BADGE[row.origin];
  // What the org is on the hook for right now: the approved figure once a
  // reviewer has cut it, the agreed one until then.
  const amountCents = row.approvedCents ?? row.agreedAmountCents;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="rounded-lg border border-border bg-raised px-4 py-3 active:opacity-80 web:hover:border-border-strong"
    >
      <View className="flex-row items-start gap-3">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
            {row.payeeName}
            {row.payeeBusinessName ? (
              <Text className="font-normal text-muted">
                {" "}
                · {row.payeeBusinessName}
              </Text>
            ) : null}
          </Text>
          <Text className="mt-0.5 text-xs text-muted" numberOfLines={2}>
            {row.serviceDescription}
          </Text>
          <Text className="mt-1 text-2xs text-faint">
            {row.reference} ·{" "}
            {formatDate(row.serviceDate ?? row.submittedAt ?? row.createdAt)}
          </Text>
        </View>
        <View className="items-end gap-1.5">
          <Text
            className="text-sm font-semibold text-ink"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {formatCents(amountCents)}
          </Text>
          <Badge
            label={CONTRACTOR_PAYMENT_STATUS_LABELS[row.status]}
            tone={status.tone}
            icon={status.icon}
          />
          <Badge
            label={CONTRACTOR_PAYMENT_ORIGIN_LABELS[row.origin]}
            tone={origin.tone}
            icon={origin.icon}
          />
        </View>
      </View>
    </Pressable>
  );
}

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Finance access needed"
      message="Ask a finance manager to grant you access to the contractor payments queue."
    />
  );
}

export default function PaymentsScreen() {
  return (
    <FinanceBoundary fallback={<NoFinanceAccess />}>
      <PaymentsQueue />
    </FinanceBoundary>
  );
}
