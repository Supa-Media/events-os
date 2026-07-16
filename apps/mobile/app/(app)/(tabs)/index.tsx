import { useState } from "react";
import { View, Text, useWindowDimensions, Pressable } from "react-native";
import { useRouter, Redirect } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Screen,
  PageHeader,
  Card,
  Button,
  Badge,
  ReadinessBar,
  EmptyState,
  Icon,
  type IconName,
  Table,
  TableHeader,
  HeaderCell,
  Row,
  Cell,
  statusTone,
  ToastView,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { useActionRunner } from "../../../lib/useActionToast";
import { useChapterContext } from "../../../lib/ChapterContext";
import { TemplatesView } from "../../../components/template/TemplatesView";
import {
  EVENT_STATUS_LABELS,
  PHASE_LABELS,
  type EventStatus,
  type PhaseKey,
} from "@events-os/shared";

/** A single enriched row from `api.events.current`. */
type EventRow = FunctionReturnType<typeof api.events.current>[number];

/** Events has two modes for admins/leads: the events list and its templates. */
type Mode = "events" | "templates";

/**
 * Wide-viewport breakpoint. Mirrors AppShell's `DESKTOP` (760) — at/above it we
 * render the data table; below it the table's fixed columns overlap on narrow
 * screens, so we fall back to a readable card list.
 */
const WIDE = 760;

/** EVENTS — the landing screen. A sortable table of events, or its templates. */
export default function EventsScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const org = useQuery(api.org.nav);
  // Read-only peek (WP-S follow-up): a central-seat holder browsing a
  // different chapter's events. `chapterId` is `undefined` for everyone else
  // (no finance seat at all, or at their own seat) — `events.current`/
  // `events.past` fall back to the caller's own chapter server-side in that
  // case, unchanged from before this feature existed.
  const { context } = useChapterContext();
  const isPeeking = context?.kind === "peek";
  const chapterId: Id<"chapters"> | undefined =
    context?.kind === "peek" ? context.chapterId : undefined;
  const currentEvents = useQuery(api.events.current, { chapterId });
  const pastEvents = useQuery(api.events.past, { chapterId });
  const templates = useQuery(api.templates.list);

  const seed = useMutation(api.seed.seedDemoData);
  const [seeding, setSeeding] = useState(false);
  // Admins/leads can flip Events into its Templates mode (folded in from the
  // old Templates tab); everyone else only ever sees the events list.
  const [mode, setMode] = useState<Mode>("events");
  const { run, toast, dismiss } = useActionRunner();

  // The derived landing: a volunteer has no Events screen — their lobby is the
  // briefing. Decided before the Events data renders (all hooks already ran).
  if (org === undefined) return <Screen loading />;
  if (org.tier === "volunteer") return <Redirect href="/briefing" />;

  const loading =
    currentEvents === undefined ||
    pastEvents === undefined ||
    templates === undefined;
  if (loading) return <Screen loading />;

  // Same gate the old Templates nav entry used — only admins/leads get the
  // segment; members drop straight to the events list. Hidden while peeking
  // too — Templates has no chapterId concept and always reads the caller's
  // own chapter, so it'd be misleading chrome on a foreign chapter's screen.
  const canManageTemplates =
    !isPeeking && (org.tier === "admin" || org.tier === "lead");

  const isEmpty = currentEvents.length === 0;
  const noTemplates = templates.length === 0;

  async function handleSeed() {
    setSeeding(true);
    try {
      await run(() => seed({}), { errorTitle: "Couldn't seed demo data" });
    } finally {
      setSeeding(false);
    }
  }

  // Tapping an event navigates into its full detail screen — but that
  // screen's other tabs (roles, modules, ticketing, budget, gear) are
  // hard-scoped to the caller's OWN chapter via `requireOwned` throughout the
  // app, so they'd throw for a foreign-chapter event. Every row/card below
  // guards its `onPress` with `isPeeking` instead of half-rendering (see
  // `ChapterContext`'s file doc).
  function openEvent(id: string) {
    router.push(`/event/${id}`);
  }

  return (
    <Screen maxWidth={1120}>
      <ToastView toast={toast} onDismiss={dismiss} />
      <PageHeader
        eyebrow="Operations"
        title="Events"
        subtitle="Every upcoming event and how ready it is to run."
        actions={
          // Creating an event always targets the caller's OWN chapter — hidden
          // while peeking so it's never mistaken for "add to the chapter I'm
          // viewing".
          isPeeking ? undefined : (
            <Button
              title="New event"
              icon="plus"
              onPress={() => router.push("/event/new")}
            />
          )
        }
      />

      {/* Events ⇄ Templates — admins/leads only (members never see it). */}
      {canManageTemplates ? (
        <View className="mt-1 flex-row">
          <Segmented
            options={[
              { key: "events", icon: "layout", label: "Events" },
              { key: "templates", icon: "grid", label: "Templates" },
            ]}
            value={mode}
            onChange={setMode}
          />
        </View>
      ) : null}

      {mode === "templates" ? (
        <View className="mt-6">
          <TemplatesView />
        </View>
      ) : (
        <>
          {isEmpty ? (
            <View className="mt-6">
              {isPeeking ? (
                <EmptyState
                  icon="calendar"
                  title="No upcoming events"
                  message="This chapter has nothing on the calendar right now."
                />
              ) : noTemplates ? (
                <EmptyState
                  icon="inbox"
                  title="Nothing here yet"
                  message="Seed some demo data to explore events, templates, and people."
                  action={
                    <Button
                      title="Seed demo data"
                      icon="download"
                      variant="secondary"
                      loading={seeding}
                      onPress={handleSeed}
                    />
                  }
                />
              ) : (
                <EmptyState
                  icon="calendar"
                  title="No upcoming events"
                  message="Start an event from one of your templates."
                  action={
                    <Button
                      title="New event"
                      icon="plus"
                      onPress={() => router.push("/event/new")}
                    />
                  }
                />
              )}
            </View>
          ) : wide ? (
            <View className="mt-6">
              <Table>
                <TableHeader>
                  <HeaderCell flex={3}>Event</HeaderCell>
                  <HeaderCell flex={2}>Type</HeaderCell>
                  <HeaderCell flex={2}>Date</HeaderCell>
                  <HeaderCell flex={2}>Phase readiness</HeaderCell>
                  <HeaderCell width={96}>Blockers</HeaderCell>
                  <HeaderCell width={108}>Status</HeaderCell>
                </TableHeader>
                {currentEvents.map((e, i) => (
                  <Row
                    key={e._id}
                    last={i === currentEvents.length - 1}
                    onPress={isPeeking ? undefined : () => openEvent(e._id)}
                  >
                    <Cell flex={3}>
                      <Text className="text-base font-semibold text-ink" numberOfLines={1}>
                        {e.name}
                      </Text>
                      <Text className="mt-0.5 text-sm text-muted">
                        {e.taskDone}/{e.taskTotal} tasks done
                      </Text>
                    </Cell>
                    <Cell flex={2}>
                      <Text className="text-base text-muted" numberOfLines={1}>
                        {e.eventTypeName}
                      </Text>
                    </Cell>
                    <Cell flex={2}>
                      <Text className="text-base text-ink">{formatDate(e.eventDate)}</Text>
                    </Cell>
                    <Cell flex={2}>
                      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                        {PHASE_LABELS[e.currentPhase as PhaseKey] ?? "Planning"}
                      </Text>
                      {e.currentPhasePct == null ? (
                        <Text className="mt-0.5 text-sm text-faint">—</Text>
                      ) : (
                        <View className="mt-0.5">
                          <ReadinessBar value={e.currentPhasePct} />
                        </View>
                      )}
                    </Cell>
                    <Cell width={96}>
                      {e.blockerCount > 0 ? (
                        <Badge label={String(e.blockerCount)} tone="danger" icon="alert-triangle" />
                      ) : (
                        <Text className="text-sm text-faint">—</Text>
                      )}
                    </Cell>
                    <Cell width={108}>
                      <Badge
                        label={EVENT_STATUS_LABELS[e.status as EventStatus]}
                        tone={statusTone(e.status as EventStatus)}
                      />
                    </Cell>
                  </Row>
                ))}
              </Table>
            </View>
          ) : (
            <View className="mt-6 gap-3">
              {currentEvents.map((e) => (
                <EventCard
                  key={e._id}
                  event={e}
                  onPress={isPeeking ? undefined : () => openEvent(e._id)}
                />
              ))}
            </View>
          )}

          {/* Past events (date + 2-week grace behind us): hidden by default,
              expand to review. They no longer send task reminders. */}
          <PastEventsSection
            events={pastEvents}
            onOpen={isPeeking ? undefined : openEvent}
          />
        </>
      )}
    </Screen>
  );
}

/**
 * The collapsed "Past events" section under the current events list. Renders the
 * same cards, but folded away by default so the screen leads with live work.
 */
function PastEventsSection({
  events,
  onOpen,
}: {
  events: EventRow[];
  /** `undefined` while peeking — an event's detail screen isn't peek-safe. */
  onOpen?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  return (
    <View className="mt-8">
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-2 rounded-md px-1 py-1.5 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={16}
          color={colors.muted}
        />
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          Past events
        </Text>
        <Text className="text-2xs font-bold text-faint">{events.length}</Text>
      </Pressable>
      {open ? (
        <View className="mt-3 gap-3">
          {events.map((e) => (
            <EventCard
              key={e._id}
              event={e}
              onPress={onOpen ? () => onOpen(e._id) : undefined}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Narrow-viewport event row. Renders the same data as a table row but stacked
 * into a tappable card so nothing overlaps or truncates on phones.
 */
function EventCard({
  event,
  onPress,
}: {
  event: EventRow;
  /** `undefined` while peeking — an event's detail screen isn't peek-safe. */
  onPress?: () => void;
}) {
  return (
    <Card onPress={onPress} padding="md">
      <View className="flex-row items-start gap-3">
        <View className="flex-1">
          <Text className="text-base font-semibold text-ink" numberOfLines={2}>
            {event.name}
          </Text>
          <Text className="mt-0.5 text-sm text-muted" numberOfLines={1}>
            {event.eventTypeName} · {formatDate(event.eventDate)}
          </Text>
        </View>
        <Badge
          label={EVENT_STATUS_LABELS[event.status as EventStatus]}
          tone={statusTone(event.status as EventStatus)}
        />
      </View>

      <View className="mt-3">
        <View className="flex-row items-center justify-between">
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {PHASE_LABELS[event.currentPhase as PhaseKey] ?? "Planning"}
          </Text>
          <Text className="text-sm text-muted">
            {event.taskDone}/{event.taskTotal} tasks
          </Text>
        </View>
        {event.currentPhasePct != null ? (
          <View className="mt-1.5">
            <ReadinessBar value={event.currentPhasePct} />
          </View>
        ) : null}
      </View>

      {event.blockerCount > 0 ? (
        <View className="mt-2.5 flex-row">
          <Badge
            label={`${event.blockerCount} blocker${event.blockerCount === 1 ? "" : "s"}`}
            tone="danger"
            icon="alert-triangle"
          />
        </View>
      ) : null}
    </Card>
  );
}

/**
 * The compact segmented toggle for the Events ⇄ Templates modes. Mirrors the
 * Work tab's local `Segmented` (kept per-screen — the two never share state).
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; icon: IconName; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <View
      className="flex-row rounded-lg bg-sunken"
      style={{ padding: 3, gap: spacing.xs }}
    >
      {options.map((v) => {
        const active = value === v.key;
        return (
          <Pressable
            key={v.key}
            onPress={() => onChange(v.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            className={`flex-row items-center gap-1.5 rounded-md px-2.5 py-1 active:opacity-80 ${
              active ? "bg-raised shadow-sm" : ""
            }`}
          >
            <Icon
              name={v.icon}
              size={13}
              color={active ? colors.ink : colors.muted}
            />
            <Text
              className={`text-xs font-semibold ${
                active ? "text-ink" : "text-muted"
              }`}
            >
              {v.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
