/**
 * Grid cells — one inline editor per column type, dispatched by `GridCell`.
 *
 * Each cell reads its value from the item (via cellValue) and reports a new
 * logical value through `onChange`; the grid maps that to a mutation patch
 * (buildPatch). System columns (title/offset/status/role/owner/due_date) and
 * custom columns are all handled here uniformly.
 */
import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Image,
  Platform,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
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
import { TemplateOwnerPicker } from "../ui/TemplateOwnerPicker";
import {
  cellValue,
  isTemplateOwnerCell,
  type GridColumn,
  type GridItem,
  type GridMode,
} from "./useGridData";

export interface CellContext {
  column: GridColumn;
  item: GridItem;
  module: ModuleKey;
  mode: GridMode;
  roles: Array<{ _id: string; label: string }>;
  eventDate?: number;
  editable: boolean;
  onChange: (value: any) => void;
  /** Template mode: the eventType id, used to source placeholder-crew owners. */
  templateId?: string;
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

// ── Template owner (placeholder crew) ─────────────────────────────────────────
// On a TEMPLATE the Expectations owner is a placeholder crew member, not a real
// person. The stored value is the templatePerson id (in fields.templateOwnerId)
// plus a cached display name (fields.templateOwnerName). Picking reports
// `{ id, name }`; clearing reports null.
function TemplateOwnerCell({ item, templateId, editable, onChange }: any) {
  const [open, setOpen] = useState(false);
  const name = item.fields?.templateOwnerName ?? null;
  const selectedId = item.fields?.templateOwnerId ?? null;
  // The row's team (Expectations `team` select value). When set, the picker
  // surfaces crew on that team first so the assignment lines up.
  const rowTeam = item.fields?.team ?? null;
  return (
    <>
      <Pressable
        disabled={!editable}
        onPress={() => setOpen(true)}
        className="flex-1 flex-row items-center gap-2 px-2 py-1.5 active:opacity-70"
      >
        {name ? (
          <>
            <Avatar name={name} size={22} />
            <Text className="text-sm text-ink" numberOfLines={1}>
              {name}
            </Text>
          </>
        ) : (
          <Text className="text-sm text-faint">—</Text>
        )}
      </Pressable>
      <TemplateOwnerPicker
        visible={open}
        eventTypeId={templateId}
        selectedId={selectedId}
        preferTeam={rowTeam}
        onPick={(id: string, picked: string) => {
          onChange({ id, name: picked });
          setOpen(false);
        }}
        onClear={() => {
          onChange(null);
          setOpen(false);
        }}
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

// ── Photo (Convex file storage upload; legacy URL values still display) ───────
// The field stores either a Convex `storageId` (new uploads) or a legacy
// http(s) URL (pasted). Display resolution: a URL is used directly; anything
// else is treated as a storageId and resolved through `api.storage.getUrl`.
function isHttpUrl(v: any): boolean {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

function PhotoCell({ value, editable, onChange }: any) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const [uploading, setUploading] = useState(false);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);

  // Resolve a storageId to a servable URL; skip for empty/URL values.
  const needsResolve = typeof value === "string" && value.length > 0 && !isHttpUrl(value);
  const resolvedUrl = useQuery(
    api.storage.getUrl,
    needsResolve ? { storageId: value as any } : "skip",
  );
  const displayUri = isHttpUrl(value) ? value : needsResolve ? resolvedUrl ?? undefined : undefined;

  // Upload a File (web) or Blob (native) and store the returned storageId.
  async function uploadBlob(blob: Blob, contentType: string) {
    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      const { storageId } = await res.json();
      onChange(storageId);
    } catch {
      // Swallow; cell simply stays unchanged on failure.
    } finally {
      setUploading(false);
    }
  }

  // WEB: DOM file input → File (already a Blob).
  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadBlob(file, file.type || "image/jpeg");
    };
    input.click();
  }

  // NATIVE: expo-image-picker → asset uri → fetch into a Blob.
  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await uploadBlob(blob, asset.mimeType || blob.type || "image/jpeg");
  }

  function pickImage() {
    close();
    if (Platform.OS === "web") pickWeb();
    else void pickNative();
  }

  return (
    <>
      <Pressable
        ref={ref}
        disabled={!editable}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70"
      >
        {uploading ? (
          <ActivityIndicator size="small" color={colors.faint} />
        ) : displayUri ? (
          <Image
            source={{ uri: displayUri }}
            style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: colors.sunken }}
          />
        ) : (
          <Icon name="image" size={16} color={colors.faint} />
        )}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={280}>
        <View className="gap-2 p-2">
          <Pressable
            onPress={pickImage}
            className="flex-row items-center gap-2 rounded-md bg-sunken px-3 py-2 active:opacity-70"
          >
            <Icon name="image" size={16} color={colors.muted} />
            <Text className="text-sm font-medium text-ink">Upload photo…</Text>
          </Pressable>
          <InlineText
            value={isHttpUrl(value) ? value : ""}
            placeholder="…or paste image URL"
            onCommit={(t) => {
              close();
              onChange(t && t.trim() ? t.trim() : null);
            }}
          />
        </View>
      </Popover>
    </>
  );
}

// ── How-To (links a cell to a standalone doc) ─────────────────────────────────
// The cell value is the doc's id (a string in `fields[colKey]`), or empty.
// Empty  → "+ How-To" opens a kind picker; picking calls api.docs.create and
//          stores the new id back into the cell via onChange.
// Filled → resolves the doc (api.docs.get) and renders by kind:
//   link/video → title + open-out icon (opens the URL) and an inline URL field.
//   note       → inline short text (writes docs.update body).
//   markdown   → title + "Open" → navigates to the doc editor screen (/doc/<id>).
const HOW_TO_KINDS: Array<{
  value: "link" | "video" | "note" | "markdown";
  label: string;
  icon: any;
}> = [
  { value: "link", label: "Link", icon: "link" },
  { value: "video", label: "Video", icon: "video" },
  { value: "note", label: "Note", icon: "file-text" },
  { value: "markdown", label: "Markdown page", icon: "book-open" },
];

/**
 * Small kind switcher for an EXISTING how-to cell. Renders a chevron button that
 * opens a Popover listing the four kinds; picking one patches only `doc.kind`
 * (lossless — `url`/`body` are left untouched so they reappear if switched
 * back). Routes through `onPick`, which the parent wires to its copy-on-write
 * commit so an event cell forks before changing kind.
 */
function HowToKindMenu({
  currentKind,
  editable,
  onPick,
}: {
  currentKind: "link" | "video" | "note" | "markdown";
  editable: boolean;
  onPick: (kind: "link" | "video" | "note" | "markdown") => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  if (!editable) return null;
  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        hitSlop={6}
        className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="chevron-down" size={13} color={colors.faint} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={200}>
        <View className="py-1">
          {HOW_TO_KINDS.map((k) => (
            <Pressable
              key={k.value}
              onPress={() => {
                close();
                if (k.value !== currentKind) onPick(k.value);
              }}
              className="flex-row items-center justify-between gap-2 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <View className="flex-row items-center gap-2">
                <Icon name={k.icon} size={15} color={colors.muted} />
                <Text className="text-sm text-ink">{k.label}</Text>
              </View>
              {k.value === currentKind ? (
                <Icon name="check" size={15} color={colors.accent} />
              ) : null}
            </Pressable>
          ))}
        </View>
      </Popover>
    </>
  );
}

function HowToCell({ value, editable, onChange, mode, eventItemId, colKey }: any) {
  const router = useRouter();
  const { ref, anchor, visible, open, close } = useAnchor();
  const docId = typeof value === "string" && value.length > 0 ? value : null;
  const doc = useQuery(api.docs.get, docId ? { docId: docId as any } : "skip");
  const createDoc = useMutation(api.docs.create);
  const updateDoc = useMutation(api.docs.update);
  const forkDoc = useMutation(api.docs.forkForEventItem);

  // Whether this cell lives on an event (vs a template) — only event cells fork.
  const isEvent = mode === "event";

  /**
   * Inline commit for an EVENT cell, with copy-on-write. If the cell's doc is
   * still a shared (template-origin) doc, fork it first, repoint the cell at the
   * copy, then write the edit to the copy. A doc already `scope === "event"` (a
   * prior fork, or one created directly on this event) is updated in place.
   * Template cells just update in place — they never fork.
   *
   * Switching `kind` is lossless: we patch only `kind` and leave `url`/`body`
   * alone, so the other field reappears if the user switches back.
   */
  async function commitInline(patch: {
    url?: string;
    body?: string;
    kind?: "link" | "video" | "note" | "markdown";
  }) {
    if (!docId) return;
    if (isEvent && doc && doc.scope !== "event" && eventItemId && colKey) {
      const res = await forkDoc({ docId: docId as any, eventItemId, colKey });
      onChange(res._id);
      await updateDoc({ docId: res._id as any, ...patch });
      return;
    }
    await updateDoc({ docId: docId as any, ...patch });
  }

  // Empty cell → "+ How-To" with a kind picker.
  if (!docId) {
    return (
      <>
        <Pressable
          ref={ref}
          disabled={!editable}
          onPress={open}
          className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70"
        >
          {editable ? (
            <>
              <Icon name="plus" size={13} color={colors.faint} />
              <Text className="text-sm text-faint">How-To</Text>
            </>
          ) : (
            <Text className="text-sm text-faint">—</Text>
          )}
        </Pressable>
        <Popover visible={visible} onClose={close} anchor={anchor} width={220}>
          <View className="py-1">
            {HOW_TO_KINDS.map((k) => (
              <Pressable
                key={k.value}
                onPress={async () => {
                  close();
                  // Created docs take the grid's scope: template grids author the
                  // shared master; event grids author an event-local doc.
                  const res = await createDoc({
                    kind: k.value,
                    title: "Untitled",
                    scope: isEvent ? "event" : "template",
                  });
                  onChange(res._id);
                  if (k.value === "markdown") router.push(`/doc/${res._id}` as any);
                }}
                className="flex-row items-center gap-2 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
              >
                <Icon name={k.icon} size={15} color={colors.muted} />
                <Text className="text-sm text-ink">{k.label}</Text>
              </Pressable>
            ))}
          </View>
        </Popover>
      </>
    );
  }

  if (doc === undefined) {
    return (
      <View className="flex-1 px-2 py-1.5">
        <Text className="text-sm text-faint">…</Text>
      </View>
    );
  }
  if (doc === null) {
    // Doc was deleted / not in chapter — let the author re-pick.
    return (
      <Pressable
        disabled={!editable}
        onPress={() => onChange(null)}
        className="flex-1 px-2 py-1.5 active:opacity-70"
      >
        <Text className="text-sm text-faint">Missing — tap to clear</Text>
      </Pressable>
    );
  }

  const kindIcon =
    HOW_TO_KINDS.find((k) => k.value === doc.kind)?.icon ?? "file-text";

  // Note → inline editable short text (writes to docs.body).
  if (doc.kind === "note") {
    return (
      <View className="flex-1 flex-row items-center gap-1 px-1">
        <Icon name={kindIcon} size={13} color={colors.faint} />
        <InlineText
          value={doc.body ?? ""}
          placeholder="Note…"
          parse={(t) => (t.trim() ? t : "")}
          onCommit={(t) => commitInline({ body: t })}
        />
        <HowToKindMenu
          currentKind={doc.kind}
          editable={editable}
          onPick={(kind) => commitInline({ kind })}
        />
      </View>
    );
  }

  // Link / Video → title + open-out, and an inline editable URL.
  if (doc.kind === "link" || doc.kind === "video") {
    return (
      <View className="flex-1 flex-row items-center gap-1 px-1">
        <Icon name={kindIcon} size={13} color={colors.faint} />
        <InlineText
          value={doc.url ?? ""}
          placeholder={doc.kind === "video" ? "Video URL" : "Link URL"}
          parse={(t) => (t.trim() ? t.trim() : "")}
          onCommit={(t) => commitInline({ url: t })}
        />
        {doc.url ? (
          <Pressable
            hitSlop={6}
            onPress={() => Linking.openURL(doc.url as string)}
            className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="external-link" size={14} color={colors.accent} />
          </Pressable>
        ) : null}
        <HowToKindMenu
          currentKind={doc.kind}
          editable={editable}
          onPick={(kind) => commitInline({ kind })}
        />
      </View>
    );
  }

  // Markdown → title + Open (navigates to the doc editor screen). Event cells
  // carry owner context so the editor can fork-on-first-edit (copy-on-write);
  // template cells navigate plain so they always edit the master in place.
  const markdownHref =
    isEvent && eventItemId && colKey
      ? `/doc/${docId}?ownerItem=${eventItemId}&ownerCol=${encodeURIComponent(colKey)}`
      : `/doc/${docId}`;
  return (
    <View className="flex-1 flex-row items-center px-1">
      <Pressable
        onPress={() => router.push(markdownHref as any)}
        className="flex-1 flex-row items-center justify-between gap-2 px-1 py-1.5 active:bg-sunken web:hover:bg-sunken"
      >
        <View className="flex-1 flex-row items-center gap-1.5">
          <Icon name={kindIcon} size={14} color={colors.muted} />
          <Text className="text-sm text-ink" numberOfLines={1}>
            {doc.title || "Untitled"}
          </Text>
        </View>
        <Icon name="chevron-right" size={15} color={colors.faint} />
      </Pressable>
      <HowToKindMenu
        currentKind={doc.kind}
        editable={editable}
        onPick={(kind) => commitInline({ kind })}
      />
    </View>
  );
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
export function GridCell(ctx: CellContext) {
  const { column, item, module, mode, roles, eventDate, editable, onChange, templateId } = ctx;
  const value = cellValue(column, item, module, mode);

  // Template Expectations owner = a placeholder crew member (templatePeople),
  // stored in the fields bag rather than the promoted ownerPersonId.
  if (isTemplateOwnerCell(column, module, mode)) {
    return (
      <TemplateOwnerCell
        item={item}
        templateId={templateId}
        editable={editable}
        onChange={onChange}
      />
    );
  }

  // Owner is meaningless on a template for every other module.
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
    case "how_to":
      return (
        <HowToCell
          value={value}
          editable={editable}
          onChange={onChange}
          mode={mode}
          eventItemId={item._id}
          colKey={column.key}
        />
      );
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
