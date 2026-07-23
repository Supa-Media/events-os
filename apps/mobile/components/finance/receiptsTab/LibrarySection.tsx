/**
 * RECEIPTS TAB — Library section (item 3 of the receipt CRM UI plan): "all
 * receipts represented" — every receipt document in the chapter, backed by
 * `api.receipts.listReceipts`. Filter chips (All / Unmatched / Matched) are
 * server-side (mirrors the Inbox section + Reconcile's own filter-pill
 * idiom); a receipt card shows its thumbnail, canonical amount/date/merchant,
 * sender-class + source badges, link count, and duplicate flags.
 */
import { Image, Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, EmptyState, Icon, Pill } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import {
  formatCents,
  senderClassLabel,
  senderClassTone,
  LIBRARY_FILTERS,
  type LibraryFilterKey,
  type ReceiptRow,
} from "./helpers";

const SOURCE_LABEL: Record<ReceiptRow["source"], string> = {
  email: "Emailed",
  upload: "Uploaded",
  sms: "Texted",
};

export function LibrarySection({
  filter,
  onFilterChange,
  onOpenReceipt,
}: {
  filter: LibraryFilterKey;
  onFilterChange: (f: LibraryFilterKey) => void;
  onOpenReceipt: (receiptId: Id<"receipts">) => void;
}) {
  const rows = useQuery(api.receipts.listReceipts, { filter });
  const byId = new Map<Id<"receipts">, ReceiptRow>((rows ?? []).map((r) => [r._id, r]));

  return (
    <View>
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="font-display text-lg text-ink">Library</Text>
        {rows ? (
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {rows.length} {rows.length === 1 ? "receipt" : "receipts"}
          </Text>
        ) : null}
      </View>

      <View className="mb-3 flex-row flex-wrap gap-2">
        {LIBRARY_FILTERS.map((f) => (
          <Pill key={f.key} label={f.label} selected={filter === f.key} onPress={() => onFilterChange(f.key)} />
        ))}
      </View>

      {rows === undefined ? (
        <View className="py-10">
          <EmptyState title="Loading receipts…" />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="image"
          title="No receipts yet"
          message="Upload one above, or ask the team to email receipts to receipts@reply.publicworship.life."
        />
      ) : (
        <View className="flex-row flex-wrap gap-3">
          {rows.map((r) => (
            <ReceiptCard
              key={r._id}
              receipt={r}
              onPress={() => onOpenReceipt(r._id)}
              onJumpToOriginal={
                r.duplicateOfReceiptId
                  ? () => onOpenReceipt(r.duplicateOfReceiptId as Id<"receipts">)
                  : undefined
              }
              original={r.duplicateOfReceiptId ? byId.get(r.duplicateOfReceiptId) : undefined}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function ReceiptCard({
  receipt,
  onPress,
  onJumpToOriginal,
  original,
}: {
  receipt: ReceiptRow;
  onPress: () => void;
  onJumpToOriginal?: () => void;
  original?: ReceiptRow;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="w-40 overflow-hidden rounded-lg border border-border bg-raised active:opacity-80"
    >
      <View className="h-24 w-full bg-sunken">
        {receipt.url ? (
          <Image source={{ uri: receipt.url }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
        ) : (
          <View className="flex-1 items-center justify-center">
            <Icon name="file-text" size={20} color={colors.faint} />
          </View>
        )}
      </View>
      <View className="gap-1 p-2.5">
        <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
          {receipt.amountCents != null ? formatCents(receipt.amountCents) : "No amount"}
        </Text>
        <Text className="text-2xs text-muted" numberOfLines={1}>
          {receipt.merchant ?? "Unknown merchant"}
        </Text>
        <Text className="text-2xs text-faint" numberOfLines={1}>
          {receipt.receiptDate != null ? formatDate(receipt.receiptDate) : formatDate(receipt.createdAt)}
        </Text>
        <View className="flex-row flex-wrap items-center gap-1 pt-0.5">
          <Badge label={senderClassLabel(receipt.senderClass)} tone={senderClassTone(receipt.senderClass)} />
          <Badge label={SOURCE_LABEL[receipt.source]} tone="neutral" />
        </View>
        {receipt.linkCount > 0 ? (
          <Text className="text-2xs font-semibold text-success">
            {receipt.linkCount} {receipt.linkCount === 1 ? "link" : "links"}
          </Text>
        ) : (
          <Text className="text-2xs text-faint">Unmatched</Text>
        )}
        {receipt.duplicateOfReceiptId ? (
          <Pressable onPress={onJumpToOriginal} hitSlop={4} className="gap-0.5">
            <Badge label="DUPLICATE" tone="danger" icon="copy" />
            {original ? (
              <Text className="text-2xs text-faint" numberOfLines={1}>
                of {original.merchant ?? formatCents(original.amountCents ?? 0)}
              </Text>
            ) : null}
          </Pressable>
        ) : receipt.softDuplicate ? (
          <Badge label="Possible duplicate" tone="warn" icon="alert-triangle" />
        ) : null}
      </View>
    </Pressable>
  );
}
