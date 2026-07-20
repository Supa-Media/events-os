/**
 * SupplyStatusCell — the supplies grid's Status cell (event mode only).
 *
 * Supplies status is DERIVED server-side (Packed-in + Source + live inventory
 * state; docs/plans/inventory-supplies-unification.md §4), so this cell renders
 * the smart-status affordances the plain SelectCell can't:
 *   - `reserved_elsewhere` rows show the live "Event X · Container" detail,
 *   - an auto glyph marks derived values; an edit glyph marks a manual override,
 *   - an override's popover leads with "Back to auto" (onChange(null) → the
 *     existing statusOverride: null plumbing) instead of a generic Clear.
 * Picking any option is an override (unchanged plumbing).
 */
import { View, Text, Pressable } from "react-native";
import { colors } from "../../../lib/theme";
import { Icon } from "../../ui/Icon";
import { OptionTag } from "../../ui/OptionTag";
import { Popover } from "../../ui/Popover";
import { OptionEditFooter, OptionRow, useAnchor } from "../selectPrimitives";
import type { GridColumn, GridItem } from "../useGridData";

type Props = {
  column: GridColumn;
  item: GridItem;
  value: any;
  editable: boolean;
  onChange: (value: any) => void;
  onAddOption?: (columnId: string, label: string) => Promise<string>;
  onEditOptions?: (columnId: string) => void;
};

export function SupplyStatusCell({
  column,
  item,
  value,
  editable,
  onChange,
  onAddOption,
  onEditOptions,
}: Props) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const opts = column.options ?? [];
  const current = opts.find((o) => o.value === value);
  const isDerived = item.statusIsDerived !== false; // absent → treat as auto
  const isOverride = item.statusIsDerived === false;
  // The cross-event hold reads as its live location, not the generic label.
  const label =
    value === "reserved_elsewhere" && item.statusDetail
      ? item.statusDetail
      : current?.label ?? (value ? String(value) : null);

  return (
    <>
      <Pressable
        ref={ref}
        disabled={!editable}
        onPress={open}
        className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70"
      >
        {label ? (
          <OptionTag label={label} color={current?.color} />
        ) : (
          <Text className="text-sm text-faint">—</Text>
        )}
        {label && isDerived ? (
          // Subtle auto marker: this value came from the rules, not a hand-pick.
          <Icon name="zap" size={11} color={colors.faint} />
        ) : null}
        {label && isOverride ? (
          <Icon name="edit-2" size={11} color={colors.muted} />
        ) : null}
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {isOverride ? (
            <Pressable
              onPress={() => {
                onChange(null);
                close();
              }}
              className="flex-row items-center gap-2 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="zap" size={14} color={colors.accent} />
              <Text className="text-sm font-medium text-accent">
                Back to auto
              </Text>
            </Pressable>
          ) : null}
          {opts.map((o) => (
            <OptionRow
              key={o.value}
              label={o.label}
              color={o.color}
              selected={o.value === value}
              onPress={() => {
                onChange(o.value);
                close();
              }}
            />
          ))}
        </View>
        {editable ? (
          <OptionEditFooter
            columnId={column._id}
            onAddOption={onAddOption}
            onEditOptions={onEditOptions}
            onSelect={(v) => {
              onChange(v);
              close();
            }}
            closePopover={close}
          />
        ) : null}
      </Popover>
    </>
  );
}
