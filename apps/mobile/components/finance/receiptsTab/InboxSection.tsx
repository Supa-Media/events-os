/**
 * RECEIPTS TAB — Inbox section (item 2 of the receipt CRM UI plan): every
 * inbound email the OCR pipeline has touched, backed by
 * `api.receipts.listInboundQueue` (the "upgraded review queue" — chapter rows
 * PLUS chapterless/unknown-sender rows every bookkeeper sees). Status chips
 * filter server-side (`listInboundQueue({status})`); "All" omits the arg,
 * which reads the same default set the backend itself surfaces
 * (`needs_review`/`no_match`/`error` — never `matched`/`ignored`/`pending`),
 * so Dismiss is always a legal action on every row here.
 */
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, EmptyState, Icon, Pill } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDateTime } from "../../../lib/format";
import { confirmAction } from "../../event/ticketing/helpers";
import type { ActionRunner } from "../../../lib/useActionToast";
import {
  formatCents,
  inboundStatusLabel,
  inboundStatusTone,
  senderClassLabel,
  senderClassTone,
  INBOX_STATUS_FILTERS,
  type InboundQueueRow,
  type InboxStatusFilter,
} from "./helpers";

export function InboxSection({
  run,
  onOpenReceipt,
}: {
  run: ActionRunner["run"];
  onOpenReceipt: (receiptId: Id<"receipts">) => void;
}) {
  const [filter, setFilter] = useState<InboxStatusFilter>("all");
  const rows = useQuery(api.receipts.listInboundQueue, {
    status: filter === "all" ? undefined : filter,
  });
  const dismiss = useMutation(api.receiptInbox.dismissInboundReceipt);

  function handleDismiss(row: { _id: Id<"inboundReceipts">; fromEmail: string }) {
    confirmAction({
      title: "Dismiss this email?",
      message: `This removes it from the review queue and clears any unmatched receipts it produced. Email from ${row.fromEmail}.`,
      confirmLabel: "Dismiss",
      destructive: true,
      onConfirm: () => {
        void run(() => dismiss({ receiptId: row._id }), {
          errorTitle: "Couldn't dismiss",
        });
      },
    });
  }

  return (
    <View className="mb-6">
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="font-display text-lg text-ink">Inbox</Text>
        {rows ? (
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {rows.length} {rows.length === 1 ? "email" : "emails"}
          </Text>
        ) : null}
      </View>

      <View className="mb-3 flex-row flex-wrap gap-2">
        {INBOX_STATUS_FILTERS.map((f) => (
          <Pill
            key={f.key}
            label={f.label}
            selected={filter === f.key}
            onPress={() => setFilter(f.key)}
          />
        ))}
      </View>

      {rows === undefined ? (
        <View className="py-10">
          <EmptyState title="Loading inbox…" />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="Nothing here"
          message="Receipts emailed to receipts@reply.publicworship.life land here for review."
        />
      ) : (
        <View className="gap-2">
          {rows.map((row) => (
            <InboxRow
              key={row._id}
              row={row}
              onOpenReceipt={onOpenReceipt}
              onDismiss={() => handleDismiss(row)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function InboxRow({
  row,
  onOpenReceipt,
  onDismiss,
}: {
  row: InboundQueueRow;
  onOpenReceipt: (receiptId: Id<"receipts">) => void;
  onDismiss: () => void;
}) {
  return (
    <View className="rounded-lg border border-border bg-raised p-3.5">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge label={inboundStatusLabel(row.status)} tone={inboundStatusTone(row.status)} />
        <Badge label={senderClassLabel(row.senderClass)} tone={senderClassTone(row.senderClass)} />
        <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
          {row.fromEmail}
        </Text>
        <Text className="text-2xs text-faint">{formatDateTime(row.receivedAt)}</Text>
      </View>

      {row.subject ? (
        <Text className="mt-1 text-sm text-ink" numberOfLines={1}>
          {row.subject}
        </Text>
      ) : null}
      {row.detail ? (
        <Text className="mt-1 text-xs text-muted" numberOfLines={2}>
          {row.detail}
        </Text>
      ) : null}

      {row.receipts.length > 0 ? (
        <View className="mt-3 flex-row flex-wrap gap-2">
          {row.receipts.map((r) => (
            <Pressable
              key={r._id}
              onPress={() => onOpenReceipt(r._id)}
              className="w-24 items-start active:opacity-70"
            >
              <View className="h-16 w-24 overflow-hidden rounded-md border border-border bg-sunken">
                {r.url ? (
                  <Image source={{ uri: r.url }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                ) : (
                  <View className="flex-1 items-center justify-center">
                    <Icon name="file-text" size={16} color={colors.faint} />
                  </View>
                )}
              </View>
              <Text className="mt-1 text-2xs font-semibold text-ink" numberOfLines={1}>
                {r.amountCents != null ? formatCents(r.amountCents) : "—"}
              </Text>
              <Text className="text-2xs text-faint" numberOfLines={1}>
                {r.merchant ?? "Unknown merchant"}
              </Text>
              {r.duplicateOfReceiptId ? (
                <View className="mt-0.5">
                  <Badge label="Duplicate" tone="danger" />
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : (
        <Text className="mt-2 text-2xs text-faint">No receipt file on this email.</Text>
      )}

      <View className="mt-3 flex-row justify-end border-t border-border pt-2.5">
        <Pressable onPress={onDismiss} hitSlop={6} className="active:opacity-70">
          <Text className="text-xs font-semibold text-danger">Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}
