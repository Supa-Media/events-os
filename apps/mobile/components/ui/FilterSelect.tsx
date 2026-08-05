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

export type FilterSelectOption = {
  value: string;
  label: string;
  /**
   * A live count shown after the label in the menu, and after the current
   * value on the trigger. Optional — a filter bar with nothing to count (the
   * Donors screen's status/kind/source selectors) just omits it.
   *
   * This is what lets a dropdown REPLACE a row of counted chips without losing
   * anything: open it and every count is visible at once, which a wrapped or
   * scrolling chip row can't manage on a phone.
   */
  count?: number;
  /** A non-selectable group heading. `value` still has to be unique. */
  header?: boolean;
};

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
  const current = options.find((o) => !o.header && o.value === value);

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
        {current?.count != null ? (
          <Text
            className="text-xs font-semibold text-muted"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {current.count}
          </Text>
        ) : null}
        <Icon name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={minWidth}>
        {options.map((o) => {
          if (o.header) {
            return (
              <Text
                key={o.value}
                className="px-3 pb-1 pt-2.5 text-2xs font-bold uppercase tracking-wider text-faint"
              >
                {o.label}
              </Text>
            );
          }
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => {
                onChange(o.value);
                close();
              }}
              className={`flex-row items-center justify-between gap-3 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken ${
                selected ? "bg-sunken" : "bg-raised"
              }`}
            >
              <Text
                className={`flex-1 text-sm ${selected ? "font-semibold text-accent" : "text-ink"}`}
                numberOfLines={1}
              >
                {o.label}
              </Text>
              {o.count != null ? (
                <Text
                  className={`text-xs ${selected ? "font-semibold text-accent" : "text-muted"}`}
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {o.count}
                </Text>
              ) : null}
              {selected ? (
                <Icon name="check" size={15} color={colors.accent} />
              ) : (
                <View style={{ width: 15 }} />
              )}
            </Pressable>
          );
        })}
      </Popover>
    </>
  );
}
