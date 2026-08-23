/**
 * HIRING — the org's one funnel, as data.
 *
 * Public Worship already HAS a hiring process: the five-step pipeline the
 * Academy teaches in the `growing-the-team` course (`academy/streams/
 * management.ts` — "Empower first, appoint second", "The interview", "The
 * trial", "The call"). Until now it lived only as training and tribal
 * knowledge, which is exactly the thing the People Director is being hired to
 * systematize. This module is that process written down as constants, so the
 * public `/team` pages (`apps/landing/src/pages/team/*`), the application
 * intake (`apps/convex/hiring.ts`), and the Hiring desk (`apps/mobile/app/
 * (app)/hiring/*`) all describe the SAME pipeline and can never drift from
 * each other or from the lessons.
 *
 * THE FIVE STEPS (Academy, `mgmt-empower-first`):
 *   1 · Create the role      — define it before looking: purpose, outcomes,
 *                              responsibilities, ideal traits. The public
 *                              role page is that definition, published.
 *   2 · Find candidates      — in-house → volunteer interest pool → public
 *                              call → personal networks, ALWAYS in that
 *                              order (`CANDIDATE_SOURCES`). The `/team` page
 *                              is the "public call" rung; every rung lands in
 *                              the same table so everyone passes the same door.
 *   3 · Interview            — two meetings (heart & alignment, then role
 *                              fit), at least `MIN_REVIEWS_BEFORE_DECISION`
 *                              team members, one shared rubric (`RUBRIC`).
 *   4 · Empowerment Trial    — 1–2 months of real, bounded work before
 *                              anything is official (`TRIAL_TRACKS`).
 *   5 · The Director decides — prayerfully, with a templated outcome message
 *                              either way (`OUTCOMES`, `outcomeMessage`).
 *
 * WHERE *BUY BACK YOUR TIME* COMES IN (owner's ask, 2026-08-23). Martell's
 * delegation discipline doesn't replace any of the five steps — it sharpens
 * step 1 and step 4, which are the two the org has the least structure for:
 *   - "Delegate an OUTCOME, constraints, authority, and a definition of done —
 *     not a stream of keystrokes." Hence a role definition is invalid here
 *     unless it names outcomes, their definition of done, and the decisions
 *     the seat gets to make on its own (enforced by the landing site's
 *     `roles` collection schema, which mirrors `ROLE_TEMPLATE_SECTIONS`).
 *   - The 1-3-1 escalation rule (one problem, three options, one
 *     recommendation) is asked of every applicant as `escalation` below,
 *     because how someone escalates is the cheapest early read on whether
 *     delegating to them will actually buy time back.
 *   - The Camcorder Method — the RECIPIENT writes the playbook from real
 *     executions — is why the trial brief asks for a written playbook rather
 *     than handing one over (`TRIAL_DELIVERABLE_PROMPT`).
 * See `3-resources/books/buy-back-your-time.md` in the owner's brain for the
 * framework itself, and `docs/guides/recruiting.md` for how a director
 * actually runs one of these.
 *
 * NOTHING here is chapter-scoped: hiring is a CENTRAL desk (the People seat
 * runs one standard for the whole org — `lib/hiringAccess.ts` gates on the
 * central scope only), even when the role being filled sits in a chapter.
 */

// ── Stages ───────────────────────────────────────────────────────────────────

/**
 * Where a candidate is in the funnel. The six OPEN stages are the five
 * Academy steps with one addition: `reviewing`, the triage the five-step
 * process never needed because it predates a public application form. An
 * inbound application has to be READ by someone before it becomes an
 * interview, and that read is where the standard is actually held ("one
 * pipeline, one standard, someone who can say yes, no, why, or not now").
 *
 * The four CLOSED stages are the outcomes of step 5. `not_now` is a real
 * outcome, not a soft no — it carries a revisit date (see `OUTCOMES`).
 */
export const HIRING_STAGES = [
  "applied",
  "reviewing",
  "interview_heart",
  "interview_role",
  "trial",
  "decision",
  "placed",
  "not_now",
  "declined",
  "withdrawn",
] as const;
export type HiringStage = (typeof HIRING_STAGES)[number];

export interface HiringStageDef {
  id: HiringStage;
  /** What the DESK calls it. */
  label: string;
  /** Which of the five Academy steps this stage belongs to, or `null` for a
   *  closed stage (the outcome of step 5 rather than a step). */
  step: 2 | 3 | 4 | 5 | null;
  /** One line on what has to happen for it to move on. */
  blurb: string;
  /** Closed stages are terminal: the file stops moving and stops counting
   *  against the response promise. */
  closed: boolean;
  /** What the CANDIDATE is told this stage means, in the confirmation email
   *  and on `/team`'s "what happens after you apply" list. Absent on
   *  stages a candidate never sees named (`withdrawn`). */
  candidateLabel?: string;
}

export const HIRING_STAGE_DEFS: Record<HiringStage, HiringStageDef> = {
  applied: {
    id: "applied",
    label: "Applied",
    step: 2,
    blurb: "Landed in the funnel. Nobody has read it yet.",
    closed: false,
    candidateLabel: "We have your application",
  },
  reviewing: {
    id: "reviewing",
    label: "Reading it",
    step: 2,
    blurb:
      "A human is reading it against the role: covering, capacity, and whether the outcomes fit.",
    closed: false,
    candidateLabel: "Someone is reading it",
  },
  interview_heart: {
    id: "interview_heart",
    label: "Interview · heart & alignment",
    step: 3,
    blurb:
      "20–30 min on their story, why they want to serve, chemistry, humility — and the mission, plainly.",
    closed: false,
    candidateLabel: "A first conversation",
  },
  interview_role: {
    id: "interview_role",
    label: "Interview · role fit",
    step: 3,
    blurb:
      "20 min on role-specific depth, scope, and what the trial would be. Combine with the first if time is short.",
    closed: false,
    candidateLabel: "A second conversation about the role",
  },
  trial: {
    id: "trial",
    label: "Empowerment Trial",
    step: 4,
    blurb:
      "Real, bounded work with a midpoint and a final review. Nothing is official yet.",
    closed: false,
    candidateLabel: "An Empowerment Trial",
  },
  decision: {
    id: "decision",
    label: "Awaiting the call",
    step: 5,
    blurb:
      "The trial is done and the reviews are in. The Director owes this person an answer.",
    closed: false,
    candidateLabel: "A decision",
  },
  placed: {
    id: "placed",
    label: "Placed",
    step: null,
    blurb: "Yes. They hold the seat; onboarding owns them now.",
    closed: true,
    candidateLabel: "A yes",
  },
  not_now: {
    id: "not_now",
    label: "Not now",
    step: null,
    blurb:
      "Yes to the person, no to the timing or the seat. Carries a revisit date — this is a promise, not a filing cabinet.",
    closed: true,
    candidateLabel: "A not-yet, with a date we'll come back to you",
  },
  declined: {
    id: "declined",
    label: "Declined",
    step: null,
    blurb: "No, said warmly and promptly, with the reason recorded internally.",
    closed: true,
    candidateLabel: "A no",
  },
  withdrawn: {
    id: "withdrawn",
    label: "Withdrew",
    step: null,
    blurb: "They stepped out, or went quiet past the point of chasing.",
    closed: true,
  },
};

/** The open stages, in funnel order — the desk's column order. */
export const OPEN_HIRING_STAGES: HiringStage[] = HIRING_STAGES.filter(
  (s) => !HIRING_STAGE_DEFS[s].closed,
);

/** The terminal stages, in the order a director thinks of them. */
export const CLOSED_HIRING_STAGES: HiringStage[] = HIRING_STAGES.filter(
  (s) => HIRING_STAGE_DEFS[s].closed,
);

export function isHiringStage(value: string): value is HiringStage {
  return (HIRING_STAGES as readonly string[]).includes(value);
}

export function isClosedStage(stage: HiringStage): boolean {
  return HIRING_STAGE_DEFS[stage].closed;
}

/** The next open stage in funnel order, or `null` at `decision` (where the
 *  only moves left are the four outcomes — a "next" button must never guess
 *  which one). */
export function nextOpenStage(stage: HiringStage): HiringStage | null {
  if (isClosedStage(stage)) return null;
  const index = OPEN_HIRING_STAGES.indexOf(stage);
  return OPEN_HIRING_STAGES[index + 1] ?? null;
}

// ── Outcomes (step 5) ────────────────────────────────────────────────────────

/** The four ways a file closes. Each maps to its terminal stage 1:1 — the
 *  separate type exists so a decision UI can offer exactly these and nothing
 *  else, and so the required-field rules below have somewhere to live. */
export const HIRING_OUTCOMES = [
  "placed",
  "not_now",
  "declined",
  "withdrawn",
] as const;
export type HiringOutcome = (typeof HIRING_OUTCOMES)[number];

export interface HiringOutcomeDef {
  id: HiringOutcome;
  label: string;
  /** Must the director record a revisit date? (`not_now` is a promise.) */
  requiresRevisitDate: boolean;
  /** Does the candidate get a message? `withdrawn` is the only one that
   *  doesn't — they closed the loop themselves. */
  messagesCandidate: boolean;
}

export const HIRING_OUTCOME_DEFS: Record<HiringOutcome, HiringOutcomeDef> = {
  placed: { id: "placed", label: "Yes — place them", requiresRevisitDate: false, messagesCandidate: true },
  not_now: { id: "not_now", label: "Not now — revisit", requiresRevisitDate: true, messagesCandidate: true },
  declined: { id: "declined", label: "No — warm decline", requiresRevisitDate: false, messagesCandidate: true },
  withdrawn: { id: "withdrawn", label: "They withdrew", requiresRevisitDate: false, messagesCandidate: false },
};

export function isHiringOutcome(value: string): value is HiringOutcome {
  return (HIRING_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The templated outcome message, pre-filled for the director to edit before
 * it sends. Templated because the Academy's `mgmt-the-call` makes it doctrine:
 * "how you say no is as much a part of the culture as how you say yes," and a
 * cold or absent no undoes everything the empower-first pipeline built. It is
 * a DRAFT, never an auto-send — the desk always shows it before it goes.
 */
export function outcomeMessage(
  outcome: HiringOutcome,
  { candidateName, roleTitle, revisitLabel }: {
    candidateName: string;
    roleTitle: string;
    /** Human date for `not_now`, e.g. "January". */
    revisitLabel?: string;
  },
): string | null {
  const first = candidateName.trim().split(/\s+/)[0] || "friend";
  switch (outcome) {
    case "placed":
      return [
        `${first} — after everything we've seen, we'd love to empower you to lead ${roleTitle}.`,
        "",
        "Thank you for the work you already put in. It told us more than any interview could have.",
        "",
        "Here's what happens next: we'll get you onboarded, walk you through what you own and what you get to decide on your own, and set up your first check-in. Expect to hear from us within the week with dates.",
        "",
        "Glad you're here.",
      ].join("\n");
    case "not_now":
      return [
        `${first} — thank you for the time and care you gave this.`,
        "",
        `This is a not-yet rather than a no. ${roleTitle} isn't the right fit for this season${revisitLabel ? `, but we'd like to come back to this around ${revisitLabel}` : ", but we'd like to come back to it"}.`,
        "",
        "If something changes on your end before then, tell us — we'd rather hear from you than assume.",
      ].join("\n");
    case "declined":
      return [
        `${first} — thank you for the time you gave this, genuinely.`,
        "",
        `We've been talking with a few people about ${roleTitle}, and we're going a different direction this time.`,
        "",
        "That isn't a verdict on you. We'd love to stay connected — come to a gathering, and if something opens that fits you better, we'll reach out.",
      ].join("\n");
    case "withdrawn":
      return null;
  }
}

// ── The rubric (steps 3 and 4 share it) ──────────────────────────────────────

/**
 * ONE rubric, used at BOTH the interview and every trial review — the
 * Academy is explicit that the trial "re-uses the same rubric to confirm the
 * call in practice."
 *
 * THE ORDER IS THE TIEBREAK, and it is not alphabetical or arbitrary: when
 * two candidates are close, character breaks the tie, then communication,
 * then people skills, then execution, then availability. "Skill can be
 * trained; heart can't" is the entire rationale. Renderers MUST keep this
 * order — the array position IS the doctrine.
 */
export const RUBRIC = [
  {
    id: "character",
    label: "Character",
    prompt:
      "Humility, honesty, how they take correction. The part a trial confirms rather than creates.",
  },
  {
    id: "communication",
    label: "Communication",
    prompt: "Clarity, and response time. Do they close loops without being chased?",
  },
  {
    id: "people_skills",
    label: "People skills",
    prompt: "Relational grace. What happens around them when something goes wrong?",
  },
  {
    id: "execution",
    label: "Execution",
    prompt: "Initiative, follow-through, ownership, excellence in the actual work.",
  },
  {
    id: "availability",
    label: "Availability",
    prompt:
      "The real hours, honestly. Also a hard gate before this: if the time isn't there, it's a no regardless of the rest.",
  },
] as const;

export type RubricCriterion = (typeof RUBRIC)[number]["id"];
export const RUBRIC_CRITERIA: RubricCriterion[] = RUBRIC.map((c) => c.id);

export function isRubricCriterion(value: string): value is RubricCriterion {
  return (RUBRIC_CRITERIA as string[]).includes(value);
}

/** 1–4, no neutral middle — a 4-point scale forces a lean. A criterion may
 *  also be left UNRATED (absent from the ratings bag) when a reviewer genuinely
 *  didn't see it; that is different from, and more honest than, a 2. */
export const RUBRIC_SCALE = [
  { value: 1, label: "Concern", blurb: "Something here would have to change." },
  { value: 2, label: "Developing", blurb: "Real, but not yet at the standard." },
  { value: 3, label: "Solid", blurb: "Meets the standard we hold." },
  { value: 4, label: "Sets the standard", blurb: "Others would learn this from them." },
] as const;

export const RUBRIC_MIN = 1;
export const RUBRIC_MAX = 4;

/** What a reviewer recommends after their meeting or review. Deliberately not
 *  a decision — step 5 says the Director decides; this is evidence. */
export const REVIEW_RECOMMENDATIONS = ["advance", "hold", "decline"] as const;
export type ReviewRecommendation = (typeof REVIEW_RECOMMENDATIONS)[number];

/** Which meeting or review a rubric card came from. */
export const REVIEW_KINDS = [
  "interview_heart",
  "interview_role",
  "trial_midpoint",
  "trial_final",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  interview_heart: "Interview · heart & alignment",
  interview_role: "Interview · role fit",
  trial_midpoint: "Trial · midpoint",
  trial_final: "Trial · final review",
};

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}

/**
 * "At least two team members, one shared rubric." Enforced at the DECISION
 * gate rather than at each stage move, so a director can still run a fast
 * first conversation alone — what they can't do is close a file on one
 * person's read.
 */
export const MIN_REVIEWS_BEFORE_DECISION = 2;

/** Mean of the rated criteria (unrated ones are skipped, not counted as 0),
 *  or `null` when a card rated nothing. A summary number for a list view —
 *  never the decision (see `mgmt-the-call`). */
export function rubricAverage(
  ratings: Partial<Record<RubricCriterion, number>>,
): number | null {
  const values = RUBRIC_CRITERIA.map((c) => ratings[c]).filter(
    (v): v is number => typeof v === "number",
  );
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Rank two candidates the way the Academy's tiebreak does: criterion by
 * criterion in `RUBRIC` order, character first. Returns <0 when `a` should
 * sort ahead. An unrated criterion counts as 0 HERE (and only here) — a
 * comparison needs a total order, and "we never saw it" genuinely is weaker
 * evidence than "we saw it and it was fine."
 */
export function compareByRubric(
  a: Partial<Record<RubricCriterion, number>>,
  b: Partial<Record<RubricCriterion, number>>,
): number {
  for (const criterion of RUBRIC_CRITERIA) {
    const diff = (b[criterion] ?? 0) - (a[criterion] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── The Empowerment Trial (step 4) ───────────────────────────────────────────

/** The two trial tracks and their check-in cadence, straight from
 *  `mgmt-the-trial`. Directors get the longer runway because the scope being
 *  confirmed is bigger. */
export const TRIAL_TRACKS = [
  {
    id: "team_member",
    label: "Team member",
    midpointDays: 14,
    decisionDays: 28,
    weeklyHours: 5,
  },
  {
    id: "director",
    label: "Director",
    midpointDays: 30,
    decisionDays: 60,
    weeklyHours: 10,
  },
] as const;

export type TrialTrack = (typeof TRIAL_TRACKS)[number]["id"];
export const TRIAL_TRACK_IDS: TrialTrack[] = TRIAL_TRACKS.map((t) => t.id);

export function isTrialTrack(value: string): value is TrialTrack {
  return (TRIAL_TRACK_IDS as string[]).includes(value);
}

export function trialTrackDef(track: TrialTrack) {
  const found = TRIAL_TRACKS.find((t) => t.id === track);
  if (!found) throw new Error(`Unknown trial track: ${track}`);
  return found;
}

const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;

/** The two dates a trial owes the candidate, computed from its start. Stored
 *  on the application so the desk can surface an overdue midpoint instead of
 *  quietly letting a trial run long — the failure mode the trial's cadence
 *  exists to prevent. */
export function trialDueDates(
  track: TrialTrack,
  startedAt: number,
): { midpointDueAt: number; decisionDueAt: number } {
  const def = trialTrackDef(track);
  return {
    midpointDueAt: startedAt + def.midpointDays * DAY_MS_LOCAL,
    decisionDueAt: startedAt + def.decisionDays * DAY_MS_LOCAL,
  };
}

/** What the trial deliberately WITHHOLDS (`mgmt-the-trial`'s "empowered, but
 *  bounded"). Rendered on the trial brief so the boundary is stated to the
 *  candidate rather than discovered by them. */
export const TRIAL_BOUNDARIES = [
  "No posting to official accounts",
  "No managing budgets or spending",
  "No access to sensitive data",
  "No team Slack yet — only the people needed for the assigned work",
] as const;

/** Camcorder Method, applied: the trial's written deliverable is the PLAYBOOK,
 *  drafted by the person doing the work, not handed to them. */
export const TRIAL_DELIVERABLE_PROMPT =
  "Alongside the work itself: write the short playbook for what you did — the trigger, the steps, what you decided and why, and what 'done' looks like. Whoever comes after you should be able to run it.";

// ── Where candidates come from (step 2) ──────────────────────────────────────

/**
 * The candidate search, IN ORDER. The order is the point: "every person
 * passes through the same door" — a fixed order stops a personal connection
 * from becoming a silent shortcut. Stored on every application so the desk
 * can see whether the order is actually being worked, or whether every hire
 * keeps arriving through rung 4.
 */
export const CANDIDATE_SOURCES = [
  { id: "in_house", label: "Already on the team", rung: 1 },
  { id: "interest_pool", label: "Volunteer interest pool", rung: 2 },
  { id: "public_call", label: "Public call (/team)", rung: 3 },
  { id: "personal_network", label: "Personal network", rung: 4 },
] as const;

export type CandidateSource = (typeof CANDIDATE_SOURCES)[number]["id"];
export const CANDIDATE_SOURCE_IDS: CandidateSource[] = CANDIDATE_SOURCES.map(
  (s) => s.id,
);

export function isCandidateSource(value: string): value is CandidateSource {
  return (CANDIDATE_SOURCE_IDS as string[]).includes(value);
}

/** Everything arriving through the `/team` form is rung 3 by definition — the
 *  public call. A director can re-file it after the fact (a personal contact
 *  they asked to apply properly is still rung 4), which is exactly the honesty
 *  the ordered search needs to be measurable. */
export const DEFAULT_CANDIDATE_SOURCE: CandidateSource = "public_call";

// ── The application itself ───────────────────────────────────────────────────

/**
 * The questions every applicant answers, in order. Same set for every role —
 * one door — with the role's own specifics carried by the role page rather
 * than by bespoke per-role questions, which is what makes two applications
 * comparable at all.
 *
 * Four of the six are load-bearing gates the Academy already names
 * (`capacity`, `covering`) or that *Buy Back Your Time* argues for
 * (`ownership` — outcomes and a definition of done; `escalation` — the 1-3-1
 * rule). `why` and `trial` are the two that consistently separate people who
 * want a title from people who want the work.
 */
export const APPLICATION_QUESTIONS = [
  {
    key: "why",
    label: "Why Public Worship, and why this role?",
    help: "Plainly. We'd rather read three honest sentences than a cover letter.",
    maxLength: 1500,
    required: true,
  },
  {
    key: "ownership",
    label: "Tell us about something you owned end to end.",
    help: "What was the outcome, how did you know it was finished, and what did you decide on your own along the way?",
    maxLength: 2000,
    required: true,
  },
  {
    key: "escalation",
    label: "Describe a hard call you had to take to someone above you.",
    help: "What was the problem, what options did you weigh, and what did you recommend? (One problem, three options, one recommendation — that's how we escalate here.)",
    maxLength: 2000,
    required: true,
  },
  {
    key: "capacity",
    label: "Realistically, how many hours a week — and what else are you carrying?",
    help: "This is a gate, not a formality: roughly 10 hrs/week for a director seat, 5 for a team seat, plus recurring meetings. We'd rather know now.",
    maxLength: 1000,
    required: true,
  },
  {
    key: "covering",
    label: "Where do you call home church, and how are you attending and giving there?",
    help: "We ask everyone. Public Worship is not a church and won't be yours — we want people who are already covered somewhere, serving here as overflow.",
    maxLength: 1000,
    required: true,
  },
  {
    key: "trial",
    label: "Every role starts with an Empowerment Trial — real, bounded work before anything is official. What would you want yours to be?",
    help: "Optional. A good answer here has told us more than a resume, more than once.",
    maxLength: 1500,
    required: false,
  },
] as const;

export type ApplicationQuestionKey = (typeof APPLICATION_QUESTIONS)[number]["key"];

export function isApplicationQuestionKey(
  value: string,
): value is ApplicationQuestionKey {
  return APPLICATION_QUESTIONS.some((q) => q.key === value);
}

export function applicationQuestion(key: ApplicationQuestionKey) {
  const found = APPLICATION_QUESTIONS.find((q) => q.key === key);
  if (!found) throw new Error(`Unknown application question: ${key}`);
  return found;
}

/** Field caps for the identity part of the form. Enforced server-side
 *  (`hiring.submitApplication`) — the client copy of these is a courtesy. */
export const APPLICATION_LIMITS = {
  name: 120,
  email: 200,
  phone: 40,
  location: 120,
  link: 500,
  links: 4,
  referredBy: 160,
} as const;

/**
 * The slug an application carries when someone applies without a specific
 * opening — the "I don't see my role but I want in" door. Kept as a real
 * slug rather than an empty field so the desk can filter on it, and so the
 * volunteer interest pool (rung 2 of the ordered search) has somewhere to
 * live that isn't a spreadsheet.
 */
export const GENERAL_INTEREST_SLUG = "general-interest";
export const GENERAL_INTEREST_TITLE = "General interest";

/**
 * What we promise a candidate, in days, and therefore what the desk is
 * measured against: an application gets a human reply within a week, and
 * nobody sits in an open stage for more than a month without hearing
 * something. These are PRODUCT commitments (published on `/team`),
 * not something the Academy pinned — if they change, the page changes.
 */
export const RESPONSE_PROMISE_DAYS = 7;
export const STALE_STAGE_DAYS = 30;

/** Is this file overdue a human touch? Closed files never are. */
export function isStale(
  stage: HiringStage,
  stageChangedAt: number,
  now: number,
): boolean {
  if (isClosedStage(stage)) return false;
  const limit = stage === "applied" ? RESPONSE_PROMISE_DAYS : STALE_STAGE_DAYS;
  return now - stageChangedAt > limit * DAY_MS_LOCAL;
}

// ── The role template (step 1) ───────────────────────────────────────────────

/**
 * The sections every published role must have, in render order. The landing
 * site's `roles` content collection enforces these as required fields (its
 * Zod schema is the executable copy of this list), which is what makes every
 * role page read the same way and stops a role from being published as a
 * vibe. The three starred by *Buy Back Your Time* — outcomes, definition of
 * done (carried inside each outcome), and authority — are required for the
 * same reason the book gives: a responsibility handed over without them comes
 * straight back.
 */
export const ROLE_TEMPLATE_SECTIONS = [
  { key: "summary", label: "The short version" },
  { key: "whyThisSeatExists", label: "Why this seat exists" },
  { key: "outcomes", label: "What you'd be accountable for" },
  { key: "authority", label: "What you'd get to decide" },
  { key: "responsibilities", label: "The work itself" },
  { key: "expectations", label: "Rhythms and the first 90 days" },
  { key: "qualifications", label: "Who this is for" },
  { key: "notThisRole", label: "What this role is not" },
  { key: "successLooks", label: "How we'd know it's working" },
  { key: "growthPath", label: "Where it can go" },
] as const;

export type RoleTemplateSection = (typeof ROLE_TEMPLATE_SECTIONS)[number]["key"];

/** A published role's lifecycle on `/team`. `filling` keeps a role
 *  visible while its pipeline runs — an applicant seeing "we're interviewing"
 *  is treated better than one who finds the page gone. */
export const ROLE_STATUSES = ["open", "filling", "not_open", "closed"] as const;
export type RoleStatus = (typeof ROLE_STATUSES)[number];

export const ROLE_STATUS_LABELS: Record<RoleStatus, string> = {
  open: "Open",
  filling: "Interviewing",
  not_open: "Not open yet",
  closed: "Filled",
};

/** Which statuses still accept an application. `not_open` and `closed` roles
 *  render, but their apply button points at general interest instead. */
export function roleAcceptsApplications(status: RoleStatus): boolean {
  return status === "open" || status === "filling";
}
