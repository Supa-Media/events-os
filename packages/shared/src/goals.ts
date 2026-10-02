/**
 * GOALS — the org's year plans: a mission, targets, objectives, and the key
 * results each objective is judged on. Plus the 2027 One Pager, the first plan
 * the org wrote, as importable starting data.
 *
 * EVERYTHING HERE IS EDITABLE DATA, on purpose. The founder's standing ask
 * (2026-10-02): "objectives, teams, seats, OKRs etc can all change in a
 * moment's notice." So nothing about a plan's content is a constant the app
 * reasons about — the One Pager below is only a seed, copied into rows once
 * and then edited in the app like anything else. The vocabularies (statuses,
 * measure kinds, units) are the only fixed parts.
 *
 * ── The boundary the feature teaches ───────────────────────────────────────
 * A key result is the SCORE and never holds tasks. The work that moves it
 * lives in exactly one home elsewhere in the app — a project, an event, a
 * duty — and links to it. See the Academy lesson and `measureKind` below.
 */

// ── Key-result status ────────────────────────────────────────────────────────
/** How a key result is going. Set by whoever posts an update; "done" is also
 *  derived automatically when a seat-filled or event-count measure hits its
 *  target (see `deriveKeyResultProgress`). */
export const KEY_RESULT_STATUSES = [
  "not_started",
  "on_track",
  "at_risk",
  "behind",
  "done",
] as const;
export type KeyResultStatus = (typeof KEY_RESULT_STATUSES)[number];

export const KEY_RESULT_STATUS_LABELS: Record<KeyResultStatus, string> = {
  not_started: "Not started",
  on_track: "On track",
  at_risk: "At risk",
  behind: "Behind",
  done: "Done",
};

// ── Plan status ──────────────────────────────────────────────────────────────
/** A plan is drafted, then becomes the active year, then is closed. Nothing is
 *  locked by status — an active plan stays fully editable. Status only decides
 *  which plan the Goals screen opens on and which key results projects can
 *  link to. */
export const GOAL_PLAN_STATUSES = ["draft", "active", "closed"] as const;
export type GoalPlanStatus = (typeof GOAL_PLAN_STATUSES)[number];
export const GOAL_PLAN_STATUS_LABELS: Record<GoalPlanStatus, string> = {
  draft: "Draft",
  active: "Active",
  closed: "Closed",
};

// ── Measures ─────────────────────────────────────────────────────────────────
/**
 * How a key result's progress is read.
 *   manual       — someone types the number (or just sets the status).
 *   seat_filled  — counts holders of one seat at one scope (Central or a
 *                  chapter). "Recruit the NYC Chapter Director" is done the
 *                  day someone is seated.
 *   event_count  — counts COMPLETED events of the chosen event types (and
 *                  optionally one chapter) dated inside the plan's year.
 * Money is `manual` for now; reading Giving/Finance totals is a follow-up.
 */
export const KEY_RESULT_MEASURE_KINDS = ["manual", "seat_filled", "event_count"] as const;
export type KeyResultMeasureKind = (typeof KEY_RESULT_MEASURE_KINDS)[number];
export const KEY_RESULT_MEASURE_LABELS: Record<KeyResultMeasureKind, string> = {
  manual: "Typed in by hand",
  seat_filled: "A seat being filled",
  event_count: "Completed events",
};

export const GOAL_UNITS = ["count", "usd", "percent", "people"] as const;
export type GoalUnit = (typeof GOAL_UNITS)[number];
export const GOAL_UNIT_LABELS: Record<GoalUnit, string> = {
  count: "Count",
  usd: "Dollars",
  percent: "Percent",
  people: "People",
};

/** Format a goal number in its unit, e.g. `$12,000`, `35%`, `5,000`. */
export function formatGoalValue(value: number, unit: GoalUnit | undefined): string {
  const n = Math.round(value * 100) / 100;
  const s = n.toLocaleString("en-US");
  if (unit === "usd") return `$${s}`;
  if (unit === "percent") return `${s}%`;
  return s;
}

/**
 * The progress shown for a key result: `current` of `target`, a 0–1 fraction
 * when there is a target, and whether the measure says it is met. Pure, so the
 * backend and the screen agree. `current` is the measured value for automatic
 * measures and the typed value for manual ones.
 */
export function deriveKeyResultProgress(
  current: number | undefined,
  target: number | undefined,
): { fraction: number | null; met: boolean } {
  if (target == null || target <= 0 || current == null) {
    return { fraction: null, met: false };
  }
  const fraction = Math.max(0, Math.min(1, current / target));
  return { fraction, met: current >= target };
}

/** The display code for a key result: objective position + KR position, both
 *  1-based, e.g. "2.4". Derived from order so reordering renumbers. */
export function keyResultCode(objectiveIndex: number, keyResultIndex: number): string {
  return `${objectiveIndex + 1}.${keyResultIndex + 1}`;
}

// ── The 2027 One Pager, as starting data ────────────────────────────────────
/**
 * Seed rows for "Public Worship 2027 One Pager", imported once from the Goals
 * screen and then edited like any other plan. Team names are matched to
 * (or create) org teams on import.
 *
 * Two places the source disagreed with itself were resolved to the
 * objectives table: 3.1 is ONE EP in Q1 and 3.2 is TWO singles in Q3 (the
 * "By Team" table said two EPs and four singles). The targets use the funding
 * split agreed on 2026-10-01 ($12k / $9k / $5k / $4k), which replaced the
 * One Pager's $20k / $5k / $5k; the key-result text is the One Pager's own.
 * Every one of those is a plain edit away in the app.
 */
export interface SeedKeyResult {
  title: string;
  owner?: string;
  contributors?: string[];
  /** A seat slug that owns this instead of a team (e.g. Chapter Directors). */
  ownerSeat?: string;
  timing: string;
  /** Epoch ms (America/New_York midnight-ish is fine — display is by date). */
  due?: string;
  measure?:
    | { kind: "seat_filled"; seat: string; scope: "central" | "nyc" | "dmv"; target?: number }
    | { kind: "manual"; target?: number; unit?: GoalUnit };
}
export interface SeedObjective {
  title: string;
  owner: string;
  keyResults: SeedKeyResult[];
}
export interface SeedTeam {
  name: string;
  /** Where the team lives: Central, or a chapter matched by name on import. */
  scope: "central" | "nyc" | "dmv";
  leadSeat?: string;
  seats?: string[];
  parent?: string;
}
export interface SeedTarget {
  label: string;
  target: number;
  unit: GoalUnit;
  children?: { label: string; target: number }[];
}
export interface SeedPlan {
  year: number;
  title: string;
  mission: string;
  retroWins: string[];
  retroGaps: string[];
  targets: SeedTarget[];
  teams: SeedTeam[];
  objectives: SeedObjective[];
}

export const ONE_PAGER_2027: SeedPlan = {
  year: 2027,
  title: "Public Worship 2027",
  mission:
    "At Public Worship, we exist to create a holy experience through music— one that ignites unwavering faith in Jesus. We strive to move seeds from rocky ground into good soil, to produce fruits of genuine worship that reflects our bold identity in Christ.",
  retroWins: [
    "Created opportunities for public worship, prayer, and church connection.",
    "Developed new leaders across the team.",
    "Established a shared brand and a roughly 600-person newsletter.",
    "Developed six original songs toward release.",
    "Launched Public Worship Supply online.",
    "7 events reaching over 1000+ people in person.",
  ],
  retroGaps: [
    "Hold ourselves more accountable to agreed deadlines.",
    "Start event planning and permit applications earlier.",
    "Recruit consistently and build a reliable volunteer pool.",
    "Reduce dependence on a few people.",
    "Agree on ownership and capacity across teams.",
    "Build repeatable funding beyond founder contributions.",
  ],
  targets: [
    {
      label: "Events",
      target: 26,
      unit: "count",
      children: [
        { label: "Worship With Strangers, across 2 cities", target: 15 },
        { label: "Flagship worship events", target: 4 },
        { label: "Fellowship events", target: 4 },
        { label: "Music workshops", target: 2 },
        { label: "Conference", target: 1 },
      ],
    },
    { label: "People reached in person", target: 5000, unit: "people" },
    {
      label: "Funding",
      target: 30000,
      unit: "usd",
      children: [
        { label: "Sponsorships and brand partnerships", target: 12000 },
        { label: "Church-partnered Worship With Strangers", target: 9000 },
        { label: "Monthly backers", target: 5000 },
        { label: "Merch profit", target: 4000 },
      ],
    },
  ],
  teams: [
    { name: "People team", scope: "central", leadSeat: "expansion_director", seats: ["recruiting_associate", "training_associate"] },
    { name: "Central Events", scope: "central" },
    { name: "Public Fellowship", scope: "central", parent: "Central Events" },
    { name: "Music team", scope: "central", leadSeat: "music_director", seats: ["a_and_r", "artists", "musicians", "songwriters"] },
    { name: "Marketing team", scope: "central", leadSeat: "marketing_director", seats: ["social_media_manager", "graphic_designer", "marketing_associate"] },
    { name: "Development team", scope: "central", leadSeat: "development_director", seats: ["partnership_associate", "fundraising_associate"] },
    { name: "Finance team", scope: "central", leadSeat: "financial_manager" },
    { name: "All teams", scope: "central" },
    { name: "NYC chapter", scope: "nyc", leadSeat: "chapter_director", seats: ["treasurer", "music_lead", "event_lead", "marketing_lead"] },
    { name: "DMV chapter", scope: "dmv", leadSeat: "chapter_director", seats: ["treasurer", "music_lead", "event_lead", "marketing_lead"] },
  ],
  objectives: [
    {
      title: "Build healthy Central, NYC, and DMV teams",
      owner: "People team",
      keyResults: [
        { title: "Recruit a recruiting associate.", owner: "People team", timing: "Oct 31, 2026", due: "2026-10-31", measure: { kind: "seat_filled", seat: "recruiting_associate", scope: "central" } },
        { title: "Recruit the NYC Chapter Director.", owner: "People team", timing: "Nov 15, 2026", due: "2026-11-15", measure: { kind: "seat_filled", seat: "chapter_director", scope: "nyc" } },
        { title: "Recruit four remaining NYC chapter leads.", owner: "People team", contributors: ["NYC chapter"], timing: "Dec 31, 2026", due: "2026-12-31", measure: { kind: "manual", target: 4, unit: "count" } },
        { title: "Recruit the DMV Chapter Director.", owner: "People team", timing: "Apr 30, 2027", due: "2027-04-30", measure: { kind: "seat_filled", seat: "chapter_director", scope: "dmv" } },
        { title: "Staff and train the DMV chapter.", owner: "People team", contributors: ["DMV chapter"], timing: "Jun 30, 2027", due: "2027-06-30" },
        { title: "Hold monthly chapter team meetings.", ownerSeat: "chapter_director", timing: "Monthly" },
        { title: "Confirm returning members' roles and commitments.", owner: "People team", contributors: ["All teams"], timing: "Nov 30, 2026", due: "2026-11-30" },
        { title: "Recruit a Partnerships Associate.", owner: "People team", contributors: ["Development team"], timing: "Dec 31, 2026", due: "2026-12-31", measure: { kind: "seat_filled", seat: "partnership_associate", scope: "central" } },
        { title: "Recruiting 4 dedicated experienced event planners.", owner: "People team", contributors: ["Central Events"], timing: "Dec 31, 2026", due: "2026-12-31", measure: { kind: "manual", target: 4, unit: "count" } },
        { title: "Document the team onboarding process.", owner: "People team", timing: "Dec 15, 2026", due: "2026-12-15" },
        { title: "Equip chapter marketers with brand resources and training.", owner: "People team", contributors: ["Marketing team"], timing: "Before chapter launch" },
        { title: "Retain 80% of the starting team.", owner: "People team", contributors: ["All teams"], timing: "Dec 2027", due: "2027-12-31", measure: { kind: "manual", target: 80, unit: "percent" } },
      ],
    },
    {
      title: "Create worship and fundraising experiences",
      owner: "Central Events",
      keyResults: [
        { title: "Host the Public Worship conference.", owner: "Central Events", timing: "Jan 2027", due: "2027-01-31" },
        { title: "Host 10 NYC Worship With Strangers gatherings.", owner: "NYC chapter", timing: "Feb–Nov 2027", due: "2027-11-30", measure: { kind: "manual", target: 10, unit: "count" } },
        { title: "Host five DMV Worship With Strangers gatherings.", owner: "DMV chapter", timing: "Jul–Nov 2027", due: "2027-11-30", measure: { kind: "manual", target: 5, unit: "count" } },
        { title: "Host Eden.", owner: "Central Events", timing: "Spring 2027", due: "2027-06-20" },
        { title: "Host Love Thy Neighbor.", owner: "Central Events", timing: "Summer 2027", due: "2027-09-22" },
        { title: "Host four Public Fellowship events.", owner: "Central Events", contributors: ["Public Fellowship"], timing: "2027", due: "2027-12-31", measure: { kind: "manual", target: 4, unit: "count" } },
        { title: "Host two additional flagship Public Worship events.", owner: "Central Events", timing: "2027", due: "2027-12-31", measure: { kind: "manual", target: 2, unit: "count" } },
        { title: "2 planned Rehearsals before every flagship worship event.", owner: "Music team", timing: "Before each flagship" },
        { title: "Track local follow-up and next steps monthly.", contributors: ["NYC chapter", "DMV chapter"], timing: "Monthly" },
      ],
    },
    {
      title: "Release music and develop our artists",
      owner: "Music team",
      keyResults: [
        { title: "Release one Public Worship EP.", owner: "Music team", timing: "Q1 2027", due: "2027-03-31" },
        { title: "Release two individual-artist singles.", owner: "Music team", timing: "Q3 2027", due: "2027-09-30", measure: { kind: "manual", target: 2, unit: "count" } },
        { title: "Hold two internal songwriting retreats.", owner: "Music team", timing: "2027", due: "2027-12-31", measure: { kind: "manual", target: 2, unit: "count" } },
        { title: "Host two public music workshops.", owner: "Music team", timing: "2027", due: "2027-12-31", measure: { kind: "manual", target: 2, unit: "count" } },
        { title: "Review every artist's development plan quarterly.", owner: "Music team", timing: "Quarterly" },
        { title: "Promote every music release.", owner: "Marketing team", timing: "Each release" },
      ],
    },
    {
      title: "Grow Public Worship's reach and engagement",
      owner: "Marketing team",
      keyResults: [
        { title: "Achieve 35% opens across 12 monthly newsletters.", owner: "Marketing team", timing: "Monthly", measure: { kind: "manual", target: 35, unit: "percent" } },
        { title: "Publish monthly updates and behind-the-scenes content.", owner: "Marketing team", timing: "Monthly" },
        { title: "Complete a team photo shoot.", owner: "Marketing team", timing: "Q1 2027", due: "2027-03-31" },
        { title: "Capture photos and video at every flagship event.", owner: "Marketing team", timing: "Each flagship" },
        { title: "Promote flagship events with printed flyers.", owner: "Marketing team", timing: "Before each flagship" },
        { title: "Promote every central event.", owner: "Marketing team", timing: "Before each event" },
        { title: "Publish photo recaps after every WWS.", contributors: ["NYC chapter", "DMV chapter"], timing: "Tuesday after WWS" },
        { title: "Publish short video recaps for every other WWS.", contributors: ["NYC chapter", "DMV chapter"], timing: "Alternate gatherings" },
        { title: "Publish WWS recaps on YouTube.", contributors: ["NYC chapter", "DMV chapter"], timing: "Quarterly" },
      ],
    },
    {
      title: "Fund the agreed ministry calendar",
      owner: "Development team",
      keyResults: [
        { title: "Secure partnerships for every WWS and flagship.", owner: "Development team", timing: "Before each event" },
        { title: "Raise $20,000 through partnerships and sponsorships.", owner: "Development team", timing: "Dec 2027", due: "2027-12-31", measure: { kind: "manual", target: 20000, unit: "usd" } },
        { title: "Raise $5,000 from monthly backers.", owner: "Development team", timing: "Dec 2027", due: "2027-12-31", measure: { kind: "manual", target: 5000, unit: "usd" } },
        { title: "Retain 85% of monthly backers.", owner: "Development team", timing: "Dec 2027", due: "2027-12-31", measure: { kind: "manual", target: 85, unit: "percent" } },
        { title: "Submit eight grant applications; win two awards.", owner: "Development team", timing: "2027", due: "2027-12-31", measure: { kind: "manual", target: 8, unit: "count" } },
        { title: "Launch new colorways, hats, and sweatshirts.", owner: "Marketing team", timing: "2027", due: "2027-12-31" },
        { title: "Complete a merch photo shoot.", owner: "Marketing team", timing: "Q1 2027", due: "2027-03-31" },
        { title: "Publish two monthly merch posts across central channels.", owner: "Marketing team", timing: "Monthly" },
        { title: "Earn $5,000 merch profit in H1.", owner: "Marketing team", timing: "Jun 30, 2027", due: "2027-06-30", measure: { kind: "manual", target: 5000, unit: "usd" } },
        { title: "Approve Central and chapter budgets.", owner: "Finance team", timing: "Nov 30, 2026", due: "2026-11-30" },
        { title: "Cover operating costs with repeatable income by Q4.", owner: "Development team", contributors: ["Finance team"], timing: "Q4 2027", due: "2027-12-31" },
      ],
    },
  ],
};

/** Parse a seed `due` ("YYYY-MM-DD") to epoch ms at noon UTC, so the calendar
 *  date reads the same in every US timezone. */
export function seedDueToMs(due: string): number {
  const [y, m, d] = due.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}
