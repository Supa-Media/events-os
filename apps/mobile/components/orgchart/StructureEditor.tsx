/**
 * Org chart STRUCTURE editor UI — the "Edit structure" mode's affordances:
 * add a seat under a parent, rename, edit duties/capabilities/maxHolders,
 * reparent, and remove. Every mutation here is `seatStructure.ts`'s, gated
 * server-side by `org.editChart` (or superuser) — this file does no gating
 * of its own beyond what the screen decides to render (see `org-chart.tsx`'s
 * `canEditStructure`).
 *
 * Every failure surfaces the backend's `ConvexError` message VERBATIM
 * (`alertError`) — the occupied/duty-ref/self-lockout/cycle/global-lockout
 * messages are written in plain language for the editor seeing them, so
 * there's no local re-wording to keep in sync.
 */
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { MULTI_HOLDER_CAP, SEAT_CAPABILITIES, SEAT_ROOT, type SeatCapability } from "@events-os/shared";
import { Button, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";
import { capabilityLabel } from "./treeUtils";

// ── Amber "editing" banner ───────────────────────────────────────────────────

export function StructureEditBanner() {
  return (
    <View className="mb-4 flex-row items-start gap-3 rounded-lg border border-warn bg-warn-bg px-4 py-3">
      <Icon name="alert-triangle" size={16} color={colors.warn} />
      <Text className="flex-1 text-sm text-ink">
        <Text className="font-bold">Structure editing</Text> — Executive Director
        only. Adding, renaming, moving, and removing seats here changes the org
        chart immediately for everyone, and is logged.
      </Text>
    </View>
  );
}

// ── Add seat ─────────────────────────────────────────────────────────────────

export function AddSeatModal({
  visible,
  chart,
  parentSlug,
  parentTitle,
  onClose,
}: {
  visible: boolean;
  chart: "central" | "chapter" | null;
  parentSlug: string | null;
  parentTitle: string | null;
  onClose: () => void;
}) {
  const addSeat = useMutation(api.seatStructure.addSeat);
  const [title, setTitle] = useState("");
  const [maxHolders, setMaxHolders] = useState<1 | typeof MULTI_HOLDER_CAP>(1);
  const [dutiesText, setDutiesText] = useState("");
  const [capabilities, setCapabilities] = useState<Set<SeatCapability>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle("");
      setMaxHolders(1);
      setDutiesText("");
      setCapabilities(new Set());
    }
  }, [visible]);

  function toggleCapability(c: SeatCapability) {
    setCapabilities((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function submit() {
    if (!chart || !parentSlug || !title.trim()) return;
    setSubmitting(true);
    try {
      await addSeat({
        chart,
        parentSlug,
        title: title.trim(),
        maxHolders,
        duties: dutiesText
          .split("\n")
          .map((d) => d.trim())
          .filter(Boolean),
        capabilities: [...capabilities],
      });
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (!visible || !parentSlug) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="flex-1 font-display text-lg text-ink" numberOfLines={1}>
              Add seat under {parentTitle}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[32rem]">
            <View className="gap-4 px-5 py-4">
              <View>
                <Text className="mb-1.5 text-sm font-semibold text-ink">Title</Text>
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  placeholder="e.g. Volunteer Coordinator"
                  placeholderTextColor={colors.faint}
                  autoFocus
                  className="rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
                />
              </View>

              <View>
                <Text className="mb-1.5 text-sm font-semibold text-ink">Holders</Text>
                <View className="flex-row gap-2">
                  <MaxHoldersTab
                    label="Single person"
                    selected={maxHolders === 1}
                    onPress={() => setMaxHolders(1)}
                  />
                  <MaxHoldersTab
                    label={`Multiple (up to ${MULTI_HOLDER_CAP})`}
                    selected={maxHolders === MULTI_HOLDER_CAP}
                    onPress={() => setMaxHolders(MULTI_HOLDER_CAP)}
                  />
                </View>
              </View>

              <View>
                <Text className="mb-1.5 text-sm font-semibold text-ink">
                  Duties (one per line, optional)
                </Text>
                <TextInput
                  value={dutiesText}
                  onChangeText={setDutiesText}
                  placeholder={"Plan the event\nCoordinate volunteers"}
                  placeholderTextColor={colors.faint}
                  multiline
                  numberOfLines={4}
                  className="min-h-[92px] rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
                />
              </View>

              <View>
                <Text className="mb-1.5 text-sm font-semibold text-ink">
                  Powers (optional)
                </Text>
                <View className="gap-1.5">
                  {SEAT_CAPABILITIES.map((c) => (
                    <CapabilityRow
                      key={c}
                      label={capabilityLabel(c)}
                      checked={capabilities.has(c)}
                      onPress={() => toggleCapability(c)}
                    />
                  ))}
                </View>
              </View>
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="ghost" onPress={onClose} />
            <Button
              title="Add seat"
              onPress={() => void submit()}
              disabled={!title.trim()}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MaxHoldersTab({
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
      className={`flex-1 items-center rounded-md border px-3 py-2 ${
        selected ? "border-accent bg-accent-soft" : "border-border bg-raised"
      }`}
    >
      <Text className={`text-sm font-semibold ${selected ? "text-accent" : "text-muted"}`}>
        {label}
      </Text>
    </Pressable>
  );
}

function CapabilityRow({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center justify-between rounded-md border px-3 py-2 ${
        checked ? "border-accent bg-accent-soft" : "border-border bg-raised"
      }`}
    >
      <Text className={`text-sm ${checked ? "font-semibold text-accent" : "text-ink"}`}>
        {label}
      </Text>
      {checked ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}

// ── Rename (inline) ──────────────────────────────────────────────────────────

export function RenameSeatControl({ slug, title }: { slug: string; title: string }) {
  const rename = useMutation(api.seatStructure.renameSeat);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);

  if (!editing) {
    return (
      <Pressable
        onPress={() => {
          setValue(title);
          setEditing(true);
        }}
        hitSlop={8}
        className="rounded-md p-1"
        accessibilityLabel="Rename seat"
      >
        <Icon name="edit-2" size={15} color={colors.muted} />
      </Pressable>
    );
  }

  async function save() {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await rename({ slug, title: trimmed });
      setEditing(false);
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="flex-row items-center gap-1.5">
      <TextInput
        value={value}
        onChangeText={setValue}
        autoFocus
        className="rounded-md border border-accent bg-raised px-2 py-1 text-base text-ink"
        style={{ minWidth: 140 }}
      />
      <Pressable onPress={() => void save()} hitSlop={8} className="rounded-md p-1" disabled={saving}>
        <Icon name="check" size={16} color={colors.success} />
      </Pressable>
      <Pressable onPress={() => setEditing(false)} hitSlop={8} className="rounded-md p-1">
        <Icon name="x" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

// ── Edit duties / capabilities / maxHolders ─────────────────────────────────

function EditSeatModal({
  visible,
  slug,
  seatTitle,
  initialMaxHolders,
  initialDuties,
  initialCapabilities,
  onClose,
}: {
  visible: boolean;
  slug: string;
  seatTitle: string;
  initialMaxHolders: number;
  initialDuties: readonly string[];
  initialCapabilities: readonly string[];
  onClose: () => void;
}) {
  const updateSeat = useMutation(api.seatStructure.updateSeat);
  const [maxHolders, setMaxHolders] = useState<1 | typeof MULTI_HOLDER_CAP>(
    initialMaxHolders === 1 ? 1 : MULTI_HOLDER_CAP,
  );
  const [dutiesText, setDutiesText] = useState(initialDuties.join("\n"));
  const [capabilities, setCapabilities] = useState<Set<SeatCapability>>(
    new Set(initialCapabilities as SeatCapability[]),
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setMaxHolders(initialMaxHolders === 1 ? 1 : MULTI_HOLDER_CAP);
      setDutiesText(initialDuties.join("\n"));
      setCapabilities(new Set(initialCapabilities as SeatCapability[]));
    }
    // Reset only when the modal (re)opens for a given seat — not on every
    // parent re-render while it's open (that would clobber in-progress edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, slug]);

  function toggleCapability(c: SeatCapability) {
    setCapabilities((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function submit() {
    setSubmitting(true);
    try {
      await updateSeat({
        slug,
        maxHolders,
        duties: dutiesText
          .split("\n")
          .map((d) => d.trim())
          .filter(Boolean),
        capabilities: [...capabilities],
      });
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="flex-1 font-display text-lg text-ink" numberOfLines={1}>
              Edit — {seatTitle}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[32rem]">
            <View className="gap-4 px-5 py-4">
              <View>
                <Text className="mb-1.5 text-sm font-semibold text-ink">Holders</Text>
                <View className="flex-row gap-2">
                  <MaxHoldersTab
                    label="Single person"
                    selected={maxHolders === 1}
                    onPress={() => setMaxHolders(1)}
                  />
                  <MaxHoldersTab
                    label={`Multiple (up to ${MULTI_HOLDER_CAP})`}
                    selected={maxHolders === MULTI_HOLDER_CAP}
                    onPress={() => setMaxHolders(MULTI_HOLDER_CAP)}
                  />
                </View>
              </View>

              <View>
                <Text className="mb-1.5 text-sm font-semibold text-ink">
                  Duties (one per line)
                </Text>
                <TextInput
                  value={dutiesText}
                  onChangeText={setDutiesText}
                  multiline
                  numberOfLines={4}
                  placeholderTextColor={colors.faint}
                  className="min-h-[92px] rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
                />
              </View>

              <View>
                <Text className="mb-1.5 text-sm font-semibold text-ink">Powers</Text>
                <View className="gap-1.5">
                  {SEAT_CAPABILITIES.map((c) => (
                    <CapabilityRow
                      key={c}
                      label={capabilityLabel(c)}
                      checked={capabilities.has(c)}
                      onPress={() => toggleCapability(c)}
                    />
                  ))}
                </View>
              </View>
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="ghost" onPress={onClose} />
            <Button title="Save" onPress={() => void submit()} loading={submitting} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Reparent ─────────────────────────────────────────────────────────────────

function ReparentModal({
  visible,
  slug,
  seatTitle,
  candidates,
  onClose,
}: {
  visible: boolean;
  slug: string;
  seatTitle: string;
  candidates: { slug: string; title: string }[];
  onClose: () => void;
}) {
  const reparent = useMutation(api.seatStructure.reparentSeat);

  function pick(newParentSlug: string, newParentTitle: string) {
    confirmAction({
      title: "Move this seat?",
      message: `${seatTitle} will report to ${newParentTitle} instead.`,
      confirmLabel: "Move",
      onConfirm: () => {
        void (async () => {
          try {
            await reparent({ slug, newParentSlug });
            onClose();
          } catch (err) {
            alertError(err);
          }
        })();
      },
    });
  }

  const options = candidates.filter((c) => c.slug !== slug);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="flex-1 font-display text-lg text-ink" numberOfLines={1}>
              Move {seatTitle} to report to…
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView className="max-h-96">
            {options.length === 0 ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                No other seats in this chart.
              </Text>
            ) : (
              options.map((o) => (
                <Pressable
                  key={o.slug}
                  onPress={() => pick(o.slug, o.title)}
                  className="flex-row items-center justify-between border-b border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
                >
                  <Text className="text-base text-ink">{o.title}</Text>
                  <Icon name="chevron-right" size={16} color={colors.faint} />
                </Pressable>
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Panel entry point ───────────────────────────────────────────────────────

/**
 * The structure-editing controls shown on a seat's detail panel in edit mode:
 * "Edit" (duties/powers/maxHolders), "Move" (reparent), and "Remove". Never
 * rendered for a `derived` seat (the caller should skip mounting this
 * entirely — `updateSeat`/`reparentSeat`/`removeSeat` all reject `derived`
 * seats server-side anyway, but there's nothing useful to edit on one).
 */
export function StructureEditActions({
  slug,
  seatTitle,
  chart,
  maxHolders,
  duties,
  capabilities,
  parentSlug,
  siblingSeats,
  onRemoved,
}: {
  slug: string;
  seatTitle: string;
  chart: "central" | "chapter";
  maxHolders: number;
  duties: readonly string[];
  capabilities: readonly string[];
  parentSlug: string;
  /** Every OTHER seat in the same chart — reparent candidates. */
  siblingSeats: { slug: string; title: string }[];
  onRemoved: () => void;
}) {
  const removeSeat = useMutation(api.seatStructure.removeSeat);
  const [editOpen, setEditOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const isRoot = parentSlug === SEAT_ROOT;

  async function remove() {
    setRemoving(true);
    try {
      await removeSeat({ slug });
      onRemoved();
    } catch (err) {
      alertError(err);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <View className="mt-1 flex-row flex-wrap gap-2">
      <Button title="Edit" variant="secondary" size="sm" icon="sliders" onPress={() => setEditOpen(true)} />
      {!isRoot ? (
        <Button
          title="Move"
          variant="secondary"
          size="sm"
          icon="corner-up-right"
          onPress={() => setMoveOpen(true)}
        />
      ) : null}
      {!isRoot ? (
        <Button
          title="Remove"
          variant="danger"
          size="sm"
          icon="trash-2"
          loading={removing}
          onPress={() =>
            confirmAction({
              title: `Remove ${seatTitle}?`,
              message:
                "This can't be undone. The seat must already be vacant, have no duties mapped to it, and have no seats reporting to it.",
              confirmLabel: "Remove seat",
              destructive: true,
              onConfirm: () => void remove(),
            })
          }
        />
      ) : null}

      <EditSeatModal
        visible={editOpen}
        slug={slug}
        seatTitle={seatTitle}
        initialMaxHolders={maxHolders}
        initialDuties={duties}
        initialCapabilities={capabilities}
        onClose={() => setEditOpen(false)}
      />
      <ReparentModal
        visible={moveOpen}
        slug={slug}
        seatTitle={seatTitle}
        candidates={siblingSeats}
        onClose={() => setMoveOpen(false)}
      />
    </View>
  );
}
