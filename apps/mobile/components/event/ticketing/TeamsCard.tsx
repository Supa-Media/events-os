/**
 * "Teams" — the Run-phase setup for splitting arriving guests into even teams
 * at check-in. Switch it on, say how many teams, rename them if the event
 * calls them something other than their color.
 *
 * Deliberately generic rather than built for one event: field-day color teams
 * are the obvious case, but the same control covers discussion tables, small
 * groups, or vans. The one thing it does NOT offer is pre-assignment — teams
 * are handed out at the door precisely so no-shows can't leave them lopsided
 * (see `@events-os/shared/guestTeams.ts`).
 *
 * Names are editable; colors are not. Team N always wears `TEAM_COLORS[N]`, so
 * the wristbands the door is holding never shift meaning underneath them.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { teamColor } from "@events-os/shared";
import { Button, Card, TextField } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import { ToggleRow } from "./ToggleRow";

/** Fewest teams worth having — one "team" is just everybody. */
const MIN_TEAMS = 2;

export function TeamsCard({
  eventId,
  run,
}: {
  eventId: Id<"events">;
  run: ActionRunner["run"];
}) {
  const data = useQuery(api.guestTeams.listForEvent, { eventId });
  const setEnabled = useMutation(api.guestTeams.setEnabled);
  const setTeamCount = useMutation(api.guestTeams.setTeamCount);
  const renameTeam = useMutation(api.guestTeams.renameTeam);
  // Per-team local edit buffer, committed on blur/submit — the same
  // type-locally, save-on-commit shape the slug and ticket-type fields use.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (data === undefined) {
    return (
      <Card>
        <Text className="text-base text-muted">Loading…</Text>
      </Card>
    );
  }

  const active = data.teams.filter((t) => t.isActive);
  const assignedTotal = data.teams.reduce((n, t) => n + t.assignedCount, 0);

  function changeCount(next: number) {
    const clamped = Math.max(MIN_TEAMS, Math.min(data!.maxTeams, next));
    if (clamped === active.length) return;
    void run(() => setTeamCount({ eventId, count: clamped }), {
      errorTitle: "Couldn't change the number of teams",
    });
  }

  function commitName(teamId: string, fallback: string) {
    const draft = drafts[teamId];
    setDrafts((d) => {
      const { [teamId]: _dropped, ...rest } = d;
      return rest;
    });
    const next = (draft ?? "").trim();
    if (next === "" || next === fallback) return;
    void run(
      () => renameTeam({ teamId: teamId as Id<"guestTeams">, name: next }),
      { errorTitle: "Couldn't rename team" },
    );
  }

  return (
    <Card>
      <ToggleRow
        label="Assign teams at check-in"
        hint="Every guest you admit joins the smallest team, so the teams come out even without anyone counting."
        value={data.enabled}
        onToggle={(next) =>
          void run(() => setEnabled({ eventId, enabled: next }), {
            errorTitle: "Couldn't update teams",
          })
        }
      />

      {data.enabled ? (
        <View className="mt-3 border-t border-border pt-3">
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1">
              <Text className="text-sm font-semibold text-ink">
                How many teams
              </Text>
              <Text className="mt-0.5 text-xs text-muted">
                Up to {data.maxTeams}. The first ten colors are the easiest to
                tell apart.
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Button
                title="−"
                variant="secondary"
                size="sm"
                disabled={active.length <= MIN_TEAMS}
                onPress={() => changeCount(active.length - 1)}
              />
              <Text className="min-w-[28px] text-center font-display text-xl text-ink">
                {active.length}
              </Text>
              <Button
                title="+"
                variant="secondary"
                size="sm"
                disabled={active.length >= data.maxTeams}
                onPress={() => changeCount(active.length + 1)}
              />
            </View>
          </View>

          <View className="mt-3 gap-2">
            {active.map((team) => {
              const c = teamColor(team.color);
              const value = drafts[team._id] ?? team.name;
              return (
                <View key={team._id} className="flex-row items-center gap-3">
                  <View
                    className="h-8 w-8 rounded-lg"
                    style={{ backgroundColor: c.solid }}
                  />
                  <View className="flex-1">
                    <TextField
                      value={value}
                      onChangeText={(t) =>
                        setDrafts((d) => ({ ...d, [team._id]: t }))
                      }
                      onBlur={() => commitName(team._id, team.name)}
                      onSubmitEditing={() => commitName(team._id, team.name)}
                      autoCorrect={false}
                    />
                  </View>
                  <Text className="min-w-[44px] text-right text-xs text-muted">
                    {team.assignedCount === 1
                      ? "1 guest"
                      : `${team.assignedCount} guests`}
                  </Text>
                </View>
              );
            })}
          </View>

          <Text className="mt-3 text-xs text-faint">
            {assignedTotal === 0
              ? "Nobody's been placed yet — teams fill up as guests are checked in."
              : `${assignedTotal} ${assignedTotal === 1 ? "guest has" : "guests have"} been placed. Changing the number of teams won't move anyone already checked in.`}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}
