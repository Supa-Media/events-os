/**
 * HIRING — the org's candidate funnel, end to end.
 *
 * Three surfaces, the same PUBLIC/ADMIN split `givingInterest.ts` uses:
 *  - PUBLIC `submitApplication` (no auth) — the write path behind
 *    `POST /api/careers/apply` (`lib/careerApiRoutes.ts`), which the careers
 *    page's application form posts to. This is rung 3 of the ordered candidate
 *    search ("public call"), and the ONLY public surface here: nothing in this
 *    file lets an unauthenticated caller read a single field back.
 *  - DESK reads — `myHiringAccess`, `listApplications`, `pipelineSummary`,
 *    `getApplication` — gated on `hiring.view`.
 *  - DESK writes — stage moves, rubric reviews, trials, notes — gated on
 *    `hiring.edit`; closing a file (`recordDecision`) on `hiring.approve`.
 *
 * The process this implements is NOT invented here. It is the five-step
 * pipeline the Academy teaches in `growing-the-team`, encoded in
 * `@events-os/shared`'s `hiring.ts`. Where this file enforces something, the
 * lesson it comes from is named at the enforcement point. The rules worth
 * knowing up front:
 *
 *  - Every candidate passes the same door. One table, one stage machine, one
 *    rubric, whether they came from a public form or a director's friend.
 *  - A file cannot be PLACED on one person's read
 *    (`MIN_REVIEWS_BEFORE_DECISION`) — "at least two team members, one shared
 *    rubric."
 *  - Every close records a REASON, and every close except a withdrawal offers
 *    the candidate a message. The warm no is doctrine (`mgmt-the-call`), so
 *    the desk makes it the path of least resistance rather than a nicety.
 *  - A `not_now` must carry a revisit date. Otherwise it is a no that nobody
 *    had to say out loud.
 *
 * See `schema/hiring.ts` for the tables and `lib/hiringAccess.ts` for the gate.
 */
import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  APPLICATION_LIMITS,
  APPLICATION_QUESTIONS,
  GENERAL_INTEREST_SLUG,
  GENERAL_INTEREST_TITLE,
  HIRING_STAGES,
  HIRING_OUTCOME_DEFS,
  MIN_REVIEWS_BEFORE_DECISION,
  RESPONSE_PROMISE_DAYS,
  RUBRIC_MAX,
  RUBRIC_MIN,
  isApplicationQuestionKey,
  isClosedStage,
  isRubricCriterion,
  trialDueDates,
  type HiringOutcome,
  type HiringStage,
  type TrialTrack,
} from "@events-os/shared";
import {
  APPLICATION_EVENT_TYPES,
  APPLICATION_RECOMMENDATIONS,
  APPLICATION_REVIEW_KINDS,
  APPLICATION_SOURCES,
  APPLICATION_STAGES,
  APPLICATION_TRIAL_TRACKS,
} from "./schema/hiring";
import {
  requireHiringDecide,
  requireHiringManage,
  requireHiringView,
  resolveHiringAccess,
} from "./lib/hiringAccess";
import { requireUserId } from "./lib/context";
import { escapeHtml } from "./lib/html";
import { siteUrl } from "./lib/siteUrl";
import {
  emailButtonRow,
  emailHeading,
  emailParagraph,
} from "./lib/emailShell";
import { emailShell, sendEmail } from "./ticketingEmails";

const stageValidator = v.union(...APPLICATION_STAGES.map((s) => v.literal(s)));
const sourceValidator = v.union(...APPLICATION_SOURCES.map((s) => v.literal(s)));
const trackValidator = v.union(
  ...APPLICATION_TRIAL_TRACKS.map((t) => v.literal(t)),
);
const reviewKindValidator = v.union(
  ...APPLICATION_REVIEW_KINDS.map((k) => v.literal(k)),
);
const recommendationValidator = v.union(
  ...APPLICATION_RECOMMENDATIONS.map((r) => v.literal(r)),
);
const outcomeValidator = v.union(
  v.literal("placed"),
  v.literal("not_now"),
  v.literal("declined"),
  v.literal("withdrawn"),
);
const eventTypeValidator = v.union(
  ...APPLICATION_EVENT_TYPES.map((t) => v.literal(t)),
);

/** A generous bound on the desk's list read. Hiring is a launch-phase volume
 *  (tens, not thousands); this is headroom, not a paging strategy. If the
 *  funnel ever outgrows it, the fix is pagination, not a bigger number. */
const APPLICATION_LIST_LIMIT = 500;
/** One file's timeline and rubric cards. A busy director-track file runs to a
 *  dozen entries; this is far past any real one. */
const APPLICATION_CHILD_LIMIT = 200;
/** Same-person dedupe scan (`by_email`) — someone applying to a handful of
 *  roles over a couple of years, with room to spare. */
const APPLICANT_HISTORY_LIMIT = 50;

/** How long a double-submit counts as the same application rather than a new
 *  one. A double-clicked form, a retried request, or someone who wasn't sure
 *  it went through should not produce two files for a director to reconcile. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const NOTE_MAX_LEN = 4000;
const TRIAL_BRIEF_MAX_LEN = 4000;
const DECISION_REASON_MAX_LEN = 2000;
const OUTCOME_MESSAGE_MAX_LEN = 8000;

/** `undefined` for a blank/whitespace-only string, else the trimmed value. */
function trimmedOrUndefined(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

function requireText(
  value: string | undefined,
  { field, label, max }: { field: string; label: string; max: number },
): string {
  const trimmed = trimmedOrUndefined(value);
  if (!trimmed) {
    throw new ConvexError({
      code: `MISSING_${field.toUpperCase()}`,
      message: `${label} is required.`,
    });
  }
  if (trimmed.length > max) {
    throw new ConvexError({
      code: `INVALID_${field.toUpperCase()}`,
      message: `${label} must be ${max} characters or fewer.`,
    });
  }
  return trimmed;
}

/** Deliberately permissive: `x@y`. A stricter regex rejects real addresses,
 *  and the only thing riding on this is whether we can write back — which the
 *  first bounce tells us anyway. */
function normalizedEmail(raw: string | undefined): string {
  const email = requireText(raw, {
    field: "email",
    label: "Email",
    max: APPLICATION_LIMITS.email,
  }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ConvexError({
      code: "INVALID_EMAIL",
      message: "That email address doesn't look right.",
    });
  }
  return email;
}

// ── PUBLIC (no auth) ─────────────────────────────────────────────────────────

/**
 * PUBLIC entry point for the careers page's application form (no auth — same
 * trust model as `givingInterest.submitInterest` and the public giving flow).
 *
 * What it enforces, and why each rule is here rather than only in the form:
 *  - Name and email are required. A file nobody can reply to is not an
 *    application, and the response promise on the careers page is a promise.
 *  - Every REQUIRED question in `APPLICATION_QUESTIONS` must be answered.
 *    Those questions are the org's actual screen — availability, spiritual
 *    covering, ownership, and how someone escalates — so an application
 *    missing one cannot be compared against the ones that answered.
 *  - Unknown answer keys are REJECTED, not stored. The answers bag exists so
 *    questions can change without a migration, not so a crafted POST can
 *    write arbitrary fields into the desk's UI.
 *  - A repeat submission for the same role by the same email inside
 *    `DUPLICATE_WINDOW_MS` updates the existing file instead of opening a
 *    second one.
 *
 * `roleSlug` is NOT validated against a list of open roles on purpose. The
 * published roles are content in the landing repo, not rows here; a slug the
 * backend doesn't recognize is a stale bookmark or a renamed posting, and the
 * right response to that is to accept the application and let a human sort it
 * out — not to lose a candidate to a 400.
 */
export const submitApplication = mutation({
  args: {
    roleSlug: v.optional(v.string()),
    roleTitle: v.optional(v.string()),
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    location: v.optional(v.string()),
    links: v.optional(v.array(v.string())),
    referredBy: v.optional(v.string()),
    // Loose `v.record(v.string(), v.string())`, narrowed in the handler so an
    // unknown key produces a friendly message rather than Convex's generic
    // argument-validation failure (the same call `submitInterest` makes).
    answers: v.record(v.string(), v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    const roleSlug =
      trimmedOrUndefined(args.roleSlug)?.toLowerCase() ?? GENERAL_INTEREST_SLUG;
    const roleTitle =
      trimmedOrUndefined(args.roleTitle) ??
      (roleSlug === GENERAL_INTEREST_SLUG ? GENERAL_INTEREST_TITLE : roleSlug);

    const name = requireText(args.name, {
      field: "name",
      label: "Your name",
      max: APPLICATION_LIMITS.name,
    });
    const email = normalizedEmail(args.email);
    const phone = trimmedOrUndefined(args.phone);
    const location = trimmedOrUndefined(args.location);
    const referredBy = trimmedOrUndefined(args.referredBy);

    if (phone && phone.length > APPLICATION_LIMITS.phone) {
      throw new ConvexError({
        code: "INVALID_PHONE",
        message: `Phone must be ${APPLICATION_LIMITS.phone} characters or fewer.`,
      });
    }
    if (location && location.length > APPLICATION_LIMITS.location) {
      throw new ConvexError({
        code: "INVALID_LOCATION",
        message: `Location must be ${APPLICATION_LIMITS.location} characters or fewer.`,
      });
    }
    if (referredBy && referredBy.length > APPLICATION_LIMITS.referredBy) {
      throw new ConvexError({
        code: "INVALID_REFERRED_BY",
        message: `That field must be ${APPLICATION_LIMITS.referredBy} characters or fewer.`,
      });
    }

    const links = (args.links ?? [])
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (links.length > APPLICATION_LIMITS.links) {
      throw new ConvexError({
        code: "TOO_MANY_LINKS",
        message: `Please share at most ${APPLICATION_LIMITS.links} links.`,
      });
    }
    for (const link of links) {
      if (link.length > APPLICATION_LIMITS.link) {
        throw new ConvexError({
          code: "INVALID_LINK",
          message: `A link must be ${APPLICATION_LIMITS.link} characters or fewer.`,
        });
      }
    }

    const answers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(args.answers)) {
      if (!isApplicationQuestionKey(key)) {
        throw new ConvexError({
          code: "UNKNOWN_QUESTION",
          message: `We don't have a question called "${key}".`,
        });
      }
      const value = raw.trim();
      if (!value) continue;
      const question = APPLICATION_QUESTIONS.find((q) => q.key === key)!;
      if (value.length > question.maxLength) {
        throw new ConvexError({
          code: "ANSWER_TOO_LONG",
          message: `"${question.label}" must be ${question.maxLength} characters or fewer.`,
        });
      }
      answers[key] = value;
    }
    const missing = APPLICATION_QUESTIONS.filter(
      (q) => q.required && !answers[q.key],
    );
    if (missing.length > 0) {
      throw new ConvexError({
        code: "MISSING_ANSWERS",
        message: `Still needed: ${missing.map((q) => q.label).join(" · ")}`,
      });
    }

    // Same person, same role, same day → the same application. Scanned through
    // `by_email` (bounded) rather than a compound index: an applicant's own
    // history is a handful of rows, and the desk wants that history anyway.
    const history = await ctx.db
      .query("jobApplications")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(APPLICANT_HISTORY_LIMIT);
    const duplicate = history.find(
      (row) =>
        row.roleSlug === roleSlug && now - row.createdAt < DUPLICATE_WINDOW_MS,
    );
    if (duplicate) {
      await ctx.db.patch(duplicate._id, {
        name,
        ...(phone ? { phone } : {}),
        ...(location ? { location } : {}),
        ...(links.length ? { links } : {}),
        ...(referredBy ? { referredBy } : {}),
        answers,
        updatedAt: now,
      });
      await ctx.db.insert("applicationEvents", {
        applicationId: duplicate._id,
        type: "note",
        body: "Applicant re-submitted the form; this file was updated in place.",
        at: now,
      });
      return null;
    }

    const applicationId = await ctx.db.insert("jobApplications", {
      roleSlug,
      roleTitle,
      name,
      email,
      ...(phone ? { phone } : {}),
      ...(location ? { location } : {}),
      ...(links.length ? { links } : {}),
      ...(referredBy ? { referredBy } : {}),
      answers,
      // Rung 3 of the ordered search by definition — it arrived through the
      // public call. A director who nudged someone to apply properly can
      // re-file it as `personal_network` afterwards, which is the honesty the
      // ordered search needs to mean anything.
      stage: "applied",
      stageChangedAt: now,
      source: "public_call",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "submitted",
      body: `Applied for ${roleTitle}.`,
      at: now,
    });

    // The confirmation is part of the promise, not a courtesy: the careers
    // page tells people what happens next, so the first thing that happens
    // next has to be an email that says the same thing. Scheduled (not
    // awaited) so a Resend hiccup can never cost us the application itself.
    await ctx.scheduler.runAfter(0, internal.hiring.sendApplicationReceived, {
      applicationId,
    });
    return null;
  },
});

// ── Desk reads ───────────────────────────────────────────────────────────────

/** The caller's reach, for nav and in-screen gating. Never throws — a signed-in
 *  member with no hiring seat gets three `false`s, not an error. */
export const myHiringAccess = query({
  args: {},
  returns: v.object({
    canView: v.boolean(),
    canManage: v.boolean(),
    canDecide: v.boolean(),
  }),
  handler: async (ctx) => {
    const access = await resolveHiringAccess(ctx);
    return {
      canView: access.canView,
      canManage: access.canManage,
      canDecide: access.canDecide,
    };
  },
});

const applicationRowValidator = v.object({
  _id: v.id("jobApplications"),
  roleSlug: v.string(),
  roleTitle: v.string(),
  name: v.string(),
  email: v.string(),
  phone: v.union(v.string(), v.null()),
  location: v.union(v.string(), v.null()),
  stage: stageValidator,
  stageChangedAt: v.number(),
  source: sourceValidator,
  assignedTo: v.union(v.id("users"), v.null()),
  assignedToName: v.union(v.string(), v.null()),
  personId: v.union(v.id("people"), v.null()),
  trialTrack: v.union(trackValidator, v.null()),
  trialMidpointDueAt: v.union(v.number(), v.null()),
  trialDecisionDueAt: v.union(v.number(), v.null()),
  outcome: v.union(outcomeValidator, v.null()),
  revisitAt: v.union(v.number(), v.null()),
  outcomeMessageSentAt: v.union(v.number(), v.null()),
  reviewCount: v.number(),
  createdAt: v.number(),
});

/** The display name behind a `users` id, via that user's roster row — the desk
 *  shows "assigned to Ada", not a document id. `null` when the id resolves to
 *  nobody (a removed user on an old assignment). */
async function userDisplayName(
  ctx: QueryCtx,
  userId: Id<"users"> | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const person = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (person?.name) return person.name;
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? null;
}

async function countReviews(
  ctx: QueryCtx,
  applicationId: Id<"jobApplications">,
): Promise<number> {
  const reviews = await ctx.db
    .query("applicationReviews")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .take(APPLICATION_CHILD_LIMIT);
  return reviews.length;
}

async function applicationRow(ctx: QueryCtx, row: Doc<"jobApplications">) {
  return {
    _id: row._id,
    roleSlug: row.roleSlug,
    roleTitle: row.roleTitle,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    location: row.location ?? null,
    stage: row.stage,
    stageChangedAt: row.stageChangedAt,
    source: row.source,
    assignedTo: row.assignedTo ?? null,
    assignedToName: await userDisplayName(ctx, row.assignedTo),
    personId: row.personId ?? null,
    trialTrack: row.trialTrack ?? null,
    trialMidpointDueAt: row.trialMidpointDueAt ?? null,
    trialDecisionDueAt: row.trialDecisionDueAt ?? null,
    outcome: row.outcome ?? null,
    revisitAt: row.revisitAt ?? null,
    outcomeMessageSentAt: row.outcomeMessageSentAt ?? null,
    reviewCount: await countReviews(ctx, row._id),
    createdAt: row.createdAt,
  };
}

/**
 * The desk's list. Newest first, open files only unless `includeClosed`.
 *
 * Deliberately ONE list rather than a per-stage query: the People seat's job
 * is the whole funnel at once ("how are our people?" starts with "who is
 * waiting on us?"), and a stage filter on top of a bounded read is cheaper
 * than six round trips.
 */
export const listApplications = query({
  args: {
    stage: v.optional(stageValidator),
    roleSlug: v.optional(v.string()),
    includeClosed: v.optional(v.boolean()),
  },
  returns: v.array(applicationRowValidator),
  handler: async (ctx, { stage, roleSlug, includeClosed }) => {
    await requireHiringView(ctx);

    const rows = stage
      ? await ctx.db
          .query("jobApplications")
          .withIndex("by_stage", (q) => q.eq("stage", stage))
          .take(APPLICATION_LIST_LIMIT)
      : await ctx.db
          .query("jobApplications")
          .withIndex("by_createdAt")
          .order("desc")
          .take(APPLICATION_LIST_LIMIT);

    const filtered = rows
      .filter((row) => (roleSlug ? row.roleSlug === roleSlug : true))
      .filter((row) =>
        includeClosed || stage ? true : !isClosedStage(row.stage as HiringStage),
      )
      .sort((a, b) => b.createdAt - a.createdAt);

    return Promise.all(filtered.map((row) => applicationRow(ctx, row)));
  },
});

/**
 * The header numbers: how many files sit in each stage, how many are past the
 * promise, how many nobody owns, and how many trials are overdue a review.
 *
 * The last three are the ones that matter. A stage count tells you the funnel's
 * shape; an aging unassigned file tells you the funnel is failing someone.
 */
export const pipelineSummary = query({
  args: {},
  returns: v.object({
    byStage: v.record(v.string(), v.number()),
    open: v.number(),
    pastPromise: v.number(),
    unassigned: v.number(),
    trialReviewsDue: v.number(),
    awaitingDecision: v.number(),
    responsePromiseDays: v.number(),
  }),
  handler: async (ctx) => {
    await requireHiringView(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("jobApplications")
      .withIndex("by_createdAt")
      .order("desc")
      .take(APPLICATION_LIST_LIMIT);

    const byStage: Record<string, number> = {};
    for (const s of HIRING_STAGES) byStage[s] = 0;
    let open = 0;
    let pastPromise = 0;
    let unassigned = 0;
    let trialReviewsDue = 0;
    let awaitingDecision = 0;

    for (const row of rows) {
      byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
      if (isClosedStage(row.stage as HiringStage)) continue;
      open += 1;
      if (row.stage === "applied" &&
          now - row.createdAt > RESPONSE_PROMISE_DAYS * 24 * 60 * 60 * 1000) {
        pastPromise += 1;
      }
      if (!row.assignedTo) unassigned += 1;
      if (row.stage === "decision") awaitingDecision += 1;
      if (
        row.stage === "trial" &&
        row.trialMidpointDueAt !== undefined &&
        now > row.trialMidpointDueAt
      ) {
        trialReviewsDue += 1;
      }
    }

    return {
      byStage,
      open,
      pastPromise,
      unassigned,
      trialReviewsDue,
      awaitingDecision,
      responsePromiseDays: RESPONSE_PROMISE_DAYS,
    };
  },
});

/** One file, with its answers, its rubric cards, and its timeline. */
export const getApplication = query({
  args: { applicationId: v.id("jobApplications") },
  returns: v.union(
    v.null(),
    v.object({
      application: v.object({
        ...applicationRowValidator.fields,
        links: v.array(v.string()),
        referredBy: v.union(v.string(), v.null()),
        answers: v.record(v.string(), v.string()),
        trialBrief: v.union(v.string(), v.null()),
        trialStartedAt: v.union(v.number(), v.null()),
        decisionReason: v.union(v.string(), v.null()),
        decidedAt: v.union(v.number(), v.null()),
        updatedAt: v.number(),
      }),
      reviews: v.array(
        v.object({
          _id: v.id("applicationReviews"),
          reviewerId: v.id("users"),
          reviewerName: v.union(v.string(), v.null()),
          kind: reviewKindValidator,
          ratings: v.record(v.string(), v.number()),
          notes: v.union(v.string(), v.null()),
          recommendation: recommendationValidator,
          createdAt: v.number(),
        }),
      ),
      events: v.array(
        v.object({
          _id: v.id("applicationEvents"),
          type: eventTypeValidator,
          actorName: v.union(v.string(), v.null()),
          fromStage: v.union(stageValidator, v.null()),
          toStage: v.union(stageValidator, v.null()),
          body: v.union(v.string(), v.null()),
          at: v.number(),
        }),
      ),
      /** Everything else this person has ever applied for — the "have we met
       *  before?" the `by_email` index exists for. */
      otherApplications: v.array(
        v.object({
          _id: v.id("jobApplications"),
          roleTitle: v.string(),
          stage: stageValidator,
          createdAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, { applicationId }) => {
    await requireHiringView(ctx);
    const row = await ctx.db.get(applicationId);
    if (!row) return null;

    const reviewRows = await ctx.db
      .query("applicationReviews")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
      .take(APPLICATION_CHILD_LIMIT);
    const eventRows = await ctx.db
      .query("applicationEvents")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
      .take(APPLICATION_CHILD_LIMIT);
    const history = await ctx.db
      .query("jobApplications")
      .withIndex("by_email", (q) => q.eq("email", row.email))
      .take(APPLICANT_HISTORY_LIMIT);

    return {
      application: {
        ...(await applicationRow(ctx, row)),
        links: row.links ?? [],
        referredBy: row.referredBy ?? null,
        answers: row.answers,
        trialBrief: row.trialBrief ?? null,
        trialStartedAt: row.trialStartedAt ?? null,
        decisionReason: row.decisionReason ?? null,
        decidedAt: row.decidedAt ?? null,
        updatedAt: row.updatedAt,
      },
      reviews: await Promise.all(
        reviewRows
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(async (r) => ({
            _id: r._id,
            reviewerId: r.reviewerId,
            reviewerName: await userDisplayName(ctx, r.reviewerId),
            kind: r.kind,
            ratings: r.ratings,
            notes: r.notes ?? null,
            recommendation: r.recommendation,
            createdAt: r.createdAt,
          })),
      ),
      events: await Promise.all(
        eventRows
          .sort((a, b) => b.at - a.at)
          .map(async (e) => ({
            _id: e._id,
            type: e.type,
            actorName: await userDisplayName(ctx, e.actorId),
            fromStage: e.fromStage ?? null,
            toStage: e.toStage ?? null,
            body: e.body ?? null,
            at: e.at,
          })),
      ),
      otherApplications: history
        .filter((h) => h._id !== applicationId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((h) => ({
          _id: h._id,
          roleTitle: h.roleTitle,
          stage: h.stage,
          createdAt: h.createdAt,
        })),
    };
  },
});

// ── Desk writes ──────────────────────────────────────────────────────────────

/** Load a file for a write, or throw the same not-found either way — a desk
 *  write against a deleted id is a bug, not a user error. */
async function loadApplication(
  ctx: MutationCtx,
  applicationId: Id<"jobApplications">,
): Promise<Doc<"jobApplications">> {
  const row = await ctx.db.get(applicationId);
  if (!row) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "That application no longer exists.",
    });
  }
  return row;
}

/**
 * Move a file to another OPEN stage.
 *
 * Terminal stages are refused here on purpose: closing a file is
 * `recordDecision`, which requires a different power, a recorded reason, and
 * (for a placement) two rubric cards. Letting a stage move quietly reach
 * `declined` would route around all three.
 */
export const advanceStage = mutation({
  args: {
    applicationId: v.id("jobApplications"),
    stage: stageValidator,
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { applicationId, stage, note }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const row = await loadApplication(ctx, applicationId);

    if (isClosedStage(stage as HiringStage)) {
      throw new ConvexError({
        code: "USE_DECISION",
        message:
          "Closing a file is a decision — use place, not-now, or decline so the reason and the message are recorded.",
      });
    }
    if (row.stage === stage) return null;

    const body = trimmedOrUndefined(note);
    if (body && body.length > NOTE_MAX_LEN) {
      throw new ConvexError({
        code: "NOTE_TOO_LONG",
        message: `A note must be ${NOTE_MAX_LEN} characters or fewer.`,
      });
    }

    const now = Date.now();
    // Re-opening a closed file: clear the outcome so a stale "declined" badge
    // can't outlive the decision that set it.
    const clearing = isClosedStage(row.stage as HiringStage)
      ? {
          outcome: undefined,
          decidedAt: undefined,
          decidedBy: undefined,
          revisitAt: undefined,
          outcomeMessageSentAt: undefined,
        }
      : {};
    await ctx.db.patch(applicationId, {
      stage,
      stageChangedAt: now,
      updatedAt: now,
      ...clearing,
    });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "stage",
      actorId: userId,
      fromStage: row.stage,
      toStage: stage,
      ...(body ? { body } : {}),
      at: now,
    });
    return null;
  },
});

/** Take (or drop) ownership of a file. Ownership is the difference between a
 *  funnel and an inbox — an unowned file past the promise is the desk's
 *  loudest alarm (`pipelineSummary.unassigned`). */
export const claimApplication = mutation({
  args: { applicationId: v.id("jobApplications"), claim: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { applicationId, claim }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await loadApplication(ctx, applicationId);
    const now = Date.now();
    await ctx.db.patch(applicationId, {
      assignedTo: claim ? userId : undefined,
      updatedAt: now,
    });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "assigned",
      actorId: userId,
      body: claim ? "Took ownership of this file." : "Released this file.",
      at: now,
    });
    return null;
  },
});

/** Re-file which rung of the ordered candidate search this person actually
 *  arrived on. The form can only ever say "public call"; a director who asked
 *  a friend to apply properly should say so, or the ordered search measures
 *  nothing. */
export const setSource = mutation({
  args: { applicationId: v.id("jobApplications"), source: sourceValidator },
  returns: v.null(),
  handler: async (ctx, { applicationId, source }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await loadApplication(ctx, applicationId);
    const now = Date.now();
    await ctx.db.patch(applicationId, { source, updatedAt: now });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "note",
      actorId: userId,
      body: `Re-filed as: ${source.replace(/_/g, " ")}.`,
      at: now,
    });
    return null;
  },
});

/** A note on the file. Notes are timeline entries, not a mutable field — what
 *  someone thought in week one is evidence, and evidence doesn't get edited. */
export const addNote = mutation({
  args: { applicationId: v.id("jobApplications"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, { applicationId, body }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await loadApplication(ctx, applicationId);
    const text = requireText(body, {
      field: "note",
      label: "A note",
      max: NOTE_MAX_LEN,
    });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "note",
      actorId: userId,
      body: text,
      at: Date.now(),
    });
    await ctx.db.patch(applicationId, { updatedAt: Date.now() });
    return null;
  },
});

/**
 * File a rubric card for one meeting or trial review.
 *
 * ONE card per reviewer per kind: a second submission REPLACES the first
 * rather than stacking, so `MIN_REVIEWS_BEFORE_DECISION` counts people, not
 * submissions — one enthusiastic director cannot become two reviewers by
 * filing twice.
 *
 * Ratings are validated key-by-key against `RUBRIC_CRITERIA` and clamped to
 * the 1–4 scale. A criterion the reviewer didn't see is simply absent, which
 * the rubric treats as "no signal" rather than a low score.
 */
export const submitReview = mutation({
  args: {
    applicationId: v.id("jobApplications"),
    kind: reviewKindValidator,
    ratings: v.record(v.string(), v.number()),
    notes: v.optional(v.string()),
    recommendation: recommendationValidator,
  },
  returns: v.null(),
  handler: async (ctx, { applicationId, kind, ratings, notes, recommendation }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await loadApplication(ctx, applicationId);

    const clean: Record<string, number> = {};
    for (const [criterion, value] of Object.entries(ratings)) {
      if (!isRubricCriterion(criterion)) {
        throw new ConvexError({
          code: "UNKNOWN_CRITERION",
          message: `"${criterion}" isn't part of the rubric.`,
        });
      }
      if (!Number.isInteger(value) || value < RUBRIC_MIN || value > RUBRIC_MAX) {
        throw new ConvexError({
          code: "INVALID_RATING",
          message: `Ratings run ${RUBRIC_MIN}–${RUBRIC_MAX}.`,
        });
      }
      clean[criterion] = value;
    }
    if (Object.keys(clean).length === 0) {
      throw new ConvexError({
        code: "EMPTY_REVIEW",
        message: "Rate at least one part of the rubric.",
      });
    }
    const text = trimmedOrUndefined(notes);
    if (text && text.length > NOTE_MAX_LEN) {
      throw new ConvexError({
        code: "NOTE_TOO_LONG",
        message: `Notes must be ${NOTE_MAX_LEN} characters or fewer.`,
      });
    }

    const now = Date.now();
    const mine = await ctx.db
      .query("applicationReviews")
      .withIndex("by_application_and_reviewer", (q) =>
        q.eq("applicationId", applicationId).eq("reviewerId", userId),
      )
      .take(APPLICATION_CHILD_LIMIT);
    const existing = mine.find((r) => r.kind === kind);

    if (existing) {
      await ctx.db.patch(existing._id, {
        ratings: clean,
        notes: text,
        recommendation,
        createdAt: now,
      });
    } else {
      await ctx.db.insert("applicationReviews", {
        applicationId,
        reviewerId: userId,
        kind,
        ratings: clean,
        ...(text ? { notes: text } : {}),
        recommendation,
        createdAt: now,
      });
    }
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "review",
      actorId: userId,
      body: `${existing ? "Updated" : "Filed"} a ${kind.replace(/_/g, " ")} review — recommends ${recommendation}.`,
      at: now,
    });
    await ctx.db.patch(applicationId, { updatedAt: now });
    return null;
  },
});

/**
 * Start the Empowerment Trial: pick the track, write the brief, move the file.
 *
 * The two due dates are computed from the track and STORED (see the schema's
 * note): a trial is a promise about specific dates, and a later change to the
 * cadence constants must not silently move one that's already running.
 */
export const startTrial = mutation({
  args: {
    applicationId: v.id("jobApplications"),
    track: trackValidator,
    brief: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { applicationId, track, brief }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await loadApplication(ctx, applicationId);

    const text = requireText(brief, {
      field: "brief",
      label: "The trial brief",
      max: TRIAL_BRIEF_MAX_LEN,
    });
    const now = Date.now();
    const { midpointDueAt, decisionDueAt } = trialDueDates(
      track as TrialTrack,
      now,
    );
    await ctx.db.patch(applicationId, {
      stage: "trial",
      stageChangedAt: now,
      trialTrack: track,
      trialStartedAt: now,
      trialMidpointDueAt: midpointDueAt,
      trialDecisionDueAt: decisionDueAt,
      trialBrief: text,
      updatedAt: now,
    });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "trial_started",
      actorId: userId,
      toStage: "trial",
      body: text,
      at: now,
    });
    return null;
  },
});

/**
 * THE CALL (step 5). Close a file with an outcome, a reason, and — unless they
 * withdrew — a message to the candidate.
 *
 * Three rules are enforced here rather than left to discipline:
 *  1. `hiring.approve`, not `hiring.edit`. The Director decides.
 *  2. A PLACEMENT needs `MIN_REVIEWS_BEFORE_DECISION` rubric cards from
 *     DIFFERENT people. Declines and not-nows deliberately don't: an
 *     application that fails the availability gate in week one shouldn't need
 *     two interviews to be answered honestly, and forcing that would make the
 *     warm no slower, which is the opposite of the doctrine.
 *  3. A `not_now` needs a revisit date. It is a promise or it is a no.
 *
 * The message is a DRAFT the caller passes in (pre-filled client-side from
 * `outcomeMessage`) — never auto-generated and sent behind their back, because
 * the one thing a templated message must not become is a form letter nobody
 * read before it went out.
 */
export const recordDecision = mutation({
  args: {
    applicationId: v.id("jobApplications"),
    outcome: outcomeValidator,
    reason: v.string(),
    revisitAt: v.optional(v.number()),
    message: v.optional(v.string()),
    sendMessage: v.boolean(),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { applicationId, outcome, reason, revisitAt, message, sendMessage },
  ) => {
    await requireHiringDecide(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const row = await loadApplication(ctx, applicationId);
    const def = HIRING_OUTCOME_DEFS[outcome as HiringOutcome];

    const why = requireText(reason, {
      field: "reason",
      label: "The reason",
      max: DECISION_REASON_MAX_LEN,
    });

    if (outcome === "placed") {
      const reviews = await ctx.db
        .query("applicationReviews")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .take(APPLICATION_CHILD_LIMIT);
      const reviewers = new Set(reviews.map((r) => String(r.reviewerId)));
      if (reviewers.size < MIN_REVIEWS_BEFORE_DECISION) {
        throw new ConvexError({
          code: "NEEDS_MORE_REVIEWS",
          message: `Placing someone takes at least ${MIN_REVIEWS_BEFORE_DECISION} people's rubric reviews — there ${reviewers.size === 1 ? "is 1" : `are ${reviewers.size}`} on this file.`,
        });
      }
    }

    if (def.requiresRevisitDate && !revisitAt) {
      throw new ConvexError({
        code: "MISSING_REVISIT_DATE",
        message:
          "A not-now needs a date you'll actually come back to it — otherwise it's a no nobody had to say.",
      });
    }

    const draft = trimmedOrUndefined(message);
    if (draft && draft.length > OUTCOME_MESSAGE_MAX_LEN) {
      throw new ConvexError({
        code: "MESSAGE_TOO_LONG",
        message: `The message must be ${OUTCOME_MESSAGE_MAX_LEN} characters or fewer.`,
      });
    }
    const willSend = sendMessage && def.messagesCandidate && !!draft;

    const now = Date.now();
    await ctx.db.patch(applicationId, {
      stage: outcome,
      stageChangedAt: now,
      outcome,
      decidedAt: now,
      decidedBy: userId,
      decisionReason: why,
      ...(revisitAt ? { revisitAt } : {}),
      updatedAt: now,
    });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "decision",
      actorId: userId,
      fromStage: row.stage,
      toStage: outcome,
      body: why,
      at: now,
    });

    if (willSend) {
      await ctx.scheduler.runAfter(0, internal.hiring.sendOutcomeMessage, {
        applicationId,
        message: draft,
      });
    }
    return null;
  },
});

/** Link this file to the person's CRM row once they're real to us — placed, or
 *  worth keeping warm. Deliberately manual: an application is not a
 *  relationship, and auto-creating a `people` row for everyone who clicks
 *  apply would quietly corrupt every roster count in the app. */
export const linkToPerson = mutation({
  args: {
    applicationId: v.id("jobApplications"),
    personId: v.union(v.id("people"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { applicationId, personId }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await loadApplication(ctx, applicationId);
    if (personId) {
      const person = await ctx.db.get(personId);
      if (!person) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That person no longer exists.",
        });
      }
    }
    const now = Date.now();
    await ctx.db.patch(applicationId, {
      personId: personId ?? undefined,
      updatedAt: now,
    });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "note",
      actorId: userId,
      body: personId ? "Linked to their person record." : "Unlinked from their person record.",
      at: now,
    });
    return null;
  },
});

// ── Internal: the two emails a candidate gets ────────────────────────────────

/** Everything an applicant email needs, or `null` if the file vanished under a
 *  scheduled send (it should degrade, not throw). */
export const getApplicantEmailPayload = internalQuery({
  args: { applicationId: v.id("jobApplications") },
  returns: v.union(
    v.null(),
    v.object({
      name: v.string(),
      email: v.string(),
      roleTitle: v.string(),
      roleSlug: v.string(),
    }),
  ),
  handler: async (ctx, { applicationId }) => {
    const row = await ctx.db.get(applicationId);
    if (!row) return null;
    return {
      name: row.name,
      email: row.email,
      roleTitle: row.roleTitle,
      roleSlug: row.roleSlug,
    };
  },
});

/**
 * "We have it, and here's what happens next."
 *
 * Sent immediately on submit, and it says exactly what the careers page says,
 * because a promise made on a page and not repeated in the only artifact the
 * candidate keeps is a promise nobody can hold us to.
 */
export const sendApplicationReceived = internalAction({
  args: { applicationId: v.id("jobApplications") },
  returns: v.null(),
  handler: async (ctx, { applicationId }) => {
    try {
      const payload = await ctx.runQuery(
        internal.hiring.getApplicantEmailPayload,
        { applicationId },
      );
      if (!payload) return null;

      const html = emailShell(`
        ${emailHeading("We've got your application")}
        ${emailParagraph(`Thanks, ${escapeHtml(payload.name.split(/\s+/)[0] || "friend")} — your application for <b>${escapeHtml(payload.roleTitle)}</b> is in, and a real person reads every one.`)}
        ${emailParagraph(`<b>What happens next.</b> You'll hear from us within ${RESPONSE_PROMISE_DAYS} days either way. If we go further, it's a conversation about you and why you want to serve, then one about the role itself. Every role here starts with an Empowerment Trial — a month or two of real, bounded work — before anything is official. Nobody gets a title before they've done the work.`)}
        ${emailParagraph("If your situation changes — your time, your church, your interest — just reply to this email and tell us. We'd rather know.")}
        ${emailButtonRow(`${siteUrl()}/careers`, "See the open roles →")}
      `);
      await sendEmail(ctx, {
        to: payload.email,
        subject: `We've got your application — ${payload.roleTitle}`,
        html,
      });
    } catch (err) {
      console.error("sendApplicationReceived: failed", applicationId, err);
    }
    return null;
  },
});

/**
 * The outcome message (step 5), as the director wrote it. Plain text from the
 * desk, wrapped in the org's email shell — deliberately NOT reformatted or
 * embellished, because the whole point is that a person wrote it.
 */
export const sendOutcomeMessage = internalAction({
  args: { applicationId: v.id("jobApplications"), message: v.string() },
  returns: v.null(),
  handler: async (ctx, { applicationId, message }) => {
    try {
      const payload = await ctx.runQuery(
        internal.hiring.getApplicantEmailPayload,
        { applicationId },
      );
      if (!payload) return null;

      const body = message
        .split(/\n{2,}/)
        .map((para) => emailParagraph(escapeHtml(para).replace(/\n/g, "<br>")))
        .join("");
      await sendEmail(ctx, {
        to: payload.email,
        subject: `About ${payload.roleTitle}`,
        html: emailShell(`${emailHeading("Public Worship")}${body}`),
      });
      await ctx.runMutation(internal.hiring.markOutcomeMessageSent, {
        applicationId,
        message,
      });
    } catch (err) {
      console.error("sendOutcomeMessage: failed", applicationId, err);
    }
    return null;
  },
});

/** Stamp the send + record it on the timeline. Separate from `recordDecision`
 *  so an unsent message (Resend down, no key configured) leaves the stamp
 *  ABSENT — a closed file with no `outcomeMessageSentAt` is the desk's "someone
 *  still owes this person an email" flag, and it would be worthless if the
 *  stamp were written optimistically at decision time. */
export const markOutcomeMessageSent = internalMutation({
  args: { applicationId: v.id("jobApplications"), message: v.string() },
  returns: v.null(),
  handler: async (ctx, { applicationId, message }) => {
    const row = await ctx.db.get(applicationId);
    if (!row) return null;
    const now = Date.now();
    await ctx.db.patch(applicationId, {
      outcomeMessageSentAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("applicationEvents", {
      applicationId,
      type: "message_sent",
      body: message,
      at: now,
    });
    return null;
  },
});
