/**
 * CrewSections — an event's people rendered as two inline-editable database
 * tables: Volunteers and Vendors (paid), both backed by the `engagements` model.
 *
 * The chrome mirrors the People directory (apps/.../(tabs)/people.tsx): fixed
 * pixel column widths inside a horizontal ScrollView, an uppercase header row,
 * bordered cells, inline text that commits on blur, OptionTag+Popover selects,
 * an add-row, and a delete gutter. Volunteers is a FLAT, sortable table with a
 * Team column (no team group-header bands). Both tables share the parameterized
 * `<EngagementTable>` — they differ only in their column descriptors.
 *
 * PERSON-EDIT: Name / Email / Phone live on the shared `people` record, not on
 * the engagement — editing them here updates the person everywhere (every event
 * + the People directory). The header caption says so.
 *
 * RN-web notes: react-native-web ignores function-style Pressable `style`, so
 * layout lives on inner Views with static className + active:/web:hover variants.
 * Inline cells commit on `onBlur` (onEndEditing does not fire on RN-web).
 */
import { useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Modal,
  Platform,
  Linking,
} from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  SectionHeader,
  Button,
  Icon,
  Avatar,
  OptionTag,
  Popover,
  PersonPicker,
  Badge,
  InlineText,
  useAnchor,
} from "../ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";
import {
  EngagementTable,
  type EngagementColumn,
} from "./EngagementTable";
import type {
  Engagement,
  EngagementPerson,
  TeamOption,
  Sort,
  SortCol,
} from "./engagementTypes";

type EngagementType = "volunteer" | "paid";
type Status = "invited" | "confirmed" | "declined";
type PaymentStatus = "unpaid" | "invoiced" | "paid";

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
  team: 180,
  service: 170,
  amount: 100,
  payment: 120,
  status: 120,
  type: 140,
} as const;

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
// open so several can be picked at once. (Multi-select, so the single-value
// shared SelectCell doesn't apply.)
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
      <InlineText<number | null | undefined>
        value={value}
        numeric
        placeholder="$0"
        format={(v) => (v != null ? `$${v}` : "")}
        parse={(t) => {
          const n = Number(t.replace(/[^0-9.]/g, ""));
          return t.trim() === "" || !Number.isFinite(n) ? null : n;
        }}
        onCommit={(v) => {
          onCommit(v ?? null);
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
// Placeholder volunteers (created from a template's crew) instead render a
// tappable "Replace" affordance and a Placeholder tag: their name isn't a real
// person yet, so it can't be inline-edited — it must be swapped for a real one.
// Renders inside EngagementTable's bordered <Cell>, so it draws no border of
// its own — just the avatar + name layout.
function NameCell({
  person,
  onOpen,
  onCommitName,
  onReplace,
}: {
  person: EngagementPerson;
  onOpen: () => void;
  onCommitName: (name: string) => void;
  onReplace?: () => void;
}) {
  const name = person?.name ?? "";
  const isPlaceholder = person?.isPlaceholder === true && !!onReplace;

  if (isPlaceholder) {
    return (
      <View className="flex-1 flex-row items-center gap-2 px-2 py-1.5">
        <Avatar name={name || "?"} size={26} />
        <Pressable
          onPress={onReplace}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Replace placeholder volunteer"
          className="min-w-0 flex-1 active:opacity-70 web:hover:opacity-90"
        >
          <Text className="text-sm font-medium text-ink" numberOfLines={1}>
            {name || "Unassigned"}
          </Text>
          <View className="mt-0.5 flex-row items-center gap-1">
            <OptionTag label="Placeholder" color="amber" />
            <Text className="text-2xs font-semibold text-accent">Replace →</Text>
          </View>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-1 flex-row items-center gap-2 px-2 py-1.5">
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

// ── Sorting (volunteers) ───────────────────────────────────────────────────────
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
  const person = useQuery(api.people.get, {
    personId: personId as Id<"people">,
  });
  const history = useQuery(api.engagements.historyForPerson, {
    personId: personId as Id<"people">,
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
    eventId: eventId as Id<"events">,
    type: "volunteer",
  }) as Engagement[] | undefined;
  const vendors = useQuery(api.engagements.listForEvent, {
    eventId: eventId as Id<"events">,
    type: "paid",
  }) as Engagement[] | undefined;

  // Team list = options of the "team" select column on the volunteer
  // expectations module. Falls back to an empty list (everyone is Unassigned).
  const volunteerModule = useQuery(api.items.listForEventModule, {
    eventId: eventId as Id<"events">,
    module: "volunteer_expectations",
  });
  const teamOptions: TeamOption[] =
    (volunteerModule?.columns as { key: string; options?: TeamOption[] }[] | undefined)?.find(
      (c) => c.key === "team",
    )?.options ?? [];

  const add = useMutation(api.engagements.add);
  const update = useMutation(api.engagements.update);
  const remove = useMutation(api.engagements.remove);
  const replacePlaceholder = useMutation(
    api.engagements.replacePlaceholderVolunteer,
  );
  const updatePerson = useMutation(api.people.update);
  const createPerson = useMutation(api.people.create);

  const [picker, setPicker] = useState<EngagementType | null>(null);
  // Engagement currently being re-pointed from a placeholder to a real person.
  const [replacingId, setReplacingId] = useState<Id<"engagements"> | null>(null);
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
        eventId: eventId as Id<"events">,
        personId: personId as Id<"people">,
        type: picker,
      });
    }
    setPicker(null);
  };

  // Create a brand-new person, then engage them on this event as the picked type.
  const onCreate = async (name: string) => {
    if (!picker) return;
    const personId = await createPerson({ name });
    await add({ eventId: eventId as Id<"events">, personId, type: picker });
    setPicker(null);
  };

  // Replace flow: point a placeholder volunteer's engagement at a REAL person.
  // The backend mutation remaps Expectations owners and deletes the placeholder.
  const onPickReplacement = async (personId: string) => {
    if (!replacingId) return;
    await replacePlaceholder({
      engagementId: replacingId,
      personId: personId as Id<"people">,
    });
    setReplacingId(null);
  };

  // Replace via add-new: create the real person first, then re-point.
  const onCreateReplacement = async (name: string) => {
    if (!replacingId) return;
    const personId = await createPerson({ name });
    await replacePlaceholder({ engagementId: replacingId, personId });
    setReplacingId(null);
  };

  const onSort = (col: SortCol) =>
    setSort((s) =>
      s.col === col ? { col, dir: (s.dir * -1) as 1 | -1 } : { col, dir: 1 },
    );

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

  // ── Shared row callbacks (person edits vs engagement edits) ────────────────
  const commitName = (e: Engagement) => (name: string) =>
    void updatePerson({ personId: e.personId as Id<"people">, name });
  const patchPerson =
    (e: Engagement) => (patch: Record<string, unknown>) =>
      void updatePerson({ personId: e.personId as Id<"people">, ...patch });
  const patchEngagement =
    (e: Engagement) => (patch: Record<string, unknown>) =>
      void update({ engagementId: e._id as Id<"engagements">, ...patch });

  // ── Column descriptors ──────────────────────────────────────────────────────
  const volunteerColumns: EngagementColumn[] = [
    {
      key: "name",
      label: "Name",
      width: VOL_COLS.name,
      sortCol: "name",
      render: (e) => (
        <NameCell
          person={e.person}
          onOpen={() => openPerson(e.personId, e.person?.name ?? "")}
          onCommitName={commitName(e)}
          onReplace={() => setReplacingId(e._id as Id<"engagements">)}
        />
      ),
    },
    {
      key: "email",
      label: "Email",
      width: VOL_COLS.email,
      render: (e) => (
        <InlineText
          value={e.person?.email ?? ""}
          placeholder="—"
          onCommit={(t) => patchPerson(e)({ email: t.trim() || undefined })}
        />
      ),
    },
    {
      key: "phone",
      label: "Phone",
      width: VOL_COLS.phone,
      render: (e) => (
        <InlineText
          value={e.person?.phone ?? ""}
          placeholder="—"
          onCommit={(t) => patchPerson(e)({ phone: t.trim() || undefined })}
        />
      ),
    },
    {
      key: "team",
      label: "Team",
      width: VOL_COLS.team,
      sortCol: "team",
      render: (e) => (
        <TeamCell
          teams={e.teams}
          options={teamOptions}
          onChange={(teams) => patchEngagement(e)({ teams })}
        />
      ),
    },
    {
      key: "service",
      label: "Service / role",
      width: VOL_COLS.service,
      render: (e) => (
        <InlineText
          value={e.service ?? ""}
          placeholder="—"
          onCommit={(t) => patchEngagement(e)({ service: t.trim() || null })}
        />
      ),
    },
    {
      key: "status",
      label: "Status",
      width: VOL_COLS.status,
      sortCol: "status",
      render: (e) => (
        <StatusCell
          status={e.status}
          onChange={(status) => patchEngagement(e)({ status })}
        />
      ),
    },
    {
      key: "callTime",
      label: "Call time",
      width: VOL_COLS.callTime,
      render: (e) => (
        <InlineText
          value={e.callTime ?? ""}
          placeholder="—"
          onCommit={(t) => patchEngagement(e)({ callTime: t.trim() || null })}
        />
      ),
    },
    {
      key: "responsibilities",
      label: "Responsibilities",
      width: VOL_COLS.responsibilities,
      render: (e) => (
        <InlineText
          value={e.responsibilities ?? ""}
          placeholder="—"
          onCommit={(t) =>
            patchEngagement(e)({ responsibilities: t.trim() || null })
          }
        />
      ),
    },
    {
      key: "type",
      label: "Type",
      width: VOL_COLS.type,
      render: (e) => (
        <RowAction
          label="Make paid →"
          onPress={() => patchEngagement(e)({ type: "paid" })}
        />
      ),
    },
  ];

  const vendorColumns: EngagementColumn[] = [
    {
      key: "name",
      label: "Name",
      width: VEN_COLS.name,
      render: (e) => (
        <NameCell
          person={e.person}
          onOpen={() => openPerson(e.personId, e.person?.name ?? "")}
          onCommitName={commitName(e)}
        />
      ),
    },
    {
      key: "email",
      label: "Email",
      width: VEN_COLS.email,
      render: (e) => (
        <InlineText
          value={e.person?.email ?? ""}
          placeholder="—"
          onCommit={(t) => patchPerson(e)({ email: t.trim() || undefined })}
        />
      ),
    },
    {
      key: "phone",
      label: "Phone",
      width: VEN_COLS.phone,
      render: (e) => (
        <InlineText
          value={e.person?.phone ?? ""}
          placeholder="—"
          onCommit={(t) => patchPerson(e)({ phone: t.trim() || undefined })}
        />
      ),
    },
    {
      key: "team",
      label: "Team",
      width: VEN_COLS.team,
      render: (e) => (
        <TeamCell
          teams={e.teams}
          options={teamOptions}
          onChange={(teams) => patchEngagement(e)({ teams })}
        />
      ),
    },
    {
      key: "service",
      label: "Service",
      width: VEN_COLS.service,
      render: (e) => (
        <InlineText
          value={e.service ?? ""}
          placeholder="—"
          onCommit={(t) => patchEngagement(e)({ service: t.trim() || null })}
        />
      ),
    },
    {
      key: "amount",
      label: "Amount",
      width: VEN_COLS.amount,
      render: (e) => (
        <AmountCell
          value={e.amountUsd}
          onCommit={(amountUsd) => patchEngagement(e)({ amountUsd })}
        />
      ),
    },
    {
      key: "payment",
      label: "Payment",
      width: VEN_COLS.payment,
      render: (e) => (
        <PaymentCell
          payment={e.paymentStatus ?? "unpaid"}
          onChange={(paymentStatus) => patchEngagement(e)({ paymentStatus })}
        />
      ),
    },
    {
      key: "status",
      label: "Status",
      width: VEN_COLS.status,
      render: (e) => (
        <StatusCell
          status={e.status}
          onChange={(status) => patchEngagement(e)({ status })}
        />
      ),
    },
    {
      key: "type",
      label: "Type",
      width: VEN_COLS.type,
      render: (e) => (
        <RowAction
          label="Make volunteer →"
          onPress={() => patchEngagement(e)({ type: "volunteer" })}
        />
      ),
    },
  ];

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
        <EngagementTable
          rows={sortedVolunteers}
          columns={volunteerColumns}
          addLabel="Add volunteer"
          emptyLabel="No volunteers yet — use Add volunteer."
          onAdd={() => setPicker("volunteer")}
          onRemove={(e) =>
            void remove({ engagementId: e._id as Id<"engagements"> })
          }
          confirmRemove={confirmRemove}
          sort={sort}
          onSort={onSort}
        />
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
          <EngagementTable
            rows={vendors}
            columns={vendorColumns}
            addLabel="Add vendor"
            emptyLabel="No paid vendors yet — use Add vendor."
            onAdd={() => setPicker("paid")}
            onRemove={(e) =>
              void remove({ engagementId: e._id as Id<"engagements"> })
            }
            confirmRemove={confirmRemove}
          />
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

      {/* Replace-placeholder picker: non-placeholder people only (+ add-new).
          Works in sandboxes too — the server scopes the roster to the learner
          + sample people (not placeholders), so the swap quest's bench passes
          this filter while the sandbox's own placeholder slots don't. */}
      <PersonPicker
        visible={replacingId !== null}
        title="Replace with person"
        filter={(p: Doc<"people">) => p.isPlaceholder !== true}
        onPick={(id) => void onPickReplacement(id)}
        onCreate={(name) => void onCreateReplacement(name)}
        onClose={() => setReplacingId(null)}
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
