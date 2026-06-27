import { useState } from "react";
import { View, Text } from "react-native";
import {
  Card,
  Button,
  Badge,
  PhaseBreakdown,
  TextField,
  Icon,
  statusTone,
} from "../ui";
import { colors } from "../../lib/theme";
import { formatDateTime } from "../../lib/format";
import {
  EVENT_STATUS_LABELS,
  type EventStatus,
  type PhaseScores,
} from "@events-os/shared";

/**
 * Workspace header for an event — readiness ring, inline-editable name, the
 * meta strip (date/location/tasks/budget), status badge, and the day-of /
 * me-view / share affordances.
 */
export function EventHeader({
  event,
  eventId,
  eventTypeName,
  phases,
  taskDone,
  taskTotal,
  budgetSpent,
  budgetPct,
  nameValue,
  onChangeName,
  onSaveName,
  onDayOf,
  meView,
  onToggleMeView,
}: {
  event: any;
  eventId: string;
  eventTypeName: string;
  phases: PhaseScores;
  taskDone: number;
  taskTotal: number;
  budgetSpent: number;
  budgetPct: number;
  nameValue: string;
  onChangeName: (text: string) => void;
  onSaveName: () => void;
  onDayOf: () => void;
  meView: boolean;
  onToggleMeView: () => void;
}) {
  return (
    <Card className="mb-4">
      <View className="flex-row flex-wrap items-start gap-5">
        <View className="flex-1 gap-2" style={{ minWidth: 280 }}>
          <Text className="text-xs font-bold uppercase tracking-wider text-accent">
            {eventTypeName}
          </Text>
          <TextField
            value={nameValue}
            onChangeText={onChangeName}
            onBlur={onSaveName}
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
              onPress={onDayOf}
            />
            <Button
              title="Me view"
              icon="user"
              size="sm"
              variant={meView ? "primary" : "secondary"}
              onPress={onToggleMeView}
            />
            <ShareCrewButton eventId={eventId} />
          </View>
        </View>

        {/* Phase readiness — four small rings (Pre-plan / Planning / Day-of /
            Post). Replaces the old single readiness ring. */}
        <View className="justify-center">
          <PhaseBreakdown phases={phases} size={54} />
        </View>
      </View>
    </Card>
  );
}

/**
 * Copies the event's PUBLIC volunteer-briefing link (/share/<id>) to the
 * clipboard so it can be sent to volunteers — they view it without an account.
 */
export function ShareCrewButton({ eventId }: { eventId: string }) {
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

export function Meta({ icon, text, danger }: { icon: any; text: string; danger?: boolean }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon name={icon} size={14} color={danger ? colors.danger : colors.muted} />
      <Text className={`text-base ${danger ? "font-semibold text-danger" : "text-muted"}`}>
        {text}
      </Text>
    </View>
  );
}
