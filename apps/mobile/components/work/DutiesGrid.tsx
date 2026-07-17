/**
 * DUTIES GRID — the chapter's recurring duties as a database grid.
 *
 * Extracted from the Duties screen so it can render both there (its own route,
 * kept for deep links) and inside the Work tab's Duties segment. Each row is a
 * DEFINITION that fans out: assign it to org-chart SEATS ("Chapter Director")
 * and every person holding one of those seats gets it as an individual duty on
 * their Work page; assign specific people when no seat fits. The How-to column
 * is the handoff documentation; cadence says how often (daily … yearly, or ad
 * hoc).
 *
 * The Roles column is a TRANSITION surface: a duty created before seats
 * existed still carries legacy `assigneeRoles` strings, shown here as muted
 * read-only chips next to a seat picker ("Map to seats"). Picking a seat calls
 * the targeted `responsibilities.addSeat` mutation (mirrors `addAssignee` —
 * read-modify-write inside the transaction, not a whole-array patch), which
 * clears the legacy strings in the same edit the FIRST time a duty gets any
 * seat — there's no way to add a NEW legacy role string from this grid; the
 * seat picker IS the Roles column once a duty is created. See
 * `responsibilityAppliesTo` (`@events-os/shared`) for the matching rule this
 * UI mirrors: seats win over legacy roles the instant a duty has any.
 *
 * Two guardrails sit in front of `addSeat`/`removeSeat` (`guardedSeatChange`):
 * mapping a duty onto a seat NOBODY currently holds warns that the people it
 * currently reaches via the legacy role lose it until the seat is filled;
 * removing a duty's last seat once its legacy strings are already gone warns
 * that it'll apply to nobody. Both are one-tap-to-proceed confirmations, not
 * hard blocks — an owner can still map onto a vacant seat on purpose.
 *
 * Self-contained: it owns its own queries + mutations, so both mount points
 * render `<DutiesGrid />` with no wiring. Callers gate visibility (nav.canManage)
 * — this component assumes the caller is allowed to manage the catalog.
 */
import { useMemo, useState } from "react";
import { Modal, View, Text, Pressable, ScrollView } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCES,
  RESPONSIBILITY_CADENCE_LABELS,
  responsibilityAppliesTo,
  normalizeRole,
  type ResponsibilityCadence,
} from "@events-os/shared";
import {
  Narrow,
  TextField,
  EmptyState,
  Icon,
  OptionTag,
  InlineText,
  GridHeaderCell,
  SelectCell,
  PersonPicker,
  type SelectOption,
} from "../ui";
import {
  HowToDocCell,
  type HowToDocSummary,
} from "../team/HowToDocCell";
import { colors, spacing } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

const CADENCE_OPTIONS: SelectOption<ResponsibilityCadence>[] =
  RESPONSIBILITY_CADENCES.map((c) => ({
    value: c,
    label: RESPONSIBILITY_CADENCE_LABELS[c],
    color: c === "ad_hoc" ? "gray" : "teal",
  }));

type Responsibility = Doc<"responsibilities"> & {
  howToDoc: HowToDocSummary | null;
};

// Fixed column widths (px) — mirrors the People grid's chrome.
const COLS = {
  title: 230,
  cadence: 120,
  roles: 210,
  people: 230,
  holders: 90,
  howTo: 280,
  description: 240,
  notes: 200,
} as const;
const DELETE_W = 38;
const TABLE_WIDTH =
  Object.values(COLS).reduce((sum, w) => sum + w, 0) + DELETE_W;

/**
 * Mapping-flow guardrails, shared by the seat picker's toggle and a seat
 * chip's ✕ — both are one seat-at-a-time edits, so both need the same two
 * checks before committing:
 *
 *  1. ADDING a seat that's the duty's FIRST seat (`currentSeatCount === 0`,
 *     i.e. this click IS the mapping) onto a seat nobody currently holds
 *     (`seatHolderCount === 0`) — when the duty still had people reaching it
 *     via the (about-to-be-abandoned) legacy role match (`legacyMatchCount >
 *     0`), warn that they're about to lose it until the seat is filled.
 *  2. REMOVING the duty's LAST seat (`currentSeatCount === 1`) when its
 *     legacy roles are already cleared (`legacyRoles.length === 0`, always
 *     true once a duty has been mapped) — warn that the duty will apply to
 *     nobody (barring direct assignees).
 *
 * Neither check applies to any other add/remove (adding a 2nd+ seat, or
 * removing down to 1+ remaining) — `commit()` runs immediately for those.
 */
function guardedSeatChange({
  isAdding,
  currentSeatCount,
  legacyRoles,
  legacyMatchCount = 0,
  seatHolderCount = 0,
  commit,
}: {
  isAdding: boolean;
  currentSeatCount: number;
  legacyRoles: string[];
  /** How many people currently reach this duty via `legacyRoles` — only
   *  needed for the ADD/vacancy check. */
  legacyMatchCount?: number;
  /** How many people hold the seat being added — only needed for the
   *  ADD/vacancy check. */
  seatHolderCount?: number;
  commit: () => void;
}) {
  if (
    isAdding &&
    currentSeatCount === 0 &&
    seatHolderCount === 0 &&
    legacyMatchCount > 0
  ) {
    confirmAction({
      title: "This seat is vacant",
      message: `${legacyMatchCount} ${legacyMatchCount === 1 ? "person" : "people"} currently matched by "${legacyRoles.join(", ")}" will lose this duty until the seat is filled.`,
      confirmLabel: "Map anyway",
      destructive: true,
      onConfirm: commit,
    });
    return;
  }
  if (!isAdding && currentSeatCount === 1 && legacyRoles.length === 0) {
    confirmAction({
      title: "Remove the last seat?",
      message:
        "This duty will apply to nobody (unless someone is directly assigned) — the old role text is gone.",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: commit,
    });
    return;
  }
  commit();
}

export function DutiesGrid({
  header = "full",
}: {
  /**
   * "full" renders the standalone route's own title block; "compact" renders
   * just the search + count row for embedding under the Work tab's header
   * (which already says where you are — a second title read as two screens
   * stacked on top of each other).
   */
  header?: "full" | "compact";
} = {}) {
  const responsibilities = useQuery(api.responsibilities.list);
  const people = useQuery(api.people.list, {});
  const seatOptions = useQuery(api.responsibilities.seatOptions);
  const seatHoldings = useQuery(api.responsibilities.chapterSeatHoldings);
  const create = useMutation(api.responsibilities.create);
  const addAssignee = useMutation(api.responsibilities.addAssignee);
  // Grid-level (not per-row): the seat picker below lives at the grid, not
  // inside any one `ResponsibilityRow`. Targeted, like addAssignee/
  // removeAssignee — never a whole-array `update({ assigneeSeatIds })`.
  const addSeat = useMutation(api.responsibilities.addSeat);
  const removeSeat = useMutation(api.responsibilities.removeSeat);

  const [search, setSearch] = useState("");
  // ONE picker for the whole grid (a per-row picker would mount a hidden
  // Modal + roster watcher on every row); rows just say which row it's for.
  const [pickerForRow, setPickerForRow] =
    useState<Id<"responsibilities"> | null>(null);
  // Same one-picker-for-the-grid reasoning for the seat picker.
  const [seatPickerForRow, setSeatPickerForRow] =
    useState<Id<"responsibilities"> | null>(null);

  const nameById = useMemo(
    () => new Map((people ?? []).map((p) => [p._id, p.name])),
    [people],
  );

  // Seat title + chart, by seatDefId — chip labels and the picker's
  // Central/Chapter grouping.
  const seatById = useMemo(
    () => new Map((seatOptions ?? []).map((s) => [s.seatDefId, s])),
    [seatOptions],
  );

  // Which seats each person holds (their own chapter's chapter-chart seats +
  // every central-chart seat — see `chapterSeatHoldings`), for resolving
  // `responsibilityAppliesTo`'s seat-based match.
  const personSeatIds = useMemo(() => {
    const map = new Map<Id<"people">, Id<"seatDefs">[]>();
    for (const h of seatHoldings ?? []) {
      map.set(h.personId, [...(map.get(h.personId) ?? []), h.seatDefId]);
    }
    return map;
  }, [seatHoldings]);

  // The reverse index — who holds THIS seat — for the mapping-flow vacancy
  // guardrail (is the seat being mapped actually vacant?).
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

  // How many people each row currently fans out to (seat/role match + direct).
  const holderCount = useMemo(() => {
    const map = new Map<Id<"responsibilities">, number>();
    for (const r of responsibilities ?? []) {
      map.set(
        r._id,
        (people ?? []).filter((p) =>
          responsibilityAppliesTo(r, {
            _id: p._id,
            role: p.role,
            seatIds: personSeatIds.get(p._id),
          }),
        ).length,
      );
    }
    return map;
  }, [responsibilities, people, personSeatIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return responsibilities ?? [];
    return (responsibilities ?? []).filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.assigneeRoles ?? []).some((role) =>
          role.toLowerCase().includes(q),
        ),
    );
  }, [responsibilities, search]);

  if (responsibilities === undefined || people === undefined) {
    return (
      <Narrow>
        <View style={{ paddingVertical: spacing.lg }}>
          <Text className="text-sm text-faint">Loading duties…</Text>
        </View>
      </Narrow>
    );
  }

  return (
    <>
      <Narrow>
        {header === "full" ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: spacing.md,
            }}
          >
            <Text className="font-display text-2xl text-ink">Duties</Text>
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {responsibilities.length} ongoing
            </Text>
          </View>
        ) : (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "flex-end",
              marginBottom: spacing.sm,
            }}
          >
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {responsibilities.length} ongoing
            </Text>
          </View>
        )}
        <TextField
          placeholder="Search by title or role…"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
        />
      </Narrow>

      {/* The grid */}
      <View className="overflow-hidden rounded-lg border border-border bg-raised">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ width: Math.max(TABLE_WIDTH, 320) }}>
            <View className="flex-row items-center border-b border-border bg-sunken">
              <GridHeaderCell label="Duty" width={COLS.title} />
              <GridHeaderCell label="Cadence" width={COLS.cadence} />
              <GridHeaderCell label="Roles" width={COLS.roles} />
              <GridHeaderCell label="People" width={COLS.people} />
              <GridHeaderCell label="Holders" width={COLS.holders} />
              <GridHeaderCell label="How to" width={COLS.howTo} />
              <GridHeaderCell label="Description" width={COLS.description} />
              <GridHeaderCell label="Notes" width={COLS.notes} />
              <View style={{ width: DELETE_W }} />
            </View>

            {responsibilities.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No duties yet — add the ongoing work your team runs on
                  below.
                </Text>
              </View>
            ) : filtered.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  Nothing matches your search.
                </Text>
              </View>
            ) : (
              filtered.map((r, i) => (
                <ResponsibilityRow
                  key={r._id}
                  row={r}
                  nameById={nameById}
                  seatById={seatById}
                  roleHolders={roleHolders}
                  holders={holderCount.get(r._id) ?? 0}
                  isLast={i === filtered.length - 1}
                  onOpenPicker={() => setPickerForRow(r._id)}
                  onOpenSeatPicker={() => setSeatPickerForRow(r._id)}
                />
              ))
            )}
          </View>
        </ScrollView>

        {/* Add row */}
        <Pressable
          onPress={() => {
            // A live search filter would hide the new row — clear it first.
            setSearch("");
            void create({ title: "New duty" }).catch(alertError);
          }}
          className="flex-row items-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">
            Add duty
          </Text>
        </Pressable>
      </View>

      {responsibilities.length === 0 ? (
        <Narrow>
          <View style={{ marginTop: spacing.md }}>
            <EmptyState
              title="Document the recurring work"
              message="e.g. “Meet with directs — bi-weekly — Chapter Director” or “Create event flyers — ad hoc — Communications”. Assign to seats so one row covers everyone holding it."
            />
          </View>
        </Narrow>
      ) : null}

      <PersonPicker
        visible={pickerForRow !== null}
        title="Assign to person"
        onPick={(personId) => {
          const row = responsibilities.find((r) => r._id === pickerForRow);
          setPickerForRow(null);
          if (!row) return;
          // Targeted membership write — safe against concurrent edits of the
          // same definition's assignments (server no-ops when already there).
          void addAssignee({
            responsibilityId: row._id,
            personId: personId as Id<"people">,
          }).catch(alertError);
        }}
        onClose={() => setPickerForRow(null)}
      />

      <SeatPicker
        visible={seatPickerForRow !== null}
        seats={seatOptions ?? []}
        selectedIds={
          (responsibilities.find((r) => r._id === seatPickerForRow)
            ?.assigneeSeatIds as Id<"seatDefs">[] | undefined) ?? []
        }
        onToggle={(seatDefId) => {
          const row = responsibilities.find((r) => r._id === seatPickerForRow);
          if (!row) return;
          const current = row.assigneeSeatIds ?? [];
          const isAdding = !current.includes(seatDefId);
          guardedSeatChange({
            isAdding,
            currentSeatCount: current.length,
            legacyRoles: row.assigneeRoles ?? [],
            legacyMatchCount: holderCount.get(row._id) ?? 0,
            seatHolderCount: holdersBySeat.get(seatDefId)?.size ?? 0,
            commit: () => {
              const mutate = isAdding ? addSeat : removeSeat;
              void mutate({
                responsibilityId: row._id,
                seatDefId,
              }).catch(alertError);
            },
          });
        }}
        onClose={() => setSeatPickerForRow(null)}
      />
    </>
  );
}

function ResponsibilityRow({
  row,
  nameById,
  seatById,
  roleHolders,
  holders,
  isLast,
  onOpenPicker,
  onOpenSeatPicker,
}: {
  row: Responsibility;
  nameById: Map<Id<"people">, string>;
  seatById: Map<Id<"seatDefs">, { title: string; chart: "central" | "chapter" }>;
  roleHolders: Map<string, number>;
  holders: number;
  isLast: boolean;
  onOpenPicker: () => void;
  onOpenSeatPicker: () => void;
}) {
  const updateMutation = useMutation(api.responsibilities.update);
  const removeMutation = useMutation(api.responsibilities.remove);
  const removeAssignee = useMutation(api.responsibilities.removeAssignee);
  const removeSeatMutation = useMutation(api.responsibilities.removeSeat);
  const id = row._id;

  const update = (args: Omit<Parameters<typeof updateMutation>[0], "responsibilityId">) => {
    void updateMutation({ responsibilityId: id, ...args }).catch(alertError);
  };

  return (
    <View
      className={`flex-row items-stretch border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      }`}
    >
      {/* Title */}
      <Cell width={COLS.title}>
        <InlineText
          value={row.title}
          placeholder="Duty"
          weight="medium"
          onCommit={(t) => {
            if (t.trim()) update({ title: t.trim() });
          }}
        />
      </Cell>

      {/* Cadence */}
      <Cell width={COLS.cadence}>
        <SelectCell
          value={row.cadence}
          options={CADENCE_OPTIONS}
          onChange={(cadence) => update({ cadence })}
        />
      </Cell>

      {/* Assignee seats (fan-out, current model): read-only chips resolved
          from `assigneeSeatIds`, plus a seat picker. A duty not yet mapped to
          seats shows its LEGACY `assigneeRoles` strings muted — read-only,
          nothing here can add a new one — next to the same picker, which is
          the one-time mapping flow ("Map to seats"). */}
      <Cell width={COLS.roles}>
        <SeatsCell
          seatIds={(row.assigneeSeatIds as Id<"seatDefs">[] | undefined) ?? []}
          legacyRoles={row.assigneeRoles ?? []}
          seatById={seatById}
          roleHolders={roleHolders}
          onOpenPicker={onOpenSeatPicker}
          onRemoveSeat={(seatDefId) => {
            const current =
              (row.assigneeSeatIds as Id<"seatDefs">[] | undefined) ?? [];
            guardedSeatChange({
              isAdding: false,
              currentSeatCount: current.length,
              legacyRoles: row.assigneeRoles ?? [],
              commit: () => {
                void removeSeatMutation({
                  responsibilityId: id,
                  seatDefId,
                }).catch(alertError);
              },
            });
          }}
        />
      </Cell>

      {/* Directly-assigned people: chips + picker */}
      <Cell width={COLS.people}>
        <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
          {(row.assigneePersonIds ?? []).map((pid) => (
            <OptionTag
              key={pid}
              label={nameById.get(pid) ?? "?"}
              onRemove={() =>
                void removeAssignee({
                  responsibilityId: id,
                  personId: pid,
                }).catch(alertError)
              }
            />
          ))}
          <Pressable
            onPress={onOpenPicker}
            hitSlop={6}
            accessibilityLabel="Assign a person"
            className="rounded p-0.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="plus" size={13} color={colors.faint} />
          </Pressable>
        </View>
      </Cell>

      {/* Fan-out count (derived, read-only) */}
      <Cell width={COLS.holders}>
        <Text className={`px-2 text-sm ${holders > 0 ? "text-ink" : "text-faint"}`}>
          {holders > 0 ? holders : "—"}
        </Text>
      </Cell>

      {/* How to (the handoff doc): link / video / note / markdown page —
          the same doc primitive behind event-grid How-To cells. */}
      <Cell width={COLS.howTo}>
        <HowToDocCell
          doc={row.howToDoc}
          onSetDoc={(docId) =>
            update(docId ? { howToDocId: docId } : { howToDocId: null })
          }
        />
      </Cell>

      {/* Description */}
      <Cell width={COLS.description}>
        <InlineText
          value={row.description ?? ""}
          placeholder="—"
          onCommit={(t) => update({ description: t.trim() || null })}
        />
      </Cell>

      {/* Notes */}
      <Cell width={COLS.notes}>
        <InlineText
          value={row.notes ?? ""}
          placeholder="—"
          onCommit={(t) => update({ notes: t.trim() || null })}
        />
      </Cell>

      {/* Delete gutter */}
      <View style={{ width: DELETE_W }} className="items-center justify-center">
        <Pressable
          onPress={() =>
            confirmAction({
              title: "Delete duty?",
              message: `"${row.title || "This duty"}" will be removed for everyone holding it.`,
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => {
                void removeMutation({ responsibilityId: id }).catch(alertError);
              },
            })
          }
          hitSlop={4}
          accessibilityLabel="Delete duty"
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

/**
 * Seat chips + legacy-role transition chips. A duty with `assigneeSeatIds`
 * shows ONLY seat chips (purple, removable) — seats are authoritative once
 * mapped. A duty with no seats yet but legacy `assigneeRoles` shows those
 * strings as muted, read-only "(legacy)" chips: there's no editor for them
 * anymore, only the seat picker ("Map to seats"), which replaces them in one
 * edit. A duty with neither shows "—" and a plain "+".
 */
function SeatsCell({
  seatIds,
  legacyRoles,
  seatById,
  roleHolders,
  onOpenPicker,
  onRemoveSeat,
}: {
  seatIds: Id<"seatDefs">[];
  legacyRoles: string[];
  seatById: Map<Id<"seatDefs">, { title: string; chart: "central" | "chapter" }>;
  roleHolders: Map<string, number>;
  onOpenPicker: () => void;
  onRemoveSeat: (seatDefId: Id<"seatDefs">) => void;
}) {
  const hasSeats = seatIds.length > 0;
  const unmappedLegacy = !hasSeats && legacyRoles.length > 0;

  return (
    <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
      {hasSeats
        ? seatIds.map((seatDefId) => (
            <OptionTag
              key={seatDefId}
              label={seatById.get(seatDefId)?.title ?? "Seat"}
              color="purple"
              onRemove={() => onRemoveSeat(seatDefId)}
            />
          ))
        : null}
      {unmappedLegacy
        ? legacyRoles.map((s) => {
            const holds = (roleHolders.get(normalizeRole(s)) ?? 0) > 0;
            return (
              <OptionTag
                key={s}
                label={holds ? `${s} (legacy)` : `${s} — no one holds this role`}
                color={holds ? "gray" : "red"}
              />
            );
          })
        : null}
      {!hasSeats && legacyRoles.length === 0 ? (
        <Text className="text-sm text-faint">—</Text>
      ) : null}
      {unmappedLegacy ? (
        <Pressable
          onPress={onOpenPicker}
          hitSlop={4}
          className="rounded px-1 py-0.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Text className="text-2xs font-semibold text-accent">
            Map to seats
          </Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={onOpenPicker}
          hitSlop={6}
          accessibilityLabel="Add a seat"
          className="rounded p-0.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={13} color={colors.faint} />
        </Pressable>
      )}
    </View>
  );
}

/**
 * Multi-select seat picker, grouped Central seats / Chapter seats — mirrors
 * `RolePicker`'s centered-modal chrome, but toggles (stays open across
 * multiple picks) instead of picking once and closing, since a duty commonly
 * fans out to more than one seat.
 */
function SeatPicker({
  visible,
  seats,
  selectedIds,
  onToggle,
  onClose,
}: {
  visible: boolean;
  seats: { seatDefId: Id<"seatDefs">; title: string; chart: "central" | "chapter" }[];
  selectedIds: Id<"seatDefs">[];
  onToggle: (seatDefId: Id<"seatDefs">) => void;
  onClose: () => void;
}) {
  const central = seats.filter((s) => s.chart === "central");
  const chapter = seats.filter((s) => s.chart === "chapter");
  const selected = new Set(selectedIds);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">
              Assign to seats
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-96">
            {seats.length === 0 ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                No seats defined yet — set up the org chart first.
              </Text>
            ) : (
              <>
                {central.length > 0 ? <SeatGroupHeader label="Central seats" /> : null}
                {central.map((s) => (
                  <SeatOptionRow
                    key={s.seatDefId}
                    label={s.title}
                    selected={selected.has(s.seatDefId)}
                    onPress={() => onToggle(s.seatDefId)}
                  />
                ))}
                {chapter.length > 0 ? <SeatGroupHeader label="Chapter seats" /> : null}
                {chapter.map((s) => (
                  <SeatOptionRow
                    key={s.seatDefId}
                    label={s.title}
                    selected={selected.has(s.seatDefId)}
                    onPress={() => onToggle(s.seatDefId)}
                  />
                ))}
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SeatGroupHeader({ label }: { label: string }) {
  return (
    <View className="border-b border-border bg-sunken px-5 py-1.5">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
    </View>
  );
}

function SeatOptionRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between border-b border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
    >
      <Text
        className={`text-base ${selected ? "font-semibold text-accent" : "text-ink"}`}
      >
        {label}
      </Text>
      {selected ? <Icon name="check" size={16} color={colors.accent} /> : null}
    </Pressable>
  );
}
