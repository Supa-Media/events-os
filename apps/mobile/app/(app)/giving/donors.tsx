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
 * fleet — they stay locked to their own chapter. Tapping a row opens the
 * donor detail. The backend `listDonors` gates on `requireGivingView` — this
 * PR is UI-only, no query/column here needs data the backend doesn't already
 * return.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
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
  Narrow,
  Screen,
  SortableHeaderCell,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";
import { DonorDuplicatesSheet } from "../../../components/giving/DonorDuplicatesSheet";
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
  name: 240,
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
  name: string;
  email?: string;
  phone?: string;
  status: string;
  kind: string;
  source?: string;
  lifetimeCents: number;
  lastGiftAt?: number;
  scopeLabel?: string;
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
    ? COLS.name + COLS.status + COLS.kind + COLS.lifetime + COLS.lastGift + COLS.source + COLS.book
    : COLS.name + COLS.status + COLS.kind + COLS.lifetime + COLS.lastGift + COLS.source;

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
        {/* Header — row count (+ "N of M" while searching) + Duplicates. */}
        <View className="mb-3 flex-row items-center justify-between">
          {searching ? (
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {sorted.length} of {donors.length}
            </Text>
          ) : (
            <GridCountLabel label="Donors" count={donors.length} />
          )}
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
              isLast={i === sorted.length - 1}
              onPress={() => router.navigate(`/giving/donor/${d._id}` as never)}
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

/** One donor row: Name (+ email/phone subtitle) · Status · Kind · Lifetime ·
 *  Last gift · Source (+ Book tag in all-scopes mode). */
function DonorGridRow({
  donor,
  showBook,
  isLast,
  onPress,
}: {
  donor: DonorRow;
  showBook: boolean;
  isLast: boolean;
  onPress: () => void;
}) {
  const contact = donor.email ?? donor.phone ?? "No contact";
  return (
    <GridRow onPress={onPress} isLast={isLast} accessibilityLabel={`Open ${donor.name}`}>
      <GridCell width={COLS.name}>
        <View className="flex-1 px-2 py-1.5">
          <Text className="text-sm font-medium text-ink" numberOfLines={1}>
            {donor.name}
          </Text>
          <Text className="text-2xs text-muted" numberOfLines={1}>
            {contact}
          </Text>
        </View>
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
