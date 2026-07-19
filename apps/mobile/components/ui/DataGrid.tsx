/**
 * DataGrid — shared "it should just look like a database" grid shell (owner
 * request, 2026-07-19: "The donors list should just look like a database. Go
 * look at the way the finances reconcile looks — let's keep that... let's
 * just have inline databases"). Mirrors the Reconcile grid's design language
 * 1:1 — `components/finance/reconcile/ReconcileList.tsx`, itself modeled on
 * the People roster grid (`app/(app)/(tabs)/people.tsx`): a bordered/rounded
 * shell, a `bg-sunken` header row, fixed-width dense bordered cells, and
 * horizontal scroll on narrow screens with columns held at their width
 * rather than squeezed.
 *
 * `GridHeaderCell` / `SelectCell` (the INLINE-EDITABLE cell primitives —
 * dropdowns that commit a field) already live in `EditableTable.tsx` and are
 * reused as-is by Reconcile and People. This file adds the READ-ONLY grid
 * shell those screens didn't need but a plain list→detail grid does: a
 * whole-row press target (row tap → detail sheet, not a per-cell editor)
 * with a web hover tint, and a sortable column header for client-side
 * sorting over already-loaded rows (see `../../components/giving/gridSort`
 * for the pure comparator helpers).
 *
 * First consumers: the Giving desk's Donors / Backers / Gifts list screens
 * (`app/(app)/giving/{donors,backers,gifts}.tsx`) — replacing their stacked
 * card lists with inline grids, the same "no need to keep reinventing UIs"
 * request. Reconcile itself is UNCHANGED; this is purely additive.
 */
import { ReactNode, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";

/** Outer bordered/rounded/shadow shell + horizontal scroll — identical frame
 *  to Reconcile's `ReconcileList` and the People roster grid. `width` is the
 *  sum of every column's fixed width (the grid's natural, un-squeezed size);
 *  the shell never shrinks narrower than 320px. */
export function GridContainer({
  width,
  children,
}: {
  width: number;
  children: ReactNode;
}) {
  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(width, 320) }}>{children}</View>
      </ScrollView>
    </View>
  );
}

/** The column-header row — `bg-sunken`, bottom hairline, exactly Reconcile's. */
export function GridHeaderRow({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row items-center border-b border-border bg-sunken">
      {children}
    </View>
  );
}

export type SortDirection = "asc" | "desc";

/**
 * A fixed-width column header that doubles as a sort toggle: press to sort
 * by this column (ascending first), press again to flip direction. Renders
 * as a plain (non-interactive) label — identical to `GridHeaderCell` — when
 * `onSort` is omitted, so the same row can mix sortable and static columns
 * (e.g. Donors' Source column isn't sortable).
 */
export function SortableHeaderCell({
  label,
  width,
  active = false,
  direction = "asc",
  onSort,
  align = "left",
}: {
  label: string;
  width: number;
  /** Whether THIS column is the current sort key. */
  active?: boolean;
  direction?: SortDirection;
  onSort?: () => void;
  align?: "left" | "right";
}) {
  if (!onSort) {
    return (
      <View style={{ width }} className="px-2 py-2.5">
        <Text
          className={`text-2xs font-bold uppercase tracking-wider text-muted ${
            align === "right" ? "text-right" : ""
          }`}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
    );
  }
  return (
    <Pressable
      onPress={onSort}
      accessibilityRole="button"
      accessibilityLabel={
        active
          ? `Sort by ${label}, currently ${direction === "asc" ? "ascending" : "descending"}`
          : `Sort by ${label}`
      }
      style={{ width }}
      className={`flex-row items-center gap-1 px-2 py-2.5 active:opacity-70 web:hover:opacity-90 ${
        align === "right" ? "justify-end" : ""
      }`}
    >
      <Text
        className={`text-2xs font-bold uppercase tracking-wider ${
          active ? "text-ink" : "text-muted"
        }`}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Icon
        name={active && direction === "desc" ? "arrow-down" : active ? "arrow-up" : "chevron-down"}
        size={11}
        color={active ? colors.accent : colors.faint}
      />
    </Pressable>
  );
}

/** A dense, fixed-width cell — border-r hairline, no built-in padding
 *  (children carry their own `px-2 py-1.5`, exactly Reconcile's `Cell`, so
 *  a Pressable child can fill the whole cell as its own hit target). */
export function GridCell({
  width,
  children,
}: {
  width: number;
  children: ReactNode;
}) {
  return (
    <View
      style={{ width }}
      className="flex-row items-center border-r border-border/60"
    >
      {children}
    </View>
  );
}

/** A grid row — bottom hairline, `bg-raised`, web hover tint to `bg-sunken`
 *  when the whole row is a press target (row tap → detail). Falls back to a
 *  plain (non-pressable) row when `onPress` is omitted. `muted` (Backers'
 *  paused-pledge rows) dims the whole row so a paused row reads as visually
 *  distinct without hiding it — it's still in the list, still tappable. */
export function GridRow({
  children,
  onPress,
  isLast = false,
  accessibilityLabel,
  muted = false,
}: {
  children: ReactNode;
  onPress?: () => void;
  /** Drop the bottom hairline on the final row. */
  isLast?: boolean;
  accessibilityLabel?: string;
  /** Dim the row (e.g. a paused pledge) without removing it from the grid. */
  muted?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const border = isLast ? "" : "border-b border-border";
  const dim = muted ? "opacity-60" : "";

  if (!onPress) {
    return (
      <View className={`flex-row items-stretch bg-raised ${border} ${dim}`}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className={`flex-row items-stretch ${border} ${dim} ${hovered ? "bg-sunken" : "bg-raised"}`}
    >
      {children}
    </Pressable>
  );
}

/** A row-count label, e.g. "DONORS (42)" — the convention the People roster
 *  ("Roster (N)") and other list screens use for "how many am I looking at". */
export function GridCountLabel({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
      {label} ({count})
    </Text>
  );
}
