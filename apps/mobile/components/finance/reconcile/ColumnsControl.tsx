/**
 * `Columns ▾` — the one control that says which of the grid's columns are on
 * screen. Founder, on the deployed grid: "I think we should have a way to
 * enable and disable columns quickly… so I could just narrow in on that."
 *
 * ONE QUIET CONTROL, not a row of toggles. This page has just had a view menu
 * and a chip rail taken out of it for restating what its own controls already
 * said, and nine switches above the grid would be that mistake again in a new
 * costume. Closed, this is a single pill that says how much is hidden; open,
 * every column is a tick box and the whole answer is visible at once — the
 * same trade the filter dropdowns made when they replaced nine counted chips.
 *
 * Built on the same anchored-dropdown plumbing as everything else on this
 * screen (`useAnchor` + `Popover`, exactly what `FilterSelect` and the grid's
 * own select cells use), so it flips and clamps at screen edges and needs no
 * bespoke overlay. It is NOT a `FilterSelect`, deliberately: that control's
 * multi-select trigger summarises the CHECKED set ("2 selected", or one
 * option's own name), which here would read as "2 columns" while eight are on
 * screen — and its "Clear" row would mean "hide everything". The vocabulary is
 * borrowed; the sentence has to be about what is MISSING.
 *
 * A TICK MEANS VISIBLE, which is the way round the founder described it
 * ("click which ones are visible") — even though what travels in the URL is
 * the hidden set (see `gridView.ts#parseHiddenColumns` for why that's the
 * durable half).
 *
 * The menu only ever lists columns THIS scope can render (`offerableColumns`)
 * — no tick box for Book outside the merged queue, none for Category where
 * central money has none, none for the three the side panel is rendering
 * itself. A box that changed nothing would be the dead affordance this screen
 * keeps deleting.
 */
import { Pressable, Text, View } from "react-native";
import { Icon, Popover, spaceToggleProps, useAnchor } from "../../ui";
import { colors } from "../../../lib/theme";
import { HIDEABLE_COLUMNS, type ReconcileColumnKey } from "./gridView";

export function ColumnsControl({
  hidden,
  offered,
  onToggle,
  onShowAll,
}: {
  /** The columns switched off — the URL's own `?cols=` set. May name a column
   *  that isn't in `offered` right now (the panel is open, the scope changed);
   *  such a preference is kept, not silently dropped. */
  hidden: readonly ReconcileColumnKey[];
  /** What this scope can render at all — `gridView#offerableColumns`. */
  offered: readonly ReconcileColumnKey[];
  onToggle: (key: ReconcileColumnKey) => void;
  /** Put every column back. Shown only when something is actually hidden. */
  onShowAll: () => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const rows = HIDEABLE_COLUMNS.filter((c) => offered.includes(c.key));
  // Counted over what's ON OFFER, so the pill can't claim "2 hidden" about two
  // columns this scope wasn't going to render anyway.
  const hiddenHere = rows.filter((c) => hidden.includes(c.key));
  const triggerText =
    hiddenHere.length === 0
      ? "All"
      : hiddenHere.length === 1
        ? `${hiddenHere[0].label} hidden`
        : `${hiddenHere.length} hidden`;

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        accessibilityRole="button"
        aria-expanded={visible}
        aria-haspopup="true"
        accessibilityLabel={`Columns: ${triggerText}`}
        className={`flex-row items-center gap-1.5 self-start rounded-pill border bg-raised px-3 py-1.5 active:bg-sunken web:hover:bg-sunken ${
          visible ? "border-accent" : "border-border-strong"
        }`}
      >
        <Icon name="columns" size={14} color={colors.muted} />
        <Text className="text-xs font-medium text-muted">Columns</Text>
        <Text
          className={`text-sm ${
            hiddenHere.length === 0 ? "text-muted" : "font-semibold text-ink"
          }`}
          numberOfLines={1}
        >
          {triggerText}
        </Text>
        <Icon name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={240}>
        {hiddenHere.length > 0 ? (
          <Pressable
            onPress={onShowAll}
            accessibilityRole="button"
            accessibilityLabel="Show all columns"
            className="flex-row items-center gap-2 border-b border-border px-3 py-2 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="x" size={13} color={colors.muted} />
            <Text className="text-xs text-muted">Show all</Text>
          </Pressable>
        ) : null}
        {rows.map((col) => {
          const shown = !hidden.includes(col.key);
          return (
            <Pressable
              key={col.key}
              {...spaceToggleProps(() => onToggle(col.key))}
              onPress={() => onToggle(col.key)}
              // Each row is an independent yes/no that leaves the menu open —
              // narrowing a grid is picking SEVERAL, and reopening between each
              // one is the friction this control exists to remove. Mirrors
              // `FilterSelect`'s multi-select rows exactly.
              accessibilityRole="checkbox"
              aria-checked={shown}
              accessibilityLabel={col.label}
              className={`flex-row items-center justify-between gap-3 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken ${
                shown ? "bg-raised" : "bg-sunken"
              }`}
            >
              <Text
                className={`flex-1 text-sm ${shown ? "text-ink" : "text-muted"}`}
                numberOfLines={1}
              >
                {col.label}
              </Text>
              <Icon
                name={shown ? "check-square" : "square"}
                size={15}
                color={shown ? colors.accent : colors.faint}
              />
            </Pressable>
          );
        })}
      </Popover>
    </>
  );
}
