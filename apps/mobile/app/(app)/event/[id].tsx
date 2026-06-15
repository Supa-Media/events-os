import { useMemo, useState } from "react";
import { View, Text, Pressable, Alert, Platform } from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  SectionHeader,
  PersonPicker,
  Icon,
} from "../../../components/ui";
import { EditableGrid } from "../../../components/grid/EditableGrid";
import { AiAssistantPanel } from "../../../components/ai/AiAssistantPanel";
import { CrewSections } from "../../../components/event/CrewSections";
import { EventHeader } from "../../../components/event/EventHeader";
import { EventTabBar } from "../../../components/event/EventTabBar";
import { EventOverviewControls } from "../../../components/event/EventOverviewControls";
import { EventRolesCard } from "../../../components/event/EventRolesCard";
import { ModuleOwnerBar, ModuleRollupRow } from "../../../components/event/EventModuleRollup";
import { colors } from "../../../lib/theme";
import { parseDateInput, toDateInput } from "../../../lib/format";
import {
  MODULE_KEYS,
  MODULE_LABELS,
  MODULE_OWNER_ROLE_KEY,
  type ModuleKey,
} from "@events-os/shared";

export default function EventDetailScreen() {
  const router = useRouter();
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const eventId = id as any;

  const data = useQuery(api.events.get, { eventId });
  const roleRows = useQuery(api.roleAssignments.listForEvent, { eventId });
  const eventRolesRaw = useQuery(api.roles.listForEvent, { eventId });
  const summaries = useQuery(api.events.moduleSummaries, { eventId });

  const reschedule = useMutation(api.events.reschedule);
  const setStatus = useMutation(api.events.setStatus);
  const updateDetails = useMutation(api.events.updateDetails);
  const removeEvent = useMutation(api.events.remove);
  const assignRole = useMutation(api.roleAssignments.assign);
  const unassignRole = useMutation(api.roleAssignments.unassign);

  // Local edit buffers (null = mirror server value).
  const [nameInput, setNameInput] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState<string | null>(null);
  const [budgetInput, setBudgetInput] = useState<string | null>(null);
  const [picker, setPicker] = useState<
    | { roleId: string; roleLabel: string; selectedId: string | null }
    | null
  >(null);
  const [ownerOpen, setOwnerOpen] = useState(false);

  // Event roles, shaped for the grid's role cells ({_id, label}).
  const eventRoles = useMemo(
    () =>
      (eventRolesRaw ?? []).map((r: any) => ({
        _id: r._id as string,
        label: r.label as string,
      })),
    [eventRolesRaw],
  );

  const loading =
    data === undefined || roleRows === undefined || eventRolesRaw === undefined;

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <Screen loading />
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <Screen>
          <View className="items-start gap-4 py-10">
            <Text className="font-display text-xl text-ink">
              This event no longer exists.
            </Text>
            <Button
              title="Back to pipeline"
              icon="arrow-left"
              variant="secondary"
              onPress={() => router.replace("/")}
            />
          </View>
        </Screen>
      </>
    );
  }

  const {
    event,
    eventTypeName,
    activeComponents,
    owner,
    readiness,
    taskTotal,
    taskDone,
    budgetSpent,
    budgetPct,
  } = data;

  const nameValue = nameInput !== null ? nameInput : event.name;
  const dateValue = dateInput !== null ? dateInput : toDateInput(event.eventDate);
  const budgetValue =
    budgetInput !== null
      ? budgetInput
      : event.budget != null
        ? String(event.budget)
        : "";

  // Modules the event type switched on, in canonical order. The
  // volunteer_expectations module is the team EXPECTATIONS list (rows = things a
  // team does, tagged by team); WHO is on each team lives in CrewSections below.
  const activeModules = MODULE_KEYS.filter((m) => activeComponents.includes(m));

  // Tabs: Overview + each active module + Crew. The active tab lives in the URL
  // (`?tab=`) so it's deep-linkable and survives back/forward; unknown/missing
  // falls back to Overview.
  const tabs: { key: string; label: string }[] = [
    { key: "overview", label: "Overview" },
    ...activeModules.map((m) => ({ key: m as string, label: MODULE_LABELS[m] })),
    { key: "crew", label: "Crew" },
  ];
  const activeTab = tabs.some((t) => t.key === tab) ? (tab as string) : "overview";
  const summaryByModule = new Map(
    (summaries ?? []).map((s: any) => [s.module as string, s]),
  );

  // A module's owner is derived (not stored): map the module to its default
  // role key, then resolve the person assigned to that role on this event,
  // looking the key up against the EVENT's roles.
  function moduleOwner(module: ModuleKey) {
    const roleKey = MODULE_OWNER_ROLE_KEY[module];
    const role = (eventRolesRaw ?? []).find((r: any) => r.key === roleKey);
    if (!role) return null;
    const row = (roleRows ?? []).find((r) => r.roleId === role._id);
    return {
      roleId: role._id as string,
      roleLabel: role.label as string,
      person: row?.person ?? null,
    };
  }

  function openOwnerPicker(module: ModuleKey) {
    const info = moduleOwner(module);
    if (!info) return;
    setPicker({
      roleId: info.roleId,
      roleLabel: info.roleLabel,
      selectedId: info.person?._id ?? null,
    });
  }

  async function handleSaveName() {
    const trimmed = nameValue.trim();
    if (trimmed.length === 0 || trimmed === event.name) {
      setNameInput(null);
      return;
    }
    await updateDetails({ eventId, name: trimmed });
    setNameInput(null);
  }

  async function handleReschedule() {
    const ts = parseDateInput(dateValue);
    if (ts === null) return;
    await reschedule({ eventId, eventDate: ts });
    setDateInput(null);
  }

  async function handleSaveBudget() {
    const trimmed = budgetValue.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && Number.isNaN(parsed)) return;
    await updateDetails({ eventId, budget: parsed });
    setBudgetInput(null);
  }

  async function doDelete() {
    await removeEvent({ eventId });
    router.replace("/");
  }

  function confirmDelete() {
    // RN's Alert.alert is a no-op on web — use the DOM confirm there.
    if (Platform.OS === "web") {
      if (
        typeof window !== "undefined" &&
        window.confirm("Delete this event and all its items? This can't be undone.")
      ) {
        void doDelete();
      }
      return;
    }
    Alert.alert("Delete event?", "This removes the event and all its items.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doDelete },
    ]);
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen maxWidth={1180}>
        {/* Breadcrumb / back */}
        <Pressable
          onPress={() => router.replace("/")}
          className="mb-4 flex-row items-center gap-1.5 self-start active:opacity-70"
        >
          <Icon name="arrow-left" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">Pipeline</Text>
        </Pressable>

        {/* Workspace header */}
        <EventHeader
          event={event}
          eventId={eventId}
          eventTypeName={eventTypeName}
          readiness={readiness}
          taskDone={taskDone}
          taskTotal={taskTotal}
          budgetSpent={budgetSpent}
          budgetPct={budgetPct}
          nameValue={nameValue}
          onChangeName={setNameInput}
          onSaveName={handleSaveName}
          onDayOf={() => router.push(`/event/${eventId}/day-of`)}
          onSiteMap={() => router.push(`/event/${eventId}/site-map`)}
        />

        {/* Module navigation — same tab bar on web + mobile (scrolls on phones) */}
        <EventTabBar
          tabs={tabs}
          activeKey={activeTab}
          onSelect={(key) => router.setParams({ tab: key })}
        />

        {/* ── Overview: controls + per-module rollup ─────────────────────────── */}
        {activeTab === "overview" ? (
          <>
            <EventOverviewControls
              event={event}
              roleRows={roleRows}
              owner={owner}
              dateValue={dateValue}
              budgetValue={budgetValue}
              onPickRole={(r) =>
                setPicker({
                  roleId: r.roleId,
                  roleLabel: r.roleLabel,
                  selectedId: r.person?._id ?? null,
                })
              }
              onSetStatus={(s) => setStatus({ eventId, status: s })}
              onReschedule={(ts) => reschedule({ eventId, eventDate: ts })}
              onChangeDate={setDateInput}
              onSaveDate={handleReschedule}
              onOpenOwner={() => setOwnerOpen(true)}
              onChangeBudget={setBudgetInput}
              onSaveBudget={handleSaveBudget}
              onDelete={confirmDelete}
            />

            {/* Event roles — the event's own role list (diverges from template). */}
            <EventRolesCard eventId={eventId} roles={eventRoles} />

            {/* Per-module rollup — owner (role → person), progress, next due. */}
            {activeModules.length === 0 ? (
              <Card padding="lg">
                <Text className="text-base text-muted">
                  This event type has no planning modules enabled.
                </Text>
              </Card>
            ) : (
              <>
                <SectionHeader title="Modules" count={activeModules.length} />
                <Card padding="none">
                  {activeModules.map((m: ModuleKey, i) => (
                    <ModuleRollupRow
                      key={m}
                      module={m}
                      owner={moduleOwner(m)}
                      summary={summaryByModule.get(m)}
                      first={i === 0}
                      onOpen={() => router.setParams({ tab: m })}
                      onAssignOwner={() => openOwnerPicker(m)}
                    />
                  ))}
                </Card>
              </>
            )}
          </>
        ) : activeTab === "crew" ? (
          /* ── Crew: volunteers + paid vendors (engagements) ────────────────── */
          <CrewSections eventId={eventId} />
        ) : (
          /* ── A single module: owner badge + its grid ──────────────────────── */
          (() => {
            const m = activeTab as ModuleKey;
            return (
              <View>
                <ModuleOwnerBar
                  owner={moduleOwner(m)}
                  onPress={() => openOwnerPicker(m)}
                />
                <SectionHeader
                  title={MODULE_LABELS[m]}
                  right={
                    m === "supplies" ? (
                      <Button
                        title="Packing mode"
                        icon="package"
                        size="sm"
                        variant="secondary"
                        onPress={() => router.push(`/event/${eventId}/packing`)}
                      />
                    ) : undefined
                  }
                />
                <EditableGrid
                  mode="event"
                  parentId={eventId}
                  module={m}
                  roles={eventRoles}
                  eventDate={event.eventDate}
                  addLabel={`Add ${MODULE_LABELS[m].toLowerCase()} row`}
                />
              </View>
            );
          })()
        )}
      </Screen>

      <PersonPicker
        visible={picker !== null}
        title={picker ? `Assign ${picker.roleLabel}` : "Assign role"}
        source="team"
        selectedId={picker?.selectedId ?? null}
        onPick={async (personId) => {
          if (!picker) return;
          await assignRole({
            eventId,
            roleId: picker.roleId as any,
            personId: personId as any,
          });
          setPicker(null);
        }}
        onClear={
          picker && picker.selectedId
            ? async () => {
                if (!picker) return;
                await unassignRole({ eventId, roleId: picker.roleId as any });
                setPicker(null);
              }
            : undefined
        }
        onClose={() => setPicker(null)}
      />

      <PersonPicker
        visible={ownerOpen}
        title="Event owner"
        source="team"
        selectedId={owner?._id ?? null}
        onPick={async (personId) => {
          await updateDetails({ eventId, ownerPersonId: personId as any });
          setOwnerOpen(false);
        }}
        onClear={
          owner
            ? async () => {
                await updateDetails({ eventId, ownerPersonId: null });
                setOwnerOpen(false);
              }
            : undefined
        }
        onClose={() => setOwnerOpen(false)}
      />

      <AiAssistantPanel eventId={eventId} eventName={event.name} />
    </>
  );
}
