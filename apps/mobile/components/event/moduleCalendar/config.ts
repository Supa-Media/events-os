/**
 * Shared types, constants, pure helpers, and the PER-MODULE config that drives
 * the reusable Module Calendar. The calendar scaffolding (grid, banner, day
 * panel, composer, copy editing) is identical across day-offset modules; only
 * the fields it surfaces differ, and those differences live here as data.
 *
 *   Comms Schedule — leads with channel logos, tags audience, copy = "Notes".
 *   Planning Doc   — leads with a status glyph, no channels, copy = "Details".
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { IconName } from "../../ui/Icon";

export type ModuleData = FunctionReturnType<typeof api.items.listForEventModule>;
export type ScheduleItem = ModuleData["items"][number];
export type SelectOption = { value: string; label: string; color?: string | null };

/** Below this width the calendar stacks the grid over the day panel. */
export const WIDE = 900;

export const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const WEEKDAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/** What each day-offset module surfaces on its calendar. */
export type ModuleCalendarConfig = {
  module: string;
  /** Singular noun for an item, e.g. "send" / "task" — powers Add/empty copy. */
  itemNoun: string;
  /** Longtext field holding the body a user writes, always editable on a card. */
  copyField: string;
  copyLabel: string;
  copyPlaceholder: string;
  /** Multiselect field rendered as leading logos (channels); null → status glyph. */
  badgeField: string | null;
  /** Multiselect fields shown as tag chips on a card (e.g. audience). */
  metaFields: string[];
  /** Multiselect fields offered as toggle groups in the composer. */
  composerFields: string[];
};

export const MODULE_CALENDAR_CONFIG: Record<string, ModuleCalendarConfig> = {
  comms: {
    module: "comms",
    itemNoun: "send",
    copyField: "notes",
    copyLabel: "Copy",
    copyPlaceholder: "Add the message copy to send…",
    badgeField: "channel",
    metaFields: ["audience"],
    composerFields: ["channel", "audience"],
  },
  planning_doc: {
    module: "planning_doc",
    itemNoun: "task",
    copyField: "details",
    copyLabel: "Details",
    copyPlaceholder: "Add the task details…",
    badgeField: null,
    metaFields: [],
    composerFields: [],
  },
};

/** Module keys that support the calendar view (and its table ↔ calendar toggle). */
export const CALENDAR_MODULES = Object.keys(MODULE_CALENDAR_CONFIG);

/** Comms opens on the calendar by default; others keep the table as home. */
export function defaultCalendarView(module: string): "table" | "calendar" {
  return module === "comms" ? "calendar" : "table";
}

/**
 * Channel value → Feather glyph. Reading WHERE a send goes at a glance is the
 * point, so every channel gets a recognizable icon (Feather ships them, so no
 * native SVG). Unknown channels fall back to "send".
 */
const CHANNEL_ICON: Record<string, IconName> = {
  team_slack: "slack",
  google_chat: "message-circle",
  imessage_group: "message-square",
  ig_post: "instagram",
  ig_stories: "camera",
  email: "mail",
  audience_preferred: "users",
  partiful_posh: "tag",
};

/** Status value → glyph (comms + planning share these semantic names). */
const STATUS_ICON: Record<string, IconName> = {
  not_started: "circle",
  drafted: "edit-3",
  scheduled: "clock",
  sent: "check-circle",
  in_progress: "loader",
  blocked: "alert-circle",
  done: "check-circle",
};

export function channelIcon(value: string): IconName {
  return CHANNEL_ICON[value] ?? "send";
}

export function statusIcon(value: string | undefined): IconName {
  return value ? STATUS_ICON[value] ?? "circle" : "circle";
}

/** Normalize a multiselect field (stored as string[] | string | undefined). */
export function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" && v ? [v] : [];
}

/** The body copy on an item for a given field, or "" when none is set yet. */
export function readCopy(item: ScheduleItem, field: string): string {
  const copy = item.fields?.[field];
  return typeof copy === "string" ? copy : "";
}
