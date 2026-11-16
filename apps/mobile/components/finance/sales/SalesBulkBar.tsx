/**
 * The multi-select bulk bar for the Sales grid, mirroring the Reconcile one:
 * appears when rows are checked, offers the batch actions, and clears itself.
 *
 * TWO ACTIONS, and they have very different eligibility.
 *
 * SET EVENT always applies — attributing a run of orphaned taps to the event
 * they were taken at is the most common bulk fix there is, and nothing about one
 * row's amount constrains another's event.
 *
 * SET ITEMS only applies when every selected row is offered the SAME readings,
 * which happens exactly when they share an amount and a day's price list. That
 * is not a rare case — Pop The Balloon has dozens of identical $3 taps, and
 * settling them one at a time is the drudgery this bar exists to remove — but a
 * mixed selection has no basket that is correct for all of it. Rather than offer
 * a picker that would half-apply (or, worse, silently skip the rows it didn't
 * fit), the picker steps aside and says why, exactly as `BulkBar` does for a
 * selection that spans books.
 *
 * REFUND applies to the selected Stripe ticket orders that aren't already
 * refunded, and only for a finance manager (`refundRows` arrives empty
 * otherwise). Same two-step confirm as the detail panel: the first press shows
 * the count and total and takes a reason; only the second sends money. Each
 * buyer is emailed by the server (`saleRefundNotices.ts`).
 *
 * Every selected row can be checked, whatever its kind, and each action says
 * how many of the selection it covers — a mixed selection is normal.
 */
import { useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { Button, Icon, OptionTag, Popover, useAnchor } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  formatCents,
  type BasketOption,
  type SaleEventOption,
  type SaleRow,
} from "./helpers";

export function SalesBulkBar({
  count,
  inPersonCount,
  refundRows,
  onRefund,
  events,
  basketOptions,
  sharedGrossCents,
  onSetEvent,
  onSetItems,
  onClear,
}: {
  count: number;
  events: SaleEventOption[];
  /** The readings every selected row shares, or `null` when they share none. */
  basketOptions: BasketOption[] | null;
  /** The one amount behind those readings — shown so the picker's heading can
   *  name what it is about to assert about every selected row. */
  sharedGrossCents: number | null;
  onSetEvent: (eventId: string | null) => void;
  onSetItems: (basketKey: string | null) => void;
  onClear: () => void;
  /** How many of the selection are in-person taps — the rows event/items touch. */
  inPersonCount: number;
  /** Selected rows a refund can be sent for (empty without the power). */
  refundRows: SaleRow[];
  onRefund: (reason: string) => Promise<{ refunded: number; failed: number }>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const refundTotal = refundRows.reduce((a, r) => a + r.grossCents, 0);
  const partial = inPersonCount > 0 && inPersonCount < count;

  async function sendRefunds() {
    setBusy(true);
    const { refunded, failed } = await onRefund(reason);
    setBusy(false);
    setConfirming(false);
    setReason("");
    setResult(
      failed === 0
        ? `Refunded ${refunded} sale${refunded === 1 ? "" : "s"}. Each buyer was emailed.`
        : `Refunded ${refunded}, ${failed} didn't go through — open those rows to reissue.`,
    );
  }

  return (
    <View className="mb-3 gap-2 rounded-lg border border-accent bg-accent-soft px-4 py-2.5">
      <View className="flex-row flex-wrap items-center gap-3">
        <Text className="text-sm font-semibold text-ink">{count} selected</Text>
        <View className="flex-row flex-wrap items-center gap-2">
          {refundRows.length > 0 ? (
            <Pressable
              onPress={() => {
                setResult(null);
                setConfirming(true);
              }}
              className="flex-row items-center gap-1 rounded-md border border-danger bg-raised px-3 py-1.5 active:opacity-70 web:hover:bg-sunken"
            >
              <Text className="text-sm font-medium text-danger">
                {`Refund ${refundRows.length} · ${formatCents(refundTotal)}`}
              </Text>
            </Pressable>
          ) : null}
          {inPersonCount > 0 ? (
            <BulkPicker
              label={
                partial ? `Set event (${inPersonCount} in person)` : "Set event"
              }
            >
              {(close) => (
                <>
                  <Pressable
                    onPress={() => {
                      onSetEvent(null);
                      close();
                    }}
                    className="px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                  >
                    <Text className="text-sm text-muted">Unattributed</Text>
                  </Pressable>
                  {events.map((e) => (
                    <Pressable
                      key={e.eventId}
                      onPress={() => {
                        onSetEvent(e.eventId);
                        close();
                      }}
                      className="px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                    >
                      <OptionTag label={e.name} />
                    </Pressable>
                  ))}
                </>
              )}
            </BulkPicker>
          ) : null}

          {inPersonCount === 0 ? null : basketOptions ? (
            <BulkPicker label="Set items">
              {(close) => (
                <>
                  <Text className="px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-faint">
                    {sharedGrossCents != null
                      ? `What each ${formatCents(sharedGrossCents)} could be`
                      : "What each could be"}
                  </Text>
                  {basketOptions.map((o) => (
                    <Pressable
                      key={o.key}
                      onPress={() => {
                        onSetItems(o.key);
                        close();
                      }}
                      className="px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                    >
                      <Text className="text-sm text-ink">{o.label}</Text>
                    </Pressable>
                  ))}
                  <Pressable
                    onPress={() => {
                      onSetItems(null);
                      close();
                    }}
                    className="border-t border-border px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                  >
                    <Text className="text-sm text-muted">
                      Leave them unresolved
                    </Text>
                  </Pressable>
                </>
              )}
            </BulkPicker>
          ) : (
            <Text className="text-xs text-muted">
              Mixed amounts — select taps of the same amount to set their items
              together
            </Text>
          )}
        </View>
        <Pressable
          onPress={onClear}
          hitSlop={8}
          accessibilityLabel="Clear selection"
          className="ml-auto rounded p-1 active:opacity-70"
        >
          <Icon name="x" size={16} color={colors.muted} />
        </Pressable>
      </View>

      {confirming ? (
        <View className="gap-2 rounded-lg border border-border bg-raised p-3">
          <Text className="text-sm text-ink">
            {`Refund ${refundRows.length} ticket sale${refundRows.length === 1 ? "" : "s"} (${formatCents(
              refundTotal,
            )} in total) to the buyers' cards? Their tickets will stop working and each buyer is emailed. This can't be undone.`}
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
              title={`Refund ${refundRows.length}`}
              variant="danger"
              loading={busy}
              onPress={() => void sendRefunds()}
            />
          </View>
        </View>
      ) : null}
      {result ? <Text className="text-xs text-ink">{result}</Text> : null}
    </View>
  );
}

/** A labelled button that opens a Popover. Takes a render prop rather than an
 *  item list because the two menus here have genuinely different shapes (one is
 *  event tags, the other is headed basket text) and flattening them into one
 *  option type would only re-create the difference with flags. */
function BulkPicker({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-row items-center gap-1 rounded-md border border-border-strong bg-raised px-3 py-1.5 active:opacity-70 web:hover:bg-sunken"
      >
        <Text className="text-sm font-medium text-ink">{label}</Text>
        <Icon name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={280}>
        <View className="py-1">{children(close)}</View>
      </Popover>
    </>
  );
}
