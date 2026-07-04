/**
 * FieldChips — the day-panel card's "every column, one tap away" strip.
 *
 * Each column with a value renders as a small tappable chip (owner, role, cost,
 * audience, custom columns…); tapping opens the right editor in place (see
 * {@link FieldEditor}). A trailing dashed "+" chip lists the columns that are
 * still empty, and picking one opens its editor immediately. Which columns
 * appear is decided by {@link chipColumns}, so the calendar keeps full parity
 * with the table — including custom columns — without per-module code.
 */
import { useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon } from "../../ui/Icon";
import { Avatar } from "../../ui/Avatar";
import { Popover } from "../../ui/Popover";
import { measureAnchor } from "../../ui/ContextMenu";
import type { AnchorRect } from "../../ui/useAnchor";
import { colors } from "../../../lib/theme";
import { optionColor } from "../../../lib/optionColor";
import { type CalendarColumn, type ScheduleItem } from "./config";
import {
  chipText,
  hasValue,
  type EditTarget,
  type EventRole,
} from "./fieldChips.helpers";
import { FieldEditor } from "./FieldEditors";

export type { EventRole };

export function FieldChips({
  item,
  columns,
  roles,
  onSaveField,
}: {
  item: ScheduleItem;
  columns: CalendarColumn[];
  roles: EventRole[];
  /** Persist one column's new value (null clears it). */
  onSaveField: (column: CalendarColumn, value: unknown) => void;
}) {
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<any>(null);
  const [addAnchor, setAddAnchor] = useState<AnchorRect | undefined>();

  if (columns.length === 0) return null;

  const filled = columns.filter((c) => hasValue(item, c));
  const empty = columns.filter((c) => !hasValue(item, c));

  const openEditor = (column: CalendarColumn, node: any) => {
    measureAnchor(node, (anchor) => setEditing({ column, anchor }));
  };
  const close = () => setEditing(null);
  const save = (value: unknown) => {
    if (editing) onSaveField(editing.column, value);
    close();
  };

  return (
    <View className="mt-2 flex-row flex-wrap items-center gap-1.5">
      {filled.map((column) => (
        <Chip
          key={column.key}
          item={item}
          column={column}
          roles={roles}
          onOpen={(node) => openEditor(column, node)}
        />
      ))}

      {/* "+" — every column that's still empty, one tap from its editor. */}
      {empty.length > 0 ? (
        <Pressable
          ref={addRef}
          onPress={() =>
            measureAnchor(addRef.current, (a) => {
              setAddAnchor(a);
              setAddOpen(true);
            })
          }
          hitSlop={6}
          className="h-6 flex-row items-center gap-1 rounded-pill border border-dashed border-border px-2 active:bg-sunken web:hover:border-accent"
        >
          <Icon name="plus" size={11} color={colors.faint} />
          {filled.length === 0 ? (
            <Text className="text-2xs font-semibold text-faint">Add field</Text>
          ) : null}
        </Pressable>
      ) : null}

      <Popover visible={addOpen} onClose={() => setAddOpen(false)} anchor={addAnchor} width={200}>
        <View className="py-1">
          {empty.map((column) => (
            <Pressable
              key={column.key}
              onPress={() => {
                setAddOpen(false);
                setEditing({ column, anchor: addAnchor });
              }}
              className="flex-row items-center justify-between px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <Text className="text-sm text-ink">{column.label}</Text>
              <Text className="text-2xs text-faint">{column.type}</Text>
            </Pressable>
          ))}
        </View>
      </Popover>

      {editing ? (
        <FieldEditor
          item={item}
          target={editing}
          roles={roles}
          onSave={save}
          onClose={close}
        />
      ) : null}
    </View>
  );
}

/** One populated column as a tappable pill: faint label, then the value. */
function Chip({
  item,
  column,
  roles,
  onOpen,
}: {
  item: ScheduleItem;
  column: CalendarColumn;
  roles: EventRole[];
  onOpen: (node: any) => void;
}) {
  const ref = useRef<any>(null);

  if (column.key === "owner" && item.owner) {
    return (
      <Pressable
        ref={ref}
        onPress={() => onOpen(ref.current)}
        hitSlop={4}
        className="h-6 flex-row items-center gap-1.5 rounded-pill border border-border bg-sunken pl-1 pr-2 active:opacity-70 web:hover:border-faint"
      >
        <Avatar name={item.owner.name} size={16} />
        <Text
          className={`text-2xs font-semibold ${
            item.ownerIsInherited ? "italic text-muted" : "text-ink"
          }`}
          numberOfLines={1}
        >
          {item.owner.name}
        </Text>
      </Pressable>
    );
  }

  const { text, color } = chipText(item, column, roles);
  const c = color != null ? optionColor(color) : null;
  return (
    <Pressable
      ref={ref}
      onPress={() => onOpen(ref.current)}
      hitSlop={4}
      className="h-6 max-w-full flex-row items-center gap-1 rounded-pill border border-border bg-sunken px-2 active:opacity-70 web:hover:border-faint"
    >
      {c ? (
        <View className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.text }} />
      ) : (
        <Text className="text-2xs text-faint">{column.label}</Text>
      )}
      <Text className="text-2xs font-semibold text-ink" numberOfLines={1}>
        {text || "—"}
      </Text>
    </Pressable>
  );
}
