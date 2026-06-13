/**
 * Shared domain model for Events OS.
 *
 * Pure constants + helpers used by BOTH the Convex backend and the Expo app, so
 * roles, statuses, column shapes, and date math never drift between the two.
 * Convex schema validators inline literal strings; everything else imports here.
 *
 * The data model is a UNIFIED ITEMS model: every planning surface (planning doc,
 * supplies, comms, run-of-show) is a "module" — a list of items rendered through
 * a configurable set of columns. A template defines the columns + base items; an
 * event clones them and stays locked-but-editable. The few fields the backend
 * computes on (title, offset, status, role, owner, due date) are promoted to real
 * columns on each item; everything else lives in a flexible `fields` bag, so
 * template authors can add custom columns without a schema change.
 */

export const APP_NAME = "Events OS";
export const APP_SLUG = "events-os";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

// ── Roles ──────────────────────────────────────────────────────────────────
// Roles are now editable DB rows (`roles` table), chapter-scoped. These are the
// defaults a new chapter is seeded with — the 4 the events team settled on. They
// can be renamed, reordered, or archived; a template declares which it uses.
export interface RoleSeed {
  key: string;
  label: string;
  description: string;
}

export const DEFAULT_ROLES: RoleSeed[] = [
  {
    key: "event_lead",
    label: "Event Lead / PM",
    description:
      "Final decision maker. Owns the planning doc, runs the meetings, budget approval, permits, and run-of-show calls. Combines event lead + project manager.",
  },
  {
    key: "comms_lead",
    label: "Comms Lead",
    description:
      "The mouthpiece of the event. Owns the comms & content schedule, volunteer coordination, and reminders — anything that contacts people outside the team (music team, marketing).",
  },
  {
    key: "logistics_lead",
    label: "Logistics Lead",
    description:
      "Moves everything point A → B. Owns supplies & packing, ordering missing items, and the day-of physical setup (signs, gear, water).",
  },
  {
    key: "production_lead",
    label: "Production Lead",
    description:
      "Audio/video setup, the run of show + service direction (time-boxing the day), and content capture — contracting the videographer/photographer.",
  },
];

/** Lightweight events (e.g. Worship With Strangers) collapse to these. */
export const LIGHTWEIGHT_ROLE_KEYS = ["event_lead", "comms_lead", "logistics_lead"];

// ── Event status ─────────────────────────────────────────────────────────────
export const EVENT_STATUSES = [
  "planning",
  "ready",
  "completed",
  "cancelled",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  planning: "Planning",
  ready: "Ready",
  completed: "Completed",
  cancelled: "Cancelled",
};

// ── Modules ──────────────────────────────────────────────────────────────────
// The four list-backed planning surfaces. Each module key is also a component
// key (a template toggles which components/modules are active).
export const MODULE_KEYS = [
  "planning_doc",
  "supplies",
  "comms",
  "run_of_show",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  planning_doc: "Planning Doc",
  supplies: "Supplies & Packing",
  comms: "Comms & Content Schedule",
  run_of_show: "Run of Show",
};

/** Modules that schedule off the event date (offset in days → due date). */
export const DAY_OFFSET_MODULES: ModuleKey[] = ["planning_doc", "comms"];
/** Modules that schedule off the event start time (offset in minutes). */
export const MINUTE_OFFSET_MODULES: ModuleKey[] = ["run_of_show"];

// ── Template components ──────────────────────────────────────────────────────
// Every template is assembled from a fixed set of components. Six are core
// (present on every event); two switch on for larger events. The first four are
// the list-backed MODULE_KEYS above.
export const COMPONENT_KEYS = [
  "planning_doc",
  "run_of_show",
  "comms",
  "permits",
  "supplies",
  "retro",
  "volunteer_expectations",
  "day_of_roles",
] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export const CORE_COMPONENTS: ComponentKey[] = [
  "planning_doc",
  "run_of_show",
  "comms",
  "permits",
  "supplies",
  "retro",
];

export const LARGER_EVENT_COMPONENTS: ComponentKey[] = [
  "volunteer_expectations",
  "day_of_roles",
];

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  planning_doc: "Planning Doc",
  run_of_show: "Run of Show",
  comms: "Comms & Content Schedule",
  permits: "Permits",
  supplies: "Supplies & Packing Checklist",
  retro: "Retrospective",
  volunteer_expectations: "Volunteer Expectations",
  day_of_roles: "Day-Of Roles & Responsibilities",
};

// ── Columns ──────────────────────────────────────────────────────────────────
// A column tells the grid how to render/edit a field and (for `system` columns)
// which promoted item field backs it. `custom` columns store their value in the
// item's `fields` bag and are fully add/edit/delete-able by template authors.
export const COLUMN_TYPES = [
  "text",
  "longtext",
  "select",
  "multiselect",
  "status",
  "number",
  "currency",
  "date",
  "url",
  "photo",
  "person",
  "role",
  "offset_days",
  "offset_minutes",
  "due_date",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export type ColumnKind = "system" | "custom";

export interface SelectOption {
  value: string;
  label: string;
  color?: string;
  /** For status options: does this value count as "complete" for readiness? */
  isComplete?: boolean;
}

export interface ColumnDef {
  /** Stable key. For system columns one of SYSTEM_COLUMN_KEYS; else a slug. */
  key: string;
  label: string;
  kind: ColumnKind;
  type: ColumnType;
  options?: SelectOption[];
  /** Reserved for type-specific config (currency format, etc.). */
  config?: Record<string, unknown>;
  isVisible: boolean;
}

/**
 * System columns map to promoted fields on the item:
 *   title    → item.title
 *   offset   → item.offsetDays (day modules) / item.offsetMinutes (run-of-show)
 *   due_date → computed (read-only)
 *   status   → item.status
 *   role     → item.roleId
 *   owner    → eventItem.ownerPersonId (event side only)
 */
export const SYSTEM_COLUMN_KEYS = [
  "title",
  "offset",
  "due_date",
  "status",
  "role",
  "owner",
] as const;
export type SystemColumnKey = (typeof SYSTEM_COLUMN_KEYS)[number];

// ── Status option sets (seed defaults; editable per template) ────────────────
export const TASK_STATUS_OPTIONS: SelectOption[] = [
  { value: "not_started", label: "Not started", color: "red", isComplete: false },
  { value: "in_progress", label: "In progress", color: "amber" },
  { value: "done", label: "Done", color: "green", isComplete: true },
];

export const SUPPLY_STATUS_OPTIONS: SelectOption[] = [
  { value: "pull_from_storage", label: "Pull from storage", color: "blue" },
  { value: "need_to_order", label: "Need to order", color: "red" },
  { value: "need_to_buy", label: "Need to buy", color: "red" },
  { value: "ordered", label: "Ordered", color: "amber" },
  { value: "have_it", label: "Have it", color: "teal" },
  { value: "packed", label: "Packed", color: "green", isComplete: true },
];

export const COMMS_STATUS_OPTIONS: SelectOption[] = [
  { value: "not_started", label: "Not started", color: "red", isComplete: false },
  { value: "drafted", label: "Drafted", color: "amber" },
  { value: "scheduled", label: "Scheduled", color: "blue" },
  { value: "sent", label: "Sent", color: "green", isComplete: true },
];

// ── Select option sets (seed defaults; editable per template) ────────────────
export const SUPPLY_SOURCE_OPTIONS: SelectOption[] = [
  { value: "storage", label: "Storage", color: "blue" },
  { value: "order_online", label: "Order online", color: "amber" },
  { value: "buy_in_store", label: "Buy in-store", color: "orange" },
  { value: "misc", label: "Misc", color: "gray" },
];

export const CONTAINER_OPTIONS: SelectOption[] = [
  { value: "black_luggage", label: "Black luggage", color: "purple" },
  { value: "green_luggage", label: "Green luggage", color: "green" },
  { value: "cooler", label: "Cooler", color: "teal" },
  { value: "car", label: "Car", color: "gray" },
  { value: "on_its_own", label: "On its own", color: "amber" },
  { value: "tbd", label: "TBD", color: "gray" },
];

export const COMMS_CHANNEL_OPTIONS: SelectOption[] = [
  { value: "team_slack", label: "Team Slack", color: "red" },
  { value: "google_chat", label: "Google Chat", color: "green" },
  { value: "imessage_group", label: "iMessage group", color: "blue" },
  { value: "ig_post", label: "IG Post", color: "purple" },
  { value: "ig_stories", label: "IG Stories", color: "pink" },
  { value: "email", label: "Email", color: "gray" },
  { value: "audience_preferred", label: "Audience preferred", color: "teal" },
];

export const COMMS_AUDIENCE_OPTIONS: SelectOption[] = [
  { value: "leaders", label: "Leaders", color: "green" },
  { value: "volunteers", label: "Volunteers", color: "amber" },
  { value: "musicians", label: "Musicians", color: "blue" },
  { value: "attendees", label: "Attendees", color: "teal" },
  { value: "general_public", label: "General public", color: "purple" },
];

// ── Default column sets per module (seed defaults; editable per template) ─────
// Authors reorder/hide/rename these and add custom columns. `system` columns are
// backed by promoted item fields; `custom` columns live in the `fields` bag.
export const DEFAULT_COLUMNS: Record<ModuleKey, ColumnDef[]> = {
  planning_doc: [
    { key: "title", label: "Task", kind: "system", type: "text", isVisible: true },
    { key: "details", label: "Details", kind: "custom", type: "longtext", isVisible: true },
    { key: "status", label: "Status", kind: "system", type: "status", options: TASK_STATUS_OPTIONS, isVisible: true },
    { key: "offset", label: "Timing", kind: "system", type: "offset_days", isVisible: true },
    { key: "due_date", label: "Due", kind: "system", type: "due_date", isVisible: true },
    { key: "role", label: "Role", kind: "system", type: "role", isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
    { key: "notes", label: "Notes", kind: "custom", type: "longtext", isVisible: true },
  ],
  supplies: [
    { key: "title", label: "Item", kind: "system", type: "text", isVisible: true },
    { key: "status", label: "Status", kind: "system", type: "status", options: SUPPLY_STATUS_OPTIONS, isVisible: true },
    { key: "source", label: "Source", kind: "custom", type: "select", options: SUPPLY_SOURCE_OPTIONS, isVisible: true },
    { key: "container", label: "Packed in", kind: "custom", type: "select", options: CONTAINER_OPTIONS, isVisible: true },
    { key: "photo", label: "Photo", kind: "custom", type: "photo", isVisible: true },
    { key: "link", label: "Link", kind: "custom", type: "url", isVisible: true },
    { key: "qty", label: "Qty", kind: "custom", type: "number", isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
    { key: "role", label: "Role", kind: "system", type: "role", isVisible: false },
    { key: "notes", label: "Notes", kind: "custom", type: "longtext", isVisible: true },
  ],
  comms: [
    { key: "title", label: "Comm", kind: "system", type: "text", isVisible: true },
    { key: "offset", label: "Timing", kind: "system", type: "offset_days", isVisible: true },
    { key: "due_date", label: "Date", kind: "system", type: "due_date", isVisible: true },
    { key: "channel", label: "Channel", kind: "custom", type: "multiselect", options: COMMS_CHANNEL_OPTIONS, isVisible: true },
    { key: "audience", label: "Audience", kind: "custom", type: "multiselect", options: COMMS_AUDIENCE_OPTIONS, isVisible: true },
    { key: "status", label: "Status", kind: "system", type: "status", options: COMMS_STATUS_OPTIONS, isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
    { key: "role", label: "Role", kind: "system", type: "role", isVisible: false },
    { key: "notes", label: "Notes / copy", kind: "custom", type: "longtext", isVisible: true },
    { key: "files", label: "Files & media", kind: "custom", type: "photo", isVisible: true },
  ],
  run_of_show: [
    { key: "title", label: "Segment", kind: "system", type: "text", isVisible: true },
    { key: "offset", label: "Time", kind: "system", type: "offset_minutes", isVisible: true },
    { key: "role", label: "Owner / Role", kind: "system", type: "role", isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: false },
    { key: "notes", label: "Notes / Tech", kind: "custom", type: "longtext", isVisible: true },
  ],
};

/** The default status option set for a module (or undefined if no status). */
export function defaultStatusOptions(module: ModuleKey): SelectOption[] | undefined {
  if (module === "planning_doc") return TASK_STATUS_OPTIONS;
  if (module === "supplies") return SUPPLY_STATUS_OPTIONS;
  if (module === "comms") return COMMS_STATUS_OPTIONS;
  return undefined;
}

/** The default status value (first option) for a module, if any. */
export function defaultStatusValue(module: ModuleKey): string | undefined {
  return defaultStatusOptions(module)?.[0]?.value;
}

// ── Date / offset helpers ─────────────────────────────────────────────────────
/**
 * Back-calculate an item's due date from the single event date and its SIGNED
 * day offset. Negative = before the event (T-minus), positive = after (T-plus),
 * 0 = day-of. Moving the event date shifts the whole timeline — no per-item date
 * wrangling, which is the entire reason this app exists.
 */
export function computeDueDate(eventDate: number, offsetDays: number): number {
  return eventDate + offsetDays * DAY_MS;
}

/** Wall-clock time of a run-of-show segment (offset minutes from event start). */
export function computeRunTime(eventStart: number, offsetMinutes: number): number {
  return eventStart + offsetMinutes * MINUTE_MS;
}

/** Format a signed day offset as "T-14" / "T+3" / "Day of". */
export function formatOffsetDays(offsetDays: number): string {
  if (offsetDays === 0) return "Day of";
  return offsetDays < 0 ? `T-${-offsetDays}` : `T+${offsetDays}`;
}

/** Format signed minutes-from-start as "−1:30" style relative label. */
export function formatOffsetMinutes(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "−" : "+";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}:${String(m).padStart(2, "0")}`;
}

// ── Readiness ─────────────────────────────────────────────────────────────────
/** Per-event readiness as a 0–100 integer (complete items / total items). */
export function computeReadiness(total: number, complete: number): number {
  if (total <= 0) return 0;
  return Math.round((complete / total) * 100);
}

/** Whether a status value counts as complete, given the column's option set. */
export function isCompleteStatus(
  options: SelectOption[] | undefined,
  value: string | undefined | null,
): boolean {
  if (!options || value == null) return false;
  return options.some((o) => o.value === value && o.isComplete === true);
}

// ── Vetting status ───────────────────────────────────────────────────────────
export const VETTING_STATUSES = ["unvetted", "pending", "vetted"] as const;
export type VettingStatus = (typeof VETTING_STATUSES)[number];
