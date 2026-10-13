/**
 * The in-app Academy course editor: the `people.academy.edit` gate, the shared
 * draft, publish checks, the stale-draft guard, restoring the built-in
 * version, and — the point of the whole layer — that a published edit is what
 * the server GRADES against, not just what the screen shows.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  BUILT_IN_ACADEMY_CATALOG,
  courseEditFromCatalog,
  toEditedSection,
  type CourseEdit,
} from "@events-os/shared";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runAddAcademyEditPowerDefaults } from "../migrations/0089_add_academy_edit_power_defaults";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

// A course whose first lesson has a quiz, so grading can be checked.
const COURSE = BUILT_IN_ACADEMY_CATALOG.courses.find(
  (c) => BUILT_IN_ACADEMY_CATALOG.getSection(c.moduleSlugs[0])!.quiz.length > 0,
)!;
const FIRST = BUILT_IN_ACADEMY_CATALOG.getSection(COURSE.moduleSlugs[0])!;

type Member = ChapterSetup & { personId: Id<"people"> };

async function member(
  t: ReturnType<typeof newT>,
  opts: { email: string; seat?: string },
): Promise<Member> {
  const s = await setupChapter(t, { email: opts.email });
  const personId = await run(t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.email.split("@")[0],
      email: s.email,
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    });
    if (opts.seat) {
      const def = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", opts.seat!))
        .first();
      await ctx.db.insert("seatAssignments", {
        seatDefId: def!._id,
        scope: "central",
        personId,
        createdAt: Date.now(),
      });
    }
    return personId;
  });
  return { ...s, personId };
}

async function seeded() {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const editor = await member(t, { email: "trainer@publicworship.life", seat: "training_associate" });
  return { t, editor };
}

function freshEdit(): CourseEdit {
  return courseEditFromCatalog(BUILT_IN_ACADEMY_CATALOG, COURSE.slug, null)!;
}

/** The first lesson with its quiz rewritten so the right answer moves. */
function withMovedAnswer(edit: CourseEdit): { edit: CourseEdit; newAnswer: number } {
  const lesson = toEditedSection(FIRST);
  const q = lesson.quiz[0];
  const newAnswer = (q.answerIndex + 1) % q.options.length;
  lesson.quiz = [{ ...q, answerIndex: newAnswer }, ...lesson.quiz.slice(1)];
  lesson.title = "Rewritten in the app";
  return { edit: { ...edit, sections: [lesson] }, newAnswer };
}

describe("the Edit Academy courses power", () => {
  test("a member without it can't see or touch the editor", async () => {
    const { t } = await seeded();
    const plain = await member(t, { email: "plain@publicworship.life" });
    expect(await plain.as.query(api.academyEditor.canEditCourses, {})).toBe(false);
    await expect(
      plain.as.mutation(api.academyEditor.saveDraft, {
        courseSlug: COURSE.slug,
        edit: freshEdit(),
        basedOnVersion: 0,
      }),
    ).rejects.toThrow(/Edit Academy courses/);
    await expect(
      plain.as.query(api.academyEditor.courseEditor, { courseSlug: COURSE.slug }),
    ).rejects.toThrow(/Edit Academy courses/);
  });

  test("the Training Associate seat carries it", async () => {
    const { editor } = await seeded();
    expect(await editor.as.query(api.academyEditor.canEditCourses, {})).toBe(true);
  });

  test("migration 0089 adds it to live seats once, and only adds", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    await run(t, async (ctx) => {
      for (const slug of ["training_associate", "executive_director"]) {
        const def = await ctx.db
          .query("seatDefs")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .first();
        await ctx.db.patch(def!._id, {
          capabilities: def!.capabilities.filter((c) => c !== "people.academy.edit"),
        });
      }
    });
    const first = await run(t, (ctx) => runAddAcademyEditPowerDefaults(ctx));
    expect(first.patched).toBe(2);
    const again = await run(t, (ctx) => runAddAcademyEditPowerDefaults(ctx));
    expect(again.patched).toBe(0);
    const ed = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "executive_director"))
        .first(),
    );
    expect(ed!.capabilities).toContain("org.chart.edit");
    expect(ed!.capabilities).toContain("people.academy.edit");
  });
});

describe("drafts and publishing", () => {
  test("a published edit is what learners see AND what the quiz is graded on", async () => {
    const { t, editor } = await seeded();
    const learner = await member(t, { email: "learner@publicworship.life" });
    const { edit, newAnswer } = withMovedAnswer(freshEdit());

    await editor.as.mutation(api.academyEditor.saveDraft, {
      courseSlug: COURSE.slug,
      edit,
      basedOnVersion: 0,
    });
    // A draft changes nothing for learners.
    expect(await learner.as.query(api.academy.courseEdits, {})).toEqual([]);

    const { version, summary } = await editor.as.mutation(
      api.academyEditor.publishDraft,
      { courseSlug: COURSE.slug },
    );
    expect(version).toBe(1);
    expect(summary).toEqual([`Edited "Rewritten in the app": details, quiz`]);

    const live = await learner.as.query(api.academy.courseEdits, {});
    expect(live.map((e) => e.courseSlug)).toEqual([COURSE.slug]);

    // The old right answer is now wrong; the new one passes.
    const answers = FIRST.quiz.map((q) => q.answerIndex);
    const old = await learner.as.mutation(api.academy.submitQuiz, {
      sectionSlug: FIRST.slug,
      answers,
    });
    expect(old.passed).toBe(false);
    answers[0] = newAnswer;
    const ok = await learner.as.mutation(api.academy.submitQuiz, {
      sectionSlug: FIRST.slug,
      answers,
    });
    expect(ok.passed).toBe(true);

    const state = await editor.as.query(api.academyEditor.courseEditor, {
      courseSlug: COURSE.slug,
    });
    expect(state.draft).toBeNull();
    expect(state.currentVersion).toBe(1);
    expect(state.versions[0]).toMatchObject({ version: 1, publishedByName: "trainer" });
  });

  test("an unfinished lesson can be saved but not published", async () => {
    const { editor } = await seeded();
    const edit = freshEdit();
    const lesson = toEditedSection(FIRST);
    lesson.quiz = [{ prompt: "", options: ["a"], answerIndex: 3, explanation: "" }];
    edit.sections = [lesson];
    await editor.as.mutation(api.academyEditor.saveDraft, {
      courseSlug: COURSE.slug,
      edit,
      basedOnVersion: 0,
    });
    await expect(
      editor.as.mutation(api.academyEditor.publishDraft, { courseSlug: COURSE.slug }),
    ).rejects.toThrow(/Fix these before publishing/);
  });

  test("a draft started before someone else published can't overwrite them", async () => {
    const { t, editor } = await seeded();
    const other = await member(t, { email: "ed@publicworship.life", seat: "executive_director" });
    await other.as.mutation(api.academyEditor.saveDraft, {
      courseSlug: COURSE.slug,
      edit: withMovedAnswer(freshEdit()).edit,
      basedOnVersion: 0,
    });
    await other.as.mutation(api.academyEditor.publishDraft, { courseSlug: COURSE.slug });

    const stale = freshEdit();
    stale.course.title = "Mine";
    await editor.as.mutation(api.academyEditor.saveDraft, {
      courseSlug: COURSE.slug,
      edit: stale,
      basedOnVersion: 0,
    });
    await expect(
      editor.as.mutation(api.academyEditor.publishDraft, { courseSlug: COURSE.slug }),
    ).rejects.toThrow(/Someone published this course after your draft started/);
  });

  test("restoring the built-in version and publishing removes the edit", async () => {
    const { t, editor } = await seeded();
    await editor.as.mutation(api.academyEditor.saveDraft, {
      courseSlug: COURSE.slug,
      edit: withMovedAnswer(freshEdit()).edit,
      basedOnVersion: 0,
    });
    await editor.as.mutation(api.academyEditor.publishDraft, { courseSlug: COURSE.slug });

    await editor.as.mutation(api.academyEditor.restoreVersion, {
      courseSlug: COURSE.slug,
      version: 0,
    });
    const { summary } = await editor.as.mutation(api.academyEditor.publishDraft, {
      courseSlug: COURSE.slug,
    });
    expect(summary).toEqual(["Restored the built-in version"]);
    const learner = await member(t, { email: "learner@publicworship.life" });
    expect(await learner.as.query(api.academy.courseEdits, {})).toEqual([]);

    // …and version 1 is still there to go back to.
    await editor.as.mutation(api.academyEditor.restoreVersion, {
      courseSlug: COURSE.slug,
      version: 1,
    });
    const state = await editor.as.query(api.academyEditor.courseEditor, {
      courseSlug: COURSE.slug,
    });
    expect(state.draft?.edit?.sections[0].title).toBe("Rewritten in the app");
    expect(state.draft?.basedOnVersion).toBe(2);
  });
});
