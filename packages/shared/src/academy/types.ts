/**
 * The Academy — shared types for the curriculum (sections/blocks/quizzes) and
 * the course/theme catalog layer that groups sections into themes → courses →
 * modules.
 *
 * Content itself lives per-stream in `./streams/*` (Events, Works, Management,
 * Finances) and is assembled, in curriculum order, by `./index`. Splitting the
 * former ~4,000-line `academy.ts` monolith into one file per stream lets four
 * content PRs land in parallel with no file overlap — this file is the shared
 * contract they all depend on. Content is authored FROM the playbook
 * (docs/agent.md) and the enablement guides (docs/guides/*) — this file (via
 * `./index`) is the single source both the mobile Academy screens and the
 * Convex grading backend read, so the quiz is always graded server-side
 * against exactly what the reader saw.
 *
 * Authoring rules (learned from the v1 rewrite):
 *  - Teach the SOFTWARE first, the doctrine second. Numbers like "announce at
 *    T-14" are the templates' proven defaults, not laws of the app — say so.
 *  - Short pages (2–4 min). One idea per block. The click path is part of the
 *    lesson, not a footnote.
 *  - Quizzes teach, not trick: every explanation restates the rule checked.
 */

/** One quiz question. `answerIndex` points into `options`. */
export interface AcademyQuestion {
  prompt: string;
  options: string[];
  answerIndex: number;
  /** Shown after grading — restates the rule, right or wrong. */
  explanation: string;
}

/** One option of a `try_status` demo chip (colors match the app's real select chips). */
export interface AcademyStatusOption {
  value: string;
  label: string;
  /** Option color token (gray / amber / green / …) — same vocabulary as real status columns. */
  color: string;
}

/** One bubble of an `agent_demo` scripted exchange. */
export interface AcademyExchange {
  who: "you" | "agent";
  text: string;
}

/**
 * One typed content block of an Academy article. Articles are authored as a
 * sequence of blocks (not a markdown blob) so the mobile renderer can give
 * each kind a designed treatment — story callouts, principle cards, tables,
 * and interactive practice widgets — instead of generic markdown output.
 * Prose (`text` / `items` / table cells) may carry `**bold**` and `*italic*`
 * inline emphasis.
 *
 * The `try_*` / `reveal` / `agent_demo` kinds are INTERACTIVE: self-contained
 * widgets with throwaway local state, styled pixel-close to the real app so
 * practicing in the article transfers one-to-one. They never write to the
 * backend.
 */
export type AcademyBlock =
  | { kind: "p"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  /** "From the field" pull-quote — a real anecdote (title like "Eden, 2026"). */
  | { kind: "story"; title: string; text: string }
  /** Key-principle card — the rule the section hangs on. */
  | { kind: "rule"; title: string; text: string }
  /** Tabular content (tab overviews, cadences, lead times…). */
  | { kind: "table"; headers: string[]; rows: string[][] }
  /** "In the app · …" pointer to the concrete UI move. */
  | { kind: "tip"; text: string }
  /** Mini grid row with a tappable status chip — cycle it to the terminal state. */
  | {
      kind: "try_status";
      title: string;
      options: AcademyStatusOption[];
      /** The terminal option's `value` — reaching it shows the success line. */
      terminal: string;
      caption?: string;
    }
  /** T-offset sandbox: pick an offset, move the event date, watch due dates re-derive. */
  | { kind: "try_offset"; eventDateLabel?: string }
  /** The accountability chain, rendered as links you can break. */
  | { kind: "try_chain" }
  /** Mark-ready simulator: criteria checklist, gated button, honest override path. */
  | { kind: "try_ready"; criteria: string[] }
  /** Scenario card: "what would you do?" with a tap-to-reveal playbook answer. */
  | { kind: "reveal"; prompt: string; answer: string }
  /** Scripted assistant exchange, revealed bubble-by-bubble on tap. */
  | { kind: "agent_demo"; exchanges: AcademyExchange[] };

/** The interactive block kinds (practice widgets with local state). */
export const ACADEMY_INTERACTIVE_KINDS = [
  "try_status",
  "try_offset",
  "try_chain",
  "try_ready",
  "reveal",
  "agent_demo",
] as const satisfies readonly AcademyBlock["kind"][];

/**
 * Which training sandbox a capstone section drives. Each kind maps to its own
 * platform training template (ACADEMY_TRAINING_TEMPLATES) and each learner
 * gets their own sandbox event per capstone.
 */
export type AcademyTrainingKind =
  | "join_event"
  | "birthday_party"
  | "worship_event"
  | "comms_lead"
  | "event_lead"
  | "logistics_lead";

/** Capstone metadata carried by a capstone section. */
export interface AcademyCapstoneMeta {
  kind: AcademyTrainingKind;
}

/** One curriculum section: an article (typed content blocks) + its quiz. */
export interface AcademySection {
  slug: string;
  /** 1-based position in the curriculum (sections unlock in this order). */
  order: number;
  title: string;
  subtitle: string;
  /** Rough read estimate, minutes. */
  minutes: number;
  /** The article, as an ordered sequence of typed blocks. */
  blocks: AcademyBlock[];
  /** Empty for capstones — their "quiz" is the training-event quest list. */
  quiz: AcademyQuestion[];
  /** Present on capstone sections: which training sandbox completes them. */
  capstone?: AcademyCapstoneMeta;
  /**
   * A bonus section: unlocks in order like any other, but does NOT count
   * toward "fully trained" (completed/total exclude it).
   */
  optional?: boolean;
}

/**
 * The per-kind platform training templates the capstones instantiate.
 * `templateKey` is the stable `eventTypes.platformKey` value (never suffixed,
 * unlike the slug, so a slug squatter can't hijack the lookup).
 */
export const ACADEMY_TRAINING_TEMPLATES: Record<
  AcademyTrainingKind,
  { templateKey: string }
> = {
  join_event: { templateKey: "academy-join-event" },
  birthday_party: { templateKey: "academy-birthday-party" },
  worship_event: { templateKey: "academy-worship-event" },
  comms_lead: { templateKey: "academy-comms-lead" },
  event_lead: { templateKey: "academy-event-lead" },
  logistics_lead: { templateKey: "academy-logistics-lead" },
};

/**
 * Whether an event counts toward chapter OPERATIONS. Academy training
 * sandboxes (`isTraining`) are real events, but they must never surface in
 * operational views: event lists, the Events tab, dashboards, Team workload
 * views, or reminder emails. Every exclusion site shares this one predicate.
 */
export function isOperationalEvent(e: {
  isTraining?: boolean | null;
}): boolean {
  return e.isTraining !== true;
}

/**
 * A course's difficulty tier — the founder's ask. Courses gate by level order
 * within a theme (see §6.3 of the redesign doc).
 */
export type AcademyLevel = "beginner" | "intermediate" | "advanced" | "leader";

/**
 * What a course *teaches* (the rebrand §5a taxonomy), so courses can later be
 * surfaced contextually ("about to own your first event → the Ownership course").
 *  - `role`      — the remit of one event role (Comms Lead, Event Lead, …)
 *  - `ownership` — accountability doctrine + hands-on capstones
 *  - `team`      — cross-team / whole-crew content
 */
export type AcademyAudience = "role" | "ownership" | "team";

/**
 * Code-defined grouping of courses — the Academy's STREAMS (the founder's
 * 2026-07-14 structure): foundations (who we are and how we work — the
 * mission, the org chart, and team culture; taught first), running events,
 * ongoing works (projects & duties), management (leading the people who do
 * both), finances (WP-5.1 — enablement for the finance v2 split,
 * `docs/plans/finance-v2-split-prd.md` §Phase 5), and music (the
 * doxological songwriting/song-selection framework, worship-leader
 * submission, and producer/artist roles).
 */
export type AcademyThemeKey =
  | "foundations"
  | "events"
  | "works"
  | "management"
  | "finances"
  | "music";

/** One stream: a titled grouping courses belong to via `themeKey`. */
export interface Theme {
  key: AcademyThemeKey;
  title: string;
  /** One-line promise of what the stream trains. */
  subtitle: string;
}

/**
 * One course: a titled, levelled, audience-tagged ordered path through existing
 * curriculum modules. `moduleSlugs` are EXISTING `AcademySection` slugs, in the
 * intended teaching order for this course (which may differ from the flat
 * curriculum order — e.g. `being-an-owner` sits with the ownership capstones).
 */
export interface Course {
  slug: string;
  themeKey: AcademyThemeKey;
  title: string;
  level: AcademyLevel;
  audience: AcademyAudience;
  description: string;
  /**
   * The course's glyph — a Feather icon name (the set the mobile `Icon`
   * component draws from). Kept as a plain string here because this package
   * can't depend on the icon font's types; the UI narrows it at the callsite.
   */
  icon: string;
  /** Existing section slugs, in this course's intended order. */
  moduleSlugs: string[];
}
