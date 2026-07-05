import { useMemo, useState, type ComponentProps } from "react";
import { View, Text, Pressable, Alert, Platform } from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  Card,
  Button,
  SectionHeader,
  PersonPicker,
  Icon,
} from "../../../components/ui";
import { ToastView } from "../../../components/ui/Toast";
import { useActionRunner } from "../../../lib/useActionToast";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { AiAssistantPanel } from "../../../components/ai/AiAssistantPanel";
import { CrewSections } from "../../../components/event/CrewSections";
import { EventHeader } from "../../../components/event/EventHeader";
import { EventTabBar, type EventTab } from "../../../components/event/EventTabBar";
import { EventOverviewControls } from "../../../components/event/EventOverviewControls";
import { EventTodos } from "../../../components/event/EventTodos";
import {
  ModuleRollupRow,
  confirmRemoveModule,
} from "../../../components/event/EventModuleRollup";
import { ModuleSection } from "../../../components/event/ModuleSection";
import TicketingTab from "../../../components/event/ticketing/TicketingTab";
import { colors, modulePhase } from "../../../lib/theme";
import { usePhasePulse } from "../../../lib/usePhasePulse";
import { parseDateInput, toDateInput, formatDate } from "../../../lib/format";
import {
  firstUnassignedRole,
  firstModuleMissingOwner,
  type ResolvedModule,
} from "@events-os/shared";

/** A task row in the "Me view" My-tasks list. */
type MyTask = {
  itemId: string;
  module: string;
  moduleLabel: string;
  title: string;
  dueDate?: number | null;
  status?: string | null;
};

type ModuleOwner = {
  roleId: string;
  roleLabel: string;
  person: { _id: string; name: string } | null;
} | null;

export default function EventDetailScreen() {
  const router = useRouter();
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const eventId = id as Id<"events">;
  const { run, toast, dismiss } = useActionRunner();

  // Personal "Me view" filter — when on, the Overview shows only the modules
  // and tasks the current user owns (driven by api.events.myWork).
  const [meView, setMeView] = useState(false);

  // Tapping a header phase ring briefly pulses the tabs that feed that phase —
  // the interactive answer to "which tabs move this number?".
  const { pulsePhase, flash: flashPhase } = usePhasePulse();

  const data = useQuery(api.events.get, { eventId });
  const roleRows = useQuery(api.roleAssignments.listForEvent, { eventId });
  const eventRolesRaw = useQuery(api.roles.listForEvent, { eventId });
  const moduleData = useQuery(api.modules.listForEvent, { eventId });
  const summaries = useQuery(api.events.moduleSummaries, { eventId });
  const myWork = useQuery(
    api.events.myWork,
    meView ? { eventId } : "skip",
  );
  // "What's next" to-dos for the normal Overview only (not Me view). Skip on
  // other tabs to avoid the extra read while a module surface is open.
  const onOverview = (tab ?? "overview") === "overview";
  // The "What's next" list powers both the normal Overview and Me view's task
  // section, so fetch it on the overview regardless of Me view.
  const todos = useQuery(
    api.events.todos,
    onOverview ? { eventId } : "skip",
  );

  const reschedule = useMutation(api.events.reschedule);
  const setStatus = useMutation(api.events.setStatus);
  const updateDetails = useMutation(api.events.updateDetails);
  const removeEvent = useMutation(api.events.remove);
  const assignRole = useMutation(api.roleAssignments.assign);
  const unassignRole = useMutation(api.roleAssignments.unassign);
  const updateEventRole = useMutation(api.roles.updateEventRole);
  const createEventRole = useMutation(api.roles.createForEvent);
  const deleteEventRole = useMutation(api.roles.deleteEventRole);
  const toggleCoreModule = useMutation(api.modules.toggleCoreForEvent);
  const createCustomModule = useMutation(api.modules.createCustomForEvent);
  const deleteCustomModule = useMutation(api.modules.deleteCustomForEvent);

  // Local edit buffers (null = mirror server value).
  const [nameInput, setNameInput] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState<string | null>(null);
  const [budgetInput, setBudgetInput] = useState<string | null>(null);
  const [locationInput, setLocationInput] = useState<string | null>(null);
  const [picker, setPicker] = useState<
    | { roleId: string; roleLabel: string; selectedId: string | null }
    | null
  >(null);
  const [ownerOpen, setOwnerOpen] = useState(false);

  // Event roles, shaped for the grid's role cells ({_id, label}).
  const eventRoles = useMemo(
    () =>
      (eventRolesRaw ?? []).map((r) => ({
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
    phases,
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
  const locationValue =
    locationInput !== null ? locationInput : (event.location ?? "");

  // Resolved active modules (core + custom, with the event's deltas applied), in
  // canonical order. Includes the site_map module (surface "site_map"); the
  // volunteer_expectations module is the team EXPECTATIONS list (WHO is on each
  // team lives in CrewSections below).
  const activeModules: ResolvedModule[] = resolvedModules ?? [];

  // The volunteer_expectations module (the team EXPECTATIONS grid) is NOT a tab of
  // its own — it's merged into the Crew tab below, alongside the crew engagements.
  const expectationsModule =
    activeModules.find((m) => m.key === "volunteer_expectations") ?? null;

  // Tabs: Overview + each active module (minus volunteer_expectations) + the
  // combined "Crew & Expectations" tab. The active tab lives in the URL (`?tab=`)
  // so it's deep-linkable and survives back/forward; unknown/missing falls back
  // to Overview.
  // Me view sets (myWork is only fetched while meView is on). `ownedModuleKeys`
  // = modules whose owner resolves to me (show ALL their items); `myItemIds` =
  // items I own; a module is "involved" if I own it OR own an item in it.
  const ownedModuleKeys = myWork ? new Set(myWork.ownedModuleKeys) : null;
  const myItemIds = myWork
    ? new Set(myWork.tasks.map((t) => t.itemId as string))
    : null;
  const involvedModuleKeys = myWork
    ? new Set<string>([
        ...myWork.ownedModuleKeys,
        ...myWork.tasks.map((t) => t.module as string),
      ])
    : null;
  // Crew & Expectations is team work — show it in Me view if I'm on a team, have
  // team tasks, own the expectations module, or own an expectation item.
  const crewInvolved = myWork
    ? myWork.myTeams.length > 0 ||
      myWork.teamItemIds.length > 0 ||
      (ownedModuleKeys?.has("volunteer_expectations") ?? false) ||
      myWork.tasks.some((t) => t.module === "volunteer_expectations")
    : true;
  // Expectation item ids I should see in Me view (my team's tasks ∪ items I own).
  const myExpectationItemIds =
    meView && myWork
      ? new Set<string>([...(myItemIds ?? []), ...myWork.teamItemIds])
      : null;

  // Crew shows outside Me view, or in Me view when I'm team-involved.
  const showCrew = !meView || crewInvolved;
  const summaryByModule = new Map(
    (summaries ?? []).map((s) => [s.module as string, s] as const),
  );
  const readyByModule = new Map(
    (moduleReadiness ?? []).map(
      (r) => [r.key as string, r.ready as boolean] as const,
    ),
  );
  // Phase hue + progress for a module tab: marked-ready counts as complete;
  // otherwise done/total when the module has measurable items; else null (the
  // tab shows a dim phase dot instead of a mini ring).
  function tabMeta(moduleKey: string): Pick<EventTab, "phase" | "progress"> {
    const summary = summaryByModule.get(moduleKey);
    const progress =
      readyByModule.get(moduleKey) === true
        ? 1
        : summary && summary.hasStatus && summary.total > 0
          ? summary.done / summary.total
          : null;
    return { phase: modulePhase(moduleKey), progress };
  }
  // Build the module tabs in lifecycle order, rendering the merged
  // "Crew & Expectations" tab AT the volunteer_expectations slot (so it sits
  // before the post-event Retrospective, not after it). In Me view, modules I'm
  // not involved in are dropped. myWork still loading ⇒ tabs unfiltered briefly.
  const moduleTabs = activeModules.flatMap((m): EventTab[] => {
    // Outside Me view, a module tab can disable/remove itself from its own menu.
    const remove = !meView
      ? { isCore: m.isCore, onRemove: () => removeModule(m) }
      : undefined;
    if (m.key === "volunteer_expectations") {
      return showCrew
        ? [
            {
              key: "crew",
              label: "Crew & Expectations",
              remove,
              ...tabMeta("volunteer_expectations"),
            },
          ]
        : [];
    }
    if (meView && involvedModuleKeys && !involvedModuleKeys.has(m.key)) return [];
    return [{ key: m.key, label: m.label, remove, ...tabMeta(m.key) }];
  });
  const tabs: EventTab[] = [
    { key: "overview", label: "Overview" },
    // The public event page: RSVPs, tickets, guest list, check-in, blasts.
    { key: "tickets", label: "Tickets" },
    ...moduleTabs,
    // Fallback: if the expectations module is disabled, still surface Crew last.
    ...(showCrew && !moduleTabs.some((t) => t.key === "crew")
      ? [{ key: "crew", label: "Crew & Expectations" }]
      : []),
  ];
  const activeTab = tabs.some((t) => t.key === tab) ? (tab as string) : "overview";
  // Custom event-module rows, keyed by module key, so a rollup row can resolve
  // its `eventModules` id for deletion.
  const customModuleIdByKey = new Map(
    (moduleData?.customRows ?? []).map(
      (r) => [r.key as string, r._id as string] as const,
    ),
  );

  // A module's owner is its resolved owner role KEY, resolved to the person
  // assigned to that role on this event (looked up against the EVENT's roles).
  function moduleOwner(module: ResolvedModule) {
    const roleKey = module.ownerRoleKey;
    const role = (eventRolesRaw ?? []).find((r) => r.key === roleKey);
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

  /**
   * Remove a module from its tab menu: a core module is disabled (re-enable it
   * from the "＋" in the tab bar), a custom one is deleted (confirmed, since it
   * takes its items with it).
   */
  function removeModule(module: ResolvedModule) {
    const doRemove = () => {
      if (module.isCore) {
        void run(
          () => toggleCoreModule({ eventId, key: module.key, enabled: false }),
          { errorTitle: "Couldn't disable module" },
        );
      } else {
        const rowId = customModuleIdByKey.get(module.key);
        if (rowId)
          void run(
            () =>
              deleteCustomModule({ moduleId: rowId as Id<"eventModules"> }),
            { errorTitle: "Couldn't remove module" },
          );
      }
    };
    if (module.isCore) doRemove();
    else confirmRemoveModule(doRemove);
  }

  /**
   * Run a "What's next" setup row (which has no module tab) by opening the picker
   * where the work actually happens: "Assign roles" jumps to the first unassigned
   * role, "Assign module owners" to the first owner-less module.
   */
  function handleSetupAction(id: string) {
    if (id === "roles") {
      const next = firstUnassignedRole(roleRows ?? []);
      if (next) {
        setPicker({
          roleId: next.roleId,
          roleLabel: next.roleLabel,
          selectedId: null,
        });
      }
    } else if (id === "owners") {
      const m = firstModuleMissingOwner(
        activeModules,
        (mod) => !!mod.ownerRoleKey,
        (mod) => !!moduleOwner(mod)?.person,
      );
      if (m) openOwnerPicker(m);
    }
  }

  async function handleSaveName() {
    const trimmed = nameValue.trim();
    if (trimmed.length === 0 || trimmed === event.name) {
      setNameInput(null);
      return;
    }
    await run(() => updateDetails({ eventId, name: trimmed }), {
      errorTitle: "Couldn't rename event",
    });
    setNameInput(null);
  }

  async function handleReschedule() {
    const ts = parseDateInput(dateValue);
    if (ts === null) return;
    await run(() => reschedule({ eventId, eventDate: ts }), {
      errorTitle: "Couldn't reschedule",
    });
    setDateInput(null);
  }

  async function handleSaveBudget() {
    const trimmed = budgetValue.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && Number.isNaN(parsed)) return;
    await run(() => updateDetails({ eventId, budget: parsed }), {
      errorTitle: "Couldn't save budget",
    });
    setBudgetInput(null);
  }

  async function handleSaveLocation(next?: string) {
    // `next` is the explicit value when a suggestion is picked; otherwise fall
    // back to the current edit buffer (a free-text blur commit).
    const trimmed = (next ?? locationValue).trim();
    if (trimmed === (event.location ?? "")) {
      setLocationInput(null);
      return;
    }
    await run(
      () =>
        updateDetails({
          eventId,
          location: trimmed === "" ? null : trimmed,
        }),
      { errorTitle: "Couldn't save location" },
    );
    setLocationInput(null);
  }

  async function doDelete() {
    const ok = await run(() => removeEvent({ eventId }), {
      errorTitle: "Couldn't delete event",
    });
    // Only navigate away once the delete actually succeeded.
    if (ok !== undefined) router.replace("/");
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
          <Screen maxWidth={FULL_WIDTH}>
        <Narrow>
        <ToastView toast={toast} onDismiss={dismiss} />
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
          phases={phases}
          taskDone={taskDone}
          taskTotal={taskTotal}
          budgetSpent={budgetSpent}
          budgetPct={budgetPct}
          nameValue={nameValue}
          onChangeName={setNameInput}
          onSaveName={handleSaveName}
          onDayOf={() => router.push(`/event/${eventId}/day-of`)}
          onSongs={() => router.push(`/event/${eventId}/songs`)}
          meView={meView}
          onToggleMeView={() => setMeView((v) => !v)}
          onSelectPhase={flashPhase}
          activePhase={pulsePhase}
        />

        {/* Module navigation — same tab bar on web + mobile (scrolls on phones) */}
        <EventTabBar
          tabs={tabs}
          activeKey={activeTab}
          highlightPhase={pulsePhase}
          onSelect={(key) => router.setParams({ tab: key })}
          addModule={
            meView
              ? undefined
              : {
                  disabledCore: moduleData?.disabledCore ?? [],
                  onEnableCore: (key) =>
                    void run(
                      () => toggleCoreModule({ eventId, key, enabled: true }),
                      { errorTitle: "Couldn't enable module" },
                    ),
                  onCreateCustom: (label) =>
                    void run(() => createCustomModule({ eventId, label }), {
                      errorTitle: "Couldn't add module",
                    }),
                }
          }
        />
        </Narrow>

        {/* ── Overview: controls + per-module rollup ─────────────────────────── */}
        {activeTab === "overview" && meView ? (
          <Narrow>
          <MeView
            ownedModuleKeys={myWork?.ownedModuleKeys ?? null}
            todos={todos}
            activeModules={activeModules}
            readyByModule={readyByModule}
            summaryByModule={summaryByModule}
            moduleOwner={moduleOwner}
            onOpenModule={(key) =>
              router.setParams({
                tab: key === "volunteer_expectations" ? "crew" : key,
              })
            }
            onOpenTab={(t) => router.setParams({ tab: t })}
            onSetupAction={handleSetupAction}
            onAssignOwner={openOwnerPicker}
          />
          </Narrow>
        ) : activeTab === "overview" ? (
          <Narrow>
            <EventOverviewControls
              event={event}
              roleRows={roleRows}
              owner={owner}
              dateValue={dateValue}
              budgetValue={budgetValue}
              locationValue={locationValue}
              onPickRole={(r) =>
                setPicker({
                  roleId: r.roleId,
                  roleLabel: r.roleLabel,
                  selectedId: r.person?._id ?? null,
                })
              }
              onSetStatus={(s) =>
                run(() => setStatus({ eventId, status: s }), {
                  errorTitle: "Couldn't change status",
                })
              }
              onReschedule={(ts) =>
                run(() => reschedule({ eventId, eventDate: ts }), {
                  errorTitle: "Couldn't reschedule",
                })
              }
              onChangeDate={setDateInput}
              onSaveDate={handleReschedule}
              onOpenOwner={() => setOwnerOpen(true)}
              onChangeBudget={setBudgetInput}
              onSaveBudget={handleSaveBudget}
              onChangeLocation={setLocationInput}
              onSaveLocation={handleSaveLocation}
              onDelete={confirmDelete}
              onRenameRole={(roleId, label) =>
                run(
                  () =>
                    updateEventRole({
                      roleId: roleId as Id<"eventRoles">,
                      label,
                    }),
                  { errorTitle: "Couldn't rename role" },
                )
              }
              onDeleteRole={(roleId) =>
                run(
                  () =>
                    deleteEventRole({ roleId: roleId as Id<"eventRoles"> }),
                  { errorTitle: "Couldn't delete role" },
                )
              }
              onAddRole={(label) =>
                run(() => createEventRole({ eventId, label }), {
                  errorTitle: "Couldn't add role",
                })
              }
            />

            {/* What's next — outstanding work grouped by phase, each line
                deep-linking to the module tab that holds it. */}
            {todos ? (
              <>
                <SectionHeader title="What's next" />
                <EventTodos
                  todos={todos}
                  onOpenTab={(t) => router.setParams({ tab: t })}
                  onSetupAction={handleSetupAction}
                />
              </>
            ) : null}

          </Narrow>
        ) : activeTab === "tickets" ? (
          /* ── Tickets: the shareable public page + RSVPs/tickets admin ─────── */
          <Narrow>
            <TicketingTab eventId={eventId} />
          </Narrow>
        ) : activeTab === "crew" ? (
          /* ── Crew & Expectations: WHO is on each team (engagements) plus, below,
                WHAT each team is expected to do (the volunteer_expectations grid). */
          <View className="gap-8">
            <Narrow>
              <CrewSections eventId={eventId} />
            </Narrow>
            {expectationsModule ? (
              <View>
                <SectionHeader title="Expectations" />
                <ModuleSection
                  eventId={eventId}
                  module={expectationsModule}
                  roles={eventRoles}
                  eventDate={event.eventDate}
                  owner={moduleOwner(expectationsModule)}
                  ready={readyByModule.get(expectationsModule.key) ?? false}
                  onAssignOwner={() => openOwnerPicker(expectationsModule)}
                  filterItemIds={
                    // Me view: show my team's expectation tasks (+ any I own),
                    // unless I own the expectations module (then show all).
                    meView &&
                    myExpectationItemIds &&
                    !ownedModuleKeys?.has(expectationsModule.key)
                      ? myExpectationItemIds
                      : undefined
                  }
                />
              </View>
            ) : null}
          </View>
        ) : (
          /* ── A single module: owner bar + ready toggle + its surface ───────── */
          (() => {
            // volunteer_expectations is handled in the Crew tab, so skip it here —
            // a stale `?tab=volunteer_expectations` URL falls through to Overview.
            const m = activeModules.find(
              (mod) =>
                mod.key === activeTab && mod.key !== "volunteer_expectations",
            );
            if (!m) return null;
            // Me view: if I don't own this module, show only my items; if I own
            // the module, show everything (no filter).
            const filterItemIds =
              meView && myItemIds && !ownedModuleKeys?.has(m.key)
                ? myItemIds
                : undefined;
            return (
              // Key by module so switching tabs remounts the section, resetting
              // its view to that module's default (Comms → calendar, others →
              // table). Without this, one instance is reused across tabs and the
              // view "sticks" — toggling Table on one module carried into others.
              <ModuleSection
                key={m.key}
                eventId={eventId}
                module={m}
                roles={eventRoles}
                eventDate={event.eventDate}
                owner={moduleOwner(m)}
                ready={readyByModule.get(m.key) ?? false}
                onAssignOwner={() => openOwnerPicker(m)}
                filterItemIds={filterItemIds}
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
          await run(
            () =>
              assignRole({
                eventId,
                roleId: picker.roleId as Id<"eventRoles">,
                personId: personId as Id<"people">,
              }),
            { errorTitle: "Couldn't assign role" },
          );
          setPicker(null);
        }}
        onClear={
          picker && picker.selectedId
            ? async () => {
                if (!picker) return;
                await run(
                  () =>
                    unassignRole({
                      eventId,
                      roleId: picker.roleId as Id<"eventRoles">,
                    }),
                  { errorTitle: "Couldn't clear role" },
                );
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
          await run(
            () =>
              updateDetails({
                eventId,
                ownerPersonId: personId as Id<"people">,
              }),
            { errorTitle: "Couldn't set owner" },
          );
          setOwnerOpen(false);
        }}
        onClear={
          owner
            ? async () => {
                await run(
                  () => updateDetails({ eventId, ownerPersonId: null }),
                  { errorTitle: "Couldn't clear owner" },
                );
                setOwnerOpen(false);
              }
            : undefined
        }
        onClose={() => setOwnerOpen(false)}
      />
    </>
  );
}

/**
 * The Overview's "Me view" — a focused "My work" surface showing only the
 * modules the current user owns and a flat list of their tasks across every
 * module. Reuses ModuleRollupRow for the modules so it matches the full rollup.
 * `null` values mean the myWork query is still loading.
 */
function MeView({
  ownedModuleKeys,
  todos,
  activeModules,
  readyByModule,
  summaryByModule,
  moduleOwner,
  onOpenModule,
  onOpenTab,
  onSetupAction,
  onAssignOwner,
}: {
  ownedModuleKeys: string[] | null;
  todos: ComponentProps<typeof EventTodos>["todos"] | undefined;
  activeModules: ResolvedModule[];
  readyByModule: Map<string, boolean>;
  summaryByModule: Map<
    string,
    { total: number; done: number; hasStatus: boolean; nextDueDate: number | null }
  >;
  moduleOwner: (m: ResolvedModule) => ModuleOwner;
  onOpenModule: (key: string) => void;
  onOpenTab: (tab: string) => void;
  onSetupAction: (id: string) => void;
  onAssignOwner: (m: ResolvedModule) => void;
}) {
  if (ownedModuleKeys === null || todos === undefined) {
    return (
      <View className="py-10">
        <Text className="text-base text-muted">Loading your work…</Text>
      </View>
    );
  }

  const ownedKeys = new Set(ownedModuleKeys);
  const myModules = activeModules.filter((m) => ownedKeys.has(m.key));

  return (
    <>
      <SectionHeader title="Modules you own" count={myModules.length} />
      {myModules.length === 0 ? (
        <Card>
          <Text className="text-base text-muted">
            You don't own any modules on this event.
          </Text>
        </Card>
      ) : (
        <Card padding="none">
          {myModules.map((m, i) => (
            <ModuleRollupRow
              key={m.key}
              label={m.label}
              isCore={m.isCore}
              ready={readyByModule.get(m.key) ?? false}
              owner={moduleOwner(m)}
              summary={summaryByModule.get(m.key)}
              first={i === 0}
              onOpen={() => onOpenModule(m.key)}
              onAssignOwner={() => onAssignOwner(m)}
              onRemove={() => {}}
            />
          ))}
        </Card>
      )}

      {/* "My tasks" IS the What's next list — yours (always) + overseeing (at
          risk), with overdue flagged red. */}
      <SectionHeader title="What's next" />
      <EventTodos
        todos={todos}
        onOpenTab={onOpenTab}
        onSetupAction={onSetupAction}
      />
    </>
  );
}
