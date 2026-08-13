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
 * Read-only. Everything editable about a sale is editable in the grid, one cell
 * at a time, and duplicating those controls here would create two places for the
 * same decision to be made and disagree about.
 */
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, CopyButton, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  formatCents,
  itemsLabel,
  longDateTime,
  ITEM_SOURCE_LABELS,
  type SaleRow,
} from "./helpers";

export function SaleDetailModal({
  row,
  onClose,
}: {
  row: SaleRow;
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
