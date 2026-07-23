/**
 * FINANCES · CHASE RECEIPTS — the FM's ready-made "who do I nudge" list.
 *
 * Every charge still owed a receipt, grouped by cardholder and sorted big-first
 * (`api.finances.receiptChase` — groups by total DESC, charges within a group
 * by amount DESC, the no-cardholder "Unattributed" bucket pinned last). The
 * grouping resolves the cardholder exactly like the Reconcile grid's
 * Cardholder column, and the query's predicate is now IDENTICAL to the
 * grid's Missing-receipt pill (`isSpend && no receipt && not reconciled`) —
 * a `reconciled` row was closed receipt-less on purpose, so it's absent from
 * both. See the query's doc comment for the exact rule.
 *
 * `scope`/`chapterId` route params (set by the Reconcile screen's
 * "Chase receipts" button — see `reconcile.tsx`'s `chaseHref`) are forwarded
 * straight to `receiptChase`, which resolves them exactly like
 * `listReconcile` does. This is what actually keeps the two screens honest:
 * without it, this page always read the caller's HOME chapter regardless of
 * which scope the grid was showing, so a central/peeked-chapter pill could
 * point at a different bucket than the count it displayed.
 *
 * READ-ONLY on purpose: the chasing itself happens off-app (a text, a tap on
 * the shoulder) and the automated day-1/day-3 nudges + day-7 card auto-lock
 * already run on their own (`cards.advanceReceiptReminders` /
 * `autoLockOverdueCards`) — each row's badge shows how far along that
 * timeline the charge already is. Uploading the receipt stays on Reconcile /
 * My Transactions.
 *
 * Reached from the Reconcile screen (not a tab of its own). Gated exactly like
 * Reconcile: real finance seats (`financeRoles.mySeats`) decide whether the
 * inner component — whose query throws for a no-role caller — ever mounts,
 * with `FinanceBoundary` as the degrade for a role throw (the [hotfix] crash
 * class; see `reconcile.tsx`'s module doc for the full story).
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { useLocalSearchParams } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Avatar,
  BackLink,
  Badge,
  EmptyState,
  Narrow,
  Screen,
} from "../../../components/ui";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import {
  formatCents,
  shortDate,
  signedMoney,
} from "../../../components/finance/reconcile/helpers";

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Chase receipts is restricted"
      message="Only finance managers and bookkeepers can see who still owes a receipt."
    />
  );
}

/** Real gate: the caller's actual finance seats. No seat → an empty state,
 *  never `ReceiptChaseBody` (whose query throws for a no-role caller). */
export default function ReceiptChaseScreen() {
  const seats = useQuery(api.financeRoles.mySeats, {});

  if (seats === undefined) return <Screen loading />;

  if (seats.length === 0) {
    return (
      <Screen>
        <Narrow>
          <NoFinanceAccess />
        </Narrow>
      </Screen>
    );
  }

  return (
    <FinanceBoundary fallback={<NoFinanceAccess />}>
      <ReceiptChaseBody />
    </FinanceBoundary>
  );
}

/** The reminder-timeline badge for one charge — mirrors the Reconcile grid's
 *  Receipt column language (day-1 "Reminder sent" → day-3 "Day 3 overdue"). */
function ReminderBadge({
  stage,
}: {
  stage: "none" | "flagged" | "escalated";
}) {
  if (stage === "escalated") {
    return <Badge label="Day 3 overdue" tone="danger" icon="alert-triangle" />;
  }
  if (stage === "flagged") return <Badge label="Reminder sent" tone="warn" />;
  return <Badge label="No receipt" tone="neutral" />;
}

function ReceiptChaseBody() {
  // Mirrors `reconcile.tsx`'s `chaseHref` — whichever scope the grid was
  // showing when "Chase receipts" was tapped. Absent params (a direct nav,
  // or a non-central caller whose `?scope=central` we ignore exactly like
  // the grid's own toggle does) fall back to the caller's home chapter,
  // same as before this pair of args existed.
  const params = useLocalSearchParams<{ scope?: string; chapterId?: string }>();
  const chase = useQuery(
    api.finances.receiptChase,
    params.scope === "central"
      ? { scope: "central" as const }
      : params.chapterId
        ? { chapterId: params.chapterId as Id<"chapters"> }
        : {},
  );

  if (chase === undefined) {
    return (
      <Screen>
        <Narrow>
          <EmptyState title="Loading missing receipts…" />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <BackLink label="Back to Reconcile" fallback="/finances/reconcile" />

        {/* Header — title + the outstanding total across everyone. */}
        <View className="mb-1 flex-row items-baseline gap-2">
          <Text className="font-display text-2xl text-ink">Chase receipts</Text>
          {chase.count > 0 ? (
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {chase.count} owed · {formatCents(chase.totalCents)}
            </Text>
          ) : null}
        </View>
        <Text className="mb-4 text-sm text-muted">
          Every charge still missing a receipt, by cardholder — biggest first.
          Nudge them here; receipts upload from Reconcile or My Transactions.
        </Text>

        {chase.groups.length === 0 ? (
          <EmptyState
            icon="check-circle"
            title="Every receipt is in"
            message="Nobody owes a receipt right now — nothing to chase."
          />
        ) : (
          <View className="gap-4">
            {chase.groups.map((group) => (
              <View
                key={group.personId ?? "unattributed"}
                className="overflow-hidden rounded-lg border border-border bg-raised shadow-card"
              >
                {/* Group header: the cardholder + their outstanding tally. */}
                <View className="flex-row items-center gap-2.5 border-b border-border bg-sunken px-3 py-2.5">
                  <Avatar
                    name={group.name || "?"}
                    size={26}
                    uri={group.imageUrl}
                  />
                  <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
                    {group.name}
                  </Text>
                  <Text className="text-sm font-semibold text-ink">
                    {formatCents(group.totalCents)}
                  </Text>
                  <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                    {group.transactions.length}{" "}
                    {group.transactions.length === 1 ? "receipt" : "receipts"}
                  </Text>
                </View>

                {/* The charges, biggest first (server-sorted). */}
                {group.transactions.map((t, i) => (
                  <View
                    key={t.id}
                    className={`flex-row items-center gap-3 px-3 py-2 ${
                      i === group.transactions.length - 1 ? "" : "border-b border-border/60"
                    }`}
                  >
                    <View className="flex-1">
                      <Text className="text-sm font-medium text-ink" numberOfLines={1}>
                        {t.merchantName ?? t.description ?? "Unlabeled charge"}
                      </Text>
                      <Text className="text-xs text-muted" numberOfLines={1}>
                        {[shortDate(t.postedAt), t.cardLast4 ? `card ··${t.cardLast4}` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                    <ReminderBadge stage={t.reminderStage} />
                    <Text className="w-[90px] text-right text-sm font-semibold text-ink">
                      {signedMoney(t.amountCents, "outflow")}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
