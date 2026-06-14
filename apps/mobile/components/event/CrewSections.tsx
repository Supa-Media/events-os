/**
 * CrewSections — an event's people rendered as two inline-editable database
 * tables: Volunteers and Vendors (paid), both backed by the `engagements` model.
 *
 * The chrome mirrors the People directory (apps/.../(tabs)/people.tsx): fixed
 * pixel column widths inside a horizontal ScrollView, an uppercase header row,
 * bordered cells, inline text that commits on blur, OptionTag+Popover selects,
 * an add-row, and a delete gutter. Volunteers is a FLAT, sortable table with a
 * Team column (no team group-header bands).
 *
 * PERSON-EDIT: Name / Email / Phone live on the shared `people` record, not on
 * the engagement — editing them here updates the person everywhere (every event
 * + the People directory). The header caption says so.
 *
 * RN-web notes: react-native-web ignores function-style Pressable `style`, so
 * layout lives on inner Views with static className + active:/web:hover variants.
 * Inline cells commit on `onBlur` (onEndEditing does not fire on RN-web).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Modal,
  Platform,
  Linking,
} from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  SectionHeader,
  Button,
  Icon,
  Avatar,
  OptionTag,
  Popover,
  PersonPicker,
  Badge,
} from "../ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";

type EngagementType = "volunteer" | "paid";
type Status = "invited" | "confirmed" | "declined";
type PaymentStatus = "unpaid" | "invoiced" | "paid";

type Person = {
  _id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  skills?: string[];
} | null;

type TeamOption = { value: string; label: string; color?: string | null };

type Engagement = {
  _id: string;
  eventId: string;
  personId: string;
  type: EngagementType;
  teams?: string[] | null;
  service?: string | null;
  status: Status;
  callTime?: string | null;
  responsibilities?: string | null;
  amountUsd?: number | null;
  paymentStatus?: PaymentStatus | null;
  notes?: string | null;
  person: Person;
};

// ── Chip cycle definitions ────────────────────────────────────────────────────
const STATUS_CYCLE: Status[] = ["invited", "confirmed", "declined"];
const STATUS_COLOR: Record<Status, string> = {
  invited: "gray",
  confirmed: "green",
  declined: "red",
};
const STATUS_LABEL: Record<Status, string> = {
  invited: "Invited",
  confirmed: "Confirmed",
  declined: "Declined",
};

const PAYMENT_CYCLE: PaymentStatus[] = ["unpaid", "invoiced", "paid"];
const PAYMENT_COLOR: Record<PaymentStatus, string> = {
  unpaid: "red",
  invoiced: "amber",
  paid: "green",
};
const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  unpaid: "Unpaid",
  invoiced: "Invoiced",
  paid: "Paid",
};

function next<T>(cycle: T[], current: T): T {
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length];
}

/** Confirm a destructive action — window.confirm on web, no prompt on native. */
function confirmRemove(name: string): boolean {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.confirm(`Remove ${name || "this person"} from this event?`);
  }
  return true;
}

// ── Fixed column widths (px) — keep columns put while the table scrolls. ──────
const VOL_COLS = {
  name: 220,
  email: 190,
  phone: 140,
  team: 180,
  service: 170,
  status: 120,
  callTime: 110,
  responsibilities: 220,
  type: 110,
} as const;
const VEN_COLS = {
  name: 220,
  email: 190,
  phone: 140,
  service: 170,
  amount: 100,
  payment: 120,
  status: 120,
  type: 140,
} as const;
const DELETE_W = 38;

function sumWidths(cols: Record<string, number>): number {
  return Object.values(cols).reduce((a, b) => a + b, 0) + DELETE_W;
}

// ── Header cells ──────────────────────────────────────────────────────────────
function HeaderCell({ label, width }: { label: string; width: number }) {
  return (
    <View style={{ width }} className="px-2 py-2.5">
      <Text
        className="text-2xs font-bold uppercase tracking-wider text-muted"
        numberOfLines={1}
      >
        {label}
      </Text>
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

// ── Inline text input (commits on blur) — mirrors people.tsx InlineText ───────
function InlineText({
  value,
  onCommit,
  placeholder,
  numeric,
  parse,
  format,
  weight,
}: {
  value: any;
  onCommit: (v: any) => void;
  placeholder?: string;
  numeric?: boolean;
  parse?: (t: string) => any;
  format?: (v: any) => string;
  weight?: "normal" | "medium";
}) {
  const initial = format ? format(value) : value == null ? "" : String(value);
  const [text, setText] = useState(initial);
  // Keep the field in sync when the underlying value changes from elsewhere.
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
      keyboardType={numeric ? "numbers-and-punctuation" : "default"}
      autoCapitalize="none"
      onBlur={() => onCommit(parse ? parse(text) : text)}
      className={`flex-1 px-2 py-1.5 text-sm leading-snug text-ink ${
        weight === "medium" ? "font-medium" : ""
      }`}
      style={{ minWidth: 40 }}
    />
  );
}

// ── Anchored-popover helper (matches grid/cells.tsx) ──────────────────────────
function useAnchor() {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<
    { x: number; y: number; width: number; height: number } | undefined
  >();
  const [visible, setVisible] = useState(false);
  const open = () => {
    const node = ref.current;
    if (node && typeof node.measureInWindow === "function") {
      node.measureInWindow(
        (x: number, y: number, width: number, height: number) => {
          setAnchor({ x, y, width, height });
          setVisible(true);
        },
      );
    } else {
      setVisible(true);
    }
  };
  return { ref, anchor, visible, open, close: () => setVisible(false) };
}

// ── A selectable option row inside a popover (matches grid/cells.tsx) ─────────
function OptionRow({
  label,
  color,
  selected,
  muted,
  onPress,
}: {
  label: string;
  color?: string | null;
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
      {muted ? (
        <Text className="text-sm text-muted">{label}</Text>
      ) : (
        <OptionTag label={label} color={color} />
      )}
      {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}

// ── Team cell: a MULTI-select — a volunteer can be on more than one team. ─────
// Shows a chip per selected team; the popover toggles options on/off and stays
// open so several can be picked at once.
function TeamCell({
  teams,
  options,
  onChange,
}: {
  teams?: string[] | null;
  options: TeamOption[];
  onChange: (teams: string[]) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const selected = teams ?? [];
  const selectedOpts = options.filter((o) => selected.includes(o.value));
  const toggle = (value: string) => {
    const set = new Set(selected);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    onChange(Array.from(set));
  };
  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5 active:opacity-70"
      >
        {selectedOpts.length === 0 ? (
          <Text className="text-sm text-faint">—</Text>
        ) : (
          selectedOpts.map((o) => (
            <OptionTag key={o.value} label={o.label} color={o.color} />
          ))
        )}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {options.length === 0 ? (
            <Text className="px-3 py-2 text-sm text-muted">
              No teams configured
            </Text>
          ) : (
            options.map((o) => (
              <OptionRow
                key={o.value}
                label={o.label}
                color={o.color}
                selected={selected.includes(o.value)}
                onPress={() => toggle(o.value)}
              />
            ))
          )}
        </View>
      </Popover>
    </>
  );
}

// ── Status cell: an OptionTag chip that cycles invited→confirmed→declined. ────
function StatusCell({
  status,
  onChange,
}: {
  status: Status;
  onChange: (s: Status) => void;
}) {
  return (
    <Pressable
      onPress={() => onChange(next(STATUS_CYCLE, status))}
      className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      <OptionTag label={STATUS_LABEL[status]} color={STATUS_COLOR[status]} />
    </Pressable>
  );
}

// ── Payment cell: an OptionTag chip that cycles unpaid→invoiced→paid. ─────────
function PaymentCell({
  payment,
  onChange,
}: {
  payment: PaymentStatus;
  onChange: (p: PaymentStatus) => void;
}) {
  return (
    <Pressable
      onPress={() => onChange(next(PAYMENT_CYCLE, payment))}
      className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      <OptionTag label={PAYMENT_LABEL[payment]} color={PAYMENT_COLOR[payment]} />
    </Pressable>
  );
}

// ── Amount cell: $X when set, tap to edit. ─────────────────────────────────────
function AmountCell({
  value,
  onCommit,
}: {
  value: number | null | undefined;
  onCommit: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <InlineText
        value={value}
        numeric
        placeholder="$0"
        format={(v) => (v != null ? `$${v}` : "")}
        parse={(t) => {
          const n = Number(t.replace(/[^0-9.]/g, ""));
          return t.trim() === "" || !Number.isFinite(n) ? null : n;
        }}
        onCommit={(v) => {
          onCommit(v);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <Pressable
      onPress={() => setEditing(true)}
      className="flex-1 flex-row items-center px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      {value != null ? (
        <Text className="text-sm text-ink">${value}</Text>
      ) : (
        <Text className="text-sm text-faint">$0</Text>
      )}
    </Pressable>
  );
}

// ── Small ghost text action (e.g. "Make paid →") ──────────────────────────────
function RowAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={6}
      className="flex-1 items-start px-2 py-1.5 active:opacity-60 web:hover:opacity-80"
    >
      <Text className="text-xs font-semibold text-accent">{label}</Text>
    </Pressable>
  );
}

// ── Name cell: avatar (opens detail) + inline-editable person name. ───────────
function NameCell({
  person,
  width,
  onOpen,
  onCommitName,
}: {
  person: Person;
  width: number;
  onOpen: () => void;
  onCommitName: (name: string) => void;
}) {
  const name = person?.name ?? "";
  return (
    <View
      style={{ width }}
      className="flex-row items-center gap-2 border-r border-border/60 px-2 py-1.5"
    >
      <Pressable onPress={onOpen} hitSlop={4} className="active:opacity-70">
        <Avatar name={name || "?"} size={26} />
      </Pressable>
      <InlineText
        value={name}
        placeholder="Name"
        weight="medium"
        onCommit={(t) => onCommitName(t)}
      />
    </View>
  );
}

// ── Delete gutter ──────────────────────────────────────────────────────────────
function DeleteGutter({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}) {
  return (
    <View style={{ width: DELETE_W }} className="items-center justify-center">
      <Pressable
        onPress={() => {
          if (confirmRemove(name)) onRemove();
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

// ── A reusable table shell (header row + body + add-row) ──────────────────────
function TableShell({
  tableWidth,
  header,
  children,
  addLabel,
  onAdd,
}: {
  tableWidth: number;
  header: React.ReactNode;
  children: React.ReactNode;
  addLabel: string;
  onAdd: () => void;
}) {
  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(tableWidth, 320) }}>
          <View className="flex-row items-center border-b border-border bg-sunken">
            {header}
          </View>
          {children}
        </View>
      </ScrollView>
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

// ── Volunteer row ──────────────────────────────────────────────────────────────
function VolunteerRow({
  engagement,
  teamOptions,
  isLast,
  onOpen,
  onCommitName,
  onUpdatePerson,
  onUpdate,
  onRemove,
}: {
  engagement: Engagement;
  teamOptions: TeamOption[];
  isLast: boolean;
  onOpen: () => void;
  onCommitName: (name: string) => void;
  onUpdatePerson: (patch: Record<string, unknown>) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const e = engagement;
  return (
    <View
      className={`flex-row items-stretch border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      }`}
    >
      <NameCell
        person={e.person}
        width={VOL_COLS.name}
        onOpen={onOpen}
        onCommitName={onCommitName}
      />
      <Cell width={VOL_COLS.email}>
        <InlineText
          value={e.person?.email ?? ""}
          placeholder="—"
          onCommit={(t) => onUpdatePerson({ email: t.trim() || undefined })}
        />
      </Cell>
      <Cell width={VOL_COLS.phone}>
        <InlineText
          value={e.person?.phone ?? ""}
          placeholder="—"
          onCommit={(t) => onUpdatePerson({ phone: t.trim() || undefined })}
        />
      </Cell>
      <Cell width={VOL_COLS.team}>
        <TeamCell
          teams={e.teams}
          options={teamOptions}
          onChange={(teams) => onUpdate({ teams })}
        />
      </Cell>
      <Cell width={VOL_COLS.service}>
        <InlineText
          value={e.service ?? ""}
          placeholder="—"
          onCommit={(t) => onUpdate({ service: t.trim() || null })}
        />
      </Cell>
      <Cell width={VOL_COLS.status}>
        <StatusCell
          status={e.status}
          onChange={(status) => onUpdate({ status })}
        />
      </Cell>
      <Cell width={VOL_COLS.callTime}>
        <InlineText
          value={e.callTime ?? ""}
          placeholder="—"
          onCommit={(t) => onUpdate({ callTime: t.trim() || null })}
        />
      </Cell>
      <Cell width={VOL_COLS.responsibilities}>
        <InlineText
          value={e.responsibilities ?? ""}
          placeholder="—"
          onCommit={(t) => onUpdate({ responsibilities: t.trim() || null })}
        />
      </Cell>
      <Cell width={VOL_COLS.type}>
        <RowAction label="Make paid →" onPress={() => onUpdate({ type: "paid" })} />
      </Cell>
      <DeleteGutter name={e.person?.name ?? ""} onRemove={onRemove} />
    </View>
  );
}

// ── Vendor (paid) row ──────────────────────────────────────────────────────────
function VendorRow({
  engagement,
  isLast,
  onOpen,
  onCommitName,
  onUpdatePerson,
  onUpdate,
  onRemove,
}: {
  engagement: Engagement;
  isLast: boolean;
  onOpen: () => void;
  onCommitName: (name: string) => void;
  onUpdatePerson: (patch: Record<string, unknown>) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const e = engagement;
  const payment = e.paymentStatus ?? "unpaid";
  return (
    <View
      className={`flex-row items-stretch border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      }`}
    >
      <NameCell
        person={e.person}
        width={VEN_COLS.name}
        onOpen={onOpen}
        onCommitName={onCommitName}
      />
      <Cell width={VEN_COLS.email}>
        <InlineText
          value={e.person?.email ?? ""}
          placeholder="—"
          onCommit={(t) => onUpdatePerson({ email: t.trim() || undefined })}
        />
      </Cell>
      <Cell width={VEN_COLS.phone}>
        <InlineText
          value={e.person?.phone ?? ""}
          placeholder="—"
          onCommit={(t) => onUpdatePerson({ phone: t.trim() || undefined })}
        />
      </Cell>
      <Cell width={VEN_COLS.service}>
        <InlineText
          value={e.service ?? ""}
          placeholder="—"
          onCommit={(t) => onUpdate({ service: t.trim() || null })}
        />
      </Cell>
      <Cell width={VEN_COLS.amount}>
        <AmountCell
          value={e.amountUsd}
          onCommit={(amountUsd) => onUpdate({ amountUsd })}
        />
      </Cell>
      <Cell width={VEN_COLS.payment}>
        <PaymentCell
          payment={payment}
          onChange={(paymentStatus) => onUpdate({ paymentStatus })}
        />
      </Cell>
      <Cell width={VEN_COLS.status}>
        <StatusCell
          status={e.status}
          onChange={(status) => onUpdate({ status })}
        />
      </Cell>
      <Cell width={VEN_COLS.type}>
        <RowAction
          label="Make volunteer →"
          onPress={() => onUpdate({ type: "volunteer" })}
        />
      </Cell>
      <DeleteGutter name={e.person?.name ?? ""} onRemove={onRemove} />
    </View>
  );
}

// ── Sorting (volunteers) ───────────────────────────────────────────────────────
type SortCol = "name" | "team" | "status";
type Sort = { col: SortCol; dir: 1 | -1 };

function sortVolunteers(
  rows: Engagement[],
  sort: Sort,
  teamOptions: TeamOption[],
): Engagement[] {
  // Sort by a row's FIRST team (alphabetically), so multi-team rows still cluster.
  const firstTeamLabel = (teams?: string[] | null) => {
    const labels = (teams ?? [])
      .map((v) => teamOptions.find((o) => o.value === v)?.label ?? v)
      .sort((x, y) => x.localeCompare(y));
    return labels[0] ?? "";
  };
  const cmp = (a: Engagement, b: Engagement) => {
    let av = "";
    let bv = "";
    if (sort.col === "name") {
      av = a.person?.name ?? "";
      bv = b.person?.name ?? "";
    } else if (sort.col === "team") {
      // Cluster by first team; unassigned (no team) sorts last.
      av = firstTeamLabel(a.teams) || "￿";
      bv = firstTeamLabel(b.teams) || "￿";
    } else {
      av = String(STATUS_CYCLE.indexOf(a.status));
      bv = String(STATUS_CYCLE.indexOf(b.status));
    }
    const r = av.localeCompare(bv, undefined, { numeric: true });
    return r * sort.dir;
  };
  return [...rows].sort(cmp);
}

// ── Person detail modal (read-only contact + engagement history) ──────────────
function PersonDetail({
  personId,
  name,
  onClose,
}: {
  personId: string | null;
  name: string;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={personId !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          {personId ? (
            <PersonDetailBody
              personId={personId}
              name={name}
              onClose={onClose}
            />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PersonDetailBody({
  personId,
  name,
  onClose,
}: {
  personId: string;
  name: string;
  onClose: () => void;
}) {
  const person = useQuery(api.people.get, { personId: personId as any });
  const history = useQuery(api.engagements.historyForPerson, {
    personId: personId as any,
  });
  const email = person?.email ?? null;
  const phone = person?.phone ?? null;

  return (
    <>
      <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
        <View className="flex-1 flex-row items-center gap-3">
          <Avatar name={name || "?"} size={36} />
          <Text className="font-display text-lg text-ink" numberOfLines={1}>
            {name || "Untitled"}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
          <Icon name="x" size={18} color={colors.muted} />
        </Pressable>
      </View>

      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ padding: 20 }}>
        {email || phone ? (
          <View className="mb-5 gap-2">
            {email ? (
              <ContactLink icon="mail" label={email} url={`mailto:${email}`} />
            ) : null}
            {phone ? (
              <ContactLink icon="phone" label={phone} url={`tel:${phone}`} />
            ) : null}
          </View>
        ) : null}

        <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
          Event history
        </Text>
        {history === undefined ? (
          <Text className="text-sm text-muted">Loading history…</Text>
        ) : history.count === 0 ? (
          <Text className="text-sm text-muted">No event history yet.</Text>
        ) : (
          <>
            <Text className="mb-2 text-sm font-semibold text-muted">
              {history.count} {history.count === 1 ? "event" : "events"} ·{" "}
              {history.volunteerCount} volunteer · {history.paidCount} paid · $
              {history.paidTotal} paid total
            </Text>
            <View className="gap-2">
              {history.history.map((h) => (
                <View
                  key={h.engagementId}
                  className="gap-1 rounded-lg border border-border p-3"
                >
                  <View className="flex-row items-center justify-between gap-2">
                    <Text
                      className="flex-1 text-sm font-bold text-ink"
                      numberOfLines={1}
                    >
                      {h.eventName}
                    </Text>
                    <Badge
                      label={h.type === "paid" ? "Paid" : "Volunteer"}
                      tone={h.type === "paid" ? "accent" : "neutral"}
                    />
                  </View>
                  <Text className="text-xs text-muted">
                    {formatDate(h.eventDate)}
                    {h.service ? ` · ${h.service}` : ""}
                    {h.type === "paid"
                      ? ` · $${h.amountUsd}${h.paymentStatus ? ` (${h.paymentStatus})` : ""}`
                      : ""}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </>
  );
}

function ContactLink({
  icon,
  label,
  url,
}: {
  icon: "mail" | "phone";
  label: string;
  url: string;
}) {
  return (
    <Pressable
      onPress={() => Linking.openURL(url)}
      className="flex-row items-center gap-2 active:opacity-70"
    >
      <Icon name={icon} size={15} color={colors.muted} />
      <Text className="text-sm text-info">{label}</Text>
    </Pressable>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────
export function CrewSections({ eventId }: { eventId: string }) {
  const volunteers = useQuery(api.engagements.listForEvent, {
    eventId: eventId as any,
    type: "volunteer",
  }) as Engagement[] | undefined;
  const vendors = useQuery(api.engagements.listForEvent, {
    eventId: eventId as any,
    type: "paid",
  }) as Engagement[] | undefined;

  // Team list = options of the "team" select column on the volunteer
  // expectations module. Falls back to an empty list (everyone is Unassigned).
  const volunteerModule = useQuery(api.items.listForEventModule, {
    eventId: eventId as any,
    module: "volunteer_expectations",
  });
  const teamOptions: TeamOption[] =
    (volunteerModule?.columns as any[] | undefined)?.find(
      (c) => c.key === "team",
    )?.options ?? [];

  const add = useMutation(api.engagements.add);
  const update = useMutation(api.engagements.update);
  const remove = useMutation(api.engagements.remove);
  const updatePerson = useMutation(api.people.update);
  const createPerson = useMutation(api.people.create);

  const [picker, setPicker] = useState<EngagementType | null>(null);
  const [openPersonId, setOpenPersonId] = useState<string | null>(null);
  const [openPersonName, setOpenPersonName] = useState("");
  const [sort, setSort] = useState<Sort>({ col: "team", dir: 1 });

  const onPick = (personId: string) => {
    if (!picker) return;
    // One engagement per person per type — if they're already on this event as
    // that type, don't add a duplicate row (set their teams on the existing one).
    const existing = (picker === "volunteer" ? volunteers : vendors)?.some(
      (e) => e.personId === personId,
    );
    if (!existing) {
      void add({
        eventId: eventId as any,
        personId: personId as any,
        type: picker,
      });
    }
    setPicker(null);
  };

  // Create a brand-new person, then engage them on this event as the picked type.
  const onCreate = async (name: string) => {
    if (!picker) return;
    const personId = await createPerson({ name });
    await add({ eventId: eventId as any, personId, type: picker });
    setPicker(null);
  };

  const onSort = (col: SortCol) =>
    setSort((s) => (s.col === col ? { col, dir: (s.dir * -1) as 1 | -1 } : { col, dir: 1 }));

  const openPerson = (id: string, name: string) => {
    setOpenPersonId(id);
    setOpenPersonName(name);
  };

  const sortedVolunteers = useMemo(
    () => sortVolunteers(volunteers ?? [], sort, teamOptions),
    [volunteers, sort, teamOptions],
  );

  const committed = (vendors ?? []).reduce(
    (sum, v) => sum + (typeof v.amountUsd === "number" ? v.amountUsd : 0),
    0,
  );

  const VOL_WIDTH = sumWidths(VOL_COLS);
  const VEN_WIDTH = sumWidths(VEN_COLS);

  return (
    <View>
      {/* Volunteers — a flat, sortable database table */}
      <SectionHeader
        title="Volunteers"
        count={volunteers?.length}
        right={
          <Button
            title="Add volunteer"
            variant="secondary"
            size="sm"
            icon="user-plus"
            onPress={() => setPicker("volunteer")}
          />
        }
      />
      <Text className="mb-2 text-xs text-faint">
        Editing name, email or phone changes this person across the whole app.
      </Text>
      {volunteers === undefined ? (
        <Text className="py-2 text-sm text-muted">Loading…</Text>
      ) : (
        <TableShell
          tableWidth={VOL_WIDTH}
          addLabel="Add volunteer"
          onAdd={() => setPicker("volunteer")}
          header={
            <>
              <SortHeaderCell
                label="Name"
                width={VOL_COLS.name}
                active={sort.col === "name"}
                dir={sort.dir}
                onPress={() => onSort("name")}
              />
              <HeaderCell label="Email" width={VOL_COLS.email} />
              <HeaderCell label="Phone" width={VOL_COLS.phone} />
              <SortHeaderCell
                label="Team"
                width={VOL_COLS.team}
                active={sort.col === "team"}
                dir={sort.dir}
                onPress={() => onSort("team")}
              />
              <HeaderCell label="Service / role" width={VOL_COLS.service} />
              <SortHeaderCell
                label="Status"
                width={VOL_COLS.status}
                active={sort.col === "status"}
                dir={sort.dir}
                onPress={() => onSort("status")}
              />
              <HeaderCell label="Call time" width={VOL_COLS.callTime} />
              <HeaderCell
                label="Responsibilities"
                width={VOL_COLS.responsibilities}
              />
              <HeaderCell label="Type" width={VOL_COLS.type} />
              <View style={{ width: DELETE_W }} />
            </>
          }
        >
          {sortedVolunteers.length === 0 ? (
            <View className="px-3 py-6">
              <Text className="text-sm text-faint">
                No volunteers yet — use Add volunteer.
              </Text>
            </View>
          ) : (
            sortedVolunteers.map((e, i) => (
              <VolunteerRow
                key={e._id}
                engagement={e}
                teamOptions={teamOptions}
                isLast={i === sortedVolunteers.length - 1}
                onOpen={() => openPerson(e.personId, e.person?.name ?? "")}
                onCommitName={(name) =>
                  void updatePerson({ personId: e.personId as any, name })
                }
                onUpdatePerson={(patch) =>
                  void updatePerson({ personId: e.personId as any, ...patch })
                }
                onUpdate={(patch) =>
                  void update({ engagementId: e._id as any, ...patch })
                }
                onRemove={() => void remove({ engagementId: e._id as any })}
              />
            ))
          )}
        </TableShell>
      )}

      {/* Vendors (paid) — a matching database table */}
      <SectionHeader
        title="Vendors (paid)"
        count={vendors?.length}
        right={
          <Button
            title="Add vendor"
            variant="secondary"
            size="sm"
            icon="user-plus"
            onPress={() => setPicker("paid")}
          />
        }
      />
      {vendors === undefined ? (
        <Text className="py-2 text-sm text-muted">Loading…</Text>
      ) : (
        <>
          <TableShell
            tableWidth={VEN_WIDTH}
            addLabel="Add vendor"
            onAdd={() => setPicker("paid")}
            header={
              <>
                <HeaderCell label="Name" width={VEN_COLS.name} />
                <HeaderCell label="Email" width={VEN_COLS.email} />
                <HeaderCell label="Phone" width={VEN_COLS.phone} />
                <HeaderCell label="Service" width={VEN_COLS.service} />
                <HeaderCell label="Amount" width={VEN_COLS.amount} />
                <HeaderCell label="Payment" width={VEN_COLS.payment} />
                <HeaderCell label="Status" width={VEN_COLS.status} />
                <HeaderCell label="Type" width={VEN_COLS.type} />
                <View style={{ width: DELETE_W }} />
              </>
            }
          >
            {vendors.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No paid vendors yet — use Add vendor.
                </Text>
              </View>
            ) : (
              vendors.map((e, i) => (
                <VendorRow
                  key={e._id}
                  engagement={e}
                  isLast={i === vendors.length - 1}
                  onOpen={() => openPerson(e.personId, e.person?.name ?? "")}
                  onCommitName={(name) =>
                    void updatePerson({ personId: e.personId as any, name })
                  }
                  onUpdatePerson={(patch) =>
                    void updatePerson({ personId: e.personId as any, ...patch })
                  }
                  onUpdate={(patch) =>
                    void update({ engagementId: e._id as any, ...patch })
                  }
                  onRemove={() => void remove({ engagementId: e._id as any })}
                />
              ))
            )}
          </TableShell>
          {vendors.length > 0 ? (
            <View className="mt-2 flex-row items-center gap-1.5 px-1">
              <Icon name="dollar-sign" size={14} color={colors.muted} />
              <Text className="text-sm font-semibold text-muted">
                Committed: ${committed}
              </Text>
            </View>
          ) : null}
        </>
      )}

      {/* Shared add-person picker (loads chapter roster via api.people.list) */}
      <PersonPicker
        visible={picker !== null}
        title={picker === "paid" ? "Add vendor" : "Add volunteer"}
        onPick={onPick}
        onCreate={onCreate}
        onClose={() => setPicker(null)}
      />

      {/* Person detail (read-only contact + engagement history) */}
      <PersonDetail
        personId={openPersonId}
        name={openPersonName}
        onClose={() => setOpenPersonId(null)}
      />
    </View>
  );
}
