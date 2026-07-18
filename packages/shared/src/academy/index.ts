/**
 * The Academy — assembles the seven content streams (Foundations, Events,
 * Works, Management, Finances, Music, Marketing & Media) into the flat
 * curriculum and course/theme catalog that the mobile Academy screens and
 * the Convex grading backend read.
 *
 * This is the ONLY file that concatenates streams — it exists so a
 * mid-curriculum insert or a stream re-order is a one-line change here, and
 * so the stream files (`./streams/*`) can be authored in parallel with
 * zero merge overlap. Do not add sections or courses directly here; add them
 * to the owning stream file and this module assembles them.
 *
 * `order` is DERIVED from array position (see `ACADEMY_SECTIONS` below) so a
 * mid-curriculum insert can never silently break the sequential-unlock chain
 * with duplicate or gapped order numbers.
 *
 * Keystone invariant (course catalog): **module slug === section slug**, and
 * every section lands in exactly one course (see `assertCourseCatalogIntegrity`
 * below). That is what makes the badge/completion migration lossless — no
 * `passedAt` is orphaned.
 */

import {
  FOUNDATIONS_COURSES,
  FOUNDATIONS_SECTIONS,
  FOUNDATIONS_THEME,
} from "./streams/foundations";
import {
  EVENTS_COURSES,
  EVENTS_SECTIONS,
  EVENTS_THEME,
} from "./streams/events";
import { WORKS_COURSES, WORKS_SECTIONS, WORKS_THEME } from "./streams/works";
import {
  MANAGEMENT_COURSES,
  MANAGEMENT_SECTIONS,
  MANAGEMENT_THEME,
} from "./streams/management";
import {
  FINANCES_COURSES,
  FINANCES_SECTIONS,
  FINANCES_THEME,
} from "./streams/finances";
import { MUSIC_COURSES, MUSIC_SECTIONS, MUSIC_THEME } from "./streams/music";
import {
  MARKETING_COURSES,
  MARKETING_SECTIONS,
  MARKETING_THEME,
} from "./streams/marketing";
import type {
  AcademySection,
  AcademyThemeKey,
  Course,
  Theme,
} from "./types";

export * from "./types";
export * from "./quizShuffle";

// The curriculum, in reading order: Foundations first (who we are and how we
// work), then Events, Works, Management, then Finances — the exact order the
// former monolith's flat array used, with Foundations prepended — then
// Music, then Marketing & Media, both appended after Finances (Marketing &
// Media added after Music; sibling stream PRs may land concurrently and
// shift this tail, resolved at merge time).
const SECTIONS_IN_ORDER: Omit<AcademySection, "order">[] = [
  ...FOUNDATIONS_SECTIONS,
  ...EVENTS_SECTIONS,
  ...WORKS_SECTIONS,
  ...MANAGEMENT_SECTIONS,
  ...FINANCES_SECTIONS,
  ...MUSIC_SECTIONS,
  ...MARKETING_SECTIONS,
];

/**
 * The ordered curriculum. `order` is frozen from array position (1-based) so
 * it is always contiguous — the sequential-unlock chain in the backend walks
 * `order ± 1` and would silently break on duplicated or gapped numbers.
 */
export const ACADEMY_SECTIONS: AcademySection[] = SECTIONS_IN_ORDER.map(
  (s, i) => ({ ...s, order: i + 1 }),
);

/** Total number of curriculum sections (including optional bonus sections). */
export const ACADEMY_SECTION_COUNT = ACADEMY_SECTIONS.length;

/**
 * How many sections count toward "fully trained" — optional bonus sections
 * are excluded. This is the denominator progress UIs and completion counts use.
 */
export const ACADEMY_REQUIRED_SECTION_COUNT = ACADEMY_SECTIONS.filter(
  (s) => s.optional !== true,
).length;

/** The capstone sections, in curriculum order. */
export const ACADEMY_CAPSTONE_SECTIONS: AcademySection[] =
  ACADEMY_SECTIONS.filter((s) => s.capstone != null);

/** Look up a section by slug, or undefined. */
export function getAcademySection(slug: string): AcademySection | undefined {
  return ACADEMY_SECTIONS.find((s) => s.slug === slug);
}

/** The section after this one in curriculum order, or undefined at the end. */
export function nextAcademySection(slug: string): AcademySection | undefined {
  const current = getAcademySection(slug);
  if (!current) return undefined;
  return ACADEMY_SECTIONS.find((s) => s.order === current.order + 1);
}

/** The section before this one in curriculum order, or undefined at the start. */
export function previousAcademySection(
  slug: string,
): AcademySection | undefined {
  const current = getAcademySection(slug);
  if (!current) return undefined;
  return ACADEMY_SECTIONS.find((s) => s.order === current.order - 1);
}

/**
 * The streams, in display order. Every stream renders on the Academy hub —
 * vertically stacked, each with a horizontal rail of course tiles.
 */
export const ACADEMY_THEMES: Theme[] = [
  FOUNDATIONS_THEME,
  EVENTS_THEME,
  WORKS_THEME,
  MANAGEMENT_THEME,
  FINANCES_THEME,
  MUSIC_THEME,
  MARKETING_THEME,
];

/**
 * The courses, in catalog order, grouped by stream. Every role course ends in
 * a hands-on CAPSTONE particular to that role (founder 2026-07-14) — the badge
 * means demonstrated ability in a sandbox, not just passed quizzes. Every
 * module slug is an existing section slug; the union of all courses covers
 * every section exactly once (asserted by `assertCourseCatalogIntegrity` at
 * module load).
 */
export const ACADEMY_COURSES: Course[] = [
  ...FOUNDATIONS_COURSES,
  ...EVENTS_COURSES,
  ...WORKS_COURSES,
  ...MANAGEMENT_COURSES,
  ...FINANCES_COURSES,
  ...MUSIC_COURSES,
  ...MARKETING_COURSES,
];

/** Look up a course by slug, or undefined. */
export function getAcademyCourse(slug: string): Course | undefined {
  return ACADEMY_COURSES.find((c) => c.slug === slug);
}

/**
 * The course a given section slug belongs to, or undefined if the slug is not
 * mapped into any course. Every section maps to exactly one course, so this is
 * unambiguous (guaranteed by the integrity check).
 */
export function courseForModuleSlug(sectionSlug: string): Course | undefined {
  return ACADEMY_COURSES.find((c) => c.moduleSlugs.includes(sectionSlug));
}

/**
 * The course a section slug belongs to plus its 0-based position in that
 * course's `moduleSlugs`, or null if the slug maps to no course. This is the
 * anchor for PER-COURSE sequential unlock: a module unlocks off the module
 * before it IN ITS OWN COURSE, not off the global curriculum order.
 */
export function moduleCourseIndex(
  sectionSlug: string,
): { course: Course; index: number } | null {
  const course = courseForModuleSlug(sectionSlug);
  if (!course) return null;
  const index = course.moduleSlugs.indexOf(sectionSlug);
  if (index < 0) return null;
  return { course, index };
}

/**
 * The module slug immediately before this one IN THE SAME COURSE, or null when
 * the slug is first-in-course (no predecessor) or unmapped. This is the unlock
 * predecessor the Academy gates on: a module opens once ITS course-predecessor
 * is passed, and every course's first module opens immediately.
 */
export function previousModuleInCourse(sectionSlug: string): string | null {
  const hit = moduleCourseIndex(sectionSlug);
  if (!hit || hit.index === 0) return null;
  return hit.course.moduleSlugs[hit.index - 1];
}

/**
 * The module slug immediately after this one IN THE SAME COURSE, or null when
 * the slug is last-in-course or unmapped.
 */
export function nextModuleInCourse(sectionSlug: string): string | null {
  const hit = moduleCourseIndex(sectionSlug);
  if (!hit) return null;
  return hit.course.moduleSlugs[hit.index + 1] ?? null;
}

/**
 * The ordered `AcademySection` objects for a course's `moduleSlugs`. Unknown
 * course → empty array. Every mapped slug resolves (integrity check), so the
 * result has one entry per module.
 */
export function academyCourseModules(courseSlug: string): AcademySection[] {
  const course = getAcademyCourse(courseSlug);
  if (!course) return [];
  return course.moduleSlugs
    .map((slug) => getAcademySection(slug))
    .filter((s): s is AcademySection => s != null);
}

/** The courses in a theme, in catalog order. */
export function academyCoursesForTheme(themeKey: AcademyThemeKey): Course[] {
  return ACADEMY_COURSES.filter((c) => c.themeKey === themeKey);
}

/**
 * A course's module slugs EXCLUDING any whose `AcademySection` is `optional`
 * (the worship capstone is optional, so it drops out of `owning-an-event`'s
 * required set). This is the set the course-completion badge gates on later.
 */
export function requiredModuleSlugsForCourse(courseSlug: string): string[] {
  const course = getAcademyCourse(courseSlug);
  if (!course) return [];
  return course.moduleSlugs.filter(
    (slug) => getAcademySection(slug)?.optional !== true,
  );
}

/**
 * Catalog integrity, asserted at module load (there is no test harness in this
 * package). Throws if the additive layer ever drifts from the curriculum:
 *
 *  (a) every course module slug resolves to a real `AcademySection`, and
 *  (b) the union of all course module slugs equals EXACTLY the set of all
 *      `ACADEMY_SECTIONS` slugs — no section orphaned, none double-assigned.
 *
 * (b) is the lossless-migration guarantee: every stored `passedAt` re-keys into
 * exactly one course.
 */
export function assertCourseCatalogIntegrity(): void {
  const sectionSlugs = new Set(ACADEMY_SECTIONS.map((s) => s.slug));
  const seen = new Set<string>();

  for (const course of ACADEMY_COURSES) {
    for (const slug of course.moduleSlugs) {
      // (a) resolves to a real section
      if (getAcademySection(slug) === undefined) {
        throw new Error(
          `Academy catalog: course "${course.slug}" references unknown ` +
            `module slug "${slug}" (no matching AcademySection).`,
        );
      }
      // no double-assignment
      if (seen.has(slug)) {
        throw new Error(
          `Academy catalog: module slug "${slug}" is assigned to more than ` +
            `one course (found again in "${course.slug}").`,
        );
      }
      seen.add(slug);
    }
  }

  // (b) no orphaned section
  for (const slug of sectionSlugs) {
    if (!seen.has(slug)) {
      throw new Error(
        `Academy catalog: section "${slug}" is not assigned to any course.`,
      );
    }
  }

  // exact set equality (belt-and-suspenders on the counts)
  if (seen.size !== sectionSlugs.size) {
    throw new Error(
      `Academy catalog: mapped ${seen.size} module slugs but there are ` +
        `${sectionSlugs.size} sections — the sets are not equal.`,
    );
  }
}

// Run the invariant once, at module load, so a catalog/curriculum drift fails
// fast (typecheck imports this module) rather than surfacing as a silent gap.
assertCourseCatalogIntegrity();
