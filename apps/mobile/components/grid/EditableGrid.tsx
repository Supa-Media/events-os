/**
 * EditableGrid — a desktop-first, spreadsheet-like editable table that renders
 * any module (planning doc, supplies, comms, run-of-show) on either a template
 * or a live event. Columns are configurable; cells edit inline; rows add /
 * delete / reorder. Driven entirely by the module's ColumnDef set.
 */
import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
} from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import { useAction } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { type ModuleKey } from "@events-os/shared";
import { colors } from "../../lib/theme";
import { Icon } from "../ui/Icon";
import { OptionTag } from "../ui/OptionTag";
import { Popover } from "../ui/Popover";
import {
  ContextMenu,
  measureAnchor,
  type ContextMenuAnchor,
} from "../ui/ContextMenu";
import { TextField, Select } from "../ui/Field";
import { Button } from "../ui/Button";
import { GridCell } from "./cells";
import { SortableRows } from "./SortableRows";
import { ColumnOptionsEditor } from "./ColumnOptionsEditor";
import { ResizeHandle } from "./ResizeHandle";
import {
  GRIP_W,
  DELETE_W,
  MIN_TABLE_WIDTH,
  getColumnWidth,
} from "./columnRegistry";
import {
  useGridData,
  buildPatch,
  cellValue,
  type GridColumn,
  type GridItem,
  type GridMode,
} from "./useGridData";

// Drag-resize clamps (px).
const COL_MIN_W = 60;
const COL_MAX_W = 640;
const ROW_MIN_H = 36;
const ROW_MAX_H = 480;

/** Column types a template author can add as custom columns. */
const ADDABLE_TYPES: Array<{ value: string; label: string }> = [
  { value: "text", label: "Text" },
  { value: "longtext", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "date", label: "Date" },
  { value: "url", label: "Link" },
  { value: "select", label: "Select" },
  { value: "multiselect", label: "Multi-select" },
  { value: "status", label: "Status" },
  { value: "person", label: "Person" },
  { value: "photo", label: "Photo" },
  { value: "how_to", label: "How-To" },
];
const OPTION_TYPES = ["select", "multiselect", "status"];
const OPTION_PALETTE = ["red", "amber", "green", "blue", "teal", "purple", "pink", "orange", "gray"];

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "opt";
}
function parseOptions(raw: string) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((label, i) => ({ value: slug(label), label, color: OPTION_PALETTE[i % OPTION_PALETTE.length] }));
}

type Props = {
  mode: GridMode;
  parentId: string;
  module: ModuleKey;
  roles: Array<{ _id: string; label: string }>;
  eventDate?: number;
  editable?: boolean;
  /** Label for the add-row button, e.g. "Add task". */
  addLabel?: string;
  /**
   * When set, only rows whose item id is in this set are shown (used by the
   * event "Me view" to show only items the current user owns, for modules they
   * don't own). `null`/omitted shows every row.
   */
  filterItemIds?: Set<string> | null;
};

export function EditableGrid({
  mode,
  parentId,
  module,
  roles,
  eventDate,
  editable = true,
  addLabel = "Add row",
  filterItemIds,
}: Props) {
  const grid = useGridData(mode, parentId, module);
  // `useGridData` returns a fresh object (with fresh method closures) every
  // render. Mirror it in a ref so the memoized Row's callbacks can stay stable
  // across renders without depending on `grid` (which would defeat the memo).
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const autofill = useAction(api.aiActions.autofillItem);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | "columns" | "group" | "addField" | "editOptions">(null);
  const [editColId, setEditColId] = useState<string | null>(null);
  // Pre-plan cell context menu (template authoring): which cell + where.
  const [prePlanMenu, setPrePlanMenu] = useState<
    null | { itemId: string; colKey: string; marked: boolean; anchor: ContextMenuAnchor }
  >(null);
  // Live column-width override while a header border is being dragged (the
  // committed width persists on release). Only one column resizes at a time.
  const [liveColResize, setLiveColResize] = useState<
    null | { id: string; width: number }
  >(null);
  // True while any column/row resize drag is in flight — suspends the horizontal
  // ScrollView so a horizontal column drag isn't stolen by it.
  const [resizing, setResizing] = useState(false);

  // In template mode the computed due date is meaningless, and `owner` has no
  // owner to resolve — EXCEPT volunteer_expectations, whose owner is authored
  // against the template's placeholder crew (templatePeople).
  const stripInTemplate = (key: string) =>
    key === "due_date" ||
    (key === "owner" && module !== "volunteer_expectations");

  const columns = useMemo(() => {
    return grid.columns
      .filter((c) => c.isVisible)
      .filter((c) => (mode === "template" ? !stripInTemplate(c.key) : true))
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.columns, mode, module]);

  const widths = useMemo(
    () =>
      columns.map((c) =>
        liveColResize && liveColResize.id === c._id
          ? liveColResize.width
          : c.width ?? getColumnWidth(c),
      ),
    [columns, liveColResize],
  );
  const tableWidth =
    widths.reduce((sum, w) => sum + w, 0) + (editable ? GRIP_W + DELETE_W : 0);

  /** Columns you can group the board by (single-choice tag columns). */
  const groupables = useMemo(
    () => columns.filter((c) => c.type === "status" || c.type === "select"),
    [columns],
  );
  const groupCol = groupBy ? grid.columns.find((c) => c.key === groupBy) ?? null : null;
  const editCol = editColId ? grid.columns.find((c) => c._id === editColId) ?? null : null;

  const commit = useCallback(
    (item: GridItem, column: GridColumn, value: any) =>
      gridRef.current.updateItem(
        item._id,
        buildPatch(column, value, module, mode, eventDate),
      ),
    [module, mode, eventDate],
  );

  // Open the full ColumnOptionsEditor for a column straight from a cell's
  // value-picker dropdown (reuses the existing "editOptions" popover).
  const openOptionsEditor = useCallback((columnId: string) => {
    setEditColId(columnId);
    setMenu("editOptions");
  }, []);

  // Inline quick-add from a cell dropdown: append a new option to the column,
  // preserving every existing option and slugging the label into a unique
  // value (mirrors ColumnOptionsEditor). Returns the new value so the cell can
  // immediately select it.
  const addOption = useCallback(
    async (columnId: string, label: string): Promise<string> => {
      const col = gridRef.current.columns.find((c) => c._id === columnId);
      const existing = col?.options ?? [];
      const taken = new Set(existing.map((o) => o.value));
      let value = slug(label);
      if (taken.has(value)) {
        let i = 2;
        while (taken.has(`${value}_${i}`)) i++;
        value = `${value}_${i}`;
      }
      const options = [
        ...existing,
        {
          value,
          label: label.trim(),
          color: OPTION_PALETTE[existing.length % OPTION_PALETTE.length],
        },
      ];
      await gridRef.current.updateColumn(columnId, { options });
      return value;
    },
    [],
  );

  // Stable per-item row callbacks (read the live grid through the ref).
  const removeItem = useCallback((itemId: string) => {
    void gridRef.current.removeItem(itemId);
  }, []);
  const autofillItem = useCallback(
    (itemId: string) => autofill({ itemId: itemId as any }),
    [autofill],
  );
  const openPrePlanMenu = useCallback(
    (item: GridItem, colKey: string, node: any) =>
      measureAnchor(node, (anchor) =>
        setPrePlanMenu({
          itemId: item._id,
          colKey,
          marked: (item.prePlanColumns ?? []).includes(colKey),
          anchor,
        }),
      ),
    [],
  );
  const toggleChecked = useCallback((itemId: string, colKey: string) => {
    void gridRef.current.togglePrePlanChecked(itemId, colKey);
  }, []);

  // Persist a drag-resized column width (clears the live override first).
  const commitColumnWidth = useCallback((columnId: string, width: number) => {
    setLiveColResize(null);
    void gridRef.current.updateColumn(columnId, { width: Math.round(width) });
  }, []);
  // Persist a drag-resized row height.
  const commitRowHeight = useCallback((itemId: string, height: number) => {
    void gridRef.current.updateItem(itemId, { rowHeight: Math.round(height) });
  }, []);

  // The per-row ✨ Autofill button only makes sense on a live event with a
  // fillable column (photo / link / cost).
  const canAutofill =
    mode === "event" &&
    columns.some((c) => ["photo", "url", "currency"].includes(c.type));

  const itemsById = useMemo(() => {
    const map = new Map<string, GridItem>();
    for (const item of grid.items) map.set(item._id, item);
    return map;
  }, [grid.items]);

  // Rows to render. Me view passes a filter so only the user's own items show
  // (for modules they don't own); otherwise every item is visible.
  const visibleItems = useMemo(
    () =>
      filterItemIds ? grid.items.filter((i) => filterItemIds.has(i._id)) : grid.items,
    [grid.items, filterItemIds],
  );

  /** Buckets for the grouped/board view (one per option + a "none" bucket). */
  const groups = useMemo(() => {
    if (!groupCol) return null;
    const opts = groupCol.options ?? [];
    const buckets = opts.map((o) => ({
      key: o.value,
      label: o.label,
      color: o.color,
      items: [] as GridItem[],
    }));
    const none = { key: "__none", label: `No ${groupCol.label.toLowerCase()}`, color: undefined as any, items: [] as GridItem[] };
    for (const it of visibleItems) {
      const v = cellValue(groupCol, it, module);
      const b = buckets.find((x) => x.key === v);
      (b ?? none).items.push(it);
    }
    return none.items.length ? [...buckets, none] : buckets;
  }, [groupCol, visibleItems, module]);

  const templateId = mode === "template" ? parentId : undefined;
  const allowPrePlanMenu = mode === "template" && editable;
  const allowToggleChecked = mode === "event" && editable;

  const renderRow = useCallback(
    (item: GridItem, isLast: boolean, drag?: GestureType) => (
      <Row
        key={item._id}
        item={item}
        isLast={isLast}
        columns={columns}
        widths={widths}
        module={module}
        mode={mode}
        roles={roles}
        eventDate={eventDate}
        editable={editable}
        templateId={templateId}
        onCommit={commit}
        onEditOptions={editable ? openOptionsEditor : undefined}
        onAddOption={editable ? addOption : undefined}
        onRemove={editable ? removeItem : undefined}
        onAutofill={canAutofill ? autofillItem : undefined}
        drag={drag}
        // Template authors right-click / long-press a cell to (un)mark pre-plan;
        // on an event a marked cell shows a check-off tick.
        onPrePlanMenu={allowPrePlanMenu ? openPrePlanMenu : undefined}
        onToggleChecked={allowToggleChecked ? toggleChecked : undefined}
        rowHeight={item.rowHeight}
        onResize={editable ? commitRowHeight : undefined}
        onResizeActiveChange={setResizing}
      />
    ),
    [
      columns,
      widths,
      module,
      mode,
      roles,
      eventDate,
      editable,
      templateId,
      commit,
      openOptionsEditor,
      addOption,
      removeItem,
      canAutofill,
      autofillItem,
      allowPrePlanMenu,
      openPrePlanMenu,
      allowToggleChecked,
      toggleChecked,
      commitRowHeight,
    ],
  );

  const reorder = useCallback((ids: string[]) => {
    void gridRef.current.reorder(ids);
  }, []);

  const renderList = useCallback(
    (items: GridItem[], sortable: boolean) => {
      if (items.length === 0) {
        return (
          <View className="px-3 py-3">
            <Text className="text-sm text-faint">Empty</Text>
          </View>
        );
      }
      if (sortable && editable) {
        return (
          <SortableRows
            ids={items.map((i) => i._id)}
            onReorder={reorder}
            renderRow={({ id, index, drag }) => {
              const item = itemsById.get(id);
              if (!item) return null;
              return renderRow(item, index === items.length - 1, drag);
            }}
          />
        );
      }
      return items.map((item, i) => renderRow(item, i === items.length - 1));
    },
    [editable, reorder, itemsById, renderRow],
  );

  // NOTE: keep this loading guard AFTER all hooks — an early return placed
  // above the render* useCallbacks above causes "rendered more hooks than
  // during the previous render" once loading flips to false.
  if (grid.loading) {
    return (
      <View className="items-center py-8">
        <Text className="text-sm text-muted">Loading…</Text>
      </View>
    );
  }

  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised">
      {/* Toolbar */}
      {editable ? (
        <View className="flex-row items-center justify-end gap-1 border-b border-border px-2 py-1.5">
          {groupables.length > 0 ? (
            <ToolbarBtn
              icon="grid"
              label={groupCol ? `Group: ${groupCol.label}` : "Group"}
              active={!!groupCol}
              onPress={() => setMenu("group")}
            />
          ) : null}
          <ToolbarBtn icon="sliders" label="Columns" onPress={() => setMenu("columns")} />
          {mode === "template" ? (
            <ToolbarBtn icon="plus" label="Field" onPress={() => setMenu("addField")} />
          ) : null}
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEnabled={!resizing}
      >
        <View style={{ width: Math.max(tableWidth, MIN_TABLE_WIDTH) }}>
          {/* Column header */}
          <View className="flex-row items-center border-b border-border bg-sunken">
            {editable ? <View style={{ width: GRIP_W }} /> : null}
            {columns.map((c, i) => (
              <View
                key={c._id}
                style={{ width: widths[i] }}
                className="relative px-2 py-2.5"
              >
                <Text className="text-2xs font-bold uppercase tracking-wider text-muted" numberOfLines={1}>
                  {c.label}
                </Text>
                {/* Drag the right border to resize this column. */}
                {editable ? (
                  <ResizeHandle
                    axis="x"
                    start={c.width ?? getColumnWidth(c)}
                    min={COL_MIN_W}
                    max={COL_MAX_W}
                    onActiveChange={setResizing}
                    onPreview={(width) => setLiveColResize({ id: c._id, width })}
                    onCommit={(width) => commitColumnWidth(c._id, width)}
                  />
                ) : null}
              </View>
            ))}
            {editable ? <View style={{ width: DELETE_W }} /> : null}
          </View>

          {/* Body — grouped board, or a single drag-reorderable list. */}
          {visibleItems.length === 0 ? (
            <View className="px-3 py-6">
              <Text className="text-sm text-faint">
                {filterItemIds ? "Nothing assigned to you here." : "No rows yet."}
              </Text>
            </View>
          ) : groupCol && groups ? (
            groups.map((g) => (
              <View key={g.key}>
                <View
                  style={{ width: Math.max(tableWidth, MIN_TABLE_WIDTH) }}
                  className="flex-row items-center gap-2 border-b border-border bg-sunken/60 px-3 py-1.5"
                >
                  <OptionTag label={g.label} color={g.color} />
                  <Text className="text-2xs text-faint">{g.items.length}</Text>
                </View>
                {renderList(g.items, false)}
              </View>
            ))
          ) : (
            renderList(visibleItems, true)
          )}
        </View>
      </ScrollView>

      {/* Add row */}
      {editable ? (
        <Pressable
          onPress={() => grid.addItem({})}
          className="flex-row items-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">{addLabel}</Text>
        </Pressable>
      ) : null}

      {/* Group-by menu */}
      <Popover visible={menu === "group"} onClose={() => setMenu(null)} width={240}>
        <View className="py-1">
          <MenuRow label="None" selected={!groupBy} onPress={() => { setGroupBy(null); setMenu(null); }} />
          {groupables.map((c) => (
            <MenuRow
              key={c._id}
              label={c.label}
              selected={groupBy === c.key}
              onPress={() => { setGroupBy(c.key); setMenu(null); }}
            />
          ))}
        </View>
      </Popover>

      {/* Columns show/hide menu */}
      <Popover visible={menu === "columns"} onClose={() => setMenu(null)} width={280}>
        <View className="py-1">
          {grid.columns
            .filter((c) => (mode === "template" ? !stripInTemplate(c.key) : true))
            .sort((a, b) => a.order - b.order)
            .map((c) => (
              <View key={c._id} className="flex-row items-center justify-between px-3 py-2">
                <Text className="text-sm text-ink">{c.label}</Text>
                <View className="flex-row items-center gap-1">
                  {(c.type === "select" || c.type === "status" || c.type === "multiselect") ? (
                    <Pressable
                      hitSlop={6}
                      onPress={() => { setEditColId(c._id); setMenu("editOptions"); }}
                      className="rounded p-1 active:bg-sunken"
                    >
                      <Icon name="edit-2" size={14} color={colors.muted} />
                    </Pressable>
                  ) : null}
                  <Pressable
                    hitSlop={6}
                    onPress={() => grid.setColumnVisible(c._id, !c.isVisible)}
                    className="rounded p-1 active:bg-sunken"
                  >
                    <Icon name={c.isVisible ? "eye" : "eye-off"} size={15} color={c.isVisible ? colors.ink : colors.faint} />
                  </Pressable>
                  {mode === "template" && c.kind === "custom" ? (
                    <Pressable
                      hitSlop={6}
                      onPress={() => grid.removeColumn(c._id)}
                      className="rounded p-1 active:bg-sunken"
                    >
                      <Icon name="trash-2" size={15} color={colors.danger} />
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ))}
        </View>
      </Popover>

      {/* Add custom field (template only) */}
      <Popover visible={menu === "addField"} onClose={() => setMenu(null)} width={300}>
        <AddFieldForm
          onAdd={async (label, type, options) => {
            await grid.addColumn({ label, type, options });
            setMenu(null);
          }}
        />
      </Popover>

      {/* Edit a select/status column's options (template only) */}
      <Popover visible={menu === "editOptions"} onClose={() => setMenu(null)} width={300}>
        {editCol ? (
          <ColumnOptionsEditor
            column={editCol}
            onSave={async (options) => {
              await grid.updateColumn(editCol._id, { options });
              setMenu(null);
            }}
          />
        ) : null}
      </Popover>

      {/* Pre-plan cell mark menu (template authoring) */}
      <ContextMenu
        anchor={prePlanMenu?.anchor}
        width={200}
        onClose={() => setPrePlanMenu(null)}
        actions={
          prePlanMenu
            ? [
                {
                  label: prePlanMenu.marked
                    ? "Unmark pre-plan"
                    : "Mark as pre-plan",
                  icon: prePlanMenu.marked ? "x-circle" : "check-circle",
                  onPress: () =>
                    void grid.toggleTemplatePrePlan(
                      prePlanMenu.itemId,
                      prePlanMenu.colKey,
                    ),
                },
              ]
            : []
        }
      />
    </View>
  );
}

function ToolbarBtn({
  icon,
  label,
  active,
  onPress,
}: {
  icon: any;
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center gap-1 rounded-md px-2 py-1 active:bg-sunken web:hover:bg-sunken ${
        active ? "bg-accent-soft" : ""
      }`}
    >
      <Icon name={icon} size={13} color={active ? colors.accent : colors.muted} />
      <Text className={`text-xs font-medium ${active ? "text-accent" : "text-muted"}`}>{label}</Text>
    </Pressable>
  );
}

function MenuRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between px-3 py-2 active:bg-sunken web:hover:bg-sunken"
    >
      <Text className={`text-sm ${selected ? "font-semibold text-accent" : "text-ink"}`}>{label}</Text>
      {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}

function AddFieldForm({
  onAdd,
}: {
  onAdd: (label: string, type: string, options?: any[]) => void;
}) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState("text");
  const [optionsRaw, setOptionsRaw] = useState("");
  const needsOptions = OPTION_TYPES.includes(type);
  return (
    <View className="gap-3 p-3">
      <Text className="font-display text-base text-ink">New field</Text>
      <TextField label="Name" value={label} onChangeText={setLabel} placeholder="e.g. Vendor" />
      <Select
        label="Type"
        value={type}
        options={ADDABLE_TYPES}
        onChange={(v) => setType(v ?? "text")}
      />
      {needsOptions ? (
        <TextField
          label="Options (comma-separated)"
          value={optionsRaw}
          onChangeText={setOptionsRaw}
          placeholder="To do, Doing, Done"
        />
      ) : null}
      <Button
        title="Add field"
        disabled={!label.trim()}
        onPress={() =>
          onAdd(label.trim(), type, needsOptions ? parseOptions(optionsRaw) : undefined)
        }
      />
    </View>
  );
}

/** Props for a single grid row. */
interface RowProps {
  item: GridItem;
  isLast: boolean;
  columns: GridColumn[];
  widths: number[];
  module: ModuleKey;
  mode: GridMode;
  roles: Array<{ _id: string; label: string }>;
  eventDate?: number;
  editable: boolean;
  templateId?: string;
  onCommit: (item: GridItem, column: GridColumn, value: any) => void;
  /** Open the full ColumnOptionsEditor for a select/status/multiselect column. */
  onEditOptions?: (columnId: string) => void;
  /** Append+persist a new option to a column; resolves to its new value. */
  onAddOption?: (columnId: string, label: string) => Promise<string>;
  /** Remove THIS row (called with the row's item id). */
  onRemove?: (itemId: string) => void;
  /** ✨ one-click enrich (photo/cost/link) from the item name (by item id). */
  onAutofill?: (itemId: string) => Promise<unknown>;
  /** Pan gesture from SortableRows; attached to the grip handle when editable. */
  drag?: GestureType;
  /** Template: open the pre-plan mark menu for a cell (right-click/long-press). */
  onPrePlanMenu?: (item: GridItem, colKey: string, node: any) => void;
  /** Event: tick / untick a marked pre-plan cell (by item id). */
  onToggleChecked?: (itemId: string, colKey: string) => void;
  /** Committed manual row height (px); undefined = auto-fit content. */
  rowHeight?: number;
  /** Persist a drag-resized row height (by item id). */
  onResize?: (itemId: string, height: number) => void;
  /** Drag begin/end, to suspend the surrounding scroll view. */
  onResizeActiveChange?: (active: boolean) => void;
}

/**
 * A single grid row: the flex-row of fixed-width cells plus, when editable, the
 * row-actions column (drag grip + delete). Shared by the sortable (editable)
 * and read-only render paths so the markup stays in one place.
 *
 * Memoized: with stable callbacks from the parent, a row only re-renders when
 * its own `item` (or layout) changes — so editing one cell no longer re-renders
 * every other row in the grid (the highest-impact perf fix here).
 */
const Row = memo(function Row({
  item,
  isLast,
  columns,
  widths,
  module,
  mode,
  roles,
  eventDate,
  editable,
  templateId,
  onCommit,
  onEditOptions,
  onAddOption,
  onRemove,
  onAutofill,
  drag,
  onPrePlanMenu,
  onToggleChecked,
  rowHeight,
  onResize,
  onResizeActiveChange,
}: RowProps) {
  const prePlanCols = useMemo(
    () => new Set(item.prePlanColumns ?? []),
    [item.prePlanColumns],
  );
  const checkedCols = useMemo(
    () => new Set(item.prePlanChecked ?? []),
    [item.prePlanChecked],
  );
  // Live height while THIS row's bottom border is being dragged; null = use the
  // committed `rowHeight` (or auto when that's unset). Kept local so dragging one
  // row doesn't re-render the others.
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  // Last measured natural height — the drag's starting point when no manual
  // height is set yet. State (not a ref) so the handle actually re-renders with
  // the real measured start before the first drag begins.
  const [measuredH, setMeasuredH] = useState(44);
  const previewHeight = useCallback((h: number) => setLiveHeight(h), []);
  const commitHeight = useCallback(
    (h: number) => {
      setLiveHeight(null);
      onResize?.(item._id, h);
    },
    [onResize, item._id],
  );
  const effectiveHeight = liveHeight ?? rowHeight;
  return (
    <View
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        setMeasuredH((prev) => (Math.abs(h - prev) > 1 ? h : prev));
      }}
      style={effectiveHeight != null ? { height: effectiveHeight } : undefined}
      // With a manual height the cells stretch to fill it (so multiline inputs
      // gain the extra room); auto rows keep top alignment.
      className={`relative flex-row border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      } ${effectiveHeight != null ? "items-stretch overflow-hidden" : "items-start"}`}
    >
      {/* Left gutter: drag grip */}
      {editable ? (
        <View style={{ width: GRIP_W }} className="items-center pt-2.5">
          {drag ? (
            <GestureDetector gesture={drag}>
              <View
                hitSlop={6}
                className="cursor-grab rounded p-1 active:bg-sunken web:hover:bg-sunken"
              >
                <Icon name="menu" size={15} color={colors.faint} />
              </View>
            </GestureDetector>
          ) : null}
        </View>
      ) : null}

      {columns.map((c, i) => (
        <RowCell
          key={c._id}
          column={c}
          item={item}
          width={widths[i]}
          isPrePlan={prePlanCols.has(c.key)}
          isChecked={checkedCols.has(c.key)}
          module={module}
          mode={mode}
          roles={roles}
          eventDate={eventDate}
          editable={editable}
          templateId={templateId}
          onCommit={onCommit}
          onEditOptions={onEditOptions}
          onAddOption={onAddOption}
          onPrePlanMenu={onPrePlanMenu}
          onToggleChecked={onToggleChecked}
        />
      ))}

      {/* Right gutter: ✨ autofill + delete */}
      {editable ? (
        <View
          style={{ width: DELETE_W }}
          className="items-center justify-start gap-0.5 pt-1.5"
        >
          {onAutofill ? (
            <AutofillBtn onPress={() => onAutofill(item._id)} />
          ) : null}
          {onRemove ? (
            <RowBtn icon="trash-2" danger onPress={() => onRemove(item._id)} />
          ) : null}
        </View>
      ) : null}

      {/* Drag the bottom border to resize this row's height. */}
      {editable && onResize ? (
        <ResizeHandle
          axis="y"
          start={rowHeight ?? measuredH}
          min={ROW_MIN_H}
          max={ROW_MAX_H}
          onActiveChange={onResizeActiveChange}
          onPreview={previewHeight}
          onCommit={commitHeight}
        />
      ) : null}
    </View>
  );
});

/** Props for a single cell within a row (one column × one item). */
interface RowCellProps {
  column: GridColumn;
  item: GridItem;
  width: number;
  isPrePlan: boolean;
  isChecked: boolean;
  module: ModuleKey;
  mode: GridMode;
  roles: Array<{ _id: string; label: string }>;
  eventDate?: number;
  editable: boolean;
  templateId?: string;
  onCommit: (item: GridItem, column: GridColumn, value: any) => void;
  onEditOptions?: (columnId: string) => void;
  onAddOption?: (columnId: string, label: string) => Promise<string>;
  onPrePlanMenu?: (item: GridItem, colKey: string, node: any) => void;
  onToggleChecked?: (itemId: string, colKey: string) => void;
}

/**
 * One memoized cell. Holds a stable `onChange` (bound to its item + column) and
 * adapts the row-level pre-plan callbacks (which take the item) to the
 * cell-level ones the wrapper expects (which take just the colKey), so the
 * memoized `PrePlanCellWrapper` and `GridCell` only re-render when this cell's
 * own inputs change.
 */
const RowCell = memo(function RowCell({
  column,
  item,
  width,
  isPrePlan,
  isChecked,
  module,
  mode,
  roles,
  eventDate,
  editable,
  templateId,
  onCommit,
  onEditOptions,
  onAddOption,
  onPrePlanMenu,
  onToggleChecked,
}: RowCellProps) {
  const onChange = useCallback(
    (value: any) => onCommit(item, column, value),
    [onCommit, item, column],
  );
  const handlePrePlanMenu = useCallback(
    (colKey: string, node: any) => onPrePlanMenu?.(item, colKey, node),
    [onPrePlanMenu, item],
  );
  const handleToggleChecked = useCallback(
    (colKey: string) => onToggleChecked?.(item._id, colKey),
    [onToggleChecked, item._id],
  );
  return (
    <PrePlanCellWrapper
      width={width}
      isPrePlan={isPrePlan}
      isChecked={isChecked}
      colKey={column.key}
      onPrePlanMenu={onPrePlanMenu ? handlePrePlanMenu : undefined}
      onToggleChecked={onToggleChecked ? handleToggleChecked : undefined}
    >
      <GridCell
        column={column}
        item={item}
        module={module}
        mode={mode}
        roles={roles}
        eventDate={eventDate}
        editable={editable}
        templateId={templateId}
        onChange={onChange}
        onEditOptions={onEditOptions}
        onAddOption={onAddOption}
      />
    </PrePlanCellWrapper>
  );
});

/**
 * Wraps one grid cell to layer the pre-plan affordances on top of any cell type:
 *  - TEMPLATE: right-click (web) / long-press (native) opens a menu to (un)mark
 *    the cell as pre-plan; marked cells get a distinct tinted background + border.
 *  - EVENT: a marked cell shows a small check-off tick in the corner; ticking it
 *    toggles `prePlanChecked`. Checked cells read as done (green tint).
 * Cells that aren't pre-plan render exactly as before (a plain bordered cell).
 */
function PrePlanCellWrapper({
  width,
  isPrePlan,
  isChecked,
  colKey,
  onPrePlanMenu,
  onToggleChecked,
  children,
}: {
  width: number;
  isPrePlan: boolean;
  isChecked: boolean;
  colKey: string;
  onPrePlanMenu?: (colKey: string, node: any) => void;
  onToggleChecked?: (colKey: string) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<any>(null);

  // Template authors open the mark menu via right-click / long-press anywhere on
  // the cell. We attach the DOM contextmenu handler on web; long-press on native.
  const contextProps =
    onPrePlanMenu != null
      ? Platform.OS === "web"
        ? {
            // web-only DOM prop passed through react-native-web's View.
            onContextMenu: (e: any) => {
              e.preventDefault?.();
              onPrePlanMenu(colKey, ref.current);
            },
          }
        : {}
      : {};

  const tint = isChecked
    ? "bg-success-bg"
    : isPrePlan
      ? "bg-warn-bg/40"
      : "";
  const ring = isPrePlan ? "border-l-2 border-l-warn" : "";

  return (
    <View
      ref={ref}
      style={{ width }}
      className={`flex-row border-r border-border/60 ${tint} ${ring}`}
      {...contextProps}
    >
      <View className="flex-1">{children}</View>
      {/* Tick affordance: template = mark hint (long-press on native); event =
          tappable check-off for marked cells. */}
      {isPrePlan && onToggleChecked ? (
        <Pressable
          hitSlop={6}
          onPress={() => onToggleChecked(colKey)}
          accessibilityLabel={isChecked ? "Uncheck pre-plan cell" : "Check off pre-plan cell"}
          className="items-center justify-center px-1 active:opacity-70"
        >
          <Icon
            name={isChecked ? "check-circle" : "circle"}
            size={15}
            color={isChecked ? colors.success : colors.warn}
          />
        </Pressable>
      ) : null}
      {/* Native template authoring: long-press anywhere on the cell to mark. */}
      {onPrePlanMenu && Platform.OS !== "web" ? (
        <Pressable
          hitSlop={4}
          onLongPress={() => onPrePlanMenu(colKey, ref.current)}
          className="items-center justify-center px-1 active:opacity-70"
        >
          <Icon name="more-vertical" size={14} color={colors.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Per-row ✨ Autofill control — fills photo / cost / link from the item name in
 * one click. Owns its busy state and surfaces a spinner while the agent works.
 */
function AutofillBtn({ onPress }: { onPress: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      onPress={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await onPress();
        } catch {
          // Surfaced via the assistant panel / left as a no-op; never crash a row.
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
      hitSlop={4}
      accessibilityLabel="Autofill photo, cost and link"
      className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.accent} />
      ) : (
        <Icon name="sparkles" size={14} color={colors.accent} />
      )}
    </Pressable>
  );
}

function RowBtn({
  icon,
  onPress,
  disabled,
  danger,
}: {
  icon: any;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      className={`rounded p-1 active:bg-sunken ${disabled ? "opacity-25" : ""}`}
    >
      <Icon name={icon} size={14} color={danger ? colors.danger : colors.faint} />
    </Pressable>
  );
}
