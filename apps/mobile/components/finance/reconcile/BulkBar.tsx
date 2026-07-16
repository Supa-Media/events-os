/**
 * The multi-select bulk bar for the Reconcile grid: appears when one or more
 * rows are checked and offers the three batch actions — set Category, set Budget
 * (both via `bulkCategorize`), and mark Reconciled (a loop over the per-row
 * status setter). Category / Budget open the same `PickerItem` popover the grid
 * cells use, so the option lists never drift.
 */
import { View, Text, Pressable } from "react-native";
import { Button, Icon, OptionTag, Popover, useAnchor } from "../../ui";
import { colors } from "../../../lib/theme";
import type { PickerItem } from "./ReconcileList";

export function BulkBar({
  count,
  categoryItems,
  budgetItems,
  onSetCategory,
  onSetBudget,
  onMarkReconciled,
  onClear,
  hideCategory = false,
}: {
  count: number;
  categoryItems: PickerItem[];
  budgetItems: PickerItem[];
  onSetCategory: (categoryId: string | null) => void;
  onSetBudget: (budgetId: string | null) => void;
  onMarkReconciled: () => void;
  onClear: () => void;
  // WP-2.1: hide "Set category" in central scope — central txns have no
  // categories (chapter-only), so only Budget + Mark Reconciled apply.
  hideCategory?: boolean;
}) {
  return (
    <View className="mb-3 flex-row flex-wrap items-center gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-2.5">
      <Text className="text-sm font-semibold text-ink">
        {count} selected
      </Text>
      <View className="flex-row flex-wrap items-center gap-2">
        {!hideCategory ? (
          <BulkPicker
            label="Set category"
            items={categoryItems}
            onPick={onSetCategory}
          />
        ) : null}
        <BulkPicker
          label="Set budget"
          items={budgetItems}
          onPick={onSetBudget}
        />
        <Button
          title="Mark reconciled"
          variant="primary"
          size="sm"
          icon="check"
          onPress={onMarkReconciled}
        />
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
