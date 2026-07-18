/**
 * Test suite for migration 0028: re-awarding `courseCompletions` after the
 * `chapter-money-model` reshape moved `finance-tiers-and-skim` out of the
 * `chapter-director` course (now just `finance-raise-vs-manage` +
 * `finance-approving-budgets`) into the new shared course.
 *
 * Mirrors 0018's own test style (`academyCompletions.test.ts`), but exercises
 * the migration directly against hand-inserted `academyProgress` rows (rather
 * than driving `submitQuiz`) so each scenario simulates a specific PRE-reshape
 * progress state precisely.
 */
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runReawardCourseCompletions } from "../migrations/0028_reaward_course_completions";

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

async function pass(s: LearnerSetup, slug: string, passedAt: number) {
  await run(s.t, (ctx) =>
    ctx.db.insert("academyProgress", {
      chapterId: s.chapterId,
      personId: s.personId,
      sectionSlug: slug,
      passedAt,
    }),
  );
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

describe("0028_reaward_course_completions", () => {
  test("a person who already held the chapter-director badge (earned pre-reshape, all three old modules) keeps it — badges are never revoked", async () => {
    const s = await setupLearner();
    // Simulate the PRE-reshape earned state directly: insert the badge row
    // as if migration 0018 (or the live award path) had already granted it
    // for all three of the OLD chapter-director modules.
    await run(s.t, (ctx) =>
      ctx.db.insert("courseCompletions", {
        chapterId: s.chapterId,
        personId: s.personId,
        courseSlug: "chapter-director",
        earnedAt: 1000,
      }),
    );
    await pass(s, "finance-raise-vs-manage", 500);
    await pass(s, "finance-approving-budgets", 700);
    await pass(s, "finance-tiers-and-skim", 900);

    const result = await run(s.t, (ctx) => runReawardCourseCompletions(ctx));
    // Nothing new to award: chapter-director is already held, and
    // chapter-money-model needs the two brand-new sections too.
    expect(result.awarded).toBe(0);
    expect(await badges(s)).toEqual(["chapter-director"]);
  });

  test("a person who passed BOTH remaining chapter-director modules (not tiers-and-skim) newly qualifies for the shrunk course", async () => {
    const s = await setupLearner();
    await pass(s, "finance-raise-vs-manage", 100);
    await pass(s, "finance-approving-budgets", 200);
    // Deliberately no finance-tiers-and-skim pass.

    expect(await badges(s)).toEqual([]);

    const result = await run(s.t, (ctx) => runReawardCourseCompletions(ctx));
    expect(result.awarded).toBe(1);
    expect(await badges(s)).toEqual(["chapter-director"]);
  });

  test("chapter-money-model is NOT awarded when its two new sections are unpassed, even with tiers-and-skim passed — no throw, graceful no-op", async () => {
    const s = await setupLearner();
    await pass(s, "finance-tiers-and-skim", 100);
    // finance-budget-lifecycle / finance-one-home-per-dollar: unpassed.

    const result = await run(s.t, (ctx) => runReawardCourseCompletions(ctx));
    expect(result.awarded).toBe(0);
    expect(await badges(s)).toEqual([]);
  });

  test("a person who passes all three chapter-money-model modules earns that badge too, independent of chapter-director", async () => {
    const s = await setupLearner();
    await pass(s, "finance-tiers-and-skim", 100);
    await pass(s, "finance-budget-lifecycle", 200);
    await pass(s, "finance-one-home-per-dollar", 300);

    const result = await run(s.t, (ctx) => runReawardCourseCompletions(ctx));
    expect(result.awarded).toBe(1);
    expect(await badges(s)).toEqual(["chapter-money-model"]);
  });

  test("idempotent: a second run awards nothing further", async () => {
    const s = await setupLearner();
    await pass(s, "finance-raise-vs-manage", 100);
    await pass(s, "finance-approving-budgets", 200);
    await pass(s, "finance-tiers-and-skim", 300);
    await pass(s, "finance-budget-lifecycle", 400);
    await pass(s, "finance-one-home-per-dollar", 500);

    const first = await run(s.t, (ctx) => runReawardCourseCompletions(ctx));
    expect(first.awarded).toBe(2); // chapter-director + chapter-money-model

    const second = await run(s.t, (ctx) => runReawardCourseCompletions(ctx));
    expect(second.awarded).toBe(0);
    expect(await badges(s)).toEqual(["chapter-director", "chapter-money-model"]);
  });

  test("via the real runPending registry (fresh DB): no-op when there's no progress to award", async () => {
    const s = await setupLearner();
    await s.t.mutation(internal.migrations.runPending, {});
    expect(await badges(s)).toEqual([]);
  });
});
