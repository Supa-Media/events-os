/**
 * GIVING · Backers — the recurring-pledge desk (F-6 P2), restyled as an
 * inline DATABASE GRID (owner request, 2026-07-19 — same "let's just have
 * inline databases" treatment as Donors/Gifts), 1:1 on the Reconcile grid via
 * the shared `DataGrid` primitives. Lists the scope's pledges grouped by
 * lifecycle (active · past due · imported-awaiting-resignup · canceled) —
 * that grouping is kept (an existing affordance: "past due" and "awaiting
 * re-signup" are each their own actionable bucket) — with each group's rows
 * now rendered as a grid (Name · Pledge · Frequency · Since · Status) instead
 * of stacked cards. A client-side search box (name / email, mirrors the
 * Gifts ledger's search, #303) narrows all groups at once. Shows the derived
 * backer-count summary (active pledges at/above the $50 unit — the number
 * the affordability header now reads).
 *
 * Every pledge on our rails is a MONTHLY commitment (`pledges.amountCents` —
 * "the monthly pledge", schema doc) — there's no per-row cadence field, so
 * the Frequency column is a constant "Monthly" label, not backend data this
 * PR is missing.
 *
 * Reads `listPledges` (gated by `requireGivingView`). Territories P6: bulk
 * recurring-pledge import (the old inline Givebutter form here) moved to the
 * desk's own `Import` tab (`import.tsx`) — see that screen for the canonical
 * preview/commit flow that now covers `recurring` rows alongside gifts,
 * tickets, and contacts.
 *
 * Giving CRM v2: "Export" (owner request #3) serializes exactly the rows on
 * screen — every visible lifecycle group, each in its own current sort order,
 * in the same top-to-bottom order the page renders them. Row-action menus
 * (pause/resume, edit-since, delete-with-reason) + a pledge history view are
 * DEFERRED to the parallel `claude/giving-integrity-tools` PR — those
 * mutations (`setPledgeStatus`/`editPledgeStartedAt`/`deletePledge`/
 * `pledgeHistory`) aren't on `main` yet as of this PR.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, View, Text } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { BACKER_UNIT_CENTS, formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  FULL_WIDTH,
  GridCell,
  GridContainer,
  GridHeaderRow,
  GridRow,
  Narrow,
  Screen,
  SectionHeader,
  SortableHeaderCell,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";
import { toCsv } from "../../../components/giving/csv";
import { exportCsv } from "../../../components/giving/exportCsv";
import {
  nextSortState,
  sortRows,
  type SortDirection,
} from "../../../components/giving/gridSort";

type GivingScope = "central" | Id<"chapters">;

type PledgeRow = {
  _id: Id<"pledges">;
  donorId: Id<"donors">;
  donorName: string;
  donorEmail: string | null;
  amountCents: number;
  status: "incomplete" | "active" | "past_due" | "canceled";
  origin: "stripe" | "imported";
  startedAt?: number;
  createdAt: number;
};

const NUM = { fontVariant: ["tabular-nums" as const] };

// Fixed column widths (px) — mirrors the Reconcile / Donors grids.
const COLS = {
  name: 260,
  pledge: 120,
  frequency: 110,
  since: 130,
  status: 130,
} as const;
const GRID_WIDTH = COLS.name + COLS.pledge + COLS.frequency + COLS.since + COLS.status;

/** Pledge lifecycle → chip tone. */
function pledgeStatusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "past_due") return "warn";
  if (status === "canceled") return "danger";
  return "neutral";
}

export default function BackersScreen() {
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
  return <BackersBody scope={access.scope} />;
}

type SortKey = "name" | "pledge" | "since";
type SortState = { key: SortKey; direction: SortDirection };

function BackersBody({ scope }: { scope: GivingScope }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "since", direction: "desc" });
  const pledges = useQuery(api.givingPledges.listPledges, { scope }) as
    | PledgeRow[]
    | undefined;

  // Client-side search (name / email) — mirrors the Gifts ledger's search
  // (#303) — narrows every lifecycle group at once.
  const searched = useMemo(() => {
    const rows = pledges ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((p) =>
      [p.donorName, p.donorEmail ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [pledges, search]);

  const groups = useMemo(() => {
    const active: PledgeRow[] = [];
    const pastDue: PledgeRow[] = [];
    const imported: PledgeRow[] = [];
    const canceled: PledgeRow[] = [];
    for (const p of searched) {
      if (p.status === "canceled") canceled.push(p);
      else if (p.origin === "imported") imported.push(p);
      else if (p.status === "active") active.push(p);
      else pastDue.push(p); // past_due / incomplete on our rails
    }
    // Backers = active pledges at/above the $50 unit (the derived count the
    // affordability header reads; PRD Appendix C#2) — computed over the
    // UNFILTERED-by-search set so the stat cards never shift with a search.
    const allActive = (pledges ?? []).filter(
      (p) => p.status !== "canceled" && p.origin !== "imported" && p.status === "active",
    );
    const backerCount = allActive.filter(
      (p) => p.amountCents >= BACKER_UNIT_CENTS,
    ).length;
    const monthlyCents = allActive.reduce((sum, p) => sum + p.amountCents, 0);
    return {
      active,
      pastDue,
      imported,
      canceled,
      backerCount,
      activeCount: allActive.length,
      monthlyCents,
    };
  }, [searched, pledges]);

  function toggleSort(key: SortKey) {
    setSort((current) => nextSortState(key, current));
  }

  // The same per-group sort `PledgeGrid` applies for DISPLAY — recomputed
  // here (cheap, pure) so Export serializes rows in the exact order shown.
  function sortedForExport(rows: PledgeRow[]): PledgeRow[] {
    const getValue = (p: PledgeRow) => {
      if (sort.key === "name") return p.donorName.toLowerCase();
      if (sort.key === "pledge") return p.amountCents;
      return p.startedAt ?? p.createdAt;
    };
    return sortRows(rows, getValue, sort.direction);
  }

  async function exportBackers() {
    const headers = ["Name", "Email", "Pledge", "Frequency", "Since", "Status", "Group"];
    const orderedGroups: [string, PledgeRow[]][] = [
      ["Active", groups.active],
      ["Past due", groups.pastDue],
      ["Imported · awaiting re-signup", groups.imported],
      ["Canceled", groups.canceled],
    ];
    const rows = orderedGroups.flatMap(([label, list]) =>
      sortedForExport(list).map((p) => [
        p.donorName,
        p.donorEmail ?? "",
        (p.amountCents / 100).toFixed(2),
        "Monthly",
        new Date(p.startedAt ?? p.createdAt).toLocaleDateString(),
        p.status,
        label,
      ]),
    );
    await exportCsv(`backers-${Date.now()}.csv`, toCsv(headers, rows));
  }

  if (pledges === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const searching = search.trim().length > 0;

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
        <View className="mb-3 flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-row flex-wrap gap-3">
            <Stat label="Backers" value={String(groups.backerCount)} />
            <Stat label="Active pledges" value={String(groups.activeCount)} />
            <Stat label="Monthly recurring" value={formatCents(groups.monthlyCents)} />
          </View>
          <Button
            title="Export"
            icon="download"
            size="sm"
            variant="secondary"
            onPress={() => void exportBackers()}
          />
        </View>

        <View className="mb-4 min-w-[160px]">
          <TextField
            value={search}
            onChangeText={setSearch}
            placeholder="Search name, email…"
            autoCapitalize="none"
          />
        </View>

        {pledges.length === 0 ? (
          <EmptyState
            title="No pledges yet"
            message="Backers appear here once they subscribe, or import recurring donors from the Import tab."
          />
        ) : searching && searched.length === 0 ? (
          <EmptyState
            icon="search"
            title="No matches"
            message={`No backers match “${search.trim()}”.`}
          />
        ) : null}
      </Narrow>

      {pledges.length > 0 && !(searching && searched.length === 0) ? (
        <>
          <PledgeGrid
            title="Active"
            rows={groups.active}
            sort={sort}
            onSort={toggleSort}
            onOpen={(donorId) => router.navigate(`/giving/donor/${donorId}` as never)}
          />
          <PledgeGrid
            title="Past due"
            rows={groups.pastDue}
            sort={sort}
            onSort={toggleSort}
            onOpen={(donorId) => router.navigate(`/giving/donor/${donorId}` as never)}
          />
          <PledgeGrid
            title="Imported · awaiting re-signup"
            rows={groups.imported}
            sort={sort}
            onSort={toggleSort}
            onOpen={(donorId) => router.navigate(`/giving/donor/${donorId}` as never)}
          />
          <PledgeGrid
            title="Canceled"
            rows={groups.canceled}
            sort={sort}
            onSort={toggleSort}
            onOpen={(donorId) => router.navigate(`/giving/donor/${donorId}` as never)}
          />
        </>
      ) : null}
    </Screen>
  );
}

/** One lifecycle group's grid — SectionHeader (title + count) above a
 *  Reconcile-style grid (Name · Pledge · Frequency · Since · Status). Sort
 *  state is shared across every group (one set of column headers behaves the
 *  same everywhere), applied independently per group's rows. */
function PledgeGrid({
  title,
  rows,
  sort,
  onSort,
  onOpen,
}: {
  title: string;
  rows: PledgeRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  onOpen: (donorId: Id<"donors">) => void;
}) {
  // Hooks run unconditionally, even for an empty group — the early return
  // (below) happens after every hook.
  const sorted = useMemo(() => {
    const getValue = (p: PledgeRow) => {
      if (sort.key === "name") return p.donorName.toLowerCase();
      if (sort.key === "pledge") return p.amountCents;
      return p.startedAt ?? p.createdAt;
    };
    return sortRows(rows, getValue, sort.direction);
  }, [rows, sort]);

  if (rows.length === 0) return null;

  return (
    <View className="mb-5">
      <Narrow>
        <SectionHeader title={`${title} (${rows.length})`} />
      </Narrow>
      <GridContainer width={GRID_WIDTH}>
        <GridHeaderRow>
          <SortableHeaderCell
            label="Name"
            width={COLS.name}
            active={sort.key === "name"}
            direction={sort.direction}
            onSort={() => onSort("name")}
          />
          <SortableHeaderCell
            label="Pledge"
            width={COLS.pledge}
            align="right"
            active={sort.key === "pledge"}
            direction={sort.direction}
            onSort={() => onSort("pledge")}
          />
          <SortableHeaderCell label="Frequency" width={COLS.frequency} />
          <SortableHeaderCell
            label="Since"
            width={COLS.since}
            active={sort.key === "since"}
            direction={sort.direction}
            onSort={() => onSort("since")}
          />
          <SortableHeaderCell label="Status" width={COLS.status} />
        </GridHeaderRow>
        {sorted.map((p, i) => (
          <PledgeGridRow
            key={p._id}
            pledge={p}
            isLast={i === sorted.length - 1}
            onPress={() => onOpen(p.donorId)}
          />
        ))}
      </GridContainer>
    </View>
  );
}

function PledgeGridRow({
  pledge,
  isLast,
  onPress,
}: {
  pledge: PledgeRow;
  isLast: boolean;
  onPress: () => void;
}) {
  const since = pledge.startedAt ?? pledge.createdAt;
  return (
    <GridRow onPress={onPress} isLast={isLast} accessibilityLabel={`Open ${pledge.donorName}`}>
      <GridCell width={COLS.name}>
        <View className="flex-1 px-2 py-1.5">
          <Text className="text-sm font-medium text-ink" numberOfLines={1}>
            {pledge.donorName}
          </Text>
          {pledge.donorEmail ? (
            <Text className="text-2xs text-muted" numberOfLines={1}>
              {pledge.donorEmail}
            </Text>
          ) : null}
        </View>
      </GridCell>
      <GridCell width={COLS.pledge}>
        <Text className="flex-1 px-2 py-1.5 text-right text-sm font-semibold text-ink" style={NUM}>
          {formatCents(pledge.amountCents)}
        </Text>
      </GridCell>
      <GridCell width={COLS.frequency}>
        <Text className="flex-1 px-2 py-1.5 text-sm text-muted" numberOfLines={1}>
          Monthly
        </Text>
      </GridCell>
      <GridCell width={COLS.since}>
        <Text className="flex-1 px-2 py-1.5 text-sm text-muted" style={NUM}>
          {new Date(since).toLocaleDateString()}
        </Text>
      </GridCell>
      <GridCell width={COLS.status}>
        <View className="flex-1 px-2 py-1.5">
          <Badge label={pledge.status} tone={pledgeStatusTone(pledge.status)} />
        </View>
      </GridCell>
    </GridRow>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[110px] flex-1 rounded-lg border border-border bg-raised p-3">
      <Text className="text-xs text-muted">{label}</Text>
      <Text className="mt-1 text-lg font-bold text-ink">{value}</Text>
    </View>
  );
}
