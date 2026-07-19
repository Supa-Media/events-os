/**
 * FilterSelect — a COMPACT, inline dropdown for CRM-style filter rows (the
 * giving Donors screen's status / kind / source / lifetime / scope selectors).
 *
 * The existing `Field.tsx` `Select` is a full-width, labelled FORM control that
 * stacks vertically (each in its own `Field` with `mb-3`); a filter bar wants
 * several selectors side by side on one wrapping row. This is that: a pill
 * trigger showing "Label: Value", opening an anchored `Popover` of options —
 * the same anchored-dropdown plumbing (`useAnchor` + `Popover`) the grid's
 * select cells already use, so it flips/clamps on screen edges and works on
 * web + native without a bespoke overlay.
 */
import { Pressable, Text, View } from "react-native";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
import { useAnchor } from "./useAnchor";
import { colors } from "../../lib/theme";

export type FilterSelectOption = { value: string; label: string };

export function FilterSelect({
  label,
  value,
  options,
  onChange,
  minWidth = 200,
}: {
  /** Short prefix shown before the current value (e.g. "Status"). */
  label?: string;
  value: string;
  options: FilterSelectOption[];
  onChange: (value: string) => void;
  /** Popover panel width. */
  minWidth?: number;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        accessibilityRole="button"
        className={`flex-row items-center gap-1.5 self-start rounded-pill border px-3 py-1.5 active:bg-sunken web:hover:bg-sunken ${
          visible ? "border-accent" : "border-border-strong"
        } bg-raised`}
      >
        {label ? (
          <Text className="text-xs font-medium text-muted">{label}</Text>
        ) : null}
        <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
          {current?.label ?? "—"}
        </Text>
        <Icon name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={minWidth}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => {
                onChange(o.value);
                close();
              }}
              className={`flex-row items-center justify-between px-3 py-2.5 active:bg-sunken web:hover:bg-sunken ${
                selected ? "bg-sunken" : "bg-raised"
              }`}
            >
              <Text
                className={`text-sm ${selected ? "font-semibold text-accent" : "text-ink"}`}
              >
                {o.label}
              </Text>
              {selected ? (
                <Icon name="check" size={15} color={colors.accent} />
              ) : (
                <View />
              )}
            </Pressable>
          );
        })}
      </Popover>
    </>
  );
}
