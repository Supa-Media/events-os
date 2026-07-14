/**
 * Academy course completions — the earned BADGE (`courseCompletions`).
 *
 * Covers: the real-time award from submitQuiz (quiz-only courses) and from
 * syncCapstone (the capstone-gated Owning-an-event course); the optional bonus
 * capstone never being required; the 0018 backfill of existing progress; award
 * idempotency + `earnedAt` = max(passedAt); and the two read surfaces
 * (`courseCompleters`, `personBadges`).
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  ACADEMY_CAPSTONE_SECTIONS,
  ACADEMY_SECTIONS,
  defaultStatusOptions,
  getAcademyCourse,
  requiredModuleSlugsForCourse,
  type ModuleKey,
} from "@events-os/shared";
import { runBackfillCourseCompletions } from "../migrations/0018_backfill_course_completions";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

type LearnerSetup = ChapterSetup & { personId: Id<"people"> };

async function setupLearner(): Promise<LearnerSetup> {
  const t = newT();
  const s = await setupChapter(t);
  const personId = await run(t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Casey Learner",
      email: s.email,
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  return { ...s, personId };
}

function correctAnswers(slug: string): number[] {
  const section = ACADEMY_SECTIONS.find((s) => s.slug === slug)!;
  return section.quiz.map((q) => q.answerIndex);
}

function terminalStatusFor(module: string): string {
  const terminal = defaultStatusOptions(module as ModuleKey)?.find(
    (o) => o.isComplete === true,
  );
  if (!terminal) throw new Error(`no terminal status for module ${module}`);
  return terminal.value;
}

/** Pass every quiz section in curriculum order. */
async function passAllQuizzes(s: LearnerSetup) {
  for (const section of ACADEMY_SECTIONS) {
    if (section.quiz.length === 0) continue;
    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: section.slug,
      answers: correctAnswers(section.slug),
    });
  }
}

/** Drive one capstone to a stored pass: start the sandbox, terminalize every
 *  quest row, then sync. */
async function passCapstone(s: LearnerSetup, capstoneSlug: string) {
  const { eventId } = await s.as.mutation(api.academy.startTraining, {
    capstoneSlug,
  });
  await run(s.t, async (ctx) => {
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    for (const it of items) {
      if (!it.title.startsWith("Quest:")) continue;
      await ctx.db.patch(it._id, { status: terminalStatusFor(it.module) });
    }
  });
  await s.as.mutation(api.academy.syncCapstone, { capstoneSlug });
}

async function badges(s: LearnerSetup): Promise<string[]> {
  const rows = await run(s.t, (ctx) =>
    ctx.db
      .query("courseCompletions")
      .withIndex("by_chapter_and_person", (q) =>
        q.eq("chapterId", s.chapterId).eq("personId", s.personId),
      )
      .collect(),
  );
  return rows.map((r) => r.courseSlug).sort();
}

describe("academy course completions", () => {
  test("passing every quiz awards the quiz-only courses, not Owning", async () => {
    const s = await setupLearner();
    await passAllQuizzes(s);
    // Fundamentals + the three role courses are all quiz modules → earned.
    // Owning-an-event needs its capstones, so a quiz pass alone can't earn it.
    expect(await badges(s)).toEqual([
      "chapter-os-fundamentals",
      "comms-lead",
      "event-lead",
      "logistics-lead",
    ]);
  });

  test("Owning-an-event is earned once its required capstones pass (bonus excluded)", async () => {
    const s = await setupLearner();
    await passAllQuizzes(s); // unlocks + passes being-an-owner (a quiz module)
    const required = requiredModuleSlugsForCourse("owning-an-event");
    const requiredCapstones = ACADEMY_CAPSTONE_SECTIONS.filter((c) =>
      required.includes(c.slug),
    );
    // The optional worship bonus is NOT in the required set.
    expect(requiredCapstones.map((c) => c.slug)).not.toContain(
      ACADEMY_CAPSTONE_SECTIONS.find((c) => c.optional)!.slug,
    );

    // Not earned until every required capstone is passed.
    for (let i = 0; i < requiredCapstones.length; i++) {
      await passCapstone(s, requiredCapstones[i].slug);
      const earned = (await badges(s)).includes("owning-an-event");
      expect(earned).toBe(i === requiredCapstones.length - 1);
    }
  });

  test("a partial course earns nothing", async () => {
    const s = await setupLearner();
    // Pass only ONE of comms-lead's two required modules.
    const [first] = requiredModuleSlugsForCourse("comms-lead");
    await run(s.t, (ctx) =>
      ctx.db.insert("academyProgress", {
        chapterId: s.chapterId,
        personId: s.personId,
        sectionSlug: first,
        passedAt: 1000,
      }),
    );
    await run(s.t, (ctx) => runBackfillCourseCompletions(ctx));
    expect(await badges(s)).toEqual([]);
  });

  test("backfill awards existing progress; earnedAt = max(passedAt); idempotent", async () => {
    const s = await setupLearner();
    const [m1, m2] = requiredModuleSlugsForCourse("comms-lead");
    await run(s.t, async (ctx) => {
      await ctx.db.insert("academyProgress", {
        chapterId: s.chapterId,
        personId: s.personId,
        sectionSlug: m1,
        passedAt: 1000,
      });
      await ctx.db.insert("academyProgress", {
        chapterId: s.chapterId,
        personId: s.personId,
        sectionSlug: m2,
        passedAt: 2000,
      });
    });

    const first = await run(s.t, (ctx) => runBackfillCourseCompletions(ctx));
    expect(first.awarded).toBe(1);
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("courseCompletions")
        .withIndex("by_chapter_and_person", (q) =>
          q.eq("chapterId", s.chapterId).eq("personId", s.personId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].courseSlug).toBe("comms-lead");
    expect(rows[0].earnedAt).toBe(2000); // max of the two passedAt values

    // Second run inserts nothing (ledger-independent idempotency).
    const second = await run(s.t, (ctx) => runBackfillCourseCompletions(ctx));
    expect(second.awarded).toBe(0);
  });

  test("courseCompleters + personBadges read the earned badges", async () => {
    const s = await setupLearner();
    await passAllQuizzes(s);

    const completers = await s.as.query(api.academy.courseCompleters, {
      courseSlug: "comms-lead",
    });
    expect(completers).not.toBeNull();
    expect(completers!.map((c) => c.personId)).toContain(s.personId);

    const mine = await s.as.query(api.academy.personBadges, {
      personId: s.personId,
    });
    expect(mine.map((b) => b.courseSlug).sort()).toEqual(
      (await badges(s)),
    );
    // No badge for an unearned course.
    const owning = await s.as.query(api.academy.courseCompleters, {
      courseSlug: "owning-an-event",
    });
    expect(owning).toEqual([]);
  });

  test("every course slug the queries take resolves in the shared catalog", () => {
    // Guards against a query being called with a slug the catalog dropped.
    for (const slug of [
      "chapter-os-fundamentals",
      "comms-lead",
      "event-lead",
      "logistics-lead",
      "owning-an-event",
    ]) {
      expect(getAcademyCourse(slug)).toBeDefined();
    }
  });
});
