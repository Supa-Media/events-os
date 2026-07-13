import { Modal, View, Text, Pressable, ScrollView } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { colors } from "../../lib/theme";

type Props = {
  visible: boolean;
  eventTypeId?: string;
  selectedId?: string | null;
  /**
   * The Expectations row's team (the `team` select value). When set, crew on
   * that team are surfaced in a "Matching team" group at the top; the rest follow
   * under "Other crew" so any member is still pickable.
   */
  preferTeam?: string | null;
  onPick: (templatePersonId: string, name: string) => void;
  onClear?: () => void;
  onClose: () => void;
};

/**
 * Owner picker for TEMPLATE Expectations — lists the template's PLACEHOLDER crew
 * (templatePeople), not chapter people. Picking reports the chosen id + name so
 * the cell can cache the display name. Crew is authored in the Template Crew
 * card; this picker is read-only over that list.
 */
export function TemplateOwnerPicker({
  visible,
  eventTypeId,
  selectedId,
  preferTeam,
  onPick,
  onClear,
  onClose,
}: Props) {
  const crew = useQuery(
    api.templatePeople.list,
    eventTypeId ? { eventTypeId: eventTypeId as Id<"eventTypes"> } : "skip",
  );
  // Resolve team option VALUES (what crew/Expectations store) to display labels.
  const teamColumns = useQuery(
    api.columns.listForTemplate,
    eventTypeId
      ? { eventTypeId: eventTypeId as Id<"eventTypes">, module: "volunteer_expectations" }
      : "skip",
  );
  const teamOptions: Array<{ value: string; label: string }> =
    (teamColumns?.find((c: any) => c.key === "team")?.options as any) ?? [];
  const teamLabel = (value?: string | null) =>
    value ? teamOptions.find((o) => o.value === value)?.label ?? value : undefined;

  // A placeholder's team(s): prefer the multi-team `teams`, falling back to the
  // legacy single `team` (Chapter-OS rename — new rows carry only `teams`).
  const crewTeams = (c: any): string[] => c.teams ?? (c.team ? [c.team] : []);
  const primaryTeam = (c: any): string | null => crewTeams(c)[0] ?? null;

  // When the row has a team, split crew into matching / other so the matching
  // team surfaces first (but everyone stays pickable).
  const matching = preferTeam
    ? (crew ?? []).filter((c: any) => crewTeams(c).includes(preferTeam))
    : [];
  const others = preferTeam
    ? (crew ?? []).filter((c: any) => !crewTeams(c).includes(preferTeam))
    : (crew ?? []);
  const grouped = preferTeam && matching.length > 0;

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
            <Text className="font-display text-lg text-ink">Assign placeholder crew</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-96">
            {onClear ? (
              <Row label="Clear owner" muted icon="user-x" onPress={onClear} />
            ) : null}

            {crew === undefined ? (
              <Text className="px-5 py-6 text-center text-base text-muted">Loading…</Text>
            ) : crew.length === 0 ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                No placeholder crew yet. Add some in the Crew card first.
              </Text>
            ) : grouped ? (
              <>
                <SectionLabel label="Matching team" />
                {matching.map((c: any) => (
                  <Row
                    key={c._id}
                    label={c.name}
                    sub={teamLabel(primaryTeam(c))}
                    selected={c._id === selectedId}
                    onPress={() => onPick(c._id, c.name)}
                  />
                ))}
                {others.length > 0 ? (
                  <>
                    <SectionLabel label="Other crew" />
                    {others.map((c: any) => (
                      <Row
                        key={c._id}
                        label={c.name}
                        sub={teamLabel(primaryTeam(c))}
                        selected={c._id === selectedId}
                        onPress={() => onPick(c._id, c.name)}
                      />
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              others.map((c: any) => (
                <Row
                  key={c._id}
                  label={c.name}
                  sub={teamLabel(primaryTeam(c))}
                  selected={c._id === selectedId}
                  onPress={() => onPick(c._id, c.name)}
                />
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Small group header inside the picker (e.g. "Matching team" / "Other crew"). */
function SectionLabel({ label }: { label: string }) {
  return (
    <View className="border-b border-border bg-sunken/60 px-5 py-1.5">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
    </View>
  );
}

function Row({
  label,
  sub,
  selected,
  muted,
  icon,
  onPress,
}: {
  label: string;
  sub?: string;
  selected?: boolean;
  muted?: boolean;
  icon?: "user-x";
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between border-b border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
    >
      <View className="flex-row items-center gap-3">
        {muted ? (
          <View className="h-7 w-7 items-center justify-center rounded-pill bg-sunken">
            <Icon name={icon ?? "user"} size={14} color={colors.muted} />
          </View>
        ) : (
          <Avatar name={label} size={28} />
        )}
        <View>
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
          {sub ? <Text className="text-xs text-muted">{sub}</Text> : null}
        </View>
      </View>
      {selected ? <Icon name="check" size={16} color={colors.accent} /> : null}
    </Pressable>
  );
}
