/**
 * The Academy CATALOG — the code-defined curriculum (`./index`) with the
 * course edits people have PUBLISHED in the app laid over it.
 *
 * The streams in `./streams/*` stay the built-in version of every course. The
 * in-app course editor (gated by `people.academy.edit`) never rewrites them; it
 * publishes a `CourseEdit` per course, stored in Convex, and every reader —
 * the hub, the course and lesson screens, and the server-side quiz grader —
 * builds the same catalog from the same published edits with
 * `buildAcademyCatalog`. That is what keeps grading honest: the server grades
 * a quiz against exactly the version the learner was shown.
 *
 * ── How an edit lays over the built-in course ───────────────────────────────
 *  - Course fields (title, description, level, stream, icon) are replaced.
 *  - `moduleSlugs` is the course's lesson order, as the editor left it. A
 *    built-in lesson the edit never mentions — added to the course in code
 *    after the edit was made — is appended, unless the edit removed it on
 *    purpose (`removedSlugs`). So a code change still reaches an edited course.
 *  - A lesson listed by an edit is CLAIMED by that course: it leaves whatever
 *    course it was in before ("Add an existing lesson" moves it). Two edits
 *    claiming one lesson resolve to the one published last.
 *  - `sections` holds only the lessons the editor changed, plus lessons
 *    created in the app. An unchanged lesson keeps reading from code, so a
 *    code fix to it still lands.
 *  - A lesson in no course after all of that is retired: it disappears from
 *    the catalog (its stored progress rows are left alone).
 *  - A capstone's sandbox wiring (`capstone`) always comes from code — the
 *    editor can change its article, never what completes it.
 *
 * `order` is re-derived from catalog position, so the sequential-unlock chain
 * stays contiguous whatever the edits do.
 */
import {
  ACADEMY_COURSES,
  ACADEMY_SECTIONS,
  ACADEMY_THEMES,
} from "./index";
import type {
  AcademyAudience,
  AcademyLevel,
  AcademySection,
  AcademyThemeKey,
  Course,
  Theme,
} from "./types";

// ── Edit shapes ──────────────────────────────────────────────────────────────

/** One lesson as the editor stores it. `order` and `capstone` are derived
 *  (from catalog position and from code) and never stored. */
export interface EditedSection
  extends Omit<AcademySection, "order" | "capstone"> {
  /** Fingerprint of the built-in lesson this edit started from, so the editor
   *  can say "the built-in version changed since this was edited". Absent for
   *  a lesson created in the app. */
  baseFingerprint?: string;
}

/** The editable fields of a course. */
export interface CourseFields {
  title: string;
  description: string;
  level: AcademyLevel;
  themeKey: AcademyThemeKey;
  audience: AcademyAudience;
  icon: string;
}

/** Everything one course's edit says — what is published, and what a draft
 *  holds before it is. */
export interface CourseEdit {
  course: CourseFields;
  /** The course's lessons, in teaching order. */
  moduleSlugs: string[];
  /** Built-in lessons of this course the editor removed on purpose. */
  removedSlugs: string[];
  /** Only the lessons that differ from code, or were created in the app. */
  sections: EditedSection[];
}

/** A published edit, as the catalog builder receives it. */
export interface PublishedCourseEdit {
  courseSlug: string;
  edit: CourseEdit;
  publishedAt: number;
}

/** Slugs of lessons created in the app carry this prefix, so they can never
 *  collide with a slug a stream file adds later. */
export const APP_LESSON_SLUG_PREFIX = "app-";

// ── Fingerprints ─────────────────────────────────────────────────────────────

/** JSON with object keys sorted, so two equal values serialize identically
 *  whatever order their keys were written in (a round trip through the
 *  database does not preserve key order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/** True when two JSON-shaped values hold the same content. */
export function sameContent(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A short, stable fingerprint of any JSON-shaped value (djb2 over its
 *  canonical JSON). Detects change; not a security primitive. */
export function contentFingerprint(value: unknown): string {
  const json = canonicalJson(value);
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** The fingerprint of a lesson's CONTENT — what an editor can change. */
export function sectionFingerprint(
  s: Omit<AcademySection, "order" | "capstone">,
): string {
  return contentFingerprint({
    slug: s.slug,
    title: s.title,
    subtitle: s.subtitle,
    minutes: s.minutes,
    blocks: s.blocks,
    quiz: s.quiz,
    optional: s.optional === true,
  });
}

/** The built-in version of a lesson, or undefined for one made in the app. */
export function builtInSection(slug: string): AcademySection | undefined {
  return ACADEMY_SECTIONS.find((s) => s.slug === slug);
}

/** The built-in version of a course, or undefined. */
export function builtInCourse(slug: string): Course | undefined {
  return ACADEMY_COURSES.find((c) => c.slug === slug);
}

// ── The catalog ──────────────────────────────────────────────────────────────

/** The merged curriculum and every lookup the screens and grader need. The
 *  method names mirror the static helpers in `./index` one-for-one. */
export interface AcademyCatalog {
  sections: AcademySection[];
  courses: Course[];
  themes: Theme[];
  /** Sections counting toward "fully trained" (optional ones excluded). */
  requiredSectionCount: number;
  capstoneSections: AcademySection[];
  getSection(slug: string): AcademySection | undefined;
  getCourse(slug: string): Course | undefined;
  courseForModuleSlug(slug: string): Course | undefined;
  moduleCourseIndex(slug: string): { course: Course; index: number } | null;
  previousModuleInCourse(slug: string): string | null;
  nextModuleInCourse(slug: string): string | null;
  courseModules(courseSlug: string): AcademySection[];
  coursesForTheme(themeKey: AcademyThemeKey): Course[];
  requiredModuleSlugsForCourse(courseSlug: string): string[];
}

/**
 * Lay `edits` over the built-in curriculum. Pure and deterministic: the same
 * published edits always produce the same catalog, on the client and on the
 * server. An edit for a course that no longer exists in code is ignored.
 */
export function buildAcademyCatalog(
  edits: readonly PublishedCourseEdit[],
): AcademyCatalog {
  const editByCourse = new Map<string, PublishedCourseEdit>();
  for (const e of edits) {
    if (!builtInCourse(e.courseSlug)) continue;
    const prior = editByCourse.get(e.courseSlug);
    if (!prior || prior.publishedAt <= e.publishedAt) {
      editByCourse.set(e.courseSlug, e);
    }
  }

  // Which course each lesson a published edit lists belongs to. Later
  // publishes win a contested lesson.
  const claimedBy = new Map<string, string>();
  const byRecency = [...editByCourse.values()].sort(
    (a, b) => a.publishedAt - b.publishedAt,
  );
  for (const e of byRecency) {
    for (const slug of e.edit.moduleSlugs) claimedBy.set(slug, e.courseSlug);
  }

  // Edited lesson content: the claiming course's copy wins, else the most
  // recently published copy anywhere.
  const editedSection = new Map<string, EditedSection>();
  for (const e of byRecency) {
    for (const s of e.edit.sections) editedSection.set(s.slug, s);
  }
  for (const e of byRecency) {
    for (const s of e.edit.sections) {
      if (claimedBy.get(s.slug) === e.courseSlug) editedSection.set(s.slug, s);
    }
  }

  const baseSection = new Map(ACADEMY_SECTIONS.map((s) => [s.slug, s]));
  const ownedHere = (slug: string, courseSlug: string) => {
    const owner = claimedBy.get(slug);
    return owner === undefined || owner === courseSlug;
  };

  const seen = new Set<string>();
  const courses: Course[] = [];
  for (const base of ACADEMY_COURSES) {
    const published = editByCourse.get(base.slug);
    let moduleSlugs: string[];
    let fields: CourseFields = base;
    if (published) {
      const { edit } = published;
      fields = edit.course;
      const removed = new Set(edit.removedSlugs);
      const listed = new Set(edit.moduleSlugs);
      moduleSlugs = [
        ...edit.moduleSlugs,
        ...base.moduleSlugs.filter((s) => !listed.has(s) && !removed.has(s)),
      ];
    } else {
      moduleSlugs = [...base.moduleSlugs];
    }
    moduleSlugs = moduleSlugs.filter(
      (slug) =>
        ownedHere(slug, base.slug) &&
        (baseSection.has(slug) || editedSection.has(slug)) &&
        !seen.has(slug),
    );
    for (const slug of moduleSlugs) seen.add(slug);
    courses.push({
      slug: base.slug,
      title: fields.title,
      description: fields.description,
      level: fields.level,
      themeKey: fields.themeKey,
      audience: fields.audience,
      icon: fields.icon,
      moduleSlugs,
    });
  }

  // Sections in curriculum order: built-in lessons keep their place in the
  // streams (so nothing that reads `order` reshuffles), and a lesson made in
  // the app sits right after the lesson before it in its course.
  const inCourse = new Set(courses.flatMap((c) => c.moduleSlugs));
  const slugs = ACADEMY_SECTIONS.map((s) => s.slug).filter((s) => inCourse.has(s));
  for (const course of courses) {
    course.moduleSlugs.forEach((slug, i) => {
      if (slugs.includes(slug)) return;
      const prev = course.moduleSlugs[i - 1];
      const next = course.moduleSlugs.find((s, j) => j > i && slugs.includes(s));
      const at =
        prev !== undefined && slugs.includes(prev)
          ? slugs.indexOf(prev) + 1
          : next !== undefined
            ? slugs.indexOf(next)
            : slugs.length;
      slugs.splice(at, 0, slug);
    });
  }
  const sections: AcademySection[] = [];
  for (const slug of slugs) {
    const base = baseSection.get(slug);
    const edited = editedSection.get(slug);
    const order = sections.length + 1;
    if (edited) {
      const { baseFingerprint: _fp, ...content } = edited;
      sections.push({
        ...content,
        order,
        // A capstone's sandbox wiring comes from code, and it completes
        // through that sandbox, never a quiz.
        ...(base?.capstone ? { capstone: base.capstone, quiz: [] } : {}),
      });
    } else if (base) {
      sections.push({ ...base, order });
    }
  }

  return catalogFrom(sections, courses);
}

function catalogFrom(
  sections: AcademySection[],
  courses: Course[],
): AcademyCatalog {
  const sectionBySlug = new Map(sections.map((s) => [s.slug, s]));
  const courseBySlug = new Map(courses.map((c) => [c.slug, c]));
  const courseByModule = new Map<string, Course>();
  for (const c of courses) {
    for (const m of c.moduleSlugs) courseByModule.set(m, c);
  }
  const moduleCourseIndex = (slug: string) => {
    const course = courseByModule.get(slug);
    if (!course) return null;
    return { course, index: course.moduleSlugs.indexOf(slug) };
  };
  return {
    sections,
    courses,
    themes: ACADEMY_THEMES,
    requiredSectionCount: sections.filter((s) => s.optional !== true).length,
    capstoneSections: sections.filter((s) => s.capstone != null),
    getSection: (slug) => sectionBySlug.get(slug),
    getCourse: (slug) => courseBySlug.get(slug),
    courseForModuleSlug: (slug) => courseByModule.get(slug),
    moduleCourseIndex,
    previousModuleInCourse: (slug) => {
      const hit = moduleCourseIndex(slug);
      if (!hit || hit.index <= 0) return null;
      return hit.course.moduleSlugs[hit.index - 1];
    },
    nextModuleInCourse: (slug) => {
      const hit = moduleCourseIndex(slug);
      if (!hit) return null;
      return hit.course.moduleSlugs[hit.index + 1] ?? null;
    },
    courseModules: (courseSlug) =>
      (courseBySlug.get(courseSlug)?.moduleSlugs ?? [])
        .map((s) => sectionBySlug.get(s))
        .filter((s): s is AcademySection => s != null),
    coursesForTheme: (key) => courses.filter((c) => c.themeKey === key),
    requiredModuleSlugsForCourse: (courseSlug) =>
      (courseBySlug.get(courseSlug)?.moduleSlugs ?? []).filter(
        (s) => sectionBySlug.get(s)?.optional !== true,
      ),
  };
}

/** The catalog with nothing edited — identical to the static helpers. */
export const BUILT_IN_ACADEMY_CATALOG: AcademyCatalog = buildAcademyCatalog([]);
