/**
 * The Academy — per-person curriculum progress + the training-event capstones.
 *
 * The curriculum itself (sections, article bodies, quizzes) is code
 * (ACADEMY_SECTIONS in @events-os/shared); this module stores only progress
 * and grades quizzes SERVER-SIDE against that source — a client never submits
 * a score, only its answers.
 *
 * There are multiple capstones (see ACADEMY_CAPSTONE_SECTIONS), each backed by
 * its own platform training template and its own per-learner sandbox event —
 * a real event flagged `isTraining`. A capstone completes when every quest row
 * inside its sandbox is terminal. Completion is PERSISTED: `syncCapstone`
 * server-verifies the quests and stamps `passedAt` on the capstone
 * `academyProgress` row, so the pass survives the sandbox being completed or
 * cleaned up. Reads treat capstone passed as "stored passedAt OR live-derived
 * from the quest rows" — the derivation is a fallback for events finished
 * before syncing, never the only record.
 *
 * The last capstone is OPTIONAL (a bonus): it unlocks in order like any other
 * section but is excluded from completed/total ("fully trained") counts.
 */
import { query, mutation, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  ACADEMY_COURSES,
  ACADEMY_REQUIRED_SECTION_COUNT,
  ACADEMY_SECTIONS,
  ACADEMY_TRAINING_TEMPLATES,
  CORE_MODULE_KEYS,
  DAY_MS,
  DAY_OFFSET_MODULES,
  computeDueDate,
  courseForModuleSlug,
  defaultStatusValue,
  getAcademySection,
  isCompleteStatus,
  previousModuleInCourse,
  requiredModuleSlugsForCourse,
  type AcademySection,
  type AcademyTrainingKind,
  type ModuleKey,
  type SelectOption,
} from "@events-os/shared";
import {
  requireChapterId,
  requireUserId,
  getChapterIdOrNull,
} from "./lib/context";
import {
  getPersonForUser,
  getOrCreateOwnerPerson,
  instantiateEvent,
} from "./lib/templates";
import {
  ensureTrainingTemplate,
  trainingTemplateSpec,
  QUEST_TITLE_PREFIX,
} from "./lib/seed/templates";
import { statusColumnFor } from "./lib/readiness";
import {
  isChapterAdmin,
  chapterRoster,
  viewerFromRoster,
  buildChildrenOf,
  subtreeIds,
} from "./lib/org";

/** A person may hold at most this many training events PER CAPSTONE, ever
 *  (incl. cancelled). */
const TRAINING_EVENT_LIMIT = 5;

/** Workstream display order — quest checklists group modules by this, not
 *  alphabetically, so the checklist tells the story the specs authored
 *  (Tasks quests before Comms quests, Debrief last). */
const MODULE_ORDER = new Map(CORE_MODULE_KEYS.map((k, i) => [k as string, i]));

/** Throw unless `slug` names a real curriculum section. */
function requireSection(slug: string) {
  const section = getAcademySection(slug);
  if (!section) {
    throw new ConvexError({
      code: "UNKNOWN_SECTION",
      message: `"${slug}" is not an Academy section.`,
    });
  }
  return section;
}

/** Throw unless `slug` names a capstone section; returns it with its meta. */
function requireCapstoneSection(slug: string): AcademySection & {
  capstone: { kind: AcademyTrainingKind };
} {
  const section = requireSection(slug);
  if (!section.capstone) {
    throw new ConvexError({
      code: "NOT_A_CAPSTONE",
      message: `"${slug}" is not a capstone section.`,
    });
  }
  return section as AcademySection & { capstone: { kind: AcademyTrainingKind } };
}

/**
 * The caller's roster person, read-only — never inserts or claims a row.
 * markRead/submitQuiz are progress bookkeeping, not identity-binding actions,
 * so a caller with no roster row gets a friendly error instead of a silently
 * created (or claimed) `people` row.
 */
async function requirePerson(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
): Promise<Id<"people">> {
  const me = await getPersonForUser(ctx, chapterId, userId);
  if (!me) {
    throw new ConvexError({
      code: "NO_PERSON",
      message:
        "You're not on this chapter's roster yet — ask an admin to add you to the team, then come back to the Academy.",
    });
  }
  return me;
}

/** A person's progress rows (≤ one per section), keyed by section slug. */
async function progressBySlug(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Map<string, Doc<"academyProgress">>> {
  const rows = await ctx.db
    .query("academyProgress")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", chapterId).eq("personId", personId),
    )
    .collect();
  return new Map(rows.map((r) => [r.sectionSlug, r]));
}

/** The fields markRead/submitQuiz/syncCapstone may stamp on a progress row. */
type ProgressPatch = Partial<
  Pick<
    Doc<"academyProgress">,
    "readAt" | "quizBestScore" | "quizTotal" | "passedAt"
  >
>;

/** Patch the person's row for a section, or insert it — the one write path. */
async function upsertProgress(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
  sectionSlug: string,
  existing: Doc<"academyProgress"> | undefined,
  patch: ProgressPatch,
): Promise<void> {
  if (existing) {
    await ctx.db.patch(existing._id, patch);
  } else {
    await ctx.db.insert("academyProgress", {
      chapterId,
      personId,
      sectionSlug,
      ...patch,
    });
  }
}

// ── Training events ───────────────────────────────────────────────────────────

/** Whether a training event is still in flight (not completed/cancelled). */
function isActiveTrainingEvent(e: Doc<"events">): boolean {
  return (
    e.isTraining === true &&
    e.status !== "completed" &&
    e.status !== "cancelled"
  );
}

/**
 * The chapter's platform templates for EVERY capstone kind, resolved from one
 * read of the (small, per-chapter) eventTypes range — callers that need
 * several kinds (myProgress, chapterProgress) must not re-collect per kind.
 * Matched on `isPlatform && platformKey` — never on slug — so slug squatters
 * and the legacy pre-2026-07 platform template (no key) can't hijack the
 * lookup. Kinds whose template isn't seeded yet are absent from the map
 * (queries can't create templates; startTraining does).
 */
async function platformTemplateIdsFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Map<AcademyTrainingKind, Id<"eventTypes">>> {
  const types = await ctx.db
    .query("eventTypes")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const ids = new Map<AcademyTrainingKind, Id<"eventTypes">>();
  for (const kind of Object.keys(
    ACADEMY_TRAINING_TEMPLATES,
  ) as AcademyTrainingKind[]) {
    const key = ACADEMY_TRAINING_TEMPLATES[kind].templateKey;
    const match = types.find(
      (t) => t.isPlatform === true && t.platformKey === key,
    );
    if (match) ids.set(kind, match._id);
  }
  return ids;
}

/**
 * A person's training events FOR ONE CAPSTONE (by its platform template),
 * newest first — an indexed range over their owned events, never a
 * chapter-wide scan. Bounded by TRAINING_EVENT_LIMIT plus whatever real
 * events they own.
 */
async function trainingEventsFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
  templateId: Id<"eventTypes">,
): Promise<Doc<"events">[]> {
  const owned = await ctx.db
    .query("events")
    .withIndex("by_chapter_and_ownerPersonId", (q) =>
      q.eq("chapterId", chapterId).eq("ownerPersonId", personId),
    )
    .collect();
  return owned
    .filter((e) => e.isTraining === true && e.eventTypeId === templateId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The training event a person's capstone reads from: their newest
 * NON-CANCELLED one for that capstone's template. Completed events count —
 * finishing the sandbox (exactly what the curriculum teaches) must never
 * un-train the learner. Null when the capstone's template isn't seeded or no
 * sandbox exists.
 */
async function newestTrainingEventFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
  kind: AcademyTrainingKind,
): Promise<Doc<"events"> | null> {
  const templateId = (await platformTemplateIdsFor(ctx, chapterId)).get(kind);
  if (!templateId) return null;
  const mine = await trainingEventsFor(ctx, chapterId, personId, templateId);
  return mine.find((e) => e.status !== "cancelled") ?? null;
}

/** One quest row of a training event, resolved to done/not-done. */
type Quest = {
  itemId: Id<"eventItems">;
  /** Title with the "Quest:" prefix stripped for display. */
  title: string;
  module: string;
  status: string | null;
  done: boolean;
};

/**
 * The raw quest rows of a training event: every item whose title starts with
 * "Quest:", grouped by module in WORKSTREAM DISPLAY ORDER (Tasks first,
 * Debrief last — the story order the specs authored), ordered within a
 * module by row order. No status resolution — see `questsFor` for the
 * done/not-done pass.
 */
async function questRowsFor(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<Doc<"eventItems">[]> {
  const items = await ctx.db
    .query("eventItems")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .collect();
  const rank = (m: string) => MODULE_ORDER.get(m) ?? MODULE_ORDER.size;
  return items
    .filter((it) => (it.title ?? "").startsWith(QUEST_TITLE_PREFIX))
    .sort((a, b) =>
      a.module === b.module
        ? a.order - b.order
        : rank(a.module) - rank(b.module),
    );
}

/**
 * The quest checklist of a training event, each row done when its status is
 * terminal for its module's status column (the same complete rule readiness
 * runs on).
 */
async function questsFor(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<Quest[]> {
  const items = await questRowsFor(ctx, event);
  const optionsByModule = new Map<string, SelectOption[] | undefined>();
  const quests: Quest[] = [];
  for (const it of items) {
    if (!optionsByModule.has(it.module)) {
      const col = await statusColumnFor(ctx, event._id, it.module);
      optionsByModule.set(it.module, col?.options as SelectOption[] | undefined);
    }
    quests.push({
      itemId: it._id,
      title: it.title.slice(QUEST_TITLE_PREFIX.length).trim(),
      module: it.module,
      status: (it.status ?? null) as string | null,
      done: isCompleteStatus(optionsByModule.get(it.module), it.status),
    });
  }
  return quests;
}

/** A capstone's completion rule: at least one quest, and every quest done. */
function questsComplete(quests: Quest[]): boolean {
  return quests.length > 0 && quests.every((q) => q.done);
}

/**
 * Whether a capstone section is passed for a person: the stored stamp first,
 * live quest derivation as the fallback (for sandboxes finished before
 * syncCapstone ran).
 */
async function capstonePassedFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
  section: AcademySection,
  bySlug: Map<string, Doc<"academyProgress">>,
): Promise<boolean> {
  if (bySlug.get(section.slug)?.passedAt != null) return true;
  const event = await newestTrainingEventFor(
    ctx,
    chapterId,
    personId,
    section.capstone!.kind,
  );
  if (!event) return false;
  return questsComplete(await questsFor(ctx, event));
}

// ── Course completion (the earned badge) ──────────────────────────────────────

/**
 * When a person has completed a course, or null if not. Complete = every
 * REQUIRED module passed (`requiredModuleSlugsForCourse` excludes the optional
 * bonus). Quiz modules pass via stored `passedAt`; capstone modules via
 * `capstonePassedFor` (stored stamp OR live derivation). Returns the badge's
 * `earnedAt`: the max `passedAt` across the required modules. Every course has
 * at least one quiz module, so a complete course always has a real timestamp;
 * the `0` fallback (all modules live-derived, no stamp) is only a theoretical
 * guard the caller resolves with `|| Date.now()`.
 */
async function courseEarnedAt(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
  course: (typeof ACADEMY_COURSES)[number],
  bySlug: Map<string, Doc<"academyProgress">>,
): Promise<number | null> {
  const required = requiredModuleSlugsForCourse(course.slug);
  if (required.length === 0) return null; // an empty course is never "earned"
  let earnedAt = 0;
  for (const slug of required) {
    const section = getAcademySection(slug);
    if (!section) return null; // catalog invariant guarantees this can't happen
    const stamped = bySlug.get(slug)?.passedAt;
    if (stamped != null) {
      earnedAt = Math.max(earnedAt, stamped);
      continue;
    }
    if (
      section.capstone &&
      (await capstonePassedFor(ctx, chapterId, personId, section, bySlug))
    ) {
      continue; // passed (live-derived) but unstamped — contributes no timestamp
    }
    return null; // a required module isn't passed → course incomplete
  }
  return earnedAt;
}

/** The person's existing course-badge slugs (dedupe before awarding). */
async function completedCourseSlugs(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query("courseCompletions")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", chapterId).eq("personId", personId),
    )
    .collect();
  return new Set(rows.map((r) => r.courseSlug));
}

/**
 * Award ONE course's badge if it's now complete and not already held — the
 * real-time path called from submitQuiz / syncCapstone after a module passes.
 * Idempotent: a no-op when the course is incomplete or the badge already
 * exists. Returns whether a row was inserted.
 */
async function maybeAwardCourse(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
  courseSlug: string,
): Promise<boolean> {
  const course = ACADEMY_COURSES.find((c) => c.slug === courseSlug);
  if (!course) return false;
  if ((await completedCourseSlugs(ctx, chapterId, personId)).has(courseSlug)) {
    return false;
  }
  const bySlug = await progressBySlug(ctx, chapterId, personId);
  const earnedAt = await courseEarnedAt(ctx, chapterId, personId, course, bySlug);
  if (earnedAt === null) return false;
  await ctx.db.insert("courseCompletions", {
    chapterId,
    personId,
    courseSlug,
    earnedAt: earnedAt || Date.now(),
  });
  return true;
}

/**
 * Award every course the person has completed but doesn't yet hold a badge for
 * — the batch path for migration 0018's backfill. Reads the person's progress
 * once, then checks all courses. Idempotent. Returns the number awarded.
 */
export async function awardAllCourses(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<number> {
  const have = await completedCourseSlugs(ctx, chapterId, personId);
  const bySlug = await progressBySlug(ctx, chapterId, personId);
  let awarded = 0;
  for (const course of ACADEMY_COURSES) {
    if (have.has(course.slug)) continue;
    const earnedAt = await courseEarnedAt(
      ctx,
      chapterId,
      personId,
      course,
      bySlug,
    );
    if (earnedAt === null) continue;
    await ctx.db.insert("courseCompletions", {
      chapterId,
      personId,
      courseSlug: course.slug,
      earnedAt: earnedAt || Date.now(),
    });
    awarded++;
  }
  return awarded;
}

// ── Progress ──────────────────────────────────────────────────────────────────

/** A capstone's training sub-state myProgress returns (fed to the hub). */
type CapstoneTraining = {
  eventId: Id<"events">;
  started: true;
  questsDone: number;
  questsTotal: number;
  complete: boolean;
} | null;

/**
 * The caller's per-section progress + the overall completion count the hub's
 * path renders. `passed` is the canonical per-section flag: quiz sections pass
 * via a perfect quiz (persisted `passedAt`); capstones via their training
 * event's quests (stored `passedAt` stamped by syncCapstone, OR live-derived
 * as a fallback). `unlocked` mirrors the PER-COURSE sequential rule the
 * mutations enforce — a module opens once the module before it IN ITS COURSE
 * is passed, and every course's first module opens from the start; there is no
 * hard gate across courses (reading is never locked). Capstone entries carry
 * `training` — their sandbox's live quest tally — so the hub renders capstone
 * rows from this query alone. `completed`/`total` count REQUIRED sections
 * only; optional bonus sections are listed but never counted.
 *
 * `earnedCourseSlugs` is the caller's OWN course-badge slugs (one indexed read
 * of `courseCompletions` by_chapter_and_person) — the hub's earned indicator
 * reads it here rather than firing a second query per course.
 */
export const myProgress = query({
  args: {},
  handler: async (ctx) => {
    const empty = {
      sections: ACADEMY_SECTIONS.map((s) => ({
        slug: s.slug,
        readAt: null as number | null,
        quizBestScore: null as number | null,
        quizTotal: null as number | null,
        passedAt: null as number | null,
        passed: false,
        // Per-course unlock: with zero progress, every course's first module is
        // open (first-in-course → no predecessor). No global order-1 gate.
        unlocked: previousModuleInCourse(s.slug) == null,
        training: null as CapstoneTraining,
      })),
      completed: 0,
      total: ACADEMY_REQUIRED_SECTION_COUNT,
      earnedCourseSlugs: [] as string[],
    };
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return empty;
    const userId = await requireUserId(ctx);
    const me = await getPersonForUser(
      ctx,
      chapterId as Id<"chapters">,
      userId as Id<"users">,
    );
    if (!me) return empty;

    const bySlug = await progressBySlug(ctx, chapterId as Id<"chapters">, me);

    // ONE read each of the chapter's templates and the caller's owned events
    // serves every capstone below — never re-collected per kind.
    const templateIds = await platformTemplateIdsFor(
      ctx,
      chapterId as Id<"chapters">,
    );
    const ownedEvents = await ctx.db
      .query("events")
      .withIndex("by_chapter_and_ownerPersonId", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">).eq("ownerPersonId", me),
      )
      .collect();
    const sandboxFor = (kind: AcademyTrainingKind): Doc<"events"> | null => {
      const templateId = templateIds.get(kind);
      if (!templateId) return null;
      return (
        ownedEvents
          .filter(
            (e) =>
              e.isTraining === true &&
              e.eventTypeId === templateId &&
              e.status !== "cancelled",
          )
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
      );
    };

    // Resolve passed per section IN CURRICULUM ORDER — a capstone's unlock
    // depends on the module before it IN ITS COURSE, which for the capstones
    // (owning-an-event) is being-an-owner then the prior capstone; both sit
    // earlier in curriculum order, so they're already resolved when we get here.
    const passedBySlug = new Map<string, boolean>();
    const trainingBySlug = new Map<string, CapstoneTraining>();
    for (const s of ACADEMY_SECTIONS) {
      if (!s.capstone) {
        passedBySlug.set(s.slug, bySlug.get(s.slug)?.passedAt != null);
        continue;
      }
      const storedPass = bySlug.get(s.slug)?.passedAt != null;
      const previousSlug = previousModuleInCourse(s.slug);
      const unlockedNow =
        previousSlug == null || passedBySlug.get(previousSlug) === true;

      // Short-circuits: a still-locked (and unpassed) capstone can't have a
      // sandbox, so no quest reads at all; a stored pass settles `passed`
      // without deriving quest statuses.
      let training: CapstoneTraining = null;
      let passed = storedPass;
      if (storedPass || unlockedNow) {
        const event = sandboxFor(s.capstone.kind);
        if (event) {
          if (storedPass) {
            const rows = await questRowsFor(ctx, event);
            training = {
              eventId: event._id,
              started: true,
              questsDone: rows.length,
              questsTotal: rows.length,
              complete: true,
            };
          } else {
            const quests = await questsFor(ctx, event);
            const complete = questsComplete(quests);
            training = {
              eventId: event._id,
              started: true,
              questsDone: quests.filter((q) => q.done).length,
              questsTotal: quests.length,
              complete,
            };
            passed = complete;
          }
        }
      }
      passedBySlug.set(s.slug, passed);
      trainingBySlug.set(s.slug, training);
    }

    const sections = ACADEMY_SECTIONS.map((s) => {
      const row = bySlug.get(s.slug);
      const previousSlug = previousModuleInCourse(s.slug);
      return {
        slug: s.slug,
        readAt: row?.readAt ?? null,
        quizBestScore: row?.quizBestScore ?? null,
        quizTotal: row?.quizTotal ?? null,
        passedAt: row?.passedAt ?? null,
        passed: passedBySlug.get(s.slug) === true,
        // Per-course: unlocked once the module before it IN ITS COURSE is
        // passed, or when it's first-in-course. A module you already passed is
        // always unlocked — a mid-course INSERT (a new, unpassed predecessor)
        // must never re-lock a module people already finished. Mirrors
        // submitQuiz's `storedPass || unlockedNow`.
        unlocked:
          passedBySlug.get(s.slug) === true ||
          previousSlug == null ||
          passedBySlug.get(previousSlug) === true,
        training: trainingBySlug.get(s.slug) ?? null,
      };
    });
    const completed = ACADEMY_SECTIONS.filter(
      (s) => s.optional !== true && passedBySlug.get(s.slug) === true,
    ).length;
    // The caller's own earned course badges — one indexed read, so the hub's
    // per-course "earned" indicator needs no second query.
    const earnedCourseSlugs = [
      ...(await completedCourseSlugs(ctx, chapterId as Id<"chapters">, me)),
    ];
    return {
      sections,
      completed,
      total: ACADEMY_REQUIRED_SECTION_COUNT,
      earnedCourseSlugs,
    };
  },
});

/** Record that the caller opened a section's article (first open wins). */
export const markRead = mutation({
  args: { sectionSlug: v.string() },
  handler: async (ctx, { sectionSlug }) => {
    requireSection(sectionSlug);
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const me = await requirePerson(ctx, chapterId, userId);

    const existing = (await progressBySlug(ctx, chapterId, me)).get(
      sectionSlug,
    );
    if (existing?.readAt != null) return null;
    await upsertProgress(ctx, chapterId, me, sectionSlug, existing, {
      readAt: Date.now(),
    });
    return null;
  },
});

/**
 * Grade a quiz attempt SERVER-SIDE against ACADEMY_SECTIONS — the client sends
 * answer indexes, never a score. Retakes are allowed and keep the best score;
 * `passedAt` is set the first time an attempt is perfect and never cleared.
 * Returns per-question correctness + the teaching explanation (and the correct
 * index — the quizzes teach, they don't gatekeep). Quizzes unlock sequentially:
 * a section's quiz opens once the previous section's quiz is passed.
 */
export const submitQuiz = mutation({
  args: { sectionSlug: v.string(), answers: v.array(v.number()) },
  handler: async (ctx, { sectionSlug, answers }) => {
    const section = requireSection(sectionSlug);
    if (section.quiz.length === 0) {
      throw new ConvexError({
        code: "NO_QUIZ",
        message:
          "This section is completed through its training event, not a quiz.",
      });
    }
    if (answers.length !== section.quiz.length) {
      throw new ConvexError({
        code: "BAD_ANSWERS",
        message: `Expected ${section.quiz.length} answers, got ${answers.length}.`,
      });
    }
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    const me = await requirePerson(ctx, chapterId, userId);
    const bySlug = await progressBySlug(ctx, chapterId, me);

    // Per-course sequential unlock: the previous module IN THIS COURSE must be
    // passed first; a module that's first-in-its-course opens immediately (no
    // hard gate across courses). Reading is never gated — only completing out
    // of order is. Every quiz module's course-predecessor is itself a quiz
    // module, so the stored stamp is the whole answer here. A module the caller
    // ALREADY passed stays open for retakes even when its predecessor is unpassed.
    const previousSlug = previousModuleInCourse(sectionSlug);
    const previous = previousSlug ? getAcademySection(previousSlug) : undefined;
    const alreadyPassed = bySlug.get(sectionSlug)?.passedAt != null;
    if (
      !alreadyPassed &&
      previous &&
      bySlug.get(previous.slug)?.passedAt == null
    ) {
      throw new ConvexError({
        code: "QUIZ_LOCKED",
        message: `Pass "${previous.title}" first — sections complete in order.`,
      });
    }

    const results = section.quiz.map((q, i) => ({
      correct: answers[i] === q.answerIndex,
      correctIndex: q.answerIndex,
      explanation: q.explanation,
    }));
    const score = results.filter((r) => r.correct).length;
    const total = section.quiz.length;
    const passed = score === total;

    const existing = bySlug.get(sectionSlug);
    const newlyPassed = passed && existing?.passedAt == null;
    await upsertProgress(ctx, chapterId, me, sectionSlug, existing, {
      quizBestScore: Math.max(existing?.quizBestScore ?? 0, score),
      quizTotal: total,
      passedAt: existing?.passedAt ?? (passed ? now : undefined),
    });

    // A newly-passed module may be the last one its course needed → award the
    // badge. Only the module's own course can complete from this pass.
    if (newlyPassed) {
      const course = courseForModuleSlug(sectionSlug);
      if (course) await maybeAwardCourse(ctx, chapterId, me, course.slug);
    }

    return { score, total, passed, results };
  },
});

/**
 * Persist a capstone: resolve the caller's newest non-cancelled training
 * event for that capstone, server-verify every quest terminal, and stamp
 * `passedAt` on the capstone progress row. Idempotent — an already-stamped
 * row is left alone — and a no-op (`passed: false`) while the quests aren't
 * done. The client calls this when the checklist completes; the stored stamp
 * is what keeps a learner trained after their sandbox is completed or deleted.
 */
export const syncCapstone = mutation({
  args: { capstoneSlug: v.string() },
  handler: async (ctx, { capstoneSlug }) => {
    const section = requireCapstoneSection(capstoneSlug);
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const me = await getPersonForUser(ctx, chapterId, userId);
    if (!me) return { passed: false }; // no roster row → nothing to sync

    const existing = (await progressBySlug(ctx, chapterId, me)).get(
      section.slug,
    );
    if (existing?.passedAt != null) return { passed: true };

    const event = await newestTrainingEventFor(
      ctx,
      chapterId,
      me,
      section.capstone.kind,
    );
    if (!event) return { passed: false };
    const quests = await questsFor(ctx, event);
    if (!questsComplete(quests)) return { passed: false };

    await upsertProgress(ctx, chapterId, me, section.slug, existing, {
      passedAt: Date.now(),
    });

    // The capstone that just passed may complete its course (Owning an event).
    const course = courseForModuleSlug(section.slug);
    if (course) await maybeAwardCourse(ctx, chapterId, me, course.slug);

    return { passed: true };
  },
});

/**
 * Per-person completion counts for the chapter — "who's trained". Gated the
 * way the Team/Duties nav gates (api.org.nav's canManage): chapter admins see
 * the whole roster, managers their own subtree, everyone else gets null (the
 * hub simply doesn't render the panel). Counts REQUIRED sections only —
 * the optional bonus capstone never inflates anyone's number.
 */
export const chapterProgress = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const isAdmin = await isChapterAdmin(ctx, chapterId as Id<"chapters">);
    const roster = await chapterRoster(ctx, chapterId as Id<"chapters">);
    const childrenOf = buildChildrenOf(roster);
    const viewer = await viewerFromRoster(ctx, roster);
    const hasReports =
      viewer != null && (childrenOf.get(viewer._id) ?? []).length > 0;
    if (!isAdmin && !hasReports) return null;

    const visible = isAdmin
      ? roster
      : roster.filter((p) => subtreeIds(childrenOf, viewer!).has(p._id));

    // One chapter-wide read of progress rows, grouped by person. Only
    // REQUIRED slugs in the CURRENT curriculum count — rows stranded by a
    // renamed section (or the optional bonus) must not inflate anyone.
    const requiredSections = ACADEMY_SECTIONS.filter(
      (s) => s.optional !== true,
    );
    const requiredQuizSlugs = new Set(
      requiredSections.filter((s) => !s.capstone).map((s) => s.slug),
    );
    const requiredCapstones = requiredSections.filter((s) => s.capstone);
    const requiredCapstoneSlugs = new Set(requiredCapstones.map((s) => s.slug));
    const rows = await ctx.db
      .query("academyProgress")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const quizPassedByPerson = new Map<string, number>();
    // person → set of stored-passed capstone slugs
    const capstoneStored = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.passedAt == null) continue;
      const key = String(r.personId);
      if (requiredCapstoneSlugs.has(r.sectionSlug)) {
        const set = capstoneStored.get(key) ?? new Set<string>();
        set.add(r.sectionSlug);
        capstoneStored.set(key, set);
      } else if (requiredQuizSlugs.has(r.sectionSlug)) {
        quizPassedByPerson.set(key, (quizPassedByPerson.get(key) ?? 0) + 1);
      }
    }

    // Map each required capstone to its platform template, then find each
    // person's newest non-cancelled training event PER capstone in ONE pass
    // over the chapter's events — the live-derivation fallback for people
    // whose quests finished before syncCapstone stamped them.
    const templateIds = await platformTemplateIdsFor(
      ctx,
      chapterId as Id<"chapters">,
    );
    const capstoneByTemplateId = new Map<string, string>(); // templateId → slug
    for (const s of requiredCapstones) {
      const templateId = templateIds.get(s.capstone!.kind);
      if (templateId) capstoneByTemplateId.set(String(templateId), s.slug);
    }
    const allEvents = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    // `${personId}:${capstoneSlug}` → newest training event
    const trainingByOwnerCapstone = new Map<string, Doc<"events">>();
    for (const e of allEvents) {
      if (e.isTraining !== true || !e.ownerPersonId || e.status === "cancelled")
        continue;
      const slug = capstoneByTemplateId.get(String(e.eventTypeId));
      if (!slug) continue;
      const key = `${String(e.ownerPersonId)}:${slug}`;
      const current = trainingByOwnerCapstone.get(key);
      if (!current || e.createdAt > current.createdAt) {
        trainingByOwnerCapstone.set(key, e);
      }
    }

    const people = await Promise.all(
      visible.map(async (p) => {
        const key = String(p._id);
        const quizPassed = quizPassedByPerson.get(key) ?? 0;
        const stored = capstoneStored.get(key) ?? new Set<string>();
        // Stored capstone stamps first; quest derivation only for the (few)
        // visible people who lack one but do have a training event.
        let capstonesPassed = 0;
        for (const s of requiredCapstones) {
          if (stored.has(s.slug)) {
            capstonesPassed++;
            continue;
          }
          const training = trainingByOwnerCapstone.get(`${key}:${s.slug}`);
          if (training && questsComplete(await questsFor(ctx, training))) {
            capstonesPassed++;
          }
        }
        return {
          personId: p._id,
          name: p.name,
          completed: Math.min(
            quizPassed + capstonesPassed,
            ACADEMY_REQUIRED_SECTION_COUNT,
          ),
          total: ACADEMY_REQUIRED_SECTION_COUNT,
        };
      }),
    );
    return {
      people: people.sort(
        (a, b) => b.completed - a.completed || a.name.localeCompare(b.name),
      ),
      total: ACADEMY_REQUIRED_SECTION_COUNT,
    };
  },
});

/**
 * Everyone in the chapter who has earned a given course's badge — the course
 * page's completer list. Chapter-visible (decision D4): any chapter member can
 * see who completed a course, unlike the manager-gated aggregate panel
 * (`chapterProgress`). Returns null when the caller has no chapter; oldest
 * completion first.
 */
export const courseCompleters = query({
  args: { courseSlug: v.string() },
  handler: async (ctx, { courseSlug }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const rows = await ctx.db
      .query("courseCompletions")
      .withIndex("by_chapter_and_course", (q) =>
        q
          .eq("chapterId", chapterId as Id<"chapters">)
          .eq("courseSlug", courseSlug),
      )
      .collect();
    const people = await Promise.all(
      rows.map(async (r) => {
        const p = await ctx.db.get(r.personId);
        return p
          ? {
              personId: p._id,
              name: p.name,
              imageUrl: p.image ? await ctx.storage.getUrl(p.image) : null,
              earnedAt: r.earnedAt,
            }
          : null;
      }),
    );
    return people
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.earnedAt - b.earnedAt || a.name.localeCompare(b.name));
  },
});

/**
 * Team-only training roster for a course, WITH the untrained state — the
 * compact grid on the course page (owner report, 2026-07-18): the finances
 * course's completer list was showing every chapter person (team, volunteer,
 * vendor alike) in a growing vertical list with no way to see who HASN'T
 * trained. Unlike `courseCompleters` above (chapter-visible, decision D4,
 * completers-only — left untouched; `academy/path/[seatSlug].tsx` still
 * consumes it as-is), this is:
 *  - scoped to TEAM members only, same `isSamplePerson !== true &&
 *    (isTeamMember === true || userId != null)` predicate `people.
 *    teamMembers` uses (a team member is who's actually expected to record
 *    transactions — a volunteer/vendor completing the course is real but not
 *    what this roster is triaging);
 *  - server-filtered rather than client-joined against `courseCompleters`
 *    (a chapter's team can be large, and this returns everyone whether or
 *    not they've trained — no reason to ship two full people scans to the
 *    client to reconcile).
 * Returns `null` when the caller has no chapter (mirrors `courseCompleters`).
 */
export const courseTeamTrainingRoster = query({
  args: { courseSlug: v.string() },
  handler: async (ctx, { courseSlug }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    const team = people.filter(
      (p) => p.isSamplePerson !== true && (p.isTeamMember === true || p.userId != null),
    );
    const completions = await ctx.db
      .query("courseCompletions")
      .withIndex("by_chapter_and_course", (q) =>
        q
          .eq("chapterId", chapterId as Id<"chapters">)
          .eq("courseSlug", courseSlug),
      )
      .collect();
    const trainedIds = new Set(completions.map((c) => String(c.personId)));
    return await Promise.all(
      team
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (p) => ({
          personId: p._id,
          name: p.name,
          imageUrl: p.image ? await ctx.storage.getUrl(p.image) : null,
          trained: trainedIds.has(String(p._id)),
        })),
    );
  },
});

/**
 * A person's earned course badges (slug + earnedAt), newest first — the chips
 * on their profile. Scoped to the caller's chapter, so it only returns badges
 * for someone on the caller's roster. Course titles/levels live in the shared
 * catalog (ACADEMY_COURSES); the client resolves them from the slug.
 */
export const personBadges = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const rows = await ctx.db
      .query("courseCompletions")
      .withIndex("by_chapter_and_person", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">).eq("personId", personId),
      )
      .collect();
    return rows
      .map((r) => ({ courseSlug: r.courseSlug, earnedAt: r.earnedAt }))
      .sort((a, b) => b.earnedAt - a.earnedAt);
  },
});

// ── The training-event capstones ──────────────────────────────────────────────

/**
 * Re-seed an existing training event's missing rows from its template — the
 * self-heal for a sandbox whose quest rows were deleted. Restores EVERY
 * template row with no surviving clone (matched by sourceTemplateItemId),
 * not just quests: the join-event sandbox's scenery rows are load-bearing
 * (quests send the learner to read call times off the Run of Show, duties
 * off Crew Duties), so a quest-only heal would restore a pedagogically
 * broken sandbox. Same cloning rules as instantiateEvent: due dates
 * back-calculated from the event date, roleIds remapped template-role →
 * event-role by role key.
 */
async function reseedMissingRows(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<void> {
  const existing = await ctx.db
    .query("eventItems")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .collect();
  const clonedFrom = new Set(
    existing
      .map((it) => (it.sourceTemplateItemId ? String(it.sourceTemplateItemId) : null))
      .filter((v): v is string => v != null),
  );
  // A spec-version refresh WIPES the template's rows, so a sandbox cloned
  // from the previous version points at ids that no longer exist and the
  // id match above would reinsert the entire new row set on top of the
  // surviving old rows. The (module, title) key catches those survivors —
  // NUL-separated so a crafted title can't collide across the boundary.
  const existingKeys = new Set(
    existing.map((it) => `${it.module}\u0000${it.title}`),
  );
  const questItems = (
    await ctx.db
      .query("templateItems")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", event.eventTypeId))
      .collect()
  ).filter(
    (it) =>
      !clonedFrom.has(String(it._id)) &&
      !existingKeys.has(`${it.module}\u0000${it.title}`),
  );
  if (questItems.length === 0) return;

  const [templateRoles, eventRoles] = await Promise.all([
    ctx.db
      .query("templateRoles")
      .withIndex("by_template", (q) => q.eq("eventTypeId", event.eventTypeId))
      .collect(),
    ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect(),
  ]);
  const roleKeyById = new Map(templateRoles.map((r) => [String(r._id), r.key]));
  const eventRoleByKey = new Map(eventRoles.map((r) => [r.key, r._id]));

  for (const it of questItems) {
    const roleKey = it.roleId ? roleKeyById.get(String(it.roleId)) : undefined;
    await ctx.db.insert("eventItems", {
      eventId: event._id,
      chapterId: event.chapterId,
      sourceTemplateItemId: it._id,
      module: it.module,
      title: it.title,
      order: it.order,
      offsetDays: it.offsetDays,
      offsetMinutes: it.offsetMinutes,
      dueDate:
        DAY_OFFSET_MODULES.includes(it.module as ModuleKey) &&
        it.offsetDays !== undefined
          ? computeDueDate(event.eventDate, it.offsetDays)
          : undefined,
      roleId: roleKey ? eventRoleByKey.get(roleKey) : undefined,
      status: it.status ?? defaultStatusValue(it.module as ModuleKey),
      prePlanColumns: it.prePlanColumns,
      fields: it.fields,
    });
  }
}

/**
 * Ensure a capstone's sample teammates (spec.sampleTeammates) exist on the
 * chapter roster, flagged `isSamplePerson`: excluded from every operational
 * surface (People roster, chapterRoster views, real events' pickers) but
 * offered by sandbox-scoped pickers — exactly where the role quests need
 * them. Deliberately NOT `isPlaceholder`: replacing a placeholder crew slot
 * with a sample person must CLEAR the placeholder debt (and a later
 * re-replace must never garbage-collect the shared bench row). Reused by
 * name across learners — one Maya per chapter, not one per run; legacy rows
 * from earlier releases are healed onto the new flags.
 */
async function ensureSampleTeammates(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  now: number,
  seeds: { name: string; role: string }[],
): Promise<void> {
  if (seeds.length === 0) return;
  const people = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  for (const seed of seeds) {
    const existing = people.find(
      (p) =>
        p.name === seed.name &&
        (p.isSamplePerson === true ||
          p.isPlaceholder === true ||
          p.isTeamMember === true),
    );
    if (existing) {
      // Heal rows created by earlier releases (placeholder and/or
      // isTeamMember variants) onto the sample-person shape.
      if (
        existing.isSamplePerson !== true ||
        existing.isPlaceholder === true ||
        existing.isTeamMember === true
      ) {
        await ctx.db.patch(existing._id, {
          isSamplePerson: true,
          isPlaceholder: undefined,
          isTeamMember: undefined,
        });
      }
      continue;
    }
    await ctx.db.insert("people", {
      chapterId,
      name: seed.name,
      role: seed.role,
      isSamplePerson: true,
      status: "active",
      createdAt: now,
    });
  }
}

/**
 * Create (or resume) the caller's training event for one capstone: a real
 * event instantiated from that capstone's platform template, flagged
 * `isTraining`, dated ~14 days out so the quest offsets land in the future.
 *
 * Server-side rules:
 *  - CAPSTONE_LOCKED — the section before this capstone must be passed first
 *    (the same sequential rule submitQuiz enforces; a preceding capstone
 *    counts as passed via its stored stamp OR live quest completion).
 *  - Idempotent per person PER CAPSTONE: the newest NON-CANCELLED training
 *    event is returned, completed ones included (the capstone stamp
 *    survives) — a new sandbox is only minted when none exists or all were
 *    cancelled. An active sandbox whose quest rows were deleted gets them
 *    re-seeded.
 *  - TRAINING_LIMIT — at most 5 training events ever per person per capstone.
 */
export const startTraining = mutation({
  args: { capstoneSlug: v.string() },
  handler: async (
    ctx,
    { capstoneSlug },
  ): Promise<{ eventId: Id<"events"> }> => {
    const section = requireCapstoneSection(capstoneSlug);
    const kind = section.capstone.kind;
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    // Starting training genuinely makes you an event owner — the one Academy
    // path where resolve-or-create is the right person lookup.
    const me = await getOrCreateOwnerPerson(ctx, chapterId, userId, now);

    // The capstone unlocks per-course: the previous module IN ITS COURSE must
    // be passed (owning-an-event order: being-an-owner → capstone-join →
    // capstone-birthday → capstone-worship). A quiz predecessor (being-an-owner)
    // passes via its stored stamp; a preceding capstone via stamp OR live quest
    // completion. First-in-course would open immediately, but every capstone has
    // a predecessor within owning-an-event, so `previous` is always set here.
    const bySlug = await progressBySlug(ctx, chapterId, me);
    const previousSlug = previousModuleInCourse(section.slug);
    const previous = previousSlug ? getAcademySection(previousSlug) : undefined;
    if (previous) {
      const previousPassed = previous.capstone
        ? await capstonePassedFor(ctx, chapterId, me, previous, bySlug)
        : bySlug.get(previous.slug)?.passedAt != null;
      if (!previousPassed) {
        throw new ConvexError({
          code: "CAPSTONE_LOCKED",
          message: `Pass "${previous.title}" first — sections complete in order.`,
        });
      }
    }

    // Idempotent platform-template lookup — also self-heals chapters seeded
    // before this capstone existed.
    const trainingTypeId = await ensureTrainingTemplate(
      ctx,
      chapterId,
      userId,
      now,
      kind,
    );

    // Sample teammates the capstone's role quests assign (if the spec has
    // any). Runs on RESUME too — it also heals bench rows created by earlier
    // releases onto the current flags.
    const spec = trainingTemplateSpec(kind);
    await ensureSampleTeammates(ctx, chapterId, now, spec.sampleTeammates ?? []);

    const mine = await trainingEventsFor(ctx, chapterId, me, trainingTypeId);
    const existing = mine.find((e) => e.status !== "cancelled");
    if (existing) {
      // Self-heal an in-flight sandbox whose quest rows are gone.
      if (
        isActiveTrainingEvent(existing) &&
        (await questRowsFor(ctx, existing)).length === 0
      ) {
        await reseedMissingRows(ctx, existing);
      }
      return { eventId: existing._id };
    }
    if (mine.length >= TRAINING_EVENT_LIMIT) {
      throw new ConvexError({
        code: "TRAINING_LIMIT",
        message:
          "You've reached the training-run limit for this capstone — your progress is already saved.",
      });
    }

    const eventType = await ctx.db.get(trainingTypeId);
    const person = await ctx.db.get(me);
    const firstName = (person?.name ?? "Your").split(/\s+/)[0];
    const eventId = await instantiateEvent(ctx, {
      eventType,
      chapterId,
      userId,
      name: spec.eventName(firstName),
      // Horizons scale with the event — the join sandbox sits a month out,
      // the party/pop-up sandboxes at the ~2-week planning floor.
      eventDate: now + spec.eventDaysOut * DAY_MS,
      isTraining: true,
      now,
    });
    return { eventId };
  },
});

/**
 * The caller's training event for one capstone + its live quest checklist
 * (quests tick as the rows hit terminal statuses in the real event). Reads
 * the newest non-cancelled sandbox — completing the event keeps the checklist
 * (and the pass) visible. Null when that capstone's training hasn't started.
 */
export const trainingStatus = query({
  args: { capstoneSlug: v.string() },
  handler: async (ctx, { capstoneSlug }) => {
    const section = requireCapstoneSection(capstoneSlug);
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const userId = await requireUserId(ctx);
    const me = await getPersonForUser(
      ctx,
      chapterId as Id<"chapters">,
      userId as Id<"users">,
    );
    if (!me) return null;
    const event = await newestTrainingEventFor(
      ctx,
      chapterId as Id<"chapters">,
      me,
      section.capstone.kind,
    );
    if (!event) return null;
    const quests = await questsFor(ctx, event);
    const doneCount = quests.filter((q) => q.done).length;
    return {
      eventId: event._id,
      name: event.name,
      eventDate: event.eventDate,
      quests,
      doneCount,
      total: quests.length,
      complete: questsComplete(quests),
    };
  },
});
