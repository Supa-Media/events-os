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

  async function assignExisting(r: ResponsibilityRow) {
    try {
      if (seatTarget) {
        // Targeted, one seat at a time — mirrors DutiesGrid's addSeat usage,
        // safe against a concurrent edit of the same definition's seats.
        const current = r.assigneeSeatIds ?? [];
        await Promise.all(
          selectedSeatIds
            .filter((seatDefId) => !current.includes(seatDefId))
            .map((seatDefId) => addSeat({ responsibilityId: r._id, seatDefId })),
        );
      } else {
        // Targeted, not a whole-array patch — safe against a concurrent edit
        // of the same definition's assignments.
        await addAssignee({ responsibilityId: r._id, personId: person._id });
      }
      onClose();
    } catch (err) {
      alertError(err);
    }
  }

  async function createNew() {
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
