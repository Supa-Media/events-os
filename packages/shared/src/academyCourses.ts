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

/**
 * Code-defined grouping of courses — the Academy's three STREAMS (the
 * founder's 2026-07-14 structure): running events, ongoing works (projects &
 * duties), and management (leading the people who do both).
 */
export type AcademyThemeKey = "events" | "works" | "management";

/** One stream: a titled grouping courses belong to via `themeKey`. */
export interface Theme {
  key: AcademyThemeKey;
  title: string;
  /** One-line promise of what the stream trains. */
  subtitle: string;
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
  /**
   * The course's glyph — a Feather icon name (the set the mobile `Icon`
   * component draws from). Kept as a plain string here because this package
   * can't depend on the icon font's types; the UI narrows it at the callsite.
   */
  icon: string;
  /** Existing section slugs, in this course's intended order. */
  moduleSlugs: string[];
}

/**
 * The streams, in display order. Every stream renders on the Academy hub —
 * vertically stacked, each with a horizontal rail of course tiles.
 */
export const ACADEMY_THEMES: Theme[] = [
  {
    key: "events",
    title: "Events",
    subtitle: "Plan and run events nobody has to rescue.",
  },
  {
    key: "works",
    title: "Works",
    subtitle: "Projects & duties — the chapter's ongoing work between events.",
  },
  {
    key: "management",
    title: "Management",
    subtitle:
      "Lead the people: 1:1s, delegation, and care that still holds the line.",
  },
];

/**
 * The courses, in catalog order, grouped by stream. Every role course ends in
 * a hands-on CAPSTONE particular to that role (founder 2026-07-14) — the badge
 * means demonstrated ability in a sandbox, not just passed quizzes. Every
 * module slug below is an existing section slug; the union of all courses
 * covers every section exactly once (asserted by
 * `assertCourseCatalogIntegrity` at module load).
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
    icon: "compass",
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
      "The Comms Lead's remit at Public Worship: crew coordination + comms, " +
      "capped by a hands-on capstone — write the duties, recruit the crew.",
    icon: "message-circle",
    moduleSlugs: ["tab-crew-duties", "tab-comms", "capstone-comms-lead"],
  },
  {
    slug: "event-lead",
    themeKey: "events",
    title: "Event Lead",
    level: "intermediate",
    audience: "role",
    description:
      "The Event Lead's remit: tasks, run of show, and permitting — then a " +
      "capstone where you rescue a drifting plan for real.",
    icon: "clipboard",
    moduleSlugs: [
      "tab-tasks",
      "tab-run-of-show",
      "tab-permits",
      "capstone-event-lead",
    ],
  },
  {
    slug: "logistics-lead",
    themeKey: "events",
    title: "Logistics Lead",
    level: "intermediate",
    audience: "role",
    description:
      "The Logistics Lead's remit: supplies & logistics, capped by a " +
      "hands-on capstone. Gains a keeping-inventory module when the typed " +
      "Inventory feature ships.",
    icon: "package",
    moduleSlugs: ["tab-supplies", "capstone-logistics-lead"],
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
    icon: "key",
    moduleSlugs: [
      "being-an-owner",
      "capstone-join-an-event",
      "capstone-birthday-party",
      "capstone-worship-event",
    ],
  },

  // ── Works stream — projects & duties ────────────────────────────────────────
  {
    slug: "projects",
    themeKey: "works",
    title: "Projects",
    level: "beginner",
    audience: "team",
    description:
      "Finite work with one owner and a finish line: purpose, status, " +
      "deadline, blockers, and driving it to done.",
    icon: "briefcase",
    moduleSlugs: ["works-projects", "works-driving-a-project"],
  },
  {
    slug: "duties",
    themeKey: "works",
    title: "Duties",
    level: "beginner",
    audience: "team",
    description:
      "The work that never finishes: cadences, fan-out to roles, runbooks, " +
      "and handoffs that don't need a meeting.",
    icon: "repeat",
    moduleSlugs: ["works-duties", "works-owning-a-duty"],
  },

  // ── Management stream — leading the people ─────────────────────────────────
  {
    slug: "the-one-on-one",
    themeKey: "management",
    title: "The one-on-one",
    level: "leader",
    audience: "team",
    description:
      "The manager's basic unit: person first, the two pulses, then the " +
      "work — and feedback that travels up the chain.",
    icon: "coffee",
    moduleSlugs: ["mgmt-one-on-one", "mgmt-reviewing-the-work"],
  },
  {
    slug: "care-and-accountability",
    themeKey: "management",
    title: "Care & accountability",
    level: "leader",
    audience: "team",
    description:
      "Caring for people while holding the line: load, rotation, gratitude — " +
      "and the action ladder for when work isn't happening.",
    icon: "heart",
    moduleSlugs: ["mgmt-caring-for-people", "mgmt-holding-the-line"],
  },
  {
    slug: "directing",
    themeKey: "management",
    title: "Directing",
    level: "leader",
    audience: "team",
    description:
      "The director's philosophy: the manager tree, the oversight dial per " +
      "person, and building a team that runs without you.",
    icon: "users",
    moduleSlugs: ["mgmt-the-org-tree", "mgmt-director-philosophy"],
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
