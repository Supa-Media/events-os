# Academy 2026 revamp — role-based paths + culture consolidation

**Status: IN PROGRESS — foundation merged (PR #243); roles view, finance
reshape, and four stream-content PRs in flight.**

The Academy is the org's canonical training — it teaches both the app and
Public Worship's culture. This revamp adds a role-based view on top of the
existing streams, consolidates the Notion wiki into courses, and establishes a
standing update reflex via the CLAUDE.md guardrail ("The Academy Must Track
the Product").

## Goals

- **Role-based learning paths** — every org-chart seat maps to a curated path
  of courses. Paths are *recommendations*, never gates: all courses stay
  visible to everyone, so an aspiring leader can walk a path for a seat they
  don't hold yet ("an event planner today is a chapter director tomorrow").
  Vacant seats keep browsable paths — the role view doubles as a recruiting
  surface.
- **Culture ↔ product convergence** — condense the Notion wiki (mission,
  doxology framework, recruiting pipeline, Director standard, partnerships
  gates, brand/media guides) into quizzable, badgeable courses. The Academy is
  canon; Notion is further reading.
- **Reuse over duplication** — courses are shared across paths by slug;
  completions carry across paths automatically.
- **Sustainable governance** — every feature PR asks "does the Academy need
  updating?" (see CLAUDE.md).

## Principles

1. **Roles recommend; never restrict.** Reading is never gated (unchanged);
   sequential unlock stays per-course; paths add no locks of any kind.
2. **A role path is an ordered playlist of shared course slugs**, keyed by
   org-chart seat slug (`packages/shared/src/seats.ts` SEAT_DEFS) plus the
   per-event hats (comms/event/logistics lead). Defined in
   `packages/shared/src/academyPaths.ts`; joined to `api.seats.mySeatAssignments`
   and existing progress at render time. No new tables.
3. **Closely-related roles share a core and fork thin craft courses.** First
   instance: "The chapter money model" course shared by the Treasurer and
   Chapter Director paths (also FM/ED), with slimmed role-specific courses on
   top. Section slugs never change in reshapes — `academyProgress` is keyed by
   section slug, so all passes and badges survive.
4. **Every feature PR asks whether the Academy needs updating.** See CLAUDE.md
   § "The Academy Must Track the Product".

## Catalog direction

Today: 4 streams (Events, Works, Management, Finances) / 15 courses /
45 sections (39 quiz lessons + 6 sandbox capstones). Target: **7 streams /
~24 courses / ~75 sections.**

- **Foundations** (new) — "Welcome to Public Worship" (mission/vision, org
  shape & seats, the teams) + "How we work" (communication norms, attendance &
  disagree-and-commit, PARA, spending pointer). Every path starts here.
- **Events** — unchanged (Chapter OS fundamentals; Comms Lead; Event Lead;
  Logistics Lead; Owning an event).
- **Works** — unchanged (Projects; Duties); a "Proposing a project" lesson may
  be added to Projects later.
- **People & Leadership** (rename of Management) — keeps The one-on-one, Care &
  accountability, Directing; adds "The Director standard" (SLAs, ownership,
  repair ritual), "Growing the team" (recruiting pipeline: empower first,
  interview, trial, outcome), "Partnerships" (the four gates, routing, final
  yes).
- **Finances** — keeps Finances for Everyone, Financial Manager, Executive
  Director; adds the shared "The chapter money model" core (tiers & skim,
  budget lifecycle, one home per dollar); Treasurer and Chapter Director slim
  to craft-only.
- **Music** (new) — "Doxology: what we sing" (the songwriting/song-selection
  framework, with judge-the-lyric case studies from the doxological song
  catalog); "Leading worship" (song submission; set-building is **coming
  soon** — needs owner input); "Producing & artistry".
- **Marketing & Media** (new) — "Brand & voice"; "Short-form editing"; "Media
  pipeline" (field capture, editing prep, access).

**Deliberately deferred (marked "coming soon" in paths):** set-building
(Music), "Launching a chapter" (Expansion Director path), production craft,
fundraising/donor ops — no written source material exists; these need owner
working sessions, not guesswork.

### Content sources

- Lessons are authored in code as typed blocks
  (`packages/shared/src/academy/streams/*.ts`), one file per stream so content
  PRs parallelize without conflicts (the point of PR #243).
- Notion sources were archived verbatim at authoring time (the site was public
  only briefly). Lessons cite sources and link further reading via internal
  `https://www.notion.so/<page-id>` URLs, which keep working for workspace
  members after unpublishing.
- Capstones (sandbox training events, `apps/convex/lib/seed/templates.ts`)
  are unchanged by this revamp; finance capstones are future work (below).

## Build sequence

1. **PR #243 (merged)** — split the `academy.ts` monolith into per-stream
   files; hardcoded snapshot test + full content diff verified zero behavior
   change.
2. **Roles view** (`feat/academy-roles-view`, in flight) — `academyPaths.ts`
   (ROLE_PATHS + integrity asserts), Tracks/Roles segmented hub, role path
   page (live seat duties, per-course progress, walked-this-path), org-chart
   SeatDetailPanel training block.
3. **Finance reshape** (`feat/academy-finance-core`, in flight) — the shared
   "chapter money model" course (tiers-and-skim moves in; two new lessons:
   budget lifecycle, one home per dollar); CD/Treasurer slim; idempotent
   badge re-award migration.
4. **Four parallel stream-content PRs** (planned) — Foundations; Music;
   People & Leadership additions; Marketing & Media. Each owns one stream
   file; authors work from the archived Notion text and match the existing
   lesson voice.
5. **PR #244 (this PR)** — CLAUDE.md guardrail + this plan record.

## Later horizon

- **Finance capstones** — the finance stream is quiz-only because no money
  sandbox exists; a "training ledger" (fake transactions, real Reconcile UI)
  would let a Treasurer earn the badge by doing a close. Separate program.
- **DB-backed authoring** — lift the catalog behind `playbookEntries` without
  touching completions (anticipated in `docs/plans/academy-redesign.md`), so
  people + the assistant can maintain courses in-app.
- **Seat-change nudges** — when someone takes a seat, surface their path
  ("You became Treasurer — your path is waiting"); a per-path lens on the
  "Who's trained" panel.

## Integrity and testing

- `assertCourseCatalogIntegrity()` runs at module load: every section belongs
  to exactly one course; catalog structure is internally consistent.
- `packages/shared/src/academy.snapshot.test.ts` hardcodes the section order,
  per-section metadata, and course structures; content PRs must extend it
  deliberately so intended changes are visible in the diff.
- ROLE_PATHS gets its own load-time asserts (every course slug exists; every
  seat slug exists in SEAT_DEFS; no duplicates within a path).
- These catch structural drift only — they cannot catch a lesson that now
  teaches the wrong thing. That's what the CLAUDE.md guardrail is for.

## Reviewer notes

- **No schema changes.** `academyProgress` and `courseCompletions` are
  untouched; paths are computed reads. Reshapes preserve section slugs, so no
  stored progress is ever invalidated; course-badge deltas are handled by the
  existing idempotent award machinery.
- **All courses remain visible to everyone.** Personalization is surfacing
  (ordering, progress, badges), never gating.
