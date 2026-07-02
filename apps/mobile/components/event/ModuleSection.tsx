import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { ResolvedModule } from "@events-os/shared";
import { Button, SectionHeader, Icon } from "../ui";
import type { IconName } from "../ui/Icon";
import { colors } from "../../lib/theme";
import { EditableGrid } from "../grid/EditableGrid";
import { ModuleCalendar } from "./moduleCalendar";
import {
  MODULE_CALENDAR_CONFIG,
  CALENDAR_MODULES,
  defaultCalendarView,
} from "./moduleCalendar/config";
import { SiteMapEditor } from "./SiteMapEditor";
import { ModuleOwnerBar, type ModuleOwnerInfo } from "./EventModuleRollup";

/**
 * One active module's section on the event screen. Renders the owner bar + a
 * "Mark ready / Ready ✓" toggle in the header, then switches on the module's
 * SURFACE: grid modules render the EditableGrid (or, for day-offset modules like
 * Comms/Planning, a table ↔ calendar toggle); the site_map module renders the
 * venue-map editor inline (the same component the standalone route uses).
 */
export function ModuleSection({
  eventId,
  module,
  roles,
  eventDate,
  owner,
  ready,
  onAssignOwner,
  filterItemIds,
}: {
  eventId: string;
  module: ResolvedModule;
  roles: Array<{ _id: string; label: string }>;
  eventDate: number;
  owner: ModuleOwnerInfo;
  ready: boolean;
  onAssignOwner: () => void;
  /** Me view: only show these item ids (for modules the user doesn't own). */
  filterItemIds?: Set<string> | null;
}) {
  const router = useRouter();
  const setReady = useMutation(api.modules.setReady);

  // Day-offset modules (Comms, Planning Doc) can be read as a table or a calendar.
  // Comms opens on the calendar; the rest keep the table as home.
  const hasCalendar = CALENDAR_MODULES.includes(module.key);
  const [view, setView] = useState<"table" | "calendar">(() =>
    defaultCalendarView(module.key),
  );

  return (
    <View>
      <ModuleOwnerBar owner={owner} onPress={onAssignOwner} />
      <SectionHeader
        title={module.label}
        right={
          <View className="flex-row items-center gap-2">
            {hasCalendar ? (
              <ViewToggle
                value={view}
                onChange={setView}
                options={[
                  { key: "table", icon: "list", label: "Table" },
                  { key: "calendar", icon: "calendar", label: "Calendar" },
                ]}
              />
            ) : null}
            {module.key === "supplies" ? (
              <Button
                title="Packing mode"
                icon="package"
                size="sm"
                variant="secondary"
                onPress={() => router.push(`/event/${eventId}/packing`)}
              />
            ) : null}
            <ReadyToggle
              ready={ready}
              onToggle={() =>
                setReady({ eventId: eventId as any, key: module.key, ready: !ready })
              }
            />
          </View>
        }
      />

      {module.surface === "site_map" ? (
        <SiteMapEditor eventId={eventId} embedded />
      ) : hasCalendar && view === "calendar" ? (
        <ModuleCalendar
          eventId={eventId}
          eventDate={eventDate}
          config={MODULE_CALENDAR_CONFIG[module.key]}
          filterItemIds={filterItemIds}
        />
      ) : (
        <EditableGrid
          mode="event"
          parentId={eventId}
          module={module.key as any}
          roles={roles}
          eventDate={eventDate}
          addLabel={`Add ${module.label.toLowerCase()} row`}
          filterItemIds={filterItemIds}
        />
      )}
    </View>
  );
}

/** Small segmented control for switching a module's surface (table ↔ calendar). */
function ViewToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ key: T; icon: IconName; label: string }>;
}) {
  return (
    <View className="flex-row rounded-pill border border-border bg-raised p-0.5">
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            className={`flex-row items-center gap-1.5 rounded-pill px-3 py-1 ${
              active ? "bg-accent-soft" : ""
            } active:opacity-80`}
          >
            <Icon
              name={opt.icon}
              size={13}
              color={active ? colors.accent : colors.muted}
            />
            <Text
              className="text-xs font-semibold"
              style={{ color: active ? colors.accent : colors.muted }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "Mark ready" / "Ready ✓" pill — toggles a module's readiness on the event. */
function ReadyToggle({
  ready,
  onToggle,
}: {
  ready: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable onPress={onToggle} className="active:opacity-70">
      <View
        className="flex-row items-center gap-1.5 rounded-pill border px-3 py-1.5"
        style={{
          backgroundColor: ready ? colors.successBg : "transparent",
          borderColor: ready ? colors.success : colors.border,
        }}
      >
        <Icon
          name={ready ? "check-circle" : "circle"}
          size={14}
          color={ready ? colors.success : colors.muted}
        />
        <Text
          className="text-xs font-semibold"
          style={{ color: ready ? colors.success : colors.muted }}
        >
          {ready ? "Ready" : "Mark ready"}
        </Text>
      </View>
    </Pressable>
  );
}
