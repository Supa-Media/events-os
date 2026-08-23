import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * HIRING — the org's candidate funnel, as tables.
 *
 * Public Worship's hiring process is not invented here: it is the five-step
 * pipeline the Academy already teaches (`packages/shared/src/academy/streams/
 * management.ts`, the `growing-the-team` course), written down as constants in
 * `@events-os/shared`'s `hiring.ts` and stored here. Read that module first —
 * it explains every literal below and why the stage list has the shape it does.
 *
 * Three tables, and the split is the usual one:
 *  - `jobApplications` — one row per person per role. The file itself.
 *  - `applicationReviews` — one rubric card per reviewer per meeting/review.
 *    A separate table because "at least two team members, one shared rubric"
 *    means an unbounded-in-principle list of cards, and because a review is
 *    written by someone who may not own the file.
 *  - `applicationEvents` — the timeline. Every stage move, note, and decision,
 *    append-only, so "who moved this and when" survives the next stage move.
 *
 * WRITE PATHS. `hiring.submitApplication` is PUBLIC and unauthenticated — the
 * careers page posts to `/api/careers/apply` (`lib/careerApiRoutes.ts`), the
 * same trust model as the giving interest form. Everything else is gated
 * through the NAMED resolvers in `lib/hiringAccess.ts` (per CLAUDE.md's "Gate
 * It Behind a Power"): `requireHiringView` to read, `requireHiringManage` to
 * move a file, `requireHiringDecide` to close one.
 *
 * SCOPE. Central only — there is no `chapterId` on these tables on purpose.
 * "One pipeline, one standard, someone who can say yes, no, why, or not now"
 * is the mandate the People seat is being hired against; a per-chapter intake
 * would be a different product decision, and would arrive as a new column here
 * plus a scope argument on the resolvers, not as a quiet filter.
 *
 * PII. A candidate's answers are as personal as anything in this database —
 * where they go to church, what they can afford to give in hours, why they
 * want out of wherever they are. NO public query returns a row or any part of
 * one. The public surface is write-only (`submitApplication`) and the read
 * surface is the gated desk.
 */

/** The funnel, in order — `HIRING_STAGES` in `@events-os/shared`, inlined here
 *  the way every schema in this repo inlines its literals. `hiring.test.ts`
 *  asserts these two lists stay identical, so the drift this duplication would
 *  otherwise invite fails a test instead of shipping. */
export const APPLICATION_STAGES = [
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

/** Which rung of the ordered candidate search this person arrived on
 *  (`CANDIDATE_SOURCES`). Stored so the desk can see whether the order is
 *  actually being worked or whether every hire keeps arriving through rung 4. */
export const APPLICATION_SOURCES = [
  "in_house",
  "interest_pool",
  "public_call",
  "personal_network",
] as const;

/** The Empowerment Trial's two tracks (`TRIAL_TRACKS`). */
export const APPLICATION_TRIAL_TRACKS = ["team_member", "director"] as const;

/** Which meeting or review a rubric card came from (`REVIEW_KINDS`). */
export const APPLICATION_REVIEW_KINDS = [
  "interview_heart",
  "interview_role",
  "trial_midpoint",
  "trial_final",
] as const;

/** A reviewer's read, never a decision (`REVIEW_RECOMMENDATIONS`). */
export const APPLICATION_RECOMMENDATIONS = ["advance", "hold", "decline"] as const;

/** Timeline entry kinds. `submitted` opens every file; `decision` closes it. */
export const APPLICATION_EVENT_TYPES = [
  "submitted",
  "stage",
  "note",
  "review",
  "trial_started",
  "assigned",
  "decision",
  "message_sent",
] as const;

const stageValidator = v.union(
  ...APPLICATION_STAGES.map((s) => v.literal(s)),
);

export const jobApplications = defineTable({
  // ── What they applied for ────────────────────────────────────────────────
  /** The published role's slug (`apps/landing/src/content/roles/<slug>.md`),
   *  or `"general-interest"` for the no-specific-opening door. NOT a foreign
   *  key: roles are content in the repo, and an application has to outlive the
   *  posting it came from — a file from a role filled last year is exactly
   *  what the "not now" pile is for. */
  roleSlug: v.string(),
  /** The role's title AS PUBLISHED when they applied. Denormalized on purpose:
   *  if the role is later retitled, this file should still say what the person
   *  actually read and agreed to. */
  roleTitle: v.string(),

  // ── Who they are ─────────────────────────────────────────────────────────
  name: v.string(),
  /** Lowercased at write. Indexed — the desk needs "have we talked to this
   *  person before?" to be one lookup, because the answer changes how the
   *  first conversation should go. */
  email: v.string(),
  phone: v.optional(v.string()),
  location: v.optional(v.string()),
  /** Portfolio, LinkedIn, a church's site — capped in count and length at
   *  write time (`APPLICATION_LIMITS`). */
  links: v.optional(v.array(v.string())),
  /** Free text: "Sam told me to apply." Kept separate from `source` because
   *  what a candidate SAYS and how the desk FILES it are different facts. */
  referredBy: v.optional(v.string()),

  // ── What they said ───────────────────────────────────────────────────────
  /** Answers keyed by `APPLICATION_QUESTIONS[].key`. A record rather than
   *  named columns so a question can be reworded, added, or retired without a
   *  schema migration; unknown keys are rejected at the write gate, so the bag
   *  can't become a junk drawer. */
  answers: v.record(v.string(), v.string()),

  // ── Where they are ───────────────────────────────────────────────────────
  stage: stageValidator,
  /** When the CURRENT stage was entered — the clock the response promise and
   *  the stale-file warning are both measured against (`isStale`). */
  stageChangedAt: v.number(),
  source: v.union(...APPLICATION_SOURCES.map((s) => v.literal(s))),
  /** Who owns getting back to this person. Nobody, at first — an unassigned
   *  file aging past the promise is the desk's most useful alarm. */
  assignedTo: v.optional(v.id("users")),
  /** Linked once they're a real person in the CRM (placed, or worth keeping
   *  warm). Deliberately NOT created at submit time: an application is not yet
   *  a relationship, and filling `people` with everyone who ever clicked apply
   *  would poison every roster count in the app. */
  personId: v.optional(v.id("people")),

  // ── The Empowerment Trial (step 4) ───────────────────────────────────────
  trialTrack: v.optional(
    v.union(...APPLICATION_TRIAL_TRACKS.map((t) => v.literal(t))),
  ),
  trialStartedAt: v.optional(v.number()),
  /** Both computed from the track at start (`trialDueDates`) and STORED, so a
   *  later change to the cadence constants can't silently move a trial that is
   *  already running under a promise made to a person. */
  trialMidpointDueAt: v.optional(v.number()),
  trialDecisionDueAt: v.optional(v.number()),
  /** The bounded work itself: what they're doing, what "done" looks like, what
   *  they get to decide. Written by the desk, shown to the candidate. */
  trialBrief: v.optional(v.string()),

  // ── The call (step 5) ────────────────────────────────────────────────────
  outcome: v.optional(
    v.union(
      v.literal("placed"),
      v.literal("not_now"),
      v.literal("declined"),
      v.literal("withdrawn"),
    ),
  ),
  decidedAt: v.optional(v.number()),
  decidedBy: v.optional(v.id("users")),
  /** WHY, internally. Required on every close (`recordDecision`) — the "yes,
   *  no, why, or not now" mandate is unenforceable if the why is optional, and
   *  a reason written months ago is the only thing that makes a re-open
   *  honest. Never shown to the candidate; the outcome MESSAGE is. */
  decisionReason: v.optional(v.string()),
  /** `not_now` only, and required there: the date this is actually revisited.
   *  A not-now without one is a no that nobody had to say. */
  revisitAt: v.optional(v.number()),
  /** When the templated outcome message actually went out. Absent on a closed
   *  file = someone owes this person an email. */
  outcomeMessageSentAt: v.optional(v.number()),

  createdAt: v.number(),
  updatedAt: v.number(),
})
  // The desk's default view: one stage's column, newest first.
  .index("by_stage", ["stage"])
  // Whole-funnel reads and the "what came in this week" count.
  .index("by_createdAt", ["createdAt"])
  // Everyone who ever applied for one role — the pool a re-opened role starts
  // from rather than starting cold.
  .index("by_role", ["roleSlug"])
  // "Have we met this person before?" — dedupe at submit, history at read.
  .index("by_email", ["email"]);

export const applicationReviews = defineTable({
  applicationId: v.id("jobApplications"),
  /** The reviewer, always the CALLER — never an argument. */
  reviewerId: v.id("users"),
  kind: v.union(...APPLICATION_REVIEW_KINDS.map((k) => v.literal(k))),
  /** Criterion → 1-4 (`RUBRIC`, `RUBRIC_SCALE`). A criterion the reviewer
   *  genuinely didn't see is ABSENT, which is different from — and more honest
   *  than — a low score. Keys and range are validated at the write gate. */
  ratings: v.record(v.string(), v.number()),
  notes: v.optional(v.string()),
  recommendation: v.union(
    ...APPLICATION_RECOMMENDATIONS.map((r) => v.literal(r)),
  ),
  createdAt: v.number(),
})
  .index("by_application", ["applicationId"])
  // "Has THIS reviewer already filed for this meeting?" — one card per
  // reviewer per kind, enforced at the write gate.
  .index("by_application_and_reviewer", ["applicationId", "reviewerId"]);

export const applicationEvents = defineTable({
  applicationId: v.id("jobApplications"),
  type: v.union(...APPLICATION_EVENT_TYPES.map((t) => v.literal(t))),
  /** Absent for `submitted` — the candidate isn't a user. */
  actorId: v.optional(v.id("users")),
  fromStage: v.optional(stageValidator),
  toStage: v.optional(stageValidator),
  /** The note, the decision reason, the message that went out. */
  body: v.optional(v.string()),
  at: v.number(),
}).index("by_application", ["applicationId"]);
