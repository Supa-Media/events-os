/**
 * ChargeRow — one of the member's own charges, and what it still owes.
 *
 * Split out of the route file so the screen keeps to queries, ordering and
 * state (see `@supa-media/linter`'s route-file rule). Everything about how a
 * row READS lives here:
 *
 *  - the "still needs" badge, whose words come from `chargeTodo` and therefore
 *    match the reminder email that sent this person here;
 *  - the receipt cell, the identical `ReceiptCell` the Reconcile grid uses, so
 *    uploading behaves the same everywhere;
 *  - THE SEND-BACK NOTE, quoted in full on its own strip under the row. A
 *    badge saying "changes requested" tells somebody they have work; only the
 *    note tells them what the work is, and for the person who has to act on it
 *    that sentence is the most useful string on the page. Tapping it opens the
 *    sheet, because reading it is the moment you want to fix it.
 */
import { Pressable, Text, View } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Cell, Icon, Row } from "../../ui";
import { colors } from "../../../lib/theme";
import { SignedMoney } from "../dashboard/parts";
import { ReceiptCell } from "../reconcile/ReconcileList";
import type { ChargeTodo, MyTxnRow } from "./chargeTodo";

/** `YYYY-MM-DD` in the finance timezone for display (mirrors MemberView). */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

export function ChargeRow({
  txn,
  todo,
  reviewNote,
  last,
  onOpen,
  onUpload,
  generateUploadUrl,
}: {
  txn: MyTxnRow;
  todo: ChargeTodo;
  reviewNote: string | null;
  last: boolean;
  onOpen: () => void;
  onUpload: (storageId: Id<"_storage">) => Promise<void>;
  generateUploadUrl: () => Promise<string>;
}) {
  const sentBack = todo.kind === "sent_back" && reviewNote != null;

  return (
    <>
      <Row last={last && !sentBack}>
        <Cell flex={2}>
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
              {txn.merchantName ?? txn.description ?? "—"}
            </Text>
            {txn.isPersonal ? <Badge label="Personal" tone="accent" /> : null}
          </View>
          <Text className="text-xs text-muted" numberOfLines={1}>
            {[
              dateStr(txn.postedAt),
              txn.merchantName ? txn.description : null,
              txn.cardLast4 ? `card ••${txn.cardLast4}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {txn.note ? (
            <Text className="mt-0.5 text-xs italic text-muted" numberOfLines={2}>
              {txn.note}
            </Text>
          ) : null}
        </Cell>
        <Cell width={110} align="right">
          <SignedMoney
            cents={txn.amountCents}
            flow={txn.flow}
            className="text-sm font-semibold"
          />
        </Cell>
        <Cell width={185}>
          <Badge label={todo.label} tone={todo.tone} />
        </Cell>
        <Cell width={130}>
          <ReceiptCell
            hasReceipt={txn.hasReceipt}
            reminderStage={txn.reminderStage}
            transactionId={txn.id as Id<"transactions">}
            onUpload={onUpload}
            generateUploadUrl={generateUploadUrl}
          />
        </Cell>
        <Cell width={110} align="right">
          <Button
            title={todo.actionable ? "Finish" : "Open"}
            variant={todo.actionable ? "primary" : "ghost"}
            size="sm"
            onPress={onOpen}
          />
        </Cell>
      </Row>

      {sentBack ? (
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          className={`bg-danger-bg px-4 py-2.5 active:opacity-80 ${
            last ? "" : "border-b border-border"
          }`}
        >
          <View className="flex-row items-start gap-2">
            <Icon name="corner-up-left" size={13} color={colors.danger} />
            <View className="flex-1">
              <Text className="text-2xs font-semibold uppercase tracking-wide text-danger">
                Sent back to you
              </Text>
              <Text className="mt-0.5 text-sm text-ink">“{reviewNote}”</Text>
            </View>
          </View>
        </Pressable>
      ) : null}
    </>
  );
}

/** The two-state list filter. Deliberately not a `Select`: there are two
 *  choices and one of them is what the reminder email sent you here for. */
export function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      className={`rounded-full border px-3 py-1 active:opacity-70 ${
        active ? "border-accent bg-accent/10" : "border-border bg-sunken"
      }`}
    >
      <Text
        className={`text-xs ${active ? "font-semibold text-accent" : "text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
