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
import { useLocalSearchParams, useRouter } from "expo-router";
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
  PersonPicker,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { formatDate, parseList } from "../../../lib/format";
import { alertError } from "../../../lib/errors";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  type VettingStatus,
  type RosterStatus,
  personaOf,
  responsibilityAppliesTo,
  type Persona,
} from "@events-os/shared";
import { DutyRows } from "../../../components/work/DutyRows";
import { AddResponsibilityModal } from "../../../components/team/AddResponsibilityModal";
import { CourseBadgeChips } from "../../../components/academy/CourseBadgeChips";
import { DuplicatesSheet } from "../../../components/people/DuplicatesSheet";

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

// One "Givers" overlay mark (territories P5) — sourced from
// `givingPlatform.giverMarks`, keyed by `personId`. "Giver" is an OVERLAY on
// top of persona (Team/Volunteer/Vendor), never a persona of its own — a Team
// member can also be a giver. Absent entirely (empty map) for a caller with no
// giving access at this chapter, so the whole overlay quietly disappears
// rather than erroring.
//
// Owner privacy request: the roster NEVER shows a dollar amount — only a
// heart (giver) and, if `isBacker`, an additional building icon. Amounts
// live only in the giving desk, reached through `donorId`'s deep-link.
type GiverMark = {
  personId: Id<"people">;
  donorId: Id<"donors">;
  isBacker: boolean;
};

// The segmented filter adds an "all" sentinel on top of the shared Persona
// set, PLUS "contacts" (person-centric audiences Phase 1 item 1) — a
// deliberate, explicit way to see contact-only rows (auto-created from a
// donor gift, an import, or a public RSVP) that the default roster view
// (`api.people.list` with `contactsOnly` unset) now excludes. "Contacts" is
// NOT one of the shared `Persona` values: it's a UI-local view, not a
// backend-derived persona (a contact never has a team/volunteer/vendor
// signal — it's excluded from the roster entirely, not classified within it).
type PersonaFilter = Persona | "all" | "contacts";

const PERSONA_FILTERS: { key: PersonaFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "team", label: "Team" },
  { key: "volunteer", label: "Volunteers" },
  { key: "vendor", label: "Vendors" },
  { key: "contacts", label: "Contacts" },
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
  manager: 170,
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


/** Confirm a destructive action — window.confirm on web, no prompt on native. */
function confirmRemove(name: string): boolean {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.confirm(`Remove ${name || "this person"} from the roster?`);
  }
  return true;
}

/** PEOPLE roster — a spreadsheet-style editable grid with per-person history. */
export default function PeopleScreen() {
  // Roster (default `api.people.list` — excludes `isContactOnly` rows now,
  // person-centric audiences Phase 1) and contacts (the deliberate
  // `contactsOnly: true` view) are TWO separate queries, both kept live so
  // the segmented control's counts stay stable regardless of which tab is
  // active — see the "contacts" persona filter note above `PersonaFilter`.
  const roster = useQuery(api.people.list, {}) as Person[] | undefined;
  const contacts = useQuery(api.people.list, {
    contactsOnly: true,
  }) as Person[] | undefined;
  const org = useQuery(api.org.nav);
  const create = useMutation(api.people.create);
  // The Title column mirrors org-chart seat titles (the current model) —
  // `people.role` is only the fallback shown when someone holds no seat.
  const seatHoldings = useQuery(api.responsibilities.chapterSeatHoldings);

  const [search, setSearch] = useState("");
  const [skillFilter, setSkillFilter] = useState<string | null>(null);
  // Default to the core Team — the common case (a lead manages their team, not
  // the full roster of volunteers/vendors). "All" is one tap away.
  const [persona, setPersona] = useState<PersonaFilter>("team");
  // Givers overlay toggle — independent of the persona segments (a Team member
  // can also be a giver), so it composes with whichever persona is selected.
  const [giversOnly, setGiversOnly] = useState(false);

  // The grid's data source: the roster for every persona except the
  // deliberate "Contacts" tab, which shows the separate contacts-only query.
  const people = persona === "contacts" ? contacts : roster;

  // Givers overlay (territories P5). Every roster row shares one `chapterId`
  // (the roster query is already hard-scoped to the caller's own chapter), so
  // the first row's is the current chapter — skip the query until the roster
  // has loaded at least one row. Sourced from `roster` (not `people`) so it
  // stays available even while the Contacts tab is active. Returns `[]` for a
  // caller with no giving access at this chapter (quiet degrade, never a
  // throw — see `givingPlatform.giverMarks`), so the overlay simply doesn't
  // render below.
  const chapterId = roster && roster.length > 0 ? roster[0].chapterId : undefined;
  const giverMarks = useQuery(
    api.givingPlatform.giverMarks,
    chapterId ? { chapterId } : "skip",
  ) as GiverMark[] | undefined;
  const giverMarksByPerson = useMemo(() => {
    const map = new Map<Id<"people">, GiverMark>();
    for (const m of giverMarks ?? []) map.set(m.personId, m);
    return map;
  }, [giverMarks]);
  const hasGiverOverlay = giverMarksByPerson.size > 0;
  // Cross-tab deep link (giving CRM v2's Donors grid "Linked person" column —
  // `router.navigate(\`/people?openId=\${personId}\`)`): opens straight to that
  // person's detail sheet, the same modal a row tap opens locally. Read once
  // as the initial state (mirrors `finances/reconcile.tsx`'s own `?filter=`/
  // `?scope=` query-param precedent) — a param for a person outside the
  // caller's own chapter roster (or no longer on it) simply finds no match
  // below and the modal never opens (quiet degrade).
  const openParam = useLocalSearchParams<{ openId?: string }>();
  const [openId, setOpenId] = useState<string | null>(openParam.openId ?? null);
  // Admin-only duplicate review + merge (Attendance C).
  const [dupOpen, setDupOpen] = useState(false);

  // Manager names by id — one map instead of a per-row roster scan. Sourced
  // from `roster` (not `people`): a contact-only row is never anyone's
  // manager, and this must stay resolvable while the Contacts tab is active.
  const nameById = useMemo(
    () => new Map((roster ?? []).map((p) => [p._id, p.name])),
    [roster],
  );

  // Seat titles held, by person — the Title column's read-only mirror.
  const seatTitlesByPerson = useMemo(() => {
    const map = new Map<Id<"people">, string[]>();
    for (const h of seatHoldings ?? []) {
      map.set(h.personId, [...(map.get(h.personId) ?? []), h.seatTitle]);
    }
    return map;
  }, [seatHoldings]);

  // Per-persona counts for the segmented control, so the filtering model is
  // legible at a glance (Team 12 · Volunteers 30 · Vendors 5 · Contacts 4)
  // rather than a blind default. "all" is the full roster (still excluding
  // contacts — see `PersonaFilter`'s doc). Sourced from `roster`/`contacts`
  // directly (not `people`) so the counts never flicker between tabs.
  const personaCounts = useMemo(() => {
    const counts: Record<PersonaFilter, number> = {
      all: (roster ?? []).length,
      team: 0,
      volunteer: 0,
      vendor: 0,
      contacts: (contacts ?? []).length,
    };
    for (const p of roster ?? []) counts[personaOf(p)] += 1;
    return counts;
  }, [roster, contacts]);

  // Distinct skills across the roster, for the filter bar. Roster-only —
  // contact rows never carry `services`.
  const allSkills = useMemo(() => {
    const set = new Set<string>();
    for (const p of roster ?? []) {
      for (const s of p.services ?? []) set.add(s);
    }
    return Array.from(set).sort();
  }, [roster]);

  // Memoized so a re-render (e.g. typing in another field) doesn't re-scan the
  // whole roster — only persona / skill / search changes recompute the rows.
  // `persona === "contacts"` skips the `personaOf` check: `people` is already
  // the contacts-only query result in that case, not a slice to filter again.
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (people ?? []).filter((p) => {
      if (persona !== "all" && persona !== "contacts" && personaOf(p) !== persona)
        return false;
      if (giversOnly && !giverMarksByPerson.has(p._id)) return false;
      if (skillFilter && !(p.services ?? []).includes(skillFilter))
        return false;
      if (query && !p.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [people, persona, giversOnly, giverMarksByPerson, skillFilter, search]);

  if (people === undefined) return <Screen loading />;

  // Cross-tab deep link (see `openParam` above) can point at a CONTACT — e.g.
  // the giving CRM's donor "Linked person" column, since a donor-linked row is
  // now `isContactOnly` (person-centric audiences Phase 1). Search BOTH
  // `roster` and `contacts`, never just the currently active `people` view, so
  // the link still opens regardless of which persona tab happens to be active.
  const openPerson = openId
    ? ((roster ?? []).find((p) => p._id === openId) ??
        (contacts ?? []).find((p) => p._id === openId) ??
        null)
    : null;

  async function handleAddRow() {
    await create({ name: "New person" });
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
      {/* Title row */}
      <View style={styles.titleRow}>
        <Text className="font-display text-2xl text-ink">People</Text>
        <View className="flex-row items-center gap-3">
          {/* Duplicate review is chapter-admin only (merging re-points every
              reference across the app; enforced server-side too). */}
          {org?.isAdmin === true && chapterId ? (
            <Pressable
              onPress={() => setDupOpen(true)}
              hitSlop={6}
              accessibilityLabel="Review duplicate people"
              className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="copy" size={13} color={colors.muted} />
              <Text className="text-xs font-semibold text-muted">Duplicates</Text>
            </Pressable>
          ) : null}
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {persona === "contacts" ? "Contacts" : "Roster"} ({people.length})
          </Text>
        </View>
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
                <Text className={active ? "text-muted" : "text-faint"}>
                  {"  "}
                  {personaCounts[f.key]}
                </Text>
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Givers overlay chip (territories P5) — absent entirely when the
          caller has no giving access at this chapter (`giverMarks` returns
          `[]`), so the People tab renders exactly as before for everyone
          else. An OVERLAY, not a persona: composes with whichever segment is
          selected above. */}
      {hasGiverOverlay ? (
        <View style={styles.filterBar}>
          <Pill
            label={`Givers  ${giverMarksByPerson.size}`}
            selected={giversOnly}
            onPress={() => setGiversOnly((v) => !v)}
          />
        </View>
      ) : null}

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
              <GridHeaderCell label="Title" width={COLS.role} />
              <GridHeaderCell label="Email" width={COLS.email} />
              <GridHeaderCell label="PW Email" width={COLS.pwEmail} />
              <GridHeaderCell label="Phone" width={COLS.phone} />
              <GridHeaderCell label="Gender" width={COLS.gender} />
              <GridHeaderCell label="Services" width={COLS.skills} />
              <GridHeaderCell label="Usual rate" width={COLS.rate} />
              <GridHeaderCell label="Vetting" width={COLS.vetting} />
              <GridHeaderCell label="Team" width={COLS.team} />
              <GridHeaderCell label="Manager" width={COLS.manager} />
              <GridHeaderCell label="POC" width={COLS.poc} />
              <GridHeaderCell label="Involvements" width={COLS.projects} />
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
                {persona !== "all" && personaCounts.all > 0 ? (
                  <Pressable
                    onPress={() => setPersona("all")}
                    className="mt-2 self-start active:opacity-70"
                  >
                    <Text className="text-sm font-semibold text-accent">
                      View all {personaCounts.all} people
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              filtered.map((p, i) => (
                <PersonRow
                  key={p._id}
                  person={p}
                  managerName={
                    p.managerId ? nameById.get(p.managerId) ?? null : null
                  }
                  canEditManager={org?.isAdmin === true}
                  seatTitles={seatTitlesByPerson.get(p._id) ?? []}
                  giverMark={giverMarksByPerson.get(p._id) ?? null}
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

      <PersonDetail
        person={openPerson}
        giverMark={openPerson ? giverMarksByPerson.get(openPerson._id) ?? null : null}
        onClose={() => setOpenId(null)}
      />

      {chapterId ? (
        <DuplicatesSheet
          chapterId={chapterId}
          visible={dupOpen}
          onClose={() => setDupOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/** A single roster row of fixed-width inline-editable cells + a delete gutter. */
function PersonRow({
  person,
  managerName,
  canEditManager,
  seatTitles,
  giverMark,
  isLast,
  onOpen,
}: {
  person: Person;
  managerName: string | null;
  /** Rewiring the org tree is admin-only (enforced server-side too). */
  canEditManager: boolean;
  /** Org-chart seat titles this person holds — the Title column's mirror.
   *  Empty when they hold no seat (falls back to the legacy `person.role`
   *  string, shown muted). */
  seatTitles: string[];
  /** Territories P5 "Givers" overlay mark, or null when this person hasn't
   *  given (or the caller has no giving access — the whole overlay is absent
   *  in that case, upstream). */
  giverMark: GiverMark | null;
  isLast: boolean;
  onOpen: () => void;
}) {
  const update = useMutation(api.people.update);
  const remove = useMutation(api.people.remove);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const [managerPickerOpen, setManagerPickerOpen] = useState(false);
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
        {/* Linked to a user account — they can sign in. Distinguishes a real
            logged-in team member from a roster-only contact. */}
        {person.userId ? (
          <Icon name="user-check" size={14} color={colors.success} />
        ) : null}
        {/* Giver overlay badge (territories P5) — a heart marks a giver, an
            additional building icon marks a backer, NOT a persona: a Team
            member/Volunteer/Vendor can also be a giver. Owner privacy
            request: icons only, never a dollar amount — that lives in the
            giving desk (tap through the detail sheet). */}
        {giverMark ? (
          <View
            className="flex-row items-center gap-0.5"
            accessibilityLabel={
              giverMark.isBacker ? "Giver · Backer" : "Giver"
            }
          >
            <Icon name="heart" size={11} color={colors.danger} />
            {giverMark.isBacker ? (
              <Icon name="building" size={11} color={colors.info} />
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Status (roster lifecycle select) */}
      <Cell width={COLS.status}>
        <SelectCell
          value={status}
          options={STATUS_OPTIONS}
          onChange={(v) => update({ personId: id, status: v })}
        />
      </Cell>

      {/* Title: read-only mirror of held org-chart seats (the current model —
          see the file doc comment). No editor here anymore; assignment
          happens on the Org Chart. Falls back to the legacy `person.role`
          free-text string, visibly muted, only while this person holds no
          seat. */}
      <Cell width={COLS.role}>
        <TitleCell seatTitles={seatTitles} legacyRole={person.role ?? null} />
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
          skills={person.services ?? []}
          onCommit={(next) => update({ personId: id, services: next })}
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

      {/* Manager (roster person this one reports to — powers the Team view).
          Read-only unless the caller is a chapter admin. */}
      <Cell width={COLS.manager}>
        <Pressable
          onPress={canEditManager ? () => setManagerPickerOpen(true) : undefined}
          disabled={!canEditManager}
          className={`flex-1 flex-row items-center px-2 py-1.5 ${
            canEditManager ? "active:opacity-70 web:hover:opacity-90" : ""
          }`}
        >
          {managerName ? (
            <Text className="text-sm text-ink" numberOfLines={1}>
              {managerName}
            </Text>
          ) : (
            <Text className="text-sm text-faint">{canEditManager ? "—" : ""}</Text>
          )}
        </Pressable>
        {canEditManager ? (
          <PersonPicker
            visible={managerPickerOpen}
            title="Set manager"
            selectedId={person.managerId ?? null}
            source="team"
            filter={(p) => p._id !== person._id}
            onPick={async (managerId) => {
              setManagerPickerOpen(false);
              try {
                await update({ personId: id, managerId: managerId as Id<"people"> });
              } catch (err) {
                // Surface the server's reason (cycle, forbidden, …) verbatim.
                alertError(err);
              }
            }}
            onClear={() => {
              update({ personId: id, managerId: null });
              setManagerPickerOpen(false);
            }}
            onClose={() => setManagerPickerOpen(false)}
          />
        ) : null}
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

/**
 * Title column body: the person's held org-chart seat titles (comma-joined),
 * or — while they hold none — their legacy `person.role` free-text string,
 * muted so it reads as a fallback, not the source of truth. The whole cell is
 * a link to the Org Chart (the ONLY place roles/titles are assigned now); the
 * small external-link glyph is the "roles come from the Org Chart" hint,
 * kept to one line so the row height matches every other single-line cell in
 * this grid. NOTE: `/org-chart` is this PR's best guess at the seats org-chart
 * UI's route — the parallel org-chart PR hadn't landed a route on this
 * branch yet; confirm/adjust the path when that PR merges.
 */
function TitleCell({
  seatTitles,
  legacyRole,
}: {
  seatTitles: string[];
  legacyRole: string | null;
}) {
  const router = useRouter();
  const hasSeats = seatTitles.length > 0;
  const label = hasSeats ? seatTitles.join(", ") : legacyRole;
  return (
    <Pressable
      onPress={() => router.push("/org-chart" as any)}
      hitSlop={4}
      accessibilityLabel="Roles come from the Org Chart"
      className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      <Text
        className={`flex-1 text-sm ${hasSeats ? "text-ink" : "italic text-faint"}`}
        numberOfLines={1}
      >
        {label || "Set on Org Chart"}
      </Text>
      <Icon name="external-link" size={11} color={colors.faint} />
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
  giverMark,
  onClose,
}: {
  person: Person | null;
  giverMark: GiverMark | null;
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
          {person ? (
            <PersonDetailBody
              person={person}
              giverMark={giverMark}
              onClose={onClose}
            />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PersonDetailBody({
  person,
  giverMark,
  onClose,
}: {
  person: Person;
  giverMark: GiverMark | null;
  onClose: () => void;
}) {
  const history = useQuery(api.engagements.historyForPerson, {
    personId: person._id as any,
  });
  // Duties are shown only to callers who can act on them (managers/admins) —
  // for anyone else `responsibilities.list` returns just the CALLER's own
  // duties, which would render a misleadingly empty section for this person.
  const nav = useQuery(api.org.nav);
  const canManage = nav?.canManage === true;
  const duties = useQuery(api.responsibilities.list, canManage ? {} : "skip");
  // Seat holdings, for resolving `responsibilityAppliesTo`'s seat-based match
  // and DutyRows' "via {seat}" provenance — same gate as `duties` above.
  const seatHoldings = useQuery(
    api.responsibilities.chapterSeatHoldings,
    canManage ? {} : "skip",
  );
  const personSeatIds = useMemo(
    () =>
      (seatHoldings ?? [])
        .filter((h) => h.personId === person._id)
        .map((h) => h.seatDefId),
    [seatHoldings, person._id],
  );
  const seatTitleById = useMemo(
    () => new Map((seatHoldings ?? []).map((h) => [h.seatDefId, h.seatTitle])),
    [seatHoldings],
  );
  // Read-only mirror of this person's specialized (leadership/finance) roles.
  // Super-admin gated on the backend — skip the query for anyone else, and mirror
  // the same gate on the chapter-name lookup used to label chapter-scoped roles.
  const me = useQuery(api.profiles.me);
  const isSuperuser = me?.isSuperuser === true;
  const specializedRoles = useQuery(
    api.specializedRoles.personSpecializedRoles,
    isSuperuser ? { personId: person._id as Id<"people"> } : "skip",
  );
  const chaptersForRoles = useQuery(
    api.profiles.listChapters,
    isSuperuser ? {} : "skip",
  );
  const [addDutyOpen, setAddDutyOpen] = useState(false);
  const personDuties = (duties ?? []).filter((r) =>
    responsibilityAppliesTo(r, {
      _id: person._id,
      role: person.role ?? null,
      seatIds: personSeatIds,
    }),
  );
  const router = useRouter();
  // Person-centric audiences Phase 2 (specs/person-centric-audiences.md Phase
  // 2 item 3) — the person-level marketing opt-out. Gated exactly like every
  // other field in this sheet/grid (`api.people.update`'s own chapter-
  // membership check; this app doesn't gate ordinary roster contact edits
  // beyond that — see `people.ts`'s module doc). The full preference center
  // (known addresses, per-list subscriptions) is a later phase; this is
  // deliberately just the one toggle.
  const updateMarketingPref = useMutation(api.people.update);
  const marketingOptOut = person.marketingOptOut === true;

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

        {/* Marketing preference (person-centric audiences Phase 2) — layered
            OVER the address-level unsubscribe/bounce ledger, which stays
            authoritative and untouched; this only ever excludes THIS person
            from campaign sends (never transactional email). */}
        <View className="mb-4">
          <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
            Marketing
          </Text>
          <Pressable
            onPress={() =>
              updateMarketingPref({ personId: person._id, marketingOptOut: !marketingOptOut })
            }
            accessibilityRole="switch"
            accessibilityState={{ checked: !marketingOptOut }}
            accessibilityLabel="Marketing emails"
            className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3 active:opacity-70"
          >
            <View className="flex-row items-center gap-2">
              <Icon name="mail" size={14} color={colors.muted} />
              <Text className="text-sm text-ink">Marketing emails</Text>
            </View>
            <Badge
              label={marketingOptOut ? "Off" : "On"}
              tone={marketingOptOut ? "neutral" : "accent"}
            />
          </Pressable>
        </View>

        {/* Giving (territories P5) — a heart/building mark linking to the
            donor record, shown only when this person is a marked giver
            (absent for everyone else, and absent entirely for a caller with
            no giving access — `giverMark` is null in both cases). Owner
            privacy request: NO dollar amount on the roster — tap through to
            the giving desk for that. */}
        {giverMark ? (
          <View className="mb-4">
            <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
              Giving
            </Text>
            <Pressable
              onPress={() => {
                onClose();
                router.push(`/giving/donor/${giverMark.donorId}` as never);
              }}
              accessibilityLabel={
                giverMark.isBacker ? "Giver · Backer" : "Giver"
              }
              className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3 active:opacity-70"
            >
              <View className="flex-row items-center gap-2">
                <Icon name="heart" size={14} color={colors.danger} />
                {giverMark.isBacker ? (
                  <Icon name="building" size={14} color={colors.info} />
                ) : null}
                <Text className="text-sm text-ink">
                  {giverMark.isBacker ? "Giver · Backer" : "Giver"}
                </Text>
              </View>
              <Icon name="chevron-right" size={14} color={colors.muted} />
            </Pressable>
          </View>
        ) : null}

        {/* Earned Academy course badges (display-only; hidden when none). */}
        <CourseBadgeChips personId={person._id} />

        {/* Duties (managers/admins): the per-person assignment surface the
            founder's review asked for — see, add, and unassign right here. */}
        {canManage ? (
          <>
            <View className="mb-2 flex-row items-center justify-between">
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                Duties
              </Text>
              {/* Held back until the catalog is loaded: the modal's duplicate-
                  title guard scans the definitions, so an empty loading list
                  would let "Create" duplicate an existing duty. */}
              {duties !== undefined ? (
                <Pressable
                  onPress={() => setAddDutyOpen(true)}
                  hitSlop={6}
                  accessibilityLabel={`Add duty for ${person.name}`}
                  className="flex-row items-center gap-1 rounded p-1 active:bg-sunken web:hover:bg-sunken"
                >
                  <Icon name="plus" size={13} color={colors.accent} />
                  <Text className="text-xs font-medium text-accent">
                    Add duty
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {duties === undefined ? (
              <Text style={styles.historyEmpty}>Loading duties…</Text>
            ) : personDuties.length === 0 ? (
              <Text style={styles.historyEmpty}>
                No recurring duties yet.
              </Text>
            ) : (
              <View className="mb-4">
                <DutyRows
                  items={personDuties}
                  person={{
                    _id: person._id,
                    role: person.role ?? null,
                    seatIds: personSeatIds,
                  }}
                  seatTitleById={seatTitleById}
                  canUnassign
                  // This surface lives in a Modal — close it before pushing
                  // the How-To doc route, or the page opens underneath it.
                  onBeforeNavigate={onClose}
                />
              </View>
            )}
          </>
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

        {/* Governance roles (super-admin only): a read-only mirror of this
            person's specialized leadership/finance roles. Assignment happens
            from the Org Chart (`/org-chart`) — this section only reflects
            the current state. */}
        {isSuperuser &&
        specializedRoles !== undefined &&
        specializedRoles.length > 0 ? (
          <View className="mt-4">
            <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
              Roles
            </Text>
            <View className="gap-2">
              {specializedRoles.map((r) => {
                const scopeName =
                  r.scope === "central"
                    ? "Central (org)"
                    : (chaptersForRoles ?? []).find((c) => c._id === r.scope)
                        ?.name ?? "Chapter";
                return (
                  <View
                    key={r.id}
                    className="flex-row items-center gap-2"
                  >
                    <Badge
                      label={r.label}
                      tone={r.roleKind === "finance" ? "accent" : "lavender"}
                    />
                    <Text className="text-sm text-muted">{scopeName}</Text>
                  </View>
                );
              })}
            </View>
            <Text className="mt-2 text-xs text-faint">
              Manage these from the Org Chart.
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {addDutyOpen ? (
        <AddResponsibilityModal
          person={{
            _id: person._id,
            name: person.name,
            role: person.role ?? null,
          }}
          responsibilities={duties ?? []}
          onClose={() => setAddDutyOpen(false)}
        />
      ) : null}
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
