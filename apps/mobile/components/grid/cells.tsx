/**
 * Grid cells — one inline editor per column type, dispatched by `GridCell`.
 *
 * Each cell reads its value from the item (via cellValue) and reports a new
 * logical value through `onChange`; the grid maps that to a mutation patch
 * (buildPatch). System columns (title/offset/status/role/owner/due_date) and
 * custom columns are all handled here uniformly.
 */
import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, Image } from "react-native";
import {
  formatDate,
  formatTime,
  parseDateInput,
  toDateInput,
} from "../../lib/format";
import {
  formatOffsetDays,
  formatOffsetMinutes,
  computeRunTime,
  type ModuleKey,
} from "@events-os/shared";
import { colors } from "../../lib/theme";
import { Icon } from "../ui/Icon";
import { Avatar } from "../ui/Avatar";
import { OptionTag } from "../ui/OptionTag";
import { Popover } from "../ui/Popover";
import { RolePicker } from "../ui/RolePicker";
import { PersonPicker } from "../ui/PersonPicker";
import { cellValue, type GridColumn, type GridItem, type GridMode } from "./useGridData";

export interface CellContext {
  column: GridColumn;
  item: GridItem;
  module: ModuleKey;
  mode: GridMode;
  roles: Array<{ _id: string; label: string }>;
  eventDate?: number;
  editable: boolean;
  onChange: (value: any) => void;
}

// ── Inline text input (commits on blur) ──────────────────────────────────────
function InlineText({
  value,
  onCommit,
  placeholder,
  multiline,
  numeric,
  autoFocus,
  parse,
  format,
  weight,
}: {
  value: any;
  onCommit: (v: any) => void;
  placeholder?: string;
  multiline?: boolean;
  numeric?: boolean;
  autoFocus?: boolean;
  parse?: (t: string) => any;
  format?: (v: any) => string;
  weight?: "normal" | "medium";
}) {
  const initial = format ? format(value) : value == null ? "" : String(value);
  const [text, setText] = useState(initial);
  // Auto-grow multiline inputs to their content height so wrapped text is never
  // clipped and the row grows to fit (no fixed-height <textarea> truncation).
  const [contentH, setContentH] = useState<number | undefined>(undefined);
  useEffect(() => {
    setText(format ? format(value) : value == null ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      placeholder={placeholder}
      placeholderTextColor={colors.faint}
      multiline={multiline}
      autoFocus={autoFocus}
      textAlignVertical="top"
      keyboardType={numeric ? "numbers-and-punctuation" : "default"}
      onContentSizeChange={
        multiline
          ? (e) => setContentH(e.nativeEvent.contentSize.height)
          : undefined
      }
      onBlur={() => onCommit(parse ? parse(text) : text)}
      className={`flex-1 px-2 py-1.5 text-sm leading-snug text-ink ${
        weight === "medium" ? "font-medium" : ""
      }`}
      style={[
        { minWidth: 40 },
        multiline && contentH ? { height: Math.max(contentH, 22) } : null,
      ]}
    />
  );
}

// ── Anchored-popover helper for select-style cells ────────────────────────────
function useAnchor() {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<
    { x: number; y: number; width: number; height: number } | undefined
  >();
  const [visible, setVisible] = useState(false);
  const open = () => {
    const node = ref.current;
    if (node && typeof node.measureInWindow === "function") {
      node.measureInWindow((x: number, y: number, width: number, height: number) => {
        setAnchor({ x, y, width, height });
        setVisible(true);
      });
    } else {
      setVisible(true);
    }
  };
  return { ref, anchor, visible, open, close: () => setVisible(false) };
}

function OptionRow({
  label,
  color,
  selected,
  muted,
  onPress,
}: {
  label: string;
  color?: string;
  selected?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center justify-between gap-3 px-3 py-2 ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      {color !== undefined || !muted ? (
        <OptionTag label={label} color={color} />
      ) : (
        <Text className="text-sm text-muted">{label}</Text>
      )}
      {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}

// ── Select / status (single choice) ───────────────────────────────────────────
function SelectCell({ column, value, editable, onChange }: any) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const opts = column.options ?? [];
  const current = opts.find((o: any) => o.value === value);
  return (
    <>
      <Pressable
        ref={ref}
        disabled={!editable}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70"
      >
        {current ? (
          <OptionTag label={current.label} color={current.color} />
        ) : (
          <Text className="text-sm text-faint">—</Text>
        )}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {value != null ? (
            <OptionRow label="Clear" muted onPress={() => { onChange(null); close(); }} />
          ) : null}
          {opts.map((o: any) => (
            <OptionRow
              key={o.value}
              label={o.label}
              color={o.color}
              selected={o.value === value}
              onPress={() => { onChange(o.value); close(); }}
            />
          ))}
        </View>
      </Popover>
    </>
  );
}

// ── Multiselect ───────────────────────────────────────────────────────────────
function MultiSelectCell({ column, value, editable, onChange }: any) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const opts = column.options ?? [];
  const selected: string[] = Array.isArray(value) ? value : [];
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
  return (
    <>
      <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
        {selected.map((v) => {
          const o = opts.find((opt: any) => opt.value === v);
          return (
            <OptionTag
              key={v}
              label={o?.label ?? v}
              color={o?.color}
              onRemove={editable ? () => toggle(v) : undefined}
            />
          );
        })}
        <Pressable ref={ref} disabled={!editable} onPress={open} hitSlop={6} className="active:opacity-70">
          {selected.length === 0 ? (
            <Text className="text-sm text-faint">—</Text>
          ) : (
            <Icon name="plus" size={14} color={colors.faint} />
          )}
        </Pressable>
      </View>
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {opts.map((o: any) => (
            <OptionRow
              key={o.value}
              label={o.label}
              color={o.color}
              selected={selected.includes(o.value)}
              onPress={() => toggle(o.value)}
            />
          ))}
        </View>
      </Popover>
    </>
  );
}

// ── Role ──────────────────────────────────────────────────────────────────────
function RoleCell({ value, roles, fallbackLabel, editable, onChange }: any) {
  const [open, setOpen] = useState(false);
  const role = roles.find((r: any) => r._id === value);
  const label = role?.label ?? (value ? fallbackLabel : null);
  return (
    <>
      <Pressable
        disabled={!editable}
        onPress={() => setOpen(true)}
        className="flex-1 px-2 py-1.5 active:opacity-70"
      >
        {label ? (
          <View className="self-start rounded-sm bg-sunken px-2 py-0.5">
            <Text className="text-xs font-semibold text-muted">{label}</Text>
          </View>
        ) : (
          <Text className="text-sm text-faint">—</Text>
        )}
      </Pressable>
      <RolePicker
        visible={open}
        roles={roles}
        selectedId={value ?? null}
        onPick={(id: string) => { onChange(id); setOpen(false); }}
        onClear={() => { onChange(null); setOpen(false); }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

// ── Person / owner ─────────────────────────────────────────────────────────────
// `ownerName` is the RESOLVED owner (explicit override, or inherited from the
// role). `inherited` => show it muted/italic to signal it's auto-from-role.
// `value` is the explicit override id (picker selection); clearing reverts to
// the role-derived owner.
function PersonCell({ value, ownerName, inherited, editable, onChange }: any) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        disabled={!editable}
        onPress={() => setOpen(true)}
        className="flex-1 flex-row items-center gap-2 px-2 py-1.5 active:opacity-70"
      >
        {ownerName ? (
          <>
            <Avatar name={ownerName} size={22} />
            <Text
              className={`text-sm ${inherited ? "italic text-muted" : "text-ink"}`}
              numberOfLines={1}
            >
              {ownerName}
            </Text>
          </>
        ) : (
          <Text className="text-sm text-faint">—</Text>
        )}
      </Pressable>
      <PersonPicker
        visible={open}
        selectedId={value ?? null}
        onPick={(id: string) => { onChange(id); setOpen(false); }}
        onClear={() => { onChange(null); setOpen(false); }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

// ── Chip-edit (offsets): show a chip, tap to edit a number ────────────────────
function ChipEditCell({ value, editable, onChange, format, placeholder }: any) {
  const [editing, setEditing] = useState(false);
  if (editing && editable) {
    return (
      <InlineText
        value={value}
        numeric
        autoFocus
        placeholder={placeholder}
        parse={(t) => {
          const n = parseInt(t.replace(/[^0-9-]/g, ""), 10);
          return Number.isFinite(n) ? n : 0;
        }}
        onCommit={(v) => { onChange(v); setEditing(false); }}
      />
    );
  }
  return (
    <Pressable
      disabled={!editable}
      onPress={() => setEditing(true)}
      className="flex-1 px-2 py-1.5 active:opacity-70"
    >
      {value != null ? (
        <View className="self-start rounded-sm bg-sunken px-2 py-0.5">
          <Text className="text-xs font-semibold text-muted">{format(value)}</Text>
        </View>
      ) : (
        <Text className="text-sm text-faint">{placeholder ?? "—"}</Text>
      )}
    </Pressable>
  );
}

// ── Photo (URL-backed for now; native upload deferred) ────────────────────────
function PhotoCell({ value, editable, onChange }: any) {
  const { ref, anchor, visible, open, close } = useAnchor();
  return (
    <>
      <Pressable
        ref={ref}
        disabled={!editable}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70"
      >
        {value ? (
          <Image
            source={{ uri: value }}
            style={{ width: 34, height: 34, borderRadius: 6, backgroundColor: colors.sunken }}
          />
        ) : (
          <Icon name="image" size={16} color={colors.faint} />
        )}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={280}>
        <View className="p-2">
          <InlineText
            value={value}
            placeholder="Paste image URL"
            autoFocus
            onCommit={(t) => { onChange(t && t.trim() ? t.trim() : null); }}
          />
        </View>
      </Popover>
    </>
  );
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
export function GridCell(ctx: CellContext) {
  const { column, item, module, mode, roles, eventDate, editable, onChange } = ctx;
  const value = cellValue(column, item, module);

  // Owner is meaningless on a template (template items have no owner).
  if (column.key === "owner" && mode === "template") {
    return <Text className="px-2 py-1.5 text-sm text-faint">—</Text>;
  }

  switch (column.type) {
    case "status":
    case "select":
      return <SelectCell column={column} value={value} editable={editable} onChange={onChange} />;
    case "multiselect":
      return <MultiSelectCell column={column} value={value} editable={editable} onChange={onChange} />;
    case "role":
      return (
        <RoleCell
          value={value}
          roles={roles}
          fallbackLabel={item.roleLabel}
          editable={editable}
          onChange={onChange}
        />
      );
    case "person":
      return (
        <PersonCell
          value={value}
          ownerName={item.owner?.name}
          inherited={item.ownerIsInherited}
          editable={editable}
          onChange={onChange}
        />
      );
    case "offset_days":
      return (
        <ChipEditCell
          value={value}
          editable={editable}
          onChange={onChange}
          format={formatOffsetDays}
          placeholder="T-…"
        />
      );
    case "offset_minutes":
      return (
        <ChipEditCell
          value={value}
          editable={editable}
          onChange={onChange}
          format={(v: number) =>
            eventDate != null ? formatTime(computeRunTime(eventDate, v)) : formatOffsetMinutes(v)
          }
          placeholder="0:00"
        />
      );
    case "due_date":
      return (
        <Text className="px-2 py-1.5 text-sm text-muted">
          {value != null ? formatDate(value) : "—"}
        </Text>
      );
    case "date":
      return (
        <InlineText
          value={value}
          placeholder="YYYY-MM-DD"
          format={(v) => (v != null ? toDateInput(v) : "")}
          parse={(t) => parseDateInput(t)}
          onCommit={(v) => onChange(v)}
        />
      );
    case "number":
      return (
        <InlineText
          value={value}
          numeric
          placeholder="—"
          parse={(t) => {
            if (t.trim() === "") return null;
            const n = Number(t);
            return Number.isFinite(n) ? n : null;
          }}
          onCommit={(v) => onChange(v)}
        />
      );
    case "currency":
      return (
        <InlineText
          value={value}
          numeric
          placeholder="$—"
          format={(v) => (v != null ? `$${v}` : "")}
          parse={(t) => {
            const n = Number(t.replace(/[^0-9.]/g, ""));
            return t.trim() === "" ? null : Number.isFinite(n) ? n : null;
          }}
          onCommit={(v) => onChange(v)}
        />
      );
    case "url":
      return (
        <InlineText
          value={value}
          placeholder="Link"
          parse={(t) => (t.trim() ? t.trim() : null)}
          onCommit={(v) => onChange(v)}
        />
      );
    case "photo":
      return <PhotoCell value={value} editable={editable} onChange={onChange} />;
    case "longtext":
      return (
        <InlineText
          value={value}
          multiline
          placeholder="—"
          parse={(t) => (t.trim() ? t : null)}
          onCommit={(v) => onChange(v)}
        />
      );
    case "text":
    default:
      return (
        <InlineText
          value={value}
          multiline
          placeholder={column.key === "title" ? "Untitled" : "—"}
          weight={column.key === "title" ? "medium" : "normal"}
          parse={(t) => (column.key === "title" ? t : t.trim() ? t : null)}
          onCommit={(v) => onChange(v)}
        />
      );
  }
}
