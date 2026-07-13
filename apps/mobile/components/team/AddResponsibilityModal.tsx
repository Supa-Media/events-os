/**
 * AddResponsibilityModal — assign a duty from a person's page, fast.
 *
 * Pick WHO it lands on first: just this person (a direct assignment) or
 * everyone holding their role (adds the role to the definition, fanning it
 * out org-wide). Then either tap an existing definition — the list shows
 * only duties that don't already apply to them — or type a new title and
 * create it on the spot (ad-hoc cadence; refine it later in the Duties tab).
 */
import { useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
} from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCE_LABELS,
  normalizeRole,
} from "@events-os/shared";
import { Icon, OptionTag } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";

type ResponsibilityRow = Doc<"responsibilities">;

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
  const update = useMutation(api.responsibilities.update);
  const addAssignee = useMutation(api.responsibilities.addAssignee);
  const [query, setQuery] = useState("");
  const hasRole = !!normalizeRole(person.role);
  const [target, setTarget] = useState<"person" | "role">("person");

  const q = query.trim().toLowerCase();
  const personRole = normalizeRole(person.role);
  // Only duties that DON'T already reach this person are offered.
  const candidates = responsibilities.filter((r) => {
    if ((r.assigneePersonIds ?? []).includes(person._id)) return false;
    if (
      personRole &&
      (r.assigneeRoles ?? []).some((x) => normalizeRole(x) === personRole)
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

  async function assignExisting(r: ResponsibilityRow) {
    try {
      if (target === "role" && person.role) {
        await update({
          responsibilityId: r._id,
          assigneeRoles: [...(r.assigneeRoles ?? []), person.role.trim()],
        });
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
        ...(target === "role" && person.role
          ? { assigneeRoles: [person.role.trim()] }
          : { assigneePersonIds: [person._id] }),
      });
      onClose();
    } catch (err) {
      alertError(err);
    }
  }

  return (
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
            {(
              [
                { key: "person", label: `Just ${person.name}` },
                ...(hasRole
                  ? [
                      {
                        key: "role",
                        label: `Everyone with title “${person.role}”`,
                      } as const,
                    ]
                  : []),
              ] as const
            ).map((t) => {
              const active = target === t.key;
              return (
                <Pressable
                  key={t.key}
                  onPress={() => setTarget(t.key)}
                  className={`rounded-pill border px-3 py-1.5 ${
                    active
                      ? "border-accent bg-accent-soft"
                      : "border-border bg-raised"
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      active ? "text-accent" : "text-muted"
                    }`}
                    numberOfLines={1}
                  >
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
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
  );
}
