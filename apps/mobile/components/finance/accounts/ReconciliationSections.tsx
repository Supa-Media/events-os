/**
 * Accounts-page sections for the MORNING RECONCILIATION ENGINE
 * (`apps/convex/reconciliation.ts`):
 *
 *  - `BalancesSection` — every book's ledger ("true value") balance beside its
 *    cached bank balance, with the book-vs-bank explainer. The number the
 *    engine exists to keep honest.
 *  - `ReconciliationSection` — engine state (last run, pause/resume, run now)
 *    + the detected-payouts list with per-book allocation breakdowns, loud
 *    unmapped/repayment buckets, deposit-match state, and a flag affordance.
 *  - `TransferHistorySection` — every central↔chapter transfer pair (manual
 *    AND engine, origin-badged) for the Financial Manager to audit, with
 *    flag/resolve. The fix for a wrong entry is an offsetting transfer
 *    (docs/plans/transfers-ops-notes.md) — flags record the decision trail.
 *
 * All three render inside the ED/FM-gated `AccountsBody` (`accounts.tsx`), so
 * their queries may assume the audit power; the server re-asserts it anyway
 * (`requireReconciliationAudit`).
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useMutation, useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  AUTO_TRANSFER_ORIGIN_LABELS,
  formatCents,
  type ReconciliationFlagKind,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  SectionHeader,
  TextField,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { BookValueBreakdownModal } from "./BookValueBreakdownModal";

/** `Aug 7` / `Aug 7, 5:31 AM` in the org's timezone — compact display dates. */
function shortDate(ts: number, withTime = false): string {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

// ── Balances ─────────────────────────────────────────────────────────────────

export function BalancesSection() {
  const balances = useQuery(api.reconciliation.accountBalances, {});
  // Which book's breakdown is open. Null = closed. A two-number summary is not
  // auditable on its own; tapping a row opens the itemisation behind it.
  const [openScope, setOpenScope] = useState<string | null>(null);
  return (
    <>
      <SectionHeader title="Account balances" />
      <Text className="mb-3 text-sm text-muted">
        Book value = the money a book has earned (donations, ticket sales and
        in-person sales, gross of processor fees) minus what its ledger says
        went out, with cross-book card spend settled by the morning engine. Bank
        is the cash physically sitting in the scope&apos;s Increase account — the
        two differing is normal until cash movement catches the books up.{" "}
        <Text className="text-ink">Tap a book to see what makes up its number.</Text>
      </Text>
      <Card>
        {balances === undefined ? (
          <Text className="text-sm text-muted">Loading…</Text>
        ) : (
          <View className="gap-2">
            <View className="flex-row items-center gap-3 pb-1">
              <Text className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                Book
              </Text>
              <Text className="w-24 text-right text-[11px] font-semibold uppercase tracking-wide text-faint">
                Book value
              </Text>
              <Text className="w-24 text-right text-[11px] font-semibold uppercase tracking-wide text-faint">
                Bank
              </Text>
            </View>
            {balances.map((row, i) => (
              <Pressable
                key={row.scope}
                onPress={() => setOpenScope(row.scope)}
                accessibilityRole="button"
                accessibilityLabel={`${row.scopeName} — see what makes up this book value`}
                className={`flex-row items-center gap-3 py-2 ${
                  i > 0 ? "border-t border-border-strong" : ""
                }`}
              >
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-1.5">
                    <Text className="font-display text-base text-ink" numberOfLines={1}>
                      {row.scopeName}
                    </Text>
                    <Icon name="chevron-right" size={14} color={colors.faint} />
                  </View>
                  <Text className="text-2xs text-faint">
                    {formatCents(row.revenueCents)} earned ·{" "}
                    {row.ledgerNetCents <= 0
                      ? `${formatCents(Math.abs(row.ledgerNetCents))} out`
                      : `${formatCents(row.ledgerNetCents)} ledger net`}
                  </Text>
                  {row.truncated ? (
                    <Text className="text-2xs text-warn">
                      Scan truncated — treat as approximate
                    </Text>
                  ) : null}
                </View>
                <Text
                  className="w-24 text-right text-sm font-semibold text-ink"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {formatCents(row.bookBalanceCents)}
                </Text>
                <View className="w-24 items-end">
                  {row.bankBalanceCents == null ? (
                    <Text className="text-2xs text-faint">—</Text>
                  ) : (
                    <>
                      <Text
                        className="text-sm text-muted"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {formatCents(row.bankBalanceCents)}
                      </Text>
                      {row.bankBalanceAsOf ? (
                        <Text className="text-2xs text-faint">
                          as of {shortDate(row.bankBalanceAsOf)}
                        </Text>
                      ) : null}
                    </>
                  )}
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </Card>
      <BookValueBreakdownModal scope={openScope} onClose={() => setOpenScope(null)} />
    </>
  );
}

// ── Flag modal (shared by payouts + history) ─────────────────────────────────

function FlagModal({
  title,
  onConfirm,
  onCancel,
  submitting,
}: {
  title: string;
  onConfirm: (note: string) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [note, setNote] = useState("");
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">{title}</Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>
          <View className="gap-3 px-5 py-4">
            <Text className="text-xs text-muted">
              Flagging never changes the ledger — it puts this entry on the
              audit list with your note. If the entry itself is wrong, the fix
              is an offsetting transfer (see the transfers ops notes).
            </Text>
            <TextField
              label="What needs review?"
              value={note}
              onChangeText={setNote}
              placeholder="e.g. This allocation looks too large for NYC"
              multiline
            />
            <View className="flex-row justify-end gap-2">
              <Button title="Cancel" variant="secondary" onPress={onCancel} />
              <Button
                title={submitting ? "Flagging…" : "Flag for review"}
                disabled={submitting || note.trim().length === 0}
                onPress={() => onConfirm(note)}
              />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Morning reconciliation panel ─────────────────────────────────────────────

const RUN_STATUS_TONE: Record<string, "success" | "warn" | "danger" | "neutral"> =
  {
    ok: "success",
    running: "warn",
    skipped: "neutral",
    error: "danger",
  };

export function ReconciliationSection() {
  const overview = useQuery(api.reconciliation.reconciliationOverview, {});
  const setPaused = useMutation(api.reconciliation.setReconciliationPaused);
  const setRealMovement = useMutation(api.reconciliation.setRealMovementEnabled);
  const flagEntry = useMutation(api.reconciliation.flagReconciliationEntry);
  const runNow = useAction(api.reconciliation.runReconciliationNow);
  const { run, toast, dismiss } = useActionRunner();
  const [flagging, setFlagging] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Two-step confirm for ENABLING real movement (web-safe — Alert.alert
  // no-ops on web): first tap arms, second tap within the armed state
  // commits. Disabling is one tap; turning money movement OFF should never
  // have friction.
  const [confirmingRealMove, setConfirmingRealMove] = useState(false);

  if (overview === undefined) {
    return (
      <>
        <SectionHeader title="Morning reconciliation" />
        <Card>
          <Text className="text-sm text-muted">Loading…</Text>
        </Card>
      </>
    );
  }

  const { lastRun } = overview;

  return (
    <>
      <SectionHeader title="Morning reconciliation" />
      <Text className="mb-3 text-sm text-muted">
        Every morning the engine detects Stripe payouts, moves each book&apos;s
        share of the deposit onto its own book (net of fees), labels the bank
        deposit, and settles cross-book card spend.{" "}
        {overview.realMovement
          ? "Real cash movement is ON: it also executes those transfers between the Increase accounts, so the cash follows the books."
          : "Ledger entries only while Real cash movement is off — no real money moves."}{" "}
        Flag anything that looks off.
      </Text>
      <View className="mb-1">
        <ToastView toast={toast} onDismiss={dismiss} />
      </View>
      <Card>
        <View className="gap-3">
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <View className="flex-row flex-wrap items-center gap-2">
              <Badge
                label={overview.paused ? "Paused" : "Active"}
                tone={overview.paused ? "warn" : "success"}
                icon={overview.paused ? "pause" : "check-circle"}
              />
              {lastRun ? (
                <Badge
                  label={`Last run ${shortDate(lastRun.startedAt, true)} · ${lastRun.status}`}
                  tone={RUN_STATUS_TONE[lastRun.status] ?? "neutral"}
                />
              ) : (
                <Badge label="Hasn't run yet" tone="neutral" />
              )}
              {overview.openFlagCount > 0 ? (
                <Badge
                  label={`${overview.openFlagCount} open flag${overview.openFlagCount === 1 ? "" : "s"}`}
                  tone="warn"
                  icon="flag"
                />
              ) : null}
            </View>
            <View className="flex-row gap-2">
              <Button
                title={overview.paused ? "Resume" : "Pause"}
                variant="secondary"
                onPress={() =>
                  void run(() => setPaused({ paused: !overview.paused }), {
                    errorTitle: "Couldn't change the engine state",
                  })
                }
              />
              <Button
                title="Run now"
                variant="secondary"
                icon="refresh-cw"
                onPress={() =>
                  void run(() => runNow({}), {
                    errorTitle: "Couldn't run the engine",
                  })
                }
              />
            </View>
          </View>

          <View className="flex-row items-start justify-between gap-3 rounded-lg border border-border bg-sunken/40 px-3 py-2">
            <View className="min-w-0 flex-1">
              <View className="flex-row flex-wrap items-center gap-2">
                <Text className="text-xs font-semibold text-ink">
                  Real cash movement
                </Text>
                <Badge
                  label={overview.realMovement ? "ON" : "Off"}
                  tone={overview.realMovement ? "success" : "neutral"}
                  icon={overview.realMovement ? "zap" : "lock"}
                />
              </View>
              <Text className="mt-0.5 text-2xs text-muted">
                {overview.realMovement
                  ? "The morning run executes each booked transfer as a real Increase account-to-account movement, so the cash follows the books."
                  : "Off: the engine writes ledger entries only. Turn on to have the morning run move the actual cash between Increase accounts to match."}
              </Text>
              {confirmingRealMove && !overview.realMovement ? (
                <Text className="mt-1 text-2xs font-semibold text-warn">
                  This authorizes the engine to move real money every morning —
                  transfers booked from this moment on will execute
                  automatically. Tap Confirm to proceed.
                </Text>
              ) : null}
            </View>
            {overview.realMovement ? (
              <Button
                title="Turn off"
                variant="secondary"
                onPress={() =>
                  void run(() => setRealMovement({ enabled: false }), {
                    errorTitle: "Couldn't change real cash movement",
                  })
                }
              />
            ) : confirmingRealMove ? (
              <View className="gap-1.5">
                <Button
                  title="Confirm — move real money"
                  onPress={() =>
                    void run(
                      async () => {
                        await setRealMovement({ enabled: true });
                        setConfirmingRealMove(false);
                      },
                      { errorTitle: "Couldn't change real cash movement" },
                    )
                  }
                />
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setConfirmingRealMove(false)}
                />
              </View>
            ) : (
              <Button
                title="Turn on"
                variant="secondary"
                onPress={() => setConfirmingRealMove(true)}
              />
            )}
          </View>

          {overview.sinceMs != null ? (
            <Text className="text-2xs text-faint">
              Allocating payouts arriving since {shortDate(overview.sinceMs)}.
              Older deposits stay however they were hand-coded.
            </Text>
          ) : (
            <Text className="text-2xs text-faint">
              The first run will start allocating from that moment forward —
              history stays however it was hand-coded.
            </Text>
          )}

          {lastRun ? (
            <View className="gap-0.5 rounded-lg border border-border bg-sunken/40 px-3 py-2">
              <Text className="text-2xs text-muted">
                {lastRun.payoutsProcessed} payout(s) processed ·{" "}
                {lastRun.transfersBooked} allocation transfer(s) ·{" "}
                {lastRun.settlementsBooked} settlement(s) ·{" "}
                {formatCents(lastRun.allocatedCents)} moved
              </Text>
              {lastRun.error ? (
                <Text className="text-2xs text-danger">{lastRun.error}</Text>
              ) : null}
              {lastRun.notes.slice(0, 6).map((note, i) => (
                <Text key={i} className="text-2xs text-faint" numberOfLines={2}>
                  {note}
                </Text>
              ))}
            </View>
          ) : null}

          <View className="gap-2">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              Detected payouts
            </Text>
            {overview.payouts.length === 0 ? (
              <Text className="text-2xs text-muted">
                No Stripe payouts detected yet — they&apos;ll appear here as
                they arrive.
              </Text>
            ) : (
              overview.payouts.map((po) => {
                const isExpanded = expanded === po.stripePayoutId;
                return (
                  <View
                    key={po.stripePayoutId}
                    className="overflow-hidden rounded-lg border border-border"
                  >
                    <View className="flex-row items-center gap-2 px-3 py-2">
                      <Pressable
                        onPress={() =>
                          setExpanded(isExpanded ? null : po.stripePayoutId)
                        }
                        accessibilityRole="button"
                        className="min-w-0 flex-1"
                      >
                        <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
                          {shortDate(po.arrivalDate)} ·{" "}
                          {formatCents(po.amountCents)} · {po.stripePayoutId}
                        </Text>
                        <Text className="text-2xs text-muted">
                          {isExpanded ? "Hide breakdown" : "Tap for breakdown"}
                        </Text>
                      </Pressable>
                      <Badge
                        label={
                          po.processState === "allocated"
                            ? "Allocated"
                            : po.processState === "failed"
                              ? "Failed"
                              : "Pending"
                        }
                        tone={
                          po.processState === "allocated"
                            ? "success"
                            : po.processState === "failed"
                              ? "danger"
                              : "warn"
                        }
                      />
                      {po.flagged ? (
                        <Badge label="Flagged" tone="warn" icon="flag" />
                      ) : (
                        <Pressable
                          onPress={() => setFlagging(po.stripePayoutId)}
                          accessibilityRole="button"
                          hitSlop={8}
                        >
                          <Text className="text-2xs font-semibold text-accent">
                            Flag
                          </Text>
                        </Pressable>
                      )}
                    </View>
                    {isExpanded ? (
                      <View className="gap-1 border-t border-border bg-sunken/40 px-3 py-2">
                        {po.allocation.map((entry) => (
                          <View
                            key={entry.scope}
                            className="flex-row items-center justify-between gap-3"
                          >
                            <Text className="flex-1 text-2xs text-muted" numberOfLines={1}>
                              {entry.scopeName} · {entry.itemCount} item
                              {entry.itemCount === 1 ? "" : "s"}
                            </Text>
                            <Text
                              className="text-2xs text-ink"
                              style={{ fontVariant: ["tabular-nums"] }}
                            >
                              {formatCents(entry.netCents)}
                            </Text>
                          </View>
                        ))}
                        {po.unmappedNetCents !== 0 ? (
                          <Text className="text-2xs text-warn">
                            {formatCents(po.unmappedNetCents)} couldn&apos;t be
                            traced to an order, gift, or repayment — it stays on
                            central&apos;s book. Review and move it with a
                            manual transfer if it belongs to a chapter.
                          </Text>
                        ) : null}
                        {po.repaymentNetCents !== 0 ? (
                          <Text className="text-2xs text-faint">
                            {formatCents(po.repaymentNetCents)} is repayment
                            cash returning to the org (chapter books were
                            already credited at settle).
                          </Text>
                        ) : null}
                        <Text
                          className={`text-2xs ${po.depositMatched ? "text-faint" : "text-warn"}`}
                        >
                          {po.depositMatched
                            ? "Bank deposit matched and labeled."
                            : "Bank deposit not matched yet — retried each morning."}
                        </Text>
                        {po.error ? (
                          <Text className="text-2xs text-danger">{po.error}</Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
          </View>
        </View>
      </Card>

      {flagging ? (
        <FlagModal
          title="Flag payout for review"
          onConfirm={(note) => {
            void run(
              async () => {
                await flagEntry({
                  kind: "payout" satisfies ReconciliationFlagKind,
                  refKey: flagging,
                  note,
                });
                setFlagging(null);
              },
              { errorTitle: "Couldn't flag the payout" },
            );
          }}
          onCancel={() => setFlagging(null)}
        />
      ) : null}
    </>
  );
}

// ── Transfer history ─────────────────────────────────────────────────────────

const ORIGIN_BADGE: Record<
  "manual" | "payout_allocation" | "auto_settlement",
  { label: string; tone: "neutral" | "lavender" | "success" }
> = {
  manual: { label: "Manual", tone: "neutral" },
  payout_allocation: {
    label: AUTO_TRANSFER_ORIGIN_LABELS.payout_allocation,
    tone: "lavender",
  },
  auto_settlement: {
    label: AUTO_TRANSFER_ORIGIN_LABELS.auto_settlement,
    tone: "success",
  },
};

export function TransferHistorySection() {
  const [limit, setLimit] = useState(25);
  const history = useQuery(api.reconciliation.listTransferHistory, { limit });
  const flagEntry = useMutation(api.reconciliation.flagReconciliationEntry);
  const resolveFlag = useMutation(api.reconciliation.resolveReconciliationFlag);
  const { run, toast, dismiss } = useActionRunner();
  const [flagging, setFlagging] = useState<string | null>(null);

  return (
    <>
      <SectionHeader
        title="Transfer history"
        count={history?.length ?? undefined}
      />
      <Text className="mb-3 text-sm text-muted">
        Every central↔chapter transfer — recorded by hand or booked by the
        morning engine — newest first. This is the audit trail: flag anything
        that needs a human decision; correct a wrong entry with an offsetting
        transfer.
      </Text>
      <View className="mb-1">
        <ToastView toast={toast} onDismiss={dismiss} />
      </View>
      {history === undefined ? (
        <Card>
          <Text className="text-sm text-muted">Loading…</Text>
        </Card>
      ) : history.length === 0 ? (
        <EmptyState
          icon="repeat"
          title="No transfers yet"
          message="Transfers recorded by hand or booked by the morning engine will appear here."
        />
      ) : (
        <Card>
          <View className="gap-2">
            {history.map((row, i) => {
              const badge = ORIGIN_BADGE[row.origin];
              return (
                <View
                  key={row.transferGroupId}
                  className={`gap-1 py-2 ${i > 0 ? "border-t border-border-strong" : ""}`}
                >
                  <View className="flex-row items-center gap-2">
                    <Text className="min-w-0 flex-1 text-xs font-semibold text-ink" numberOfLines={1}>
                      {shortDate(row.postedAt)} ·{" "}
                      {row.direction === "central_to_chapter"
                        ? `Central → ${row.chapterName}`
                        : `${row.chapterName} → Central`}
                    </Text>
                    <Text
                      className="text-sm font-semibold text-ink"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {formatCents(row.amountCents)}
                    </Text>
                  </View>
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Badge label={badge.label} tone={badge.tone} />
                    {row.cashMoved === true ? (
                      <Badge label="Cash moved" tone="success" icon="check" />
                    ) : row.cashMoved === false ? (
                      <Badge label="Cash not moved" tone="neutral" />
                    ) : null}
                    {row.stripePayoutId ? (
                      <Text className="text-2xs text-faint">{row.stripePayoutId}</Text>
                    ) : null}
                    {row.recordedByName ? (
                      <Text className="text-2xs text-faint">by {row.recordedByName}</Text>
                    ) : null}
                    {row.flag ? (
                      row.flag.status === "open" ? (
                        <Pressable
                          onPress={() =>
                            void run(
                              () =>
                                resolveFlag({
                                  flagId: row.flag!.flagId,
                                  resolutionNote: "Reviewed — no change needed.",
                                }),
                              { errorTitle: "Couldn't resolve the flag" },
                            )
                          }
                          accessibilityRole="button"
                          hitSlop={8}
                        >
                          <Badge label="Flagged — tap to resolve" tone="warn" icon="flag" />
                        </Pressable>
                      ) : (
                        <Badge label="Flag resolved" tone="neutral" icon="check" />
                      )
                    ) : (
                      <Pressable
                        onPress={() => setFlagging(row.transferGroupId)}
                        accessibilityRole="button"
                        hitSlop={8}
                      >
                        <Text className="text-2xs font-semibold text-accent">Flag</Text>
                      </Pressable>
                    )}
                  </View>
                  {row.note ? (
                    <Text className="text-2xs text-muted" numberOfLines={2}>
                      {row.note}
                    </Text>
                  ) : null}
                  {row.flag?.status === "open" ? (
                    <Text className="text-2xs text-warn" numberOfLines={2}>
                      ⚑ {row.flag.note}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
          {history.length >= limit ? (
            <View className="mt-3 items-center">
              <Button
                title="Show more"
                variant="secondary"
                onPress={() => setLimit((n) => Math.min(n + 25, 100))}
              />
            </View>
          ) : null}
        </Card>
      )}

      {flagging ? (
        <FlagModal
          title="Flag transfer for review"
          onConfirm={(note) => {
            void run(
              async () => {
                await flagEntry({
                  kind: "transfer" satisfies ReconciliationFlagKind,
                  refKey: flagging,
                  note,
                });
                setFlagging(null);
              },
              { errorTitle: "Couldn't flag the transfer" },
            );
          }}
          onCancel={() => setFlagging(null)}
        />
      ) : null}
    </>
  );
}
