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
// Single source of truth for the event lifecycle. Exported as a readonly tuple
// so the Convex schema can build its validator from this array
// (`v.union(...EVENT_STATUSES.map(v.literal))`) instead of re-listing literals —
// keeping schema + app in lock-step without pulling convex/values in here.
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
// The built-in planning surfaces (keys + type). A template/event toggles which
// modules are active; see CORE_MODULES for the full registry.
export const MODULE_KEYS = [
  "planning_doc",
  "comms",
  "run_of_show",
  "volunteer_expectations",
  "site_map",
  "supplies",
  "permits",
  "retro",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** How a module renders. Grid modules use the spreadsheet EditableGrid; bespoke
 *  surfaces (e.g. the site map, wired up in a later phase) render their own
 *  editor instead of a grid. */
export type ModuleSurface = "grid" | "site_map";

/** How a module's rows schedule relative to the event. */
export type ModuleOffsetMode = "none" | "days" | "minutes";

/**
 * A platform-wide CORE module definition.
 *
 * `defaultOwnerRoleKey` maps a module to the ROLE that owns it (resolved to a
 * person via roleAssignments) — reusing the role infra instead of a third owner
 * concept. Defaults mirror the role descriptions (event_lead owns the planning
 * doc + permits, comms_lead owns comms + volunteer coordination, logistics_lead
 * owns supplies, production_lead owns the run of show). Per-template/event owner
 * overrides layer on later.
 */
export interface CoreModuleDef {
  key: ModuleKey;
  label: string;
  surface: ModuleSurface;
  defaultOwnerRoleKey: string;
  offsetMode: ModuleOffsetMode;
}

/**
 * CORE module registry — the single source of truth for the built-in modules,
 * in display order. Every template/event gets these; they can be toggled off but
 * never deleted (custom modules are added per template). The derived maps below
 * (labels, owner, offsets) are projections of this list, so there is one place
 * to edit a core module.
 */
export const CORE_MODULES: CoreModuleDef[] = [
  // Display order (drives tabs/chips/rollup). volunteer_expectations is the
  // merged "Crew & Expectations" tab on events. Retrospective stays last (post).
  { key: "planning_doc", label: "Planning Doc", surface: "grid", defaultOwnerRoleKey: "event_lead", offsetMode: "days" },
  { key: "comms", label: "Comms Schedule", surface: "grid", defaultOwnerRoleKey: "comms_lead", offsetMode: "days" },
  { key: "run_of_show", label: "Run of Show", surface: "grid", defaultOwnerRoleKey: "production_lead", offsetMode: "minutes" },
  { key: "volunteer_expectations", label: "Expectations", surface: "grid", defaultOwnerRoleKey: "comms_lead", offsetMode: "none" },
  // Site map is a non-grid core module: it renders the venue-map editor instead
  // of a spreadsheet grid (surface !== "grid"), so grid-only code paths skip it.
  { key: "site_map", label: "Site Map", surface: "site_map", defaultOwnerRoleKey: "logistics_lead", offsetMode: "none" },
  { key: "supplies", label: "Supplies & Packing", surface: "grid", defaultOwnerRoleKey: "logistics_lead", offsetMode: "none" },
  { key: "permits", label: "Permits", surface: "grid", defaultOwnerRoleKey: "event_lead", offsetMode: "days" },
  { key: "retro", label: "Retrospective", surface: "grid", defaultOwnerRoleKey: "event_lead", offsetMode: "none" },
];

/**
 * The grid-backed core modules, in order. Grid-only code paths (column seeding,
 * default columns, module summaries) iterate these — never `site_map`.
 */
export const GRID_CORE_MODULE_KEYS: ModuleKey[] = CORE_MODULES.filter(
  (m) => m.surface === "grid",
).map((m) => m.key);

/** Core module keys, in display order. */
export const CORE_MODULE_KEYS: ModuleKey[] = CORE_MODULES.map((m) => m.key);

// ── Derived views of CORE_MODULES (single source of truth above) ─────────────
export const MODULE_LABELS: Record<ModuleKey, string> = Object.fromEntries(
  CORE_MODULES.map((m) => [m.key, m.label]),
) as Record<ModuleKey, string>;

export const MODULE_OWNER_ROLE_KEY: Record<ModuleKey, string> = Object.fromEntries(
  CORE_MODULES.map((m) => [m.key, m.defaultOwnerRoleKey]),
) as Record<ModuleKey, string>;

/** Modules that schedule off the event date (offset in days → due date). */
export const DAY_OFFSET_MODULES: ModuleKey[] = CORE_MODULES.filter(
  (m) => m.offsetMode === "days",
).map((m) => m.key);
/** Modules that schedule off the event start time (offset in minutes). */
export const MINUTE_OFFSET_MODULES: ModuleKey[] = CORE_MODULES.filter(
  (m) => m.offsetMode === "minutes",
).map((m) => m.key);

// ── Module deltas + active-module resolution ─────────────────────────────────
// Core modules are platform-wide constants (CORE_MODULES). A template/event
// stores only DELTAS against them: which core keys are toggled off, per-core
// label/owner overrides, plus its own CUSTOM module rows. `resolveActiveModules`
// folds those into one ordered active list, used by both the editors and the
// event screen so the frontend never does the delta math itself.

/** A per-core override: rename and/or repoint a core module's owner role. */
export interface ModuleOverride {
  key: string;
  label?: string;
  ownerRoleKey?: string;
}

/** A custom (author-created) module row — always a grid surface. */
export interface CustomModule {
  key: string;
  label: string;
  surface: "grid";
  ownerRoleKey?: string;
  offsetMode: ModuleOffsetMode;
  order: number;
  isActive?: boolean;
}

/** The module-delta state a template or event carries. */
export interface ScopeModuleState {
  disabledCoreModules?: string[];
  coreModuleOverrides?: ModuleOverride[];
  customModules: CustomModule[];
}

/** A fully-resolved active module (core or custom), ready to render. */
export interface ResolvedModule {
  key: string;
  label: string;
  surface: ModuleSurface;
  ownerRoleKey: string | undefined;
  offsetMode: ModuleOffsetMode;
  isCore: boolean;
}

/** Apply a scope's per-core override (label / owner) to a core module. */
function applyOverride(
  m: CoreModuleDef,
  overrides: ModuleOverride[] | undefined,
): ResolvedModule {
  const o = overrides?.find((ov) => ov.key === m.key);
  return {
    key: m.key,
    label: o?.label ?? m.label,
    surface: m.surface,
    ownerRoleKey: o?.ownerRoleKey ?? m.defaultOwnerRoleKey,
    offsetMode: m.offsetMode,
    isCore: true,
  };
}

/**
 * Resolve a scope's ordered active module list: platform core modules (minus
 * `disabledCoreModules`, with overrides applied) followed by its active custom
 * modules in `order`.
 */
export function resolveActiveModules(scope: ScopeModuleState): ResolvedModule[] {
  const disabled = new Set(scope.disabledCoreModules ?? []);
  const core: ResolvedModule[] = CORE_MODULES.filter(
    (m) => !disabled.has(m.key),
  ).map((m) => applyOverride(m, scope.coreModuleOverrides));

  const custom: ResolvedModule[] = [...scope.customModules]
    .filter((c) => c.isActive !== false)
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      key: c.key,
      label: c.label,
      surface: c.surface,
      ownerRoleKey: c.ownerRoleKey,
      offsetMode: c.offsetMode,
      isCore: false,
    }));

  return [...core, ...custom];
}

/**
 * The core modules a scope currently has DISABLED, as resolved defs — used by an
 * editor to offer "re-enable" controls (event side re-enables a template-off
 * core; template side just re-toggles).
 */
export function disabledCoreModules(scope: ScopeModuleState): ResolvedModule[] {
  const disabled = new Set(scope.disabledCoreModules ?? []);
  return CORE_MODULES.filter((m) => disabled.has(m.key)).map((m) =>
    applyOverride(m, scope.coreModuleOverrides),
  );
}

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
  // Links a cell to a standalone doc (link / video / note / markdown page) that
  // opens natively and is shareable on its own URL. Cell value = the doc id.
  "how_to",
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

export const PERMIT_STATUS_OPTIONS: SelectOption[] = [
  { value: "not_needed", label: "Not needed", color: "gray" },
  { value: "to_apply", label: "To apply", color: "red", isComplete: false },
  { value: "submitted", label: "Submitted", color: "amber" },
  { value: "approved", label: "Approved", color: "green", isComplete: true },
];

export const RETRO_STATUS_OPTIONS: SelectOption[] = [
  { value: "open", label: "Open", color: "amber" },
  { value: "actioned", label: "Actioned", color: "green", isComplete: true },
];

export const VOLUNTEER_TEAM_OPTIONS: SelectOption[] = [
  { value: "flower", label: "Flower", color: "pink" },
  { value: "food_bev", label: "Food & Bev", color: "amber" },
  { value: "welcome", label: "Welcome", color: "blue" },
  { value: "prayer", label: "Prayer", color: "purple" },
  { value: "content", label: "Content", color: "teal" },
  { value: "production", label: "Production", color: "gray" },
];

/** Site-map marker categories (what a pin represents) + their pin colors. */
export const SITE_MARKER_CATEGORIES: SelectOption[] = [
  { value: "station", label: "Station", color: "red" },
  { value: "team", label: "Team area", color: "pink" },
  { value: "stage", label: "Stage / Worship", color: "amber" },
  { value: "prayer", label: "Prayer", color: "purple" },
  { value: "equipment", label: "Equipment", color: "blue" },
  { value: "entrance", label: "Entrance", color: "teal" },
  { value: "parking", label: "Parking", color: "gray" },
  { value: "other", label: "Other", color: "gray" },
];

export const VOLUNTEER_STATUS_OPTIONS: SelectOption[] = [
  { value: "invited", label: "Invited", color: "gray" },
  { value: "confirmed", label: "Confirmed", color: "green", isComplete: true },
  { value: "declined", label: "Declined", color: "red" },
];

// ── Default column sets per module (seed defaults; editable per template) ─────
// Authors reorder/hide/rename these and add custom columns. `system` columns are
// backed by promoted item fields; `custom` columns live in the `fields` bag.
// `site_map` has no grid columns (surface !== "grid"), so it's intentionally
// absent here — hence Partial. Grid code paths look modules up by key and skip
// anything without a column set.
export const DEFAULT_COLUMNS: Partial<Record<ModuleKey, ColumnDef[]>> = {
  planning_doc: [
    { key: "title", label: "Task", kind: "system", type: "text", isVisible: true },
    { key: "details", label: "Details", kind: "custom", type: "longtext", isVisible: true },
    { key: "status", label: "Status", kind: "system", type: "status", options: TASK_STATUS_OPTIONS, isVisible: true },
    { key: "offset", label: "Timing", kind: "system", type: "offset_days", isVisible: true },
    { key: "due_date", label: "Due", kind: "system", type: "due_date", isVisible: true },
    { key: "role", label: "Role", kind: "system", type: "role", isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
    { key: "cost", label: "Cost", kind: "custom", type: "currency", isVisible: true },
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
    { key: "cost", label: "Cost", kind: "custom", type: "currency", isVisible: true },
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
    { key: "cost", label: "Cost", kind: "custom", type: "currency", isVisible: false },
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
  permits: [
    { key: "title", label: "Permit", kind: "system", type: "text", isVisible: true },
    { key: "status", label: "Status", kind: "system", type: "status", options: PERMIT_STATUS_OPTIONS, isVisible: true },
    { key: "offset", label: "Deadline", kind: "system", type: "offset_days", isVisible: true },
    { key: "due_date", label: "Due", kind: "system", type: "due_date", isVisible: true },
    { key: "document", label: "Document", kind: "custom", type: "photo", isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
    { key: "notes", label: "Notes", kind: "custom", type: "longtext", isVisible: true },
  ],
  retro: [
    { key: "title", label: "What happened", kind: "system", type: "text", isVisible: true },
    { key: "status", label: "Status", kind: "system", type: "status", options: RETRO_STATUS_OPTIONS, isVisible: true },
    { key: "notes", label: "Detail", kind: "custom", type: "longtext", isVisible: true },
    { key: "link", label: "Link", kind: "custom", type: "url", isVisible: true },
  ],
  // Rows are EXPECTATIONS (things we expect a team to do), each tagged to a
  // team/area. The team column's options ARE the event's team list — both these
  // rows and volunteer engagements reference those team values. WHO is on each
  // team is tracked on engagements (the Volunteers list), not here.
  volunteer_expectations: [
    { key: "title", label: "Expectation", kind: "system", type: "text", isVisible: true },
    { key: "team", label: "Team", kind: "custom", type: "select", options: VOLUNTEER_TEAM_OPTIONS, isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
    { key: "details", label: "Details", kind: "custom", type: "longtext", isVisible: true },
    { key: "how_to", label: "How-To", kind: "custom", type: "how_to", isVisible: true },
  ],
};

/**
 * Generic starter column set for a NEW custom module: the system Title plus a
 * Status, Owner, and Notes column. Authors reorder/hide/rename and add their own
 * from here — same shape as a core module's default columns.
 */
export const DEFAULT_CUSTOM_COLUMNS: ColumnDef[] = [
  { key: "title", label: "Title", kind: "system", type: "text", isVisible: true },
  { key: "status", label: "Status", kind: "system", type: "status", options: TASK_STATUS_OPTIONS, isVisible: true },
  { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
  { key: "notes", label: "Notes", kind: "custom", type: "longtext", isVisible: true },
];

/** The default status option set for a module (or undefined if no status). */
export function defaultStatusOptions(module: ModuleKey): SelectOption[] | undefined {
  if (module === "planning_doc") return TASK_STATUS_OPTIONS;
  if (module === "supplies") return SUPPLY_STATUS_OPTIONS;
  if (module === "comms") return COMMS_STATUS_OPTIONS;
  if (module === "permits") return PERMIT_STATUS_OPTIONS;
  if (module === "retro") return RETRO_STATUS_OPTIONS;
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

/**
 * Bucket a 0–100 readiness percentage into a semantic tier. Returns the TIER
 * only — consumers map tier → color/class in their own layer (theme.ts,
 * Readiness.tsx), so the threshold rule (<34 danger · <67 warn · else success)
 * lives in exactly one place instead of being hand-coded per surface.
 */
export function readinessTier(pct: number): "danger" | "warn" | "success" {
  if (pct < 34) return "danger";
  if (pct < 67) return "warn";
  return "success";
}

/** Whether a status value counts as complete, given the column's option set. */
export function isCompleteStatus(
  options: SelectOption[] | undefined,
  value: string | undefined | null,
): boolean {
  if (!options || value == null) return false;
  return options.some((o) => o.value === value && o.isComplete === true);
}

// ── Phase-based readiness ────────────────────────────────────────────────────
// The single readiness % is replaced by FOUR phase numbers, so the team can see
// not just "how done is this event" but "how done is each stage of running it":
//   pre-plan  — explicit author-marked cells checked off (a separate mechanism;
//               see prePlanScore below — it is NOT derived from item status)
//   planning  — prep work scheduled before the event (T-minus)
//   dayOf     — packing, run-of-show, and anything that lands on the event day
//   post      — retro + follow-up after the event (T-plus)
//
// Scoring uses three primitives:
//   itemScore   — 1 (complete) / 0.5 (started, "partial") / 0 (not started)
//   moduleScore — average itemScore over that module's items in a phase
//   phaseScore  — average moduleScore over modules with ≥1 item in the phase
// A phase with no items anywhere is null (rendered "—"), so an empty phase does
// NOT read as "0% ready". Equal-weight modules naturally cap any one module's
// influence (Supplies is one module no matter how many packing rows it has).

export const PHASE_KEYS = ["prePlan", "planning", "dayOf", "post"] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];

export const PHASE_LABELS: Record<PhaseKey, string> = {
  prePlan: "Pre-plan",
  planning: "Planning",
  dayOf: "Day-of",
  post: "Post",
};

/** A phase score is 0..1, or null when the phase has no items to measure. */
export type PhaseScores = Record<PhaseKey, number | null>;

/**
 * Which phase each module's "mark as ready" gate counts toward — for BOTH the
 * Overview "What's next" to-dos and the phase readiness rings, so the two never
 * drift. Modules absent here have no ready gate (e.g. planning_doc, retro).
 *   comms / permits                                       → pre-plan
 *   run_of_show / site_map / volunteer_expectations /
 *   supplies                                              → planning
 * Note: volunteer_expectations ITEMS phase to dayOf (itemPhase); only its
 * "mark ready" gate is a planning milestone.
 */
export const MODULE_READY_PHASE: Record<string, PhaseKey> = {
  comms: "prePlan",
  permits: "prePlan",
  run_of_show: "planning",
  site_map: "planning",
  volunteer_expectations: "planning",
  supplies: "planning",
};

/**
 * Status values that count as "started but not complete" → itemScore 0.5.
 *
 * The rule is "started toward done, but not done". Choices per vocabulary:
 *   tasks    — `in_progress` (only non-terminal status)
 *   comms    — `drafted`, `scheduled` (drafting/queued toward `sent`)
 *   permits  — `to_apply`, `submitted` (in flight toward `approved`). `to_apply`
 *              is "we know we need it and intend to apply" — meaningful progress
 *              over no status at all; `not_needed` is terminal-but-not-complete
 *              so it stays 0 (it genuinely isn't done/handled work).
 *   supplies — `need_to_order`, `need_to_buy`, `ordered`, `have_it`,
 *              `pull_from_storage` (all en route to `packed`). Note: `need_to_*`
 *              count as 0.5 because the item is identified + sourced, which is
 *              real progress toward packing.
 *   retro    — `open` is the not-started state, so retro has no partial value.
 *   volunteer — `invited` is in-flight toward `confirmed`.
 * `not_started`, `not_needed`, `declined`, `open`, `tbd` and any unknown value
 * fall through to 0.
 */
export const PARTIAL_STATUS_VALUES: Set<string> = new Set([
  // tasks / custom modules
  "in_progress",
  // comms
  "drafted",
  "scheduled",
  // permits
  "to_apply",
  "submitted",
  // supplies
  "need_to_order",
  "need_to_buy",
  "ordered",
  "have_it",
  "pull_from_storage",
  // volunteer engagement-ish
  "invited",
]);

/**
 * Score a single item 1 / 0.5 / 0 from its status + the module's status options.
 *   1   — status is a `isComplete` option
 *   0.5 — status is in PARTIAL_STATUS_VALUES (started, not done)
 *   0   — no status, or a not-started/terminal-incomplete status
 */
export function itemScore(
  options: SelectOption[] | undefined,
  value: string | undefined | null,
): number {
  if (value == null) return 0;
  if (isCompleteStatus(options, value)) return 1;
  if (PARTIAL_STATUS_VALUES.has(value)) return 0.5;
  return 0;
}

/**
 * Assign an item to exactly one phase from its module + timing. Pre-plan is a
 * separate mechanism (explicit check-off) and is never returned here.
 *   retro module                 → post
 *   supplies module              → dayOf (packing / load-in)
 *   minute-offset (run_of_show)  → dayOf
 *   else by offsetDays: <0 planning · 0 dayOf · >0 post
 *   no timing at all             → planning (default prep)
 */
export function itemPhase(item: {
  module: string;
  offsetDays?: number | null;
  offsetMinutes?: number | null;
}): Exclude<PhaseKey, "prePlan"> {
  if (item.module === "retro") return "post";
  // Supplies (packing/load-in) and volunteer expectations (what each team does
  // on the day) are day-of work, regardless of any offset.
  if (item.module === "supplies" || item.module === "volunteer_expectations")
    return "dayOf";
  if (item.offsetMinutes != null) return "dayOf";
  if (item.offsetDays != null) {
    if (item.offsetDays < 0) return "planning";
    if (item.offsetDays === 0) return "dayOf";
    return "post";
  }
  return "planning";
}

/**
 * Compute the four timing-based phase scores (planning / dayOf / post) plus a
 * pre-plan score from a flat list of items grouped by module.
 *
 * `modules` is the list of (module key, its status options, its items). Each
 * item carries `status`, `offsetDays`, `offsetMinutes`, plus the pre-plan
 * arrays. Returns 0..1 per phase, or null when a phase has no measurable items.
 */
export function computePhaseScores(
  modules: Array<{
    module: string;
    statusOptions: SelectOption[] | undefined;
    items: Array<{
      status?: string | null;
      offsetDays?: number | null;
      offsetMinutes?: number | null;
      prePlanColumns?: string[];
      prePlanChecked?: string[];
    }>;
  }>,
  // Extra pre-plan items the backend supplies — assigning each event ROLE and
  // each module OWNER counts as a pre-plan item, equally weighted with the
  // template-marked cells. `done` = how many are assigned; `total` = how many
  // exist.
  prePlanExtra?: { done: number; total: number },
  // Module "mark as ready" gates. Each gate is a unit of work in its phase: a
  // ready gate counts as 1, an unmet gate as 0. Pre-plan gates fold into the
  // pre-plan count; timing-phase gates weigh as one module-equivalent.
  moduleReady?: Array<{ phase: PhaseKey; ready: boolean }>,
): PhaseScores {
  type TimingPhase = Exclude<PhaseKey, "prePlan">;
  // Per phase: collect each module's average itemScore (only for modules that
  // have ≥1 item in that phase), then average those module scores.
  const moduleScores: Record<TimingPhase, number[]> = {
    planning: [],
    dayOf: [],
    post: [],
  };

  // Pre-plan accumulators (across all modules/items).
  let prePlanMarked = 0;
  let prePlanChecked = 0;

  for (const m of modules) {
    const perPhaseItemScores: Record<TimingPhase, number[]> = {
      planning: [],
      dayOf: [],
      post: [],
    };
    for (const it of m.items) {
      const phase = itemPhase({
        module: m.module,
        offsetDays: it.offsetDays,
        offsetMinutes: it.offsetMinutes,
      });
      perPhaseItemScores[phase].push(itemScore(m.statusOptions, it.status));

      // Pre-plan: count marked cells on this item and how many are checked.
      const marked = it.prePlanColumns ?? [];
      if (marked.length > 0) {
        const checkedSet = new Set(it.prePlanChecked ?? []);
        prePlanMarked += marked.length;
        prePlanChecked += marked.filter((k) => checkedSet.has(k)).length;
      }
    }
    for (const phase of ["planning", "dayOf", "post"] as TimingPhase[]) {
      const scores = perPhaseItemScores[phase];
      if (scores.length > 0) {
        moduleScores[phase].push(
          scores.reduce((sum, s) => sum + s, 0) / scores.length,
        );
      }
    }
  }

  // Module "ready" gates: a met gate is a completed unit in its phase, an unmet
  // gate a 0. Pre-plan gates add to the pre-plan count; timing-phase gates push
  // a 1/0 module-equivalent into that phase's average.
  let readyPrePlanTotal = 0;
  let readyPrePlanDone = 0;
  for (const g of moduleReady ?? []) {
    if (g.phase === "prePlan") {
      readyPrePlanTotal += 1;
      if (g.ready) readyPrePlanDone += 1;
    } else {
      moduleScores[g.phase].push(g.ready ? 1 : 0);
    }
  }

  const avg = (arr: number[]): number | null =>
    arr.length > 0 ? arr.reduce((sum, s) => sum + s, 0) / arr.length : null;

  // Pre-plan = marked-cell check-offs + the extra role/owner-assignment items +
  // pre-plan ready gates, all equally weighted. Null only when there's nothing
  // to assign, mark, or ready.
  const prePlanTotal =
    prePlanMarked + (prePlanExtra?.total ?? 0) + readyPrePlanTotal;
  const prePlanDone =
    prePlanChecked + (prePlanExtra?.done ?? 0) + readyPrePlanDone;
  return {
    prePlan: prePlanTotal > 0 ? prePlanDone / prePlanTotal : null,
    planning: avg(moduleScores.planning),
    dayOf: avg(moduleScores.dayOf),
    post: avg(moduleScores.post),
  };
}

/**
 * The "current" phase of an event by date — what a pipeline card highlights.
 *   same calendar day as the event → dayOf
 *   after the event                → post
 *   otherwise (before)             → planning
 * Pre-plan is intentionally NOT auto-selected as "current": it's an explicit
 * checklist the pipeline surfaces only via its own number, not as a stage.
 */
export function currentPhase(
  eventDate: number,
  now: number,
): Exclude<PhaseKey, "prePlan"> {
  const sameDay =
    new Date(eventDate).toDateString() === new Date(now).toDateString();
  if (sameDay) return "dayOf";
  if (now > eventDate) return "post";
  return "planning";
}

// ── Vetting status ───────────────────────────────────────────────────────────
export const VETTING_STATUSES = ["unvetted", "pending", "vetted"] as const;
export type VettingStatus = (typeof VETTING_STATUSES)[number];

// ── Persona ──────────────────────────────────────────────────────────────────
// Persona is DERIVED from signals, not stored as a rigid `kind` field, so the
// same person can be a vendor on one event and a volunteer on another. The rule
// previously lived only in the People screen and in seed prose; this is the one
// canonical encoding both backend and frontend call.
export type Persona = "team" | "volunteer" | "vendor";

/**
 * Derive a person's persona from their signals:
 *   isTeamMember === true  → "team"    (core team is explicitly flagged)
 *   usualRateUsd != null   → "vendor"  (a usual rate marks vendor capability)
 *   else                   → "volunteer"
 * Accepts a minimal structural shape so any person-like row can be classified.
 */
export function personaOf(person: {
  isTeamMember?: boolean | null;
  usualRateUsd?: number | null;
}): Persona {
  if (person.isTeamMember === true) return "team";
  if (person.usualRateUsd != null) return "vendor";
  return "volunteer";
}

// ── Roster lifecycle status ──────────────────────────────────────────────────
// Richer than the isActive flag — drives the People-screen Status cell.
export const ROSTER_STATUSES = [
  "active",
  "inactive",
  "transitioning_in",
  "transitioning_out",
  "unavailable",
] as const;
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

// ── Songs / worship setlists ─────────────────────────────────────────────────
// The Songs module: a chapter-wide song LIBRARY (title, author, lyrics, tags),
// a per-event ordered SETLIST, and public, anonymous song REQUESTS submitted
// from a QR/link page. The worship leader scrolls the setlist day-of, marks the
// song they're currently on (its lyrics surface on the public page), and works
// the incoming requests through a tiny lifecycle.
export const SONG_REQUEST_STATUSES = [
  "new",
  "queued",
  "done",
  "dismissed",
] as const;
export type SongRequestStatus = (typeof SONG_REQUEST_STATUSES)[number];

export const SONG_REQUEST_STATUS_LABELS: Record<SongRequestStatus, string> = {
  new: "New",
  queued: "Queued",
  done: "Played",
  dismissed: "Dismissed",
};

/**
 * Suggested song tags (free-form tags are allowed too). The `doxology` tag is
 * special: songs carrying it are offered as default suggestions on the public
 * request page even when they're not on the event's setlist — so a congregation
 * always has the common doxologies one tap away.
 */
export const COMMON_SONG_TAGS = [
  "doxology",
  "hymn",
  "contemporary",
  "spontaneous",
] as const;

/** Field length caps for anonymous public requests (defensive against abuse). */
export const SONG_REQUEST_LIMITS = {
  title: 120,
  name: 60,
  note: 400,
} as const;

// ── AI agent config (model registry, cost, budgets) ──────────────────────────
export * from "./ai";
