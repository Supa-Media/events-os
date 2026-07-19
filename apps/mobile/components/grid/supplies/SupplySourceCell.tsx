/**
 * SupplySourceCell — the supplies grid's Source cell (event mode only).
 *
 * Source is the provenance spine (docs/plans/inventory-supplies-unification.md
 * §2–3): picking an inventory-backed value (Chapter Storage) opens the
 * AssetLinkPicker to link an existing chapter asset or create one; every other
 * value commits like a plain select (the server releases the link + reservation
 * on switch-away). A linked row shows its asset chip with live availability;
 * an inventory-backed row without a link keeps a "Link inventory item…" retry
 * affordance. Owns its link mutations directly (precedent: PhotoCell, HowToCell).
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { LOAN_SOURCES, isInventoryBackedSource } from "@events-os/shared";
import { colors } from "../../../lib/theme";
import { Icon } from "../../ui/Icon";
import { OptionTag } from "../../ui/OptionTag";
import { Popover } from "../../ui/Popover";
import { OptionEditFooter, OptionRow, useAnchor } from "../selectPrimitives";
import type { GridColumn, GridItem } from "../useGridData";
import { AssetLinkPicker } from "./AssetLinkPicker";

type Props = {
  column: GridColumn;
  item: GridItem;
  value: any;
  editable: boolean;
  onChange: (value: any) => void;
  onAddOption?: (columnId: string, label: string) => Promise<string>;
  onEditOptions?: (columnId: string) => void;
};

export function SupplySourceCell({
  column,
  item,
  value,
  editable,
  onChange,
  onAddOption,
  onEditOptions,
}: Props) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const [pickerOpen, setPickerOpen] = useState(false);
  // The source value the picker was opened FOR — committed as a plain select
  // change if the user closes the picker without linking.
  const [pendingSource, setPendingSource] = useState<string | null>(null);

  const linkAsset = useMutation(api.items.linkSupplyToAsset);
  const createAsset = useMutation(api.items.createAssetFromSupply);

  const opts = column.options ?? [];
  const current = opts.find((o) => o.value === value);
  const backed = isInventoryBackedSource(value);
  const linked = item.linkedAsset ?? null;
  // Acquired rows (buy/order) aren't inventory-backed by default, but the
  // Academy + PRD (docs/plans/inventory-supplies-unification.md §3) promise an
  // explicit promotion path: "Keep in inventory" links/creates an asset
  // without requiring the user to switch Source first. Loan sources
  // (borrowed/rented) never promote — they return to their lender, not to
  // chapter storage.
  const isAcquiredSource =
    value != null && !backed && !LOAN_SOURCES.includes(value);

  const pickOption = (picked: string) => {
    close();
    if (isInventoryBackedSource(picked)) {
      // Don't commit yet — link first; linkSupplyToAsset sets the source
      // server-side. Cancelling still commits the picked source (unlinked).
      setPendingSource(picked);
      setPickerOpen(true);
    } else {
      onChange(picked);
    }
  };

  const closePicker = () => {
    setPickerOpen(false);
    // Cancelled without linking: still honor the source pick — the row stays
    // unlinked and the "Link inventory item…" chip remains as the retry.
    if (pendingSource && !isInventoryBackedSource(value)) {
      onChange(pendingSource);
    }
    setPendingSource(null);
  };

  return (
    <>
      <Pressable
        ref={ref}
        disabled={!editable}
        onPress={open}
        className="flex-1 gap-1 px-2 py-1.5 active:opacity-70"
      >
        {current ? (
          <OptionTag label={current.label} color={current.color} />
        ) : (
          <Text className="text-sm text-faint">—</Text>
        )}
        {backed ? (
          linked ? (
            <Pressable
              disabled={!editable}
              onPress={() => setPickerOpen(true)}
              hitSlop={4}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Icon name="link" size={11} color={colors.muted} />
              <Text className="text-xs text-muted" numberOfLines={1}>
                {linked.name} · {linked.available} free
              </Text>
            </Pressable>
          ) : (
            <Pressable
              disabled={!editable}
              onPress={() => setPickerOpen(true)}
              hitSlop={4}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Icon name="link" size={11} color={colors.accent} />
              <Text className="text-xs font-medium text-accent">
                Link inventory item…
              </Text>
            </Pressable>
          )
        ) : null}
        {isAcquiredSource && !linked ? (
          <Pressable
            disabled={!editable}
            onPress={() => setPickerOpen(true)}
            hitSlop={4}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Icon name="archive" size={11} color={colors.muted} />
            <Text className="text-xs text-muted">Keep in inventory…</Text>
          </Pressable>
        ) : null}
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {value != null ? (
            <OptionRow
              label="Clear"
              muted
              onPress={() => {
                onChange(null);
                close();
              }}
            />
          ) : null}
          {opts.map((o) => (
            <OptionRow
              key={o.value}
              label={o.label}
              color={o.color}
              selected={o.value === value}
              onPress={() => pickOption(o.value)}
            />
          ))}
        </View>
        {editable ? (
          <OptionEditFooter
            columnId={column._id}
            onAddOption={onAddOption}
            onEditOptions={onEditOptions}
            onSelect={(v) => pickOption(v)}
            closePopover={close}
          />
        ) : null}
      </Popover>

      <AssetLinkPicker
        visible={pickerOpen}
        rowTitle={item.title}
        selectedId={linked?._id ?? null}
        onPick={(assetId) => {
          setPickerOpen(false);
          setPendingSource(null);
          void linkAsset({ itemId: item._id as any, assetId: assetId as any });
        }}
        onCreate={(name) => {
          setPickerOpen(false);
          setPendingSource(null);
          void createAsset({ itemId: item._id as any, name });
        }}
        onClear={
          linked
            ? () => {
                setPickerOpen(false);
                setPendingSource(null);
                void linkAsset({ itemId: item._id as any, assetId: null });
              }
            : undefined
        }
        onClose={closePicker}
      />
    </>
  );
}
