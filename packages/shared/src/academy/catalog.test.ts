import { describe, expect, test } from "vitest";
import {
  ACADEMY_CAPSTONE_SECTIONS,
  ACADEMY_COURSES,
  ACADEMY_REQUIRED_SECTION_COUNT,
  ACADEMY_SECTIONS,
} from "./index";
import {
  BUILT_IN_ACADEMY_CATALOG,
  buildAcademyCatalog,
  type CourseEdit,
  type PublishedCourseEdit,
} from "./catalog";
import {
  blankLesson,
  builtInChangedSince,
  courseEditFromCatalog,
  courseEditProblems,
  describeCourseEditChanges,
  newAppLessonSlug,
  toEditedSection,
} from "./courseEdit";

const COURSE = ACADEMY_COURSES.find((c) => c.moduleSlugs.length >= 3)!;
const OTHER = ACADEMY_COURSES.find(
  (c) => c.slug !== COURSE.slug && c.moduleSlugs.length >= 2,
)!;

function startEdit(slug = COURSE.slug): CourseEdit {
  return courseEditFromCatalog(BUILT_IN_ACADEMY_CATALOG, slug, null)!;
}

function published(
  edit: CourseEdit,
  courseSlug = COURSE.slug,
  publishedAt = 1,
): PublishedCourseEdit {
  return { courseSlug, edit, publishedAt };
}

describe("the built-in catalog", () => {
  test("matches the static curriculum exactly", () => {
    const cat = BUILT_IN_ACADEMY_CATALOG;
    expect(cat.courses).toEqual(ACADEMY_COURSES);
    expect(cat.requiredSectionCount).toBe(ACADEMY_REQUIRED_SECTION_COUNT);
    expect(cat.capstoneSections.map((s) => s.slug)).toEqual(
      ACADEMY_CAPSTONE_SECTIONS.map((s) => s.slug),
    );
    expect(cat.sections).toEqual(ACADEMY_SECTIONS);
  });

  test("a fresh draft changes nothing", () => {
    const edit = startEdit();
    expect(edit.sections).toEqual([]);
    expect(describeCourseEditChanges(COURSE.slug, edit, BUILT_IN_ACADEMY_CATALOG)).toEqual([]);
    expect(buildAcademyCatalog([published(edit)]).courses).toEqual(ACADEMY_COURSES);
  });
});

describe("laying an edit over a course", () => {
  test("replaces the course's details and lesson order", () => {
    const edit = startEdit();
    edit.course.title = "Renamed";
    edit.moduleSlugs.reverse();
    const cat = buildAcademyCatalog([published(edit)]);
    const course = cat.getCourse(COURSE.slug)!;
    expect(course.title).toBe("Renamed");
    expect(course.moduleSlugs).toEqual([...COURSE.moduleSlugs].reverse());
    const [first, second] = course.moduleSlugs;
    expect(cat.previousModuleInCourse(first)).toBeNull();
    expect(cat.previousModuleInCourse(second)).toBe(first);
    cat.sections.forEach((s, i) => expect(s.order).toBe(i + 1));
  });

  test("an edited lesson shows its new text and quiz; the rest read from code", () => {
    const edit = startEdit();
    const target = ACADEMY_SECTIONS.find(
      (s) => s.slug === COURSE.moduleSlugs[0],
    )!;
    const changed = toEditedSection(target);
    changed.title = "Better title";
    changed.blocks = [{ kind: "p", text: "Rewritten." }];
    edit.sections.push(changed);
    const cat = buildAcademyCatalog([published(edit)]);
    expect(cat.getSection(target.slug)!.title).toBe("Better title");
    expect(cat.getSection(target.slug)!.blocks).toEqual([
      { kind: "p", text: "Rewritten." },
    ]);
    const untouched = COURSE.moduleSlugs[1];
    expect(cat.getSection(untouched)).toEqual(
      BUILT_IN_ACADEMY_CATALOG.getSection(untouched),
    );
    expect(builtInChangedSince(changed)).toBe(false);
    expect(builtInChangedSince({ ...changed, baseFingerprint: "stale" })).toBe(true);
  });

  test("a removed lesson leaves the course and the catalog", () => {
    const edit = startEdit();
    const gone = edit.moduleSlugs.pop()!;
    edit.removedSlugs.push(gone);
    const cat = buildAcademyCatalog([published(edit)]);
    expect(cat.getCourse(COURSE.slug)!.moduleSlugs).not.toContain(gone);
    expect(cat.getSection(gone)).toBeUndefined();
  });

  test("a built-in lesson the edit never mentions is appended, not lost", () => {
    const edit = startEdit();
    const later = edit.moduleSlugs.pop()!; // as if code added it after the edit
    const cat = buildAcademyCatalog([published(edit)]);
    expect(cat.getCourse(COURSE.slug)!.moduleSlugs.at(-1)).toBe(later);
  });

  test("adding an existing lesson moves it out of its old course", () => {
    const edit = startEdit();
    const moved = OTHER.moduleSlugs[0];
    edit.moduleSlugs.push(moved);
    const cat = buildAcademyCatalog([published(edit)]);
    expect(cat.courseForModuleSlug(moved)!.slug).toBe(COURSE.slug);
    expect(cat.getCourse(OTHER.slug)!.moduleSlugs).not.toContain(moved);
    expect(describeCourseEditChanges(COURSE.slug, edit, BUILT_IN_ACADEMY_CATALOG)).toContain(
      `Moved "${BUILT_IN_ACADEMY_CATALOG.getSection(moved)!.title}" here from ${OTHER.title}`,
    );
  });

  test("two courses claiming one lesson: the later publish wins", () => {
    const moved = OTHER.moduleSlugs[0];
    const a = startEdit();
    a.moduleSlugs.push(moved);
    const b = startEdit(OTHER.slug);
    const cat = buildAcademyCatalog([
      published(a, COURSE.slug, 1),
      published(b, OTHER.slug, 2),
    ]);
    expect(cat.courseForModuleSlug(moved)!.slug).toBe(OTHER.slug);
    expect(cat.getCourse(COURSE.slug)!.moduleSlugs).not.toContain(moved);
  });

  test("a lesson written in the app joins the course", () => {
    const edit = startEdit();
    const slug = newAppLessonSlug(1_700_000_000_000, 0.5);
    const lesson = blankLesson(slug);
    lesson.blocks = [{ kind: "p", text: "Hello." }];
    lesson.quiz = [
      { prompt: "Q?", options: ["a", "b"], answerIndex: 1, explanation: "b." },
    ];
    edit.sections.push(lesson);
    edit.moduleSlugs.push(slug);
    expect(courseEditProblems(COURSE.slug, edit, BUILT_IN_ACADEMY_CATALOG)).toEqual([]);
    const cat = buildAcademyCatalog([published(edit)]);
    expect(cat.getSection(slug)!.quiz[0].answerIndex).toBe(1);
    expect(cat.requiredSectionCount).toBe(ACADEMY_REQUIRED_SECTION_COUNT + 1);
  });

  test("a capstone keeps its sandbox and never gains a quiz", () => {
    const cap = ACADEMY_CAPSTONE_SECTIONS[0];
    const courseSlug = BUILT_IN_ACADEMY_CATALOG.courseForModuleSlug(cap.slug)!.slug;
    const edit = startEdit(courseSlug);
    const changed = toEditedSection(cap);
    changed.title = "Renamed capstone";
    changed.quiz = [
      { prompt: "Q?", options: ["a", "b"], answerIndex: 0, explanation: "a." },
    ];
    edit.sections.push(changed);
    expect(courseEditProblems(courseSlug, edit, BUILT_IN_ACADEMY_CATALOG).join()).toMatch(
      /can't have a quiz/,
    );
    const cat = buildAcademyCatalog([published(edit, courseSlug)]);
    expect(cat.getSection(cap.slug)!.capstone).toEqual(cap.capstone);
    expect(cat.getSection(cap.slug)!.quiz).toEqual([]);
  });

  test("an edit for a course that's gone from code is ignored", () => {
    const edit = startEdit();
    const cat = buildAcademyCatalog([published(edit, "no-such-course")]);
    expect(cat.courses).toEqual(ACADEMY_COURSES);
  });
});

describe("publish checks", () => {
  test("catch an unanswerable question and an empty paragraph", () => {
    const edit = startEdit();
    const lesson = blankLesson(newAppLessonSlug(1, 0.1));
    lesson.quiz = [
      { prompt: "Q?", options: ["a", "b"], answerIndex: 5, explanation: "" },
    ];
    edit.sections.push(lesson);
    edit.moduleSlugs.push(lesson.slug);
    const problems = courseEditProblems(COURSE.slug, edit, BUILT_IN_ACADEMY_CATALOG);
    expect(problems).toContain(`"New lesson", block 1 is empty.`);
    expect(problems).toContain(`"New lesson", question 1: pick the correct answer.`);
    expect(problems).toContain(
      `"New lesson", question 1 needs the explanation shown after answering.`,
    );
  });

  test("refuse a course with no lessons or a made-up lesson id", () => {
    const edit = startEdit();
    edit.moduleSlugs = [];
    expect(courseEditProblems(COURSE.slug, edit, BUILT_IN_ACADEMY_CATALOG)).toContain(
      "A course needs at least one lesson.",
    );
    edit.moduleSlugs = ["made-up"];
    expect(courseEditProblems(COURSE.slug, edit, BUILT_IN_ACADEMY_CATALOG)).toContain(
      "A lesson in this course no longer exists (made-up).",
    );
  });
});
