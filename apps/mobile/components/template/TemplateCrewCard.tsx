import { useState } from "react";
import { View, Text, TextInput, Pressable, Platform, Alert } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, SectionHeader, Icon, Avatar } from "../ui";
import { colors } from "../../lib/theme";

/* ── Template crew (placeholders) ──────────────────────────────────────────── */

/**
 * The template OWNS a roster of PLACEHOLDER crew — stand-in people that don't
 * exist yet (e.g. "Stage Manager", "Lead Usher"). They can be set as the owner
 * of Expectations rows while authoring; on event creation each is materialized
 * into a real chapter person (flagged a placeholder) the team swaps for a real
 * volunteer later.
 *
 * A simple inline list: edit each row's name + team in place, ＋ adds one, the
 * trash icon deletes. Mirrors the lightweight RolesCard style — NOT the heavy
 * event-side CrewSections.
 */
export function TemplateCrewCard({
  eventTypeId,
}: {
  eventTypeId: Id<"eventTypes">;
}) {
  const crew = useQuery(api.templatePeople.list, { eventTypeId });
  const createCrew = useMutation(api.templatePeople.create);
  const updateCrew = useMutation(api.templatePeople.update);
  const removeCrew = useMutation(api.templatePeople.remove);

  const [adding, setAdding] = useState(false);

  return (
    <Card className="mb-2">
      <SectionHeader title="Crew (placeholders)" />
      <Text className="mb-3 text-sm text-muted">
        Stand-in crew for this template. Set them as the owner of Expectations
        rows below — each becomes a real (placeholder) person on every event you
        create, ready to swap for a real volunteer.
      </Text>

      {crew === undefined ? (
        <Text className="text-sm text-faint">Loading…</Text>
      ) : crew.length === 0 && !adding ? (
        <Text className="mb-3 text-sm text-faint">No placeholder crew yet.</Text>
      ) : (
        <View className="mb-2 gap-2">
          {crew.map((c) => (
            <CrewRow
              key={c._id}
              name={c.name}
              team={c.team ?? ""}
              onSaveName={(name) =>
                updateCrew({ templatePersonId: c._id, name })
              }
              onSaveTeam={(team) =>
                updateCrew({
                  templatePersonId: c._id,
                  team: team.trim() ? team.trim() : null,
                })
              }
              onDelete={() =>
                confirmDeleteCrew(() => removeCrew({ templatePersonId: c._id }))
              }
            />
          ))}
        </View>
      )}

      {adding ? (
        <AddCrewRow
          onCommit={(name) => {
            const trimmed = name.trim();
            if (trimmed) void createCrew({ eventTypeId, name: trimmed });
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Pressable
          onPress={() => setAdding(true)}
          accessibilityRole="button"
          accessibilityLabel="Add placeholder crew"
          className="flex-row items-center gap-1.5 self-start rounded-md border border-dashed border-border-strong px-3 py-2 active:opacity-80 web:hover:border-accent"
        >
          <Icon name="plus" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">Add crew</Text>
        </Pressable>
      )}
    </Card>
  );
}

/** One placeholder crew row: avatar + inline name + inline team + delete. */
function CrewRow({
  name,
  team,
  onSaveName,
  onSaveTeam,
  onDelete,
}: {
  name: string;
  team: string;
  onSaveName: (name: string) => void;
  onSaveTeam: (team: string) => void;
  onDelete: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(name);
  const [teamDraft, setTeamDraft] = useState(team);
  return (
    <View className="flex-row items-center gap-2 rounded-md border border-border bg-raised px-2 py-1.5">
      <Avatar name={name || "?"} size={26} />
      <TextInput
        value={nameDraft}
        onChangeText={setNameDraft}
        placeholder="Name / role"
        placeholderTextColor={colors.faint}
        autoCapitalize="words"
        onBlur={() => {
          const t = nameDraft.trim();
          if (t && t !== name) onSaveName(t);
          else setNameDraft(name);
        }}
        className="flex-1 px-1 py-1 text-sm text-ink"
        style={{ outlineWidth: 0 } as any}
      />
      <TextInput
        value={teamDraft}
        onChangeText={setTeamDraft}
        placeholder="Team"
        placeholderTextColor={colors.faint}
        onBlur={() => {
          if (teamDraft.trim() !== team) onSaveTeam(teamDraft);
        }}
        className="w-28 px-1 py-1 text-sm text-muted"
        style={{ outlineWidth: 0 } as any}
      />
      <Pressable
        onPress={onDelete}
        hitSlop={6}
        accessibilityLabel="Delete crew member"
        className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="trash-2" size={15} color={colors.danger} />
      </Pressable>
    </View>
  );
}

/** Inline input shown by "Add crew" to name a new placeholder. */
function AddCrewRow({
  onCommit,
  onCancel,
}: {
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <View className="flex-row items-center gap-2 self-start rounded-md border border-accent bg-raised px-2 py-1.5">
      <Icon name="user-plus" size={15} color={colors.muted} />
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoFocus
        placeholder="Name / role"
        placeholderTextColor={colors.faint}
        autoCapitalize="words"
        onBlur={() => (draft.trim() ? onCommit(draft) : onCancel())}
        onSubmitEditing={() => onCommit(draft)}
        blurOnSubmit
        className="px-1 py-1 text-sm text-ink"
        style={{ minWidth: 160, outlineWidth: 0 } as any}
      />
    </View>
  );
}

/** Confirm a crew delete (web `window.confirm`, native `Alert.alert`). */
function confirmDeleteCrew(onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (
      typeof window !== "undefined" &&
      window.confirm("Delete this placeholder crew member?")
    ) {
      onConfirm();
    }
    return;
  }
  Alert.alert("Delete crew member?", "This removes the placeholder from this template.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: onConfirm },
  ]);
}
