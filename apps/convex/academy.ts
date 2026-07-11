/**
 * The Academy — per-person curriculum progress + the Training Event capstone.
 *
 * The curriculum itself (sections, article bodies, quizzes) is code
 * (ACADEMY_SECTIONS in @events-os/shared); this module stores only progress
 * and grades quizzes SERVER-SIDE against that source — a client never submits
 * a score, only its answers.
 *
 * The capstone is completed by finishing the quests inside the caller's
 * Training Event (a real, sandboxed event flagged `isTraining`). Its "passed"
 * state is DERIVED live from those quest rows in `myProgress`/`chapterProgress`
 * rather than written to `academyProgress` — computed state can't drift from
 * the event, needs no client-triggered write, and un-completes honestly if a
 * quest row is reopened.
 */
import { query, mutation, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  ACADEMY_CAPSTONE_SLUG,
  ACADEMY_SECTIONS,
  ACADEMY_SECTION_COUNT,
  DAY_MS,
  getAcademySection,
  isCompleteStatus,
  previousAcademySection,
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

/** A person's progress rows (≤ one per section), keyed by section slug. */
async function progressBySlug(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Map<string, Doc<"academyProgress">>> {
  const rows = await ctx.db
    .query("academyProgress")
    .withIndex("by_person", (q) =>
      q.eq("chapterId", chapterId).eq("personId", personId),
    )
    .collect();
  return new Map(rows.map((r) => [r.sectionSlug, r]));
}

/**
 * The caller's ACTIVE training event (isTraining, owned by them, not
 * completed/cancelled). The newest one wins if bad data ever leaves several.
 */
async function activeTrainingEventFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Doc<"events"> | null> {
  const events = await ctx.db
    .query("events")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const mine = events
    .filter(
      (e) =>
        e.isTraining === true &&
        String(e.ownerPersonId) === String(personId) &&
        e.status !== "completed" &&
        e.status !== "cancelled",
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return mine[0] ?? null;
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
 * The quest checklist of a training event: every row whose title starts with
 * "Quest:", done when its status is terminal for its module's status column
 * (the same complete rule readiness runs on).
 */
async function questsFor(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<Quest[]> {
  const items = (
    await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect()
  )
    .filter((it) => (it.title ?? "").startsWith(QUEST_TITLE_PREFIX))
    // Planning-doc quests first (their order tells the story), supplies after.
    .sort((a, b) =>
      a.module === b.module
        ? a.order - b.order
        : a.module.localeCompare(b.module),
    );

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

/** Capstone completion for a person: all quests of their training event done. */
async function capstoneComplete(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<boolean> {
  const event = await activeTrainingEventFor(ctx, chapterId, personId);
  if (!event) return false;
  const quests = await questsFor(ctx, event);
  return quests.length > 0 && quests.every((q) => q.done);
}

// ── Progress ──────────────────────────────────────────────────────────────────

/**
 * The caller's per-section progress + the overall completion count the hub's
 * path renders. `passed` is the canonical per-section flag: quiz sections pass
 * via a perfect quiz (persisted `passedAt`), the capstone via its Training
 * Event quests (derived — see module docstring). `unlocked` mirrors the
 * sequential-quiz rule submitQuiz enforces (reading is never locked).
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
        unlocked: s.order === 1,
      })),
      completed: 0,
      total: ACADEMY_SECTION_COUNT,
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
    const capstoneDone = await capstoneComplete(
      ctx,
      chapterId as Id<"chapters">,
      me,
    );

    const passedBySlug = new Map<string, boolean>();
    for (const s of ACADEMY_SECTIONS) {
      passedBySlug.set(
        s.slug,
        s.slug === ACADEMY_CAPSTONE_SLUG
          ? capstoneDone
          : bySlug.get(s.slug)?.passedAt != null,
      );
    }

    const sections = ACADEMY_SECTIONS.map((s) => {
      const row = bySlug.get(s.slug);
      const previous = previousAcademySection(s.slug);
      return {
        slug: s.slug,
        readAt: row?.readAt ?? null,
        quizBestScore: row?.quizBestScore ?? null,
        quizTotal: row?.quizTotal ?? null,
        passedAt: row?.passedAt ?? null,
        passed: passedBySlug.get(s.slug) === true,
        unlocked:
          previous == null || passedBySlug.get(previous.slug) === true,
      };
    });
    return {
      sections,
      completed: sections.filter((s) => s.passed).length,
      total: ACADEMY_SECTION_COUNT,
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
    const now = Date.now();
    // Reading the Academy makes you a roster person if you weren't one yet —
    // same resolve-or-create the event paths use.
    const me = await getOrCreateOwnerPerson(ctx, chapterId, userId, now);

    const bySlug = await progressBySlug(ctx, chapterId, me);
    const existing = bySlug.get(sectionSlug);
    if (existing) {
      if (existing.readAt == null) {
        await ctx.db.patch(existing._id, { readAt: now });
      }
      return null;
    }
    await ctx.db.insert("academyProgress", {
      chapterId,
      personId: me,
      sectionSlug,
      readAt: now,
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
        message: "This section is completed through the Training Event, not a quiz.",
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
    const me = await getOrCreateOwnerPerson(ctx, chapterId, userId, now);
    const bySlug = await progressBySlug(ctx, chapterId, me);

    // Sequential unlock: the previous section's quiz must be passed first.
    // (Reading is never gated — only completing out of order is.)
    const previous = previousAcademySection(sectionSlug);
    if (previous && bySlug.get(previous.slug)?.passedAt == null) {
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
    if (existing) {
      await ctx.db.patch(existing._id, {
        quizBestScore: Math.max(existing.quizBestScore ?? 0, score),
        quizTotal: total,
        passedAt: existing.passedAt ?? (passed ? now : undefined),
      });
    } else {
      await ctx.db.insert("academyProgress", {
        chapterId,
        personId: me,
        sectionSlug,
        quizBestScore: score,
        quizTotal: total,
        passedAt: passed ? now : undefined,
      });
    }

    return { score, total, passed, results };
  },
});

/**
 * Per-person completion counts for the chapter — "who's trained". Gated the
 * way the Team/Duties nav gates (api.org.nav's canManage): chapter admins see
 * the whole roster, managers their own subtree, everyone else gets null (the
 * hub simply doesn't render the panel).
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

    // One chapter-wide read of progress rows, grouped by person.
    const rows = await ctx.db
      .query("academyProgress")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const passedByPerson = new Map<string, number>();
    for (const r of rows) {
      if (r.passedAt == null) continue;
      const key = String(r.personId);
      passedByPerson.set(key, (passedByPerson.get(key) ?? 0) + 1);
    }

    // Capstone state in ONE pass over the chapter's events (not per person):
    // each person's newest active training event → are all its quests done?
    const allEvents = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const trainingByOwner = new Map<string, Doc<"events">>();
    for (const e of allEvents) {
      if (
        e.isTraining !== true ||
        !e.ownerPersonId ||
        e.status === "completed" ||
        e.status === "cancelled"
      )
        continue;
      const key = String(e.ownerPersonId);
      const current = trainingByOwner.get(key);
      if (!current || e.createdAt > current.createdAt) {
        trainingByOwner.set(key, e);
      }
    }

    const people = await Promise.all(
      visible.map(async (p) => {
        const quizPassed = passedByPerson.get(String(p._id)) ?? 0;
        const training = trainingByOwner.get(String(p._id));
        let capstone = false;
        if (training) {
          const quests = await questsFor(ctx, training);
          capstone = quests.length > 0 && quests.every((q) => q.done);
        }
        return {
          personId: p._id,
          name: p.name,
          completed: quizPassed + (capstone ? 1 : 0),
          total: ACADEMY_SECTION_COUNT,
        };
      }),
    );
    return {
      people: people.sort(
        (a, b) => b.completed - a.completed || a.name.localeCompare(b.name),
      ),
      total: ACADEMY_SECTION_COUNT,
    };
  },
});

// ── The Training Event capstone ───────────────────────────────────────────────

/**
 * Create (or resume) the caller's Training Event: a real event instantiated
 * from the platform training template, flagged `isTraining`, dated ~14 days
 * out so the quest offsets land in the future. Idempotent per person — an
 * existing active training event is returned instead of creating another.
 */
export const startTraining = mutation({
  args: {},
  handler: async (ctx, _args): Promise<{ eventId: Id<"events"> }> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    const me = await getOrCreateOwnerPerson(ctx, chapterId, userId, now);

    const existing = await activeTrainingEventFor(ctx, chapterId, me);
    if (existing) return { eventId: existing._id };

    // Idempotent by slug — also self-heals chapters seeded before the Academy.
    const trainingTypeId = await ensureTrainingTemplate(
      ctx,
      chapterId,
      userId,
      now,
    );
    const eventType = await ctx.db.get(trainingTypeId);

    const person = await ctx.db.get(me);
    const firstName = (person?.name ?? "Your").split(/\s+/)[0];
    const eventId = await instantiateEvent(ctx, {
      eventType,
      chapterId,
      userId,
      name: `Training: ${firstName}'s first event`,
      eventDate: now + 14 * DAY_MS,
      isTraining: true,
      now,
    });
    return { eventId };
  },
});

/**
 * The caller's training event + its live quest checklist (quests tick as the
 * rows hit terminal statuses in the real event). Null when training hasn't
 * been started.
 */
export const trainingStatus = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const userId = await requireUserId(ctx);
    const me = await getPersonForUser(
      ctx,
      chapterId as Id<"chapters">,
      userId as Id<"users">,
    );
    if (!me) return null;
    const event = await activeTrainingEventFor(
      ctx,
      chapterId as Id<"chapters">,
      me,
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
      complete: quests.length > 0 && doneCount === quests.length,
    };
  },
});
