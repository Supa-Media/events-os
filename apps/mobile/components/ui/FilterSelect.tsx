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
import { Radio, RadioGroup } from "./RadioGroup";
import { spaceToggleProps } from "./spaceToggle";
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
  values,
  options,
  onChange,
  onToggle,
  onClear,
  anyLabel = "Any",
  minWidth = 200,
}: {
  /** Short prefix shown before the current value (e.g. "Status"). */
  label?: string;
  /** Single-select mode: the current value. Ignored when `values` is given. */
  value?: string;
  /**
   * MULTI-SELECT mode: the currently-selected values. Its presence is what
   * switches the control's behaviour — the menu stops closing on pick, rows
   * become toggles, and the trigger summarises rather than naming one option.
   *
   * Multi-select is right wherever the underlying options aren't genuinely
   * exclusive. Reconcile's are the case in point: a charge is routinely
   * unreviewed AND missing a receipt AND unbudgeted at once, and one-at-a-time
   * filtering meant a treasurer could never ask for "anything that still needs
   * something".
   */
  values?: readonly string[];
  options: FilterSelectOption[];
  /** Single-select handler. */
  onChange?: (value: string) => void;
  /** Multi-select handler — called with the option that was tapped. */
  onToggle?: (value: string) => void;
  /** Multi-select: clear this control's whole group. */
  onClear?: () => void;
  /** Trigger text when nothing is selected (multi-select only). */
  anyLabel?: string;
  /** Popover panel width. */
  minWidth?: number;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const multi = values != null;
  const current = options.find((o) => !o.header && o.value === value);
  const selectedOptions = multi
    ? options.filter((o) => !o.header && values.includes(o.value))
    : [];
  // One selection reads better as its own name than as "1 selected" — the
  // common case shouldn't be summarised into a number.
  const triggerText = multi
    ? selectedOptions.length === 0
      ? anyLabel
      : selectedOptions.length === 1
        ? selectedOptions[0].label
        : `${selectedOptions.length} selected`
    : (current?.label ?? "—");
  const triggerCount = multi
    ? selectedOptions.length === 1
      ? selectedOptions[0].count
      : undefined
    : current?.count;

  const rows = options.map((o) => {
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
    const selected = multi ? values.includes(o.value) : o.value === value;
    const pick = () => {
      if (multi) {
        // Stay open: picking filters is usually picking SEVERAL, and
        // reopening the menu between each one is the whole friction
        // multi-select exists to remove.
        onToggle?.(o.value);
        return;
      }
      onChange?.(o.value);
      close();
    };
    const body = (
      <>
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
          <Icon name={multi ? "check-square" : "check"} size={15} color={colors.accent} />
        ) : multi ? (
          <Icon name="square" size={15} color={colors.faint} />
        ) : (
          <View style={{ width: 15 }} />
        )}
      </>
    );
    const className = `flex-row items-center justify-between gap-3 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken ${
      selected ? "bg-sunken" : "bg-raised"
    }`;
    const name = o.count != null ? `${o.label}, ${o.count}` : o.label;
    return multi ? (
      <Pressable
        key={o.value}
        {...spaceToggleProps(pick)}
        onPress={pick}
        // It draws a tick box in multi mode, and each row is an independent
        // yes/no — so it says checkbox, and says which one is ticked. Neither
        // was true before: the rows had no role at all.
        accessibilityRole="checkbox"
        aria-checked={selected}
        accessibilityLabel={name}
        className={className}
      >
        {body}
      </Pressable>
    ) : (
      <Radio
        key={o.value}
        checked={selected}
        onSelect={pick}
        accessibilityLabel={name}
        className={className}
      >
        {body}
      </Radio>
    );
  });

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        accessibilityRole="button"
        aria-expanded={visible}
        aria-haspopup="true"
        accessibilityLabel={label ? `${label}: ${triggerText}` : triggerText}
        className={`flex-row items-center gap-1.5 self-start rounded-pill border px-3 py-1.5 active:bg-sunken web:hover:bg-sunken ${
          visible ? "border-accent" : "border-border-strong"
        } bg-raised`}
      >
        {label ? (
          <Text className="text-xs font-medium text-muted">{label}</Text>
        ) : null}
        <Text
          className={`text-sm ${
            multi && selectedOptions.length === 0
              ? "text-muted"
              : "font-semibold text-ink"
          }`}
          numberOfLines={1}
        >
          {triggerText}
        </Text>
        {triggerCount != null ? (
          <Text
            className="text-xs font-semibold text-muted"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {triggerCount}
          </Text>
        ) : null}
        <Icon name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={minWidth}>
        {multi && selectedOptions.length > 0 && onClear ? (
          <Pressable
            onPress={() => onClear()}
            className="flex-row items-center gap-2 border-b border-border px-3 py-2 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="x" size={13} color={colors.muted} />
            <Text className="text-xs text-muted">Clear {label ?? "filter"}</Text>
          </Pressable>
        ) : null}
        {/* Multi-select rows are checkboxes and each is its own decision, so
            each is its own tab stop. Single-select rows are one question with
            one answer — a `RadioGroup`, therefore ONE tab stop with the arrow
            keys moving inside it. The markup below is identical either way;
            only what it announces as differs. */}
        {multi ? rows : <RadioGroup accessibilityLabel={label ?? "Filter"}>{rows}</RadioGroup>}
      </Popover>
    </>
  );
}
