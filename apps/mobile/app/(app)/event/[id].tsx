import { createElement, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Alert,
  TextInput,
  Platform,
  ScrollView,
} from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  ReadinessRing,
  TextField,
  SectionHeader,
  PersonPicker,
  Avatar,
  Icon,
  statusTone,
} from "../../../components/ui";
import { EditableGrid } from "../../../components/grid/EditableGrid";
import { AiAssistantPanel } from "../../../components/ai/AiAssistantPanel";
import { CrewSections } from "../../../components/event/CrewSections";
import { colors } from "../../../lib/theme";
import {
  formatDate,
  formatDateTime,
  parseDateInput,
  toDateInput,
  toDateTimeLocal,
  fromDateTimeLocal,
} from "../../../lib/format";
import {
  MODULE_KEYS,
  MODULE_LABELS,
  MODULE_OWNER_ROLE_KEY,
  EVENT_STATUSES,
  EVENT_STATUS_LABELS,
  type EventStatus,
  type ModuleKey,
} from "@events-os/shared";

export default function EventDetailScreen() {
  const router = useRouter();
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const eventId = id as any;

  const data = useQuery(api.events.get, { eventId });
  const roleRows = useQuery(api.roleAssignments.listForEvent, { eventId });
  const chapterRolesRaw = useQuery(api.roles.list);
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

  // Chapter roles, shaped for the grid's role cells ({_id, label}).
  const chapterRoles = useMemo(
    () =>
      (chapterRolesRaw ?? []).map((r: any) => ({
        _id: r._id as string,
        label: r.label as string,
      })),
    [chapterRolesRaw],
  );

  const loading =
    data === undefined || roleRows === undefined || chapterRolesRaw === undefined;

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
  // role key, then resolve the person assigned to that role on this event.
  function moduleOwner(module: ModuleKey) {
    const roleKey = MODULE_OWNER_ROLE_KEY[module];
    const role = (chapterRolesRaw ?? []).find((r: any) => r.key === roleKey);
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
        <Card className="mb-4">
          <View className="flex-row items-center gap-5">
            <ReadinessRing value={readiness} size={84} />
            <View className="flex-1 gap-2">
              <Text className="text-xs font-bold uppercase tracking-wider text-accent">
                {eventTypeName}
              </Text>
              <TextField
                value={nameValue}
                onChangeText={setNameInput}
                onBlur={handleSaveName}
                placeholder="Event name"
              />
              <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
                <Meta icon="calendar" text={formatDateTime(event.eventDate)} />
                {event.location ? <Meta icon="map-pin" text={event.location} /> : null}
                <Meta icon="check-circle" text={`${taskDone}/${taskTotal} tasks`} />
                {event.budget != null ? (
                  <Meta
                    icon="dollar-sign"
                    text={`$${budgetSpent} / $${event.budget}${
                      event.budget > 0 ? ` · ${budgetPct}%` : ""
                    }`}
                    danger={event.budget > 0 && budgetSpent > event.budget}
                  />
                ) : budgetSpent > 0 ? (
                  <Meta icon="dollar-sign" text={`$${budgetSpent} planned`} />
                ) : null}
              </View>
              <View className="mt-1 flex-row items-center gap-2">
                <Badge
                  label={EVENT_STATUS_LABELS[event.status as EventStatus]}
                  tone={statusTone(event.status as EventStatus)}
                />
                <Button
                  title="Day-of view"
                  icon="play"
                  size="sm"
                  variant="secondary"
                  onPress={() => router.push(`/event/${eventId}/day-of`)}
                />
                <Button
                  title="Site map"
                  icon="map"
                  size="sm"
                  variant="secondary"
                  onPress={() => router.push(`/event/${eventId}/site-map`)}
                />
                <ShareCrewButton eventId={eventId} />
              </View>
            </View>
          </View>
        </Card>

        {/* Module navigation — same tab bar on web + mobile (scrolls on phones) */}
        <TabBar
          tabs={tabs}
          activeKey={activeTab}
          onSelect={(key) => router.setParams({ tab: key })}
        />

        {/* ── Overview: controls + per-module rollup ─────────────────────────── */}
        {activeTab === "overview" ? (
          <>
            <Card padding="md" className="mb-6">
              <View className="flex-row flex-wrap items-start gap-x-6 gap-y-4">
                {/* Roles — inline pills */}
                <ControlBlock label="Roles" count={roleRows.length || undefined}>
                  {roleRows.length === 0 ? (
                    <Text className="text-sm text-faint">No roles</Text>
                  ) : (
                    <View className="flex-row flex-wrap gap-2">
                      {roleRows.map((r) => (
                        <RoleChip
                          key={r.roleId}
                          role={r}
                          onPress={() =>
                            setPicker({
                              roleId: r.roleId,
                              roleLabel: r.roleLabel,
                              selectedId: r.person?._id ?? null,
                            })
                          }
                        />
                      ))}
                    </View>
                  )}
                </ControlBlock>

                {/* Status — inline chips */}
                <ControlBlock label="Status">
                  <View className="flex-row flex-wrap gap-2">
                    {EVENT_STATUSES.map((s) => (
                      <StatusChip
                        key={s}
                        label={EVENT_STATUS_LABELS[s]}
                        tone={statusTone(s)}
                        selected={event.status === s}
                        onPress={() => setStatus({ eventId, status: s })}
                      />
                    ))}
                  </View>
                </ControlBlock>

                {/* Schedule — date + time picker (native datetime-local on web) */}
                <ControlBlock label="Schedule">
                  {Platform.OS === "web" ? (
                    <WebDateTimeInput
                      value={event.eventDate}
                      onChange={(ts) => reschedule({ eventId, eventDate: ts })}
                    />
                  ) : (
                    <View className="flex-row items-center gap-2">
                      <InlineInput
                        value={dateValue}
                        onChangeText={setDateInput}
                        onBlur={handleReschedule}
                        placeholder="YYYY-MM-DD"
                        autoCapitalize="none"
                        width={120}
                      />
                      <Button
                        title="Save"
                        icon="calendar"
                        size="sm"
                        variant="secondary"
                        onPress={handleReschedule}
                        disabled={parseDateInput(dateValue) === null}
                      />
                    </View>
                  )}
                  <Text className="mt-1 text-2xs text-faint">Reflows due dates.</Text>
                </ControlBlock>

                {/* Owner — the single accountable person */}
                <ControlBlock label="Owner">
                  <Pressable
                    onPress={() => setOwnerOpen(true)}
                    className="flex-row items-center gap-2 active:opacity-70"
                  >
                    {owner ? (
                      <>
                        <Avatar name={owner.name} size={22} />
                        <Text className="text-sm font-medium text-ink">
                          {owner.name}
                        </Text>
                      </>
                    ) : (
                      <>
                        <Icon name="user-plus" size={15} color={colors.muted} />
                        <Text className="text-sm text-muted">Assign owner</Text>
                      </>
                    )}
                  </Pressable>
                  <Text className="mt-1 text-2xs text-faint">
                    Keeps details current.
                  </Text>
                </ControlBlock>

                {/* Budget — inline numeric field */}
                <ControlBlock label="Budget">
                  <View className="flex-row items-center gap-2">
                    <InlineInput
                      value={budgetValue}
                      onChangeText={setBudgetInput}
                      onBlur={handleSaveBudget}
                      placeholder="0"
                      keyboardType="numeric"
                      width={80}
                    />
                    <Button
                      title="Save"
                      icon="check"
                      size="sm"
                      variant="secondary"
                      onPress={handleSaveBudget}
                    />
                  </View>
                  <Text className="mt-1 text-2xs text-faint">Blank clears.</Text>
                </ControlBlock>

                {/* Danger — delete affordance */}
                <ControlBlock label="Danger">
                  <Button
                    title="Delete"
                    icon="trash-2"
                    size="sm"
                    variant="danger"
                    onPress={confirmDelete}
                  />
                </ControlBlock>
              </View>
            </Card>

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
                  roles={chapterRoles}
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

// ── Pieces ───────────────────────────────────────────────────────────────────

/**
 * Web-only date+time picker — a real `<input type="datetime-local">` so users
 * get the browser's native calendar/clock instead of typing. Commits on change.
 * (Rendered only when Platform.OS === "web"; native uses the text fallback.)
 */
function WebDateTimeInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (ts: number) => void;
}) {
  return createElement("input", {
    type: "datetime-local",
    value: toDateTimeLocal(value),
    onChange: (e: any) => {
      const ts = fromDateTimeLocal(e.target.value);
      if (ts != null) onChange(ts);
    },
    style: {
      font: "inherit",
      fontSize: 14,
      color: colors.ink,
      border: `1px solid ${colors.border}`,
      borderRadius: 8,
      padding: "6px 10px",
      background: colors.surface,
      outline: "none",
    },
  });
}

/**
 * Copies the event's PUBLIC volunteer-briefing link (/share/<id>) to the
 * clipboard so it can be sent to volunteers — they view it without an account.
 */
function ShareCrewButton({ eventId }: { eventId: string }) {
  const [copied, setCopied] = useState(false);
  function share() {
    const url =
      (typeof window !== "undefined" ? window.location.origin : "") +
      `/share/${eventId}`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } else if (typeof window !== "undefined") {
      window.prompt("Share this volunteer link:", url);
    }
  }
  return (
    <Button
      title={copied ? "Link copied!" : "Share crew"}
      icon={copied ? "check" : "share-2"}
      size="sm"
      variant="secondary"
      onPress={share}
    />
  );
}

type ModuleOwnerInfo = {
  roleId: string;
  roleLabel: string;
  person: { _id: string; name: string } | null;
} | null;

/**
 * Horizontal, scrollable tab bar — Overview, each active module, and Crew. Same
 * component on web and mobile; on a phone it scrolls sideways instead of
 * wrapping so the planning surfaces stay one tap apart.
 */
function TabBar({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: { key: string; label: string }[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <View className="mb-6 border-b border-border">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 4 }}
      >
        {tabs.map((t) => {
          const active = t.key === activeKey;
          return (
            <Pressable
              key={t.key}
              onPress={() => onSelect(t.key)}
              className={`border-b-2 px-3 py-2.5 ${
                active ? "border-accent" : "border-transparent"
              } active:opacity-80`}
            >
              <Text
                className={`text-sm ${
                  active ? "font-semibold text-accent" : "text-muted"
                }`}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * The owning role for a module, rendered as "ROLE → person" (or an Assign
 * affordance). Tapping opens the same role PersonPicker used elsewhere, so
 * setting a module's owner just assigns that role on the event.
 */
function OwnerChip({
  owner,
  onPress,
}: {
  owner: ModuleOwnerInfo;
  onPress: () => void;
}) {
  if (!owner) {
    return <Text className="text-2xs text-faint">No owning role</Text>;
  }
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-2 active:opacity-70"
    >
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {owner.roleLabel}
      </Text>
      {owner.person ? (
        <View className="flex-row items-center gap-1.5">
          <Avatar name={owner.person.name} size={18} />
          <Text className="text-sm text-ink">{owner.person.name}</Text>
        </View>
      ) : (
        <View className="flex-row items-center gap-1">
          <Icon name="user-plus" size={13} color={colors.muted} />
          <Text className="text-sm text-faint">Assign</Text>
        </View>
      )}
    </Pressable>
  );
}

/** The owner banner shown above a single module's grid. */
function ModuleOwnerBar({
  owner,
  onPress,
}: {
  owner: ModuleOwnerInfo;
  onPress: () => void;
}) {
  if (!owner) return null;
  return (
    <Card padding="sm" className="mt-2">
      <View className="flex-row items-center gap-2">
        <Icon name="shield" size={14} color={colors.muted} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          Owner
        </Text>
        <View className="flex-1" />
        <OwnerChip owner={owner} onPress={onPress} />
      </View>
    </Card>
  );
}

/** One row in the overview's per-module rollup. */
function ModuleRollupRow({
  module,
  owner,
  summary,
  first,
  onOpen,
  onAssignOwner,
}: {
  module: ModuleKey;
  owner: ModuleOwnerInfo;
  summary: { total: number; done: number; hasStatus: boolean; nextDueDate: number | null } | undefined;
  first: boolean;
  onOpen: () => void;
  onAssignOwner: () => void;
}) {
  const total = summary?.total ?? 0;
  const done = summary?.done ?? 0;
  const hasStatus = summary?.hasStatus ?? false;
  const nextDueDate = summary?.nextDueDate ?? null;
  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3 ${
        first ? "" : "border-t border-border"
      }`}
    >
      <Pressable onPress={onOpen} className="flex-1 active:opacity-70">
        <Text className="text-sm font-semibold text-ink">
          {MODULE_LABELS[module]}
        </Text>
        <View className="mt-0.5 flex-row flex-wrap items-center gap-x-3 gap-y-0.5">
          <Text className="text-2xs text-muted">
            {hasStatus
              ? `${done}/${total} done`
              : `${total} item${total === 1 ? "" : "s"}`}
          </Text>
          {nextDueDate ? (
            <Text className="text-2xs text-faint">
              Next due {formatDate(nextDueDate)}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <OwnerChip owner={owner} onPress={onAssignOwner} />
      <Pressable onPress={onOpen} className="active:opacity-70">
        <Icon name="chevron-right" size={16} color={colors.faint} />
      </Pressable>
    </View>
  );
}

function Meta({ icon, text, danger }: { icon: any; text: string; danger?: boolean }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon name={icon} size={14} color={danger ? colors.danger : colors.muted} />
      <Text className={`text-base ${danger ? "font-semibold text-danger" : "text-muted"}`}>
        {text}
      </Text>
    </View>
  );
}

/** A compact labelled block in the horizontal controls strip. */
function ControlBlock({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-baseline gap-1.5">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {label}
        </Text>
        {count !== undefined ? (
          <Text className="text-2xs font-semibold text-faint">{count}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** A small bordered text input for the controls strip (no label/hint chrome). */
function InlineInput({
  width,
  ...inputProps
}: React.ComponentProps<typeof TextInput> & { width: number }) {
  const [focused, setFocused] = useState(false);
  const border = focused ? "border-accent" : "border-border-strong";
  return (
    <TextInput
      placeholderTextColor={colors.faint}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        setFocused(false);
        inputProps.onBlur?.(e);
      }}
      style={{ width }}
      className={`rounded-md border ${border} bg-raised px-2.5 py-1.5 text-sm text-ink`}
      {...inputProps}
    />
  );
}

type RoleRow = {
  roleId: string;
  roleLabel: string;
  person: { _id: string; name: string } | null;
};

/** A compact inline pill for one role: label + assigned person or "Assign". */
function RoleChip({ role, onPress }: { role: RoleRow; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-2 rounded-pill border border-border bg-sunken px-2.5 py-1.5 active:opacity-80 web:hover:border-border-strong"
    >
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {role.roleLabel}
      </Text>
      {role.person ? (
        <View className="flex-row items-center gap-1.5">
          <Avatar name={role.person.name} size={18} />
          <Text className="text-sm text-ink">{role.person.name}</Text>
        </View>
      ) : (
        <View className="flex-row items-center gap-1">
          <Icon name="user-plus" size={13} color={colors.muted} />
          <Text className="text-sm text-faint">Assign</Text>
        </View>
      )}
    </Pressable>
  );
}

function StatusChip({
  label,
  tone,
  selected,
  onPress,
}: {
  label: string;
  tone: ReturnType<typeof statusTone>;
  selected: boolean;
  onPress: () => void;
}) {
  const TONE_BORDER: Record<string, string> = {
    warn: "border-warn",
    accent: "border-accent",
    success: "border-success",
    danger: "border-danger",
    neutral: "border-border-strong",
  };
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-pill border px-3 py-1.5 ${
        selected ? `bg-raised ${TONE_BORDER[tone]}` : "border-border bg-sunken"
      } active:opacity-80 web:hover:border-border-strong`}
    >
      <Text className={`text-sm ${selected ? "font-semibold text-ink" : "text-muted"}`}>
        {label}
      </Text>
    </Pressable>
  );
}
