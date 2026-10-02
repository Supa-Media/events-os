/**
 * TEAMS — the named groups of seats the year plan uses to say who owns what.
 * A team has a lead seat, member seats, an optional parent team, and lives at
 * Central or in one chapter. Teams carry no powers (seats do), so editing one
 * changes ownership labels on the plan and nobody's access.
 *
 * Editable by whoever can edit the org chart (`lib/teamsAccess.ts`).
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BackLink,
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  PageHeader,
  Pill,
  Screen,
  Select,
  TextField,
} from "../ui";
import type { EditorOptions } from "./KeyResultEditor";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

type TeamRow = FunctionReturnType<typeof api.goals.teams>["teams"][number];

export function TeamsScreen() {
  const data = useQuery(api.goals.teams);
  const options = useQuery(api.goals.editorOptions);
  const createTeam = useMutation(api.goalTeams.createTeam);
  const [openId, setOpenId] = useState<Id<"orgTeams"> | null>(null);

  if (data === undefined || options === undefined) return <Screen loading />;
  const active = data.teams.filter((t) => !t.isArchived);
  const archived = data.teams.filter((t) => t.isArchived);

  return (
    <Screen>
      <Narrow>
        <BackLink label="Goals" fallback="/goals" />
        <PageHeader
          title="Teams"
          subtitle="Named groups of seats that own objectives and key results. Teams don't grant powers; seats do."
          actions={
            data.canEdit ? (
              <Button
                title="Add team"
                icon="plus"
                onPress={() =>
                  createTeam({ name: "New team" })
                    .then((id) => setOpenId(id))
                    .catch(alertError)
                }
              />
            ) : null
          }
        />
        {data.teams.length === 0 ? (
          <EmptyState
            icon="users"
            title="No teams yet"
            message="Teams are created when you start from the 2027 One Pager, or add one here."
          />
        ) : null}
        <View className="gap-3">
          {active.map((t, i) => (
            <TeamCard
              key={t._id}
              team={t}
              teams={data.teams}
              options={options}
              canEdit={data.canEdit}
              open={openId === t._id}
              onToggle={() => setOpenId(openId === t._id ? null : t._id)}
              first={i === 0}
              last={i === active.length - 1}
            />
          ))}
        </View>
        {archived.length > 0 ? (
          <View className="mt-6 gap-3">
            <Text className="text-xs font-semibold uppercase tracking-wide text-muted">Archived</Text>
            {archived.map((t) => (
              <TeamCard
                key={t._id}
                team={t}
                teams={data.teams}
                options={options}
                canEdit={data.canEdit}
                open={openId === t._id}
                onToggle={() => setOpenId(openId === t._id ? null : t._id)}
                first
                last
              />
            ))}
          </View>
        ) : null}
      </Narrow>
    </Screen>
  );
}

function TeamCard({
  team,
  teams,
  options,
  canEdit,
  open,
  onToggle,
  first,
  last,
}: {
  team: TeamRow;
  teams: TeamRow[];
  options: EditorOptions;
  canEdit: boolean;
  open: boolean;
  onToggle: () => void;
  first: boolean;
  last: boolean;
}) {
  return (
    <Card onPress={canEdit && !open ? onToggle : undefined}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="font-display text-lg text-ink">{team.name}</Text>
            <Badge label={team.chapterName ?? "Central"} tone={team.chapterName ? "info" : "neutral"} />
            {team.parentName ? <Text className="text-xs text-muted">inside {team.parentName}</Text> : null}
          </View>
          {team.leadSeatTitle ? (
            <Text className="text-sm text-ink">Led by {team.leadSeatTitle}</Text>
          ) : (
            <Text className="text-sm text-muted">No lead seat yet</Text>
          )}
          {team.seatTitles.length > 0 ? (
            <Text className="text-xs text-muted">{team.seatTitles.join(", ")}</Text>
          ) : null}
          {team.description ? <Text className="text-xs text-muted">{team.description}</Text> : null}
        </View>
        {canEdit ? (
          <Button title={open ? "Close" : "Edit"} size="sm" variant="ghost" onPress={onToggle} />
        ) : null}
      </View>
      {open ? (
        <TeamEditor team={team} teams={teams} options={options} first={first} last={last} onDone={onToggle} />
      ) : null}
    </Card>
  );
}

function TeamEditor({
  team,
  teams,
  options,
  first,
  last,
  onDone,
}: {
  team: TeamRow;
  teams: TeamRow[];
  options: EditorOptions;
  first: boolean;
  last: boolean;
  onDone: () => void;
}) {
  const updateTeam = useMutation(api.goalTeams.updateTeam);
  const moveTeam = useMutation(api.goalTeams.moveTeam);
  const deleteTeam = useMutation(api.goalTeams.deleteTeam);
  const [name, setName] = useState(team.name);
  const [chapterId, setChapterId] = useState<string>(team.chapterId ?? "");
  const [lead, setLead] = useState(team.leadSeatSlug ?? "");
  const [seats, setSeats] = useState<string[]>(team.seatSlugs);
  const [parent, setParent] = useState<string>(team.parentTeamId ?? "");
  const [description, setDescription] = useState(team.description ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateTeam({
        teamId: team._id,
        name,
        chapterId: chapterId ? (chapterId as Id<"chapters">) : null,
        leadSeatSlug: lead || null,
        seatSlugs: seats,
        parentTeamId: parent ? (parent as Id<"orgTeams">) : null,
        description: description.trim() || null,
      });
      onDone();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  };

  const seatOptions = options.seats.map((s) => ({ value: s.slug, label: s.title }));
  return (
    <View className="mt-4 gap-3 border-t border-border pt-4">
      <TextField label="Name" value={name} onChangeText={setName} />
      <View className="flex-row flex-wrap gap-2">
        <View className="min-w-[200px] flex-1">
          <Select
            label="Where"
            value={chapterId}
            options={[{ value: "", label: "Central" }, ...options.chapters.map((c) => ({ value: c._id, label: c.name }))]}
            onChange={setChapterId}
          />
        </View>
        <View className="min-w-[200px] flex-1">
          <Select
            label="Inside team"
            value={parent}
            options={[
              { value: "", label: "Top level" },
              ...teams.filter((t) => t._id !== team._id && !t.isArchived).map((t) => ({ value: t._id, label: t.name })),
            ]}
            onChange={setParent}
          />
        </View>
      </View>
      <Select
        label="Lead seat"
        value={lead}
        options={[{ value: "", label: "No lead seat" }, ...seatOptions]}
        onChange={setLead}
        searchable
      />
      <View className="gap-1.5">
        <Text className="text-sm font-medium text-ink">Seats on this team</Text>
        <View className="flex-row flex-wrap gap-2">
          {options.seats.map((s) => (
            <Pill
              key={s.slug}
              size="sm"
              label={s.title}
              selected={seats.includes(s.slug)}
              onPress={() =>
                setSeats((cur) => (cur.includes(s.slug) ? cur.filter((x) => x !== s.slug) : [...cur, s.slug]))
              }
            />
          ))}
        </View>
      </View>
      <TextField label="Notes" value={description} onChangeText={setDescription} multiline numberOfLines={2} />
      <View className="flex-row flex-wrap gap-2">
        <Button title="Save" onPress={save} loading={saving} />
        {!first ? (
          <Button title="Up" variant="ghost" icon="arrow-up" onPress={() => moveTeam({ teamId: team._id, direction: "up" }).catch(alertError)} />
        ) : null}
        {!last ? (
          <Button title="Down" variant="ghost" icon="arrow-down" onPress={() => moveTeam({ teamId: team._id, direction: "down" }).catch(alertError)} />
        ) : null}
        <Button
          title={team.isArchived ? "Restore" : "Archive"}
          variant="ghost"
          onPress={() => updateTeam({ teamId: team._id, isArchived: !team.isArchived }).then(onDone).catch(alertError)}
        />
        <Button
          title="Delete"
          variant="danger"
          onPress={() =>
            confirmAction({
              title: `Delete ${team.name}?`,
              message: "Objectives and key results it owned keep their place with no owner. Archive instead to keep it on record.",
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => deleteTeam({ teamId: team._id }).catch(alertError),
            })
          }
        />
      </View>
    </View>
  );
}
