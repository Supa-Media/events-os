/**
 * Shared domain model for Events OS.
 *
 * Pure constants + helpers used by BOTH the Convex backend and the Expo app, so
 * role keys, statuses, and date math never drift between the two. Convex schema
 * validators inline these literals (validators need literal strings); everything
 * else imports from here.
 */

export const APP_NAME = "Events OS";
export const APP_SLUG = "events-os";

export const DAY_MS = 24 * 60 * 60 * 1000;

// ── Roles ──────────────────────────────────────────────────────────────────
// The 4 canonical roles (the legacy ~6 labels are consolidated into these).
// "Logistics" — not "Operations" — to avoid clashing with the org-wide
// Operations Director role.
export const ROLE_KEYS = [
  "event_lead",
  "logistics",
  "marketing",
  "volunteer",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_LABELS: Record<RoleKey, string> = {
  event_lead: "Event Lead / PM",
  logistics: "Logistics",
  marketing: "Marketing / Comms",
  volunteer: "Volunteer",
};

/** Lightweight events (e.g. Worship With Strangers) collapse to these two. */
export const LIGHTWEIGHT_ROLES: RoleKey[] = ["event_lead", "logistics"];

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

// ── Task status ──────────────────────────────────────────────────────────────
export const TASK_STATUSES = ["not_started", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
};

// ── Vetting status ───────────────────────────────────────────────────────────
export const VETTING_STATUSES = ["unvetted", "pending", "vetted"] as const;
export type VettingStatus = (typeof VETTING_STATUSES)[number];

// ── Template components ──────────────────────────────────────────────────────
// Every template is assembled from a fixed set of components. Six are core
// (present on every event); two switch on for larger events.
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

// ── Date helpers ─────────────────────────────────────────────────────────────
/**
 * Back-calculate a task's due date from the single event date and its T-minus
 * offset. The whole timeline shifts when the event date moves — no per-task
 * date wrangling.
 */
export function computeDueDate(
  eventDate: number,
  tMinusOffsetDays: number,
): number {
  return eventDate - tMinusOffsetDays * DAY_MS;
}

/** Per-event readiness as a 0–100 integer (done tasks / total tasks). */
export function computeReadiness(total: number, done: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}
