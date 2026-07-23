/**
 * FINANCES · CHASE RECEIPTS — the FM's ready-made "who do I nudge" list.
 *
 * Every charge still owed a receipt, grouped by cardholder and sorted big-first
 * (`api.finances.receiptChase` — groups by total DESC, charges within a group
 * by amount DESC, the no-cardholder "Unattributed" bucket pinned last). The
 * grouping resolves the cardholder exactly like the Reconcile grid's
 * Cardholder column, so this list can never disagree with the grid the FM
 * just came from; the chase predicate is deliberately NARROWER than the
 * grid's Missing-receipt pill (a `reconciled` row was closed receipt-less on
 * purpose — nobody left to chase). See the query's doc comment for both rules.
 *
 * The automated day-1/day-3 nudges + day-7 card auto-lock already run on
 * their own (`cards.advanceReceiptReminders` / `autoLockOverdueCards`) — each
 * row's badge shows how far along that timeline the charge already is.
 * Uploading the receipt stays on Reconcile / My Transactions.
 *
 * MANUAL NUDGE (tester-requested — no longer purely read-only): a finance
 * MANAGER (not just any finance seat — `financeRoles.mySeats`'s
 * `role:"manager"`) gets a "Send reminder" button per cardholder group plus a
 * page-level "Remind all", so they can nudge whoever spent money without
 * leaving this page. Both call `api.cards.sendReceiptNudge` (email — the
 * SAME digest content the automated reminder sends — required; SMS to the
 * text-to-receipt number best-effort). Server-side rate-limited to one nudge
 * per cardholder per 24h (`api.cards.getManualNudgeStatus` drives the
 * "Nudged today" disabled state); manager-gated server-side too
 * (`requireFinanceManager`, mirroring `lockCard`/`cancelCard`) — hidden here
 * for a non-manager viewer as a UX nicety, not the real gate.
 *
 * Reached from the Reconcile screen (not a tab of its own). Gated exactly like
 * Reconcile: real finance seats (`financeRoles.mySeats`) decide whether the
 * inner component — whose query throws for a no-role caller — ever mounts,
 * with `FinanceBoundary` as the degrade for a role throw (the [hotfix] crash
 * class; see `reconcile.tsx`'s module doc for the full story).
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Avatar,
  BackLink,
  Badge,
  Button,
  EmptyState,
  Narrow,
  Screen,
  ToastView,
} from "../../../components/ui";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import {
  formatCents,
  shortDate,
  signedMoney,
} from "../../../components/finance/reconcile/helpers";
import { useActionRunner } from "../../../lib/useActionToast";

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

/** Outcome copy for a single nudge target — shared by the "Send reminder"
 *  and "Remind all" summary banners. */
function outcomeLabel(name: string, outcome: "sent" | "already_nudged" | "no_email"): string {
  if (outcome === "already_nudged") return `${name} was already nudged today`;
  if (outcome === "no_email") return `${name} has no email on file — nothing sent`;
  return `Nudged ${name}`;
}

function ReceiptChaseBody() {
  const chase = useQuery(api.finances.receiptChase, {});
  // MANAGER, not just any finance seat — the nudge buttons are gated a step
  // above the read-only list (`ReceiptChaseScreen` already required viewer+
  // to get this far). Hiding here is a UX nicety only; `sendReceiptNudge` /
  // `getManualNudgeStatus` re-assert this server-side.
  const seats = useQuery(api.financeRoles.mySeats, {});
  const isManager = (seats ?? []).some((s) => s.role === "manager");

  const nudgeablePersonIds = useMemo(
    () =>
      (chase?.groups ?? [])
        .map((g) => g.personId)
        .filter((id): id is Id<"people"> => id != null),
    [chase],
  );
  const nudgeStatus = useQuery(
    api.cards.getManualNudgeStatus,
    isManager && nudgeablePersonIds.length > 0
      ? { personIds: nudgeablePersonIds }
      : "skip",
  );
  const nudgedToday = useMemo(
    () => new Set((nudgeStatus ?? []).map((s) => s.personId)),
    [nudgeStatus],
  );

  const sendReceiptNudge = useAction(api.cards.sendReceiptNudge);
  const { run, toast, dismiss } = useActionRunner();
  // "all" for the page-level button, else the cardholder's own personId —
  // drives which button shows its spinner while a nudge is in flight.
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  // A neutral (non-error) summary of the last nudge's outcome — separate from
  // `toast`, which `useActionRunner` reserves for genuine failures (a thrown
  // network/permission error), so "no email on file" doesn't render as red.
  const [notice, setNotice] = useState<string | null>(null);

  async function nudge(personId: Id<"people"> | undefined, key: string) {
    setSendingKey(key);
    setNotice(null);
    const res = await run(
      () => sendReceiptNudge(personId ? { personId } : {}),
      { errorTitle: "Couldn't send reminder" },
    );
    setSendingKey(null);
    if (!res) return; // a real error already surfaced via `toast` above.
    if (res.results.length === 0) {
      setNotice("Nobody currently owes a receipt.");
      return;
    }
    setNotice(res.results.map((r) => outcomeLabel(r.cardholderName, r.outcome)).join(" · "));
  }

  if (chase === undefined) {
    return (
      <Screen>
        <Narrow>
          <EmptyState title="Loading missing receipts…" />
        </Narrow>
      </Screen>
    );
  }

  const nudgeableCount = chase.groups.filter((g) => g.personId != null).length;

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <BackLink label="Back to Reconcile" fallback="/finances/reconcile" />

        {/* Header — title + the outstanding total across everyone, plus the
            manager-only "Remind all" bulk nudge. */}
        <View className="mb-1 flex-row items-baseline gap-2">
          <Text className="font-display text-2xl text-ink">Chase receipts</Text>
          {chase.count > 0 ? (
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {chase.count} owed · {formatCents(chase.totalCents)}
            </Text>
          ) : null}
          <View className="flex-1" />
          {isManager && nudgeableCount > 0 ? (
            <Button
              title="Remind all"
              variant="secondary"
              size="sm"
              icon="send"
              loading={sendingKey === "all"}
              onPress={() => nudge(undefined, "all")}
            />
          ) : null}
        </View>
        <Text className="mb-4 text-sm text-muted">
          Every charge still missing a receipt, by cardholder — biggest first.
          Nudge them here; receipts upload from Reconcile or My Transactions.
        </Text>

        <ToastView toast={toast} onDismiss={dismiss} />
        {notice ? (
          <View className="mb-3 flex-row items-center gap-2 rounded-md border border-border bg-sunken px-3 py-2.5">
            <Text className="flex-1 text-sm text-ink">{notice}</Text>
            <Button title="Dismiss" variant="ghost" size="sm" onPress={() => setNotice(null)} />
          </View>
        ) : null}

        {chase.groups.length === 0 ? (
          <EmptyState
            icon="check-circle"
            title="Every receipt is in"
            message="Nobody owes a receipt right now — nothing to chase."
          />
        ) : (
          <View className="gap-4">
            {chase.groups.map((group) => {
              const canNudge = isManager && group.personId != null;
              const alreadyNudged = group.personId != null && nudgedToday.has(group.personId);
              return (
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
                    {canNudge ? (
                      <Button
                        title={alreadyNudged ? "Nudged today" : "Send reminder"}
                        variant="secondary"
                        size="sm"
                        icon={alreadyNudged ? undefined : "send"}
                        disabled={alreadyNudged}
                        loading={sendingKey === group.personId}
                        onPress={() => nudge(group.personId!, group.personId!)}
                      />
                    ) : null}
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
              );
            })}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
