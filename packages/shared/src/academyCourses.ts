/**
 * The Academy course/theme layer — the shared catalog structure that groups the
 * flat curriculum (`academy.ts`) into **themes → courses → modules**.
 *
 * This layer is **purely additive and derived**: a course's modules ARE existing
 * `AcademySection` slugs, referenced by slug in intended order. Nothing here
 * changes the curriculum, the unlock chain, or any stored progress — it is the
 * code-authored catalog the redesign (docs/plans/academy-redesign.md, D4) reads
 * on top of today's sections. The migration/badge work lands separately; this
 * file only supplies the structure and the lookups it will gate on.
 *
 * Keystone invariant: **module slug === section slug**, and every one of the 17
 * sections lands in exactly one course (see the integrity check at the bottom).
 * That is what makes the later migration lossless — no `passedAt` is orphaned.
 */

import {
  ACADEMY_SECTIONS,
  getAcademySection,
  type AcademySection,
} from "./academy";

/**
 * A course's difficulty tier — the founder's ask. Courses gate by level order
 * within a theme (see §6.3 of the redesign doc).
 */
export type AcademyLevel = "beginner" | "intermediate" | "advanced" | "leader";

/**
 * What a course *teaches* (the rebrand §5a taxonomy), so courses can later be
 * surfaced contextually ("about to own your first event → the Ownership course").
 *  - `role`      — the remit of one event role (Comms Lead, Event Lead, …)
 *  - `ownership` — accountability doctrine + hands-on capstones
 *  - `team`      — cross-team / whole-crew content
 */
export type AcademyAudience = "role" | "ownership" | "team";

/** Code-defined grouping of courses. Management/Leadership start empty. */
export type AcademyThemeKey = "events" | "management" | "leadership";

/** One theme: a titled grouping courses belong to via `themeKey`. */
export interface Theme {
  key: AcademyThemeKey;
  title: string;
}

/**
 * One course: a titled, levelled, audience-tagged ordered path through existing
 * curriculum modules. `moduleSlugs` are EXISTING `AcademySection` slugs, in the
 * intended teaching order for this course (which may differ from the flat
 * curriculum order — e.g. `being-an-owner` sits with the ownership capstones).
 */
export interface Course {
  slug: string;
  themeKey: AcademyThemeKey;
  title: string;
  level: AcademyLevel;
  audience: AcademyAudience;
  description: string;
  /** Existing section slugs, in this course's intended order. */
  moduleSlugs: string[];
}

/**
 * The themes, in display order. `events` is populated below; `management` and
 * `leadership` are defined with zero courses for now and fill as content is
 * written (redesign §3).
 */
export const ACADEMY_THEMES: Theme[] = [
  { key: "events", title: "Events" },
  { key: "management", title: "Management" },
  { key: "leadership", title: "Leadership" },
];

/**
 * The courses, in catalog order. Exactly the four Events-theme courses the
 * founder decided on 2026-07-13 (redesign §3). Every module slug below is an
 * existing section slug; the union of all four covers all 17 sections exactly
 * once (asserted by `assertCourseCatalogIntegrity` at module load).
 */
export const ACADEMY_COURSES: Course[] = [
  {
    slug: "chapter-os-fundamentals",
    themeKey: "events",
    title: "Chapter OS fundamentals",
    level: "beginner",
    audience: "role",
    description:
      "The conceptual intro everyone needs, plus the two cross-cutting " +
      "product-literacy tabs (Debrief and the assistant) every role uses.",
    moduleSlugs: [
      "what-is-events-os",
      "organizers-and-crew",
      "anatomy-of-an-event",
      "timing-and-offsets",
      "phase-rings",
      "tab-debrief",
      "using-the-assistant",
    ],
  },
  {
    slug: "comms-lead",
    themeKey: "events",
    title: "Comms Lead",
    level: "intermediate",
    audience: "role",
    description:
      "The Comms Lead's remit at Public Worship: crew coordination + comms.",
    moduleSlugs: ["tab-crew-duties", "tab-comms"],
  },
  {
    slug: "event-lead",
    themeKey: "events",
    title: "Event Lead",
    level: "intermediate",
    audience: "role",
    description: "The Event Lead's remit: tasks, run of show, and permitting.",
    moduleSlugs: ["tab-tasks", "tab-run-of-show", "tab-permits"],
  },
  {
    slug: "logistics-lead",
    themeKey: "events",
    title: "Logistics Lead",
    level: "intermediate",
    audience: "role",
    description:
      "The Logistics Lead's remit: supplies & logistics. One module today; " +
      "gains a keeping-inventory module when the typed Inventory feature ships.",
    moduleSlugs: ["tab-supplies"],
  },
  {
    slug: "owning-an-event",
    themeKey: "events",
    title: "Owning an event",
    level: "advanced",
    audience: "ownership",
    description:
      "Accountability doctrine + the hands-on capstones. The worship capstone " +
      "is an optional bonus and does not gate the course badge.",
    moduleSlugs: [
      "being-an-owner",
      "capstone-join-an-event",
      "capstone-birthday-party",
      "capstone-worship-event",
    ],
  },
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
