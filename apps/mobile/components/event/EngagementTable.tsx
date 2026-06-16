/**
 * EngagementTable — the parameterized database table shared by the Volunteers
 * and Vendors sections of CrewSections. Both are the SAME chrome (fixed-width
 * columns inside a horizontal ScrollView, uppercase header row, bordered cells,
 * an add-row, and a delete gutter); they differ only in which columns they show
 * and whether the header is sortable. A caller supplies a `columns` descriptor
 * list — each column owns its width, header (plain or sortable), and a `render`
 * that draws the cell for a given engagement.
 *
 * RN-web notes: react-native-web ignores function-style Pressable `style`, so
 * layout lives on inner Views/cells with static className + active:/web:hover.
 */
import { View, Text, Pressable, ScrollView } from "react-native";
import { Icon, GridHeaderCell } from "../ui";
import { colors } from "../../lib/theme";
import type { Engagement, Sort, SortCol } from "./engagementTypes";

const DELETE_W = 38;

/** A column in an engagement table. `sortCol` makes its header sortable. */
export type EngagementColumn = {
  key: string;
  label: string;
  width: number;
  sortCol?: SortCol;
  /** Renders the cell body (inside a bordered, fixed-width <Cell>). */
  render: (e: Engagement) => React.ReactNode;
};

/** Sum the column widths plus the trailing delete gutter. */
export function tableWidth(columns: EngagementColumn[]): number {
  return columns.reduce((sum, c) => sum + c.width, 0) + DELETE_W;
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <View
      style={{ width }}
      className="flex-row items-center border-r border-border/60"
    >
      {children}
    </View>
  );
}

/** A clickable header cell that drives the table's sort state. */
function SortHeaderCell({
  label,
  width,
  active,
  dir,
  onPress,
}: {
  label: string;
  width: number;
  active: boolean;
  dir: 1 | -1;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={{ width }}
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-1 px-2 py-2.5 active:opacity-70 web:hover:bg-sunken"
    >
      <Text
        className={`text-2xs font-bold uppercase tracking-wider ${
          active ? "text-ink" : "text-muted"
        }`}
        numberOfLines={1}
      >
        {label}
      </Text>
      {active ? (
        <Icon
          name={dir === 1 ? "chevron-up" : "chevron-down"}
          size={12}
          color={colors.muted}
        />
      ) : null}
    </Pressable>
  );
}

/** Delete gutter — confirms before removing the person from the event. */
function DeleteGutter({
  name,
  onRemove,
  confirm,
}: {
  name: string;
  onRemove: () => void;
  confirm: (name: string) => boolean;
}) {
  return (
    <View style={{ width: DELETE_W }} className="items-center justify-center">
      <Pressable
        onPress={() => {
          if (confirm(name)) onRemove();
        }}
        hitSlop={4}
        accessibilityLabel="Remove from event"
        className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="trash-2" size={14} color={colors.danger} />
      </Pressable>
    </View>
  );
}

export function EngagementTable({
  rows,
  columns,
  addLabel,
  emptyLabel,
  onAdd,
  onRemove,
  confirmRemove,
  sort,
  onSort,
}: {
  rows: Engagement[];
  columns: EngagementColumn[];
  addLabel: string;
  emptyLabel: string;
  onAdd: () => void;
  onRemove: (e: Engagement) => void;
  confirmRemove: (name: string) => boolean;
  /** Active sort (volunteers table) — omit for an unsorted table (vendors). */
  sort?: Sort;
  onSort?: (col: SortCol) => void;
}) {
  const width = tableWidth(columns);
  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(width, 320) }}>
          {/* Header */}
          <View className="flex-row items-center border-b border-border bg-sunken">
            {columns.map((c) =>
              c.sortCol && sort && onSort ? (
                <SortHeaderCell
                  key={c.key}
                  label={c.label}
                  width={c.width}
                  active={sort.col === c.sortCol}
                  dir={sort.dir}
                  onPress={() => onSort(c.sortCol as SortCol)}
                />
              ) : (
                <GridHeaderCell key={c.key} label={c.label} width={c.width} />
              ),
            )}
            <View style={{ width: DELETE_W }} />
          </View>

          {/* Body */}
          {rows.length === 0 ? (
            <View className="px-3 py-6">
              <Text className="text-sm text-faint">{emptyLabel}</Text>
            </View>
          ) : (
            rows.map((e, i) => (
              <View
                key={e._id}
                className={`flex-row items-stretch border-b border-border bg-raised ${
                  i === rows.length - 1 ? "border-b-0" : ""
                }`}
              >
                {columns.map((c) => (
                  <Cell key={c.key} width={c.width}>
                    {c.render(e)}
                  </Cell>
                ))}
                <DeleteGutter
                  name={e.person?.name ?? ""}
                  onRemove={() => onRemove(e)}
                  confirm={confirmRemove}
                />
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* Add row */}
      <Pressable
        onPress={onAdd}
        className="flex-row items-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="user-plus" size={15} color={colors.muted} />
        <Text className="text-sm font-medium text-muted">{addLabel}</Text>
      </Pressable>
    </View>
  );
}
