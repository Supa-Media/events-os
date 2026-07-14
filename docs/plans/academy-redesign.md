# Academy redesign — design detail (D4)

**Status: PROPOSED — implementation gated on the decisions in §6.**

Implements decision **D4** from `ia-and-identity-proposal.md`: replace the flat
17-section Academy + computed "who's trained" list with **themes → courses
(each with a `level` + `audience`) → curriculum modules**, and a stored
completion **badge** (`courseCompletions`). The catalog stays authored in code
(`packages/shared`) for now; the Central phase later lifts it behind
`playbookEntries` without touching completions.

This doc is the concrete shape behind that decision — verified against the code
at HEAD, not assumed.

---

## 1. What exists today (ground truth)

- **Catalog:** one flat ordered array `SECTIONS_IN_ORDER` in
  `packages/shared/src/academy.ts` — 17 sections (14 quiz + 3 capstone; 16
  required + 1 optional bonus). Order is derived from array position; sections
  unlock sequentially (`order ± 1`). No course/level/theme/badge concept
  anywhere — this is greenfield.
- **Progress:** one table `academyProgress` (`apps/convex/schema/academy.ts`),
  one row per `(person, sectionSlug)`, carrying `readAt` / `quizBestScore` /
  `quizTotal` / `passedAt`. `passedAt` is the durable credential (set on first
  perfect quiz or verified capstone; never cleared).
- **"Who's trained":** computed live by `academy.chapterProgress`, never
  stored; rendered admin/manager-only on the hub.
- **Capstone/training-event mechanic:** robust and reusable. A capstone
  instantiates a real `isTraining` event from a platform template (matched by
  `platformKey`, not slug), seeds "Quest:"-prefixed rows, and passes when
  `questsComplete` (every quest row terminal). The pass is stamped onto
  `academyProgress.passedAt` via `syncCapstone`, with a live-derivation
  fallback so a finished-but-unsynced sandbox still counts. **We reuse this
  verbatim as a "capstone module type" — no rebuild.**

## 2. The model

```
Theme            (code-defined grouping: "Events", "Management", "Leadership")
 └─ Course       slug, title, level, audience, description
     └─ Module   slug, kind: "lesson" | "capstone"
                 lesson  → article blocks + quiz (today's quiz sections)
                 capstone→ { kind } → training-event mechanic (unchanged)
```

- `level ∈ { beginner, intermediate, advanced, leader }` — the founder's ask.
- `audience ∈ { role, ownership, team }` — the rebrand §5a taxonomy (what a
  course *teaches*), so courses can later surface contextually ("about to own
  your first event → the Ownership course").
- **Module slugs stay identical to today's section slugs.** This is the
  keystone that makes the migration lossless (see §4) and keeps capstone
  modules matching their platform templates unchanged.

## 3. Proposed catalog mapping

Every one of the 17 current slugs lands in a course, so no stored `passedAt`
is orphaned. Themes Management/Leadership start empty and fill as content is
written.

### Theme: Events

**Course `chapter-os-fundamentals`** — level **beginner**, audience **role**
The conceptual intro everyone needs before touching a real event.
`what-is-events-os` · `organizers-and-crew` · `anatomy-of-an-event` ·
`timing-and-offsets` · `phase-rings`

**Course `running-an-event`** — level **intermediate**, audience **role**
The tab deep-dives — the day-to-day of holding a role.
`tab-tasks` · `tab-comms` · `tab-run-of-show` · `tab-crew-duties` ·
`tab-supplies` · `tab-permits` · `tab-debrief` · `using-the-assistant`

**Course `owning-an-event`** — level **advanced**, audience **ownership**
Accountability doctrine + the hands-on capstones (§5a: "the existing
capstone-with-training-event mechanic is exactly right here").
`being-an-owner` (lesson) · `capstone-join-an-event` ·
`capstone-birthday-party` · `capstone-worship-event` *(optional — does not
gate the course badge)*

Two judgment calls this raises are put to the founder in §6.

## 4. Migration (lossless re-key + badge backfill)

Numbered files via the `runPending` pipeline (`apps/convex/migrations/`),
each idempotent. Next free numbers: `0018`, `0019`.

**`0018_rekey_academy_progress`** — add `courseSlug` (and keep the section
slug as `moduleSlug`, which equals today's `sectionSlug`) to every
`academyProgress` row via a static section→course map. `readAt` /
`quizBestScore` / `quizTotal` / `passedAt` are preserved untouched — no
credential is lost. Idempotent: skip rows already carrying `courseSlug`. Rows
with an unknown/stale slug are left alone (today's `chapterProgress` already
ignores unknown slugs, so counts can't inflate). **This is also where the
`what-is-events-os` slug is finally "handled"** as promised in the D4
appendix — it's preserved as the module slug, so its `passedAt` carries over;
only the parent course is added.

**`0019_backfill_course_completions`** — for each course, compute its required
module set (excluding `optional` modules — the worship capstone doesn't gate
the "Owning an event" badge). Per person: if every required module is passed
(`passedAt != null`, plus the capstone live-derivation fallback for
pre-sync sandboxes), insert one `courseCompletions` row with
`earnedAt = max(passedAt)` across the course. Idempotent on
`(personId, courseSlug)`. Runs after 0018.

**New table `courseCompletions`** — `chapterId`, `personId`, `courseSlug`,
`earnedAt`. Stored, not computed — an earned credential should survive catalog
restructuring. Indexes: `by_person`, `by_chapter_and_course` (the course
page's completer list), `by_chapter_and_person` (profile badge chips).
Awarded going forward the moment a course's last required module passes
(alongside the existing `submitQuiz`/`syncCapstone` write paths).

## 5. UI touchpoints

- **Hub (`(tabs)/academy.tsx`)** — flat 17-row list → theme list → course
  cards (showing level + badge state) → per-course module list (today's
  `SectionRow`/`CapstoneRow` reused, order scoped to the course).
- **Course page (new/adapted)** — the drilled-in course view lists completers
  from `courseCompletions` (reuses the "who's trained" pattern, scoped to one
  course).
- **Module screen (`academy/[slug].tsx`)** — becomes
  `/academy/<courseSlug>/<moduleSlug>`; the `Capstone` component (Start-training
  → live checklist → `syncCapstone`) is the reusable capstone-module renderer,
  unchanged. Final-module pass awards the badge + a course-complete moment.
- **Profile badge chips** — `courseCompletions` for the person renders a chip
  row on both person surfaces: the workload page (`WorkloadView`, below the
  identity block) and the People-tab person-detail modal (`PersonDetailBody`,
  after Contact). Both inserts are additive.

## 6. Decisions needed before implementation

1. **`being-an-owner` placement.** Today it sits at section 4 (before the tab
   deep-dives). Doctrinally it belongs with ownership (Course C). Moving it
   changes its unlock position. Recommend: **move it** — it groups cleanly and
   the migration re-keys progress regardless.
2. **Course B granularity.** "Running an event" is 8 modules → one badge.
   §5a eventually wants per-role Role courses (Comms Lead, Production Lead…).
   Recommend: **ship B whole now**, split later when role-specific content
   exists (splitting now would fragment existing passes across several badges
   with no new content to justify it).
3. **Unlock semantics** (new question the course model raises): keep a single
   global sequential unlock across all courses, or unlock **per course**
   (modules sequential within a course; courses gated by level order within a
   theme)? Recommend: **per course**, level-ordered — it's what a
   "levels" model implies and lets someone jump to the course they need.
4. **Completer-list visibility.** The course page's "who completed this" — keep
   it admin/manager-gated (like today's "who's trained"), or visible to the
   whole chapter (badges are a positive, social signal)? Recommend:
   **chapter-visible** for completers; keep aggregate progress admin-gated.

## 7. Sequencing (once §6 is decided)

Small, independently-reviewable PRs, in order:
1. Shared catalog reshape (`packages/shared`) — themes/courses/modules +
   helpers, module slugs unchanged. Pure data + types; no behavior change yet.
2. `courseCompletions` table + `0018`/`0019` migrations + award-on-pass in the
   existing write paths + `chapterProgress`/course-completer queries.
3. Hub + module-screen UI (theme→course→module nav, course page, badges).
4. Profile badge chips (both person surfaces).
