/**
 * Shared domain model for Chapter OS.
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

export const APP_NAME = "Chapter OS";
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
  "supplies",
  "permits",
  "retro",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** How a module renders. Every current module is a grid (the spreadsheet
 *  EditableGrid); a module can ALSO carry a non-grid artifact alongside its
 *  rows (`hasSiteMap` — Supplies & Logistics carries the site map). The
 *  `"site_map"` member is kept only for backward compatibility with code that
 *  switches on the surface: no module resolves to it anymore (the old
 *  standalone Site Map module was folded into Supplies & Logistics). */
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
  /**
   * The module carries the site-map artifact (the venue-layout drawing surface)
   * alongside its grid. Supplies & Logistics is the only carrier: site-map
   * placements bind supply items to map positions, so the map is the spatial
   * view of the same workstream. Ownership, timing, and the ready flag are the
   * module's own — the map has no separate readiness.
   */
  hasSiteMap?: boolean;
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
  // merged "Crew & Duties" tab on events. Debrief stays last (post).
  // Renamed 2026-07 for teachability: "Planning Doc" → "Tasks" (it's a task
  // list, not a doc), "Expectations" → "Crew expectations" (what each crew
  // team is expected to do), "Retrospective" → "Debrief" (the word the team
  // actually uses). Keys stay frozen — only labels changed.
  { key: "planning_doc", label: "Tasks", surface: "grid", defaultOwnerRoleKey: "event_lead", offsetMode: "days" },
  { key: "comms", label: "Comms Schedule", surface: "grid", defaultOwnerRoleKey: "comms_lead", offsetMode: "days" },
  { key: "run_of_show", label: "Run of Show", surface: "grid", defaultOwnerRoleKey: "production_lead", offsetMode: "minutes" },
  { key: "volunteer_expectations", label: "Crew expectations", surface: "grid", defaultOwnerRoleKey: "comms_lead", offsetMode: "none" },
  // Supplies & Logistics carries the site map (hasSiteMap): the venue-map
  // editor renders beneath its grid, and its single ready flag covers both.
  // Day offsets (2026-07): supply rows are time-bound — ordering has a real
  // lead time, so each item can carry a "have it by" offset/due date.
  { key: "supplies", label: "Supplies & Logistics", surface: "grid", defaultOwnerRoleKey: "logistics_lead", offsetMode: "days", hasSiteMap: true },
  { key: "permits", label: "Permits", surface: "grid", defaultOwnerRoleKey: "event_lead", offsetMode: "days" },
  { key: "retro", label: "Debrief", surface: "grid", defaultOwnerRoleKey: "event_lead", offsetMode: "none" },
];

/**
 * The grid-backed core modules, in order. Grid-only code paths (column seeding,
 * default columns, module summaries) iterate these. Currently every core module
 * is a grid; the filter guards against any future non-grid surface.
 */
export const GRID_CORE_MODULE_KEYS: ModuleKey[] = CORE_MODULES.filter(
  (m) => m.surface === "grid",
).map((m) => m.key);

/** Core module keys, in display order. */
export const CORE_MODULE_KEYS: ModuleKey[] = CORE_MODULES.map((m) => m.key);

/**
 * Tab keys the event screen claims for non-workstream surfaces. A custom
 * workstream must never mint one of these as its key — the screen's `?tab=`
 * routing would hijack its tab (e.g. a custom "Tickets" workstream would
 * always open the ticketing tool instead of its grid).
 */
export const RESERVED_TAB_KEYS = ["overview", "tickets", "crew", "budget"] as const;

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
  /** Renders the site-map editor beneath its grid (see CoreModuleDef). */
  hasSiteMap?: boolean;
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
    hasSiteMap: m.hasSiteMap === true,
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

// Supply status tracks ACQUISITION only — the walk from "identified" to
// "in hand". Terminal state: `have_it`. Whether an item is PACKED is a
// separate signal (the `packedIn` boolean the Packing checklist toggles),
// not a status — the old `packed` status duplicated it, and the two could
// disagree. Legacy events keep their own copied option sets, so an old
// `packed` value still reads as complete there.
export const SUPPLY_STATUS_OPTIONS: SelectOption[] = [
  { value: "pull_from_storage", label: "Pull from storage", color: "blue" },
  { value: "need_to_order", label: "Need to order", color: "red" },
  { value: "need_to_buy", label: "Need to buy", color: "red" },
  { value: "ordered", label: "Ordered", color: "amber" },
  { value: "have_it", label: "Have it", color: "green", isComplete: true },
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
  { value: "partiful_posh", label: "Partiful / Posh", color: "orange" },
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
  // A denied permit is NOT complete — it's the trigger for the readiness
  // guardrail (`permitDeniedWithoutFallback`): a denied permit with no fallback
  // plan is an event blocker.
  { value: "denied", label: "Denied", color: "red", isComplete: false },
  // The requirement was waived (no permit needed after all) → genuinely done.
  { value: "waived", label: "Waived", color: "green", isComplete: true },
];

export const RETRO_STATUS_OPTIONS: SelectOption[] = [
  { value: "open", label: "Open", color: "amber" },
  { value: "actioned", label: "Actioned", color: "green", isComplete: true },
];

/**
 * Where a retro row ended up in the debrief loop: promoted into the template,
 * kept as context for future events, or consciously dropped.
 */
export const RETRO_DISPATCH_OPTIONS: SelectOption[] = [
  { value: "promoted", label: "Promoted", color: "green" },
  { value: "context", label: "Context", color: "blue" },
  { value: "dropped", label: "Dropped", color: "gray" },
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

// ── Canonical column order ───────────────────────────────────────────────────
// Every grid leads with the same columns, in the same order: Title, Details
// (when the module has one), Status, Timing (offset), Due. Everything after
// that is the module's own business. One rule across tabs means a reader who
// learned one grid has learned them all.

/** The shared leading columns, in their fixed order. */
export const CANONICAL_LEADING_COLUMN_KEYS = [
  "title",
  "details",
  "status",
  "offset",
  "due_date",
] as const;

/**
 * Apply the canonical order to a column list: the leading keys first (those
 * present, in CANONICAL_LEADING_COLUMN_KEYS order), then every other column
 * in the relative order given. Pure + stable, so callers can normalize a
 * scope's stored columns without disturbing an author's ordering of the rest.
 */
export function canonicalColumnOrder<T extends { key: string }>(
  columns: readonly T[],
): T[] {
  const leadKeys = new Set<string>(CANONICAL_LEADING_COLUMN_KEYS);
  const lead: T[] = [];
  for (const key of CANONICAL_LEADING_COLUMN_KEYS) {
    const col = columns.find((c) => c.key === key);
    if (col) lead.push(col);
  }
  return [...lead, ...columns.filter((c) => !leadKeys.has(c.key))];
}

// ── Default column sets per module (seed defaults; editable per template) ─────
// Authors reorder/hide/rename these and add custom columns. `system` columns are
// backed by promoted item fields; `custom` columns live in the `fields` bag.
// Kept Partial defensively: grid code paths look modules up by (sometimes
// arbitrary) key and fall back to [] for anything without a column set.
// Every set below leads with the canonical columns (see above) — a test pins
// this, so a reordered edit here fails loudly instead of shipping drift.
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
    // "Have it by" deadline: ordering has a real-world lead time, so each item
    // carries an offset (order-online rows early, buy-in-store rows later; the
    // playbook wants everything in hand by T-1 so packing can happen).
    { key: "offset", label: "Timing", kind: "system", type: "offset_days", isVisible: true },
    { key: "due_date", label: "Due", kind: "system", type: "due_date", isVisible: true },
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
    { key: "status", label: "Status", kind: "system", type: "status", options: COMMS_STATUS_OPTIONS, isVisible: true },
    { key: "offset", label: "Timing", kind: "system", type: "offset_days", isVisible: true },
    { key: "due_date", label: "Date", kind: "system", type: "due_date", isVisible: true },
    { key: "channel", label: "Channel", kind: "custom", type: "multiselect", options: COMMS_CHANNEL_OPTIONS, isVisible: true },
    { key: "audience", label: "Audience", kind: "custom", type: "multiselect", options: COMMS_AUDIENCE_OPTIONS, isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
    { key: "role", label: "Role", kind: "system", type: "role", isVisible: false },
    { key: "cost", label: "Cost", kind: "custom", type: "currency", isVisible: false },
    { key: "notes", label: "Notes / copy", kind: "custom", type: "longtext", isVisible: true },
    { key: "files", label: "Files & media", kind: "custom", type: "photo", isVisible: true },
  ],
  run_of_show: [
    { key: "title", label: "Segment", kind: "system", type: "text", isVisible: true },
    { key: "offset", label: "Time", kind: "system", type: "offset_minutes", isVisible: true },
    // Segment LENGTH in minutes (a typed number cell in the fields bag, like
    // qty/cost). Optional per row: absent/0 falls back to "until the next
    // segment starts" on the Day-of view. Powers start–end ranges.
    { key: "duration", label: "Length", kind: "custom", type: "number", isVisible: true },
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
    // Issuing authority + the "if denied" contingency plan. Typed custom cells
    // in the fields bag (like Run-of-Show `duration`). `fallback` is the plan-B
    // the denied-without-fallback guardrail checks for.
    { key: "jurisdiction", label: "Jurisdiction", kind: "custom", type: "text", isVisible: true },
    { key: "fallback", label: "If denied (fallback)", kind: "custom", type: "longtext", isVisible: true },
    { key: "notes", label: "Notes", kind: "custom", type: "longtext", isVisible: true },
  ],
  retro: [
    { key: "title", label: "What happened", kind: "system", type: "text", isVisible: true },
    { key: "status", label: "Status", kind: "system", type: "status", options: RETRO_STATUS_OPTIONS, isVisible: true },
    { key: "dispatch", label: "Dispatch", kind: "custom", type: "select", options: RETRO_DISPATCH_OPTIONS, isVisible: true },
    { key: "notes", label: "Detail", kind: "custom", type: "longtext", isVisible: true },
    { key: "link", label: "Link", kind: "custom", type: "url", isVisible: true },
  ],
  // Rows are EXPECTATIONS (things we expect a team to do), each tagged to a
  // team/area. The team column's options ARE the event's team list — both these
  // rows and volunteer engagements reference those team values. WHO is on each
  // team is tracked on engagements (the Volunteers list), not here.
  volunteer_expectations: [
    { key: "title", label: "Expectation", kind: "system", type: "text", isVisible: true },
    { key: "details", label: "Details", kind: "custom", type: "longtext", isVisible: true },
    { key: "team", label: "Team", kind: "custom", type: "select", options: VOLUNTEER_TEAM_OPTIONS, isVisible: true },
    { key: "owner", label: "Owner", kind: "system", type: "person", isVisible: true },
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

/** Local-midnight timestamp for a day — the granularity day-selection works in. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Inverse of {@link computeDueDate} for calendar-day picking: the SIGNED whole-day
 * offset of `dayMs` relative to the event. Compares day-starts so the event's
 * time-of-day can't push the result off by one (e.g. a 6pm event and a midnight
 * pick still yield clean integer days). Negative = before, 0 = day-of, positive
 * = after — round-trips with `computeDueDate` for any day a due date lands on.
 */
export function offsetDaysBetween(eventDate: number, dayMs: number): number {
  return Math.round((startOfDay(dayMs) - startOfDay(eventDate)) / DAY_MS);
}

/**
 * How a comm's timing reads relative to its event, from the SEND's point of
 * view: negative offset = before, positive = after, 0 = the event day itself,
 * and a missing offset = not yet scheduled. The comms calendar and its day
 * panel both label sends with this, so the phrasing lives in exactly one place.
 */
export function commsTimingLabel(offsetDays: number | null | undefined): string {
  if (offsetDays == null) return "Unscheduled";
  if (offsetDays === 0) return "On event day";
  const n = Math.abs(offsetDays);
  const unit = n === 1 ? "day" : "days";
  return offsetDays < 0 ? `${n} ${unit} before` : `${n} ${unit} after`;
}

/**
 * A whole-day countdown to the event: 0 = "Today", ahead = "in N days", past =
 * "N days ago". Pairs with `offsetDaysBetween(today, eventDate)`, which yields
 * the signed day-delta this expects.
 */
export function eventCountdownLabel(daysAway: number): string {
  if (daysAway === 0) return "Today";
  const n = Math.abs(daysAway);
  const unit = n === 1 ? "day" : "days";
  return daysAway > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

/**
 * The discreet per-day badge on a calendar cell: how that day sits relative to
 * the event, as a compact countdown. Before the event → "7d" (days until);
 * after → "+3d"; the event day itself → "" (it carries its own marker).
 * `daysToEvent` is `offsetDaysBetween(cellDay, eventDate)` — positive before.
 */
export function daysToEventBadge(daysToEvent: number): string {
  if (daysToEvent === 0) return "";
  return daysToEvent > 0 ? `${daysToEvent}d` : `+${-daysToEvent}d`;
}

/** Wall-clock time of a run-of-show segment (offset minutes from event start). */
export function computeRunTime(eventStart: number, offsetMinutes: number): number {
  return eventStart + offsetMinutes * MINUTE_MS;
}

/**
 * True when a timestamp's LOCAL time-of-day is exactly midnight (00:00). Used to
 * flag events whose `eventDate` never got a real start time (the old new-event
 * form defaulted to local midnight) so the Day-of view can prompt to set one —
 * a migration can't infer the true start, but this reaches those events without
 * guessing. Uses local hours/minutes to match how every event time is derived.
 */
export function isLocalMidnight(ts: number): boolean {
  const d = new Date(ts);
  return d.getHours() === 0 && d.getMinutes() === 0;
}

/**
 * The final run-of-show segment has no following start to bound its "now"
 * window, so cap it instead of leaving it open forever (otherwise the last
 * segment reads "Happening now" hours after the event ends).
 */
export const RUN_OF_SHOW_FINAL_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * The END wall-clock time of a run-of-show segment, given its own start, an
 * optional explicit `durationMinutes`, and the next segment's start (or null for
 * the last row). A positive duration wins (start + duration); otherwise the
 * segment runs until the next one starts; the final row with no duration is
 * capped at {@link RUN_OF_SHOW_FINAL_WINDOW_MS}. This is the single source of
 * truth for both the Day-of start–end labels and its "now / up-next" window, so
 * the two can never disagree.
 */
export function runOfShowSegmentEnd(
  start: number,
  durationMinutes: number | null | undefined,
  nextStart: number | null,
): number {
  if (durationMinutes != null && durationMinutes > 0) {
    return start + durationMinutes * MINUTE_MS;
  }
  if (nextStart != null) return nextStart;
  return start + RUN_OF_SHOW_FINAL_WINDOW_MS;
}

/** One cell in a calendar month grid. `ms` is that day at local midnight. */
export type CalendarCell = { ms: number; day: number; inMonth: boolean };

/**
 * The 6×7 (42-cell) Sunday-first grid for a calendar month — the shape every
 * month view renders. Starts on the Sunday on/before the 1st and runs 42 days so
 * the grid height never jumps between months; cells outside the target month are
 * flagged `inMonth: false`. Pure date math (no libs), so it's unit-tested in
 * `@events-os/shared` rather than inside a screen.
 */
export function calendarMonthGrid(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
    return { ms: d.getTime(), day: d.getDate(), inMonth: d.getMonth() === month };
  });
}

/**
 * Bucket items by local calendar day (`startOfDay`), keyed by that day's
 * midnight ms. Time-of-day is ignored, so two events on the same date land in
 * one bucket regardless of their clock times. Insertion order within a day is
 * preserved; callers sort if they need to.
 */
export function groupByDay<T>(
  items: readonly T[],
  getMs: (item: T) => number,
): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const item of items) {
    const key = startOfDay(getMs(item));
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/**
 * The earliest item at or after `now` (the next upcoming one), or null if every
 * item is in the past. The boundary is inclusive — an item exactly at `now`
 * counts as upcoming. Does not mutate `items`.
 */
export function soonestUpcoming<T>(
  items: readonly T[],
  getMs: (item: T) => number,
  now: number,
): T | null {
  let best: T | null = null;
  let bestMs = Infinity;
  for (const item of items) {
    const ms = getMs(item);
    if (ms >= now && ms < bestMs) {
      best = item;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * First role row still missing an assignee, or null when all are staffed.
 * Powers the "Assign roles" What's-next row, which opens the picker for exactly
 * this role. A row is unassigned when its `person` is null/undefined.
 */
export function firstUnassignedRole<T extends { person: unknown }>(
  rows: readonly T[],
): T | null {
  return rows.find((r) => r.person == null) ?? null;
}

/**
 * First module that CAN have an owner (has an owner role) but doesn't yet, or
 * null. Powers "Assign module owners". The owner-role guard matters: a module
 * with no owner role can't be assigned one, so it must not be offered. Predicates
 * keep this free of any module/owner type so it stays trivially testable.
 */
export function firstModuleMissingOwner<T>(
  modules: readonly T[],
  hasOwnerRole: (m: T) => boolean,
  hasOwner: (m: T) => boolean,
): T | null {
  return modules.find((m) => hasOwnerRole(m) && !hasOwner(m)) ?? null;
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

// ── Permit readiness guardrail ───────────────────────────────────────────────
// A denied permit is only a real event BLOCKER when there's no contingency: a
// denied permit WITH a written `fallback` (plan B in the fields bag) is handled,
// not blocking. This keys the pipeline's blocker count and the Day-of prompt.

/**
 * True when a permit item is denied AND has no fallback plan written — the
 * blocker condition. Reads `status` (promoted) + `fields.fallback` (bag); a
 * whitespace-only fallback counts as empty.
 */
export function permitDeniedWithoutFallback(item: {
  status?: string | null;
  fields?: Record<string, unknown> | null;
}): boolean {
  if (item.status !== "denied") return false;
  const fallback = item.fields?.fallback;
  return typeof fallback !== "string" || fallback.trim() === "";
}

/** How many permit items are denied-without-fallback (the blocker rollup). */
export function countPermitBlockers(
  items: { status?: string | null; fields?: Record<string, unknown> | null }[],
): number {
  return items.filter(permitDeniedWithoutFallback).length;
}

// ── Phase-based readiness ────────────────────────────────────────────────────
// The single readiness % is replaced by FOUR phase numbers, so the team can see
// not just "how done is this event" but "how done is each stage of running it":
//   pre-plan  — explicit author-marked cells checked off (a separate mechanism;
//               see prePlanScore below — it is NOT derived from item status)
//   planning  — prep work scheduled before the event (T-minus), including
//               ACQUIRING supplies (ordering/buying happens weeks out)
//   dayOf     — run-of-show, crew duties, PACKING supplies (the `packedIn`
//               checklist), and anything that lands on the event day
//   post      — retro + follow-up after the event (T-plus)
//
// Scoring uses three primitives:
//   itemScore   — 1 (complete) / PARTIAL_ITEM_SCORE (started) / 0 (not started)
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
 *   run_of_show / volunteer_expectations / supplies       → planning
 * Note: volunteer_expectations ITEMS phase to dayOf (itemPhase); only its
 * "mark ready" gate is a planning milestone. Supplies' single gate covers the
 * whole workstream, site map included; a legacy `site_map` readiness entry on
 * an old event is simply ignored (the key is no longer a core module).
 */
export const MODULE_READY_PHASE: Record<string, PhaseKey> = {
  comms: "prePlan",
  permits: "prePlan",
  run_of_show: "planning",
  volunteer_expectations: "planning",
  supplies: "planning",
};

/**
 * Credit for a started-but-not-done item. Deliberately WELL below the midpoint:
 * finishing must visibly move a phase ring more than starting does. At 0.5 the
 * two transitions (not-started → in-progress, in-progress → done) bumped the
 * diluted, rounded ring % by the same single point, which read as "in progress
 * counts as much as done".
 */
export const PARTIAL_ITEM_SCORE = 0.25;

/**
 * Status values that count as "started but not complete" → PARTIAL_ITEM_SCORE.
 *
 * The rule is "started toward done, but not done". Choices per vocabulary:
 *   tasks    — `in_progress` (only non-terminal status)
 *   comms    — `drafted`, `scheduled` (drafting/queued toward `sent`)
 *   permits  — `to_apply`, `submitted` (in flight toward `approved`). `to_apply`
 *              is "we know we need it and intend to apply" — meaningful progress
 *              over no status at all; `not_needed` is terminal-but-not-complete
 *              so it stays 0 (it genuinely isn't done/handled work).
 *   supplies — `need_to_order`, `need_to_buy`, `ordered`, `pull_from_storage`
 *              (all en route to `have_it`). Note: `need_to_*` earn partial
 *              credit because the item is identified + sourced, which is real
 *              progress toward having it. `have_it` stays listed for LEGACY
 *              option sets where `packed` was the terminal state — current
 *              sets flag it `isComplete`, which wins before this set is read.
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
 * Score a single item from its status + the module's status options.
 *   1                  — status is a `isComplete` option
 *   PARTIAL_ITEM_SCORE — status is in PARTIAL_STATUS_VALUES (started, not done)
 *   0                  — no status, or a not-started/terminal-incomplete status
 */
export function itemScore(
  options: SelectOption[] | undefined,
  value: string | undefined | null,
): number {
  if (value == null) return 0;
  if (isCompleteStatus(options, value)) return 1;
  if (PARTIAL_STATUS_VALUES.has(value)) return PARTIAL_ITEM_SCORE;
  return 0;
}

/**
 * Assign an item to exactly one phase from its module + timing. Pre-plan is a
 * separate mechanism (explicit check-off) and is never returned here.
 *   retro module                 → post
 *   minute-offset (run_of_show)  → dayOf
 *   else by offsetDays: <0 planning · 0 dayOf · >0 post
 *   no timing at all             → planning (default prep)
 *
 * Supplies items phase by their timing like any other day-offset row: the
 * STATUS walk (order → buy → have it) is acquisition, i.e. planning work.
 * PACKING is the separate `packedIn` signal, and it always counts toward
 * day-of (see computePhaseScores) — even when packing happens early.
 */
export function itemPhase(item: {
  module: string;
  offsetDays?: number | null;
  offsetMinutes?: number | null;
}): Exclude<PhaseKey, "prePlan"> {
  if (item.module === "retro") return "post";
  // Volunteer expectations (what each crew team does on the day) are day-of
  // work, regardless of any offset.
  if (item.module === "volunteer_expectations") return "dayOf";
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
      /** Supplies only: the Packing-checklist boolean (fields.packedIn). Each
       *  supply item contributes a packed 0/1 unit to DAY-OF on top of its
       *  status (acquisition) score — buying feeds planning, packing feeds
       *  day-of, even when packing happens early. */
      packedIn?: boolean | null;
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

      // Supplies: packing is its own day-of unit per item, read from the
      // Packing checklist's `packedIn` — never from status.
      if (m.module === "supplies") {
        perPhaseItemScores.dayOf.push(it.packedIn === true ? 1 : 0);
      }

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

// ── Expected progress (the pacing ghost) ─────────────────────────────────────
// "At this point I should be at 50% — I'm at 20%." The expected score for a
// phase is the score the SAME rings would show if every item due by `now`
// were complete and nothing else were: each item's deadline passes → it
// counts 1, otherwise 0, aggregated through the identical module-averaging
// as computePhaseScores so expected and actual are directly comparable.
// Deadlines come from due dates where rows have them, and from the playbook
// conventions where they don't (supplies in hand by T-1 and packed by T-1,
// debrief by T+7, untimed-but-statused rows by T-0). Pre-plan has no deadline
// mechanism, so its expectation is null (no ghost on that ring).

/**
 * The playbook's pack-by convention, as a signed day offset: supplies are in
 * hand and packed by T-1. THE single encoding — the ready-gate ghost, the
 * expected-packed synthesis, the packing pace units, and the undated-supply
 * deadline fallback all derive from this one constant, so the convention can
 * never half-move.
 */
export const SUPPLIES_PACK_BY_OFFSET_DAYS = -1;

/**
 * Canonical read of "is this supply item packed?". The Packing checklist's
 * `fields.packedIn` boolean is the signal; the legacy `packed` STATUS is
 * grandfathered as packed too, so events created before the packed-status
 * retirement (and not yet migrated) keep honest day-of rings.
 */
export function isSupplyPacked(item: {
  status?: string | null;
  fields?: Record<string, unknown> | null;
}): boolean {
  return item.fields?.packedIn === true || item.status === "packed";
}

/** Convention deadlines (in offset days) for each module's READY gate — the
 *  playbook's earned defaults: run of show locked by T-3, supplies in hand
 *  and packed by T-1, crew locked by T-10. Pre-plan gates (comms/permits)
 *  have no ghost. */
export const EXPECTED_READY_OFFSET: Partial<Record<string, number>> = {
  run_of_show: -3,
  supplies: SUPPLIES_PACK_BY_OFFSET_DAYS,
  volunteer_expectations: -10,
};

/** When an item is EXPECTED to be complete. The stored due date wins (it's
 *  what every overdue badge in the app reads); explicit offsets next
 *  (mirroring itemPhase's precedence); conventions cover undated rows. */
function expectedDoneBy(
  module: string,
  item: {
    dueDate?: number | null;
    offsetDays?: number | null;
    offsetMinutes?: number | null;
  },
  eventDate: number,
): number {
  if (item.dueDate != null) return item.dueDate;
  if (item.offsetMinutes != null) return eventDate; // day-of segments
  if (item.offsetDays != null) return eventDate + item.offsetDays * DAY_MS;
  // Conventions for the undated rows of convention-deadline areas…
  if (module === "supplies") {
    return eventDate + SUPPLIES_PACK_BY_OFFSET_DAYS * DAY_MS; // in hand by T-1
  }
  if (module === "retro") return eventDate + 7 * DAY_MS; // dispatched by T+7
  // …and untimed rows elsewhere still have to be true before the event.
  return eventDate;
}

/**
 * When a supply item's PACKING unit is expected done: the pack-by convention
 * (T-1), floored by the item's OWN have-it-by deadline — an item that isn't
 * even acquired until event morning (a day-of ice run, offset 0) can't owe
 * packing before it exists, and a T+1 returns row packs on its own clock.
 */
function packExpectedBy(
  item: {
    dueDate?: number | null;
    offsetDays?: number | null;
    offsetMinutes?: number | null;
  },
  eventDate: number,
): number {
  return Math.max(
    expectedDoneBy("supplies", item, eventDate),
    eventDate + SUPPLIES_PACK_BY_OFFSET_DAYS * DAY_MS,
  );
}

/**
 * The expected (on-pace) phase scores at `now` — the BASELINE the target tick
 * marks. Defined as: YOUR ACTUAL SCORE WITH ALL OVERDUE DEBT CLEARED. Per
 * item that's max(actual credit, 1-if-its-deadline-passed), aggregated
 * exactly like computePhaseScores — so:
 *  - rows due by now count complete whether or not they are;
 *  - rows finished (or started) EARLY keep their credit — working ahead
 *    shifts the baseline up with you, it's never treated as "extra";
 *  - ready gates count once met OR once their convention deadline
 *    (EXPECTED_READY_OFFSET) passes.
 * The tick therefore always sits at-or-above the actual score, and the gap
 * between them is exactly the phase's overdue debt in score terms. Modules
 * without a status column contribute the same 0 on both sides. Pre-plan is
 * always null (no deadline mechanism).
 */
export function computeExpectedPhaseScores(
  modules: Array<{
    module: string;
    statusOptions: SelectOption[] | undefined;
    items: Array<{
      status?: string | null;
      dueDate?: number | null;
      offsetDays?: number | null;
      offsetMinutes?: number | null;
      packedIn?: boolean | null;
    }>;
  }>,
  moduleReady: Array<{ module: string; phase: PhaseKey; ready?: boolean }>,
  eventDate: number,
  now: number,
): PhaseScores {
  // Synthesize each item's status: a complete-flagged option value when the
  // deadline has passed, otherwise the item's REAL status (early credit
  // survives) — then reuse the real aggregator. Supplies' packing units get
  // the same treatment: expected packed once the item's pack deadline passes
  // (T-1 by convention, floored by the item's own have-it-by timing — see
  // packExpectedBy); early packing keeps its credit before that.
  const synthesized = modules.map((m) => {
    const completeValue = m.statusOptions?.find(
      (o) => o.isComplete === true,
    )?.value;
    return {
      module: m.module,
      statusOptions: m.statusOptions,
      items: m.items.map((it) => ({
        status:
          completeValue != null &&
          now >= expectedDoneBy(m.module, it, eventDate)
            ? completeValue
            : (it.status ?? null),
        offsetDays: it.offsetDays,
        offsetMinutes: it.offsetMinutes,
        packedIn:
          m.module === "supplies" && now >= packExpectedBy(it, eventDate)
            ? true
            : (it.packedIn ?? null),
        // No pre-plan marks: expected pre-plan stays null (no deadlines).
      })),
    };
  });
  const gates = moduleReady
    .filter((g) => g.phase !== "prePlan" && EXPECTED_READY_OFFSET[g.module] != null)
    .map((g) => ({
      phase: g.phase,
      ready:
        g.ready === true ||
        now >= eventDate + EXPECTED_READY_OFFSET[g.module]! * DAY_MS,
    }));
  const scores = computePhaseScores(synthesized, undefined, gates);
  return { ...scores, prePlan: null };
}

// ── Per-phase overdue counts (the pace SIGNAL) ───────────────────────────────
// The expected % above places the ghost tick; whether a ring is "on pace" is
// decided by something blunter and impossible to argue with: ARE ANY OF THIS
// PHASE'S ROWS OVERDUE? Counted with the exact same rule the What's-next list
// uses (incomplete + effective due date before the start of today), so the
// ring's "▲ N overdue" and the list's OVERDUE badges are the same rows —
// aggregate score math (partial credit, gate dilution) can never make the two
// disagree again.

/** One phase's pace: how many rows are due by today, and how many of those
 *  are still incomplete (the overdue count the ring surfaces). */
export interface PhasePace {
  dueTotal: number;
  overdue: number;
}

/** Per-phase pace tallies, or null for phases with no deadline mechanism
 *  (pre-plan). Gates count too: an unmet ready gate past its convention
 *  deadline (run of show T-3, supplies T-1, crew T-10) is one overdue unit.
 *  Supplies packing units count as well: an unpacked item past T-1 is one
 *  overdue DAY-OF unit — the one place this can outrun the What's-next list,
 *  whose row view tracks status; the Packing checklist is where the packing
 *  debt itself lives. */
export function computePhaseOverdue(
  modules: Array<{
    module: string;
    statusOptions: SelectOption[] | undefined;
    items: Array<{
      status?: string | null;
      dueDate?: number | null;
      offsetDays?: number | null;
      offsetMinutes?: number | null;
      packedIn?: boolean | null;
    }>;
  }>,
  gates: Array<{ module: string; phase: PhaseKey; ready: boolean }>,
  eventDate: number,
  now: number,
): Record<PhaseKey, PhasePace | null> {
  // Same boundary as the What's-next risk rule: due strictly before the
  // start of TODAY is overdue; due today is merely "soon".
  const cutoff = startOfDay(now);
  const acc: Record<Exclude<PhaseKey, "prePlan">, PhasePace> = {
    planning: { dueTotal: 0, overdue: 0 },
    dayOf: { dueTotal: 0, overdue: 0 },
    post: { dueTotal: 0, overdue: 0 },
  };
  for (const m of modules) {
    for (const it of m.items) {
      // Supplies: the packing unit paces separately from acquisition, on the
      // item's own pack deadline (T-1, floored by its have-it-by timing).
      if (m.module === "supplies" && packExpectedBy(it, eventDate) < cutoff) {
        acc.dayOf.dueTotal += 1;
        if (it.packedIn !== true) acc.dayOf.overdue += 1;
      }
      const due = expectedDoneBy(m.module, it, eventDate);
      if (due >= cutoff) continue;
      const phase = itemPhase({
        module: m.module,
        offsetDays: it.offsetDays,
        offsetMinutes: it.offsetMinutes,
      });
      acc[phase].dueTotal += 1;
      if (!isCompleteStatus(m.statusOptions, it.status)) {
        acc[phase].overdue += 1;
      }
    }
  }
  for (const g of gates) {
    if (g.phase === "prePlan") continue;
    const offset = EXPECTED_READY_OFFSET[g.module];
    if (offset == null) continue;
    const deadline = eventDate + offset * DAY_MS;
    if (deadline >= cutoff) continue;
    acc[g.phase].dueTotal += 1;
    if (!g.ready) acc[g.phase].overdue += 1;
  }
  return { prePlan: null, ...acc };
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

// ── Projects (units of work) ─────────────────────────────────────────────────
// A project is any unit of work the team is driving — an event prep effort, a
// recording, a pitch — nestable (a project can contain sub-projects) and owned
// by a roster person. Statuses are a readonly tuple so the Convex schema builds
// its validator from this array (same pattern as EVENT_STATUSES).
export const PROJECT_STATUSES = [
  "not_started",
  "in_progress",
  "blocked",
  "on_hold",
  "done",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  on_hold: "On hold",
  done: "Done",
};

// ── Responsibilities (ongoing duties) ────────────────────────────────────────
// A responsibility is recurring org work ("Meet with directs", "Create event
// flyers") assigned to a ROLE (so one row fans out to everyone holding it) or
// to specific people when no role fits. Cadence is how often it recurs.
export const RESPONSIBILITY_CADENCES = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
  "ad_hoc",
] as const;
export type ResponsibilityCadence = (typeof RESPONSIBILITY_CADENCES)[number];

export const RESPONSIBILITY_CADENCE_LABELS: Record<
  ResponsibilityCadence,
  string
> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  ad_hoc: "Ad hoc",
};

/** One cadence cycle in milliseconds. `ad_hoc` has no cycle (absent here). */
export const RESPONSIBILITY_CADENCE_MS: Partial<
  Record<ResponsibilityCadence, number>
> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  biweekly: 14 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  quarterly: 91 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Fraction of a cadence cycle after which a duty is due for review again. At
 * exactly 1.0 a monthly duty reviewed in a monthly 1:1 would miss its window
 * whenever the meetings drift a day early, then wait a whole extra cycle —
 * 0.75 keeps "roughly one review per cycle" under real scheduling jitter.
 */
const DUE_FOR_REVIEW_GRACE = 0.75;

/**
 * Should a responsibility be raised in a 1:1 happening `now`? True when it has
 * never been reviewed, when enough of its cadence cycle has passed since the
 * last review, or when it's `ad_hoc` (no cycle — the manager decides). Keeps
 * quarterly duties from cluttering every weekly 1:1.
 */
export function responsibilityDueForReview(
  cadence: ResponsibilityCadence,
  lastReviewedAt: number | null | undefined,
  now: number,
): boolean {
  if (lastReviewedAt == null) return true;
  const cycleMs = RESPONSIBILITY_CADENCE_MS[cadence];
  if (cycleMs === undefined) return true; // ad_hoc
  return now - lastReviewedAt >= cycleMs * DUE_FOR_REVIEW_GRACE;
}

/** Normalize a role/job title for matching responsibilities to people. */
export function normalizeRole(role?: string | null): string {
  return (role ?? "").trim().toLowerCase();
}

/**
 * Does a responsibility row fan out to this person? True when their role
 * matches one of the assignee roles (case-insensitively) or they're assigned
 * directly. The single matching rule shared by every surface that expands
 * definitions into per-person responsibilities.
 */
export function responsibilityAppliesTo(
  r: {
    assigneeRoles?: readonly string[] | null;
    assigneePersonIds?: readonly string[] | null;
  },
  person: { _id: string; role?: string | null },
): boolean {
  const role = normalizeRole(person.role);
  if (role && (r.assigneeRoles ?? []).some((x) => normalizeRole(x) === role)) {
    return true;
  }
  return (r.assigneePersonIds ?? []).includes(person._id);
}

// ── 1:1 check-ins ────────────────────────────────────────────────────────────
// A manager's log of a 1:1 with a direct report (or a skipped one): whether
// each responsibility is being fulfilled (and the course of action when not),
// prayer/personal updates the reporting chain should know, and how the report
// feels about workload and the work itself (1-10 + notes).
export const CHECKIN_TYPES = ["checkin", "skip"] as const;
export type CheckInType = (typeof CHECKIN_TYPES)[number];

export const CHECKIN_ACTIONS = [
  "warning",
  "reduce_responsibilities",
  "transfer_responsibility",
  "manager_took_over",
  "reassigned",
  "remove_from_team",
  "other",
] as const;
export type CheckInAction = (typeof CHECKIN_ACTIONS)[number];

export const CHECKIN_ACTION_LABELS: Record<CheckInAction, string> = {
  warning: "Give a warning",
  reduce_responsibilities: "Reduce responsibilities",
  transfer_responsibility: "Transfer responsibility",
  manager_took_over: "Manager takes it on",
  reassigned: "Give to someone else",
  remove_from_team: "Remove from team",
  other: "Other",
};

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
 * First-class song tags, always offered in the tag picker. They're also special
 * on the backend: songs tagged `doxology` or `well_known` are surfaced as default
 * suggestions on the public request page even when they're not on the event's
 * setlist, so a congregation always has the common ones a tap away. Beyond these
 * two, leaders can create any custom tag (e.g. "hymn", "christmas", "youth").
 */
export const FIRST_CLASS_SONG_TAGS = ["doxology", "well_known"] as const;

/** Display labels for known tags; custom tags fall back to a title-cased form. */
export const SONG_TAG_LABELS: Record<string, string> = {
  doxology: "Doxology",
  well_known: "Well-known",
  hymn: "Hymn",
  contemporary: "Contemporary",
  spontaneous: "Spontaneous",
};

/** Human label for a song tag — a known label, or a title-cased fallback. */
export function songTagLabel(tag: string): string {
  return (
    SONG_TAG_LABELS[tag] ??
    tag.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Canonicalize a free-typed tag: lowercase, spaces → underscores, drop anything
 * but `[a-z0-9_]`. Keeps custom tags tidy and dedupe-able (so "Youth Night" and
 * "youth night" collapse to one `youth_night`). Returns "" if nothing's left.
 */
export function normalizeSongTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/** Field length caps for anonymous public requests (defensive against abuse). */
export const SONG_REQUEST_LIMITS = {
  title: 120,
  name: 60,
  note: 400,
} as const;

// ── AI agent config (model registry, cost, budgets) ──────────────────────────
export * from "./ai";

// ── The planning playbook (generated from docs/agent.md) ─────────────────────
export * from "./playbook";

// ── The Academy curriculum (sections + quizzes + capstone constants) ──────────
export * from "./academy";

// ── The Academy course/theme layer (themes → courses → module slugs) ──────────
export * from "./academyCourses";
