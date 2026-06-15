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
import { AiAssistantPanel } from "../../../components/ai/AiAssistantPanel";
import { CrewSections } from "../../../components/event/CrewSections";
import { EventHeader } from "../../../components/event/EventHeader";
import { EventTabBar } from "../../../components/event/EventTabBar";
import { EventOverviewControls } from "../../../components/event/EventOverviewControls";
import { ModuleRollupRow } from "../../../components/event/EventModuleRollup";
import { ModuleSection } from "../../../components/event/ModuleSection";
import { EventModulesCard } from "../../../components/event/EventModulesCard";
import { colors } from "../../../lib/theme";
import { parseDateInput, toDateInput } from "../../../lib/format";
import type { ResolvedModule } from "@events-os/shared";

export default function EventDetailScreen() {
  const router = useRouter();
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const eventId = id as any;

  const data = useQuery(api.events.get, { eventId });
  const roleRows = useQuery(api.roleAssignments.listForEvent, { eventId });
  const eventRolesRaw = useQuery(api.roles.listForEvent, { eventId });
  const moduleData = useQuery(api.modules.listForEvent, { eventId });
  const summaries = useQuery(api.events.moduleSummaries, { eventId });

  const reschedule = useMutation(api.events.reschedule);
  const setStatus = useMutation(api.events.setStatus);
  const updateDetails = useMutation(api.events.updateDetails);
  const removeEvent = useMutation(api.events.remove);
  const assignRole = useMutation(api.roleAssignments.assign);
  const unassignRole = useMutation(api.roleAssignments.unassign);
  const updateEventRole = useMutation(api.roles.updateEventRole);
  const createEventRole = useMutation(api.roles.createForEvent);
  const deleteEventRole = useMutation(api.roles.deleteEventRole);

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
    modules: resolvedModules,
    moduleReadiness,
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

  // Resolved active modules (core + custom, with the event's deltas applied), in
  // canonical order. Includes the site_map module (surface "site_map"); the
  // volunteer_expectations module is the team EXPECTATIONS list (WHO is on each
  // team lives in CrewSections below).
  const activeModules: ResolvedModule[] = resolvedModules ?? [];

  // Tabs: Overview + each active module + Crew. The active tab lives in the URL
  // (`?tab=`) so it's deep-linkable and survives back/forward; unknown/missing
  // falls back to Overview.
  const tabs: { key: string; label: string }[] = [
    { key: "overview", label: "Overview" },
    ...activeModules.map((m) => ({ key: m.key, label: m.label })),
    { key: "crew", label: "Crew" },
  ];
  const activeTab = tabs.some((t) => t.key === tab) ? (tab as string) : "overview";
  const summaryByModule = new Map(
    (summaries ?? []).map((s: any) => [s.module as string, s]),
  );
  const readyByModule = new Map(
    (moduleReadiness ?? []).map((r: any) => [r.key as string, r.ready as boolean]),
  );

  // A module's owner is its resolved owner role KEY, resolved to the person
  // assigned to that role on this event (looked up against the EVENT's roles).
  function moduleOwner(module: ResolvedModule) {
    const roleKey = module.ownerRoleKey;
    const role = (eventRolesRaw ?? []).find((r: any) => r.key === roleKey);
    if (!role) return null;
    const row = (roleRows ?? []).find((r) => r.roleId === role._id);
    return {
      roleId: role._id as string,
      roleLabel: role.label as string,
      person: row?.person ?? null,
    };
  }

  function openOwnerPicker(module: ResolvedModule) {
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
      <View className="flex-1 flex-row">
        <View className="flex-1">
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
              onRenameRole={(roleId, label) =>
                updateEventRole({ roleId: roleId as any, label })
              }
              onDeleteRole={(roleId) =>
                deleteEventRole({ roleId: roleId as any })
              }
              onAddRole={(label) => createEventRole({ eventId, label })}
            />

            {/* Add / re-enable modules at the event level. */}
            <EventModulesCard
              eventId={eventId}
              disabledCore={moduleData?.disabledCore ?? []}
              customRows={(moduleData?.customRows ?? []) as any}
            />

            {/* Per-module rollup — owner (role → person), progress, next due. */}
            {activeModules.length === 0 ? (
              <Card padding="lg">
                <Text className="text-base text-muted">
                  This event has no modules enabled.
                </Text>
              </Card>
            ) : (
              <>
                <SectionHeader title="Modules" count={activeModules.length} />
                <Card padding="none">
                  {activeModules.map((m, i) => (
                    <ModuleRollupRow
                      key={m.key}
                      label={m.label}
                      ready={readyByModule.get(m.key) ?? false}
                      owner={moduleOwner(m)}
                      summary={summaryByModule.get(m.key)}
                      first={i === 0}
                      onOpen={() => router.setParams({ tab: m.key })}
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
          /* ── A single module: owner bar + ready toggle + its surface ───────── */
          (() => {
            const m = activeModules.find((mod) => mod.key === activeTab);
            if (!m) return null;
            return (
              <ModuleSection
                eventId={eventId}
                module={m}
                roles={eventRoles}
                eventDate={event.eventDate}
                owner={moduleOwner(m)}
                ready={readyByModule.get(m.key) ?? false}
                onAssignOwner={() => openOwnerPicker(m)}
              />
            );
          })()
        )}
          </Screen>
        </View>

        {/* In-flow assistant panel — squeezes the content left when open. */}
        <AiAssistantPanel eventId={eventId} eventName={event.name} />
      </View>

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
    </>
  );
}
