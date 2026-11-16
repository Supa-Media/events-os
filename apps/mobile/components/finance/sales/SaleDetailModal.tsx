/**
 * SaleDetailModal — the per-row detail affordance, and the answer to "why does
 * this row say that?"
 *
 * The grid is deliberately terse: a truncated payment ref, a date without a
 * time, a breakdown without its provenance. All of that is right for scanning
 * 186 rows and wrong for the moment a treasurer stops on one because it looks
 * off. This is that moment's screen — the full timestamp (two $3 taps a minute
 * apart are only tellable apart by it), the whole payment reference, the money
 * broken out, a plain sentence about HOW the breakdown was arrived at, every
 * reading the amount allows, and who has changed what.
 *
 * The history reads `finances.financeAuditTrail` — the SHARED finance audit
 * table every other field change already writes to — rather than a bespoke
 * per-sale store, which is the same call `MerchantHistoryModal` made and for the
 * same reason: one trail every finance surface writes to is worth more than
 * several that each know a fraction of the story. Newest first, matching the
 * transaction detail modal's own History section.
 *
 * Everything editable about a sale's FACTS is editable in the grid, one cell at
 * a time, and duplicating those controls here would create two places for the
 * same decision to be made and disagree about. The one action that lives here
 * is the refund (`saleRefunds.ts`): it moves money, so it belongs behind a
 * deliberate open-and-confirm rather than a cell anyone can brush past.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, CopyButton, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";
import {
  canStartRefund,
  formatCents,
  itemsLabel,
  longDateTime,
  ITEM_SOURCE_LABELS,
  REFUND_STATUS_LONG,
  REFUND_STATUS_SHORT,
  type SaleRow,
} from "./helpers";

export function SaleDetailModal({
  row,
  canRefund,
  run,
  onClose,
}: {
  row: SaleRow;
  /** Server-resolved: may this caller send refunds at all. */
  canRefund: boolean;
  run: ActionRunner["run"];
  onClose: () => void;
}) {
  // Only an in-person sale has an audit trail to show: the trail records the
  // two edits this page allows (basket, event attribution), and neither is
  // offered on a ticket order — its items and event come from the order itself.
  // Skipping keeps the query from being asked for a subject id that can't exist.
  const trail = useQuery(
    api.finances.financeAuditTrail,
    row.saleId ? { subjectType: "sale", subjectId: row.saleId } : "skip",
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <View className="min-w-0 flex-1">
              <Text className="font-display text-lg text-ink">
                {formatCents(row.grossCents)}
              </Text>
              <Text className="text-2xs text-faint">{longDateTime(row.soldAt)}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-96 px-5 py-4">
            <DetailRow label="Event" value={row.eventName ?? "Unattributed"} />
            <DetailRow label="Items" value={itemsLabel(row)} />
            <DetailRow
              label="How we know"
              value={ITEM_SOURCE_LABELS[row.itemSource] ?? row.itemSource}
            />
            <DetailRow
              label="Channel"
              value={row.channel === "in_person" ? "Card present, in person" : "Online"}
            />

            {/* Gross vs banked, spelled out. A treasurer reconciling against a
                bank statement sees the NET arrive while the books count the
                GROSS, and this line is what stops that difference reading as a
                shortfall. */}
            <View className="mt-3 rounded-lg border border-border bg-sunken px-3 py-2">
              <MoneyLine label="Gross" cents={row.grossCents} strong />
              <MoneyLine label="Stripe fee" cents={row.feeCents} />
              <MoneyLine label="Banked" cents={row.netCents} />
            </View>

            <View className="mt-3">
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                Payment
              </Text>
              <View className="flex-row items-center gap-2">
                <Text className="flex-1 text-xs text-ink" selectable>
                  {row.paymentRef || "—"}
                </Text>
                {row.paymentRef ? <CopyButton text={row.paymentRef} /> : null}
              </View>
            </View>

            {/* Every reading, including the ones not chosen. Showing the
                alternatives is what makes a chosen basket auditable — "why is
                this a popcorn and not five waters" has an answer only if the
                five waters are visible too. */}
            <View className="mt-3">
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                {`What ${formatCents(row.grossCents)} could be`}
              </Text>
              {row.itemOptions.length === 0 ? (
                <Text className="text-xs text-muted">
                  {row.hasCatalog
                    ? "No combination of that day's prices makes this amount."
                    : "No price list is on file for the day this sale happened."}
                </Text>
              ) : (
                <View className="gap-0.5">
                  {row.itemOptions.map((o) => (
                    <Text
                      key={o.key}
                      className={`text-xs ${
                        o.key === row.itemsKey ? "font-semibold text-ink" : "text-muted"
                      }`}
                    >
                      {o.key === row.itemsKey ? `${o.label}  ✓` : o.label}
                    </Text>
                  ))}
                </View>
              )}
            </View>

            {row.kind === "ticket" ? (
              <RefundSection row={row} canRefund={canRefund} run={run} />
            ) : null}

            <View className="mt-4 border-t border-border pt-3">
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                History
              </Text>
              {trail === undefined ? (
                <Text className="text-xs text-muted">Loading…</Text>
              ) : trail.length === 0 ? (
                <Text className="text-xs text-muted">
                  Nobody has changed this row since it was imported.
                </Text>
              ) : (
                <View className="mt-1 gap-2">
                  {trail.map((r) => (
                    <View key={r.id} className="border-l-2 border-accent pl-3">
                      <Text className="text-xs text-ink">
                        {r.before ?? "—"} → {r.after ?? "—"}
                      </Text>
                      <Text className="text-2xs text-faint">
                        {r.actorName ?? "Unknown"} · {longDateTime(r.createdAt)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </ScrollView>

          <View className="flex-row justify-end border-t border-border px-5 py-4">
            <Button title="Done" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="mb-2">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text className="text-sm text-ink">{value}</Text>
    </View>
  );
}

function MoneyLine({
  label,
  cents,
  strong = false,
}: {
  label: string;
  cents: number;
  strong?: boolean;
}) {
  return (
    <View className="flex-row items-baseline gap-3 py-0.5">
      <Text className={`flex-1 text-xs ${strong ? "text-ink" : "text-muted"}`}>
        {label}
      </Text>
      <Text
        className={`text-xs ${strong ? "font-semibold text-ink" : "text-muted"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {formatCents(cents)}
      </Text>
    </View>
  );
}

/**
 * The refund panel on a ticket order: current state, every attempt, and the
 * one button that fits — Refund, Reissue refund, or Check with Stripe.
 *
 * Two steps on purpose. The first press opens the confirm with the amount
 * spelled out and an optional reason; only the second sends money.
 */
function RefundSection({
  row,
  canRefund,
  run,
}: {
  row: SaleRow;
  canRefund: boolean;
  run: ActionRunner["run"];
}) {
  const orderId = row.id as Id<"ticketOrders">;
  const history = useQuery(api.saleRefunds.refundHistory, { orderId });
  const refund = useAction(api.saleRefunds.refundTicketOrder);
  const check = useAction(api.saleRefunds.checkRefund);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const status = row.refund?.status ?? null;
  const startable = canStartRefund(row);
  const stuck = status === "requested" || status === "pending";
  const reissue = status === "failed" || status === "canceled";

  async function send() {
    setBusy(true);
    const res = await run(
      () => refund({ orderId, reason: reason.trim() || undefined }),
      { errorTitle: reissue ? "Couldn't reissue the refund" : "Couldn't refund" },
    );
    setBusy(false);
    if (res) {
      setConfirming(false);
      setReason("");
    }
  }
  async function checkStatus() {
    if (!row.refund) return;
    setBusy(true);
    await run(() => check({ refundId: row.refund!.id }), {
      errorTitle: "Couldn't check with Stripe",
    });
    setBusy(false);
  }

  return (
    <View className="mt-4 border-t border-border pt-3">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        Refund
      </Text>

      {status ? (
        <View className="mt-1">
          <Text
            className={`text-sm font-semibold ${
              reissue ? "text-warn" : "text-ink"
            }`}
          >
            {REFUND_STATUS_SHORT[status]}
            {row.refund ? ` · ${formatCents(row.refund.amountCents)}` : ""}
          </Text>
          <Text className="text-xs text-muted">{REFUND_STATUS_LONG[status]}</Text>
          {row.refund?.failureReason ? (
            <Text className="mt-0.5 text-xs text-warn">
              Stripe said: {row.refund.failureReason}
            </Text>
          ) : null}
        </View>
      ) : !row.refundable ? (
        <Text className="mt-1 text-xs text-muted">
          This order wasn&apos;t paid through our Stripe checkout, so it has to be
          refunded where it was paid.
        </Text>
      ) : (
        <Text className="mt-1 text-xs text-muted">
          Not refunded. A refund returns {formatCents(row.grossCents)} to the
          buyer&apos;s card, voids their tickets, and takes the sale out of revenue.
          {row.buyerName ? ` Buyer: ${row.buyerName}.` : ""}
        </Text>
      )}

      {canRefund && stuck ? (
        <View className="mt-2 flex-row">
          <Button
            title="Check with Stripe"
            variant="secondary"
            loading={busy}
            onPress={() => void checkStatus()}
          />
        </View>
      ) : null}

      {canRefund && startable ? (
        confirming ? (
          <View className="mt-2 gap-2 rounded-lg border border-border bg-sunken p-3">
            <Text className="text-sm text-ink">
              {`Refund ${formatCents(row.grossCents)} to ${
                row.buyerName ?? "the buyer"
              }'s card? Their tickets will stop working. This can't be undone.`}
            </Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Reason (optional)"
              placeholderTextColor={colors.faint}
              maxLength={500}
              className="rounded-md border border-border-strong bg-raised px-3 py-2 text-sm text-ink"
            />
            <View className="flex-row justify-end gap-2">
              <Button
                title="Cancel"
                variant="ghost"
                disabled={busy}
                onPress={() => setConfirming(false)}
              />
              <Button
                title={reissue ? "Reissue refund" : `Refund ${formatCents(row.grossCents)}`}
                variant="danger"
                loading={busy}
                onPress={() => void send()}
              />
            </View>
          </View>
        ) : (
          <View className="mt-2 flex-row">
            <Button
              title={reissue ? "Reissue refund" : "Refund"}
              variant="secondary"
              onPress={() => setConfirming(true)}
            />
          </View>
        )
      ) : null}

      {!canRefund && startable ? (
        <Text className="mt-1 text-2xs text-faint">
          Refunds need the finance manager role.
        </Text>
      ) : null}

      {history && history.length > 0 ? (
        <View className="mt-3 gap-2">
          {history.map((h) => (
            <View key={h.id} className="border-l-2 border-border pl-3">
              <Text className="text-xs text-ink">
                {REFUND_STATUS_SHORT[h.status]} · {formatCents(h.amountCents)}
                {h.reason ? ` · ${h.reason}` : ""}
              </Text>
              {h.failureReason ? (
                <Text className="text-2xs text-warn">{h.failureReason}</Text>
              ) : null}
              <Text className="text-2xs text-faint">
                {h.requestedByName ?? "Unknown"} · {longDateTime(h.createdAt)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
