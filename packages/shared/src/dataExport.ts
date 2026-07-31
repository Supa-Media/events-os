/**
 * Data Export — the shared vocabulary for "give me this database as a
 * spreadsheet".
 *
 * ONE FLAT FILE PER DATASET (founder decision, 2026-07-31). Asked whether
 * "link it to other CSVs" meant a relational bundle of joined files or a
 * single wide spreadsheet, the founder chose the wide spreadsheet: every
 * enrichment is FLATTENED INTO COLUMNS on one row per subject, rather than
 * normalized into sibling files joined on `person_id`. So there is no ZIP, no
 * manifest and no join README anywhere in this feature — selecting three
 * datasets produces three independent CSVs, each self-contained.
 *
 * The headline consequence is the `people` dataset. It is not a dump of the
 * `people` table; it is a JOIN across everything the app knows about a person,
 * widened into columns — every known email address, service/seat, event they
 * RSVP'd to or showed up at, their giving summary, and ONE COLUMN PER FORM
 * QUESTION they have ever answered (labelled `<Form title> — <Question>`,
 * discovered at run time from `formDefinitions`, never hardcoded). That is the
 * "collect information from other sources" the request was actually about.
 *
 * WHY A REGISTRY RATHER THAN A QUERY PER SCREEN: every existing list query in
 * this repo is CAPPED (donors 500, gifts 250, reconcile 5000, receipts 500,
 * reimbursements 200) because they back scrolling grids. Exporting through
 * them would silently truncate — the single worst failure mode a export can
 * have, because the file looks complete. Export therefore owns its own
 * paginated read path per dataset (see `apps/convex/lib/exportBuilders/`), and
 * this registry is the contract that path implements.
 *
 * SECTIONS vs DATASETS: a dataset is a file; a section is an optional GROUP OF
 * COLUMNS within one. Sections exist so the people export can offer "with
 * giving" / "with form answers" without multiplying datasets — and so a
 * section the caller lacks the capability for can be dropped QUIETLY rather
 * than failing the whole export (see `lib/dataExportAccess.ts`).
 */

// ── Scope ────────────────────────────────────────────────────────────────────

/** A chapter id, or the org level. Mirrors `GivingScope`/`FinanceScope` and
 *  `seatAssignments.scope` — the same `"central"` sentinel used repo-wide.
 *  Typed as `string` here because `Id<>` is a Convex-only type and this package
 *  is imported by the mobile app too. */
export type ExportScope = string;
export const CENTRAL_SCOPE = "central";

// ── Formats ──────────────────────────────────────────────────────────────────

export const EXPORT_FORMATS = ["csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// ── Job lifecycle ────────────────────────────────────────────────────────────

/**
 * `queued`   — accepted, runner not yet started.
 * `running`  — the runner action is walking pages.
 * `ready`    — every file written; download links live until `expiresAt`.
 * `failed`   — gave up; `error` explains why, in words a human can act on.
 * `expired`  — files purged by the sweep. THE ROW SURVIVES: an export job is
 *              also the audit record of who extracted what, so the trail must
 *              outlive the bytes. Never delete a job row to free storage.
 */
export const EXPORT_JOB_STATUSES = [
  "queued",
  "running",
  "ready",
  "failed",
  "expired",
] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

/** How long a finished export's files stay downloadable before the sweep
 *  purges them. Short on purpose: these files are the densest PII in the
 *  product, and a stale signed URL in someone's chat history should stop
 *  working. */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard ceiling on rows per file. A job that hits it finishes `ready` with
 *  `truncated: true`, and every surface MUST say so — a silently short file is
 *  worse than a failed one. */
export const EXPORT_MAX_ROWS = 250_000;

/** Rows read per page of the runner's walk. One `.paginate()` per invocation,
 *  the house pattern from `apps/convex/migrations/`. */
export const EXPORT_PAGE_SIZE = 500;

/** Flush the in-memory CSV buffer to a storage chunk once it exceeds this many
 *  characters, so a huge export never holds the whole file in action memory. */
export const EXPORT_CHUNK_CHARS = 4 * 1024 * 1024;

// ── Datasets ─────────────────────────────────────────────────────────────────

export const EXPORT_DATASET_IDS = [
  "people",
  "form_submissions",
  "event_participation",
  "events",
  "tasks",
  "projects",
  "donors",
  "gifts",
  "pledges",
  "transactions",
  "academy_progress",
] as const;
export type ExportDatasetId = (typeof EXPORT_DATASET_IDS)[number];

export const EXPORT_GROUPS = [
  "People",
  "Events",
  "Giving",
  "Finance",
  "Work",
] as const;
export type ExportGroup = (typeof EXPORT_GROUPS)[number];

/**
 * The extra power a dataset needs ON TOP of `data.export`.
 *
 * `data.export` says "this person may extract data at all"; this says "…and
 * they must already be allowed to SEE this particular data". Export never
 * widens reach — a Marketing Director with `data.export` but no `giving.view`
 * can export the roster and gets no giving columns, rather than an error.
 */
export type ExportRequirement = "none" | "giving.view" | "finance.viewer";

export interface ExportDatasetDef {
  id: ExportDatasetId;
  /** Human name, used as the screen label and the filename stem. */
  label: string;
  /** One line explaining what a row IS — shown under the checkbox. */
  description: string;
  group: ExportGroup;
  requires: ExportRequirement;
  /** True when the dataset exists at `central` as well as per-chapter. */
  supportsCentral: boolean;
  /** Filters this dataset honours (see `ExportFilters`). */
  filters: readonly ExportFilterKey[];
  /** Optional column groups, in display order. Empty = fixed column set. */
  sections: readonly ExportSectionDef[];
}

export const EXPORT_FILTER_KEYS = [
  /** `receivedAt`/`eventDate`/`submittedAt`/`createdAt` window, per dataset. */
  "dateRange",
  /** Drop rows whose subject is archived/inactive/cancelled. */
  "activeOnly",
  /** People only: restrict to one persona (team/volunteer/guest/…). */
  "persona",
  /** People only: drop `isContactOnly` identity-stub rows. */
  "rosterOnly",
] as const;
export type ExportFilterKey = (typeof EXPORT_FILTER_KEYS)[number];

export interface ExportFilters {
  from?: number;
  to?: number;
  activeOnly?: boolean;
  persona?: string;
  rosterOnly?: boolean;
}

// ── Sections (column groups within one dataset) ──────────────────────────────

export const EXPORT_SECTION_IDS = [
  "identity",
  "contact",
  "all_emails",
  "services_seats",
  "participation",
  "giving_summary",
  "form_answers",
  "academy",
  "admin",
] as const;
export type ExportSectionId = (typeof EXPORT_SECTION_IDS)[number];

export interface ExportSectionDef {
  id: ExportSectionId;
  label: string;
  description: string;
  /** Extra reach needed for this section; a caller without it gets the export
   *  WITHOUT these columns, and the job records the omission. */
  requires: ExportRequirement;
  /** Ticked by default in the picker. */
  defaultOn: boolean;
  /** True when the section's columns are discovered at run time (form answers)
   *  rather than being a fixed list — the UI says "varies" instead of a count. */
  dynamic?: boolean;
}

/** The people export's column groups. `identity` is not listed because it is
 *  mandatory — `person_id` and `name` are on every row, always. */
const PEOPLE_SECTIONS: readonly ExportSectionDef[] = [
  {
    id: "contact",
    label: "Contact details",
    description: "Primary email, phone, location, company, social link.",
    requires: "none",
    defaultOn: true,
  },
  {
    id: "all_emails",
    label: "Every known email",
    description:
      "All addresses on the person's email ledger, with where each came from and whether it's verified — not just the primary one.",
    requires: "none",
    defaultOn: true,
  },
  {
    id: "services_seats",
    label: "Services, roles & seats",
    description:
      "Service catalog selections, roster role, org-chart seats and reporting manager.",
    requires: "none",
    defaultOn: true,
  },
  {
    id: "participation",
    label: "Event participation",
    description:
      "RSVP count, events attended, first/last event, and volunteer engagements.",
    requires: "none",
    defaultOn: true,
  },
  {
    id: "giving_summary",
    label: "Giving summary",
    description:
      "Lifetime total, gift count, first/last gift and pledge status. Requires giving access.",
    requires: "giving.view",
    defaultOn: true,
  },
  {
    id: "form_answers",
    label: "Form answers",
    description:
      "One column per question across every form this person has submitted — labelled by form and question.",
    requires: "none",
    defaultOn: true,
    dynamic: true,
  },
  {
    id: "academy",
    label: "Academy progress",
    description: "Lessons completed, courses earned, last activity.",
    requires: "none",
    defaultOn: false,
  },
  {
    id: "admin",
    label: "Consent & admin",
    description:
      "Marketing opt-out, email suppression status, consent source/date, vetting status, created date. Export this before any bulk send.",
    requires: "none",
    defaultOn: true,
  },
];

export const EXPORT_DATASETS: Record<ExportDatasetId, ExportDatasetDef> = {
  people: {
    id: "people",
    label: "People",
    description:
      "One row per person, widened with everything the app knows about them — emails, services, events, giving and form answers.",
    group: "People",
    requires: "none",
    supportsCentral: false,
    filters: ["persona", "rosterOnly", "activeOnly", "dateRange"],
    sections: PEOPLE_SECTIONS,
  },
  form_submissions: {
    id: "form_submissions",
    label: "Form submissions",
    description:
      "One row per submitted form, including anonymous event surveys that aren't attached to anyone.",
    group: "People",
    requires: "none",
    supportsCentral: false,
    filters: ["dateRange"],
    sections: [],
  },
  event_participation: {
    id: "event_participation",
    label: "Event participation",
    description:
      "One row per person per event — RSVP status, ticket, check-in and volunteer role.",
    group: "Events",
    requires: "none",
    supportsCentral: false,
    filters: ["dateRange"],
    sections: [],
  },
  events: {
    id: "events",
    label: "Events",
    description:
      "One row per event, with owner, date, status, and RSVP/attendance counts.",
    group: "Events",
    requires: "none",
    supportsCentral: false,
    filters: ["dateRange", "activeOnly"],
    sections: [],
  },
  tasks: {
    id: "tasks",
    label: "Tasks",
    description:
      "One row per planning item across every event module — owner, due date, status and the event it belongs to.",
    group: "Work",
    requires: "none",
    supportsCentral: false,
    filters: ["dateRange", "activeOnly"],
    sections: [],
  },
  projects: {
    id: "projects",
    label: "Projects",
    description: "One row per project, with owner, status and parent project.",
    group: "Work",
    requires: "none",
    supportsCentral: false,
    filters: ["activeOnly"],
    sections: [],
  },
  donors: {
    id: "donors",
    label: "Donors",
    description:
      "One row per donor record, with lifetime total, gift count and the roster person they're linked to.",
    group: "Giving",
    requires: "giving.view",
    supportsCentral: true,
    filters: ["activeOnly", "dateRange"],
    sections: [],
  },
  gifts: {
    id: "gifts",
    label: "Gifts",
    description:
      "One row per gift — amount, method, date, donor and the event or pledge it came through.",
    group: "Giving",
    requires: "giving.view",
    supportsCentral: true,
    filters: ["dateRange"],
    sections: [],
  },
  pledges: {
    id: "pledges",
    label: "Pledges",
    description:
      "One row per recurring pledge, with status, amount and billing period.",
    group: "Giving",
    requires: "giving.view",
    supportsCentral: true,
    filters: ["activeOnly"],
    sections: [],
  },
  transactions: {
    id: "transactions",
    label: "Transactions",
    description:
      "One row per money movement — amount, merchant, fund, budget, receipt status and who spent it.",
    group: "Finance",
    requires: "finance.viewer",
    supportsCentral: true,
    filters: ["dateRange"],
    sections: [],
  },
  academy_progress: {
    id: "academy_progress",
    label: "Academy progress",
    description:
      "One row per person per lesson, with completion date and quiz score.",
    group: "Work",
    requires: "none",
    supportsCentral: false,
    filters: ["dateRange"],
    sections: [],
  },
};

export const EXPORT_DATASET_LIST: readonly ExportDatasetDef[] =
  EXPORT_DATASET_IDS.map((id) => EXPORT_DATASETS[id]);

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isExportDatasetId(value: string): value is ExportDatasetId {
  return (EXPORT_DATASET_IDS as readonly string[]).includes(value);
}

export function isExportSectionId(value: string): value is ExportSectionId {
  return (EXPORT_SECTION_IDS as readonly string[]).includes(value);
}

/** Sections a dataset offers that the caller can actually fill, given their
 *  reach. Used by the picker to grey out rows AND by the runner to decide
 *  which columns to emit — one function so the two can never disagree. */
export function allowedSections(
  datasetId: ExportDatasetId,
  reach: { giving: boolean; finance: boolean },
): readonly ExportSectionDef[] {
  return EXPORT_DATASETS[datasetId].sections.filter((s) =>
    satisfiesRequirement(s.requires, reach),
  );
}

export function satisfiesRequirement(
  requirement: ExportRequirement,
  reach: { giving: boolean; finance: boolean },
): boolean {
  if (requirement === "none") return true;
  if (requirement === "giving.view") return reach.giving;
  return reach.finance;
}

/**
 * The filename a downloaded export lands under. Slugged hard because it ends
 * up in a `Content-Disposition` header and on a filesystem — a chapter named
 * `Austin / "South"` must not be able to inject a quote or a path separator.
 *
 * Shape: `people-austin-2026-07-31.csv`.
 */
export function exportFileName(args: {
  datasetId: ExportDatasetId;
  scopeLabel: string;
  /** ms epoch; the caller supplies it so this stays pure/testable. */
  at: number;
  format: ExportFormat;
}): string {
  const day = new Date(args.at).toISOString().slice(0, 10);
  const stem = slugForFile(EXPORT_DATASETS[args.datasetId].label);
  const scope = slugForFile(args.scopeLabel);
  const parts = [stem, scope, day].filter((p) => p.length > 0);
  return `${parts.join("-")}.${args.format}`;
}

/** Lowercase, ASCII-ish, hyphen-separated, no leading/trailing hyphens, capped.
 *  Anything outside `[a-z0-9]` collapses to a single hyphen — which disposes of
 *  quotes, slashes, `..`, control characters and RTL overrides in one rule. */
export function slugForFile(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** Column key for one form question in the wide people export. Stable across
 *  form re-wordings because it keys on `questionKey`, never the label. */
export function formAnswerColumnKey(
  formKey: string,
  questionKey: string,
): string {
  return `form:${formKey}:${questionKey}`;
}

/** Human header for that column: `Team Interest — What do you play?`. Uses an
 *  em dash so it reads as one label rather than two columns. */
export function formAnswerColumnLabel(
  formTitle: string,
  questionLabel: string,
): string {
  return `${formTitle} — ${questionLabel}`;
}

/**
 * Flatten one answer value into a single cell.
 *
 * Multi-select answers arrive as arrays and are joined with `"; "` — comma
 * would be ambiguous inside a CSV cell even though quoting makes it legal,
 * and semicolons are what Sheets' own SPLIT examples use. Objects are
 * JSON-stringified rather than dropped, so nothing silently disappears from a
 * verbatim record (`formSubmissions.answers` is `v.any()`).
 */
export function flattenAnswer(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => flattenAnswer(v)).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Money everywhere in this app is integer cents; spreadsheets want dollars.
 *  Returned as a NUMBER so it lands as a numeric cell (sortable, summable) and
 *  bypasses the formula guard, which only touches strings. */
export function centsToDollars(cents: number | undefined | null): number | "" {
  if (cents === null || cents === undefined) return "";
  return Math.round(cents) / 100;
}

/** Timestamps export as ISO-8601 date-times: unambiguous, sorts correctly as
 *  text, and every spreadsheet parses it. Empty for a missing value — never
 *  the epoch, which would read as a real 1970 date. */
export function isoOrBlank(ms: number | undefined | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

/** Date-only variant for fields where the time is noise (event dates, due
 *  dates) — `2026-07-31`. */
export function isoDateOrBlank(ms: number | undefined | null): string {
  const iso = isoOrBlank(ms);
  return iso === "" ? "" : iso.slice(0, 10);
}
