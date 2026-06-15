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
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { colors } from "../../lib/theme";

type PersonId = string;

type Props = {
  visible: boolean;
  title?: string;
  selectedId?: PersonId | null;
  onPick: (personId: PersonId) => void;
  onClear?: () => void;
  onClose: () => void;
  /** "team" lists only team members (for owners/leads); default lists everyone. */
  source?: "all" | "team";
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
  selectedId,
  onPick,
  onClear,
  onClose,
  source = "all",
  onCreate,
  filter,
}: Props) {
  const people = useQuery(
    source === "team" ? api.people.teamMembers : api.people.list,
  );

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
            <Text className="font-display text-lg text-ink">{title}</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          {onCreate ? (
            <View className="border-b border-border px-5 py-3">
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search people, or type a new name…"
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
