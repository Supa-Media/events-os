import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  Linking,
  Platform,
  TextInput,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  Badge,
  Checkbox,
  TextField,
  EmptyState,
  Avatar,
  Icon,
  OptionTag,
  InlineText,
  GridHeaderCell,
  SortableHeaderCell,
  SelectCell,
  type SelectOption,
  PersonPicker,
  Button,
  ServiceOptionsPicker,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { formatDate, parseList } from "../../../lib/format";
import { alertError } from "../../../lib/errors";
import { buildServiceLabelMap } from "../../../lib/serviceCatalog";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  type VettingStatus,
  type RosterStatus,
  responsibilityAppliesTo,
  composeName,
  firstNameForDesignatedLast,
  type Persona,
} from "@events-os/shared";
import { DutyRows } from "../../../components/work/DutyRows";
import { AddResponsibilityModal } from "../../../components/team/AddResponsibilityModal";
import { CourseBadgeChips } from "../../../components/academy/CourseBadgeChips";
import { DuplicatesSheet } from "../../../components/people/DuplicatesSheet";
import {
  PersonaRail,
  ServicesDropdown,
  MoreFiltersDropdown,
  ActiveFilterPills,
  type PersonaFilter,
  type ActiveFilterChip,
} from "../../../components/people/PeopleFilters";

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
/** Plain label lookup for `STATUS_OPTIONS` — the "More" filter dropdown and
 *  its active-filter pill need just the string, not the full select-option
 *  shape (color/value) the row editor cell uses. */
const STATUS_LABEL: Record<RosterStatus, string> = Object.fromEntries(
  STATUS_OPTIONS.map((o) => [o.value, o.label]),
) as Record<RosterStatus, string>;

// Guest history (People-CRM UX) status badge — mirrors `RSVP_STATUSES`
// (`schema/ticketing.ts`).
const RSVP_STATUS_LABEL: Record<string, string> = {
  going: "Going",
  maybe: "Maybe",
  not_going: "Not going",
};
const RSVP_STATUS_TONE: Record<string, "success" | "warn" | "neutral"> = {
  going: "success",
  maybe: "warn",
  not_going: "neutral",
};

// A roster row is the `people` document plus the `imageUrl` the list query
// resolves from the stored storageId, and the `persona` the backend derives
// per-row (`@events-os/shared#Persona`: team > vendor > volunteer > guest >
// contact — participation-aware, so it requires the DB reads `people.list`
// batches via `resolvePersonaForRoster`). Never re-derive persona
// client-side here: the client only has the row's own fields, not the
// participation signals (engagements/roleAssignments/rsvps) that distinguish
// a genuine volunteer/guest from a contact.
// `persona` is OMITTED from the Doc before being re-added: the schema types it
// `Persona | undefined`, so intersecting rather than overriding collapsed the
// intended `| null` back to `Persona` and made the "persona not computed here"
// sentinel (`openPersonFallback` below, whose query doesn't resolve the ladder)
// unassignable to the very type it feeds.
type Person = Omit<Doc<"people">, "persona"> & {
  imageUrl?: string | null;
  persona?: Persona | null;
};

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

// Fixed column widths (px) — mirrors EditableGrid's chrome so columns stay put
// while the table scrolls horizontally on web.
const COLS = {
  // First/Last (founder ask, 2026-07-25): the roster shows the structured
  // halves as two editable columns. `first` also carries the avatar and the
  // identity badges, and — for a row whose name couldn't be auto-split —
  // falls back to showing the full display name (editing it renames, which
  // re-splits when the new name is unambiguous; a truly ambiguous name is
  // hand-split in the detail sheet's Name section).
  first: 170,
  last: 130,
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
// People-CRM UX: the leftmost multi-select checkbox column.
const SELECT_W = 36;
const TABLE_WIDTH =
  Object.values(COLS).reduce((sum, w) => sum + w, 0) + DELETE_W + SELECT_W;

/** Cap on how many selected people the "Email selected" bridge will hand off
 *  to a new audience draft — a human-curated hand-pick list (same rationale
 *  as `audiences.ts#HAND_PICK_LOOKUP_LIMIT`, which allows far more; this is a
 *  tighter, UX-sane bound for a single grid selection, not the ceiling the
 *  backend enforces). */
const EMAIL_SELECTED_CAP = 200;

/** Search debounce (owner addendum precedent —
 *  `components/finance/reconcile/ReconcileList.tsx#SEARCH_DEBOUNCE_MS`): a
 *  round trip per keystroke is wasteful now that search is server-side. */
const SEARCH_DEBOUNCE_MS = 200;

/** How many rows `usePaginatedQuery` loads per page — big enough that most
 *  chapters never see a "Load more" tap, small enough that a heavily
 *  filtered/searched page still resolves in one indexed round trip. */
const PAGE_SIZE = 50;

/** Confirm a destructive action — window.confirm on web, no prompt on native. */
function confirmRemove(name: string): boolean {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.confirm(`Remove ${name || "this person"} from the roster?`);
  }
  return true;
}

/** PEOPLE roster — a spreadsheet-style editable grid with per-person history. */
export default function PeopleScreen() {
  const org = useQuery(api.org.nav);
  const create = useMutation(api.people.create);
  // The Title column mirrors org-chart seat titles (the current model) —
  // `people.role` is only the fallback shown when someone holds no seat.
  const seatHoldings = useQuery(api.responsibilities.chapterSeatHoldings);

  // ── Filter/sort state — every one of these is now a `listPaginated` ARG,
  // not a client-side filter. Search is debounced (below) so a keystroke
  // doesn't fire a fresh server round trip. ─────────────────────────────────
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const [serviceIds, setServiceIds] = useState<Id<"serviceOptions">[]>([]);
  // Default to the core Team — the common case (a lead manages their team, not
  // the full roster of volunteers/vendors). "All" is one tap away.
  const [persona, setPersona] = useState<PersonaFilter>("team");
  const [status, setStatus] = useState<RosterStatus | null>(null);
  // Givers overlay toggle — independent of persona (a Team member can also be
  // a giver), so it composes with whichever persona is selected.
  const [giversOnly, setGiversOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"name" | "lastName" | "status">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(column: "name" | "lastName" | "status") {
    if (sortBy === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir("asc");
    }
  }

  // The People tab's grid data — server-side search/filter/sort, paginated
  // (People-CRM overhaul, 2026-07-27). Replaces the old
  // `people.list({persona:"all"})` full-roster load.
  const {
    results,
    status: pageStatus,
    isLoading: pageLoading,
    loadMore,
  } = usePaginatedQuery(
    api.people.listPaginated,
    {
      search: debouncedSearch.trim() || undefined,
      persona: persona === "all" ? undefined : persona,
      serviceIds: serviceIds.length > 0 ? serviceIds : undefined,
      status: status ?? undefined,
      giversOnly: giversOnly || undefined,
      sortBy,
      sortDir,
    },
    { initialNumItems: PAGE_SIZE },
  );
  const people = results as Person[];

  // Persona-ladder counts (All / Team / Volunteers / Vendors / Guests /
  // Contacts) — a dedicated cheap query (`people.counts`), never derived from
  // `people` above (which is only ever ONE PAGE now).
  const personaCounts = useQuery(api.people.counts, {});

  // Givers overlay (territories P5). Every roster row shares one `chapterId`
  // (the query is already hard-scoped to the caller's own chapter), so the
  // first loaded row's is the current chapter — skip until at least one row
  // has loaded. Returns `[]` for a caller with no giving access at this
  // chapter (quiet degrade, never a throw — see `givingPlatform.giverMarks`),
  // so the overlay simply doesn't render below.
  const chapterId = people.length > 0 ? people[0].chapterId : undefined;
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
  const router = useRouter();
  // Admin-only duplicate review + merge (Attendance C).
  const [dupOpen, setDupOpen] = useState(false);
  // Full-database export entry point — its own power (`data.export`), so the
  // button below stays hidden — not just disabled — for a caller who doesn't
  // hold it (never just a "this view" export like the giving grids' button).
  const exportAccess = useQuery(api.dataExports.myExportAccess);

  // The deep-linked person may not be on the currently loaded page (or on
  // ANY loaded page — pagination no longer holds the whole roster). Falls
  // back to a direct, bounded single-person lookup (`people.get`, "skip"ped
  // once the id is already found on the page) rather than growing the page
  // size to guarantee it's present.
  const openPersonOnPage = openId ? people.find((p) => p._id === openId) ?? null : null;
  const openPersonFallback = useQuery(
    api.people.get,
    openId && !openPersonOnPage ? { personId: openId as Id<"people"> } : "skip",
  );

  // People-CRM UX: multi-select + "Email selected" bridge to a new segment
  // draft. Local state only — nothing persists server-side, mirrors every
  // other grid's own local-only sort/filter state. Gated on `canCompose`,
  // not `canView`: the bridge lands in the segment CREATE form, and
  // `audiences.createAudience` is behind `requireCampaignCompose` — a
  // design-only holder following this link would reach a screen with no
  // editor on it. Hidden entirely rather than shown-then-denied.
  const [selected, setSelected] = useState<Set<Id<"people">>>(new Set());
  const campaignsAccess = useQuery(api.audiences.myCampaignsAccess, {});
  const canEmailSelected = campaignsAccess?.canCompose === true;

  // Manager names by id — a lightweight `{_id, name}` PROJECTION over the
  // whole chapter (`people.namesByChapter`), not the paginated `people`
  // array: a person's manager may live on a page that isn't currently
  // loaded, so resolving their name can't depend on what's on screen.
  const allNames = useQuery(api.people.namesByChapter, {});
  const nameById = useMemo(
    () => new Map((allNames ?? []).map((p) => [p._id, p.name])),
    [allNames],
  );

  // Seat titles held, by person — the Title column's read-only mirror.
  const seatTitlesByPerson = useMemo(() => {
    const map = new Map<Id<"people">, string[]>();
    for (const h of seatHoldings ?? []) {
      map.set(h.personId, [...(map.get(h.personId) ?? []), h.seatTitle]);
    }
    return map;
  }, [seatHoldings]);

  // Service Catalog labels, for the active-filter pills — the SAME
  // "Parent:Child" label `ServicesDropdown`/`SkillsCell` show, so every
  // surface agrees on what a service is called.
  const serviceCatalog = useQuery(api.serviceOptions.list, { includeInactive: true });
  const serviceLabelById = useMemo(
    () =>
      serviceCatalog ? buildServiceLabelMap(serviceCatalog) : new Map<Id<"serviceOptions">, string>(),
    [serviceCatalog],
  );

  // People-CRM UX selection: "select all visible" respects the currently
  // LOADED page(s) — selecting across a filter/search a user hasn't scrolled
  // to yet was never supported even before pagination (it acted on
  // `filtered`, the client-side-filtered view of the full roster).
  const allVisibleSelected =
    people.length > 0 && people.every((p) => selected.has(p._id));
  const selectedCount = selected.size;
  const overCap = selectedCount > EMAIL_SELECTED_CAP;

  function toggleSelectAllVisible() {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allVisibleSelected) {
        for (const p of people) next.delete(p._id);
      } else {
        for (const p of people) next.add(p._id);
      }
      return next;
    });
  }

  function toggleSelectOne(id: Id<"people">) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleEmailSelected() {
    if (selectedCount === 0 || overCap) return;
    router.push(
      `/campaigns/audiences?seedIncludeIds=${Array.from(selected).join(",")}` as never,
    );
  }

  // Active-filter pills (standard CRM pattern): one removable chip per
  // non-default filter, so "what's currently narrowing this list" is legible
  // at a glance instead of scattered across four controls.
  // Persona is deliberately NOT a chip here: the rail above already shows
  // which rung is selected, in the accent treatment every other selected
  // filter in the app uses. A chip as well would put persona on screen twice
  // — the duplication this redesign exists to remove. Services/status/givers
  // DO get chips: their controls are dropdowns that show nothing about the
  // current selection once closed.
  const filterChips: ActiveFilterChip[] = [];
  for (const sid of serviceIds) {
    filterChips.push({
      key: `service:${sid}`,
      label: serviceLabelById.get(sid) ?? "…",
      onRemove: () => setServiceIds((cur) => cur.filter((id) => id !== sid)),
    });
  }
  if (status) {
    filterChips.push({
      key: "status",
      label: STATUS_LABEL[status],
      onRemove: () => setStatus(null),
    });
  }
  if (giversOnly) {
    filterChips.push({ key: "givers", label: "Givers only", onRemove: () => setGiversOnly(false) });
  }
  function clearAllFilters() {
    setPersona("all");
    setServiceIds([]);
    setStatus(null);
    setGiversOnly(false);
  }

  if (pageStatus === "LoadingFirstPage" && people.length === 0) return <Screen loading />;

  // Cross-tab deep link (see `openParam`/`openPersonOnPage` above) can point
  // at a CONTACT — e.g. the giving CRM's donor "Linked person" column, since
  // a donor-linked row is still `isContactOnly` (provenance).
  const openPerson: Person | null =
    openPersonOnPage ?? (openPersonFallback ? { ...openPersonFallback, imageUrl: null, persona: null } : null);

  async function handleAddRow() {
    await create({ name: "New person" });
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
      {/* Header row 1 — what you're looking at, and what you can do to the
          roster as a whole. The persona rail rides HERE rather than on its
          own band: it's the page's primary navigation axis, it reads as a
          breakdown of the title beside it, and giving it a dedicated row was
          half of why this header ran to four stacked rows of chrome before
          the first person appeared. */}
      <View style={styles.titleRow}>
        {/* The min width is load-bearing, and it's sized to the WHOLE rail
            (~600px at production count widths — "All 555", "Contacts 224"),
            not to some smaller floor. The rail is the only flexible thing in
            this row, so without one a narrow window squeezes it to a sliver
            ("Al…") while the four fixed-width actions keep every pixel; with
            a floor that's merely generous, mid-size windows clip it partway
            through a pill, hard against "Import", with nothing to say it
            scrolls. Sized to the full rail plus `flexWrap` on the row, the
            outcome is binary and always legible: either all six rungs fit
            beside the title (two-row header), or this group takes a line of
            its own (three), and only a genuinely tiny window scrolls it. */}
        <View className="min-w-[600px] flex-1 flex-row items-center gap-4">
          <Text className="font-display text-2xl text-ink">People</Text>
          <View className="min-w-0 flex-1">
            <PersonaRail value={persona} counts={personaCounts} onChange={setPersona} />
          </View>
        </View>
        <View className="flex-row items-center gap-3">
          {/* Bulk contact onboarding lives HERE, on the People tab (founder
              call, 2026-07-25) — Giving → Import stays the home for
              money-bearing files only. */}
          <Pressable
            onPress={() => router.push("/people/import" as never)}
            hitSlop={6}
            accessibilityLabel="Import contacts"
            className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="upload" size={13} color={colors.muted} />
            <Text className="text-xs font-semibold text-muted">Import</Text>
          </Pressable>
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
          {/* Reserved for the sibling `feat/guest-identify` branch's
              triage surface (`/people/identify`) — that branch owns the
              screen AND the "N to identify" count; this is just the entry
              point so the two branches merge cleanly, per that PR's own
              coordination note. No count query exists on THIS branch yet. */}
          <Pressable
            onPress={() => router.push("/people/identify" as never)}
            hitSlop={6}
            accessibilityLabel="Identify guests"
            className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="user-check" size={13} color={colors.muted} />
            <Text className="text-xs font-semibold text-muted">Identify</Text>
          </Pressable>
          {exportAccess?.canExport === true ? (
            <Pressable
              onPress={() =>
                router.push(
                  (chapterId ? `/exports?scope=${chapterId}&dataset=people` : "/exports?dataset=people") as never,
                )
              }
              hitSlop={6}
              accessibilityLabel="Full data export"
              className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="database" size={13} color={colors.muted} />
              <Text className="text-xs font-semibold text-muted">Export</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Header row 2 — refinements ON that view: free text, plus the two
          multi-select dropdowns whose option lists are far too long to sit
          open on the page. Persona is NOT here any more; it had a dropdown
          on this row AND the counts row below AND a chip below that, three
          controls for one piece of state. Selections from these two land as
          removable pills below, because a closed dropdown shows nothing. */}
      <View className="mt-3 flex-row flex-wrap items-center gap-2">
        <View className="min-w-[220px] flex-1 flex-row items-center gap-2 rounded-md border border-border-strong bg-raised px-3 py-2">
          <Icon name="search" size={14} color={colors.faint} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name, email, phone…"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            className="flex-1 text-sm text-ink"
          />
          {search.length > 0 ? (
            <Pressable onPress={() => setSearch("")} hitSlop={6} accessibilityLabel="Clear search">
              <Icon name="x" size={14} color={colors.faint} />
            </Pressable>
          ) : null}
        </View>
        <ServicesDropdown selectedIds={serviceIds} onChange={setServiceIds} />
        <MoreFiltersDropdown
          status={status}
          onChangeStatus={setStatus}
          giversOnly={giversOnly}
          onChangeGiversOnly={setGiversOnly}
          showGivers={hasGiverOverlay}
        />
      </View>

      {/* Active-filter pills — one removable chip per non-default filter,
          "Clear all" to reset every one at once. Absent entirely when
          nothing is narrowing the list. */}
      {filterChips.length > 0 ? (
        <View className="mt-2">
          <ActiveFilterPills chips={filterChips} onClearAll={clearAllFilters} />
        </View>
      ) : null}

      {/* People-CRM UX: selection bar — appears only once at least one row is
          checked. "Email selected" is hidden for a caller who can't compose
          (`myCampaignsAccess.canCompose`, the same gate the Segments screen
          puts on its own editor) rather than shown-then-denied. */}
      {selectedCount > 0 ? (
        <View style={styles.selectionBar}>
          <Text className="text-sm font-semibold text-ink">
            {selectedCount} selected
          </Text>
          <Pressable onPress={() => setSelected(new Set())} className="active:opacity-70">
            <Text className="text-xs font-medium text-muted underline">Clear</Text>
          </Pressable>
          {canEmailSelected ? (
            <>
              <Pressable
                onPress={handleEmailSelected}
                disabled={overCap}
                hitSlop={4}
                accessibilityLabel="Email selected people"
                className={`flex-row items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 ${
                  overCap ? "opacity-50" : "active:bg-sunken web:hover:bg-sunken"
                }`}
              >
                <Icon name="mail" size={13} color={colors.accent} />
                <Text className="text-xs font-semibold text-accent">
                  Email selected
                </Text>
              </Pressable>
              {overCap ? (
                <Text className="text-xs text-danger">
                  Select {EMAIL_SELECTED_CAP} or fewer to email them at once.
                </Text>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
      </Narrow>

      {/* The grid */}
      <View className="overflow-hidden rounded-lg border border-border bg-raised">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ width: Math.max(TABLE_WIDTH, 320) }}>
            {/* Column header */}
            <View className="flex-row items-center border-b border-border bg-sunken">
              {/* People-CRM UX: select-all-visible checkbox. Cross-platform
                  (Pressable/View/Icon), so it renders — and works — on both
                  web and native, not just web. */}
              <View
                style={{ width: SELECT_W }}
                className="items-center justify-center border-r border-border/60 py-1.5"
              >
                <Checkbox
                  checked={allVisibleSelected}
                  onPress={toggleSelectAllVisible}
                  accessibilityLabel={
                    allVisibleSelected ? "Deselect all visible people" : "Select all visible people"
                  }
                />
              </View>
              {/* First/Last/Status sort server-side now (People-CRM overhaul)
                  — click to sort, click again to reverse, mirrors the Giving
                  desk's `SortableHeaderCell` exactly. */}
              <SortableHeaderCell
                label="First name"
                width={COLS.first}
                active={sortBy === "name"}
                direction={sortDir}
                onSort={() => toggleSort("name")}
              />
              <SortableHeaderCell
                label="Last name"
                width={COLS.last}
                active={sortBy === "lastName"}
                direction={sortDir}
                onSort={() => toggleSort("lastName")}
              />
              <SortableHeaderCell
                label="Status"
                width={COLS.status}
                active={sortBy === "status"}
                direction={sortDir}
                onSort={() => toggleSort("status")}
              />
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
            {people.length === 0 && personaCounts?.all === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No people yet — add your first below.
                </Text>
              </View>
            ) : people.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No one matches your filters.
                </Text>
                <Pressable
                  onPress={() => {
                    clearAllFilters();
                    setSearch("");
                  }}
                  className="mt-2 self-start active:opacity-70"
                >
                  <Text className="text-sm font-semibold text-accent">
                    Clear filters{personaCounts ? ` — view all ${personaCounts.all}` : ""}
                  </Text>
                </Pressable>
              </View>
            ) : (
              people.map((p, i) => (
                <PersonRow
                  key={p._id}
                  person={p}
                  managerName={
                    p.managerId ? nameById.get(p.managerId) ?? null : null
                  }
                  canEditManager={org?.isAdmin === true}
                  seatTitles={seatTitlesByPerson.get(p._id) ?? []}
                  giverMark={giverMarksByPerson.get(p._id) ?? null}
                  isLast={i === people.length - 1}
                  selected={selected.has(p._id)}
                  onToggleSelected={() => toggleSelectOne(p._id)}
                  onOpen={() => setOpenId(p._id)}
                />
              ))
            )}
          </View>
        </ScrollView>

        {/* Load more — server-side pagination (People-CRM overhaul); a plain
            "tap to load the next page" affordance rather than an
            auto-triggering scroll listener, simplest to get right inside a
            grid that already scrolls both directions. */}
        {pageStatus === "CanLoadMore" || pageStatus === "LoadingMore" ? (
          <Pressable
            onPress={() => loadMore(PAGE_SIZE)}
            disabled={pageLoading}
            className="flex-row items-center justify-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Text className="text-sm font-medium text-muted">
              {pageStatus === "LoadingMore" ? "Loading…" : `Load ${PAGE_SIZE} more`}
            </Text>
          </Pressable>
        ) : null}

        {/* Add row */}
        <Pressable
          onPress={handleAddRow}
          className="flex-row items-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">Add person</Text>
        </Pressable>
      </View>

      {people.length === 0 && personaCounts?.all === 0 ? (
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
  selected,
  onToggleSelected,
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
  /** People-CRM UX multi-select — local grid state, not persisted. */
  selected: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
}) {
  const update = useMutation(api.people.update);
  const remove = useMutation(api.people.remove);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const [managerPickerOpen, setManagerPickerOpen] = useState(false);
  const id = person._id as Id<"people">;

  const vetting = (person.vettingStatus ?? "unvetted") as VettingStatus;
  const status = (person.status ?? "active") as RosterStatus;
  // Structured halves exist → the First/Last cells edit them directly; absent
  // (the splitter refused this name) → the First cell shows/edits the full
  // display name instead. See the two cells' own comments below.
  const isSplit = person.firstName !== undefined || person.lastName !== undefined;

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
      {/* People-CRM UX: per-row selection checkbox. */}
      <View
        style={{ width: SELECT_W }}
        className="items-center justify-center border-r border-border/60"
      >
        <Checkbox
          checked={selected}
          onPress={onToggleSelected}
          accessibilityLabel={`Select ${person.name || "this person"}`}
        />
      </View>

      {/* First name: avatar (tap to upload photo) + inline text. A row whose
          name couldn't be auto-split (no halves) shows the FULL display name
          here — editing it renames the person (which re-splits when the new
          name is unambiguous); a split row edits just the first half, the
          other half preserved server-side (`people.update`'s one-at-a-time
          rule). */}
      <View
        style={{ width: COLS.first }}
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
          value={isSplit ? (person.firstName ?? "") : person.name}
          placeholder={isSplit ? "First" : "Name"}
          weight="medium"
          onCommit={(t) =>
            isSplit
              ? update({ personId: id, firstName: t.trim() || null })
              : update({ personId: id, name: t })
          }
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

      {/* Last name — always editable, including on a row whose name never
          split. It used to render a dead em-dash there and defer to
          `NameFieldsSection` in the detail sheet. That editor is real, but a
          bare dash advertises nothing: it isn't clickable, isn't focusable,
          and names no other place to go — so in the grid the column simply
          looked broken. (Compare `TitleCell`, which is read-only for a good
          reason and SAYS so: "Set on Org Chart", pressable, and it routes
          there.) Every other cell in this row keeps its em-dash INSIDE the
          Pressable that edits it; this one didn't. Committing a surname on an
          unsplit row derives the first half server-side rather than dropping
          it — see `people.update` → `firstNameForDesignatedLast`. */}
      <Cell width={COLS.last}>
        <InlineText
          value={person.lastName ?? ""}
          placeholder="Last"
          weight="medium"
          onCommit={(t) => update({ personId: id, lastName: t.trim() || null })}
        />
      </Cell>

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

      {/* Skills: Service Catalog multi-select (replaces the old free-text
          comma editor — see `SkillsCell`'s doc). */}
      <Cell width={COLS.skills}>
        <SkillsCell
          serviceIds={person.serviceIds ?? []}
          onCommit={(next) => update({ personId: id, serviceIds: next })}
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
        autoFocus
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

// ── Skills cell: Service Catalog multi-select ──────────────────────────────
// Tapping the chips area opens `ServiceOptionsPicker` (browse the managed
// catalog, add a new option inline, or jump to "Manage services…" to rename/
// deactivate/merge) — replaces the old free-text comma editor now that
// `people.update` takes `serviceIds` (catalog ids), not `services` (strings).
// Queries its own catalog copy for label resolution (Convex dedupes this
// against every other row's identical subscription; kept local rather than
// lifted to `PeopleScreen` state to keep this change scoped to the cell).
function SkillsCell({
  serviceIds,
  onCommit,
}: {
  serviceIds: Id<"serviceOptions">[];
  onCommit: (next: Id<"serviceOptions">[]) => void;
}) {
  const tree = useQuery(api.serviceOptions.list, { includeInactive: true });
  const labelById = useMemo(
    () => (tree ? buildServiceLabelMap(tree) : new Map<Id<"serviceOptions">, string>()),
    [tree],
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setPickerOpen(true)}
        className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
      >
        {serviceIds.length === 0 ? (
          <Text className="text-sm text-faint">—</Text>
        ) : (
          serviceIds.map((sid) => (
            <OptionTag key={sid} label={labelById.get(sid) ?? "…"} />
          ))
        )}
      </Pressable>
      <ServiceOptionsPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        mode="multi"
        selectedIds={serviceIds}
        onChange={onCommit}
        title="Services"
      />
    </>
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
        autoFocus
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
/** First/Last name editor inside the detail sheet. Local drafts + an explicit
 *  Save (only shown when dirty) — the sheet's toggle-style fields commit
 *  immediately, but text fields mid-typing shouldn't fire a mutation per
 *  keystroke. Saving sends ONLY the halves; the backend recomposes the
 *  display name and refuses a call that sends both (see `people.update`). */
function NameFieldsSection({ person }: { person: Person }) {
  const update = useMutation(api.people.update);
  const [first, setFirst] = useState(person.firstName ?? "");
  const [last, setLast] = useState(person.lastName ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = first !== (person.firstName ?? "") || last !== (person.lastName ?? "");

  // A person whose name never split stores NO halves, so BOTH fields open
  // empty even though `person.name` still holds the whole thing. Typing only a
  // surname and saving used to send `firstName: null` — an explicit clear,
  // which by design beats the server's own derivation — and shortened "Mary Jo
  // Van Der Berg" to "Van Der Berg". That is the same footgun the grid's Last
  // Name cell had; closing it there left it live one screen over.
  //
  // Deriving the other half here rather than sending a clear. It is the SAME
  // rule `people.update` applies (`@events-os/shared#names`, which is why that
  // rule lives in the shared package at all) — a second rule that disagreed
  // with the server would be worse than the original bug, since the preview
  // below promises exactly what will be stored.
  const unsplit = person.firstName === undefined && person.lastName === undefined;
  const derivedFirst =
    unsplit && !first.trim() && last.trim()
      ? firstNameForDesignatedLast(person.name, last.trim())
      : "";
  const effectiveFirst = first.trim() || derivedFirst;
  const composed = composeName(effectiveFirst, last.trim());

  async function save() {
    setSaving(true);
    try {
      await update({
        personId: person._id,
        firstName: effectiveFirst || null,
        lastName: last.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mb-4">
      <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
        Name
      </Text>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <TextField label="First" value={first} onChangeText={setFirst} placeholder="First" />
        </View>
        <View className="flex-1">
          <TextField label="Last" value={last} onChangeText={setLast} placeholder="Last" />
        </View>
      </View>
      {!person.firstName && !person.lastName && !dirty ? (
        <Text className="mt-1 text-xs text-faint">
          This name couldn't be split automatically — set the halves here.
        </Text>
      ) : null}
      {/* Say the derivation out loud. Leaving First visibly blank while the
          save quietly stores a value would be its own small betrayal, even
          though the value is the right one. */}
      {derivedFirst ? (
        <Text className="mt-1 text-xs text-faint">
          First will be kept as “{derivedFirst}” — the rest of the current name.
        </Text>
      ) : null}
      {dirty ? (
        <View className="mt-2 flex-row items-center gap-2">
          <Button
            title="Save name"
            size="sm"
            onPress={save}
            loading={saving}
            disabled={!composed}
          />
          <Text className="text-xs text-muted" numberOfLines={1}>
            {composed ? `Will show as "${composed}"` : "Enter at least one name."}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** A single free-text field with a "Save" affordance that only appears once
 *  dirty — the same local-state-then-commit shape `NameFieldsSection` above
 *  uses, generalized to one field so `location`/`referralSource` don't each
 *  need their own bespoke component. `onSave` receives the trimmed value
 *  (empty string means "clear it" — the caller maps that to `null`). */
function PersonTextFieldRow({
  label,
  placeholder,
  value,
  onSave,
}: {
  label: string;
  placeholder: string;
  value: string;
  onSave: (next: string) => Promise<unknown>;
}) {
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);
  const dirty = text.trim() !== value.trim();

  return (
    <View className="mb-2">
      <TextField label={label} value={text} onChangeText={setText} placeholder={placeholder} />
      {dirty ? (
        <View className="mt-1 flex-row items-center gap-2">
          <Button
            title="Save"
            size="sm"
            loading={saving}
            onPress={async () => {
              setSaving(true);
              try {
                await onSave(text.trim());
              } finally {
                setSaving(false);
              }
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

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
  // People-CRM UX: guest/RSVP attendance history — "attended/registered as a
  // guest," distinct from `history` above ("Event history" — worked/
  // volunteered a role). Same gate as `history` (`requireOwned`).
  const guestHistory = useQuery(api.ticketing.guestHistoryForPerson, {
    personId: person._id as Id<"people">,
  });
  // People-CRM UX: the `personEmails` ledger — every known address, with a
  // "Make primary" affordance wired to `setPrimaryEmail`. Gated identically
  // to that mutation (chapter membership via the linked person — no extra
  // seat/power check, same as every other edit in this sheet).
  const knownEmails = useQuery(api.personEmails.listForPerson, {
    personId: person._id as Id<"people">,
  });
  const setPrimaryEmail = useMutation(api.personEmails.setPrimaryEmail);
  // PW Forms consolidation — every Google Form response resolved to this
  // person (intake/interest forms; event-scoped anonymous surveys never
  // carry a personId, so they never appear here — see `formSubmissions.ts`).
  // Gated identically to everything else in this sheet (chapter membership
  // via the linked person — `lib/formsAccess.ts`).
  const formSubmissions = useQuery(api.formSubmissions.listForPerson, {
    personId: person._id as Id<"people">,
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
  // deliberately just the one toggle. Shared below by every contact/identity
  // field this panel edits (marketing opt-out, location, referral source,
  // volunteer signal) — one mutation instance, several call sites.
  const updatePerson = useMutation(api.people.update);
  const marketingOptOut = person.marketingOptOut === true;
  const isVolunteer = person.isVolunteer === true;

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
        {/* Structured name (founder ask, 2026-07-25) — the split halves
            migration 0043 backfilled, shown and EDITABLE here. Saving
            recomposes the display name ("First Last"); this is also where an
            ambiguous name the automatic splitter refused ("Mary Jo Van Der
            Berg") gets hand-corrected into real halves. */}
        <NameFieldsSection person={person} />

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

        {/* Details (person-form-fields widening, founder ask 2026-07-27) —
            the facts the 6 Google Form imports capture beyond bare identity.
            Location + referral source are hand-correctable here;
            `isVolunteer` is the explicit signal, toggleable like
            `isTeamMember` elsewhere in this app. Consent is DISPLAY-ONLY: it
            records an affirmative "yes" with a timestamp, so it's set by the
            import path only, never casually flipped by a staffer — see
            `schema/people.ts#consentedAt`'s doc for why it can never be used
            to make a suppressed address sendable. */}
        <View className="mb-4">
          <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
            Details
          </Text>
          <PersonTextFieldRow
            label="Location"
            placeholder="City, State"
            value={person.location ?? ""}
            onSave={(next) =>
              updatePerson({ personId: person._id, location: next || null })
            }
          />
          <PersonTextFieldRow
            label="How they heard about us"
            placeholder="Instagram, a friend, …"
            value={person.referralSource ?? ""}
            onSave={(next) =>
              updatePerson({ personId: person._id, referralSource: next || null })
            }
          />
          <Pressable
            onPress={() =>
              updatePerson({ personId: person._id, isVolunteer: !isVolunteer })
            }
            accessibilityRole="switch"
            accessibilityState={{ checked: isVolunteer }}
            accessibilityLabel="Marked as volunteer"
            className="mt-2 flex-row items-center justify-between rounded-lg border border-border bg-raised p-3 active:opacity-70"
          >
            <View className="flex-row items-center gap-2">
              <Icon name="check-circle" size={14} color={colors.muted} />
              <Text className="text-sm text-ink">Marked as volunteer</Text>
            </View>
            <Badge label={isVolunteer ? "Yes" : "No"} tone={isVolunteer ? "accent" : "neutral"} />
          </Pressable>
          <Text className="mt-2 text-xs text-muted">
            {person.consentedAt
              ? `Consented ${formatDate(person.consentedAt)}${
                  person.consentSource ? ` · ${person.consentSource}` : ""
                }`
              : "No affirmative consent on file"}
          </Text>
        </View>

        {/* Marketing preference (person-centric audiences Phase 2) — layered
            OVER the address-level unsubscribe/bounce ledger, which stays
            authoritative and untouched; this only ever excludes THIS person
            from bulk email sends (never transactional email). */}
        <View className="mb-4">
          <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
            Marketing
          </Text>
          <Pressable
            onPress={() =>
              updatePerson({ personId: person._id, marketingOptOut: !marketingOptOut })
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

        {/* Guest history (People-CRM UX) — "attended/registered as a guest"
            (every rsvp linked to this person), distinct from "Event history"
            above (worked/volunteered a role). */}
        <View className="mt-4">
          <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
            Guest history
          </Text>
          {guestHistory === undefined ? (
            <Text style={styles.historyEmpty}>Loading guest history…</Text>
          ) : guestHistory.count === 0 ? (
            <Text style={styles.historyEmpty}>
              No RSVPs on file — this person hasn't attended as a guest.
            </Text>
          ) : (
            <View style={styles.historyList}>
              {guestHistory.history.map((h) => (
                <View key={h.rsvpId} style={styles.historyItem}>
                  <View style={styles.historyItemTop}>
                    <Text style={styles.historyEvent} numberOfLines={1}>
                      {h.eventName}
                    </Text>
                    <Badge
                      label={RSVP_STATUS_LABEL[h.status] ?? h.status}
                      tone={RSVP_STATUS_TONE[h.status] ?? "neutral"}
                    />
                  </View>
                  <Text style={styles.historyMeta}>{formatDate(h.eventDate)}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Known emails (People-CRM UX, `personEmails` ledger) — every
            address ever observed for this person, with a "Make primary"
            affordance. Compact by design: this is a quick reference, not a
            full preference center. */}
        <View className="mt-4">
          <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
            Known emails
          </Text>
          {knownEmails === undefined ? (
            <Text style={styles.historyEmpty}>Loading known emails…</Text>
          ) : knownEmails.length === 0 ? (
            <Text style={styles.historyEmpty}>No known email addresses yet.</Text>
          ) : (
            <View className="gap-1.5">
              {knownEmails.map((e) => (
                <View
                  key={e._id}
                  className="flex-row items-center justify-between rounded-md border border-border bg-raised px-2.5 py-1.5"
                >
                  <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
                    <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                      {e.address}
                    </Text>
                    <Text className="text-2xs text-faint">{e.source}</Text>
                    {e.verified ? (
                      <Icon name="check-circle" size={12} color={colors.success} />
                    ) : null}
                  </View>
                  {e.isPrimary ? (
                    <Badge label="Primary" tone="accent" />
                  ) : (
                    <Pressable
                      onPress={() => setPrimaryEmail({ personEmailId: e._id })}
                      hitSlop={6}
                      accessibilityLabel={`Make ${e.address} primary`}
                      className="active:opacity-70"
                    >
                      <Text className="text-xs font-medium text-accent">
                        Make primary
                      </Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Form submissions (PW Forms consolidation) — every Google Form
            response resolved to this person (Contact Information, Team
            Interest, …). Event-scoped anonymous surveys (Eden's attendee
            survey) never carry a personId, so they surface on the EVENT's
            Feedback card instead — see
            `components/event/ticketing/FeedbackCard.tsx`. */}
        <View className="mt-4">
          <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
            Form submissions
          </Text>
          {formSubmissions === undefined ? (
            <Text style={styles.historyEmpty}>Loading form submissions…</Text>
          ) : formSubmissions.length === 0 ? (
            <Text style={styles.historyEmpty}>No form submissions on file.</Text>
          ) : (
            <View style={styles.historyList}>
              {formSubmissions.map((sub) => (
                <View key={sub._id} style={styles.historyItem}>
                  <View style={styles.historyItemTop}>
                    <Text style={styles.historyEvent} numberOfLines={1}>
                      {sub.title}
                    </Text>
                    <Badge
                      label={sub.source === "in_app" ? "In-app" : "Import"}
                      tone="neutral"
                    />
                  </View>
                  <Text style={styles.historyMeta}>
                    {formatDate(sub.submittedAt)}
                    {submissionPreview(sub.answers) ? ` · ${submissionPreview(sub.answers)}` : ""}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

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

/** A short, single-line preview for a form submission's answers — the first
 *  1-2 non-empty short string answers, joined. Deliberately generic (no
 *  per-form logic): the full answer set is verbatim data meant for a future
 *  detail view, not this compact list row. */
function submissionPreview(answers: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(answers)) {
    if (parts.length >= 2) break;
    if (typeof value === "string" && value.trim().length > 0 && value.length <= 60) {
      parts.push(value.trim());
    }
  }
  return parts.join(" · ");
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
    // Centre, not baseline: this row now carries the persona rail's pills
    // alongside the title, and baseline alignment hangs them off the display
    // font's baseline instead of sitting them level with it.
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.sm,
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
