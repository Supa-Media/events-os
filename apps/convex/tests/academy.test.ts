/**
 * Academy — server-side quiz grading (right/wrong/partial, best-score
 * retention, passedAt only on perfect), slug validation, the sequential quiz
 * lock, tenant isolation, the training-event capstones (three of them:
 * sequential gates incl. capstone→capstone, idempotent start per capstone,
 * the per-capstone 5-run cap, quest self-heal, persisted passes via
 * syncCapstone, the optional bonus never counting), the platform training
 * templates' protections (hidden from list, no direct events, no edits,
 * squatter slugs), and the operational exclusions (events.list / pipeline /
 * dashboard.summary / org.workload / reminder collection must never see
 * training events).
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  ACADEMY_CAPSTONE_SECTIONS,
  ACADEMY_INTERACTIVE_KINDS,
  ACADEMY_REQUIRED_SECTION_COUNT,
  ACADEMY_SECTIONS,
  ACADEMY_SECTION_COUNT,
  ACADEMY_TRAINING_TEMPLATES,
  defaultStatusOptions,
  type ModuleKey,
} from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

const SECTION_1 = ACADEMY_SECTIONS[0];
const SECTION_2 = ACADEMY_SECTIONS[1];
// Curriculum order: join-an-event, birthday party, then the optional worship
// bonus. The suite leans on that order — the assertion below pins it.
const [CAPSTONE_JOIN, CAPSTONE_PARTY, CAPSTONE_BONUS] =
  ACADEMY_CAPSTONE_SECTIONS;
const DAY = 24 * 60 * 60 * 1000;

/** A module's terminal status, from the SAME source production's quest-done
 *  rule reads (defaultStatusOptions + isComplete) — no hand-kept mirror. */
function terminalStatusFor(module: string): string {
  const terminal = defaultStatusOptions(module as ModuleKey)?.find(
    (o) => o.isComplete === true,
  );
  if (!terminal) throw new Error(`no terminal status for module ${module}`);
  return terminal.value;
}

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

/** Pass every quiz section in order (unlocks the first capstone). */
async function passAllQuizzes(s: LearnerSetup) {
  for (const section of ACADEMY_SECTIONS) {
    if (section.quiz.length === 0) continue;
    await s.as.mutation(api.academy.submitQuiz, {
      sectionSlug: section.slug,
      answers: correctAnswers(section.slug),
    });
  }
}

/** Mark every quest row of an event terminal for its module. */
async function completeAllQuests(s: ChapterSetup, eventId: Id<"events">) {
  await run(s.t, async (ctx) => {
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    for (const it of items) {
      if (!it.title.startsWith("Quest:")) continue;
      await ctx.db.patch(it._id, {
        status: terminalStatusFor(it.module),
      });
    }
  });
}

/** A learner with quizzes passed and the FIRST capstone's sandbox started. */
async function setupTrainee(): Promise<LearnerSetup & { eventId: Id<"events"> }> {
  const s = await setupLearner(newT());
  await passAllQuizzes(s);
  const { eventId } = await s.as.mutation(api.academy.startTraining, {
    capstoneSlug: CAPSTONE_JOIN.slug,
  });
  return { ...s, eventId };
}

/** The person's stored progress row for a capstone, or null. */
async function capstoneRow(s: LearnerSetup, slug: string) {
  return await run(s.t, async (ctx) => {
    const rows = await ctx.db
      .query("academyProgress")
      .withIndex("by_chapter_and_person", (q) =>
        q.eq("chapterId", s.chapterId).eq("personId", s.personId),
      )
      .collect();
    return rows.find((r) => r.sectionSlug === slug) ?? null;
  });
}

/** The chapter's platform templates, keyed by platformKey. */
async function platformTemplates(s: ChapterSetup) {
  return await run(s.t, async (ctx) =>
    (
      await ctx.db
        .query("eventTypes")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect()
    ).filter((et) => et.isPlatform === true),
  );
}

describe("curriculum content", () => {
  test("seventeen ordered sections; three capstones; one optional bonus", () => {
    expect(ACADEMY_SECTION_COUNT).toBe(17);
    expect(ACADEMY_SECTIONS.map((s) => s.order)).toEqual(
      Array.from({ length: 17 }, (_v, i) => i + 1),
    );
    // The optional bonus is excluded from the trained denominator.
    expect(ACADEMY_REQUIRED_SECTION_COUNT).toBe(16);
    expect(ACADEMY_CAPSTONE_SECTIONS).toHaveLength(3);
    // The suite leans on this order — pin it.
    expect(CAPSTONE_JOIN.capstone!.kind).toBe("join_event");
    expect(CAPSTONE_PARTY.capstone!.kind).toBe("birthday_party");
    expect(CAPSTONE_BONUS.capstone!.kind).toBe("worship_event");
    // Only the bonus is optional, and it's last.
    expect(ACADEMY_SECTIONS.filter((s) => s.optional === true)).toEqual([
      CAPSTONE_BONUS,
    ]);
    expect(ACADEMY_SECTIONS[ACADEMY_SECTIONS.length - 1]).toBe(CAPSTONE_BONUS);
    // Every capstone kind has a training-template key.
    for (const c of ACADEMY_CAPSTONE_SECTIONS) {
      expect(
        ACADEMY_TRAINING_TEMPLATES[c.capstone!.kind].templateKey,
      ).toBeTruthy();
    }
  });

  test("every quiz question is well-formed; capstones have no quiz", () => {
    for (const s of ACADEMY_SECTIONS) {
      if (s.capstone) {
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

  test("every article is authored as designed, well-formed blocks", () => {
    const interactive = new Set<string>(ACADEMY_INTERACTIVE_KINDS);
    for (const s of ACADEMY_SECTIONS) {
      expect(s.blocks.length).toBeGreaterThan(0);
      // Every section anchors on at least one principle card or field story.
      expect(
        s.blocks.some((b) => b.kind === "rule" || b.kind === "story"),
      ).toBe(true);
      // Table blocks are rectangular: every row matches its header count.
      for (const b of s.blocks) {
        if (b.kind === "table") {
          expect(b.headers.length).toBeGreaterThan(1);
          for (const row of b.rows) {
            expect(row).toHaveLength(b.headers.length);
          }
        }
        if (b.kind === "try_status") {
          // The terminal value must be reachable by cycling the options —
          // and never the STARTING option, or the widget would show its
          // success caption before the learner taps anything.
          expect(b.options.map((o) => o.value)).toContain(b.terminal);
          expect(b.options[0]?.value).not.toBe(b.terminal);
        }
      }
      // Every teaching section practices hands-on: ≥1 interactive block.
      if (!s.capstone) {
        expect(s.blocks.some((b) => interactive.has(b.kind))).toBe(true);
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
    expect(progress.total).toBe(ACADEMY_REQUIRED_SECTION_COUNT);
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

  test("validation: unknown slug, wrong answer count, capstones have no quiz", async () => {
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
        sectionSlug: CAPSTONE_JOIN.slug,
        answers: [],
      }),
    ).rejects.toThrow(/training event/);
    // Capstone-only mutations reject non-capstone slugs.
    await expect(
      s.as.mutation(api.academy.startTraining, {
        capstoneSlug: SECTION_1.slug,
      }),
    ).rejects.toThrow(/not a capstone/);
    await expect(
      s.as.mutation(api.academy.syncCapstone, {
        capstoneSlug: SECTION_1.slug,
      }),
    ).rejects.toThrow(/not a capstone/);
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
    expect(view!.total).toBe(ACADEMY_REQUIRED_SECTION_COUNT);
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

describe("the training-event capstones", () => {
  test("startTraining is gated on the last quiz section (CAPSTONE_LOCKED)", async () => {
    const s = await setupLearner(newT());
    const err = await s.as
      .mutation(api.academy.startTraining, { capstoneSlug: CAPSTONE_JOIN.slug })
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

  test("capstone 2 is gated on capstone 1 (live quest completion counts)", async () => {
    const s = await setupTrainee();
    // Quizzes passed, capstone-1 sandbox started but unfinished → locked.
    const err = await s.as
      .mutation(api.academy.startTraining, {
        capstoneSlug: CAPSTONE_PARTY.slug,
      })
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/CAPSTONE_LOCKED/);

    // Finishing capstone 1's quests unlocks capstone 2 WITHOUT a sync — the
    // gate accepts live derivation, not only the stored stamp.
    await completeAllQuests(s, s.eventId);
    const { eventId } = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_PARTY.slug,
    });
    expect(eventId).not.toBe(s.eventId);
  });

  test("startTraining instantiates each capstone's template once per person", async () => {
    const s = await setupTrainee();
    // Calling again resumes the same event instead of creating another.
    const again = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(again.eventId).toBe(s.eventId);

    const event = await run(s.t, (ctx) => ctx.db.get(s.eventId));
    expect(event!.isTraining).toBe(true);
    expect(event!.name).toMatch(/^Training: .+ joins the gathering$/);
    // ~30 days out — the join sandbox models a big event's longer horizon.
    const days = (event!.eventDate - Date.now()) / DAY;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    // Template seeding is idempotent — exactly one platform template per key.
    const joinKey = ACADEMY_TRAINING_TEMPLATES.join_event.templateKey;
    const platforms = await platformTemplates(s);
    expect(platforms.filter((p) => p.platformKey === joinKey)).toHaveLength(1);
  });

  test("a completed training event is reused, not replaced", async () => {
    const s = await setupTrainee();
    await completeAllQuests(s, s.eventId);
    await s.as.mutation(api.academy.syncCapstone, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    await run(s.t, (ctx) => ctx.db.patch(s.eventId, { status: "completed" }));

    const again = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(again.eventId).toBe(s.eventId); // no fresh sandbox
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

  test("TRAINING_LIMIT caps a person at 5 training events per capstone", async () => {
    const s = await setupLearner(newT());
    await passAllQuizzes(s);
    for (let i = 0; i < 5; i++) {
      const { eventId } = await s.as.mutation(api.academy.startTraining, {
        capstoneSlug: CAPSTONE_JOIN.slug,
      });
      // Cancelled events don't satisfy idempotency, but they count forever.
      await run(s.t, (ctx) => ctx.db.patch(eventId, { status: "cancelled" }));
    }
    const err = await s.as
      .mutation(api.academy.startTraining, { capstoneSlug: CAPSTONE_JOIN.slug })
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
    expect(
      (
        await s.as.query(api.academy.trainingStatus, {
          capstoneSlug: CAPSTONE_JOIN.slug,
        })
      )!.total,
    ).toBe(0);

    const again = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(again.eventId).toBe(s.eventId);
    const status = await s.as.query(api.academy.trainingStatus, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(status!.total).toBe(8); // 5 Tasks quests + 3 Comms quests, restored
    expect(status!.doneCount).toBe(0);
    // The heal restores load-bearing SCENERY too, not just quests — the
    // comms quests send the learner to read the Run of Show and Crew Duties.
    const healed = await run(s.t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", s.eventId))
        .collect(),
    );
    expect(healed.some((it) => it.module === "run_of_show")).toBe(true);
    expect(
      healed.filter(
        (it) => it.module === "planning_doc" && !it.title.startsWith("Quest:"),
      ).length,
    ).toBeGreaterThan(0);
    // Re-seeded rows carry real due dates + role links like the originals.
    const items = await run(s.t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", s.eventId))
        .collect(),
    );
    expect(
      items.filter(
        (it) =>
          it.module === "planning_doc" &&
          it.title.startsWith("Quest:") &&
          it.dueDate != null,
      ),
    ).toHaveLength(5);
  });

  test("trainingStatus tracks quests live; both capstones roll into myProgress", async () => {
    const t = newT();
    const s = await setupLearner(t);
    expect(
      await s.as.query(api.academy.trainingStatus, {
        capstoneSlug: CAPSTONE_JOIN.slug,
      }),
    ).toBeNull();
    await passAllQuizzes(s);

    const { eventId } = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    let status = await s.as.query(api.academy.trainingStatus, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(status!.eventId).toBe(eventId);
    expect(status!.total).toBe(8);
    expect(status!.doneCount).toBe(0);
    expect(status!.complete).toBe(false);
    // Quest titles come back with the "Quest:" prefix stripped.
    expect(status!.quests.every((q) => !q.title.startsWith("Quest:"))).toBe(
      true,
    );
    // Checklist keeps workstream story order: Tasks quests before Comms
    // quests (alphabetical would invert them — 'comms' < 'planning_doc').
    expect(status!.quests.map((q) => q.module)).toEqual([
      ...Array(5).fill("planning_doc"),
      ...Array(3).fill("comms"),
    ]);

    // Tick one quest (a comms row → sent, comms' terminal state).
    await run(s.t, async (ctx) => {
      const items = await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "comms"),
        )
        .collect();
      const quest = items.find((it) => it.title.startsWith("Quest:"))!;
      await ctx.db.patch(quest._id, { status: "sent" });
    });
    status = await s.as.query(api.academy.trainingStatus, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(status!.doneCount).toBe(1);
    expect(status!.complete).toBe(false);

    // Capstone not passed yet — and myProgress carries the live quest tally
    // on the RIGHT capstone entry.
    let progress = await s.as.query(api.academy.myProgress, {});
    let join = progress.sections.find((x) => x.slug === CAPSTONE_JOIN.slug)!;
    expect(join.passed).toBe(false);
    expect(join.training).toEqual({
      eventId,
      started: true,
      questsDone: 1,
      questsTotal: 8,
      complete: false,
    });
    // Other sections (incl. the not-yet-started party capstone) carry none.
    expect(
      progress.sections
        .filter((x) => x.slug !== CAPSTONE_JOIN.slug)
        .every((x) => x.training === null),
    ).toBe(true);

    // Finish capstone 1, then run capstone 2 end-to-end.
    await completeAllQuests(s, eventId);
    progress = await s.as.query(api.academy.myProgress, {});
    join = progress.sections.find((x) => x.slug === CAPSTONE_JOIN.slug)!;
    expect(join.passed).toBe(true);
    expect(
      progress.sections.find((x) => x.slug === CAPSTONE_PARTY.slug)!.unlocked,
    ).toBe(true);
    expect(progress.completed).toBe(ACADEMY_REQUIRED_SECTION_COUNT - 1);

    const party = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_PARTY.slug,
    });
    expect(party.eventId).not.toBe(eventId);
    await completeAllQuests(s, party.eventId);
    progress = await s.as.query(api.academy.myProgress, {});
    expect(
      progress.sections.find((x) => x.slug === CAPSTONE_PARTY.slug)!.passed,
    ).toBe(true);
    expect(progress.completed).toBe(ACADEMY_REQUIRED_SECTION_COUNT); // trained

    // …and the manager view derives the same completion.
    const view = await s.as.query(api.academy.chapterProgress, {});
    expect(
      view!.people.some(
        (p) => p.completed === ACADEMY_REQUIRED_SECTION_COUNT,
      ),
    ).toBe(true);
  });

  test("the optional bonus unlocks after capstone 2 but never counts", async () => {
    const s = await setupTrainee();
    await completeAllQuests(s, s.eventId);
    const party = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_PARTY.slug,
    });
    // Bonus locked until the party capstone is done.
    let err = await s.as
      .mutation(api.academy.startTraining, {
        capstoneSlug: CAPSTONE_BONUS.slug,
      })
      .then(() => null)
      .catch((e) => e);
    expect(String(err)).toMatch(/CAPSTONE_LOCKED/);

    await completeAllQuests(s, party.eventId);
    let progress = await s.as.query(api.academy.myProgress, {});
    expect(progress.completed).toBe(ACADEMY_REQUIRED_SECTION_COUNT);
    expect(
      progress.sections.find((x) => x.slug === CAPSTONE_BONUS.slug)!.unlocked,
    ).toBe(true);

    // Run the bonus end-to-end: passed, but completed/total unchanged.
    const bonus = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_BONUS.slug,
    });
    await completeAllQuests(s, bonus.eventId);
    await s.as.mutation(api.academy.syncCapstone, {
      capstoneSlug: CAPSTONE_BONUS.slug,
    });
    progress = await s.as.query(api.academy.myProgress, {});
    expect(
      progress.sections.find((x) => x.slug === CAPSTONE_BONUS.slug)!.passed,
    ).toBe(true);
    expect(progress.completed).toBe(ACADEMY_REQUIRED_SECTION_COUNT);
    expect(progress.total).toBe(ACADEMY_REQUIRED_SECTION_COUNT);
    // chapterProgress ignores it too.
    const view = await s.as.query(api.academy.chapterProgress, {});
    const me = view!.people.find((p) => p.personId === s.personId)!;
    expect(me.completed).toBe(ACADEMY_REQUIRED_SECTION_COUNT);
  });

  test("the party capstone seeds sample teammates + crew, exactly once", async () => {
    const s = await setupTrainee();
    await completeAllQuests(s, s.eventId);
    const party = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_PARTY.slug,
    });

    const { samples, engagements } = await run(s.t, async (ctx) => ({
      samples: (
        await ctx.db
          .query("people")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).filter((p) => p.isSamplePerson === true),
      engagements: await ctx.db
        .query("engagements")
        .withIndex("by_event", (q) => q.eq("eventId", party.eventId))
        .collect(),
    }));
    // Maya + Jordan (teammates, no engagement) exist as SAMPLE people — not
    // placeholders (they must clear a placeholder slot when swapped in) and
    // not team members (real events' pickers never offer them).
    const names = samples.map((p) => p.name);
    expect(names).toContain("Maya (sample teammate)");
    expect(names).toContain("Jordan (sample teammate)");
    expect(
      samples.every(
        (p) => p.isPlaceholder !== true && p.isTeamMember !== true,
      ),
    ).toBe(true);
    // …and Uncle Ray + Cousin Lena were materialized as sandbox crew.
    expect(engagements.length).toBeGreaterThanOrEqual(2);

    // Restarting training never duplicates the teammates.
    await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_PARTY.slug,
    });
    const after = await run(s.t, async (ctx) =>
      (
        await ctx.db
          .query("people")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).filter((p) => p.name === "Maya (sample teammate)"),
    );
    expect(after).toHaveLength(1);

    // Legacy rows from earlier releases (isPlaceholder / isTeamMember Mayas)
    // heal onto the sample-person shape instead of duplicating.
    await run(s.t, (ctx) =>
      ctx.db.patch(after[0]._id, {
        isSamplePerson: undefined,
        isPlaceholder: true,
        isTeamMember: true,
      }),
    );
    await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_PARTY.slug,
    });
    const healed = await run(s.t, (ctx) => ctx.db.get(after[0]._id));
    expect(healed!.isSamplePerson).toBe(true);
    expect(healed!.isPlaceholder).toBeUndefined();
    expect(healed!.isTeamMember).toBeUndefined();
  });

  test("sandbox pickers collapse to the learner + placeholder people", async () => {
    const s = await setupTrainee();
    await completeAllQuests(s, s.eventId);
    const party = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_PARTY.slug,
    });

    // Another REAL team member exists on the roster…
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Real Rachel",
        isTeamMember: true,
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    // Without an eventId: the normal rules — no placeholders and no sample
    // people anywhere.
    const normalTeam = await s.as.query(api.people.teamMembers, {});
    expect(normalTeam.some((p) => p.name === "Real Rachel")).toBe(true);
    expect(normalTeam.some((p) => p.isPlaceholder === true)).toBe(false);
    expect(normalTeam.some((p) => p.isSamplePerson === true)).toBe(false);
    const normalList = await s.as.query(api.people.list, {});
    expect(normalList.some((p) => p.isPlaceholder === true)).toBe(false);
    expect(normalList.some((p) => p.isSamplePerson === true)).toBe(false);

    // Scoped to the training sandbox: the learner + sample people + THIS
    // event's own placeholder crew slots ONLY — Real Rachel can never be
    // roped into a drill, and the JOIN sandbox's Greeter slot (a different
    // event's placeholder) never bleeds into the party sandbox.
    for (const q of [api.people.teamMembers, api.people.list] as const) {
      const scoped = await s.as.query(q, { eventId: party.eventId });
      expect(scoped.some((p) => p.name === "Real Rachel")).toBe(false);
      expect(scoped.some((p) => p._id === s.personId)).toBe(true);
      expect(scoped.some((p) => p.name === "Maya (sample teammate)")).toBe(true);
      expect(scoped.some((p) => p.name === "Greeter (placeholder)")).toBe(
        false,
      );
      expect(
        scoped.every(
          (p) =>
            p._id === s.personId ||
            p.isSamplePerson === true ||
            p.isPlaceholder === true,
        ),
      ).toBe(true);
    }

    // A REAL event's id gives no special scope — normal rules apply.
    const realEventId = await run(s.t, async (ctx) => {
      const anyType = (await ctx.db
        .query("eventTypes")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .first())!;
      return await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId: anyType._id,
        templateVersion: 1,
        name: "Real event",
        eventDate: Date.now() + 7 * DAY,
        ownerPersonId: s.personId,
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const unscoped = await s.as.query(api.people.teamMembers, {
      eventId: realEventId,
    });
    expect(unscoped.some((p) => p.name === "Real Rachel")).toBe(true);
    expect(unscoped.some((p) => p.isPlaceholder === true)).toBe(false);
  });
});

describe("training template spec-version refresh", () => {
  test("a stale platform template is rebuilt in place on next start", async () => {
    const s = await setupTrainee();
    // Simulate a chapter seeded by an older release: wind the join template
    // back to version 1 and strip its quest rows.
    const platform = (await platformTemplates(s)).find(
      (t) =>
        t.platformKey === ACADEMY_TRAINING_TEMPLATES.join_event.templateKey,
    )!;
    await run(s.t, async (ctx) => {
      await ctx.db.patch(platform._id, { version: 1 });
      const items = await ctx.db
        .query("templateItems")
        .withIndex("by_eventType", (q) => q.eq("eventTypeId", platform._id))
        .collect();
      for (const it of items) await ctx.db.delete(it._id);
    });

    // A fresh learner starting the capstone gets the CURRENT spec content.
    const other = await setupLearner(s.t, {
      email: "second@publicworship.life",
      name: "Second Learner",
    });
    // Same chapter: rebind the second learner's membership + person row.
    await run(s.t, async (ctx) => {
      const memberships = await ctx.db.query("userChapters").collect();
      for (const m of memberships) {
        if (m.userId === other.userId) {
          await ctx.db.patch(m._id, { chapterId: s.chapterId });
        }
      }
      await ctx.db.patch(other.personId, { chapterId: s.chapterId });
    });
    await passAllQuizzes(other);
    const { eventId } = await other.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    const status = await other.as.query(api.academy.trainingStatus, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(status!.eventId).toBe(eventId);
    expect(status!.total).toBe(8); // rebuilt from the current spec
    const refreshed = await run(s.t, (ctx) => ctx.db.get(platform._id));
    expect(refreshed!.version).toBeGreaterThan(1);
  });
});

describe("syncCapstone persists a capstone", () => {
  test("no stamp before the quests are done", async () => {
    const s = await setupTrainee();
    const res = await s.as.mutation(api.academy.syncCapstone, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(res.passed).toBe(false);
    expect(await capstoneRow(s, CAPSTONE_JOIN.slug)).toBeNull();
  });

  test("stamps once done; the pass survives completing the sandbox", async () => {
    const s = await setupTrainee();
    await completeAllQuests(s, s.eventId);
    const res = await s.as.mutation(api.academy.syncCapstone, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect(res.passed).toBe(true);
    const row = await capstoneRow(s, CAPSTONE_JOIN.slug);
    expect(row?.passedAt).toBeTypeOf("number");

    // Idempotent — a second sync never re-stamps.
    await s.as.mutation(api.academy.syncCapstone, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    expect((await capstoneRow(s, CAPSTONE_JOIN.slug))!.passedAt).toBe(
      row!.passedAt,
    );

    // The learner completes their sandbox (exactly what the curriculum
    // teaches) — the capstone must stay passed.
    await run(s.t, (ctx) => ctx.db.patch(s.eventId, { status: "completed" }));
    const progress = await s.as.query(api.academy.myProgress, {});
    const join = progress.sections.find(
      (x) => x.slug === CAPSTONE_JOIN.slug,
    )!;
    expect(join.passed).toBe(true);
    expect(join.passedAt).toBe(row!.passedAt);

    // chapterProgress reads the stored stamp too (13 quizzes + 1 capstone).
    const view = await s.as.query(api.academy.chapterProgress, {});
    expect(
      view!.people.find((p) => p.personId === s.personId)!.completed,
    ).toBe(ACADEMY_REQUIRED_SECTION_COUNT - 1);
  });
});

describe("the platform training templates are protected + hidden", () => {
  test("eventTypes.list hides them; update/archive/createFromTemplate reject them", async () => {
    const s = await setupTrainee();
    const platforms = await platformTemplates(s);
    expect(platforms.length).toBeGreaterThanOrEqual(1);
    const platform = platforms[0];

    // Gone from the Templates tab / New Event picker…
    const listed = await s.as.query(api.eventTypes.list, {});
    expect(listed.some((t) => t._id === platform._id)).toBe(false);

    // …and immune to user edits, archiving, and direct event creation.
    await expect(
      s.as.mutation(api.eventTypes.update, {
        eventTypeId: platform._id,
        name: "My template now",
      }),
    ).rejects.toThrow(/managed by the platform/);
    await expect(
      s.as.mutation(api.eventTypes.archive, { eventTypeId: platform._id }),
    ).rejects.toThrow(/managed by the platform/);
    await expect(
      s.as.mutation(api.events.createFromTemplate, {
        eventTypeId: platform._id,
        name: "Sneaky real event",
        eventDate: Date.now() + 7 * DAY,
      }),
    ).rejects.toThrow(/Training runs start from the Academy/);
  });

  test("a user template squatting the slug doesn't hijack the Academy", async () => {
    const s = await setupLearner(newT());
    await passAllQuizzes(s);
    const joinKey = ACADEMY_TRAINING_TEMPLATES.join_event.templateKey;
    // A user-made template grabs the exact platform slug…
    const squatterId = await run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Academy Join Event",
        slug: joinKey,
        disabledCoreModules: [],
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    // …but startTraining seeds + uses the REAL platform template anyway.
    const { eventId } = await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    const { event, platform } = await run(s.t, async (ctx) => ({
      event: await ctx.db.get(eventId),
      platform: (
        await ctx.db
          .query("eventTypes")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect()
      ).find((et) => et.isPlatform === true && et.platformKey === joinKey),
    }));
    expect(platform).toBeDefined();
    expect(platform!._id).not.toBe(squatterId);
    expect(platform!.slug).toBe(`${joinKey}-2`);
    expect(event!.eventTypeId).toBe(platform!._id);
    // The sandbox has its quests (proof it wasn't spun from the empty squatter).
    expect(
      (
        await s.as.query(api.academy.trainingStatus, {
          capstoneSlug: CAPSTONE_JOIN.slug,
        })
      )!.total,
    ).toBe(8);
    // The squatter stays a normal user template: listed, editable.
    const listed = await s.as.query(api.eventTypes.list, {});
    expect(listed.some((t) => t._id === squatterId)).toBe(true);
    expect(listed.some((t) => t._id === platform!._id)).toBe(false);
    // Repeat starts keep matching on platformKey — no duplicate seeding.
    await s.as.mutation(api.academy.startTraining, {
      capstoneSlug: CAPSTONE_JOIN.slug,
    });
    const platforms = await platformTemplates(s);
    expect(platforms.filter((p) => p.platformKey === joinKey)).toHaveLength(1);
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
    // Quest rows are due-dated (T-14…T-1 of an event 14 days out) and resolve
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
    // A non-training event from the same training template shape: instantiate
    // from the platform template WITHOUT the flag — the exclusions must key
    // on isTraining, not on the template.
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
