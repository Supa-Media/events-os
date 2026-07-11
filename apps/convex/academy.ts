/**
 * The Academy — per-person curriculum progress + the Training Event capstone.
 *
 * The curriculum itself (sections, article bodies, quizzes) is code
 * (ACADEMY_SECTIONS in @events-os/shared); this module stores only progress
 * and grades quizzes SERVER-SIDE against that source — a client never submits
 * a score, only its answers.
 *
 * The capstone is completed by finishing the quests inside the caller's
 * Training Event (a real, sandboxed event flagged `isTraining`). Completion is
 * PERSISTED: `syncCapstone` server-verifies every quest terminal and stamps
 * `passedAt` on the capstone `academyProgress` row, so the pass survives the
 * sandbox being completed or cleaned up. Reads treat capstone passed as
 * "stored passedAt OR live-derived from the quest rows" — the derivation is a
 * fallback for events finished before syncing, never the only record.
 */
import { query, mutation, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  ACADEMY_CAPSTONE_SLUG,
  ACADEMY_SECTIONS,
  ACADEMY_SECTION_COUNT,
  DAY_MS,
  DAY_OFFSET_MODULES,
  computeDueDate,
  defaultStatusValue,
  getAcademySection,
  isCompleteStatus,
  previousAcademySection,
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

/** A person may hold at most this many training events, ever (incl. cancelled). */
const TRAINING_EVENT_LIMIT = 5;

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
 * A person's training events, newest first — an indexed range over their
 * owned events (never a chapter-wide scan). Bounded by TRAINING_EVENT_LIMIT
 * plus whatever real events they own.
 */
async function trainingEventsFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Doc<"events">[]> {
  const owned = await ctx.db
    .query("events")
    .withIndex("by_chapter_and_ownerPersonId", (q) =>
      q.eq("chapterId", chapterId).eq("ownerPersonId", personId),
    )
    .collect();
  return owned
    .filter((e) => e.isTraining === true)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The training event a person's capstone reads from: their newest
 * NON-CANCELLED one. Completed events count — finishing the sandbox (exactly
 * what the curriculum teaches) must never un-train the learner.
 */
async function newestTrainingEventFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Doc<"events"> | null> {
  const mine = await trainingEventsFor(ctx, chapterId, personId);
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
 * "Quest:", planning-doc quests first (their order tells the story), supplies
 * after. No status resolution — see `questsFor` for the done/not-done pass.
 */
async function questRowsFor(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<Doc<"eventItems">[]> {
  const items = await ctx.db
    .query("eventItems")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .collect();
  return items
    .filter((it) => (it.title ?? "").startsWith(QUEST_TITLE_PREFIX))
    .sort((a, b) =>
      a.module === b.module
        ? a.order - b.order
        : a.module.localeCompare(b.module),
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

/** The capstone's completion rule: at least one quest, and every quest done. */
function questsComplete(quests: Quest[]): boolean {
  return quests.length > 0 && quests.every((q) => q.done);
}

// ── Progress ──────────────────────────────────────────────────────────────────

/** The capstone's training sub-state myProgress returns (fix for the hub). */
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
 * via a perfect quiz (persisted `passedAt`), the capstone via its Training
 * Event quests (stored `passedAt` stamped by syncCapstone, OR live-derived as
 * a fallback). `unlocked` mirrors the sequential-quiz rule submitQuiz
 * enforces (reading is never locked). The capstone entry additionally carries
 * `training` — its sandbox's live quest tally — so the hub can render the
 * capstone row from this query alone.
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
        training: null as CapstoneTraining,
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

    const storedPass =
      bySlug.get(ACADEMY_CAPSTONE_SLUG)?.passedAt != null;
    const beforeCapstone = previousAcademySection(ACADEMY_CAPSTONE_SLUG);
    const capstoneUnlocked =
      beforeCapstone == null ||
      bySlug.get(beforeCapstone.slug)?.passedAt != null;

    // Capstone training state. Short-circuits: a still-locked (and unpassed)
    // capstone can't have a sandbox, so no event reads at all; a stored pass
    // settles `passed` without deriving quest statuses.
    let training: CapstoneTraining = null;
    let capstonePassed = storedPass;
    if (storedPass || capstoneUnlocked) {
      const event = await newestTrainingEventFor(
        ctx,
        chapterId as Id<"chapters">,
        me,
      );
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
          capstonePassed = complete;
        }
      }
    }

    const passedBySlug = new Map<string, boolean>();
    for (const s of ACADEMY_SECTIONS) {
      passedBySlug.set(
        s.slug,
        s.slug === ACADEMY_CAPSTONE_SLUG
          ? capstonePassed
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
        training: s.slug === ACADEMY_CAPSTONE_SLUG ? training : null,
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
    const me = await requirePerson(ctx, chapterId, userId);
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
    await upsertProgress(ctx, chapterId, me, sectionSlug, existing, {
      quizBestScore: Math.max(existing?.quizBestScore ?? 0, score),
      quizTotal: total,
      passedAt: existing?.passedAt ?? (passed ? now : undefined),
    });

    return { score, total, passed, results };
  },
});

/**
 * Persist the capstone: resolve the caller's newest non-cancelled training
 * event, server-verify every quest terminal, and stamp `passedAt` on the
 * capstone progress row. Idempotent — an already-stamped row is left alone —
 * and a no-op (`passed: false`) while the quests aren't done. The client
 * calls this when the checklist completes; the stored stamp is what keeps a
 * learner trained after their sandbox is completed or deleted.
 */
export const syncCapstone = mutation({
  args: {},
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const me = await getPersonForUser(ctx, chapterId, userId);
    if (!me) return { passed: false }; // no roster row → nothing to sync

    const existing = (await progressBySlug(ctx, chapterId, me)).get(
      ACADEMY_CAPSTONE_SLUG,
    );
    if (existing?.passedAt != null) return { passed: true };

    const event = await newestTrainingEventFor(ctx, chapterId, me);
    if (!event) return { passed: false };
    const quests = await questsFor(ctx, event);
    if (!questsComplete(quests)) return { passed: false };

    await upsertProgress(ctx, chapterId, me, ACADEMY_CAPSTONE_SLUG, existing, {
      passedAt: Date.now(),
    });
    return { passed: true };
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

    // One chapter-wide read of progress rows, grouped by person. Only slugs
    // in the CURRENT curriculum count — rows stranded by a renamed section
    // must not inflate anyone past the real total.
    const currentSlugs = new Set(ACADEMY_SECTIONS.map((s) => s.slug));
    const rows = await ctx.db
      .query("academyProgress")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const quizPassedByPerson = new Map<string, number>();
    const capstoneStored = new Set<string>();
    for (const r of rows) {
      if (r.passedAt == null || !currentSlugs.has(r.sectionSlug)) continue;
      const key = String(r.personId);
      if (r.sectionSlug === ACADEMY_CAPSTONE_SLUG) {
        capstoneStored.add(key);
      } else {
        quizPassedByPerson.set(key, (quizPassedByPerson.get(key) ?? 0) + 1);
      }
    }

    // Each person's newest non-cancelled training event, in ONE pass over the
    // chapter's events — the live-derivation fallback for people whose quests
    // finished before syncCapstone stamped them.
    const allEvents = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const trainingByOwner = new Map<string, Doc<"events">>();
    for (const e of allEvents) {
      if (e.isTraining !== true || !e.ownerPersonId || e.status === "cancelled")
        continue;
      const key = String(e.ownerPersonId);
      const current = trainingByOwner.get(key);
      if (!current || e.createdAt > current.createdAt) {
        trainingByOwner.set(key, e);
      }
    }

    const people = await Promise.all(
      visible.map(async (p) => {
        const key = String(p._id);
        const quizPassed = quizPassedByPerson.get(key) ?? 0;
        // Stored capstone stamps first; quest derivation only for the (few)
        // visible people who lack one but do have a training event.
        let capstone = capstoneStored.has(key);
        if (!capstone) {
          const training = trainingByOwner.get(key);
          if (training) capstone = questsComplete(await questsFor(ctx, training));
        }
        return {
          personId: p._id,
          name: p.name,
          completed: Math.min(
            quizPassed + (capstone ? 1 : 0),
            ACADEMY_SECTION_COUNT,
          ),
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
 * Re-seed the quest rows of an existing training event from its template —
 * the self-heal for a sandbox whose quest rows were deleted. Same cloning
 * rules as instantiateEvent: due dates back-calculated from the event date,
 * roleIds remapped template-role → event-role by role key.
 */
async function reseedQuestRows(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<void> {
  const questItems = (
    await ctx.db
      .query("templateItems")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", event.eventTypeId))
      .collect()
  ).filter((it) => (it.title ?? "").startsWith(QUEST_TITLE_PREFIX));
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
 * Create (or resume) the caller's Training Event: a real event instantiated
 * from the platform training template, flagged `isTraining`, dated ~14 days
 * out so the quest offsets land in the future.
 *
 * Server-side rules:
 *  - CAPSTONE_LOCKED — the last article section's quiz must be passed first
 *    (the same sequential rule submitQuiz enforces).
 *  - Idempotent per person: the newest NON-CANCELLED training event is
 *    returned, completed ones included (the capstone stamp survives) — a new
 *    sandbox is only minted when none exists or all were cancelled. An active
 *    sandbox whose quest rows were deleted gets them re-seeded.
 *  - TRAINING_LIMIT — at most 5 training events ever per person.
 */
export const startTraining = mutation({
  args: {},
  handler: async (ctx, _args): Promise<{ eventId: Id<"events"> }> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    // Starting training genuinely makes you an event owner — the one Academy
    // path where resolve-or-create is the right person lookup.
    const me = await getOrCreateOwnerPerson(ctx, chapterId, userId, now);

    // The capstone unlocks like every other section: previous section passed.
    const bySlug = await progressBySlug(ctx, chapterId, me);
    const beforeCapstone = previousAcademySection(ACADEMY_CAPSTONE_SLUG);
    if (beforeCapstone && bySlug.get(beforeCapstone.slug)?.passedAt == null) {
      throw new ConvexError({
        code: "CAPSTONE_LOCKED",
        message: `Pass "${beforeCapstone.title}" first — sections complete in order.`,
      });
    }

    const mine = await trainingEventsFor(ctx, chapterId, me);
    const existing = mine.find((e) => e.status !== "cancelled");
    if (existing) {
      // Self-heal an in-flight sandbox whose quest rows are gone.
      if (
        isActiveTrainingEvent(existing) &&
        (await questRowsFor(ctx, existing)).length === 0
      ) {
        await reseedQuestRows(ctx, existing);
      }
      return { eventId: existing._id };
    }
    if (mine.length >= TRAINING_EVENT_LIMIT) {
      throw new ConvexError({
        code: "TRAINING_LIMIT",
        message:
          "You've reached the training-run limit for this account — your capstone progress is already saved.",
      });
    }

    // Idempotent platform-template lookup — also self-heals chapters seeded
    // before the Academy.
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
 * rows hit terminal statuses in the real event). Reads the newest
 * non-cancelled sandbox — completing the event keeps the checklist (and the
 * pass) visible. Null when training hasn't been started.
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
    const event = await newestTrainingEventFor(
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
      complete: questsComplete(quests),
    };
  },
});
