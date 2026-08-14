/**
 * The multi-select bulk bar for the Reconcile grid: appears when one or more
 * rows are checked and offers the batch actions — set Category, set For (both
 * via `bulkCategorize`), Explain (one written sentence across the selection,
 * `transactionCodings.submitBulk`), and mark Closed (a loop over the
 * per-row status setter). Category / For open the same `PickerItem` popover the
 * grid cells use, so the option lists never drift.
 */
import { View, Text, Pressable } from "react-native";
import { Button, Icon, OptionTag, Popover, useAnchor } from "../../ui";
import { colors } from "../../../lib/theme";
import type { PickerItem } from "./ReconcileList";

export function BulkBar({
  count,
  categoryItems,
  forItems,
  onSetCategory,
  onSetFor,
  onMarkReconciled,
  onClear,
  hideCategory = false,
  spansBooks = false,
  reassignItems,
  onReassign,
  onMarkTransfer,
  onMarkRefund,
  onMarkPayout,
  onNoDocumentation,
  onExplain,
}: {
  count: number;
  categoryItems: PickerItem[];
  forItems: PickerItem[];
  onSetCategory: (categoryId: string | null) => void;
  onSetFor: (value: string | null) => void;
  onMarkReconciled: () => void;
  onClear: () => void;
  // WP-2.1: hide "Set category" in central scope — central txns have no
  // categories (chapter-only), so only For + Mark closed apply.
  hideCategory?: boolean;
  // The selection spans BOOKS (central + at least one chapter) — only possible
  // in the merged all-books queue. Coding is book-specific: a central charge
  // takes no category and only a central budget, a chapter charge the reverse.
  // There's no option list that's correct for both, so rather than offer one
  // that half-fails, the two coding pickers step aside and say why. Every
  // book-agnostic action (Mark closed, Reassign, transfer/payout marking)
  // stays exactly where it was.
  spansBooks?: boolean;
  // WP-2.2: central-seat holders can move the selection to another BOOK (→
  // Central or a chapter). Absent for chapter-only reconcilers.
  //
  // Labelled "Fix who paid", not "Reassign to". This rewrites custody — which
  // account the money left — and since cross-book attribution shipped there is
  // a second control ("For") that also makes a charge belong to another book,
  // by budget, without touching custody. That one is the everyday case; this
  // one is a data correction. A neutral label let them be confused, and
  // confusing them silently breaks a book's bank reconciliation. `onReassign`
  // now opens `MoveBookModal` rather than committing on the tap.
  reassignItems?: PickerItem[];
  onReassign?: (target: string | null) => void;
  // "No documentation" across the whole selection (owner ask, 2026-08-05:
  // "there's a lot of subway transactions I'm just going to have to mark as
  // not receiptable"). Lives on the BAR rather than only per-row because the
  // realistic backlog is dozens-to-hundreds of small fares, and a per-row-only
  // path means the honest option loses to the dishonest one on effort alone.
  onNoDocumentation?: () => void;
  // ── THE EXPLANATION, ACROSS THE SELECTION ─────────────────────────────────
  // The bar could batch every cheap field on a row — category, budget, status,
  // "no documentation" — and not the one thing that takes real time to type.
  // So forty identical MTA fares cost forty typings of one sentence, and the
  // cheap dishonest option (close them undocumented, publish a blank) won on
  // effort. Exactly the argument `onNoDocumentation` above already won for the
  // other half of the row.
  //
  // One human's sentence applied to rows that human selected is not machine
  // authorship — see `BulkExplainModal`'s own doc, and
  // `transactionCodings.submitBulk`, which writes one coding per row through
  // the SAME validated path a typed one takes and reports every row it
  // refused.
  //
  // BOOK-SPECIFIC, like the two coding pickers above it: a coding belongs to
  // its book, so a selection spanning books steps aside with the same message
  // rather than half-failing.
  onExplain?: () => void;
  // Marking (founder ask): reclassify already-ingested bank rows. "Mark as
  // transfer" lives HERE rather than on a row because a transfer is a PAIR —
  // it needs two rows selected, which is exactly what this bar has and a row
  // action doesn't. It's shown at any selection size but only enabled at two,
  // so the requirement is discoverable instead of the button being missing.
  onMarkTransfer?: () => void;
  onMarkPayout?: () => void;
  // "Mark as refund" is a PAIR too, for the same reason as transfer — but a
  // different meaning: a transfer belongs to no budget, whereas a refund exists
  // precisely so the ORIGINAL CHARGE stops counting against one.
  onMarkRefund?: () => void;
}) {
  const canMarkTransfer = count === 2;
  return (
    <View className="mb-3 flex-row flex-wrap items-center gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-2.5">
      <Text className="text-sm font-semibold text-ink">
        {count} selected
      </Text>
      <View className="flex-row flex-wrap items-center gap-2">
        {spansBooks ? (
          <Text className="text-xs text-muted">
            Mixed books — select one book&apos;s charges to code them
          </Text>
        ) : (
          <>
            {!hideCategory ? (
              <BulkPicker
                label="Set category"
                items={categoryItems}
                onPick={onSetCategory}
              />
            ) : null}
            <BulkPicker
              label="Set for"
              items={forItems}
              onPick={onSetFor}
            />
            {/* Beside the other two coding actions, and inside the same
                `spansBooks` guard, because it is one: a coding belongs to a
                book. */}
            {onExplain ? (
              <Button
                title="Explain"
                variant="secondary"
                size="sm"
                icon="edit-3"
                onPress={onExplain}
              />
            ) : null}
          </>
        )}
        <Button
          title="Mark closed"
          variant="primary"
          size="sm"
          icon="check"
          onPress={onMarkReconciled}
        />
        {reassignItems && onReassign ? (
          <BulkPicker
            label="Fix who paid"
            items={reassignItems}
            onPick={onReassign}
          />
        ) : null}
        {onMarkTransfer ? (
          <Button
            title="Mark as transfer"
            variant="secondary"
            size="sm"
            icon="repeat"
            disabled={!canMarkTransfer}
            onPress={onMarkTransfer}
          />
        ) : null}
        {onMarkRefund ? (
          <Button
            title="Mark as refund"
            variant="secondary"
            size="sm"
            icon="corner-up-left"
            disabled={!canMarkTransfer}
            onPress={onMarkRefund}
          />
        ) : null}
        {onMarkPayout ? (
          <Button
            title="Mark as payout"
            variant="secondary"
            size="sm"
            icon="download"
            onPress={onMarkPayout}
          />
        ) : null}
        {onNoDocumentation ? (
          <Button
            title="No documentation"
            variant="secondary"
            size="sm"
            icon="edit-3"
            onPress={onNoDocumentation}
          />
        ) : null}
      </View>
      {(onMarkTransfer || onMarkRefund) && !canMarkTransfer ? (
        <Text className="w-full text-[11px] text-faint">
          A transfer or refund needs both rows — select the two that move the
          same amount, one out and one back in.
        </Text>
      ) : null}
      <Pressable
        onPress={onClear}
        hitSlop={8}
        accessibilityLabel="Clear selection"
        className="ml-auto rounded p-1 active:opacity-70"
      >
        <Icon name="x" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

/** A labelled button that opens a Popover of options and reports the pick. */
function BulkPicker({
  label,
  items,
  onPick,
}: {
  label: string;
  items: PickerItem[];
  onPick: (value: string | null) => void;
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
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {items.map((it) =>
            it.header ? (
              <Text
                key={it.value}
                className="px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-muted"
              >
                {it.label}
              </Text>
            ) : (
              <Pressable
                key={it.value}
                onPress={() => {
                  onPick(it.value === "" ? null : it.value);
                  close();
                }}
                className="px-3 py-2 active:bg-sunken web:hover:bg-sunken"
              >
                {it.value === "" ? (
                  <Text className="text-sm text-muted">{it.label}</Text>
                ) : (
                  <OptionTag label={it.label} />
                )}
              </Pressable>
            ),
          )}
        </View>
      </Popover>
    </>
  );
}
