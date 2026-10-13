/**
 * Working with one course's edit: start a draft, check it, describe it.
 *
 * Pure helpers shared by the course editor screens and the Convex mutations
 * that save and publish (`apps/convex/academyEditor.ts`), so "is this draft
 * publishable?" has one answer on both sides. See `./catalog` for how a
 * published edit lays over the built-in course.
 */
import {
  APP_LESSON_SLUG_PREFIX,
  builtInCourse,
  builtInSection,
  sameContent,
  sectionFingerprint,
  type AcademyCatalog,
  type CourseEdit,
  type EditedSection,
} from "./catalog";
import type { AcademyBlock, AcademySection } from "./types";

/** Limits that keep one course's edit well inside a Convex document. */
export const COURSE_EDIT_LIMITS = {
  lessons: 40,
  blocksPerLesson: 120,
  questionsPerLesson: 30,
  optionsPerQuestion: 8,
  textChars: 6000,
} as const;

/** The draft an editor starts from: the course exactly as learners see it
 *  now, with every lesson it currently shows that differs from code carried
 *  as an edited section. */
export function courseEditFromCatalog(
  catalog: AcademyCatalog,
  courseSlug: string,
  published: CourseEdit | null,
): CourseEdit | null {
  const course = catalog.getCourse(courseSlug);
  if (!course) return null;
  const sections: EditedSection[] = [];
  for (const s of catalog.courseModules(courseSlug)) {
    const base = builtInSection(s.slug);
    const fromPublished = published?.sections.find((p) => p.slug === s.slug);
    if (fromPublished) {
      sections.push(fromPublished);
    } else if (!base || sectionFingerprint(base) !== sectionFingerprint(s)) {
      // Edited by another course's publish, or made in the app — carry the
      // shown version so this draft doesn't silently revert it.
      sections.push(toEditedSection(s));
    }
  }
  return {
    course: {
      title: course.title,
      description: course.description,
      level: course.level,
      themeKey: course.themeKey,
      audience: course.audience,
      icon: course.icon,
    },
    moduleSlugs: [...course.moduleSlugs],
    removedSlugs: [...(published?.removedSlugs ?? [])],
    sections,
  };
}

/** A lesson as the editor stores it, fingerprinted against its built-in
 *  version so a later code change to that lesson can be noticed. */
export function toEditedSection(s: AcademySection | EditedSection): EditedSection {
  const base = builtInSection(s.slug);
  return {
    slug: s.slug,
    title: s.title,
    subtitle: s.subtitle,
    minutes: s.minutes,
    blocks: s.blocks,
    quiz: s.quiz,
    ...(s.optional ? { optional: true } : {}),
    ...(base ? { baseFingerprint: sectionFingerprint(base) } : {}),
  };
}

/** The lesson as the draft currently shows it: its edited copy, else the
 *  catalog's, else code's. */
export function draftSection(
  edit: CourseEdit,
  slug: string,
  catalog: AcademyCatalog,
): EditedSection | AcademySection | undefined {
  return (
    edit.sections.find((s) => s.slug === slug) ??
    catalog.getSection(slug) ??
    builtInSection(slug)
  );
}

/** True when the built-in version of an edited lesson changed after the edit
 *  was made, so the editor can offer to take the new built-in version. */
export function builtInChangedSince(s: EditedSection): boolean {
  if (!s.baseFingerprint) return false;
  const base = builtInSection(s.slug);
  return base != null && sectionFingerprint(base) !== s.baseFingerprint;
}

/** A fresh, collision-proof slug for a lesson made in the app. */
export function newAppLessonSlug(now: number, rand: number): string {
  const tail = Math.floor(rand * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${APP_LESSON_SLUG_PREFIX}${now.toString(36)}-${tail}`;
}

/** A blank lesson to start writing in. */
export function blankLesson(slug: string): EditedSection {
  return {
    slug,
    title: "New lesson",
    subtitle: "",
    minutes: 3,
    blocks: [{ kind: "p", text: "" }],
    quiz: [],
  };
}

/** The block kinds the editor writes in full. Everything else (the org-chart
 *  tree, the practice widgets, the scripted assistant demo) is CODE-ONLY: the
 *  editor can move or remove one, but its insides are built in code. */
export const EDITABLE_BLOCK_KINDS = [
  "p",
  "heading",
  "bullets",
  "rule",
  "story",
  "tip",
  "table",
  "link",
  "reveal",
  "scenario",
] as const satisfies readonly AcademyBlock["kind"][];
export type EditableBlockKind = (typeof EDITABLE_BLOCK_KINDS)[number];

/** True for a block the editor can move or remove but not rewrite. */
export function isCodeOnlyBlock(b: AcademyBlock): boolean {
  return !(EDITABLE_BLOCK_KINDS as readonly string[]).includes(b.kind);
}

/** The plain-text pieces of a block, for length checks. */
function blockTexts(b: AcademyBlock): string[] {
  switch (b.kind) {
    case "p":
    case "heading":
    case "tip":
      return [b.text];
    case "bullets":
      return b.items;
    case "story":
    case "rule":
      return [b.title, b.text];
    case "table":
      return [...b.headers, ...b.rows.flat()];
    case "link":
      return [b.label, b.url, b.note ?? ""];
    case "reveal":
      return [b.prompt, b.answer];
    case "scenario":
      return [b.prompt, ...b.options.flatMap((o) => [o.text, o.feedback])];
    default:
      return [];
  }
}

/**
 * Everything wrong with `edit` that would stop it publishing, in the editor's
 * words. Empty means publishable. `catalog` is the CURRENT published catalog,
 * used to check that every lesson the course lists exists somewhere.
 */
export function courseEditProblems(
  courseSlug: string,
  edit: CourseEdit,
  catalog: AcademyCatalog,
): string[] {
  const problems: string[] = [];
  const L = COURSE_EDIT_LIMITS;
  const base = builtInCourse(courseSlug);
  if (!base) return [`There is no course called "${courseSlug}".`];

  if (!edit.course.title.trim()) problems.push("The course needs a title.");
  if (!catalog.themes.some((t) => t.key === edit.course.themeKey)) {
    problems.push("Pick a stream for the course.");
  }
  if (edit.moduleSlugs.length === 0) {
    problems.push("A course needs at least one lesson.");
  }
  if (edit.moduleSlugs.length > L.lessons) {
    problems.push(`A course can hold at most ${L.lessons} lessons.`);
  }
  if (new Set(edit.moduleSlugs).size !== edit.moduleSlugs.length) {
    problems.push("A lesson is listed twice.");
  }

  const editedSlugs = new Set<string>();
  for (const s of edit.sections) {
    if (editedSlugs.has(s.slug)) {
      problems.push(`"${s.title}" is saved twice.`);
    }
    editedSlugs.add(s.slug);
  }

  for (const slug of edit.moduleSlugs) {
    const edited = edit.sections.find((s) => s.slug === slug);
    const known = edited ?? catalog.getSection(slug) ?? builtInSection(slug);
    if (!known) {
      problems.push(`A lesson in this course no longer exists (${slug}).`);
      continue;
    }
    if (!edited) continue;
    if (!builtInSection(slug) && !slug.startsWith(APP_LESSON_SLUG_PREFIX)) {
      problems.push(`"${edited.title}" has an invalid id.`);
    }
    problems.push(...lessonProblems(edited, builtInSection(slug)));
  }
  return problems;
}

/** What's wrong with one lesson, each message naming it. */
export function lessonProblems(
  s: EditedSection,
  base: AcademySection | undefined,
): string[] {
  const L = COURSE_EDIT_LIMITS;
  const name = s.title.trim() ? `"${s.title.trim()}"` : "A lesson";
  const out: string[] = [];
  if (!s.title.trim()) out.push("A lesson needs a title.");
  if (!(s.minutes >= 1 && s.minutes <= 120)) {
    out.push(`${name}: reading time must be between 1 and 120 minutes.`);
  }
  if (s.blocks.length === 0) out.push(`${name} has no content.`);
  if (s.blocks.length > L.blocksPerLesson) {
    out.push(`${name} has more than ${L.blocksPerLesson} blocks.`);
  }
  s.blocks.forEach((b, i) => {
    const texts = blockTexts(b);
    if (texts.some((t) => t.length > L.textChars)) {
      out.push(`${name}, block ${i + 1}: text is longer than ${L.textChars} characters.`);
    }
    if (
      (b.kind === "p" || b.kind === "heading" || b.kind === "tip") &&
      !b.text.trim()
    ) {
      out.push(`${name}, block ${i + 1} is empty.`);
    }
    if (b.kind === "bullets" && b.items.every((t) => !t.trim())) {
      out.push(`${name}, block ${i + 1}: the list is empty.`);
    }
    if (b.kind === "link" && !/^https?:\/\//.test(b.url.trim())) {
      out.push(`${name}, block ${i + 1}: links must start with https://.`);
    }
    if (b.kind === "scenario" && !b.options.some((o) => o.correct)) {
      out.push(`${name}, block ${i + 1}: mark which scenario answer is right.`);
    }
    if (b.kind === "table" && b.rows.some((r) => r.length !== b.headers.length)) {
      out.push(`${name}, block ${i + 1}: every table row needs one cell per column.`);
    }
  });

  if (base?.capstone) {
    if (s.quiz.length > 0) {
      out.push(`${name} is completed in its training event, so it can't have a quiz.`);
    }
    return out;
  }
  if (s.quiz.length === 0) out.push(`${name} needs at least one quiz question.`);
  if (s.quiz.length > L.questionsPerLesson) {
    out.push(`${name} has more than ${L.questionsPerLesson} quiz questions.`);
  }
  s.quiz.forEach((q, i) => {
    const label = `${name}, question ${i + 1}`;
    if (!q.prompt.trim()) out.push(`${label} has no question text.`);
    if (q.options.length < 2) out.push(`${label} needs at least two answers.`);
    if (q.options.length > L.optionsPerQuestion) {
      out.push(`${label} has more than ${L.optionsPerQuestion} answers.`);
    }
    if (q.options.some((o) => !o.trim())) out.push(`${label} has an empty answer.`);
    if (
      !Number.isInteger(q.answerIndex) ||
      q.answerIndex < 0 ||
      q.answerIndex >= q.options.length
    ) {
      out.push(`${label}: pick the correct answer.`);
    }
    if (!q.explanation.trim()) {
      out.push(`${label} needs the explanation shown after answering.`);
    }
  });
  return out;
}

/** One line per thing a draft changes, against what learners see now — the
 *  "In this draft" list, and the summary a publish is recorded with. */
export function describeCourseEditChanges(
  courseSlug: string,
  draft: CourseEdit,
  catalog: AcademyCatalog,
): string[] {
  const out: string[] = [];
  const now = catalog.getCourse(courseSlug);
  if (!now) return out;
  const c = draft.course;
  if (c.title !== now.title) out.push(`Renamed the course to "${c.title}"`);
  if (c.description !== now.description) out.push("Changed the description");
  if (c.level !== now.level) out.push(`Level set to ${c.level}`);
  if (c.themeKey !== now.themeKey) {
    const theme = catalog.themes.find((t) => t.key === c.themeKey);
    out.push(`Moved to the ${theme?.title ?? c.themeKey} stream`);
  }
  if (c.icon !== now.icon) out.push("Changed the icon");

  const before = now.moduleSlugs;
  const after = draft.moduleSlugs;
  const titleOf = (slug: string) =>
    draftSection(draft, slug, catalog)?.title ?? slug;
  for (const slug of after) {
    if (!before.includes(slug)) {
      const elsewhere = catalog.courseForModuleSlug(slug);
      out.push(
        elsewhere
          ? `Moved "${titleOf(slug)}" here from ${elsewhere.title}`
          : `Added "${titleOf(slug)}"`,
      );
    }
  }
  for (const slug of before) {
    if (!after.includes(slug)) {
      out.push(`Removed "${catalog.getSection(slug)?.title ?? slug}"`);
    }
  }
  const kept = after.filter((s) => before.includes(s));
  const keptBefore = before.filter((s) => after.includes(s));
  if (kept.join() !== keptBefore.join()) out.push("Reordered the lessons");

  for (const slug of after) {
    if (!before.includes(slug)) continue;
    const edited = draft.sections.find((s) => s.slug === slug);
    const shown = catalog.getSection(slug);
    if (!edited || !shown) continue;
    const parts: string[] = [];
    if (
      edited.title !== shown.title ||
      edited.subtitle !== shown.subtitle ||
      edited.minutes !== shown.minutes
    ) {
      parts.push("details");
    }
    if (!sameContent(edited.blocks, shown.blocks)) {
      parts.push("article");
    }
    if (!sameContent(edited.quiz, shown.quiz)) {
      parts.push("quiz");
    }
    if (parts.length) out.push(`Edited "${edited.title}": ${parts.join(", ")}`);
  }
  return out;
}
