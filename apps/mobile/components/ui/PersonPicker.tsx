import { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
} from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { colors } from "../../lib/theme";
import { useSandboxEventId } from "../event/SandboxScope";

type PersonId = string;

type Props = {
  visible: boolean;
  title?: string;
  /** Optional one-line context shown under the title (e.g. the Money-page
   *  item→vendor conversion prompt's cost preview) — omitted entirely when
   *  unset, so every other caller's header is unchanged. */
  subtitle?: string;
  selectedId?: PersonId | null;
  onPick: (personId: PersonId) => void;
  onClear?: () => void;
  onClose: () => void;
  /**
   * "team" lists only team members (for owners/leads); "cardEligible" lists only
   * people with a `@publicworship.life` email (card issuance/linking); default
   * lists everyone.
   */
  source?: "all" | "team" | "cardEligible";
  /**
   * Optional predicate to narrow the roster (e.g. exclude placeholder people
   * when replacing a placeholder volunteer). Applied before the search filter.
   */
  filter?: (person: any) => boolean;
  /**
   * When provided, the picker gains a search box + a "Create new person" row, so
   * the caller can either CHOOSE an existing person or CREATE one by name. Left
   * unset (e.g. role assignment), the picker stays a plain roster list.
   */
  onCreate?: (name: string) => void;
  /**
   * Pre-fetched roster overriding `source`'s internal query entirely —
   * `source` is ignored when this is set. For a caller whose roster isn't
   * "the caller's own chapter" (e.g. a seat-change picker keyed off the
   * SEAT's scope, via `seats.assignablePeople`, not `people.list`).
   * `undefined` mirrors the internal query's own "still loading" state;
   * pass `[]` (not `undefined`) once the caller's own query has resolved to
   * an empty roster.
   */
  people?: { _id: string; name: string }[];
};

/**
 * Centered modal popover that lists chapter people for assigning tasks/roles.
 * Loads people via api.people.list ("all") or api.people.teamMembers ("team");
 * undefined while loading. Rows have class-driven hover and a selected check.
 *
 * With `onCreate`, it doubles as a combobox: type to filter the roster (choose),
 * or create a brand-new person from the typed name when none matches.
 */
export function PersonPicker({
  visible,
  title = "Assign person",
  subtitle,
  selectedId,
  onPick,
  onClear,
  onClose,
  source = "all",
  onCreate,
  filter,
  people: peopleOverride,
}: Props) {
  // Inside an Academy training sandbox, both sources collapse SERVER-SIDE to
  // the learner + placeholder people — real teammates are never offered from
  // within a drill.
  const sandboxEventId = useSandboxEventId();
  // The card-eligibility roster takes no args and has no sandbox variant.
  // Skipped entirely (Convex's `"skip"` sentinel) when `peopleOverride` is
  // set — no point subscribing to a roster the caller isn't using.
  const queried = useQuery(
    source === "cardEligible"
      ? api.people.cardEligible
      : source === "team"
        ? api.people.teamMembers
        : api.people.list,
    peopleOverride !== undefined
      ? "skip"
      : source !== "cardEligible" && sandboxEventId
        ? { eventId: sandboxEventId as Id<"events"> }
        : {},
  );
  const people = peopleOverride !== undefined ? peopleOverride : queried;

  const [search, setSearch] = useState("");
  // Reset the query each time the modal is dismissed so it opens fresh.
  useEffect(() => {
    if (!visible) setSearch("");
  }, [visible]);

  const q = search.trim().toLowerCase();
  const list = (people ?? []).filter((p: any) => (filter ? filter(p) : true));
  const filtered = q
    ? list.filter((p: any) => p.name.toLowerCase().includes(q))
    : list;
  const exactMatch = list.some(
    (p: any) => p.name.trim().toLowerCase() === q,
  );
  const canCreate = !!onCreate && search.trim().length > 0 && !exactMatch;
  // Show the search box whenever creating is allowed, or there is more than one
  // person to choose from (no point searching a single-name roster).
  const showSearch = !!onCreate || list.length > 1;

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
          <View className="border-b border-border px-5 py-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-display text-lg text-ink">{title}</Text>
              <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>
            {subtitle ? (
              <Text className="mt-1 text-sm text-muted">{subtitle}</Text>
            ) : null}
          </View>

          {showSearch ? (
            <View className="border-b border-border px-5 py-3">
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder={
                  onCreate
                    ? "Search people, or type a new name…"
                    : "Search people…"
                }
                placeholderTextColor={colors.faint}
                autoFocus
                autoCapitalize="words"
                className="rounded-md border border-border bg-raised px-3 py-2.5 text-base text-ink"
              />
            </View>
          ) : null}

          <ScrollView className="max-h-96">
            {onClear ? (
              <Row label="Clear assignment" muted icon="user-x" onPress={onClear} />
            ) : null}

            {people === undefined ? (
              <Text className="px-5 py-6 text-center text-base text-muted">Loading…</Text>
            ) : filtered.length === 0 && !canCreate ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                {list.length === 0
                  ? "No people yet. Add some first."
                  : "No matches."}
              </Text>
            ) : (
              filtered.map((p: any) => (
                <Row
                  key={p._id}
                  label={p.name}
                  selected={p._id === selectedId}
                  onPress={() => onPick(p._id)}
                />
              ))
            )}

            {canCreate ? (
              <Row
                label={`Create “${search.trim()}”`}
                muted
                icon="user-plus"
                onPress={() => onCreate!(search.trim())}
              />
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  label,
  selected,
  muted,
  icon,
  onPress,
}: {
  label: string;
  selected?: boolean;
  muted?: boolean;
  icon?: "user-x" | "user-plus";
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center justify-between border-b border-border px-5 py-3 ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      <View className="flex-row items-center gap-3">
        {muted ? (
          <View className="h-7 w-7 items-center justify-center rounded-pill bg-sunken">
            <Icon name={icon ?? "user"} size={14} color={colors.muted} />
          </View>
        ) : (
          <Avatar name={label} size={28} />
        )}
        <Text
          className={`text-base ${
            muted
              ? "text-muted"
              : selected
                ? "font-semibold text-accent"
                : "text-ink"
          }`}
        >
          {label}
        </Text>
      </View>
      {selected ? <Icon name="check" size={16} color={colors.accent} /> : null}
    </Pressable>
  );
}
