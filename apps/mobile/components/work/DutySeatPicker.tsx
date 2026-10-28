/**
 * Seat mapping pieces shared by the Duties page: the seat chips (with the
 * legacy-role transition chips), the multi-select seat picker, and the two
 * mapping guardrails that sit in front of `addSeat` / `removeSeat`. Split out
 * of `DutiesGrid` so the page and its detail panel stay under the file-size
 * budget.
 */
import { Modal, View, Text, Pressable, ScrollView } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { normalizeRole } from "@events-os/shared";
import { Icon, OptionTag } from "../ui";
import { colors } from "../../lib/theme";
import { confirmAction } from "../event/ticketing/helpers";

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
export function guardedSeatChange({
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


/**
 * Seat chips + legacy-role transition chips. A duty with `assigneeSeatIds`
 * shows ONLY seat chips (purple, removable) — seats are authoritative once
 * mapped. A duty with no seats yet but legacy `assigneeRoles` shows those
 * strings as muted, read-only "(legacy)" chips: there's no editor for them
 * anymore, only the seat picker ("Map to seats"), which replaces them in one
 * edit. A duty with neither shows "—" and a plain "+".
 */
export function SeatsCell({
  seatIds,
  legacyRoles,
  seatById,
  roleHolders,
  readOnly = false,
  onOpenPicker,
  onRemoveSeat,
}: {
  seatIds: Id<"seatDefs">[];
  legacyRoles: string[];
  seatById: Map<Id<"seatDefs">, { title: string; chart: "central" | "chapter" }>;
  roleHolders: Map<string, number>;
  /** A FOREIGN (org-wide, another chapter's) row: chips only, no remove ✕ and
   *  no "+"/"Map to seats" affordance — this chapter can't edit it. */
  readOnly?: boolean;
  onOpenPicker: () => void;
  onRemoveSeat: (seatDefId: Id<"seatDefs">) => void;
}) {
  const hasSeats = seatIds.length > 0;
  const unmappedLegacy = !hasSeats && legacyRoles.length > 0;

  return (
    <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
      {hasSeats
        ? seatIds.map((seatDefId) =>
            readOnly ? (
              <OptionTag
                key={seatDefId}
                label={seatById.get(seatDefId)?.title ?? "Seat"}
                color="purple"
              />
            ) : (
              <OptionTag
                key={seatDefId}
                label={seatById.get(seatDefId)?.title ?? "Seat"}
                color="purple"
                onRemove={() => onRemoveSeat(seatDefId)}
              />
            ),
          )
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
      {readOnly ? null : unmappedLegacy ? (
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
export function SeatPicker({
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
