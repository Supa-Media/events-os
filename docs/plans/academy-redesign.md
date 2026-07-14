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

## 3. Catalog mapping (founder-decided 2026-07-13)

Every one of the 17 current slugs lands in a course, so no stored `passedAt`
is orphaned. The intermediate tier is split into **role courses** (founder
decision: split now, not one "Running an event" course), keyed to Public
Worship's real role structure. Themes Management/Leadership start empty and
fill as content is written.

### Theme: Events

**Course `chapter-os-fundamentals`** — level **beginner**, audience **role**
The conceptual intro everyone needs, plus the two cross-cutting product-literacy
tabs (Debrief and the assistant — used by every role, so they belong in the
shared foundation rather than any one role course).
`what-is-events-os` · `organizers-and-crew` · `anatomy-of-an-event` ·
`timing-and-offsets` · `phase-rings` · `tab-debrief` · `using-the-assistant`

**Course `comms-lead`** — level **intermediate**, audience **role**
The Comms Lead's remit at Public Worship: crew coordination + comms.
`tab-crew-duties` · `tab-comms`

**Course `event-lead`** — level **intermediate**, audience **role**
The Event Lead's remit: tasks, run of show, permitting, and logistics.
`tab-tasks` · `tab-run-of-show` · `tab-permits` · `tab-supplies`
*(`tab-supplies` placement is provisional — see §6.4.)*

**Course `owning-an-event`** — level **advanced**, audience **ownership**
Accountability doctrine + the hands-on capstones (§5a: "the existing
capstone-with-training-event mechanic is exactly right here").
`being-an-owner` (lesson) · `capstone-join-an-event` ·
`capstone-birthday-party` · `capstone-worship-event` *(optional — does not
gate the course badge)*

A worship-team role course (§5a) has no existing content and is not seeded
now; it joins when role-specific content is written, like Management/Leadership.

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

## 6. Decisions (founder, 2026-07-13)

1. **`being-an-owner` placement → moved** into `owning-an-event`. The migration
   re-keys progress regardless, so the unlock-position shift is harmless.
2. **Intermediate granularity → split into role courses now** (not one
   "Running an event" course), keyed to PW's real roles: **Comms Lead**
   (crew-duties, comms) and **Event Lead** (tasks, run-of-show, permits,
   supplies). The two cross-cutting product-literacy tabs (debrief, assistant)
   move into the beginner Fundamentals course. See §3.
3. **Unlock semantics → per course, level-ordered.** Modules unlock
   sequentially within a course; courses gate by level order within a theme.
4. **Completer visibility → chapter-visible.** Anyone in the chapter sees who
   earned a course badge; aggregate partial-progress stays admin/manager-gated
   as today.
   - **Open sub-item:** `tab-supplies` is placed under **Event Lead**
     provisionally (logistics pairs with permits). Confirm or move to Comms
     Lead / Fundamentals before the catalog reshape lands — it's a one-line
     change in the section→course map.

### Section → course map (for migration `0018`)

```
what-is-events-os     → chapter-os-fundamentals
organizers-and-crew   → chapter-os-fundamentals
anatomy-of-an-event   → chapter-os-fundamentals
timing-and-offsets    → chapter-os-fundamentals
phase-rings           → chapter-os-fundamentals
tab-debrief           → chapter-os-fundamentals
using-the-assistant   → chapter-os-fundamentals
tab-crew-duties       → comms-lead
tab-comms             → comms-lead
tab-tasks             → event-lead
tab-run-of-show       → event-lead
tab-permits           → event-lead
tab-supplies          → event-lead        (provisional — see §6.4)
being-an-owner        → owning-an-event
capstone-join-an-event  → owning-an-event
capstone-birthday-party → owning-an-event
capstone-worship-event  → owning-an-event  (optional; excluded from badge)
```
Module slug = today's section slug in every case (lossless).

## 7. Sequencing

Small, independently-reviewable PRs, in order:
1. Shared catalog reshape (`packages/shared`) — themes/courses/modules +
   helpers, module slugs unchanged. Pure data + types; no behavior change yet.
2. `courseCompletions` table + `0018`/`0019` migrations + award-on-pass in the
   existing write paths + `chapterProgress`/course-completer queries.
3. Hub + module-screen UI (theme→course→module nav, course page, badges).
4. Profile badge chips (both person surfaces).
