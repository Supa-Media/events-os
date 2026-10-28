/**
 * DUTIES — the chapter's recurring duties: filter bar, list, detail panel.
 *
 * The body of the Duties screen (`/responsibilities`, its own nav entry). Each
 * row is a DEFINITION that fans out: assign it to org-chart SEATS ("Chapter
 * Director") and every person holding one of those seats gets it as an
 * individual duty on their Projects page; assign specific people when no seat
 * fits. The how-to is the handoff documentation; cadence says how often
 * (daily … yearly, or ad hoc).
 *
 * Layout (2026-10-28 redesign, replacing an eight-column grid that scrolled
 * sideways): tabs for the common questions (All / Needs attention / My seats /
 * Missing how-to), a filter bar (search, seat, chart, cadence, flags, sort,
 * group), a five-column list, and a detail panel for editing. The panel sits
 * beside the list on a wide window and opens as a full-screen sheet on a
 * phone. Filter rules live in `dutyFilters.logic.ts` (unit tested).
 *
 * The Roles transition: a duty created before seats existed still carries
 * legacy `assigneeRoles` strings, shown as muted read-only chips next to a
 * seat picker ("Map to seats"). Picking a seat calls the targeted
 * `responsibilities.addSeat` mutation, which clears the legacy strings the
 * FIRST time a duty gets any seat. See `responsibilityAppliesTo`
 * (`@events-os/shared`) for the matching rule: seats win over legacy roles the
 * instant a duty has any. Two guardrails sit in front of `addSeat`/`removeSeat`
 * (`guardedSeatChange` in `DutySeatPicker`).
 *
 * Self-contained: it owns its own queries + mutations. Callers gate
 * visibility (nav.canManage) — this component assumes the caller is allowed to
 * manage the catalog.
 *
 * ORG-WIDE ROWS (owner decision, 2026-07-17 — see `responsibilities.ts`'s
 * `orgWideCatalog`): `responsibilities.list` includes seat-mapped duties
 * AUTHORED BY OTHER CHAPTERS. Those rows carry `authoredByChapterName`
 * (non-null = foreign) and render READ-ONLY: a lock in the list, no editors in
 * the panel. This isn't cosmetic — every write gates on `requireOwned`
 * (authoring-chapter-only server-side).
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  Modal,
  View,
  Text,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCE_LABELS,
  responsibilityAppliesTo,
  normalizeRole,
} from "@events-os/shared";
import { Button, EmptyState, PersonPicker } from "../ui";
import { spacing } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { SeatPicker, guardedSeatChange } from "./DutySeatPicker";
import { DutyDetailPanel } from "./DutyDetailPanel";
import { DutyFilterBar } from "./DutyFilterBar";
import { DutyList } from "./DutyList";
import {
  DUTY_CADENCES,
  EMPTY_DUTY_FILTERS,
  filterDuties,
  groupDuties,
  inView,
  sortDuties,
  type DutyFacts,
  type DutyFilters,
  type DutyGroupBy,
  type DutySort,
  type DutyView,
} from "./dutyFilters.logic";

/** Window width at which the detail panel sits beside the list. */
const SIDE_PANEL_MIN = 1100;
/** Window width below which list rows fold their columns under the title. */
const COMPACT_LIST_MAX = 760;

export function DutiesGrid() {
  const nav = useQuery(api.org.nav);
  const responsibilities = useQuery(api.responsibilities.list);
  const people = useQuery(api.people.list, {});
  const seatOptions = useQuery(api.responsibilities.seatOptions);
  const seatHoldings = useQuery(api.responsibilities.chapterSeatHoldings);
  const create = useMutation(api.responsibilities.create);
  const addAssignee = useMutation(api.responsibilities.addAssignee);
  const addSeat = useMutation(api.responsibilities.addSeat);
  const removeSeat = useMutation(api.responsibilities.removeSeat);
  const { width } = useWindowDimensions();

  const [filters, setFilters] = useState<DutyFilters>(EMPTY_DUTY_FILTERS);
  const [sort, setSort] = useState<DutySort>("title");
  const [groupBy, setGroupBy] = useState<DutyGroupBy>("none");
  const [selectedId, setSelectedId] = useState<Id<"responsibilities"> | null>(null);
  // ONE picker of each kind for the whole page, acting on the selected duty.
  const [personPickerOpen, setPersonPickerOpen] = useState(false);
  const [seatPickerOpen, setSeatPickerOpen] = useState(false);

  const nameById = useMemo(
    () => new Map((people ?? []).map((p) => [p._id, p.name])),
    [people],
  );
  const seatById = useMemo(
    () => new Map((seatOptions ?? []).map((s) => [s.seatDefId, s])),
    [seatOptions],
  );
  // Which seats each person holds (their chapter's chapter-chart seats + every
  // central-chart seat — see `chapterSeatHoldings`).
  const personSeatIds = useMemo(() => {
    const map = new Map<Id<"people">, Id<"seatDefs">[]>();
    for (const h of seatHoldings ?? []) {
      map.set(h.personId, [...(map.get(h.personId) ?? []), h.seatDefId]);
    }
    return map;
  }, [seatHoldings]);
  // The reverse index — who holds THIS seat — for vacancy.
  const holdersBySeat = useMemo(() => {
    const map = new Map<Id<"seatDefs">, Set<Id<"people">>>();
    for (const h of seatHoldings ?? []) {
      if (!map.has(h.seatDefId)) map.set(h.seatDefId, new Set());
      map.get(h.seatDefId)!.add(h.personId);
    }
    return map;
  }, [seatHoldings]);
  // How many people hold each (normalized) LEGACY role — dangling-role
  // warnings on unmapped duties' muted chips.
  const roleHolders = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of people ?? []) {
      const role = normalizeRole(p.role);
      if (role) map.set(role, (map.get(role) ?? 0) + 1);
    }
    return map;
  }, [people]);

  // Each duty flattened into the facts the filters, list and panel read.
  const facts = useMemo((): DutyFacts[] => {
    return (responsibilities ?? []).map((r) => {
      const seatIds = (r.assigneeSeatIds as Id<"seatDefs">[] | undefined) ?? [];
      const seats = seatIds.map((id) => {
        const s = seatById.get(id);
        return {
          id,
          title: s?.title ?? "Seat",
          chart: s?.chart ?? ("central" as const),
          holders: holdersBySeat.get(id)?.size ?? 0,
        };
      });
      const holders = (people ?? []).filter((p) =>
        responsibilityAppliesTo(r, {
          _id: p._id,
          role: p.role,
          seatIds: personSeatIds.get(p._id),
        }),
      ).length;
      const directNames = (r.assigneePersonIds ?? []).map((id) => nameById.get(id) ?? "");
      return {
        id: r._id,
        title: r.title,
        cadence: r.cadence,
        seats,
        directCount: (r.assigneePersonIds ?? []).length,
        legacyRoles: seats.length === 0 ? (r.assigneeRoles ?? []) : [],
        hasHowTo: r.howToDoc != null,
        holders,
        searchText: [
          r.title,
          r.description ?? "",
          ...seats.map((s) => s.title),
          ...(r.assigneeRoles ?? []),
          ...directNames,
        ]
          .join(" ")
          .toLowerCase(),
      };
    });
  }, [responsibilities, people, seatById, holdersBySeat, personSeatIds, nameById]);

  const mySeatIds = useMemo(
    () =>
      new Set<string>(
        nav?.selfPersonId ? (personSeatIds.get(nav.selfPersonId) ?? []) : [],
      ),
    [nav, personSeatIds],
  );
  const foreignIds = useMemo(
    () =>
      new Set<string>(
        (responsibilities ?? [])
          .filter((r) => r.authoredByChapterName !== null)
          .map((r) => r._id),
      ),
    [responsibilities],
  );

  const filtered = useMemo(
    () => sortDuties(filterDuties(facts, filters, mySeatIds), sort),
    [facts, filters, mySeatIds, sort],
  );
  const groups = useMemo(
    () => groupDuties(filtered, groupBy, (c) => RESPONSIBILITY_CADENCE_LABELS[c]),
    [filtered, groupBy],
  );
  const viewCounts = useMemo(() => {
    const counts = {} as Record<DutyView, number>;
    for (const v of ["all", "attention", "mine", "howto"] as const) {
      counts[v] = facts.filter((d) => inView(d, v, mySeatIds)).length;
    }
    return counts;
  }, [facts, mySeatIds]);
  const cadenceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of DUTY_CADENCES) {
      counts[c] = facts.filter(
        (d) => d.cadence === c && inView(d, filters.view, mySeatIds),
      ).length;
    }
    return counts;
  }, [facts, filters.view, mySeatIds]);
  const seatFilterOptions = useMemo(
    () =>
      [...(seatOptions ?? [])]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((s) => ({
          id: s.seatDefId as string,
          title: s.title,
          chart: s.chart,
          vacant: (holdersBySeat.get(s.seatDefId)?.size ?? 0) === 0,
        })),
    [seatOptions, holdersBySeat],
  );

  if (responsibilities === undefined || people === undefined) {
    return (
      <View style={{ paddingVertical: spacing.lg }}>
        <Text className="text-sm text-faint">Loading duties…</Text>
      </View>
    );
  }

  const selected = responsibilities.find((r) => r._id === selectedId) ?? null;
  const selectedFacts = facts.find((d) => d.id === selectedId) ?? null;
  const sidePanel = width >= SIDE_PANEL_MIN;

  const addDuty = () => {
    // A live filter would hide the new row — clear it first.
    setFilters({ ...EMPTY_DUTY_FILTERS });
    void create({ title: "New duty" })
      .then((id) => setSelectedId(id))
      .catch(alertError);
  };

  const panel = selected ? (
    <DutyDetailPanel
      key={selected._id}
      row={selected}
      holders={selectedFacts?.holders ?? 0}
      vacantSeatTitles={(selectedFacts?.seats ?? [])
        .filter((s) => s.holders === 0)
        .map((s) => s.title)}
      nameById={nameById}
      seatById={seatById}
      roleHolders={roleHolders}
      onOpenPersonPicker={() => setPersonPickerOpen(true)}
      onOpenSeatPicker={() => setSeatPickerOpen(true)}
      onClose={() => setSelectedId(null)}
      people={people}
      seatHoldings={seatHoldings ?? []}
      seatOptions={seatOptions ?? []}
    />
  ) : null;

  // Rendered inside whichever surface holds the panel, so on a phone they
  // present over the panel's own modal instead of beside it.
  const pickers = selected ? (
    <>
      <PersonPicker
        visible={personPickerOpen}
        title="Assign to person"
        onPick={(personId) => {
          setPersonPickerOpen(false);
          void addAssignee({
            responsibilityId: selected._id,
            personId: personId as Id<"people">,
          }).catch(alertError);
        }}
        onClose={() => setPersonPickerOpen(false)}
      />
      <SeatPicker
        visible={seatPickerOpen}
        seats={seatOptions ?? []}
        selectedIds={(selected.assigneeSeatIds as Id<"seatDefs">[] | undefined) ?? []}
        onToggle={(seatDefId) => {
          const current = selected.assigneeSeatIds ?? [];
          const isAdding = !current.includes(seatDefId);
          guardedSeatChange({
            isAdding,
            currentSeatCount: current.length,
            legacyRoles: selected.assigneeRoles ?? [],
            legacyMatchCount: selectedFacts?.holders ?? 0,
            seatHolderCount: holdersBySeat.get(seatDefId)?.size ?? 0,
            commit: () => {
              const mutate = isAdding ? addSeat : removeSeat;
              void mutate({
                responsibilityId: selected._id,
                seatDefId,
              }).catch(alertError);
            },
          });
        }}
        onClose={() => setSeatPickerOpen(false)}
      />
    </>
  ) : null;

  return (
    <View style={{ gap: spacing.lg }}>
      <View
        className="flex-row flex-wrap items-end justify-between"
        style={{ gap: spacing.sm }}
      >
        <View style={{ gap: 2 }}>
          <Text className="font-display text-2xl text-ink">Duties</Text>
          <Text className="text-sm text-muted">
            {responsibilities.length} ongoing. Map each to a seat and whoever
            holds the seat picks it up.
          </Text>
        </View>
        <Button title="Add duty" icon="plus" onPress={addDuty} />
      </View>

      <DutyFilterBar
        filters={filters}
        onChange={setFilters}
        sort={sort}
        onSort={setSort}
        groupBy={groupBy}
        onGroupBy={setGroupBy}
        viewCounts={viewCounts}
        cadenceCounts={cadenceCounts}
        seats={seatFilterOptions}
        shown={filtered.length}
        total={facts.length}
      />

      {responsibilities.length === 0 ? (
        <EmptyState
          title="Document the recurring work"
          message="e.g. “Meet with directs — bi-weekly — Chapter Director” or “Create event flyers — ad hoc — Communications”. Assign to seats so one row covers everyone holding it."
        />
      ) : (
        <View className="flex-row items-start" style={{ gap: spacing.lg }}>
          <View className="flex-1 overflow-hidden rounded-lg border border-border bg-raised">
            {filtered.length === 0 ? (
              <View className="items-center px-4 py-10" style={{ gap: spacing.sm }}>
                <Text className="text-base font-semibold text-ink">
                  No duties match these filters
                </Text>
                <Button
                  title="Clear filters"
                  size="sm"
                  variant="secondary"
                  onPress={() => setFilters({ ...EMPTY_DUTY_FILTERS })}
                />
              </View>
            ) : (
              <DutyList
                groups={groups}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id as Id<"responsibilities">)}
                foreignIds={foreignIds}
                compact={width < COMPACT_LIST_MAX || (sidePanel && selected != null && width < 1400)}
              />
            )}
          </View>
          {sidePanel && panel ? (
            <View
              className="rounded-lg border border-border bg-raised p-5"
              style={{ width: 400 }}
            >
              {panel}
              {pickers}
            </View>
          ) : null}
        </View>
      )}

      {!sidePanel ? (
        <PanelSheet visible={panel != null} onClose={() => setSelectedId(null)}>
          {panel}
          {pickers}
        </PanelSheet>
      ) : null}
    </View>
  );
}

/** The detail panel's phone surface: a full-screen sheet. */
function PanelSheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <ScrollView
        className="flex-1 bg-raised"
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </Modal>
  );
}
