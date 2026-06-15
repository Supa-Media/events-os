import { useRef, useState } from "react";
import { View, Text, TextInput, Pressable, Platform, Alert } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, SectionHeader, Icon, Avatar } from "../ui";
import { OptionTag } from "../ui/OptionTag";
import { Popover } from "../ui/Popover";
import { colors } from "../../lib/theme";

/* ── Template crew (placeholders) ──────────────────────────────────────────── */

/**
 * The template OWNS a roster of PLACEHOLDER crew — stand-in people that don't
 * exist yet (e.g. "Stage Manager", "Lead Usher"). They can be set as the owner
 * of Expectations rows while authoring; on event creation each is materialized
 * into a real chapter person (flagged a placeholder) the team swaps for a real
 * volunteer later.
 *
 * Each crew member is tagged with a TEAM that is the SAME set as the Expectations
 * grid's "team" select column (module `volunteer_expectations`, key `team`). The
 * dropdown is sourced from that column's `options`, the stored value is the
 * option `value`, and new teams added here are appended to that column — so a
 * crew member's team and an Expectations row's team always line up.
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

  // The Expectations "team" select column — its options ARE the team set, and
  // adding a team here appends an option to it (shared with the grid).
  const teamColumns = useQuery(api.columns.listForTemplate, {
    eventTypeId,
    module: "volunteer_expectations",
  });
  const updateColumn = useMutation(api.columns.updateColumn);
  const teamColumn = teamColumns?.find((c: any) => c.key === "team") ?? null;
  const teamOptions: TeamOption[] = (teamColumn?.options as TeamOption[]) ?? [];

  const [adding, setAdding] = useState(false);

  /** Append a new team option to the Expectations `team` column, preserving the
   * existing options' values/colors (mirrors ColumnOptionsEditor). Returns the
   * new option's value so the caller can immediately assign it to a crew row. */
  const addTeam = async (label: string): Promise<string | null> => {
    if (!teamColumn) return null;
    const trimmed = label.trim();
    if (!trimmed) return null;
    const existing: TeamOption[] = (teamColumn.options as TeamOption[]) ?? [];
    const taken = new Set(existing.map((o) => o.value));
    // Reuse an existing option if the label already matches (case-insensitive).
    const match = existing.find(
      (o) => o.label.toLowerCase() === trimmed.toLowerCase(),
    );
    if (match) return match.value;
    const value = uniqueValue(slugify(trimmed), taken);
    const color = TEAM_PALETTE[existing.length % TEAM_PALETTE.length];
    await updateColumn({
      columnId: teamColumn._id as Id<"templateColumns">,
      options: [...existing, { value, label: trimmed, color }],
    });
    return value;
  };

  return (
    <Card className="mb-2">
      <SectionHeader title="Crew (placeholders)" />
      <Text className="mb-3 text-sm text-muted">
        Stand-in crew for this template. Set them as the owner of Expectations
        rows below — each becomes a real (placeholder) person on every event you
        create, ready to swap for a real volunteer. Their team uses the same set
        as the Expectations grid; add a team here or edit options with the grid's
        Columns pencil.
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
              team={c.team ?? null}
              teamOptions={teamOptions}
              teamColumnReady={teamColumn != null}
              onSaveName={(name) =>
                updateCrew({ templatePersonId: c._id, name })
              }
              onSaveTeam={(team) =>
                updateCrew({
                  templatePersonId: c._id,
                  team: team ? team : null,
                })
              }
              onAddTeam={addTeam}
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

interface TeamOption {
  value: string;
  label: string;
  color?: string;
}

const TEAM_PALETTE = [
  "red",
  "amber",
  "green",
  "blue",
  "teal",
  "purple",
  "pink",
  "orange",
  "gray",
];

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "team"
  );
}
function uniqueValue(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** One placeholder crew row: avatar + inline name + team dropdown + delete. */
function CrewRow({
  name,
  team,
  teamOptions,
  teamColumnReady,
  onSaveName,
  onSaveTeam,
  onAddTeam,
  onDelete,
}: {
  name: string;
  team: string | null;
  teamOptions: TeamOption[];
  teamColumnReady: boolean;
  onSaveName: (name: string) => void;
  onSaveTeam: (team: string | null) => void;
  onAddTeam: (label: string) => Promise<string | null>;
  onDelete: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(name);
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
      <TeamSelect
        team={team}
        teamOptions={teamOptions}
        disabled={!teamColumnReady}
        onSelect={onSaveTeam}
        onAddTeam={onAddTeam}
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

/**
 * Team dropdown for a crew row. Anchored Popover (matching the grid's select
 * cells) listing the Expectations `team` options; selecting one stores the
 * option `value`. A footer input lets the author add a NEW team — appended to
 * the shared column and immediately assigned to this crew member.
 */
function TeamSelect({
  team,
  teamOptions,
  disabled,
  onSelect,
  onAddTeam,
}: {
  team: string | null;
  teamOptions: TeamOption[];
  disabled: boolean;
  onSelect: (team: string | null) => void;
  onAddTeam: (label: string) => Promise<string | null>;
}) {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<
    { x: number; y: number; width: number; height: number } | undefined
  >();
  const [open, setOpen] = useState(false);
  const [newTeam, setNewTeam] = useState("");

  const current = teamOptions.find((o) => o.value === team) ?? null;

  const openMenu = () => {
    const node = ref.current;
    if (node && typeof node.measureInWindow === "function") {
      node.measureInWindow(
        (x: number, y: number, width: number, height: number) => {
          setAnchor({ x, y, width, height });
          setOpen(true);
        },
      );
    } else {
      setOpen(true);
    }
  };
  const close = () => {
    setOpen(false);
    setNewTeam("");
  };

  const commitNewTeam = async () => {
    const label = newTeam.trim();
    if (!label) return;
    const value = await onAddTeam(label);
    if (value) onSelect(value);
    close();
  };

  return (
    <>
      <Pressable
        ref={ref}
        disabled={disabled}
        onPress={openMenu}
        accessibilityLabel="Set team"
        className="w-28 px-1 py-1 active:opacity-70"
      >
        {current ? (
          <OptionTag label={current.label} color={current.color} />
        ) : (
          <Text className="text-sm text-faint">Team…</Text>
        )}
      </Pressable>
      <Popover visible={open} onClose={close} anchor={anchor} width={220}>
        <View className="py-1">
          {team != null ? (
            <TeamMenuRow
              label="Clear"
              muted
              onPress={() => {
                onSelect(null);
                close();
              }}
            />
          ) : null}
          {teamOptions.map((o) => (
            <TeamMenuRow
              key={o.value}
              label={o.label}
              color={o.color}
              selected={o.value === team}
              onPress={() => {
                onSelect(o.value);
                close();
              }}
            />
          ))}
          {/* Add a new team — appended to the shared Expectations column. */}
          <View className="mt-1 flex-row items-center gap-1.5 border-t border-border px-2 py-2">
            <Icon name="plus" size={14} color={colors.muted} />
            <TextInput
              value={newTeam}
              onChangeText={setNewTeam}
              placeholder="New team"
              placeholderTextColor={colors.faint}
              autoCapitalize="words"
              onSubmitEditing={() => void commitNewTeam()}
              blurOnSubmit={false}
              className="flex-1 px-1 py-1 text-sm text-ink"
              style={{ outlineWidth: 0 } as any}
            />
            <Pressable
              onPress={() => void commitNewTeam()}
              disabled={!newTeam.trim()}
              hitSlop={6}
              accessibilityLabel="Add team"
              className={`rounded p-1 active:bg-sunken ${
                newTeam.trim() ? "" : "opacity-30"
              }`}
            >
              <Icon name="check" size={15} color={colors.accent} />
            </Pressable>
          </View>
        </View>
      </Popover>
    </>
  );
}

function TeamMenuRow({
  label,
  color,
  selected,
  muted,
  onPress,
}: {
  label: string;
  color?: string;
  selected?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center justify-between gap-3 px-3 py-2 ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      {muted ? (
        <Text className="text-sm text-muted">{label}</Text>
      ) : (
        <OptionTag label={label} color={color} />
      )}
      {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
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
