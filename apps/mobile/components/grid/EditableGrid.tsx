/**
 * EditableGrid — a desktop-first, spreadsheet-like editable table that renders
 * any module (planning doc, supplies, comms, run-of-show) on either a template
 * or a live event. Columns are configurable; cells edit inline; rows add /
 * delete / reorder. Driven entirely by the module's ColumnDef set.
 */
import { useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import { useAction } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { type ModuleKey } from "@events-os/shared";
import { colors } from "../../lib/theme";
import { Icon } from "../ui/Icon";
import { OptionTag } from "../ui/OptionTag";
import { Popover } from "../ui/Popover";
import { TextField, Select } from "../ui/Field";
import { Button } from "../ui/Button";
import { GridCell } from "./cells";
import { SortableRows } from "./SortableRows";
import { ColumnOptionsEditor } from "./ColumnOptionsEditor";
import {
  useGridData,
  buildPatch,
  cellValue,
  type GridColumn,
  type GridItem,
  type GridMode,
} from "./useGridData";

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

/** Sensible default column widths (px) by type; overridden by column.width. */
function defaultWidth(col: GridColumn): number {
  if (col.key === "title") return 240;
  switch (col.type) {
    case "longtext":
      return 280;
    case "status":
      return 150;
    case "select":
      return 150;
    case "multiselect":
      return 210;
    case "person":
      return 170;
    case "role":
      return 150;
    case "offset_days":
    case "offset_minutes":
      return 96;
    case "due_date":
    case "date":
      return 130;
    case "number":
      return 90;
    case "currency":
      return 110;
    case "url":
      return 180;
    case "photo":
      return 84;
    default:
      return 160;
  }
}

// Drag grip lives in a LEFT gutter; delete in a small RIGHT gutter.
const GRIP_W = 30;
const DELETE_W = 38;

type Props = {
  mode: GridMode;
  parentId: string;
  module: ModuleKey;
  roles: Array<{ _id: string; label: string }>;
  eventDate?: number;
  editable?: boolean;
  /** Label for the add-row button, e.g. "Add task". */
  addLabel?: string;
};

export function EditableGrid({
  mode,
  parentId,
  module,
  roles,
  eventDate,
  editable = true,
  addLabel = "Add row",
}: Props) {
  const grid = useGridData(mode, parentId, module);
  const autofill = useAction(api.aiActions.autofillItem);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | "columns" | "group" | "addField" | "editOptions">(null);
  const [editColId, setEditColId] = useState<string | null>(null);

  const columns = useMemo(() => {
    return grid.columns
      .filter((c) => c.isVisible)
      // Owner + computed due date have no meaning while authoring a template.
      .filter((c) => (mode === "template" ? !["owner", "due_date"].includes(c.key) : true))
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.columns, mode]);

  const widths = useMemo(
    () => columns.map((c) => c.width ?? defaultWidth(c)),
    [columns],
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

  const commit = (item: GridItem, column: GridColumn, value: any) =>
    grid.updateItem(item._id, buildPatch(column, value, module));

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

  const orderedIds = useMemo(() => grid.items.map((i) => i._id), [grid.items]);

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
    for (const it of grid.items) {
      const v = cellValue(groupCol, it, module);
      const b = buckets.find((x) => x.key === v);
      (b ?? none).items.push(it);
    }
    return none.items.length ? [...buckets, none] : buckets;
  }, [groupCol, grid.items, module]);

  if (grid.loading) {
    return (
      <View className="items-center py-8">
        <Text className="text-sm text-muted">Loading…</Text>
      </View>
    );
  }

  const renderRow = (item: GridItem, isLast: boolean, drag?: GestureType) => (
    <Row
      item={item}
      isLast={isLast}
      columns={columns}
      widths={widths}
      module={module}
      mode={mode}
      roles={roles}
      eventDate={eventDate}
      editable={editable}
      onCommit={commit}
      onRemove={editable ? () => grid.removeItem(item._id) : undefined}
      onAutofill={canAutofill ? () => autofill({ itemId: item._id as any }) : undefined}
      drag={drag}
    />
  );

  const renderList = (items: GridItem[], sortable: boolean) => {
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
          onReorder={(ids) => grid.reorder(ids)}
          renderRow={({ id, index, drag }) => {
            const item = itemsById.get(id);
            if (!item) return null;
            return renderRow(item, index === items.length - 1, drag);
          }}
        />
      );
    }
    return items.map((item, i) => (
      <View key={item._id}>{renderRow(item, i === items.length - 1)}</View>
    ));
  };

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

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(tableWidth, 320) }}>
          {/* Column header */}
          <View className="flex-row items-center border-b border-border bg-sunken">
            {editable ? <View style={{ width: GRIP_W }} /> : null}
            {columns.map((c, i) => (
              <View key={c._id} style={{ width: widths[i] }} className="px-2 py-2.5">
                <Text className="text-2xs font-bold uppercase tracking-wider text-muted" numberOfLines={1}>
                  {c.label}
                </Text>
              </View>
            ))}
            {editable ? <View style={{ width: DELETE_W }} /> : null}
          </View>

          {/* Body — grouped board, or a single drag-reorderable list. */}
          {grid.items.length === 0 ? (
            <View className="px-3 py-6">
              <Text className="text-sm text-faint">No rows yet.</Text>
            </View>
          ) : groupCol && groups ? (
            groups.map((g) => (
              <View key={g.key}>
                <View
                  style={{ width: Math.max(tableWidth, 320) }}
                  className="flex-row items-center gap-2 border-b border-border bg-sunken/60 px-3 py-1.5"
                >
                  <OptionTag label={g.label} color={g.color} />
                  <Text className="text-2xs text-faint">{g.items.length}</Text>
                </View>
                {renderList(g.items, false)}
              </View>
            ))
          ) : (
            renderList(grid.items, true)
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
            .filter((c) => (mode === "template" ? !["owner", "due_date"].includes(c.key) : true))
            .sort((a, b) => a.order - b.order)
            .map((c) => (
              <View key={c._id} className="flex-row items-center justify-between px-3 py-2">
                <Text className="text-sm text-ink">{c.label}</Text>
                <View className="flex-row items-center gap-1">
                  {mode === "template" && (c.type === "select" || c.type === "status" || c.type === "multiselect") ? (
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

/**
 * A single grid row: the flex-row of fixed-width cells plus, when editable, the
 * row-actions column (drag grip + delete). Shared by the sortable (editable)
 * and read-only render paths so the markup stays in one place.
 */
function Row({
  item,
  isLast,
  columns,
  widths,
  module,
  mode,
  roles,
  eventDate,
  editable,
  onCommit,
  onRemove,
  onAutofill,
  drag,
}: {
  item: GridItem;
  isLast: boolean;
  columns: GridColumn[];
  widths: number[];
  module: ModuleKey;
  mode: GridMode;
  roles: Array<{ _id: string; label: string }>;
  eventDate?: number;
  editable: boolean;
  onCommit: (item: GridItem, column: GridColumn, value: any) => void;
  onRemove?: () => void;
  /** ✨ one-click enrich (photo/cost/link) from the item name. */
  onAutofill?: () => Promise<unknown>;
  /** Pan gesture from SortableRows; attached to the grip handle when editable. */
  drag?: GestureType;
}) {
  return (
    <View
      className={`flex-row items-start border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      }`}
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
        <View
          key={c._id}
          style={{ width: widths[i] }}
          className="flex-row border-r border-border/60"
        >
          <GridCell
            column={c}
            item={item}
            module={module}
            mode={mode}
            roles={roles}
            eventDate={eventDate}
            editable={editable}
            onChange={(value) => onCommit(item, c, value)}
          />
        </View>
      ))}

      {/* Right gutter: ✨ autofill + delete */}
      {editable ? (
        <View
          style={{ width: DELETE_W }}
          className="items-center justify-start gap-0.5 pt-1.5"
        >
          {onAutofill ? <AutofillBtn onPress={onAutofill} /> : null}
          {onRemove ? <RowBtn icon="trash-2" danger onPress={onRemove} /> : null}
        </View>
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
        <Icon name="zap" size={14} color={colors.accent} />
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
