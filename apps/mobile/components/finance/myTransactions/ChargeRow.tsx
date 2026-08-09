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
 *  - THE SEND-BACK STRIP: a charge a reviewer returned gets its own full-width
 *    band under the row rather than a badge among badges, because "somebody
 *    read this and handed it back to you" is a different kind of news from
 *    "this is still on your list". The strip says a reviewer wrote a note and
 *    opens the sheet, where `getForTransaction` produces the note itself —
 *    the list payload deliberately doesn't carry a per-row string that only
 *    matters once one row is opened.
 */
import { Pressable, Text, View } from "react-native";
import { displayMerchantName } from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Cell, Icon, Radio, Row } from "../../ui";
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
  last,
  onOpen,
  onUpload,
  generateUploadUrl,
}: {
  txn: MyTxnRow;
  todo: ChargeTodo;
  last: boolean;
  onOpen: () => void;
  onUpload: (storageId: Id<"_storage">) => Promise<void>;
  generateUploadUrl: () => Promise<string>;
}) {
  const sentBack = todo.kind === "sent_back";

  return (
    <>
      <Row last={last && !sentBack}>
        <Cell flex={2}>
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
              {displayMerchantName(txn, "—")}
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
          <View className="flex-row items-center gap-2">
            <Icon name="corner-up-left" size={13} color={colors.danger} />
            <View className="flex-1">
              <Text className="text-2xs font-semibold uppercase tracking-wide text-danger">
                Sent back to you
              </Text>
              <Text className="mt-0.5 text-sm text-ink">
                A reviewer wrote you a note about this charge — open it to read
                what would make it approvable.
              </Text>
            </View>
            <Icon name="chevron-right" size={16} color={colors.danger} />
          </View>
        </Pressable>
      ) : null}
    </>
  );
}

/** The two-state list filter. Deliberately not a `Select`: there are two
 *  choices and one of them is what the reminder email sent you here for.
 *
 *  Renders a `Radio`, so it MUST be used inside a `RadioGroup` — the pair of
 *  chips is one question ("which charges?"), and the group is what makes it
 *  one tab stop with arrow keys between the answers. */
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
    <Radio
      checked={active}
      onSelect={onPress}
      accessibilityLabel={label}
      className={`rounded-full border px-3 py-1 active:opacity-70 ${
        active ? "border-accent bg-accent/10" : "border-border bg-sunken"
      }`}
    >
      <Text
        className={`text-xs ${active ? "font-semibold text-accent" : "text-muted"}`}
      >
        {label}
      </Text>
    </Radio>
  );
}
