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
  selected = false,
  onOpen,
  onUpload,
  generateUploadUrl,
}: {
  txn: MyTxnRow;
  todo: ChargeTodo;
  last: boolean;
  /** The wide-screen workbench panel (`coding.tsx`) is open on this exact
   *  row — see `Row`'s own doc. `false` on every host that has no panel
   *  (narrow screens, which keep the modal). */
  selected?: boolean;
  onOpen: () => void;
  onUpload: (storageId: Id<"_storage">, filename: string | null) => Promise<void>;
  generateUploadUrl: () => Promise<string>;
}) {
  const sentBack = todo.kind === "sent_back";

  return (
    <>
      <Row last={last && !sentBack} selected={selected}>
        <Cell flex={2}>
          <View className="flex-row items-center gap-2">
            {/* `shrink min-w-0` is what makes numberOfLines actually truncate
                on web — without it the nowrap text keeps its intrinsic width
                and the fixed-width cells to the right paint straight over it
                (the founder's "amounts on top of the merchant" screenshot). */}
            <Text
              className="shrink min-w-0 text-sm font-semibold text-ink"
              numberOfLines={1}
            >
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
            isPersonal={txn.isPersonal}
            transactionId={txn.id as Id<"transactions">}
            onUpload={onUpload}
            generateUploadUrl={generateUploadUrl}
            // NO LIBRARY PICKER HERE. This row renders for the caller's OWN
            // charges — on `/code` that caller can be a volunteer with no
            // finance seat at all — and the picker reads
            // `receipts.listReceipts`, which requires bookkeeper rank. A
            // Convex query throws as soon as it mounts, so tapping the search
            // icon didn't degrade: it unwound to the root ErrorBoundary and
            // replaced the whole page, every charge, with a crash screen.
            //
            // Every other host of this cell already passes this
            // (`MoneyView`, `CodingDocumentation` ×2, `ReceiptPane`); this
            // was the one call site that didn't, on the one screen whose
            // whole audience is people without the rank.
            libraryPicker={false}
          />
        </Cell>
        <Cell width={110} align="right">
          {/* SAY THE VERB THE EMAIL SAID. This button read "Finish" —
              which is what you press AFTER doing something, not the way IN
              to doing it. The chase email's own button says "Code it →"
              (`cards.ts`), the badge one cell to the left says "Needs
              coding", and then the only control on the row asked you to
              finish a thing you had not been shown how to start. A
              cardholder's report, 2026-08-31: "i don't know if i have the
              ability to code this transaction from my side, I cant select
              anything except for uploading the receipt" — the receipt cell
              was the only thing on the row that named what it did, so it
              read as the only thing she was allowed to do.

              Everything else gets a quiet "View": `ghost`'s text is
              brand-red (`text-accent`), so every settled/in-review row used
              to render in the same alarmed color as a row that genuinely
              needed you (#founder feedback: "it says receipt attached, but
              then Open — what is it for?"). `muted` is the same shape with
              neutral text instead. */}
          <Button
            title={todo.actionable ? "Code it" : "View"}
            variant={todo.actionable ? "primary" : "muted"}
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

/**
 * THE PHONE SHAPE of a charge. `ChargeRow` is a table row whose cells are
 * fixed at 110 + 185 + 130 + 110 = 535px before gaps and padding, inside a
 * `Table` that is `overflow-hidden` with no horizontal scroller — so on a
 * 390px viewport the "still needs" badge, the receipt control and the
 * primary action button were all painted past the right edge and clipped.
 *
 * That is the whole failure of `/code`, because `/code` is a link sent by
 * email and email is opened on a phone: the one page built for volunteers
 * had no reachable primary action on the device they use.
 *
 * A stacked card, not a horizontal scroller — coding a receipt is a list of
 * chores, not a spreadsheet, and nobody should have to drag sideways to
 * find the button. Same props, same `chargeTodo` vocabulary, same
 * `ReceiptCell` (with the library picker off — see `ChargeRow`).
 */
export function ChargeCard({
  txn,
  todo,
  onOpen,
  onUpload,
  generateUploadUrl,
}: {
  txn: MyTxnRow;
  todo: ChargeTodo;
  onOpen: () => void;
  onUpload: (storageId: Id<"_storage">, filename: string | null) => Promise<void>;
  generateUploadUrl: () => Promise<string>;
}) {
  return (
    <View className="mb-2.5 rounded-xl border border-border bg-raised p-3.5">
      <View className="mb-2 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-base font-semibold text-ink" numberOfLines={2}>
            {displayMerchantName(txn)}
          </Text>
          <Text className="mt-0.5 text-xs text-muted">
            {new Date(txn.postedAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </Text>
        </View>
        <SignedMoney cents={txn.amountCents} flow={txn.flow} />
      </View>

      <View className="mb-3 flex-row flex-wrap items-center gap-2">
        <Badge label={todo.label} tone={todo.tone} />
        <ReceiptCell
          hasReceipt={txn.hasReceipt}
          reminderStage={txn.reminderStage}
          isPersonal={txn.isPersonal}
          transactionId={txn.id as Id<"transactions">}
          onUpload={onUpload}
          generateUploadUrl={generateUploadUrl}
          libraryPicker={false}
        />
      </View>

      {/* Full width, always reachable — the point of this component. Same
          verb as the row and the email that sent you here; see `ChargeRow`. */}
      <Button
        title={todo.actionable ? "Code this charge" : "View"}
        variant={todo.actionable ? "primary" : "muted"}
        size="sm"
        className="w-full"
        onPress={onOpen}
      />
    </View>
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
