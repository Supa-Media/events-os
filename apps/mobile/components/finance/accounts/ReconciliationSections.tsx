/**
 * Accounts-page sections for the MORNING RECONCILIATION ENGINE
 * (`apps/convex/reconciliation.ts`):
 *
 *  - `BalancesSection` — every book's ledger ("true value") balance beside its
 *    cached bank balance, with the book-vs-bank explainer. The number the
 *    engine exists to keep honest.
 *  - `ReconciliationSection` — engine state (last run, pause/resume, run now)
 *    + the payouts Stripe has sent, each saying whether its bank deposit was
 *    found, and a flag affordance. Its copy was rewritten 2026-08-08: it still
 *    described the per-payout allocation #553 removed, and badged payouts from
 *    a `processState` that now only records allocation-era history.
 *
 * The org-wide "do these numbers agree?" verdict is NOT here — it lives in
 * `ReconciliationSummary.tsx`, above all three, because it is the conclusion
 * and these are its evidence.
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
  // Money at the processor is real money the org holds, and nothing on this
  // page could see it before — every figure was a book total or an Increase
  // balance, so funds in transit looked like they had vanished.
  const stripe = useQuery(api.reconciliation.stripeBalance, {});
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
        is the cash physically sitting in the scope&apos;s Increase account.{" "}
        <Text className="text-ink">
          A single row is not meant to balance
        </Text>{" "}
        — payouts land in central, so central holds what the chapters earned
        until the engine moves it. The org-wide check is above. Pending is
        everything the bank has set aside but not posted: card spend awaiting
        settlement, transfers on their way out, holds on money coming in. None
        of it has reached Reconcile or book value, and the Bank figure has
        already had it deducted.{" "}
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
              <Text className="w-20 text-right text-[11px] font-semibold uppercase tracking-wide text-faint">
                Pending
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
                {/* Everything the bank has set aside but not posted — NOT just
                    card authorizations, which is what this column claimed until
                    2026-08-08 (Increase computes it as current minus available,
                    which nets every pending category: card spend, outbound
                    transfers, inbound-funds holds). It's already OUT of the Bank
                    figure and not yet IN the ledger, so showing it is what makes
                    the two columns reconcile by eye. The drill-down itemises it
                    by category. */}
                <View className="w-20 items-end">
                  {row.pendingCents == null ? (
                    <Text className="text-2xs text-faint">—</Text>
                  ) : (
                    <Text
                      className={`text-sm ${row.pendingCents > 0 ? "text-warn" : "text-faint"}`}
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {formatCents(row.pendingCents)}
                    </Text>
                  )}
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </Card>
      {stripe && (stripe.availableCents != null || stripe.pendingCents != null) ? (
        <Text className="mt-2 text-2xs text-muted">
          Held at Stripe: {formatCents(stripe.availableCents ?? 0)} available
          {stripe.pendingCents ? ` · ${formatCents(stripe.pendingCents)} still clearing` : ""}
          {stripe.asOf ? ` · as of ${shortDate(stripe.asOf)}` : ""}. Not in any
          book until it pays out.
        </Text>
      ) : null}
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

/**
 * What a payout row's badge should say — derived from facts that are still
 * true, never from the stored `processState`.
 *
 * `processState` described the pre-#553 allocation step (itemise the payout at
 * Stripe, split it between books, book transfer pairs). That step is gone:
 * chapters are settled against their books instead. So "Allocated" describes
 * work nobody does, and "Failed" — rendered in red, over a raw Stripe error
 * blob — announced the failure of work nobody attempts. This deployment has
 * exactly one such row, and it alarmed the person it was meant to inform.
 *
 * The two facts that still matter are Stripe's own lifecycle status (did the
 * money actually go out?) and whether we found the deposit it arrived as (is it
 * at risk of being counted twice?). Both are things a reader can act on.
 */
function payoutState(po: {
  stripeStatus: string;
  depositMatched: boolean;
}): { label: string; tone: "success" | "warn" | "danger" | "neutral" } {
  if (po.stripeStatus === "failed" || po.stripeStatus === "canceled") {
    return { label: `Stripe says ${po.stripeStatus}`, tone: "danger" };
  }
  if (po.stripeStatus !== "paid") {
    return { label: "On its way", tone: "neutral" };
  }
  return po.depositMatched
    ? { label: "Deposit found & labelled", tone: "success" }
    : { label: "Looking for the deposit", tone: "warn" };
}

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
      {/* REWRITTEN 2026-08-08. This paragraph described per-payout allocation —
          "moves each book's share of the deposit onto its own book (net of
          fees)" — which #553 deleted three months earlier. It was telling
          readers the engine did work it no longer attempts, on the page they
          consult to find out what the engine did. */}
      <Text className="mb-3 text-sm text-muted">
        Once a morning the engine does three things. It finds each Stripe payout
        and labels the bank deposit it arrived as, so that deposit isn&apos;t
        counted as income on top of the donations and ticket sales it was
        already paying for. It settles cross-book card spend, where one
        book&apos;s card paid for another book&apos;s costs. Then it compares
        every chapter&apos;s book value to what&apos;s actually in its bank
        account and moves the difference — payouts all land in central, so
        central holds what the chapters earned until this runs.{" "}
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
              Looking at payouts arriving since {shortDate(overview.sinceMs)}.
              Older deposits stay however they were hand-coded.
            </Text>
          ) : (
            <Text className="text-2xs text-faint">
              The first run will start from that moment forward — history stays
              however it was hand-coded.
            </Text>
          )}

          {lastRun ? (
            <View className="gap-0.5 rounded-lg border border-border bg-sunken/40 px-3 py-2">
              <Text className="text-2xs text-muted">
                {lastRun.payoutsProcessed} payout(s) checked ·{" "}
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
              Payouts Stripe has sent us
            </Text>
            {/* "DETECTED PAYOUTS" with a bare red "Failed" badge told a reader
                nothing — the founder's question was literally "what does
                detected payouts mean and what does it mean that it failed, do I
                have to do anything?" Every row now says what it is, what state
                it's in, and whether that state wants a human. */}
            <Text className="text-2xs text-muted">
              Each time Stripe pays out, the cash lands as one deposit in
              central&apos;s bank account. All the engine does with it is find
              that deposit and label it, so it isn&apos;t counted as income on
              top of the donations and ticket sales it was paying for. Nothing
              here needs a decision from you unless a row says so.
            </Text>
            {overview.payouts.length === 0 ? (
              <Text className="text-2xs text-muted">
                No Stripe payouts yet — they&apos;ll appear here as they arrive.
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
                          {isExpanded ? "Hide details" : "Tap for details"}
                        </Text>
                      </Pressable>
                      {/* Badged from FACTS, not from `processState`. That field
                          only ever described the per-payout allocation step,
                          which #553 removed — so a stored "failed" describes
                          work the engine no longer attempts and is not a live
                          problem. What still means something is Stripe's own
                          status and whether we found the deposit. */}
                      <Badge
                        label={payoutState(po).label}
                        tone={payoutState(po).tone}
                      />
                      {po.automatic === false ? (
                        <Badge label="You sent this one" tone="neutral" />
                      ) : null}
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
                        <Text
                          className={`text-2xs ${po.depositMatched ? "text-faint" : "text-warn"}`}
                        >
                          {po.depositMatched
                            ? "We found this payout's deposit in the bank feed and labelled it, so it isn't double-counted as income."
                            : "We haven't found this payout's deposit in the bank feed yet. The engine looks again every morning; deposits usually take a day or two to sync. Until it's found, that deposit may be counting as income on top of the revenue it was paying for."}
                        </Text>
                        {po.automatic === false ? (
                          <Text className="text-2xs text-faint">
                            Initiated by hand in the Stripe dashboard rather than
                            by the payout schedule. Nothing to do — it&apos;s
                            noted because Stripe treats manual payouts
                            differently and this used to make the row look
                            broken.
                          </Text>
                        ) : null}
                        {/* Historical only: no code has written an allocation
                            since #553, so this renders on pre-#553 rows and
                            never on new ones. Kept so the record of what the
                            engine once did to a payout stays readable. */}
                        {po.allocation.length > 0 ? (
                          <>
                            <Text className="mt-1 text-2xs text-faint">
                              Historical per-book split (the engine no longer
                              splits payouts — chapters are settled against
                              their books instead):
                            </Text>
                            {po.allocation.map((entry) => (
                              <View
                                key={entry.scope}
                                className="flex-row items-center justify-between gap-3"
                              >
                                <Text
                                  className="flex-1 text-2xs text-muted"
                                  numberOfLines={1}
                                >
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
                          </>
                        ) : null}
                        {/* Only ever populated alongside a failed/canceled
                            Stripe status now — the server drops obsolete
                            allocation-era blobs rather than alarming a reader
                            with an error about work nothing attempts. */}
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

/**
 * `balance_settlement` was missing here until 2026-08-08 — and it is the origin
 * the engine books MOST often, every morning, since #553 replaced per-payout
 * allocation with "bring each chapter's cash to its book". `ORIGIN_BADGE[row
 * .origin]` returned undefined for those rows and the next line read `.label`
 * off it, so the transfer history threw as soon as one existed. The typechecker
 * had been reporting exactly this since #553 landed.
 */
const ORIGIN_BADGE: Record<
  "manual" | "payout_allocation" | "auto_settlement" | "balance_settlement",
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
  balance_settlement: {
    label: AUTO_TRANSFER_ORIGIN_LABELS.balance_settlement,
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
