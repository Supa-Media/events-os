import { useMemo, useState, type ComponentProps } from "react";
import {
  View,
  Text,
  Pressable,
  Alert,
  Platform,
  useWindowDimensions,
} from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  BackLink,
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
import { EventHeader, EventTools } from "../../../components/event/EventHeader";
import { EventTabBar, type EventTab } from "../../../components/event/EventTabBar";
import { PlanSections } from "../../../components/event/PlanSections";
import { EventTodos } from "../../../components/event/EventTodos";
import { GuidesSection } from "../../../components/event/GuidesSection";
import { SandboxScope } from "../../../components/event/SandboxScope";
import {
  ModuleRollupRow,
  confirmRemoveModule,
} from "../../../components/event/EventModuleRollup";
import { ModuleSection } from "../../../components/event/ModuleSection";
import TicketingTab from "../../../components/event/ticketing/TicketingTab";
import { MoneyView } from "../../../components/money/MoneyView";
import { ScopeToggle } from "../../../components/team/ScopeToggle";
import { colors, modulePhase } from "../../../lib/theme";
import { usePhasePulse } from "../../../lib/usePhasePulse";
import { alertError } from "../../../lib/errors";
import { confirmAction } from "../../../components/event/ticketing/helpers";
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
  // Responsive split: at/above the app's desktop breakpoint we keep the
  // horizontal tab rail with the active section always visible; below it (and on
  // native phones) the sections become a vertical, drill-in plan.
  const { width } = useWindowDimensions();
  const isMobile = width < 760;

  // Personal "Me view" filter — filters the tabs (and the What's-next panel)
  // down to the modules and tasks the current user owns (api.events.myWork).
  const [meView, setMeView] = useState(false);

  // The Overview tab is gone: its details half now edits INLINE in the header
  // (title, status pill, meta line, people row), and its "What's next" half is
  // a panel toggled by the header's pace pill — available on any tab.
  const [nextOpen, setNextOpen] = useState(false);

  // Tapping a header phase ring briefly pulses the tabs that feed that phase —
  // the interactive answer to "which tabs move this number?".
  const { pulsePhase, flash: flashPhase } = usePhasePulse();

  const data = useQuery(api.events.get, { eventId });
  const roleRows = useQuery(api.roleAssignments.listForEvent, { eventId });
  const eventRolesRaw = useQuery(api.roles.listForEvent, { eventId });
  const moduleData = useQuery(api.modules.listForEvent, { eventId });
  const summaries = useQuery(api.events.moduleSummaries, { eventId });
  // Just enough of the ticketing page to know whether this event is
  // tickets-only (RSVPs off) — drives the "RSVP page" → "Event page" copy
  // switch below and in EventTools. Same query TicketingTab itself uses, so
  // this is a shared subscription, not a second fetch.
  const ticketingData = useQuery(api.ticketing.getAdminPage, { eventId });
  const rsvpEnabled = ticketingData?.page?.rsvpEnabled !== false;
  const ticketsLabel = rsvpEnabled ? "RSVP page" : "Event page";
  const myWork = useQuery(
    api.events.myWork,
    meView ? { eventId } : "skip",
  );
  // "What's next" to-dos, fetched only while its panel is open (it powers
  // both the normal panel and Me view's task section).
  const todos = useQuery(
    api.events.todos,
    nextOpen ? { eventId } : "skip",
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
  const transferScope = useMutation(api.finances.transferEventScope);

  // Local edit buffers (null = mirror server value).
  const [nameInput, setNameInput] = useState<string | null>(null);
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
              title="Back to events"
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
    expectedPhases,
    pacePhases,
    budgetSpent,
    budgetPct,
    scope,
    scopeChapterName,
    homeChapterName,
    canChangeScope,
  } = data;

  // Move the event's money attribution — the SAME `transferEventScope`
  // retroactive/creation flows both use (no second scope-move path). "chapter"
  // always means the event's own home chapter; `homeChapterName` (always
  // concrete), NOT `scopeChapterName` (null while the event currently sits at
  // Central), labels that destination so moving BACK from Central doesn't
  // confirm/label it as a generic "the chapter" (mirrors the project page).
  function handleScopeChange(next: "central" | "chapter") {
    const target = next === "central" ? "central" : event.chapterId;
    const destLabel = next === "central" ? "Central" : homeChapterName ?? "the chapter";
    confirmAction({
      title: `Move to ${destLabel}?`,
      message: `Moves the event and its budget/spend attribution to ${destLabel}.`,
      confirmLabel: "Move",
      onConfirm: () => {
        void transferScope({ eventId, target }).catch(alertError);
      },
    });
  }

  const nameValue = nameInput !== null ? nameInput : event.name;
  const budgetValue =
    budgetInput !== null
      ? budgetInput
      : event.budget != null
        ? String(event.budget)
        : "";
  const locationValue =
    locationInput !== null ? locationInput : (event.location ?? "");

  // Resolved active modules (core + custom, with the event's deltas applied), in
  // canonical order. Supplies & Logistics carries the site map (rendered under
  // its grid by ModuleSection); the volunteer_expectations module is the team
  // EXPECTATIONS list (WHO is on each team lives in CrewSections below).
  const activeModules: ResolvedModule[] = resolvedModules ?? [];

  // The volunteer_expectations module (the team EXPECTATIONS grid) is NOT a tab of
  // its own — it's merged into the Crew tab below, alongside the crew engagements.
  const expectationsModule =
    activeModules.find((m) => m.key === "volunteer_expectations") ?? null;

  // Tabs: Overview + each active module (minus volunteer_expectations) + the
  // combined "Crew & Duties" tab. The active tab lives in the URL (`?tab=`)
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
  // Crew & Duties is team work — show it in Me view if I'm on a team, have
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
  // "Crew & Duties" tab AT the volunteer_expectations slot (so it sits
  // before the post-event Debrief, not after it). In Me view, modules I'm
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
              label: "Crew & Duties",
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
    ...moduleTabs,
    // Fallback: if the expectations module is disabled, still surface Crew last.
    ...(showCrew && !moduleTabs.some((t) => t.key === "crew")
      ? [{ key: "crew", label: "Crew & Duties" }]
      : []),
  ];
  // The event's landing view is the vertical PLAN OVERVIEW (`?tab=plan`, or no
  // tab). Selecting a section drills in to `?tab=<key>`; unknown/missing/legacy
  // (`?tab=overview`) keys fall back to the overview.
  const PLAN = "plan";
  // Tickets (the public RSVP page) and Money (the ONE money surface for
  // this event, retiring the old separate Budget tab) are operational TOOLS,
  // not areas — they open from the overview tools row but live at
  // `?tab=tickets|money` so deep links and back/forward keep working.
  // Money is hidden from that row for training events (the #172 invariant), so a
  // stale/hand-typed `?tab=money` must not bypass it. (The old Gear tool is
  // retired: supply rows with Source = Chapter Storage reserve gear directly,
  // so a stale `?tab=gear` falls back to the overview.)
  const activeTab =
    tab === "tickets" || (tab === "money" && event.isTraining !== true)
      ? tab
      : tabs.some((t) => t.key === tab)
        ? (tab as string)
        : // Mobile lands on the plan overview; desktop has no overview, so it
          // opens the first area with the tab rail visible.
          isMobile
          ? PLAN
          : (tabs[0]?.key ?? "crew");
  // The plan overview is a MOBILE-only surface; on desktop a real section is
  // always active, so `isOverview` is never true there.
  const isOverview = isMobile && activeTab === PLAN;
  // Label shown on a drilled-in section's back bar. "RSVP page" leads with
  // ticketing language once RSVPs are off (see `ticketsLabel` above).
  const activeSectionLabel =
    activeTab === "tickets"
      ? ticketsLabel
      : activeTab === "money"
        ? "Money"
        : (tabs.find((t) => t.key === activeTab)?.label ?? "Section");
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
          { errorTitle: "Couldn't disable area" },
        );
      } else {
        const rowId = customModuleIdByKey.get(module.key);
        if (rowId)
          void run(
            () =>
              deleteCustomModule({ moduleId: rowId as Id<"eventModules"> }),
            { errorTitle: "Couldn't remove area" },
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

  function handleReschedule(ts: number) {
    void run(() => reschedule({ eventId, eventDate: ts }), {
      errorTitle: "Couldn't reschedule",
    });
  }

  async function handleSaveBudget() {
    const trimmed = budgetValue.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && Number.isNaN(parsed)) {
      // Unparseable → revert to the server value; keeping the rejected draft
      // in the buffer would silently mask the real budget on the next open.
      setBudgetInput(null);
      return;
    }
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

  // Enrich each tab into a plan-overview row: its phase/progress (already on the
  // tab) plus the resolved owner, done/total, and an overdue flag (soonest due
  // in the past with work remaining). The Crew tab reads the expectations
  // module's summary/owner.
  const nowTs = Date.now();
  const planSections = tabs.map((t) => {
    const modKey = t.key === "crew" ? "volunteer_expectations" : t.key;
    const summary = summaryByModule.get(modKey);
    const ready = readyByModule.get(modKey) ?? false;
    const mod = activeModules.find((m) => m.key === modKey);
    const ownerName = mod ? (moduleOwner(mod)?.person?.name ?? null) : null;
    const overdue =
      !ready &&
      summary?.nextDueDate != null &&
      summary.nextDueDate < nowTs &&
      (summary.done ?? 0) < (summary.total ?? 0);
    return {
      key: t.key,
      label: t.label,
      phase: t.phase,
      progress: t.progress,
      done: summary?.done,
      total: summary?.total,
      hasStatus: summary?.hasStatus,
      ready,
      ownerName,
      overdue,
    };
  });

  return (
    // Training sandboxes scope every person picker below (roles, grid cells,
    // crew) to the learner + placeholder people — enforced server-side; the
    // scope just carries the event id down to the pickers.
    <SandboxScope value={event.isTraining === true ? String(eventId) : null}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 flex-row">
        <View className="flex-1">
          <Screen maxWidth={FULL_WIDTH}>
        <Narrow>
        <ToastView toast={toast} onDismiss={dismiss} />
        {/* Breadcrumb / back. Tab switches (`?tab=`) update via
            `router.setParams`, which merges params on the CURRENT route
            rather than pushing a new history entry (confirmed against
            expo-router's routing internals) — so `canGoBack`/`back` here
            steps straight past tab noise to wherever actually navigated to
            this event, never through the tabs themselves. */}
        <BackLink fallback="/" />

        {/* Header + What's-next show on desktop (always) and on the mobile plan
            overview. A drilled-in mobile section shows a compact back bar
            instead, since that section's own content headlines the screen. */}
        {!isMobile || isOverview ? (
          <>
        {/* Workspace header — everything from the old Overview edits inline
            here: title, status pill, date/location/budget meta line, and the
            owner + roles row. The pace pill toggles the What's-next panel. */}
        <EventHeader
          event={event}
          eventTypeName={eventTypeName}
          phases={phases}
          expectedPhases={expectedPhases}
          pacePhases={pacePhases}
          budgetSpent={budgetSpent}
          budgetPct={budgetPct}
          nameValue={nameValue}
          onChangeName={setNameInput}
          onSaveName={handleSaveName}
          onSetStatus={(s) =>
            void run(() => setStatus({ eventId, status: s }), {
              errorTitle: "Couldn't change status",
            })
          }
          onReschedule={handleReschedule}
          locationValue={locationValue}
          onChangeLocation={setLocationInput}
          onSaveLocation={handleSaveLocation}
          budgetValue={budgetValue}
          onChangeBudget={setBudgetInput}
          onSaveBudget={handleSaveBudget}
          scope={scope}
          scopeChapterName={scopeChapterName}
          homeChapterName={homeChapterName}
          canChangeScope={canChangeScope}
          onChangeScope={handleScopeChange}
          owner={owner}
          roleRows={roleRows}
          onOpenOwner={() => setOwnerOpen(true)}
          onPickRole={(r) =>
            setPicker({
              roleId: r.roleId,
              roleLabel: r.roleLabel,
              selectedId: r.person?._id ?? null,
            })
          }
          onRenameRole={(roleId, label) =>
            void run(
              () =>
                updateEventRole({
                  roleId: roleId as Id<"eventRoles">,
                  label,
                }),
              { errorTitle: "Couldn't rename role" },
            )
          }
          onDeleteRole={(roleId) =>
            void run(
              () => deleteEventRole({ roleId: roleId as Id<"eventRoles"> }),
              { errorTitle: "Couldn't delete role" },
            )
          }
          onAddRole={(label) =>
            void run(() => createEventRole({ eventId, label }), {
              errorTitle: "Couldn't add role",
            })
          }
          whatsNextOpen={nextOpen}
          onToggleWhatsNext={() => setNextOpen((v) => !v)}
          onSelectPhase={flashPhase}
          activePhase={pulsePhase}
        />

        {/* ── What's next (the old Overview's work half): outstanding work
            (+ guides), or the Me-view work summary while Me view is on.
            Toggled by the header's pace pill; available on any tab. ─────── */}
        {nextOpen ? (
          meView ? (
            <View className="mb-6">
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
            </View>
          ) : (
            <View className="mb-6">
              <SectionHeader title="What's next" />
              {todos ? (
                <EventTodos
                  todos={todos}
                  onOpenTab={(t) => router.setParams({ tab: t })}
                  onSetupAction={handleSetupAction}
                />
              ) : (
                <Text className="py-4 text-sm text-muted">Loading…</Text>
              )}
              <GuidesSection />
            </View>
          )
        ) : null}

          </>
        ) : (
          /* A drilled-in mobile section — a compact way back to the plan; the
             section body renders full-width below. */
          <View className="mb-4 flex-row items-center gap-2.5">
            <Pressable
              onPress={() => router.setParams({ tab: PLAN })}
              className="flex-row items-center gap-1.5 rounded-pill border border-border bg-raised px-3 py-1.5 active:opacity-80"
            >
              <Icon name="arrow-left" size={15} color={colors.ink} />
              <Text className="text-sm font-semibold text-ink">Plan</Text>
            </Pressable>
            <Text
              className="min-w-0 flex-1 font-display text-lg text-ink"
              numberOfLines={1}
            >
              {activeSectionLabel}
            </Text>
          </View>
        )}

        {/* Navigation — desktop keeps the horizontal tab rail with the active
            section always visible below it; the mobile plan overview uses the
            vertical section list; a drilled-in mobile section shows neither
            (its body renders below). */}
        {!isMobile ? (
          <EventTabBar
            tabs={tabs}
            activeKey={activeTab}
            highlightPhase={pulsePhase}
            onSelect={(key) => router.setParams({ tab: key })}
            trailing={
              <EventTools
                eventId={eventId}
                onDayOf={() => router.push(`/event/${eventId}/day-of`)}
                onTickets={() => router.setParams({ tab: "tickets" })}
                ticketsActive={activeTab === "tickets"}
                ticketsLabel={ticketsLabel}
                onMoney={() => router.setParams({ tab: "money" })}
                moneyActive={activeTab === "money"}
                isTraining={event.isTraining === true}
                onSongs={() => router.push(`/event/${eventId}/songs`)}
                meView={meView}
                onToggleMeView={() => setMeView((v) => !v)}
                onDelete={confirmDelete}
              />
            }
            addModule={
              meView
                ? undefined
                : {
                    disabledCore: moduleData?.disabledCore ?? [],
                    onEnableCore: (key) =>
                      void run(
                        () => toggleCoreModule({ eventId, key, enabled: true }),
                        { errorTitle: "Couldn't enable area" },
                      ),
                    onCreateCustom: (label) =>
                      void run(() => createCustomModule({ eventId, label }), {
                        errorTitle: "Couldn't add area",
                      }),
                  }
            }
          />
        ) : isOverview ? (
          <PlanSections
            sections={planSections}
            onSelect={(key) => router.setParams({ tab: key })}
            tools={
              <EventTools
                eventId={eventId}
                onDayOf={() => router.push(`/event/${eventId}/day-of`)}
                onTickets={() => router.setParams({ tab: "tickets" })}
                ticketsActive={false}
                ticketsLabel={ticketsLabel}
                onMoney={() => router.setParams({ tab: "money" })}
                moneyActive={false}
                isTraining={event.isTraining === true}
                onSongs={() => router.push(`/event/${eventId}/songs`)}
                meView={meView}
                onToggleMeView={() => setMeView((v) => !v)}
                onDelete={confirmDelete}
              />
            }
            addModule={
              meView
                ? undefined
                : {
                    disabledCore: moduleData?.disabledCore ?? [],
                    onEnableCore: (key) =>
                      void run(
                        () => toggleCoreModule({ eventId, key, enabled: true }),
                        { errorTitle: "Couldn't enable area" },
                      ),
                    onCreateCustom: (label) =>
                      void run(() => createCustomModule({ eventId, label }), {
                        errorTitle: "Couldn't add area",
                      }),
                  }
            }
          />
        ) : null}
        </Narrow>

        {isOverview ? null : activeTab === "tickets" ? (
          /* ── Tickets: the shareable public page + RSVPs/tickets admin. The
                back-to-plan bar above is the way back. ────────────────────── */
          <Narrow>
            <TicketingTab eventId={eventId} />
          </Narrow>
        ) : activeTab === "money" ? (

          /* ── Money: the ONE money surface for this event (the old separate
                Budget tab is retired onto this one — see `moneyViews.ts`).
                Budget header + "Edit plan" + planned vs actual by category,
                assembled from the v2 budget + its planned lines + linked
                transactions. An operational tool opened from the tools row,
                so it gets the same "Back to planning" affordance. Training
                events never open this (isTraining hides the tool). The
                back-to-plan bar above is the way back. */
          <Narrow>
            <SectionHeader
              title="Money"
              right={
                <View className="flex-row items-center gap-2">
                  <Text className="text-xs font-semibold uppercase tracking-wider text-faint">
                    Belongs to
                  </Text>
                  {canChangeScope ? (
                    <ScopeToggle
                      value={scope === "central" ? "central" : "chapter"}
                      chapterName={homeChapterName ?? "This chapter"}
                      onChange={handleScopeChange}
                    />
                  ) : (
                    <Text className="text-xs font-semibold text-ink">
                      {scope === "central" ? "Central" : (scopeChapterName ?? "This chapter")}
                    </Text>
                  )}
                </View>
              }
            />
            <MoneyView refKind="event" refId={eventId} />
          </Narrow>
        ) : activeTab === "crew" ? (
          /* ── Crew & Duties: WHO is on each team (engagements) plus, below,
                WHAT each team is expected to do (the volunteer_expectations grid). */
          <View className="gap-8">
            <Narrow>
              <CrewSections eventId={eventId} />
            </Narrow>
            {expectationsModule ? (
              <View>
                <SectionHeader title={expectationsModule.label} />
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
                // Mobile drills into one section under a back bar that already
                // names it — suppress the section's own (duplicate) title there.
                hideTitle={isMobile}
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
    </SandboxScope>
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
      <SectionHeader title="Areas you own" count={myModules.length} />
      {myModules.length === 0 ? (
        <Card>
          <Text className="text-base text-muted">
            You don't own any areas on this event.
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
