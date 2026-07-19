/**
 * GIVING · Donors — the scope's donor list as an inline DATABASE GRID (owner
 * request, 2026-07-19: "The donors list should just look like a database...
 * let's just have inline databases"), styled 1:1 on the Reconcile grid
 * (`components/finance/reconcile/ReconcileList.tsx`) via the shared
 * `DataGrid` primitives (`components/ui/DataGrid.tsx`). Sorted by lifetime
 * giving by default (the "top donors" relationship workflow needs this
 * ordering on day one, PRD §1) — Name / Lifetime / Last gift are sortable
 * client-side over the already-loaded rows (`components/giving/gridSort`).
 *
 * Giving-dashboard v2 CRM: the four stacked chip rows are replaced by compact
 * `FilterSelect` dropdowns (status / kind / source / lifetime band), plus a
 * client-side search box (name / email — mirrors the Gifts ledger's search,
 * #303). A CENTRAL holder also gets a SCOPE dropdown — All chapters / Central
 * / each chapter — where "All chapters" runs `listDonors`'s central-gated
 * all-scopes merge (each row tagged with its chapter, shown as a Book
 * column). A chapter-only viewer sees neither the scope dropdown nor the
 * fleet — they stay locked to their own chapter. The backend `listDonors`
 * gates on `requireGivingView` — no query/column here needs data the backend
 * didn't already return (`personId` was already on every `donors` doc).
 *
 * Giving CRM v2 (owner feedback, voice notes): Email/Phone are now real,
 * EDITABLE columns (`InlineText`, mirrors the People roster grid's own
 * inline-edit cells) committing through the exact same `upsertDonor` mutation
 * the donor-detail screen uses — no new mutation, manage-gated server-side
 * too. A "Linked person" column shows the roster tie `personId` already
 * carries (territories P5's `linkDonorToPerson`): name resolved via
 * `people.list` (the caller's own chapter roster — the only bounded query
 * available; a cross-chapter link in all-scopes mode degrades to an
 * icon-only "Linked" state, never a wrong name) with tap → the People tab's
 * detail sheet (`/people?openId=<personId>`, that screen's own new deep-link
 * param). Because two columns are now inline-editable, the row itself is no
 * longer one big press target (a nested TextInput-inside-Pressable is unsafe
 * on web — RN-web's Pressable is click-based and the click bubbles); instead
 * the Name cell alone opens the donor detail, the same affordance the People
 * grid uses (name/avatar cell double-duties, a dedicated icon elsewhere opens
 * detail) — GridRow itself is unchanged, just unused here now.
 *
 * Export (owner request #3) serializes exactly the rows on screen — the
 * post-filter/search/sort `sorted` array — via `components/giving/csv.ts`.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  FilterSelect,
  type FilterSelectOption,
  FULL_WIDTH,
  GridCell,
  GridContainer,
  GridCountLabel,
  GridHeaderRow,
  GridRow,
  Icon,
  InlineText,
  Narrow,
  Screen,
  SortableHeaderCell,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { useGivingScope } from "../../../lib/useGivingScope";
import { DonorDuplicatesSheet } from "../../../components/giving/DonorDuplicatesSheet";
import { toCsv } from "../../../components/giving/csv";
import { exportCsv } from "../../../components/giving/exportCsv";
import {
  ALL_SCOPES_VALUE,
  anyFilterActive,
  buildListDonorsArgs,
} from "../../../components/giving/dashboard/donorFilters";
import {
  nextSortState,
  sortRows,
  type SortDirection,
} from "../../../components/giving/gridSort";

type GivingScope = "central" | Id<"chapters">;

const NUM = { fontVariant: ["tabular-nums" as const] };

// Fixed column widths (px) — the grid scrolls horizontally on narrow web
// while columns stay put, mirroring the Reconcile / People roster grids.
const COLS = {
  name: 200,
  email: 190,
  phone: 130,
  linked: 150,
  status: 108,
  kind: 116,
  lifetime: 130,
  lastGift: 116,
  source: 150,
  book: 140,
} as const;

const SOURCE_LABEL_BY_VALUE: Record<string, string> = {
  manual: "Manual",
  "event-donation": "Event donation",
  "givebutter-import": "Givebutter",
  map: "Map",
};

type SortKey = "name" | "lifetime" | "lastGift";
type SortState = { key: SortKey; direction: SortDirection };

/** A donor row as `listDonors` returns it — either single-scope, or an
 *  all-scopes row carrying a `scopeLabel` chapter tag (see the backend doc). */
type DonorRow = {
  _id: Id<"donors">;
  scope: GivingScope;
  name: string;
  email?: string;
  phone?: string;
  status: string;
  kind: string;
  source?: string;
  lifetimeCents: number;
  lastGiftAt?: number;
  scopeLabel?: string;
  /** Territories P5 roster tie (`linkDonorToPerson`) — set only for a
   *  CHAPTER-scope donor once matched into that chapter's `people` roster;
   *  a central donor's is permanently unset. */
  personId?: Id<"people">;
};

// ── CRM filters (territories P5) ────────────────────────────────────────────
// Hardcoded, mirroring `donor/[id].tsx`'s `SOURCE_OPTIONS` — mobile doesn't
// import the convex-side schema literals directly, so the option lists are
// kept in step with `schema/givingPlatform.ts`'s `DONOR_STATUSES`/
// `DONOR_KINDS`/`DONOR_SOURCES` by hand (small, stable unions).

const STATUS_FILTERS: FilterSelectOption[] = [
  { value: "all", label: "All" },
  { value: "prospect", label: "Prospect" },
  { value: "active", label: "Active" },
  { value: "lapsed", label: "Lapsed" },
];

const KIND_FILTERS: FilterSelectOption[] = [
  { value: "all", label: "All kinds" },
  { value: "individual", label: "Individual" },
  { value: "church", label: "Church" },
  { value: "business", label: "Business" },
  { value: "foundation", label: "Foundation" },
];

const SOURCE_FILTERS: FilterSelectOption[] = [
  { value: "all", label: "All sources" },
  { value: "manual", label: "Manual" },
  { value: "event-donation", label: "Event donation" },
  { value: "givebutter-import", label: "Givebutter" },
  { value: "map", label: "Map" },
];

// Lifetime bands (dollars, converted to cents for the query arg — see
// `donorFilters.LIFETIME_BAND_CENTS`).
const LIFETIME_BANDS: FilterSelectOption[] = [
  { value: "all", label: "Any amount" },
  { value: "100", label: "$100+" },
  { value: "500", label: "$500+" },
  { value: "1000", label: "$1k+" },
];

/** Donor status → chip tone: active reads calm, lapsed warns (reactivation
 *  queue), prospect is neutral (no gift yet). */
export function donorStatusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "lapsed") return "warn";
  return "neutral";
}

export default function DonorsScreen() {
  // WP-S follow-up: the app's chapter lens — see `useGivingScope`'s own doc.
  const chapterId = useGivingScope();
  const access = useQuery(api.givingPlatform.myGivingAccess, { chapterId });

  if (access === undefined) return <Screen loading />;
  if (!access.canView || access.scope === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Development desk access needed"
            message="Ask a development director to grant you access to the giving desk."
          />
        </Narrow>
      </Screen>
    );
  }
  return (
    <DonorsBody
      lensScope={access.scope}
      isCentral={access.isCentral}
      canManage={access.canManage}
    />
  );
}

function DonorsBody({
  lensScope,
  isCentral,
  canManage,
}: {
  lensScope: GivingScope;
  isCentral: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [source, setSource] = useState("all");
  const [band, setBand] = useState("all");
  const [search, setSearch] = useState("");
  // Defaults to the Academy-documented invariant — "sorted by lifetime, on
  // purpose" — applied client-side so it holds regardless of which server
  // index served the rows (a status filter reads `by_scope_and_status`,
  // which isn't lifetime-ordered).
  const [sort, setSort] = useState<SortState>({ key: "lifetime", direction: "desc" });
  // The scope selector (central holders only): a chapter id, "central", or the
  // all-scopes sentinel. Defaults to the app lens's own scope.
  const [scopeSel, setScopeSel] = useState<string>(lensScope);
  // Duplicate review + merge — manage-gated (Attendance C).
  const [dupOpen, setDupOpen] = useState(false);

  // Central holders get a scope dropdown built from the fleet (central + each
  // active chapter). Skipped for chapter-only viewers (never central-gated).
  const fleet = useQuery(
    api.givingPlatform.dashboardFleet,
    isCentral ? {} : "skip",
  );
  const scopeOptions: FilterSelectOption[] = [
    { value: ALL_SCOPES_VALUE, label: "All chapters" },
    ...(fleet?.scopes ?? []).map((s) => ({ value: s.scope, label: s.name })),
  ];

  const filters = { status, kind, source, band };
  const args = buildListDonorsArgs(filters, isCentral ? scopeSel : lensScope);
  const donors = useQuery(api.givingPlatform.listDonors, args as never) as
    | DonorRow[]
    | undefined;

  // "Linked person" column name resolution — best-effort. `people.list` is
  // hard-scoped server-side to the CALLER's own chapter (no `chapterId` arg
  // exists to aim it elsewhere), which matches every chapter-scope donor's
  // `personId` exactly when the viewer IS that chapter (the common case).
  // A central holder browsing another chapter (or "All chapters") simply
  // won't find a name here — the Linked cell degrades to an icon-only state
  // rather than ever showing a wrong person's name (see `DonorGridRow`).
  const people = useQuery(api.people.list, {});
  const personNameById = useMemo(() => {
    const map = new Map<Id<"people">, string>();
    for (const p of people ?? []) map.set(p._id, p.name);
    return map;
  }, [people]);

  const upsertDonor = useMutation(api.givingPlatform.upsertDonor);
  async function commitDonorField(
    donor: DonorRow,
    patch: { email?: string } | { phone?: string },
  ) {
    try {
      await upsertDonor({
        scope: donor.scope,
        donorId: donor._id,
        name: donor.name,
        ...patch,
      });
    } catch (e) {
      alertError(e);
    }
  }

  const isAllScopes = isCentral && scopeSel === ALL_SCOPES_VALUE;
  const filtersActive = anyFilterActive(filters);

  // Client-side search (name / email) over the already-loaded scope page —
  // mirrors the Gifts ledger's search (#303). Server search comes later.
  const searched = useMemo(() => {
    const rows = donors ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((d) =>
      [d.name, d.email ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [donors, search]);

  const sorted = useMemo(() => {
    const getValue = (d: DonorRow) => {
      if (sort.key === "name") return d.name.toLowerCase();
      if (sort.key === "lifetime") return d.lifetimeCents;
      return d.lastGiftAt ?? null;
    };
    return sortRows(searched, getValue, sort.direction);
  }, [searched, sort]);

  function toggleSort(key: SortKey) {
    setSort((current) => nextSortState(key, current));
  }

  if (donors === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const searching = search.trim().length > 0;
  const width = isAllScopes
    ? COLS.name + COLS.email + COLS.phone + COLS.linked + COLS.status + COLS.kind + COLS.lifetime + COLS.lastGift + COLS.source + COLS.book
    : COLS.name + COLS.email + COLS.phone + COLS.linked + COLS.status + COLS.kind + COLS.lifetime + COLS.lastGift + COLS.source;

  // Export (owner request #3) — exactly the CURRENT view: post-filter,
  // post-search, post-sort `sorted` rows, in the order shown.
  async function exportDonors() {
    const headers = [
      "Name",
      "Email",
      "Phone",
      "Linked person",
      "Status",
      "Kind",
      "Lifetime",
      "Last gift",
      "Source",
      ...(isAllScopes ? ["Book"] : []),
    ];
    const rows = sorted.map((d) => [
      d.name,
      d.email ?? "",
      d.phone ?? "",
      d.personId ? (personNameById.get(d.personId) ?? "Linked") : "",
      d.status,
      d.kind,
      (d.lifetimeCents / 100).toFixed(2),
      d.lastGiftAt ? new Date(d.lastGiftAt).toLocaleDateString() : "",
      d.source ? (SOURCE_LABEL_BY_VALUE[d.source] ?? d.source) : "",
      ...(isAllScopes ? [d.scopeLabel ?? ""] : []),
    ]);
    await exportCsv(`donors-${Date.now()}.csv`, toCsv(headers, rows));
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
        {/* Header — row count (+ "N of M" while searching) + Export + Duplicates. */}
        <View className="mb-3 flex-row items-center justify-between">
          {searching ? (
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {sorted.length} of {donors.length}
            </Text>
          ) : (
            <GridCountLabel label="Donors" count={donors.length} />
          )}
          <View className="flex-row items-center gap-2">
            <Button
              title="Export"
              icon="download"
              size="sm"
              variant="secondary"
              onPress={() => void exportDonors()}
            />
            {canManage && !isAllScopes ? (
              <Pressable
                onPress={() => setDupOpen(true)}
                hitSlop={6}
                accessibilityLabel="Review duplicate donors"
                className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1 active:bg-sunken web:hover:bg-sunken"
              >
                <Icon name="copy" size={13} color={colors.muted} />
                <Text className="text-xs font-semibold text-muted">Duplicates</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* CRM filter row — compact dropdowns + search, wrapping. */}
        <View className="mb-4 flex-row flex-wrap items-center gap-2">
          {isCentral ? (
            <FilterSelect
              label="Scope"
              value={scopeSel}
              options={scopeOptions}
              onChange={setScopeSel}
              minWidth={220}
            />
          ) : null}
          <FilterSelect label="Status" value={status} options={STATUS_FILTERS} onChange={setStatus} />
          <FilterSelect label="Kind" value={kind} options={KIND_FILTERS} onChange={setKind} />
          <FilterSelect label="Source" value={source} options={SOURCE_FILTERS} onChange={setSource} />
          <FilterSelect label="Lifetime" value={band} options={LIFETIME_BANDS} onChange={setBand} />
          <View className="min-w-[160px] flex-1">
            <TextField
              value={search}
              onChangeText={setSearch}
              placeholder="Search name, email…"
              autoCapitalize="none"
            />
          </View>
        </View>
      </Narrow>

      {donors.length === 0 ? (
        <Narrow>
          <EmptyState
            title={filtersActive ? "No donors match those filters" : "No donors yet"}
            message={
              filtersActive
                ? "Try widening a filter above."
                : "Record a gift on a donor, or bring in history from the Import tab."
            }
          />
        </Narrow>
      ) : sorted.length === 0 ? (
        <Narrow>
          <EmptyState
            icon="search"
            title="No matches"
            message={`No donors match “${search.trim()}”.`}
          />
        </Narrow>
      ) : (
        <GridContainer width={width}>
          <GridHeaderRow>
            <SortableHeaderCell
              label="Name"
              width={COLS.name}
              active={sort.key === "name"}
              direction={sort.direction}
              onSort={() => toggleSort("name")}
            />
            <SortableHeaderCell label="Email" width={COLS.email} />
            <SortableHeaderCell label="Phone" width={COLS.phone} />
            <SortableHeaderCell label="Linked person" width={COLS.linked} />
            <SortableHeaderCell label="Status" width={COLS.status} />
            <SortableHeaderCell label="Kind" width={COLS.kind} />
            <SortableHeaderCell
              label="Lifetime"
              width={COLS.lifetime}
              align="right"
              active={sort.key === "lifetime"}
              direction={sort.direction}
              onSort={() => toggleSort("lifetime")}
            />
            <SortableHeaderCell
              label="Last gift"
              width={COLS.lastGift}
              active={sort.key === "lastGift"}
              direction={sort.direction}
              onSort={() => toggleSort("lastGift")}
            />
            <SortableHeaderCell label="Source" width={COLS.source} />
            {isAllScopes ? (
              <SortableHeaderCell label="Book" width={COLS.book} />
            ) : null}
          </GridHeaderRow>
          {sorted.map((d, i) => (
            <DonorGridRow
              key={d._id}
              donor={d}
              showBook={isAllScopes}
              canEdit={canManage}
              personName={d.personId ? personNameById.get(d.personId) : undefined}
              isLast={i === sorted.length - 1}
              onOpen={() => router.navigate(`/giving/donor/${d._id}` as never)}
              onOpenPerson={(personId) =>
                router.navigate(`/people?openId=${personId}` as never)
              }
              onCommitEmail={(email) => void commitDonorField(d, { email })}
              onCommitPhone={(phone) => void commitDonorField(d, { phone })}
            />
          ))}
        </GridContainer>
      )}

      {canManage && !isAllScopes ? (
        <DonorDuplicatesSheet
          scope={scopeSel as GivingScope}
          visible={dupOpen}
          onClose={() => setDupOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/**
 * One donor row: Name (tap → donor detail — the row's OWN press target now
 * that Email/Phone are inline-editable text inputs; nesting those inside a
 * whole-row Pressable is unsafe on RN-web, where a click bubbles up to the
 * ancestor) · Email · Phone (both `InlineText`, manage-gated) · Linked
 * person (tap → the People tab's detail sheet) · Status · Kind · Lifetime ·
 * Last gift · Source (+ Book tag in all-scopes mode).
 */
function DonorGridRow({
  donor,
  showBook,
  canEdit,
  personName,
  isLast,
  onOpen,
  onOpenPerson,
  onCommitEmail,
  onCommitPhone,
}: {
  donor: DonorRow;
  showBook: boolean;
  /** Whether the caller can edit Email/Phone inline (`canManage`). */
  canEdit: boolean;
  /** The linked person's name, when resolvable — see `DonorsBody`'s doc on
   *  why a cross-chapter link may resolve to no name at all. */
  personName: string | undefined;
  isLast: boolean;
  onOpen: () => void;
  onOpenPerson: (personId: Id<"people">) => void;
  onCommitEmail: (email: string) => void;
  onCommitPhone: (phone: string) => void;
}) {
  return (
    <GridRow isLast={isLast}>
      <GridCell width={COLS.name}>
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`Open ${donor.name}`}
          className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-80"
        >
          <Text className="text-sm font-medium text-ink" numberOfLines={1}>
            {donor.name}
          </Text>
        </Pressable>
      </GridCell>
      <GridCell width={COLS.email}>
        {canEdit ? (
          <InlineText
            value={donor.email ?? ""}
            placeholder="—"
            onCommit={(t) => onCommitEmail(t.trim())}
          />
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-muted" numberOfLines={1}>
            {donor.email ?? "—"}
          </Text>
        )}
      </GridCell>
      <GridCell width={COLS.phone}>
        {canEdit ? (
          <InlineText
            value={donor.phone ?? ""}
            placeholder="—"
            onCommit={(t) => onCommitPhone(t.trim())}
          />
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-muted" numberOfLines={1}>
            {donor.phone ?? "—"}
          </Text>
        )}
      </GridCell>
      <GridCell width={COLS.linked}>
        {donor.personId ? (
          <Pressable
            onPress={() => onOpenPerson(donor.personId as Id<"people">)}
            accessibilityRole="button"
            accessibilityLabel={personName ? `Open ${personName}` : "Open linked person"}
            className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-80"
          >
            <Icon name="user-check" size={12} color={colors.success} />
            <Text className="flex-1 text-sm text-accent" numberOfLines={1}>
              {personName ?? "Linked"}
            </Text>
          </Pressable>
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-faint" numberOfLines={1}>
            Not linked
          </Text>
        )}
      </GridCell>
      <GridCell width={COLS.status}>
        <View className="flex-1 px-2 py-1.5">
          <Badge label={donor.status} tone={donorStatusTone(donor.status)} />
        </View>
      </GridCell>
      <GridCell width={COLS.kind}>
        <Text className="flex-1 px-2 py-1.5 text-sm capitalize text-ink" numberOfLines={1}>
          {donor.kind}
        </Text>
      </GridCell>
      <GridCell width={COLS.lifetime}>
        <Text
          className="flex-1 px-2 py-1.5 text-right text-sm font-semibold text-ink"
          style={NUM}
        >
          {formatCents(donor.lifetimeCents)}
        </Text>
      </GridCell>
      <GridCell width={COLS.lastGift}>
        <Text className="flex-1 px-2 py-1.5 text-sm text-muted" style={NUM}>
          {donor.lastGiftAt ? new Date(donor.lastGiftAt).toLocaleDateString() : "—"}
        </Text>
      </GridCell>
      <GridCell width={COLS.source}>
        <Text className="flex-1 px-2 py-1.5 text-sm text-muted" numberOfLines={1}>
          {donor.source ? (SOURCE_LABEL_BY_VALUE[donor.source] ?? donor.source) : "—"}
        </Text>
      </GridCell>
      {showBook ? (
        <GridCell width={COLS.book}>
          <Text className="flex-1 px-2 py-1.5 text-sm text-muted" numberOfLines={1}>
            {donor.scopeLabel ?? "—"}
          </Text>
        </GridCell>
      ) : null}
    </GridRow>
  );
}
