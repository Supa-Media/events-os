/**
 * Academy — server-side quiz grading (right/wrong/partial, best-score
 * retention, passedAt only on perfect), slug validation, the sequential quiz
 * lock, tenant isolation, the Training Event capstone (sequential gate,
 * idempotent start incl. completed events, the 5-run cap, quest self-heal,
 * persisted capstone via syncCapstone), the platform training template's
 * protections (hidden from list, no direct events, no edits, squatter slugs),
 * and the operational exclusions (events.list / pipeline / dashboard.summary /
 * org.workload / reminder collection must never see training events).
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  ACADEMY_CAPSTONE_SLUG,
  ACADEMY_SECTIONS,
  ACADEMY_SECTION_COUNT,
  ACADEMY_TRAINING_TEMPLATE_SLUG,
} from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

const SECTION_1 = ACADEMY_SECTIONS[0];
const SECTION_2 = ACADEMY_SECTIONS[1];
const DAY = 24 * 60 * 60 * 1000;

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

type LearnerSetup = ChapterSetup & { personId: Id<"people"> };

/**
 * setupChapter + a roster person linked to the user. markRead/submitQuiz
 * resolve the caller's person READ-ONLY now (no more auto-create/claim), so
 * every Academy flow starts from a real roster row.
 */
async function setupLearner(
  t: ReturnType<typeof newT>,
  opts: { email?: string; chapterName?: string; name?: string } = {},
): Promise<LearnerSetup> {
  const s = await setupChapter(t, opts);
  const personId = await run(t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name ?? "Casey Learner",
      email: s.email,
      userId: s.userId,
      isActive: true,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  return { ...s, personId };
}

/** Pass every quiz section in order (unlocks the capstone). */
async function passAllQuizzes(s: LearnerSetup) {
  for (const section of ACADEMY_SECTIONS) {
    if (section.quiz.length === 0) continue;
    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: section.slug,
      answers: correctAnswers(section.slug),
    });
  }
}

/** A learner with the capstone unlocked and a training event started. */
async function setupTrainee(): Promise<LearnerSetup & { eventId: Id<"events"> }> {
  const s = await setupLearner(newT());
  await passAllQuizzes(s);
  const { eventId } = await s.as.mutation(api.academy.startTraining, {});
  return { ...s, eventId };
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

/** The person's stored capstone progress row, or null. */
async function capstoneRow(s: LearnerSetup) {
  return await run(s.t, async (ctx) => {
    const rows = await ctx.db
      .query("academyProgress")
      .withIndex("by_chapter_and_person", (q) =>
        q.eq("chapterId", s.chapterId).eq("personId", s.personId),
      )
      .collect();
    return rows.find((r) => r.sectionSlug === ACADEMY_CAPSTONE_SLUG) ?? null;
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
    const s = await setupLearner(newT());
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
    const s = await setupLearner(newT());
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
    const s = await setupLearner(newT());
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
    const s = await setupLearner(newT());
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
    const s = await setupLearner(newT());
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
    const s = await setupLearner(newT());
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

  test("markRead/submitQuiz never create or claim people rows: NO_PERSON", async () => {
    const s = await setupChapter(newT()); // user + membership, NO roster row
    const err = await s.as
      .mutation(api.academy.markRead, { sectionSlug: SECTION_1.slug })
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/NO_PERSON/);

    await expect(
      s.as.mutation(api.academy.submitQuiz, {
        sectionSlug: SECTION_1.slug,
        answers: correctAnswers(SECTION_1.slug),
      }),
    ).rejects.toThrow(/NO_PERSON/);

    // The read-flavored mutations inserted NOTHING — no person, no progress.
    const { people, progress } = await run(s.t, async (ctx) => ({
      people: await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
      progress: await ctx.db
        .query("academyProgress")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    }));
    expect(people).toHaveLength(0);
    expect(progress).toHaveLength(0);
  });
});

describe("tenant isolation + chapterProgress gating", () => {
  test("progress lives per chapter — another chapter starts from zero", async () => {
    const t = newT();
    const a = await setupLearner(t, { email: "a@publicworship.life" });
    const b = await setupLearner(t, {
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
    const s = await setupLearner(t); // membership role "admin"
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

  test("a stale renamed-slug passed row never inflates chapterProgress", async () => {
    const s = await setupLearner(newT());
    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: SECTION_1.slug,
      answers: correctAnswers(SECTION_1.slug),
    });
    // A passed row stranded by a section rename — not in the curriculum.
    await run(s.t, (ctx) =>
      ctx.db.insert("academyProgress", {
        chapterId: s.chapterId,
        personId: s.personId,
        sectionSlug: "retired-section-slug",
        quizBestScore: 3,
        quizTotal: 3,
        passedAt: Date.now(),
      }),
    );
    const view = await s.as.query(api.academy.chapterProgress, {});
    const me = view!.people.find((p) => p.personId === s.personId)!;
    expect(me.completed).toBe(1); // only the real section counts
    expect(me.completed).toBeLessThanOrEqual(me.total);
  });
});

describe("the Training Event capstone", () => {
  test("startTraining is gated on the last quiz section (CAPSTONE_LOCKED)", async () => {
    const s = await setupLearner(newT());
    const err = await s.as
      .mutation(api.academy.startTraining, {})
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/CAPSTONE_LOCKED/);
    // No sandbox was minted.
    const events = await run(s.t, (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(events).toHaveLength(0);
  });

  test("startTraining instantiates the training template once per person", async () => {
    const s = await setupTrainee();
    // Calling again resumes the same event instead of creating another.
    const again = await s.as.mutation(api.academy.startTraining, {});
    expect(again.eventId).toBe(s.eventId);

    const { event, templates } = await run(s.t, async (ctx) => ({
      event: await ctx.db.get(s.eventId),
      templates: (
        await ctx.db
          .query("eventTypes")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).filter((et) => et.isPlatform === true),
    }));
    expect(event!.isTraining).toBe(true);
    expect(event!.name).toMatch(/^Training: .+'s first event$/);
    // ~14 days out.
    const days = (event!.eventDate - Date.now()) / DAY;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
    // Template seeding is idempotent — exactly one platform template.
    expect(templates).toHaveLength(1);
    expect(templates[0].slug).toBe(ACADEMY_TRAINING_TEMPLATE_SLUG);
  });

  test("a completed training event is reused, not replaced", async () => {
    const s = await setupTrainee();
    await completeAllQuests(s, s.eventId);
    await s.as.mutation(api.academy.syncCapstone, {});
    await run(s.t, (ctx) => ctx.db.patch(s.eventId, { status: "completed" }));

    const again = await s.as.mutation(api.academy.startTraining, {});
    expect(again.eventId).toBe(s.eventId); // no fresh 0/5 sandbox
    const trainingEvents = await run(s.t, async (ctx) =>
      (
        await ctx.db
          .query("events")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).filter((e) => e.isTraining === true),
    );
    expect(trainingEvents).toHaveLength(1);
  });

  test("TRAINING_LIMIT caps a person at 5 training events ever", async () => {
    const s = await setupLearner(newT());
    await passAllQuizzes(s);
    for (let i = 0; i < 5; i++) {
      const { eventId } = await s.as.mutation(api.academy.startTraining, {});
      // Cancelled events don't satisfy idempotency, but they count forever.
      await run(s.t, (ctx) => ctx.db.patch(eventId, { status: "cancelled" }));
    }
    const err = await s.as
      .mutation(api.academy.startTraining, {})
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/TRAINING_LIMIT/);
  });

  test("startTraining re-seeds quest rows into an active event that lost them", async () => {
    const s = await setupTrainee();
    await run(s.t, async (ctx) => {
      const items = await ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", s.eventId))
        .collect();
      for (const it of items) await ctx.db.delete(it._id);
    });
    expect((await s.as.query(api.academy.trainingStatus, {}))!.total).toBe(0);

    const again = await s.as.mutation(api.academy.startTraining, {});
    expect(again.eventId).toBe(s.eventId);
    const status = await s.as.query(api.academy.trainingStatus, {});
    expect(status!.total).toBe(5); // 4 planning quests + the battery, restored
    expect(status!.doneCount).toBe(0);
    // Re-seeded rows carry real due dates + role links like the originals.
    const items = await run(s.t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", s.eventId))
        .collect(),
    );
    expect(
      items.filter((it) => it.module === "planning_doc" && it.dueDate != null),
    ).toHaveLength(4);
  });

  test("trainingStatus tracks quest rows live; capstone derives into myProgress", async () => {
    const t = newT();
    const s = await setupLearner(t);
    expect(await s.as.query(api.academy.trainingStatus, {})).toBeNull();
    await passAllQuizzes(s);

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

    // Capstone not passed yet — and myProgress carries the live quest tally.
    let progress = await s.as.query(api.academy.myProgress, {});
    let capstone = progress.sections.find(
      (x) => x.slug === ACADEMY_CAPSTONE_SLUG,
    )!;
    expect(capstone.passed).toBe(false);
    expect(capstone.training).toEqual({
      eventId,
      started: true,
      questsDone: 1,
      questsTotal: 5,
      complete: false,
    });
    // Non-capstone sections never carry training state.
    expect(
      progress.sections
        .filter((x) => x.slug !== ACADEMY_CAPSTONE_SLUG)
        .every((x) => x.training === null),
    ).toBe(true);

    // …until every quest row is terminal.
    await completeAllQuests(s, eventId);
    status = await s.as.query(api.academy.trainingStatus, {});
    expect(status!.doneCount).toBe(5);
    expect(status!.complete).toBe(true);
    progress = await s.as.query(api.academy.myProgress, {});
    capstone = progress.sections.find(
      (x) => x.slug === ACADEMY_CAPSTONE_SLUG,
    )!;
    expect(capstone.passed).toBe(true);
    expect(capstone.training!.complete).toBe(true);
    expect(progress.completed).toBe(ACADEMY_SECTION_COUNT); // the full path

    // …and the manager view derives the same capstone completion.
    const view = await s.as.query(api.academy.chapterProgress, {});
    expect(
      view!.people.some((p) => p.completed === ACADEMY_SECTION_COUNT),
    ).toBe(true);
  });
});

describe("syncCapstone persists the capstone", () => {
  test("no stamp before the quests are done", async () => {
    const s = await setupTrainee();
    const res = await s.as.mutation(api.academy.syncCapstone, {});
    expect(res.passed).toBe(false);
    expect(await capstoneRow(s)).toBeNull();
  });

  test("stamps once done; the pass survives completing the sandbox", async () => {
    const s = await setupTrainee();
    await completeAllQuests(s, s.eventId);
    const res = await s.as.mutation(api.academy.syncCapstone, {});
    expect(res.passed).toBe(true);
    const row = await capstoneRow(s);
    expect(row?.passedAt).toBeTypeOf("number");

    // Idempotent — a second sync never re-stamps.
    await s.as.mutation(api.academy.syncCapstone, {});
    expect((await capstoneRow(s))!.passedAt).toBe(row!.passedAt);

    // The learner completes their sandbox (exactly what the curriculum
    // teaches) — the capstone must stay passed.
    await run(s.t, (ctx) => ctx.db.patch(s.eventId, { status: "completed" }));
    const progress = await s.as.query(api.academy.myProgress, {});
    const capstone = progress.sections.find(
      (x) => x.slug === ACADEMY_CAPSTONE_SLUG,
    )!;
    expect(capstone.passed).toBe(true);
    expect(capstone.passedAt).toBe(row!.passedAt);
    expect(progress.completed).toBe(ACADEMY_SECTION_COUNT);
    // chapterProgress reads the stored stamp too.
    const view = await s.as.query(api.academy.chapterProgress, {});
    expect(
      view!.people.find((p) => p.personId === s.personId)!.completed,
    ).toBe(ACADEMY_SECTION_COUNT);
  });
});

describe("the platform training template is protected + hidden", () => {
  test("eventTypes.list hides it; update/archive/createFromTemplate reject it", async () => {
    const s = await setupTrainee();
    const platform = await run(s.t, async (ctx) =>
      (
        await ctx.db
          .query("eventTypes")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).find((et) => et.isPlatform === true),
    );
    expect(platform).toBeDefined();

    // Gone from the Templates tab / New Event picker…
    const listed = await s.as.query(api.eventTypes.list, {});
    expect(listed.some((t) => t._id === platform!._id)).toBe(false);

    // …and immune to user edits, archiving, and direct event creation.
    await expect(
      s.as.mutation(api.eventTypes.update, {
        eventTypeId: platform!._id,
        name: "My template now",
      }),
    ).rejects.toThrow(/managed by the platform/);
    await expect(
      s.as.mutation(api.eventTypes.archive, { eventTypeId: platform!._id }),
    ).rejects.toThrow(/managed by the platform/);
    await expect(
      s.as.mutation(api.events.createFromTemplate, {
        eventTypeId: platform!._id,
        name: "Sneaky real event",
        eventDate: Date.now() + 7 * DAY,
      }),
    ).rejects.toThrow(/Training runs start from the Academy/);
  });

  test("a user template squatting the slug doesn't hijack the Academy", async () => {
    const s = await setupLearner(newT());
    await passAllQuizzes(s);
    // A user-made template grabs the exact 'academy-training' slug…
    const squatterId = await run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Academy Training",
        slug: ACADEMY_TRAINING_TEMPLATE_SLUG,
        disabledCoreModules: [],
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    // …but startTraining seeds + uses the REAL platform template anyway.
    const { eventId } = await s.as.mutation(api.academy.startTraining, {});
    const { event, platform } = await run(s.t, async (ctx) => ({
      event: await ctx.db.get(eventId),
      platform: (
        await ctx.db
          .query("eventTypes")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).find((et) => et.isPlatform === true),
    }));
    expect(platform).toBeDefined();
    expect(platform!._id).not.toBe(squatterId);
    expect(platform!.slug).toBe(`${ACADEMY_TRAINING_TEMPLATE_SLUG}-2`);
    expect(event!.eventTypeId).toBe(platform!._id);
    // The sandbox has its quests (proof it wasn't spun from the empty squatter).
    expect((await s.as.query(api.academy.trainingStatus, {}))!.total).toBe(5);
    // The squatter stays a normal user template: listed, editable.
    const listed = await s.as.query(api.eventTypes.list, {});
    expect(listed.some((t) => t._id === squatterId)).toBe(true);
    expect(listed.some((t) => t._id === platform!._id)).toBe(false);
    // Repeat starts keep matching on isPlatform — no duplicate seeding.
    await s.as.mutation(api.academy.startTraining, {});
    const platforms = await run(s.t, async (ctx) =>
      (
        await ctx.db
          .query("eventTypes")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).filter((et) => et.isPlatform === true),
    );
    expect(platforms).toHaveLength(1);
  });
});

describe("training events never pollute operations", () => {
  async function withTraining(): Promise<LearnerSetup & { eventId: Id<"events"> }> {
    return await setupTrainee();
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

  test("org.workload excludes training events and their role rows", async () => {
    const s = await withTraining();
    // Hold a role on the training event — a learner assigning themselves
    // Comms Lead is quest #1, so this row WILL exist in real data.
    await run(s.t, async (ctx) => {
      const role = await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q) => q.eq("eventId", s.eventId))
        .first();
      await ctx.db.insert("roleAssignments", {
        eventId: s.eventId,
        chapterId: s.chapterId,
        roleId: role!._id,
        personId: s.personId,
        createdAt: Date.now(),
      });
    });
    const workload = await s.as.query(api.org.workload, {
      personId: s.personId,
    });
    const mine = workload!.members.find((m) => m._id === s.personId)!;
    expect(mine.events).toHaveLength(0); // owned training event hidden
    expect(mine.roles).toHaveLength(0); // its role assignment hidden
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

  test("projects wrapping a training event are skipped by reminders", async () => {
    const s = await withTraining();
    const now = Date.now();
    await run(s.t, async (ctx) => {
      // A project pointing at the training sandbox — must never email.
      await ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Training wrapper",
        status: "in_progress",
        ownerPersonId: s.personId,
        eventId: s.eventId,
        deadline: now + DAY,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      // A control project with no event link — collected as usual.
      await ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Real project",
        status: "in_progress",
        ownerPersonId: s.personId,
        deadline: now + DAY,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
    });
    const recipients = await s.t.query(internal.reminders.openWorkForChapter, {
      chapterId: s.chapterId,
      now,
    });
    expect(recipients).toHaveLength(1);
    expect(recipients[0].entries.map((e) => e.name)).toEqual(["Real project"]);
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
      ).find((x) => x.isPlatform === true)!;
      const { instantiateEvent } = await import("../lib/templates");
      await instantiateEvent(ctx, {
        eventType: et,
        chapterId: s.chapterId,
        userId: s.userId,
        name: "Real event",
        eventDate: Date.now() + 5 * DAY,
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
