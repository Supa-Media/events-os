import { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  Linking,
  Platform,
} from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  Badge,
  Pill,
  TextField,
  EmptyState,
  Avatar,
  Icon,
  OptionTag,
  InlineText,
  GridHeaderCell,
  SelectCell,
  type SelectOption,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  type VettingStatus,
  type RosterStatus,
  personaOf,
  type Persona,
} from "@events-os/shared";

// Vetting select options (gray / amber / green) — fed to the shared SelectCell.
const VETTING_OPTIONS: SelectOption<VettingStatus>[] = [
  { value: "unvetted", label: "Unvetted", color: "gray" },
  { value: "pending", label: "Pending", color: "amber" },
  { value: "vetted", label: "Vetted", color: "green" },
];

// Roster lifecycle select options. active=green, inactive=red,
// transitioning_*=gray, unavailable=amber.
const STATUS_OPTIONS: SelectOption<RosterStatus>[] = [
  { value: "active", label: "Active", color: "green" },
  { value: "inactive", label: "Inactive", color: "red" },
  { value: "transitioning_in", label: "Transitioning in", color: "gray" },
  { value: "transitioning_out", label: "Transitioning out", color: "gray" },
  { value: "unavailable", label: "Unavailable", color: "amber" },
];

// A roster row is the `people` document plus the `imageUrl` the list query
// resolves from the stored storageId. Persona (`team` / `volunteer` / `vendor`)
// is DERIVED from signals via the shared `personaOf`, not stored.
type Person = Doc<"people"> & { imageUrl?: string | null };

// The segmented filter adds an "all" sentinel on top of the shared Persona set.
type PersonaFilter = Persona | "all";

const PERSONA_FILTERS: { key: PersonaFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "team", label: "Team" },
  { key: "volunteer", label: "Volunteers" },
  { key: "vendor", label: "Vendors" },
];

// Fixed column widths (px) — mirrors EditableGrid's chrome so columns stay put
// while the table scrolls horizontally on web.
const COLS = {
  name: 210,
  status: 150,
  role: 150,
  email: 190,
  pwEmail: 190,
  phone: 140,
  gender: 96,
  skills: 200,
  rate: 100,
  vetting: 120,
  team: 90,
  poc: 150,
  projects: 190,
  comms: 160,
  social: 190,
  notes: 200,
  events: 56,
} as const;
const DELETE_W = 38;
const TABLE_WIDTH =
  Object.values(COLS).reduce((sum, w) => sum + w, 0) + DELETE_W;

/** Parse a comma list into trimmed, lowercased, de-duped values (skills). */
function parseSkills(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim().toLowerCase();
    if (s) seen.add(s);
  }
  return Array.from(seen);
}

/** Parse a comma list into trimmed, de-duped values, PRESERVING case (e.g.
 * Projects like "Eden" or comms channels). */
function parseList(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim();
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
  const [persona, setPersona] = useState<PersonaFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  // Distinct skills across the roster, for the filter bar.
  const allSkills = useMemo(() => {
    const set = new Set<string>();
    for (const p of people ?? []) {
      for (const s of p.skills ?? []) set.add(s);
    }
    return Array.from(set).sort();
  }, [people]);

  // Memoized so a re-render (e.g. typing in another field) doesn't re-scan the
  // whole roster — only persona / skill / search changes recompute the rows.
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (people ?? []).filter((p) => {
      if (persona !== "all" && personaOf(p) !== persona) return false;
      if (skillFilter && !(p.skills ?? []).includes(skillFilter)) return false;
      if (query && !p.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [people, persona, skillFilter, search]);

  if (people === undefined) return <Screen loading />;

  const openPerson = openId ? people.find((p) => p._id === openId) ?? null : null;

  async function handleAddRow() {
    await create({ name: "New person" });
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
      {/* Title row */}
      <View style={styles.titleRow}>
        <Text className="font-display text-2xl text-ink">People</Text>
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          Roster ({people.length})
        </Text>
      </View>

      {/* Persona segmented control (All · Team · Volunteers · Vendors) */}
      <View style={styles.segmented}>
        {PERSONA_FILTERS.map((f) => {
          const active = persona === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setPersona(f.key)}
              className={`rounded-md px-3 py-1.5 active:opacity-80 ${
                active ? "bg-raised shadow-sm" : ""
              }`}
            >
              <Text
                className={`text-sm font-semibold ${
                  active ? "text-ink" : "text-muted"
                }`}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
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
      </Narrow>

      {/* The grid */}
      <View className="overflow-hidden rounded-lg border border-border bg-raised">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ width: Math.max(TABLE_WIDTH, 320) }}>
            {/* Column header */}
            <View className="flex-row items-center border-b border-border bg-sunken">
              <GridHeaderCell label="Name" width={COLS.name} />
              <GridHeaderCell label="Status" width={COLS.status} />
              <GridHeaderCell label="Role" width={COLS.role} />
              <GridHeaderCell label="Email" width={COLS.email} />
              <GridHeaderCell label="PW Email" width={COLS.pwEmail} />
              <GridHeaderCell label="Phone" width={COLS.phone} />
              <GridHeaderCell label="Gender" width={COLS.gender} />
              <GridHeaderCell label="Skills" width={COLS.skills} />
              <GridHeaderCell label="Usual rate" width={COLS.rate} />
              <GridHeaderCell label="Vetting" width={COLS.vetting} />
              <GridHeaderCell label="Team" width={COLS.team} />
              <GridHeaderCell label="POC" width={COLS.poc} />
              <GridHeaderCell label="Projects" width={COLS.projects} />
              <GridHeaderCell label="Comms" width={COLS.comms} />
              <GridHeaderCell label="Social" width={COLS.social} />
              <GridHeaderCell label="Notes" width={COLS.notes} />
              <GridHeaderCell label="Events" width={COLS.events} />
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
                  No one matches your filters.
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
        <Narrow>
          <View style={{ marginTop: spacing.md }}>
            <EmptyState
              title="No people yet"
              message="Use the “Add person” row to start your roster, then edit each cell inline."
            />
          </View>
        </Narrow>
      ) : null}

      <PersonDetail person={openPerson} onClose={() => setOpenId(null)} />
    </Screen>
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
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const id = person._id as Id<"people">;

  const vetting = (person.vettingStatus ?? "unvetted") as VettingStatus;
  const status = (person.status ?? "active") as RosterStatus;

  // Avatar upload — web file input (mirrors SiteMapEditor). Native picker is
  // intentionally omitted; web is the test target.
  function pickAvatar() {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "image/jpeg" },
          body: file,
        });
        const { storageId } = await res.json();
        await update({ personId: id, image: storageId });
      } catch {
        // Swallow; the avatar stays as-is on failure.
      }
    };
    input.click();
  }

  return (
    <View
      className={`flex-row items-stretch border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      }`}
    >
      {/* Name: avatar (tap to upload photo) + inline text */}
      <View
        style={{ width: COLS.name }}
        className="flex-row items-center gap-2 border-r border-border/60 px-2 py-1.5"
      >
        <Pressable
          onPress={pickAvatar}
          hitSlop={4}
          accessibilityLabel="Upload photo"
          className="active:opacity-70"
        >
          <Avatar name={person.name || "?"} size={26} uri={person.imageUrl} />
        </Pressable>
        <InlineText
          value={person.name}
          placeholder="Name"
          weight="medium"
          onCommit={(t) => update({ personId: id, name: t })}
        />
      </View>

      {/* Status (roster lifecycle select) */}
      <Cell width={COLS.status}>
        <SelectCell
          value={status}
          options={STATUS_OPTIONS}
          onChange={(v) => update({ personId: id, status: v })}
        />
      </Cell>

      {/* Role (job title / vendor service line) */}
      <Cell width={COLS.role}>
        <InlineText
          value={person.role ?? ""}
          placeholder="—"
          onCommit={(t) => update({ personId: id, role: t.trim() || null })}
        />
      </Cell>

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

      {/* PW Email (publicworship.life address) */}
      <Cell width={COLS.pwEmail}>
        <InlineText
          value={person.pwEmail ?? ""}
          placeholder="—"
          onCommit={(t) => update({ personId: id, pwEmail: t.trim() || null })}
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

      {/* Gender (male / female / na toggle) */}
      <Cell width={COLS.gender}>
        <GenderCell
          value={person.gender}
          onChange={(v) => update({ personId: id, gender: v })}
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
        <SelectCell
          value={vetting}
          options={VETTING_OPTIONS}
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

      {/* POC (free-text point of contact) */}
      <Cell width={COLS.poc}>
        <InlineText
          value={person.pocName ?? ""}
          placeholder="—"
          onCommit={(t) => update({ personId: id, pocName: t.trim() || null })}
        />
      </Cell>

      {/* Projects: case-preserving comma list */}
      <Cell width={COLS.projects}>
        <ListCell
          values={person.projects ?? []}
          placeholder="Eden, Love Thy Neighbor…"
          onCommit={(next) => update({ personId: id, projects: next })}
        />
      </Cell>

      {/* Comms preferences: case-preserving comma list */}
      <Cell width={COLS.comms}>
        <ListCell
          values={person.commsPreferences ?? []}
          placeholder="slack, call, text…"
          onCommit={(next) => update({ personId: id, commsPreferences: next })}
        />
      </Cell>

      {/* Social link (single URL) */}
      <Cell width={COLS.social}>
        <InlineText
          value={person.socialLink ?? ""}
          placeholder="—"
          onCommit={(t) =>
            update({ personId: id, socialLink: t.trim() || null })
          }
        />
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
      <InlineText<number | null | undefined>
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

// ── Gender cell: tap to cycle male → female → na (na covers vendor orgs) ───────
const GENDER_LABEL: Record<"male" | "female" | "na", string> = {
  male: "Male",
  female: "Female",
  na: "N/A",
};
const GENDER_CYCLE = ["male", "female", "na"] as const;

function GenderCell({
  value,
  onChange,
}: {
  value: "male" | "female" | "na" | undefined;
  onChange: (v: "male" | "female" | "na") => void;
}) {
  const next = () => {
    const i = value ? GENDER_CYCLE.indexOf(value) : -1;
    onChange(GENDER_CYCLE[(i + 1) % GENDER_CYCLE.length]);
  };
  return (
    <Pressable
      onPress={next}
      className="flex-1 flex-row items-center px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      {value ? (
        <OptionTag label={GENDER_LABEL[value]} color="gray" />
      ) : (
        <Text className="text-sm text-faint">—</Text>
      )}
    </Pressable>
  );
}

// ── List cell: chips + inline comma editor, PRESERVING case (projects/comms) ──
function ListCell({
  values,
  placeholder,
  onCommit,
}: {
  values: string[];
  placeholder: string;
  onCommit: (next: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <InlineText
        value={values.join(", ")}
        placeholder={placeholder}
        onCommit={(t) => {
          onCommit(parseList(t));
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
      {values.length === 0 ? (
        <Text className="text-sm text-faint">—</Text>
      ) : (
        values.map((s) => <OptionTag key={s} label={s} />)
      )}
    </Pressable>
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
  segmented: {
    flexDirection: "row",
    alignSelf: "flex-start",
    gap: spacing.xs,
    padding: 3,
    marginBottom: spacing.sm,
    borderRadius: 10,
    backgroundColor: colors.sunken,
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
