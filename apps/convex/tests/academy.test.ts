/**
 * Academy — server-side quiz grading (right/wrong/partial, best-score
 * retention, passedAt only on perfect), slug validation, the sequential quiz
 * lock, tenant isolation, the Training Event capstone (idempotent start, live
 * quest checklist, capstone completion deriving into myProgress), and the
 * operational exclusions (events.list / pipeline / dashboard.summary /
 * reminder collection must never see training events).
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  ACADEMY_CAPSTONE_SLUG,
  ACADEMY_SECTIONS,
  ACADEMY_SECTION_COUNT,
} from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

const SECTION_1 = ACADEMY_SECTIONS[0];
const SECTION_2 = ACADEMY_SECTIONS[1];

/** The all-correct answer vector for a section's quiz. */
function correctAnswers(slug: string): number[] {
  const section = ACADEMY_SECTIONS.find((s) => s.slug === slug)!;
  return section.quiz.map((q) => q.answerIndex);
}

/** The all-wrong answer vector (any index that isn't the right one). */
function wrongAnswers(slug: string): number[] {
  const section = ACADEMY_SECTIONS.find((s) => s.slug === slug)!;
  return section.quiz.map((q) => (q.answerIndex === 0 ? 1 : 0));
}

/** Mark every quest row of an event terminal (done / packed). */
async function completeAllQuests(s: ChapterSetup, eventId: Id<"events">) {
  await run(s.t, async (ctx) => {
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    for (const it of items) {
      if (!it.title.startsWith("Quest:")) continue;
      await ctx.db.patch(it._id, {
        status: it.module === "supplies" ? "packed" : "done",
      });
    }
  });
}

describe("curriculum content", () => {
  test("seven ordered sections; every quiz question is well-formed", () => {
    expect(ACADEMY_SECTION_COUNT).toBe(7);
    expect(ACADEMY_SECTIONS.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const s of ACADEMY_SECTIONS) {
      if (s.slug === ACADEMY_CAPSTONE_SLUG) {
        expect(s.quiz).toHaveLength(0);
        continue;
      }
      expect(s.quiz.length).toBeGreaterThanOrEqual(3);
      expect(s.quiz.length).toBeLessThanOrEqual(5);
      for (const q of s.quiz) {
        expect(q.options.length).toBeGreaterThanOrEqual(3);
        expect(q.options.length).toBeLessThanOrEqual(4);
        expect(q.answerIndex).toBeGreaterThanOrEqual(0);
        expect(q.answerIndex).toBeLessThan(q.options.length);
        expect(q.explanation.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("quiz grading", () => {
  test("perfect attempt: full score, passed, per-question results", async () => {
    const s = await setupChapter(newT());
    const res = await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers: correctAnswers(SECTION_1.slug),
    });
    expect(res.total).toBe(SECTION_1.quiz.length);
    expect(res.score).toBe(res.total);
    expect(res.passed).toBe(true);
    expect(res.results).toHaveLength(res.total);
    for (const r of res.results) {
      expect(r.correct).toBe(true);
      expect(r.explanation.length).toBeGreaterThan(0);
    }

    const progress = await s.as.query(api.academy.myProgress, {});
    const row = progress.sections.find((x) => x.slug === SECTION_1.slug)!;
    expect(row.passed).toBe(true);
    expect(row.passedAt).not.toBeNull();
    expect(row.quizBestScore).toBe(res.total);
    expect(progress.completed).toBe(1);
    expect(progress.total).toBe(ACADEMY_SECTION_COUNT);
  });

  test("partial attempt: correct count graded server-side, no pass", async () => {
    const s = await setupChapter(newT());
    const answers = correctAnswers(SECTION_1.slug);
    answers[0] = answers[0] === 0 ? 1 : 0; // break exactly one
    const res = await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers,
    });
    expect(res.score).toBe(res.total - 1);
    expect(res.passed).toBe(false);
    expect(res.results[0].correct).toBe(false);
    expect(res.results.slice(1).every((r) => r.correct)).toBe(true);

    const progress = await s.as.query(api.academy.myProgress, {});
    const row = progress.sections.find((x) => x.slug === SECTION_1.slug)!;
    expect(row.passed).toBe(false);
    expect(row.passedAt).toBeNull();
    expect(row.quizBestScore).toBe(res.total - 1);
  });

  test("retakes keep the best score; passedAt only on a perfect run", async () => {
    const s = await setupChapter(newT());
    // Good-but-imperfect first…
    const good = correctAnswers(SECTION_1.slug);
    good[0] = good[0] === 0 ? 1 : 0;
    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers: good,
    });
    // …then a terrible retake: best score must NOT regress.
    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers: wrongAnswers(SECTION_1.slug),
    });
    let progress = await s.as.query(api.academy.myProgress, {});
    let row = progress.sections.find((x) => x.slug === SECTION_1.slug)!;
    expect(row.quizBestScore).toBe(SECTION_1.quiz.length - 1);
    expect(row.passed).toBe(false);

    // A perfect retake finally passes.
    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers: correctAnswers(SECTION_1.slug),
    });
    progress = await s.as.query(api.academy.myProgress, {});
    row = progress.sections.find((x) => x.slug === SECTION_1.slug)!;
    expect(row.quizBestScore).toBe(SECTION_1.quiz.length);
    expect(row.passed).toBe(true);
  });

  test("validation: unknown slug, wrong answer count, capstone has no quiz", async () => {
    const s = await setupChapter(newT());
    await expect(
      s.as.mutation(api.academy.submitQuiz, {
        sectionSlug: "not-a-section",
        answers: [0],
      }),
    ).rejects.toThrow(/not an Academy section/);
    await expect(
      s.as.mutation(api.academy.markRead, { sectionSlug: "not-a-section" }),
    ).rejects.toThrow(/not an Academy section/);
    await expect(
      s.as.mutation(api.academy.submitQuiz, {
        sectionSlug: SECTION_1.slug,
        answers: [0],
      }),
    ).rejects.toThrow(/Expected \d+ answers/);
    await expect(
      s.as.mutation(api.academy.submitQuiz, {
        sectionSlug: ACADEMY_CAPSTONE_SLUG,
        answers: [],
      }),
    ).rejects.toThrow(/Training Event/);
  });

  test("quizzes unlock sequentially: section 2 is locked until section 1 passes", async () => {
    const s = await setupChapter(newT());
    await expect(
      s.as.mutation(api.academy.submitQuiz, {
        sectionSlug: SECTION_2.slug,
        answers: correctAnswers(SECTION_2.slug),
      }),
    ).rejects.toThrow(/first — sections complete in order/);

    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers: correctAnswers(SECTION_1.slug),
    });
    const res = await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_2.slug,
      answers: correctAnswers(SECTION_2.slug),
    });
    expect(res.passed).toBe(true);

    const progress = await s.as.query(api.academy.myProgress, {});
    const bySlug = new Map(progress.sections.map((x) => [x.slug, x]));
    expect(bySlug.get(ACADEMY_SECTIONS[2].slug)!.unlocked).toBe(true);
    expect(bySlug.get(ACADEMY_SECTIONS[3].slug)!.unlocked).toBe(false);
  });

  test("markRead stamps readAt once and never blocks on order", async () => {
    const s = await setupChapter(newT());
    // Reading is never locked — mark a LATE section read with nothing passed.
    await s.as.mutation(api.academy.markRead, {
      sectionSlug: ACADEMY_SECTIONS[4].slug,
    });
    const first = await s.as.query(api.academy.myProgress, {});
    const readAt = first.sections.find(
      (x) => x.slug === ACADEMY_SECTIONS[4].slug,
    )!.readAt;
    expect(readAt).not.toBeNull();
    await s.as.mutation(api.academy.markRead, {
      sectionSlug: ACADEMY_SECTIONS[4].slug,
    });
    const second = await s.as.query(api.academy.myProgress, {});
    expect(
      second.sections.find((x) => x.slug === ACADEMY_SECTIONS[4].slug)!.readAt,
    ).toBe(readAt); // first open wins
  });
});

describe("tenant isolation + chapterProgress gating", () => {
  test("progress lives per chapter — another chapter starts from zero", async () => {
    const t = newT();
    const a = await setupChapter(t, { email: "a@publicworship.life" });
    const b = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Boston",
    });
    await a.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers: correctAnswers(SECTION_1.slug),
    });
    const aProgress = await a.as.query(api.academy.myProgress, {});
    expect(aProgress.completed).toBe(1);
    const bProgress = await b.as.query(api.academy.myProgress, {});
    expect(bProgress.completed).toBe(0);
    // …and B's section 2 stays locked by B's OWN chapter-A-independent state.
    await expect(
      b.as.mutation(api.academy.submitQuiz, {
        sectionSlug: SECTION_2.slug,
        answers: correctAnswers(SECTION_2.slug),
      }),
    ).rejects.toThrow(/sections complete in order/);
  });

  test("chapterProgress: admins see counts; plain members get null", async () => {
    const t = newT();
    const s = await setupChapter(t); // membership role "admin"
    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers: correctAnswers(SECTION_1.slug),
    });
    const view = await s.as.query(api.academy.chapterProgress, {});
    expect(view).not.toBeNull();
    expect(view!.total).toBe(ACADEMY_SECTION_COUNT);
    const me = view!.people.find((p) => p.completed === 1);
    expect(me).toBeDefined();

    // A plain member (no admin role, no reports) is not shown the panel.
    const memberId = await run(t, async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "member@publicworship.life",
      });
      await ctx.db.insert("userChapters", {
        userId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      });
      return userId;
    });
    const asMember = t.withIdentity({
      subject: `${memberId}|session`,
      issuer: "test",
    });
    expect(await asMember.query(api.academy.chapterProgress, {})).toBeNull();
  });
});

describe("the Training Event capstone", () => {
  test("startTraining instantiates the training template once per person", async () => {
    const s = await setupChapter(newT());
    const { eventId } = await s.as.mutation(api.academy.startTraining, {});
    // Calling again resumes the same event instead of creating another.
    const again = await s.as.mutation(api.academy.startTraining, {});
    expect(again.eventId).toBe(eventId);

    const { event, templates } = await run(s.t, async (ctx) => ({
      event: await ctx.db.get(eventId),
      templates: (
        await ctx.db
          .query("eventTypes")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).filter((et) => et.slug === "academy-training"),
    }));
    expect(event!.isTraining).toBe(true);
    expect(event!.name).toMatch(/^Training: .+'s first event$/);
    // ~14 days out.
    const days = (event!.eventDate - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
    // Template seeding is idempotent by slug — exactly one per chapter.
    expect(templates).toHaveLength(1);
  });

  test("trainingStatus tracks quest rows live; capstone derives into myProgress", async () => {
    const s = await setupChapter(newT());
    expect(await s.as.query(api.academy.trainingStatus, {})).toBeNull();

    const { eventId } = await s.as.mutation(api.academy.startTraining, {});
    let status = await s.as.query(api.academy.trainingStatus, {});
    expect(status!.eventId).toBe(eventId);
    expect(status!.total).toBe(5); // 4 planning quests + the battery
    expect(status!.doneCount).toBe(0);
    expect(status!.complete).toBe(false);
    // Quest titles come back with the "Quest:" prefix stripped.
    expect(status!.quests.every((q) => !q.title.startsWith("Quest:"))).toBe(
      true,
    );

    // Tick one quest (the battery → packed, supplies' terminal state).
    await run(s.t, async (ctx) => {
      const items = await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "supplies"),
        )
        .collect();
      await ctx.db.patch(items[0]._id, { status: "packed" });
    });
    status = await s.as.query(api.academy.trainingStatus, {});
    expect(status!.doneCount).toBe(1);
    expect(status!.complete).toBe(false);

    // Capstone not passed yet…
    let progress = await s.as.query(api.academy.myProgress, {});
    expect(
      progress.sections.find((x) => x.slug === ACADEMY_CAPSTONE_SLUG)!.passed,
    ).toBe(false);

    // …until every quest row is terminal.
    await completeAllQuests(s, eventId);
    status = await s.as.query(api.academy.trainingStatus, {});
    expect(status!.doneCount).toBe(5);
    expect(status!.complete).toBe(true);
    progress = await s.as.query(api.academy.myProgress, {});
    expect(
      progress.sections.find((x) => x.slug === ACADEMY_CAPSTONE_SLUG)!.passed,
    ).toBe(true);
    expect(progress.completed).toBe(1); // capstone counts toward the path

    // …and the manager view derives the same capstone completion.
    const view = await s.as.query(api.academy.chapterProgress, {});
    expect(view!.people.some((p) => p.completed === 1)).toBe(true);
  });
});

describe("training events never pollute operations", () => {
  async function withTraining(): Promise<ChapterSetup & { eventId: Id<"events"> }> {
    const s = await setupChapter(newT());
    const { eventId } = await s.as.mutation(api.academy.startTraining, {});
    return { ...s, eventId };
  }

  test("events.list hides training events in both scopes unless opted in", async () => {
    const s = await withTraining();
    expect(await s.as.query(api.events.list, {})).toHaveLength(0);
    expect(await s.as.query(api.events.list, { scope: "all" })).toHaveLength(0);
    const withFlag = await s.as.query(api.events.list, {
      scope: "all",
      includeTraining: true,
    });
    expect(withFlag).toHaveLength(1);
    expect(withFlag[0]._id).toBe(s.eventId);
  });

  test("events.pipeline and dashboard.summary exclude training events", async () => {
    const s = await withTraining();
    expect(await s.as.query(api.events.pipeline, {})).toHaveLength(0);
    const summary = await s.as.query(api.dashboard.summary, {});
    expect(summary.upcomingCount).toBe(0);
    expect(summary.nextEvent).toBeNull();
  });

  test("reminder collection skips training quest rows entirely", async () => {
    const s = await withTraining();
    // Quest rows are due-dated (T-10…T-1 of an event 14 days out) and resolve
    // to the emailable event owner — without the exclusion they would email.
    const recipients = await s.t.query(internal.reminders.openWorkForChapter, {
      chapterId: s.chapterId,
      now: Date.now(),
    });
    expect(recipients).toHaveLength(0);
  });

  test("a REAL event still flows to lists and reminders (control)", async () => {
    const s = await withTraining();
    // A non-training event from the same training template shape: reuse the
    // WwS-style path by instantiating from the training template WITHOUT the
    // flag — the exclusions must key on isTraining, not on the template.
    await run(s.t, async (ctx) => {
      const et = (
        await ctx.db
          .query("eventTypes")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).find((x) => x.slug === "academy-training")!;
      const { instantiateEvent } = await import("../lib/templates");
      await instantiateEvent(ctx, {
        eventType: et,
        chapterId: s.chapterId,
        userId: s.userId,
        name: "Real event",
        eventDate: Date.now() + 5 * 24 * 60 * 60 * 1000,
      });
    });
    const list = await s.as.query(api.events.list, {});
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Real event");
    const recipients = await s.t.query(internal.reminders.openWorkForChapter, {
      chapterId: s.chapterId,
      now: Date.now(),
    });
    expect(recipients.length).toBeGreaterThan(0);
  });
});
