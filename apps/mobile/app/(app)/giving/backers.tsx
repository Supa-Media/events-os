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
 * Backer lifecycle actions (#311's `setPledgeStatus` / `editPledgeStartedAt`
 * / `deletePledge`, owner feedback #5): wired here as a row kebab menu, the
 * same anchored-`ContextMenu` affordance the manager cards table uses
 * (`CardholderRow`) — manage-gated, only rendered when `canManage`. A PAUSED
 * pledge (a manual, local overlay — see `setPledgeStatus`'s doc; it does NOT
 * count toward `backerCount` but stays in the list, sorted into the "Active"
 * group since it's still a live subscription, just admin-muted) renders dim
 * (`GridRow`'s `muted`) with its own "Paused" badge. Tapping a row's name
 * opens a minimal detail sheet with the pledge's full lifecycle HISTORY
 * (`pledgeHistory`, owner feedback #5d) — the "when was it paused/resumed/
 * card-failed" timeline — plus a link through to the donor's full profile.
 */
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  View,
  Text,
} from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { BACKER_UNIT_CENTS, formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  ContextMenu,
  type ContextMenuAction,
  DateTimeField,
  EmptyState,
  FULL_WIDTH,
  GridCell,
  GridContainer,
  GridHeaderRow,
  GridRow,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
  SortableHeaderCell,
  TextField,
  useAnchor,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { useGivingScope } from "../../../lib/useGivingScope";
import {
  nextSortState,
  sortRows,
  type SortDirection,
} from "../../../components/giving/gridSort";

type GivingScope = "central" | Id<"chapters">;

type PledgeStatus = "incomplete" | "active" | "past_due" | "canceled" | "paused";

type PledgeRow = {
  _id: Id<"pledges">;
  donorId: Id<"donors">;
  donorName: string;
  donorEmail: string | null;
  amountCents: number;
  status: PledgeStatus;
  origin: "stripe" | "imported";
  startedAt?: number;
  createdAt: number;
};

const NUM = { fontVariant: ["tabular-nums" as const] };

// Fixed column widths (px) — mirrors the Reconcile / Donors grids. `actions`
// is only added to the grid width when the caller can manage (kebab column).
const COLS = {
  name: 260,
  pledge: 120,
  frequency: 110,
  since: 130,
  status: 130,
  actions: 44,
} as const;
const BASE_GRID_WIDTH =
  COLS.name + COLS.pledge + COLS.frequency + COLS.since + COLS.status;

/** Display label for a pledge's status — the raw enum values aren't all
 *  presentable as-is (`past_due`). */
const STATUS_LABELS: Record<PledgeStatus, string> = {
  incomplete: "Incomplete",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  paused: "Paused",
};

/** Pledge lifecycle → chip tone. `paused` mirrors the donor-detail
 *  `PledgeCard`'s own tone choice (warn — it needs attention, even though
 *  it's a deliberate manual state, not an error). */
function pledgeStatusTone(status: PledgeStatus): BadgeTone {
  if (status === "active") return "success";
  if (status === "past_due") return "warn";
  if (status === "canceled") return "danger";
  if (status === "paused") return "warn";
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
  return <BackersBody scope={access.scope} canManage={access.canManage} />;
}

type SortKey = "name" | "pledge" | "since";
type SortState = { key: SortKey; direction: SortDirection };

function BackersBody({
  scope,
  canManage,
}: {
  scope: GivingScope;
  canManage: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "since", direction: "desc" });
  const [detailPledge, setDetailPledge] = useState<PledgeRow | null>(null);
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
      // A manually paused pledge is still a live (just admin-muted)
      // subscription — group it alongside Active so it stays visible where
      // an owner would look for it; the row itself renders dim with a
      // "Paused" badge (owner feedback #5a).
      else if (p.status === "active" || p.status === "paused") active.push(p);
      else pastDue.push(p); // past_due / incomplete on our rails
    }
    // Backers = active pledges at/above the $50 unit (the derived count the
    // affordability header reads; PRD Appendix C#2) — computed over the
    // UNFILTERED-by-search set so the stat cards never shift with a search.
    // `paused` is deliberately excluded (setPledgeStatus's doc): a paused
    // pledge doesn't count toward the backer number.
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
            canManage={canManage}
            onOpenDetail={setDetailPledge}
          />
          <PledgeGrid
            title="Past due"
            rows={groups.pastDue}
            sort={sort}
            onSort={toggleSort}
            canManage={canManage}
            onOpenDetail={setDetailPledge}
          />
          <PledgeGrid
            title="Imported · awaiting re-signup"
            rows={groups.imported}
            sort={sort}
            onSort={toggleSort}
            canManage={canManage}
            onOpenDetail={setDetailPledge}
          />
          <PledgeGrid
            title="Canceled"
            rows={groups.canceled}
            sort={sort}
            onSort={toggleSort}
            canManage={canManage}
            onOpenDetail={setDetailPledge}
          />
        </>
      ) : null}

      {detailPledge ? (
        <BackerDetailSheet
          pledge={detailPledge}
          onClose={() => setDetailPledge(null)}
          onOpenDonor={() => {
            const donorId = detailPledge.donorId;
            setDetailPledge(null);
            router.navigate(`/giving/donor/${donorId}` as never);
          }}
        />
      ) : null}
    </Screen>
  );
}

/** One lifecycle group's grid — SectionHeader (title + count) above a
 *  Reconcile-style grid (Name · Pledge · Frequency · Since · Status[·⋯]).
 *  Sort state is shared across every group (one set of column headers
 *  behaves the same everywhere), applied independently per group's rows. */
function PledgeGrid({
  title,
  rows,
  sort,
  onSort,
  canManage,
  onOpenDetail,
}: {
  title: string;
  rows: PledgeRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  canManage: boolean;
  onOpenDetail: (pledge: PledgeRow) => void;
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

  const width = BASE_GRID_WIDTH + (canManage ? COLS.actions : 0);

  return (
    <View className="mb-5">
      <Narrow>
        <SectionHeader title={`${title} (${rows.length})`} />
      </Narrow>
      <GridContainer width={width}>
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
          {canManage ? <SortableHeaderCell label="" width={COLS.actions} /> : null}
        </GridHeaderRow>
        {sorted.map((p, i) => (
          <PledgeGridRow
            key={p._id}
            pledge={p}
            isLast={i === sorted.length - 1}
            canManage={canManage}
            onOpenDetail={() => onOpenDetail(p)}
          />
        ))}
      </GridContainer>
    </View>
  );
}

function PledgeGridRow({
  pledge,
  isLast,
  canManage,
  onOpenDetail,
}: {
  pledge: PledgeRow;
  isLast: boolean;
  canManage: boolean;
  onOpenDetail: () => void;
}) {
  const since = pledge.startedAt ?? pledge.createdAt;
  const paused = pledge.status === "paused";
  return (
    <GridRow isLast={isLast} muted={paused}>
      <GridCell width={COLS.name}>
        <Pressable
          onPress={onOpenDetail}
          accessibilityRole="button"
          accessibilityLabel={`Open ${pledge.donorName}`}
          className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-80"
        >
          <Text className="text-sm font-medium text-ink" numberOfLines={1}>
            {pledge.donorName}
          </Text>
          {pledge.donorEmail ? (
            <Text className="text-2xs text-muted" numberOfLines={1}>
              {pledge.donorEmail}
            </Text>
          ) : null}
        </Pressable>
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
          <Badge label={STATUS_LABELS[pledge.status]} tone={pledgeStatusTone(pledge.status)} />
        </View>
      </GridCell>
      {canManage ? (
        <GridCell width={COLS.actions}>
          <View className="flex-1 items-center justify-center px-1 py-1.5">
            <BackerActionsMenu pledge={pledge} />
          </View>
        </GridCell>
      ) : null}
    </GridRow>
  );
}

// ── Row action menu — Pause/Resume, Edit since, Delete (owner feedback #5) ────
// Same anchored-kebab affordance as the manager cards table
// (`CardholderRow` — ⋯ button + `useAnchor` + `ContextMenu`).

function BackerActionsMenu({ pledge }: { pledge: PledgeRow }) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const [modal, setModal] = useState<
    "pause" | "resume" | "editSince" | "delete" | null
  >(null);

  const actions: ContextMenuAction[] = [];
  if (pledge.status === "active" || pledge.status === "past_due") {
    actions.push({ label: "Pause", icon: "pause", onPress: () => setModal("pause") });
  } else if (pledge.status === "paused") {
    actions.push({ label: "Resume", icon: "play", onPress: () => setModal("resume") });
  }
  actions.push({
    label: "Edit since…",
    icon: "calendar",
    onPress: () => setModal("editSince"),
  });
  actions.push({
    label: "Delete…",
    icon: "trash-2",
    destructive: true,
    onPress: () => setModal("delete"),
  });

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        hitSlop={8}
        accessibilityLabel={`Actions for ${pledge.donorName}`}
        className="rounded-md p-1 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="more-horizontal" size={16} color={colors.muted} />
      </Pressable>
      <ContextMenu
        anchor={visible ? anchor : undefined}
        actions={actions}
        onClose={close}
      />
      {modal === "pause" || modal === "resume" ? (
        <PauseResumeModal
          pledge={pledge}
          target={modal === "pause" ? "paused" : "active"}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal === "editSince" ? (
        <EditSinceModal pledge={pledge} onClose={() => setModal(null)} />
      ) : null}
      {modal === "delete" ? (
        <DeletePledgeModal pledge={pledge} onClose={() => setModal(null)} />
      ) : null}
    </>
  );
}

/** Shared bottom-sheet chrome for the three action modals — mirrors the
 *  Gifts/Donor-detail edit sheets (`Modal` + `bg-black/40` backdrop + a
 *  rounded-top panel). */
function ActionSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="max-h-[88%] rounded-t-2xl bg-surface p-4">
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-lg font-bold text-ink">{title}</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <Icon name="x" size={20} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** Pause/Resume — `why` is OPTIONAL per `setPledgeStatus`'s signature. */
function PauseResumeModal({
  pledge,
  target,
  onClose,
}: {
  pledge: PledgeRow;
  target: "active" | "paused";
  onClose: () => void;
}) {
  const setStatus = useMutation(api.givingPledges.setPledgeStatus);
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);
  const verb = target === "paused" ? "Pause" : "Resume";

  async function submit() {
    setSaving(true);
    try {
      await setStatus({
        pledgeId: pledge._id,
        status: target,
        why: why.trim() || undefined,
      });
      onClose();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionSheet title={`${verb} pledge`} onClose={onClose}>
      <Text className="mb-3 text-sm text-muted">
        {target === "paused"
          ? `${pledge.donorName}'s ${formatCents(pledge.amountCents)}/mo pledge stops counting toward the backer number immediately. Their Stripe subscription keeps billing in the background — cancel it in the Stripe portal to fully stop charges.`
          : `${pledge.donorName}'s ${formatCents(pledge.amountCents)}/mo pledge counts toward the backer number again.`}
      </Text>
      <TextField
        label="Reason (optional)"
        value={why}
        onChangeText={setWhy}
        placeholder="A note for the history…"
        multiline
      />
      <View className="mt-2 flex-row gap-2">
        <View className="flex-1">
          <Button title="Cancel" variant="secondary" onPress={onClose} />
        </View>
        <View className="flex-1">
          <Button title={verb} onPress={() => void submit()} loading={saving} />
        </View>
      </View>
    </ActionSheet>
  );
}

/** Edit since — `why` is REQUIRED per `editPledgeStartedAt`'s signature. */
function EditSinceModal({
  pledge,
  onClose,
}: {
  pledge: PledgeRow;
  onClose: () => void;
}) {
  const editStartedAt = useMutation(api.givingPledges.editPledgeStartedAt);
  const [startedAt, setStartedAt] = useState(pledge.startedAt ?? pledge.createdAt);
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!why.trim()) return;
    setSaving(true);
    try {
      await editStartedAt({ pledgeId: pledge._id, startedAt, why: why.trim() });
      onClose();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionSheet title="Edit since" onClose={onClose}>
      <Text className="mb-3 text-sm text-muted">
        Correct {pledge.donorName}'s pledge start date. Doesn't affect the
        backer count — just when they showed up on the timeline.
      </Text>
      <View className="mb-3">
        <Text className="mb-1 text-xs font-medium text-muted">Since</Text>
        <DateTimeField value={startedAt} onChange={setStartedAt} />
      </View>
      <TextField
        label="Why"
        value={why}
        onChangeText={setWhy}
        placeholder="e.g. Backfilled from the old Givebutter export"
        multiline
      />
      <View className="mt-2 flex-row gap-2">
        <View className="flex-1">
          <Button title="Cancel" variant="secondary" onPress={onClose} />
        </View>
        <View className="flex-1">
          <Button
            title="Save"
            onPress={() => void submit()}
            loading={saving}
            disabled={!why.trim()}
          />
        </View>
      </View>
    </ActionSheet>
  );
}

/** Delete — `why` is REQUIRED per `deletePledge`'s signature; a confirm step
 *  spells out what's removed (and what STAYS — the paid gifts). */
function DeletePledgeModal({
  pledge,
  onClose,
}: {
  pledge: PledgeRow;
  onClose: () => void;
}) {
  const deletePledge = useMutation(api.givingPledges.deletePledge);
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!why.trim()) return;
    setSaving(true);
    try {
      await deletePledge({ pledgeId: pledge._id, why: why.trim() });
      onClose();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionSheet title="Delete pledge" onClose={onClose}>
      <Text className="mb-3 text-sm text-ink">
        This removes {pledge.donorName}'s {formatCents(pledge.amountCents)}/mo
        pledge ({STATUS_LABELS[pledge.status]}) from the backers list.
      </Text>
      <Text className="mb-3 text-sm text-muted">
        Any billing cycles they already paid stay on the giving ledger as
        gifts — deleting the pledge only removes the subscription-state row,
        not the money they gave. Say why — a snapshot is kept on the record.
      </Text>
      <TextField
        label="Why are you deleting it?"
        value={why}
        onChangeText={setWhy}
        placeholder="e.g. Duplicate pledge from a re-signup"
        multiline
      />
      <View className="mt-2 flex-row gap-2">
        <View className="flex-1">
          <Button title="Cancel" variant="secondary" onPress={onClose} />
        </View>
        <View className="flex-1">
          <Button
            title="Delete pledge"
            variant="danger"
            onPress={() => void submit()}
            loading={saving}
            disabled={!why.trim()}
          />
        </View>
      </View>
    </ActionSheet>
  );
}

// ── Backer detail sheet — pledge summary + full lifecycle history ─────────────

const HISTORY_LABEL: Record<string, string> = {
  status: "Status changed",
  startedAt: "Since changed",
  deleted: "Deleted",
};

function BackerDetailSheet({
  pledge,
  onClose,
  onOpenDonor,
}: {
  pledge: PledgeRow;
  onClose: () => void;
  onOpenDonor: () => void;
}) {
  const history = useQuery(api.givingPledges.pledgeHistory, {
    pledgeId: pledge._id,
  });

  return (
    <ActionSheet title="Backer" onClose={onClose}>
      <View className="mb-3">
        <View className="flex-row items-center gap-2">
          <Text className="text-xl font-bold text-ink">{pledge.donorName}</Text>
          <Badge
            label={STATUS_LABELS[pledge.status]}
            tone={pledgeStatusTone(pledge.status)}
          />
        </View>
        <Text className="mt-1 text-sm text-muted">
          {formatCents(pledge.amountCents)}/mo
          {pledge.origin === "imported" ? " · Givebutter (awaiting re-signup)" : ""}
        </Text>
        <Text className="mt-1 text-xs text-faint">
          Since {new Date(pledge.startedAt ?? pledge.createdAt).toLocaleDateString()}
        </Text>
        <Button
          title="View donor"
          icon="user"
          size="sm"
          variant="secondary"
          onPress={onOpenDonor}
          className="mt-2 self-start"
        />
      </View>

      <Text className="mb-1 text-xs font-bold uppercase tracking-wider text-faint">
        History
      </Text>
      {history === undefined ? (
        <ActivityIndicator color={colors.accent} />
      ) : history.length === 0 ? (
        <Text className="text-sm text-muted">No history recorded yet.</Text>
      ) : (
        <View className="gap-2">
          {history.map((e) => (
            <View key={e._id} className="rounded-lg border border-border bg-raised p-2.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-semibold text-ink">
                  {e.from ? `${e.from} → ` : ""}
                  {e.to ?? HISTORY_LABEL[e.kind] ?? e.kind}
                </Text>
                <Text className="text-2xs text-muted">
                  {new Date(e.at).toLocaleString()}
                </Text>
              </View>
              <Text className="text-xs text-muted">by {e.actor}</Text>
              {e.note ? (
                <Text className="mt-0.5 text-xs italic text-muted">“{e.note}”</Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </ActionSheet>
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
