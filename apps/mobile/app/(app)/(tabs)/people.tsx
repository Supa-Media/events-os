import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  Linking,
  TextInput,
  Platform,
} from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Badge,
  Pill,
  TextField,
  EmptyState,
  Avatar,
  Icon,
  OptionTag,
  Popover,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { VETTING_STATUSES, type VettingStatus } from "@events-os/shared";

const VETTING_LABEL: Record<VettingStatus, string> = {
  unvetted: "Unvetted",
  pending: "Pending",
  vetted: "Vetted",
};

// OptionTag colors mirror the grid's status palette (gray / amber / green).
const VETTING_COLOR: Record<VettingStatus, string> = {
  unvetted: "gray",
  pending: "amber",
  vetted: "green",
};

type Person = {
  _id: string;
  name: string;
  email?: string;
  phone?: string;
  skills?: string[];
  usualRateUsd?: number;
  notes?: string;
  isTeamMember?: boolean;
  vettingStatus?: VettingStatus;
  isActive?: boolean;
};

// Fixed column widths (px) — mirrors EditableGrid's chrome so columns stay put
// while the table scrolls horizontally on web.
const COLS = {
  name: 220,
  email: 200,
  phone: 150,
  skills: 220,
  rate: 110,
  vetting: 130,
  team: 96,
  notes: 240,
  events: 64,
} as const;
const DELETE_W = 38;
const TABLE_WIDTH =
  COLS.name +
  COLS.email +
  COLS.phone +
  COLS.skills +
  COLS.rate +
  COLS.vetting +
  COLS.team +
  COLS.notes +
  COLS.events +
  DELETE_W;

/** Parse a comma-separated skills string into a trimmed, lowercased, de-duped array. */
function parseSkills(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim().toLowerCase();
    if (s) seen.add(s);
  }
  return Array.from(seen);
}

/** Confirm a destructive action — window.confirm on web, no prompt on native. */
function confirmRemove(name: string): boolean {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.confirm(`Remove ${name || "this person"} from the roster?`);
  }
  return true;
}

/** PEOPLE roster — a spreadsheet-style editable grid with per-person history. */
export default function PeopleScreen() {
  const people = useQuery(api.people.list) as Person[] | undefined;
  const create = useMutation(api.people.create);

  const [search, setSearch] = useState("");
  const [skillFilter, setSkillFilter] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Distinct skills across the roster, for the filter bar.
  const allSkills = useMemo(() => {
    const set = new Set<string>();
    for (const p of people ?? []) {
      for (const s of p.skills ?? []) set.add(s);
    }
    return Array.from(set).sort();
  }, [people]);

  if (people === undefined) return <Screen loading />;

  const query = search.trim().toLowerCase();
  const filtered = people.filter((p) => {
    if (skillFilter && !(p.skills ?? []).includes(skillFilter)) return false;
    if (query && !p.name.toLowerCase().includes(query)) return false;
    return true;
  });

  const openPerson = openId ? people.find((p) => p._id === openId) ?? null : null;

  async function handleAddRow() {
    await create({ name: "New person" });
  }

  return (
    <Screen>
      {/* Title row */}
      <View style={styles.titleRow}>
        <Text className="font-display text-2xl text-ink">People</Text>
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          Roster ({people.length})
        </Text>
      </View>

      {/* Search + skill filter chips */}
      <TextField
        placeholder="Search by name…"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
      />

      {allSkills.length > 0 ? (
        <View style={styles.filterBar}>
          <Pill
            label="All"
            selected={skillFilter === null}
            onPress={() => setSkillFilter(null)}
          />
          {allSkills.map((s) => (
            <Pill
              key={s}
              label={s}
              selected={skillFilter === s}
              onPress={() => setSkillFilter((cur) => (cur === s ? null : s))}
            />
          ))}
        </View>
      ) : null}

      {/* The grid */}
      <View className="overflow-hidden rounded-lg border border-border bg-raised">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ width: Math.max(TABLE_WIDTH, 320) }}>
            {/* Column header */}
            <View className="flex-row items-center border-b border-border bg-sunken">
              <HeaderCell label="Name" width={COLS.name} />
              <HeaderCell label="Email" width={COLS.email} />
              <HeaderCell label="Phone" width={COLS.phone} />
              <HeaderCell label="Skills" width={COLS.skills} />
              <HeaderCell label="Usual rate" width={COLS.rate} />
              <HeaderCell label="Vetting" width={COLS.vetting} />
              <HeaderCell label="Team" width={COLS.team} />
              <HeaderCell label="Notes" width={COLS.notes} />
              <HeaderCell label="Events" width={COLS.events} />
              <View style={{ width: DELETE_W }} />
            </View>

            {/* Body */}
            {people.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No people yet — add your first below.
                </Text>
              </View>
            ) : filtered.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No one matches your search or skill filter.
                </Text>
              </View>
            ) : (
              filtered.map((p, i) => (
                <PersonRow
                  key={p._id}
                  person={p}
                  isLast={i === filtered.length - 1}
                  onOpen={() => setOpenId(p._id)}
                />
              ))
            )}
          </View>
        </ScrollView>

        {/* Add row */}
        <Pressable
          onPress={handleAddRow}
          className="flex-row items-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">Add person</Text>
        </Pressable>
      </View>

      {people.length === 0 ? (
        <View style={{ marginTop: spacing.md }}>
          <EmptyState
            title="No people yet"
            message="Use the “Add person” row to start your roster, then edit each cell inline."
          />
        </View>
      ) : null}

      <PersonDetail person={openPerson} onClose={() => setOpenId(null)} />
    </Screen>
  );
}

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

/** A single roster row of fixed-width inline-editable cells + a delete gutter. */
function PersonRow({
  person,
  isLast,
  onOpen,
}: {
  person: Person;
  isLast: boolean;
  onOpen: () => void;
}) {
  const update = useMutation(api.people.update);
  const remove = useMutation(api.people.remove);
  const id = person._id as any;

  const vetting = (person.vettingStatus ?? "unvetted") as VettingStatus;

  return (
    <View
      className={`flex-row items-stretch border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      }`}
    >
      {/* Name: avatar + inline text; tapping the name (not the field) opens detail */}
      <View
        style={{ width: COLS.name }}
        className="flex-row items-center gap-2 border-r border-border/60 px-2 py-1.5"
      >
        <Pressable onPress={onOpen} hitSlop={4} className="active:opacity-70">
          <Avatar name={person.name || "?"} size={26} />
        </Pressable>
        <InlineText
          value={person.name}
          placeholder="Name"
          weight="medium"
          onCommit={(t) => update({ personId: id, name: t })}
        />
      </View>

      {/* Email */}
      <Cell width={COLS.email}>
        <InlineText
          value={person.email ?? ""}
          placeholder="—"
          onCommit={(t) =>
            update({ personId: id, email: t.trim() || undefined })
          }
        />
      </Cell>

      {/* Phone */}
      <Cell width={COLS.phone}>
        <InlineText
          value={person.phone ?? ""}
          placeholder="—"
          onCommit={(t) =>
            update({ personId: id, phone: t.trim() || undefined })
          }
        />
      </Cell>

      {/* Skills: chips + comma-separated inline editor */}
      <Cell width={COLS.skills}>
        <SkillsCell
          skills={person.skills ?? []}
          onCommit={(next) => update({ personId: id, skills: next })}
        />
      </Cell>

      {/* Usual rate (currency) — shows green "Volunteer" when $0 / unset */}
      <Cell width={COLS.rate}>
        <RateCell
          value={person.usualRateUsd}
          onCommit={(v) => {
            if (v === undefined) return; // unparsable → leave unchanged
            update({ personId: id, usualRateUsd: v });
          }}
        />
      </Cell>

      {/* Vetting (status select) */}
      <Cell width={COLS.vetting}>
        <VettingCell
          value={vetting}
          onChange={(v) => update({ personId: id, vettingStatus: v })}
        />
      </Cell>

      {/* Team member toggle (gates owner/lead eligibility) */}
      <Cell width={COLS.team}>
        <Pressable
          onPress={() => update({ personId: id, isTeamMember: !person.isTeamMember })}
          className="flex-1 flex-row items-center px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
        >
          {person.isTeamMember ? (
            <OptionTag label="Team" color="green" />
          ) : (
            <Text className="text-sm text-faint">—</Text>
          )}
        </Pressable>
      </Cell>

      {/* Notes */}
      <Cell width={COLS.notes}>
        <InlineText
          value={person.notes ?? ""}
          placeholder="—"
          onCommit={(t) =>
            update({ personId: id, notes: t.trim() || null })
          }
        />
      </Cell>

      {/* Events: a "view" affordance that opens the detail (count lives there). */}
      <View
        style={{ width: COLS.events }}
        className="items-center justify-center border-r border-border/60"
      >
        <Pressable
          onPress={onOpen}
          hitSlop={6}
          accessibilityLabel="View event history"
          className="rounded p-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="chevron-right" size={16} color={colors.muted} />
        </Pressable>
      </View>

      {/* Right gutter: delete */}
      <View style={{ width: DELETE_W }} className="items-center justify-center">
        <Pressable
          onPress={() => {
            if (confirmRemove(person.name)) remove({ personId: id });
          }}
          hitSlop={4}
          accessibilityLabel="Remove person"
          className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="trash-2" size={14} color={colors.danger} />
        </Pressable>
      </View>
    </View>
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

// ── Inline text input (commits on blur) — mirrors cells.tsx InlineText ────────
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

// ── Rate cell: $X when set, else a green "Volunteer" tag. Tap to edit. ────────
function RateCell({
  value,
  onCommit,
}: {
  value: number | null | undefined;
  onCommit: (v: number | null | undefined) => void;
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
          return t.trim() === ""
            ? null
            : Number.isFinite(n)
              ? n
              : undefined;
        }}
        onCommit={(v) => {
          onCommit(v);
          setEditing(false);
        }}
      />
    );
  }

  const isVolunteer = value == null || value === 0;
  return (
    <Pressable
      onPress={() => setEditing(true)}
      className="flex-1 flex-row items-center px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      {isVolunteer ? (
        <OptionTag label="Volunteer" color="green" />
      ) : (
        <Text className="text-sm text-ink">${value}</Text>
      )}
    </Pressable>
  );
}

// ── Skills cell: chips + an inline comma-separated editor ─────────────────────
// Tapping the chips area swaps to a text input; on blur it splits/normalizes.
function SkillsCell({
  skills,
  onCommit,
}: {
  skills: string[];
  onCommit: (next: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <InlineText
        value={skills.join(", ")}
        placeholder="sound, lighting…"
        onCommit={(t) => {
          onCommit(parseSkills(t));
          setEditing(false);
        }}
      />
    );
  }

  return (
    <Pressable
      onPress={() => setEditing(true)}
      className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      {skills.length === 0 ? (
        <Text className="text-sm text-faint">—</Text>
      ) : (
        skills.map((s) => <OptionTag key={s} label={s} />)
      )}
    </Pressable>
  );
}

// ── Vetting cell: an OptionTag that opens a Popover of statuses ───────────────
function VettingCell({
  value,
  onChange,
}: {
  value: VettingStatus;
  onChange: (v: VettingStatus) => void;
}) {
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

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70"
      >
        <OptionTag label={VETTING_LABEL[value]} color={VETTING_COLOR[value]} />
      </Pressable>
      <Popover visible={visible} onClose={() => setVisible(false)} anchor={anchor}>
        <View className="py-1">
          {VETTING_STATUSES.map((s) => (
            <Pressable
              key={s}
              onPress={() => {
                onChange(s);
                setVisible(false);
              }}
              className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <OptionTag label={VETTING_LABEL[s]} color={VETTING_COLOR[s]} />
              {s === value ? (
                <Icon name="check" size={15} color={colors.accent} />
              ) : null}
            </Pressable>
          ))}
        </View>
      </Popover>
    </>
  );
}

/** Centered modal detail: read-only contact + event history. */
function PersonDetail({
  person,
  onClose,
}: {
  person: Person | null;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={person !== null}
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
          {person ? <PersonDetailBody person={person} onClose={onClose} /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PersonDetailBody({
  person,
  onClose,
}: {
  person: Person;
  onClose: () => void;
}) {
  const history = useQuery(api.engagements.historyForPerson, {
    personId: person._id as any,
  });

  return (
    <>
      <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
        <View style={styles.rowIdentity}>
          <Avatar name={person.name || "?"} size={36} />
          <Text className="font-display text-lg text-ink" numberOfLines={1}>
            {person.name || "Untitled"}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
          <Icon name="x" size={18} color={colors.muted} />
        </Pressable>
      </View>

      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={styles.detailBody}>
        {/* Contact */}
        {person.email || person.phone ? (
          <View style={styles.contactRows}>
            {person.email ? (
              <ContactLink
                icon="mail"
                label={person.email}
                url={`mailto:${person.email}`}
              />
            ) : null}
            {person.phone ? (
              <ContactLink
                icon="phone"
                label={person.phone}
                url={`tel:${person.phone}`}
              />
            ) : null}
          </View>
        ) : null}

        {/* History */}
        <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
          Event history
        </Text>
        {history === undefined ? (
          <Text style={styles.historyEmpty}>Loading history…</Text>
        ) : history.count === 0 ? (
          <Text style={styles.historyEmpty}>No event history yet.</Text>
        ) : (
          <>
            <Text style={styles.historySummary}>
              {history.count} {history.count === 1 ? "event" : "events"} ·{" "}
              {history.volunteerCount} volunteer · {history.paidCount} paid · $
              {history.paidTotal} paid total
            </Text>
            <View style={styles.historyList}>
              {history.history.map((h) => (
                <View key={h.engagementId} style={styles.historyItem}>
                  <View style={styles.historyItemTop}>
                    <Text style={styles.historyEvent} numberOfLines={1}>
                      {h.eventName}
                    </Text>
                    <Badge
                      label={h.type === "paid" ? "Paid" : "Volunteer"}
                      tone={h.type === "paid" ? "accent" : "neutral"}
                    />
                  </View>
                  <Text style={styles.historyMeta}>
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
      <Text style={styles.contactLink}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  filterBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  rowIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flex: 1,
  },
  detailBody: { padding: spacing.lg },
  contactRows: { gap: spacing.sm, marginBottom: spacing.lg },
  contactLink: { fontSize: 14, color: colors.info },
  historySummary: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.muted,
    marginBottom: spacing.sm,
  },
  historyEmpty: { fontSize: 13, color: colors.muted },
  historyList: { gap: spacing.sm },
  historyItem: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing.md,
    gap: spacing.xs,
  },
  historyItemTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  historyEvent: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  historyMeta: { fontSize: 12, color: colors.muted },
});
