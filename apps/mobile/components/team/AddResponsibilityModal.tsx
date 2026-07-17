/**
 * AddResponsibilityModal — assign a duty from a person's page, fast.
 *
 * Pick WHO it lands on first: just this person (a direct assignment) or a
 * seat (or seats) it should reach through — org-chart seats fan a duty out
 * to everyone holding one, same model as the Duties grid's seat picker
 * (`DutiesGrid`'s `SeatPicker`, grouped Central/Chapter). Then either tap an
 * existing definition — the list shows only duties that don't already apply
 * to them — or type a new title and create it on the spot (ad-hoc cadence;
 * refine it later in the Duties tab).
 *
 * Only ever writes `assigneeSeatIds` — never a fresh `assigneeRoles` string.
 * Legacy role text is a read-only transition surface (see DutiesGrid); this
 * modal has no path to create more of it.
 */
import { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
} from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCE_LABELS,
  responsibilityAppliesTo,
  type SeatChart,
} from "@events-os/shared";
import { Icon, OptionTag } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

type ResponsibilityRow = Doc<"responsibilities">;
type SeatOption = { seatDefId: Id<"seatDefs">; title: string; chart: SeatChart };

export function AddResponsibilityModal({
  person,
  responsibilities,
  onClose,
}: {
  person: { _id: Id<"people">; name: string; role: string | null };
  /** All chapter definitions (the caller filters nothing — we do it here). */
  responsibilities: ResponsibilityRow[];
  onClose: () => void;
}) {
  const create = useMutation(api.responsibilities.create);
  const addAssignee = useMutation(api.responsibilities.addAssignee);
  const addSeat = useMutation(api.responsibilities.addSeat);
  const seatOptions = useQuery(api.responsibilities.seatOptions);
  const seatHoldings = useQuery(api.responsibilities.chapterSeatHoldings);
  // Only needed for the vacancy guard below (how many people a duty's legacy
  // role currently reaches) — mirrors what DutiesGrid's `people` query feeds
  // its own `holderCount`/`roleHolders` maps.
  const people = useQuery(api.people.list, {});
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<"person" | "seat">("person");
  const [selectedSeatIds, setSelectedSeatIds] = useState<Id<"seatDefs">[]>([]);
  const [seatPickerOpen, setSeatPickerOpen] = useState(false);

  // This person's own seat holdings — used only to filter the candidate list
  // below (a duty they already reach through a seat they hold shouldn't be
  // re-offered), the same seat-match `responsibilityAppliesTo` performs for
  // the Duties grid's holder counts.
  const personSeatIds = useMemo(
    () =>
      (seatHoldings ?? [])
        .filter((h) => h.personId === person._id)
        .map((h) => h.seatDefId),
    [seatHoldings, person._id],
  );
  const seatById = useMemo(
    () => new Map((seatOptions ?? []).map((s) => [s.seatDefId, s])),
    [seatOptions],
  );
  // Reverse seat→holders index — every holding, not just this modal's
  // `person` — for the vacancy guard below (is a seat about to be mapped
  // actually vacant?). Same shape as DutiesGrid's `holdersBySeat`.
  const holdersBySeat = useMemo(() => {
    const map = new Map<Id<"seatDefs">, Set<Id<"people">>>();
    for (const h of seatHoldings ?? []) {
      if (!map.has(h.seatDefId)) map.set(h.seatDefId, new Set());
      map.get(h.seatDefId)!.add(h.personId);
    }
    return map;
  }, [seatHoldings]);

  const q = query.trim().toLowerCase();
  // Only duties that DON'T already reach this person are offered.
  const candidates = responsibilities.filter((r) => {
    if (
      responsibilityAppliesTo(r, {
        _id: person._id,
        role: person.role,
        seatIds: personSeatIds,
      })
    ) {
      return false;
    }
    return !q || r.title.toLowerCase().includes(q);
  });
  // Scan ALL definitions, not just candidates — a title that already applies
  // to them is filtered from the list, and "Create" would duplicate it.
  const exactMatch = responsibilities.some(
    (r) => r.title.trim().toLowerCase() === q,
  );
  const canCreate = query.trim().length > 0 && !exactMatch;
  const seatTarget = target === "seat" && selectedSeatIds.length > 0;

  // How many people this duty currently reaches — role match or direct
  // assignment (seats are irrelevant here: this is only ever called when
  // `r.assigneeSeatIds` is still empty, so `responsibilityAppliesTo` falls
  // straight to the role/direct checks). Mirrors DutiesGrid's `holderCount`,
  // computed on demand for one row instead of memoized for the whole grid.
  function currentHolderCount(r: ResponsibilityRow): number {
    return (people ?? []).filter((p) =>
      responsibilityAppliesTo(r, { _id: p._id, role: p.role, seatIds: [] }),
    ).length;
  }

  // Union of everyone who already holds any of the given seats — used to
  // decide whether a seat mapping would leave a duty (or brand-new duty)
  // reaching nobody.
  function holdersOf(seatDefIds: Id<"seatDefs">[]): Set<Id<"people">> {
    const holders = new Set<Id<"people">>();
    for (const seatDefId of seatDefIds) {
      for (const personId of holdersBySeat.get(seatDefId) ?? []) {
        holders.add(personId);
      }
    }
    return holders;
  }

  async function assignExisting(r: ResponsibilityRow) {
    if (!seatTarget) {
      try {
        // Targeted, not a whole-array patch — safe against a concurrent edit
        // of the same definition's assignments.
        await addAssignee({ responsibilityId: r._id, personId: person._id });
        onClose();
      } catch (err) {
        alertError(err);
      }
      return;
    }

    const current = r.assigneeSeatIds ?? [];
    const newSeatIds = selectedSeatIds.filter((id) => !current.includes(id));
    if (newSeatIds.length === 0) {
      onClose();
      return;
    }
    const commitSeats = async () => {
      try {
        // Targeted, one seat at a time — mirrors DutiesGrid's addSeat usage,
        // safe against a concurrent edit of the same definition's seats.
        await Promise.all(
          newSeatIds.map((seatDefId) => addSeat({ responsibilityId: r._id, seatDefId })),
        );
        onClose();
      } catch (err) {
        alertError(err);
      }
    };
    // Same vacancy guard DutiesGrid's seat picker runs before a duty's FIRST
    // seat mapping (`guardedSeatChange`) — see `guardVacantSeatMapping` below.
    guardVacantSeatMapping({
      currentSeatCount: current.length,
      legacyRoles: r.assigneeRoles ?? [],
      legacyMatchCount: currentHolderCount(r),
      seatHolderCount: holdersOf(newSeatIds).size,
      commit: () => void commitSeats(),
    });
  }

  async function createNew() {
    const commitCreate = async () => {
      try {
        await create({
          title: query.trim(),
          cadence: "ad_hoc",
          ...(seatTarget
            ? { assigneeSeatIds: selectedSeatIds }
            : { assigneePersonIds: [person._id] }),
        });
        onClose();
      } catch (err) {
        alertError(err);
      }
    };

    if (seatTarget && holdersOf(selectedSeatIds).size === 0) {
      // Brand-new duty, so there's no legacy role to lose — just warn that
      // it won't reach anyone until the seat(s) are filled.
      confirmAction({
        title: "This seat is vacant",
        message: `No one currently holds ${
          selectedSeatIds.length === 1 ? "this seat" : "these seats"
        } — the duty won't reach anyone until someone fills it.`,
        confirmLabel: "Create anyway",
        destructive: true,
        onConfirm: () => void commitCreate(),
      });
      return;
    }
    await commitCreate();
  }

  const seatTagLabel =
    selectedSeatIds.length === 0
      ? "By seat…"
      : selectedSeatIds.length === 1
        ? (seatById.get(selectedSeatIds[0])?.title ?? "1 seat")
        : `${selectedSeatIds.length} seats`;

  return (
    <>
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable
          onPress={onClose}
          className="flex-1 items-center justify-center bg-ink/30 p-6"
        >
          <Pressable
            onPress={() => {}}
            className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
          >
            <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
              <Text className="font-display text-lg text-ink" numberOfLines={1}>
                Add duty
              </Text>
              <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>

            {/* Who does it land on? */}
            <View className="flex-row flex-wrap gap-2 border-b border-border px-5 py-3">
              <Pressable
                onPress={() => setTarget("person")}
                className={`rounded-pill border px-3 py-1.5 ${
                  target === "person"
                    ? "border-accent bg-accent-soft"
                    : "border-border bg-raised"
                }`}
              >
                <Text
                  className={`text-sm font-semibold ${
                    target === "person" ? "text-accent" : "text-muted"
                  }`}
                  numberOfLines={1}
                >
                  Just {person.name}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setTarget("seat");
                  setSeatPickerOpen(true);
                }}
                className={`rounded-pill border px-3 py-1.5 ${
                  target === "seat"
                    ? "border-accent bg-accent-soft"
                    : "border-border bg-raised"
                }`}
              >
                <Text
                  className={`text-sm font-semibold ${
                    target === "seat" ? "text-accent" : "text-muted"
                  }`}
                  numberOfLines={1}
                >
                  {seatTagLabel}
                </Text>
              </Pressable>
            </View>

            <View className="border-b border-border px-5 py-3">
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search duties, or type a new one…"
                placeholderTextColor={colors.faint}
                autoFocus
                autoCapitalize="sentences"
                className="rounded-md border border-border bg-raised px-3 py-2.5 text-base text-ink"
              />
            </View>

            <ScrollView className="max-h-96">
              {candidates.length === 0 && !canCreate ? (
                <Text className="px-5 py-6 text-center text-base text-muted">
                  {responsibilities.length === 0
                    ? "No duties defined yet — type a title to create the first."
                    : "Every matching duty already applies to them."}
                </Text>
              ) : (
                candidates.map((r) => (
                  <Pressable
                    key={r._id}
                    onPress={() => void assignExisting(r)}
                    className="flex-row items-center justify-between gap-3 border-b border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
                  >
                    <Text className="flex-1 text-base text-ink" numberOfLines={1}>
                      {r.title}
                    </Text>
                    <OptionTag
                      label={RESPONSIBILITY_CADENCE_LABELS[r.cadence]}
                      color={r.cadence === "ad_hoc" ? "gray" : "teal"}
                    />
                  </Pressable>
                ))
              )}
              {canCreate ? (
                <Pressable
                  onPress={() => void createNew()}
                  className="flex-row items-center gap-2 px-5 py-3 active:bg-sunken web:hover:bg-sunken"
                >
                  <Icon name="plus" size={15} color={colors.accent} />
                  <Text className="text-base font-medium text-accent">
                    Create “{query.trim()}”
                  </Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <DutySeatPicker
        visible={seatPickerOpen}
        seats={seatOptions ?? []}
        selectedIds={selectedSeatIds}
        onToggle={(seatDefId) =>
          setSelectedSeatIds((current) =>
            current.includes(seatDefId)
              ? current.filter((id) => id !== seatDefId)
              : [...current, seatDefId],
          )
        }
        onClose={() => {
          // Picking nothing isn't a valid seat target — fall back to the
          // person tab rather than leaving "seat" selected with 0 seats
          // (which would silently behave like a direct assignment anyway).
          setTarget((t) => (t === "seat" && selectedSeatIds.length === 0 ? "person" : t));
          setSeatPickerOpen(false);
        }}
      />
    </>
  );
}

/**
 * Mirrors `DutiesGrid`'s `guardedSeatChange` ADD/vacancy check — duplicated
 * locally (like `DutySeatPicker` below) since the grid's version is private
 * to `DutiesGrid.tsx` and this PR doesn't touch that file. Same warning
 * copy, same confirm flow (`confirmAction`) as the grid's seat picker.
 *
 * This modal only ever ADDS seats to a duty (never removes any), so only
 * the grid's ADD half is ported: mapping a duty's FIRST seat(s)
 * (`currentSeatCount === 0`, i.e. this add IS the mapping) onto seats
 * NOBODY currently holds (`seatHolderCount === 0`), while people still
 * reach the duty via a legacy role (`legacyMatchCount > 0`), would silently
 * drop it for them until someone fills the seat — warn first.
 */
function guardVacantSeatMapping({
  currentSeatCount,
  legacyRoles,
  legacyMatchCount,
  seatHolderCount,
  commit,
}: {
  currentSeatCount: number;
  legacyRoles: string[];
  legacyMatchCount: number;
  seatHolderCount: number;
  commit: () => void;
}) {
  if (currentSeatCount === 0 && seatHolderCount === 0 && legacyMatchCount > 0) {
    confirmAction({
      title: "This seat is vacant",
      message: `${legacyMatchCount} ${legacyMatchCount === 1 ? "person" : "people"} currently matched by "${legacyRoles.join(", ")}" will lose this duty until the seat is filled.`,
      confirmLabel: "Map anyway",
      destructive: true,
      onConfirm: commit,
    });
    return;
  }
  commit();
}

/**
 * Minimal seat multi-picker for this modal — mirrors `DutiesGrid`'s
 * `SeatPicker` (grouped Central seats / Chapter seats, toggles rather than
 * picking once and closing) but isn't imported from there since that
 * component is private to the grid. Duplicated on purpose per this PR's
 * scope: DutiesGrid isn't touched.
 */
function DutySeatPicker({
  visible,
  seats,
  selectedIds,
  onToggle,
  onClose,
}: {
  visible: boolean;
  seats: SeatOption[];
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
