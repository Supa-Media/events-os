# Academy 2026 revamp — role-based paths + culture consolidation

**Status: IMPLEMENTED — foundation shipped in PR #243 + parallel stream-content work.**

The Academy is the org's canonical training — it teaches both the app and Public
Worship's culture simultaneously. This revamp refactors the catalog from flat
streams to a dynamic role-based path system, consolidates the sprawling Notion
wiki into cohesive courses, and establishes a sustainable update cadence via the
CLAUDE.md guardrail.

## Goals

- **Role-based learning paths** — every org seat (Chapter Director, Treasurer,
  Planner, etc.) has a curated course path; paths are *recommendations*, not
  gates — all courses remain visible to everyone so aspiring leaders can prepare
  for future roles.
- **Culture ↔ product convergence** — merge the private Notion wiki (Public
  Worship "how we work") into Academy courses: give a course a "further reading"
  link to a Notion section rather than asking people to maintain two truths.
- **Reusable, scalable content** — courses are defined by slug, reused across
  multiple role paths. A "The chapter money model" course shared by Treasurer
  and Chapter Director need only be written once; completions carry across
  assignments to different roles.
- **Sustainable governance** — the CLAUDE.md guardrail ensures every PR that
  changes user-facing behavior examines whether the Academy should change.
  Structural integrity checks (`packages/shared/src/academy.test.ts`) catch
  drift; the guardrail catches stale lessons.

## Principles

1. **Roles recommend; never restrict.** All courses are visible to everyone.
   When a person is assigned to a new role, the path unlocks a curated reading
   order, not a gate. A person who vacated a seat but is exploring a future role
   can self-study that path anytime.

2. **Reuse over duplication.** A role path is an ordered playlist of shared
   course slugs, keyed by org-chart seat slug (defined in
   `packages/shared/src/seats.ts`, rendered dynamically via role assignments).
   Course completions carry across paths: if you've completed "The chapter
   money model," your Treasurer completion is reused when you step into a
   Chapter Director role later.

3. **Closely-related roles share core and fork craft.** A Treasurer and Chapter
   Director both need foundational money lessons (shared "The chapter money
   model" course) but diverge on specialized operations (separate Treasurer
   operations and Director people-leadership courses). This shapes which courses
   are assigned to which seats without duplication.

4. **Every feature PR asks whether the Academy needs updating.** See CLAUDE.md
   § "The Academy Must Track the Product".

## Catalog Direction

### Streams (today: 4 → new: 7)

The catalog grows from 4 flat streams (Events, Management, Leadership, Onboarding)
to 7 thematic streams, each containing ~3–4 courses, for ~24 total courses vs.
today's 15.

**Existing streams expanded:**
- **Events** (3 courses) → new role-course split per events-os event leadership
  roles (Planner, Comms, Logistics). Intro course shared by all.
- **Management** (2 courses) → renamed **Finance** (4–5 courses): money model
  (shared), Treasurer operations, Chapter Director, central roles, reconciliation.

**New streams:**
- **Foundations** (3 courses) — "Welcome to Public Worship" + "How we work"
  (distilled from Notion wiki) + onboarding. First-read for all people.
- **Music** (4 courses) — "Doxology: what we sing", "Leading worship",
  "Producing & artistry", "Music team operations". Seeded with lesson placeholders
  until Music Director details out the content.
- **Marketing & Media** (3 courses) — "Brand & voice", "Short-form editing",
  "Media pipeline". Consolidates social/comms/content direction.
- **Leadership** (expanded, 4–5 courses) — "The Director standard", "Growing
  the team", "Partnerships", specialized track for central roles.

**Deliberately not yet authored:**
- Set-building and chapter-launch capstones — marked "coming soon" pending
  owner input on curriculum.
- Central-specific onboarding (awaits org structure clarity on central roles
  beyond top-level Exec).

### Content sources

- **Lessons and quizzes** — migrated from `packages/shared/src/academy.ts`
  (today's 14 quiz sections remain; authors continue in code).
- **Notion wiki excerpts** — the now-private Notion team wiki (Culture, Hiring,
  Finance mechanics, People processes) is archived at authoring time. Key
  sections are distilled into "Further reading" Notion links on course pages;
  the Academy teaches "what you need to know", Notion is "why and deeper
  context". Links to `https://www.notion.so/...` within the Content page are
  preserved so workflows don't break; pages are not republished.
- **Capstone mechanics** — today's training-event-linked capstones (existing
  "owning an event" and birthday-party capstones) remain in the Ownership course.
  The capstone test infrastructure (`apps/convex/lib/seed/templates.ts`) is a
  living template library; new capstones are added as features warrant.

## Build sequence

1. **PR #243** (merged) — split monolith `academy.ts` into per-stream files
   (no behavior change). Foundation for parallel content work.

2. **#244** (in flight) — roles view UI: "Recommended for you" course playlist
   + toggle to "All courses". Role paths defined in `academyPaths.ts` keyed by
   seat slug; Convex `roles` table wired in to fetch person's seat and render
   their path.

3. **#245** (planned) — finance stream reshape: split "Running an event" course
   into Planner/Comms/Logistics courses. Add "The chapter money model" (shared
   by Treasurer and Chapter Director, distilled from Notion finance wiki).
   Backfill role paths for Finance roles.

4. **Parallel content PRs** (planned):
   - Foundations stream (onboarding + Public Worship culture collapse).
   - Music stream + role paths.
   - Marketing & Media + role paths.
   - Leadership stream + Director/central role paths.

5. **This PR** (docs/ only) — CLAUDE.md guardrail + revamp plan record.

## Later horizon

- **Finance capstone sandbox** — a real environment where Treasurers learn to
  use reconcile, entries, etc. (blocked on fintech integrations readiness).
- **DB-backed Academy authoring** — courses live in `playbookEntries` table;
  Convex functions (people + AI via OpenRouter) maintain them in-app. Authors
  no longer edit TypeScript; lessons live alongside the real data they teach.
  Readiness depends on the Playbook entry abstraction stabilizing (M5 scope).
- **Seat-change nudge layer** — when a person steps into a new role, send a
  gentle prompt to start their role path (via Inbox or direct message).

## Integrity and Testing

The Academy has a test suite (`packages/shared/src/academy.test.ts`) that verifies:

- Every course slug resolves to a real content object.
- Every role path exists and contains real course slugs.
- No circular or dangling references between themes, courses, and modules.
- Quiz sections still exist when referenced in capstone templates.
- The capstone templates match real training-event platform keys
  (`apps/convex/lib/seed/templates.ts`).

Tests run on CI; when they fail, the PR must fix drift in the Academy data or
the code it references. This is load-bearing — the test cannot catch a lesson
that teaches the wrong thing, only structural inconsistency.

## Reviewer notes

- **No breaking changes to stored data.** `academyProgress` and
  `courseCompletions` tables remain; role paths are computed reads from
  `academyPaths.ts` (code) + a `roles` assignment fetch (DB). Queries are
  backward-compatible.
- **Further-reading links are archival.** The Notion wiki is private after
  2026-07-17 (owners moved it to internal team workspace). Archived course
  pages preserve `notion.so` URLs; if a link breaks (Notion ID changes), update
  the course definition — the Academy teaches the app, not Notion.
- **Role paths are recommendations.** All courses remain visible in the UI.
  Paths surface a curated order; personalization happens at the course level
  (show a badge, highlight the role's recommended path), not at the feature
  gate level.
