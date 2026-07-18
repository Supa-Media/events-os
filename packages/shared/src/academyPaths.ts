/**
 * ROLE PATHS — the seat-keyed "role path" layer for the org-chart Roles view.
 *
 * A **role path** is an ordered playlist of Academy course slugs (see the
 * course catalog in `./academy`) that a person holding a given org-chart seat (or a
 * per-event "event hat") is expected to work through. This file is the pure
 * DATA + LOOKUPS layer (Deliverable 1); the Roles-view UI is built on top of
 * these exports.
 *
 * ── The `(kind, seatSlug)` identity, and why `seatSlug` alone is ambiguous ──
 *
 * A `RolePath` is identified by the TUPLE `(kind, seatSlug)`, never `seatSlug`
 * alone. There are TWO namespaces:
 *
 *  - `kind: "seat"` — `seatSlug` is a real org-chart SEAT slug from the seat
 *    taxonomy (`SEAT_IDS`/`SEAT_DEFS` in `seats.ts`), using UNDERSCORES, e.g.
 *    `"event_lead"`, `"chapter_director"`, `"treasurer"`. The derived-only
 *    rollup seat `"chapter_directors"` gets NO role path (it is never directly
 *    assigned) and must never appear here.
 *
 *  - `kind: "event_hat"` — `seatSlug` is a per-event ROLE KEY
 *    (`LIGHTWEIGHT_ROLE_KEYS` / `DEFAULT_ROLES` keys in `index.ts`) —
 *    `"comms_lead"`, `"event_lead"`, `"logistics_lead"` — OR the universal
 *    sentinel `"everyone"` (new members). An "event hat" is the hat someone
 *    wears for a single event, distinct from a standing seat. It is NOT
 *    validated against the seat taxonomy. There is deliberately NO "event_hat"
 *    type anywhere else in the codebase — it exists only as this `kind` value.
 *
 * CONFUSINGLY, the string `"event_lead"` lives in BOTH namespaces: it is a role
 * key for the per-event Event Lead hat AND a real standing chapter seat. So
 * `ROLE_PATHS` contains TWO separate array elements with `seatSlug:
 * "event_lead"` — one `{ kind: "event_hat" }`, one `{ kind: "seat" }`. Callers
 * MUST always disambiguate by the `(kind, seatSlug)` tuple; looking up by
 * `seatSlug` alone would collide.
 *
 * Note also: course slugs use DASHES (`"chapter-director"`,
 * `"executive-director"`, `"financial-manager"`) while the corresponding seat
 * slugs use UNDERSCORES (`"chapter_director"`, …). They are different strings;
 * there are no real collisions.
 *
 * Course catalog + curriculum come from `./academy`, which
 * this module only READS. `assertRolePathIntegrity()` runs at module load (same
 * fail-fast style as `assertCourseCatalogIntegrity`) so any drift between a
 * role path and the real course catalog / seat taxonomy fails typecheck-time
 * imports rather than surfacing as a silent gap.
 */

import {
  getAcademyCourse,
  getAcademySection,
  requiredModuleSlugsForCourse,
  type AcademySection,
} from "./academy";
import { SEAT_DEFS, SEAT_IDS } from "./seats";

/**
 * One role path: an ordered course playlist for a seat or event hat.
 *
 * See the module header for the `(kind, seatSlug)` identity rule — `seatSlug`
 * alone is NOT unique (`"event_lead"` appears under both kinds).
 */
export interface RolePath {
  /**
   * For `kind: "seat"`: a real seat slug from the seat taxonomy (underscores),
   * never the derived-only `"chapter_directors"`.
   * For `kind: "event_hat"`: a per-event role key (`"comms_lead"` |
   * `"event_lead"` | `"logistics_lead"`) or the `"everyone"` sentinel — NOT
   * validated against seat definitions.
   */
  seatSlug: string;
  kind: "seat" | "event_hat";
  title: string;
  /** A Feather icon name — same vocabulary as `Course.icon` in
   *  the `./academy` course catalog; narrowed to the icon set at the UI callsite. */
  icon: string;
  /** Ordered course slugs. Every entry must exist in `ACADEMY_COURSES`, with no
   *  duplicates within this one path (asserted at load). May be empty for a
   *  path whose courses are all still `comingSoon`. */
  courseSlugs: string[];
  /** Display-only labels for planned-but-unwritten courses. Rendered muted at
   *  the end of the path; NOT validated against the catalog (they aren't real
   *  course slugs yet). */
  comingSoon?: string[];
}

/**
 * The role paths, in display order: the universal/event-hat paths first, then
 * chapter seats, then central seats.
 *
 * Kept as a flat array of plain object literals on purpose ("simplicity first"
 * — no indirection): prepending a future universal "Foundations" trio to any
 * path later is a trivial edit to that path's `courseSlugs` literal.
 */
export const ROLE_PATHS: RolePath[] = [
  // ── Event hats / universal (kind: "event_hat") ──────────────────────────────
  // The "everyone" path is the Foundations trio (org onboarding). The other
  // three hats are event-scoped, NOT org onboarding, so they start with
  // chapter-os-fundamentals — not the trio.
  {
    seatSlug: "everyone",
    kind: "event_hat",
    title: "New member",
    icon: "user-plus",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
    ],
  },
  {
    seatSlug: "comms_lead",
    kind: "event_hat",
    title: "Comms Lead",
    icon: "message-square",
    courseSlugs: ["chapter-os-fundamentals", "comms-lead"],
  },
  {
    seatSlug: "event_lead",
    kind: "event_hat",
    title: "Event Lead",
    icon: "flag",
    courseSlugs: ["chapter-os-fundamentals", "event-lead"],
  },
  {
    seatSlug: "logistics_lead",
    kind: "event_hat",
    title: "Logistics Lead",
    icon: "truck",
    courseSlugs: ["chapter-os-fundamentals", "logistics-lead"],
  },

  // ── Chapter seats (kind: "seat") ────────────────────────────────────────────
  // Every seat path starts with the Foundations trio
  // (welcome-to-public-worship, how-we-work, finances-for-everyone).
  {
    seatSlug: "event_organizers",
    kind: "seat",
    title: "Event Organizer",
    icon: "users",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "chapter-os-fundamentals",
    ],
  },
  {
    seatSlug: "event_lead",
    kind: "seat",
    title: "Event Lead",
    icon: "flag",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "chapter-os-fundamentals",
      "event-lead",
      "owning-an-event",
      "projects",
      "leading-a-project",
    ],
  },
  {
    seatSlug: "production_coordinator",
    kind: "seat",
    title: "Production Coordinator",
    icon: "tool",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "chapter-os-fundamentals",
      "logistics-lead",
      "media-pipeline",
    ],
    comingSoon: ["Production craft"],
  },
  {
    seatSlug: "marketing_lead",
    kind: "seat",
    title: "Marketing Lead",
    icon: "share-2",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "brand-and-voice",
      "comms-lead",
    ],
    comingSoon: [
      "Short-form editing (Marketing Director is authoring current guidance)",
    ],
  },
  {
    seatSlug: "music_lead",
    kind: "seat",
    title: "Music Lead",
    icon: "music",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "doxology-what-we-sing",
      "leading-worship",
    ],
  },
  {
    seatSlug: "vocal_lead",
    kind: "seat",
    title: "Vocal Lead",
    icon: "mic",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "doxology-what-we-sing",
      "leading-worship",
    ],
  },
  {
    seatSlug: "band_lead",
    kind: "seat",
    title: "Band Lead",
    icon: "disc",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "doxology-what-we-sing",
      "leading-worship",
    ],
  },
  {
    seatSlug: "treasurer",
    kind: "seat",
    title: "Treasurer",
    icon: "dollar-sign",
    // F-6: deliberately NOT given a Development-stream course. The Treasurer
    // holds `giving.view` too, but their job is recording money (Reconcile),
    // not raising it — the updated chapter-money-model course (see
    // finance-tiers-and-skim) already teaches that the backer count feeding
    // their dashboard is now reported from the Giving page. See the PR
    // body's explicit decision.
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "chapter-money-model",
      "treasurer",
    ],
  },
  {
    seatSlug: "chapter_director",
    kind: "seat",
    title: "Chapter Director",
    icon: "compass",
    // F-6: the Chapter Director is "the seat that raises money (backers)"
    // (giving PRD §6) and holds chapter-lens `giving.view` — giving-fundamentals
    // (the vocabulary + CRM basics they can see) and the-backer-model (the
    // $50 floor, the ladder, the Stripe lifecycle) are directly their raising
    // job. donor-stewardship and sponsorships-and-partnerships are
    // deliberately left off this path: backfill/import needs `giving.manage`
    // (central-only today, see the PR body's discrepancy note), and
    // sponsorships is a central-lens-only desk — see the PR body for the
    // explicit decision.
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "chapter-os-fundamentals",
      "owning-an-event",
      "leading-a-project",
      "the-one-on-one",
      "care-and-accountability",
      "the-director-standard",
      "growing-the-team",
      "chapter-money-model",
      "chapter-director",
      "partnerships",
      "giving-fundamentals",
      "the-backer-model",
    ],
  },

  // ── Central seats (kind: "seat") ────────────────────────────────────────────
  {
    seatSlug: "executive_director",
    kind: "seat",
    title: "Executive Director",
    icon: "briefcase",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "directing",
      "the-director-standard",
      "growing-the-team",
      "chapter-money-model",
      "executive-director",
      "financial-manager",
      "partnerships",
    ],
  },
  {
    seatSlug: "financial_manager",
    kind: "seat",
    title: "Financial Manager",
    icon: "trending-up",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "chapter-money-model",
      "treasurer",
      "financial-manager",
    ],
  },
  {
    seatSlug: "development_director",
    kind: "seat",
    title: "Development Director",
    icon: "gift",
    // F-6: the seat's coming-soon placeholder is fulfilled — the full
    // Development stream (giving vocabulary, donor stewardship, the backer
    // model, sponsorships & partnerships, the city-launch story).
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "partnerships",
      "growing-the-team",
      "the-director-standard",
      "giving-fundamentals",
      "donor-stewardship",
      "the-backer-model",
      "sponsorships-and-partnerships",
      "the-city-launch-story",
    ],
  },
  {
    seatSlug: "partnership_associate",
    kind: "seat",
    title: "Partnership Associate",
    icon: "users",
    // F-6: partnerships is the associate's whole remit — the vocabulary
    // course plus the institutional-giving desk (packages, pipeline, church
    // partnership principles).
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "partnerships",
      "giving-fundamentals",
      "sponsorships-and-partnerships",
    ],
  },
  {
    seatSlug: "fundraising_associate",
    kind: "seat",
    title: "Fundraising Associate",
    icon: "gift",
    // F-6: fundraising is donors + backers — the vocabulary course, donor
    // stewardship, and the backer model (Givebutter migration included).
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "partnerships",
      "giving-fundamentals",
      "donor-stewardship",
      "the-backer-model",
    ],
  },
  {
    seatSlug: "music_director",
    kind: "seat",
    title: "Music Director",
    icon: "music",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "doxology-what-we-sing",
      "leading-worship",
      "producing-and-artistry",
      "the-one-on-one",
      "the-director-standard",
    ],
  },
  {
    seatSlug: "a_and_r",
    kind: "seat",
    title: "A&R",
    icon: "headphones",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "doxology-what-we-sing",
      "producing-and-artistry",
    ],
  },
  {
    seatSlug: "artists",
    kind: "seat",
    title: "Artists",
    icon: "feather",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "doxology-what-we-sing",
      "producing-and-artistry",
    ],
  },
  {
    seatSlug: "musicians",
    kind: "seat",
    title: "Musicians",
    icon: "music",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "doxology-what-we-sing",
      "producing-and-artistry",
    ],
  },
  {
    seatSlug: "songwriters",
    kind: "seat",
    title: "Songwriters",
    icon: "edit-3",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "doxology-what-we-sing",
      "producing-and-artistry",
    ],
  },
  {
    seatSlug: "marketing_director",
    kind: "seat",
    title: "Marketing Director",
    icon: "trending-up",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "brand-and-voice",
      "media-pipeline",
      "the-director-standard",
    ],
    comingSoon: [
      "Short-form editing (Marketing Director is authoring current guidance)",
    ],
  },
  {
    seatSlug: "social_media_manager",
    kind: "seat",
    title: "Social Media Manager",
    icon: "share-2",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "brand-and-voice",
    ],
    comingSoon: [
      "Short-form editing (Marketing Director is authoring current guidance)",
    ],
  },
  {
    seatSlug: "graphic_designer",
    kind: "seat",
    title: "Graphic Designer",
    icon: "pen-tool",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "brand-and-voice",
    ],
    comingSoon: [
      "Short-form editing (Marketing Director is authoring current guidance)",
    ],
  },
  {
    seatSlug: "marketing_associate",
    kind: "seat",
    title: "Marketing Associate",
    icon: "share-2",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "brand-and-voice",
    ],
    comingSoon: [
      "Short-form editing (Marketing Director is authoring current guidance)",
    ],
  },
  {
    seatSlug: "expansion_director",
    kind: "seat",
    title: "Expansion Director",
    icon: "map",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "chapter-os-fundamentals",
      "owning-an-event",
      "leading-a-project",
      "the-one-on-one",
      "care-and-accountability",
      "the-director-standard",
      "growing-the-team",
      "chapter-money-model",
      "chapter-director",
      "partnerships",
    ],
    comingSoon: ["Launching a chapter"],
  },
  {
    seatSlug: "recruiting_associate",
    kind: "seat",
    title: "Recruiting Associate",
    icon: "user-plus",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "growing-the-team",
    ],
  },
  {
    seatSlug: "training_associate",
    kind: "seat",
    title: "Training Associate",
    icon: "book-open",
    courseSlugs: [
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
      "growing-the-team",
    ],
  },
];

/**
 * Valid `kind: "seat"` slugs: every real seat EXCEPT derived-only seats
 * (`chapter_directors`). Built from the seat taxonomy so it can never drift
 * from `seats.ts`. `kind: "event_hat"` slugs are intentionally NOT constrained
 * to this set.
 */
const ASSIGNABLE_SEAT_SLUGS: ReadonlySet<string> = new Set(
  SEAT_IDS.filter((id) => SEAT_DEFS[id].derived !== true),
);

/** Look up a single path by its `(kind, seatSlug)` identity. Returns undefined
 *  if no path matches. Always pass BOTH — `seatSlug` alone is ambiguous
 *  (`"event_lead"` exists under both kinds). */
export function getRolePath(
  kind: "seat" | "event_hat",
  seatSlug: string,
): RolePath | undefined {
  return ROLE_PATHS.find((p) => p.kind === kind && p.seatSlug === seatSlug);
}

/**
 * The union of required module slugs across every course in the path, in course
 * order (a course's OPTIONAL modules — e.g. the worship capstone — are excluded
 * via `requiredModuleSlugsForCourse`). Deduped through a Set so each module is
 * counted once even in the (by-construction impossible) case of overlap. This
 * is the denominator for path progress.
 */
export function requiredModuleSlugsForPath(path: RolePath): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const courseSlug of path.courseSlugs) {
    for (const moduleSlug of requiredModuleSlugsForCourse(courseSlug)) {
      if (!seen.has(moduleSlug)) {
        seen.add(moduleSlug);
        result.push(moduleSlug);
      }
    }
  }
  return result;
}

/**
 * Progress through a path given the caller's set of passed required-module
 * slugs (the UI builds it from `myProgress().sections.filter(s => s.passed)
 * .map(s => s.slug)`, mirroring the per-course progress formula in
 * `academy.tsx` / `course/[slug].tsx`).
 *
 * `total` is the count of required modules across the path's courses; a path
 * with no (written) courses yet has `total === 0`, for which `fraction` is 0 —
 * a coming-soon-only path is treated as "nothing to complete yet", never a full
 * bar.
 */
export function rolePathProgress(
  path: RolePath,
  passedSlugs: Set<string>,
): { completed: number; total: number; fraction: number } {
  const required = requiredModuleSlugsForPath(path);
  const total = required.length;
  const completed = required.filter((slug) => passedSlugs.has(slug)).length;
  const fraction = total === 0 ? 0 : completed / total;
  return { completed, total, fraction };
}

/**
 * The first not-yet-passed required module across the path's courses, in course
 * order (then module order within each course), as its `AcademySection` — or
 * `null` when the path has no remaining required modules (fully complete, or no
 * written courses). The UI renders `.title` as the "Next: <title> →" row.
 */
export function nextIncompleteModuleForPath(
  path: RolePath,
  passedSlugs: Set<string>,
): AcademySection | null {
  for (const courseSlug of path.courseSlugs) {
    for (const moduleSlug of requiredModuleSlugsForCourse(courseSlug)) {
      if (!passedSlugs.has(moduleSlug)) {
        return getAcademySection(moduleSlug) ?? null;
      }
    }
  }
  return null;
}

/**
 * Role-path integrity, asserted at module load (same fail-fast style as
 * `assertCourseCatalogIntegrity`). Throws a descriptive `Error` if a role path
 * ever drifts from the real course catalog or seat taxonomy:
 *
 *  1. every `courseSlugs` entry resolves via `getAcademyCourse`,
 *  2. no duplicate course slug within a single path,
 *  3. every `kind: "seat"` path targets a real, assignable seat slug (never the
 *     derived-only `chapter_directors`),
 *  4. no duplicate `(kind, seatSlug)` tuple across the whole array.
 */
export function assertRolePathIntegrity(): void {
  const seenTuples = new Set<string>();

  for (const path of ROLE_PATHS) {
    const label = `${path.kind}:${path.seatSlug}`;

    // (4) no duplicate (kind, seatSlug) tuple
    if (seenTuples.has(label)) {
      throw new Error(
        `Role paths: duplicate (kind, seatSlug) tuple "${label}" — each ` +
          `role path must be uniquely identified by its (kind, seatSlug).`,
      );
    }
    seenTuples.add(label);

    // (3) kind "seat" must be a real, assignable seat slug
    if (path.kind === "seat") {
      if (path.seatSlug === "chapter_directors") {
        throw new Error(
          `Role paths: seat "chapter_directors" is derived-only (auto-rollup) ` +
            `and must never have a role path.`,
        );
      }
      if (!ASSIGNABLE_SEAT_SLUGS.has(path.seatSlug)) {
        throw new Error(
          `Role paths: seat path "${label}" references unknown seat slug ` +
            `"${path.seatSlug}" (not in the seat taxonomy, or derived-only).`,
        );
      }
    }

    // (1) + (2) course slugs resolve and are unique within the path
    const seenCourses = new Set<string>();
    for (const courseSlug of path.courseSlugs) {
      if (getAcademyCourse(courseSlug) === undefined) {
        throw new Error(
          `Role paths: path "${label}" references unknown course slug ` +
            `"${courseSlug}" (no matching Course in ACADEMY_COURSES).`,
        );
      }
      if (seenCourses.has(courseSlug)) {
        throw new Error(
          `Role paths: path "${label}" lists course slug "${courseSlug}" ` +
            `more than once.`,
        );
      }
      seenCourses.add(courseSlug);
    }
  }
}

// Run the invariant once, at module load, so a role-path / catalog / seat drift
// fails fast (typecheck imports this module) rather than surfacing silently.
assertRolePathIntegrity();
