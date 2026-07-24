# Feature: Calendar view on the Events tab

## Feature Description
Adds a month-calendar view to the Events tab (`apps/mobile/app/(app)/(tabs)/index.tsx`),
toggled alongside the existing table/card list, so anyone who can see the Events tab
can browse the chapter's events by month, tap a day to see its agenda, and start a new
event pre-dated to a day they tap.

## User Story
As a chapter admin, lead, or member
I want to view my chapter's events on a calendar, not just a flat list
So that I can see event density across a month at a glance and quickly add a new event
on a specific day

## Problem Statement
The Events tab only ever renders events as a table (wide) or stacked cards (narrow),
sorted by date. There is no way to see events laid out spatially across a month, and
"New event" always opens a blank form with no date context.

## Solution Statement
A full month-calendar screen already exists at `apps/mobile/app/(app)/calendar.tsx`
(437 lines) — a month grid of status-toned event chips plus a day-agenda panel with a
"New event" CTA that deep-links to `/event/new?date=YYYY-MM-DD` (already wired, already
consumed by `apps/mobile/app/(app)/event/new.tsx`'s `date` search param). It is fully
built but **unreachable from the UI today** — no nav link points at it, and it has no
support for the Events tab's central-seat "peek" feature (viewing a different chapter's
events read-only), unlike `api.events.current`/`api.events.past`.

Rather than building a new calendar from scratch, this plan:
1. Extends `api.events.list` with the same optional peek `chapterId` that
   `api.events.current`/`api.events.past` already have, so a calendar fed by `list`
   behaves consistently with the rest of the Events tab under peek.
2. Extracts `calendar.tsx`'s grid + agenda into a reusable
   `apps/mobile/components/event/EventsCalendarView.tsx`, threading through
   `isPeeking`/`chapterId` so "New event" and event-detail navigation respect peek the
   same way the existing list view already does (`openEvent` guard in `index.tsx`).
3. Wires that component into the Events tab as a second, independent
   `List`/`Calendar` `Segmented` toggle (the same local `Segmented` component the tab
   already uses for its `Events`/`Templates` mode), and turns the standalone
   `/calendar` route into a thin wrapper around the same component so behavior isn't
   duplicated.

This is the existing pattern (`Segmented` toggle + peek-aware optional `chapterId` on a
query) applied to already-built calendar UI, rather than inventing a new toggle
mechanism or a new calendar renderer.

## Scope
**In scope:**
- `api.events.list` accepting an optional peek `chapterId` (mirroring
  `events.current`/`events.past`).
- Extracting `calendar.tsx`'s grid/agenda into a reusable, peek-aware component.
- A `List`/`Calendar` toggle on the Events tab, visible to every tier that sees the tab
  (admin, lead, member — volunteers never reach this screen).
- The day-agenda's "New event" CTA deep-linking to `/event/new?date=...` (already
  built; verify it still works once wired into the tab).
- Peek-safety: hiding "New event" and disabling event-detail taps while peeking a
  different chapter's calendar, matching how the existing list view already guards
  these.

**Out of scope:**
- Dragging/resizing events on the calendar, multi-day events, or any recurrence UI.
- Removing or otherwise changing the standalone `/calendar` route's URL or its
  "reached from the Upcoming events stat" aspiration — it stays a valid route, now
  built from the same shared component, but wiring an actual nav link to it (e.g. from
  a home-screen stat) is not part of this feature.
- Any change to `api.events.createFromTemplate`, the New Event form, or the
  `eventDate` schema/timestamp model.
- A week or day calendar view — month view only, matching the existing `calendar.tsx`.
- New pure date-math utilities — `calendarMonthGrid`, `groupByDay`, `soonestUpcoming`,
  `startOfDay` (`packages/shared/src/index.ts:886-1048`) already do everything this
  feature needs and are reused as-is.

## Relevant Files
- `apps/mobile/app/(app)/calendar.tsx` — **the pattern to follow**: the existing,
  built-but-unreachable month calendar (grid, day agenda, status legend, month nav).
  Its body is extracted into a reusable component in this plan; the file itself
  becomes a thin wrapper.
- `apps/mobile/app/(app)/(tabs)/index.tsx` — the Events tab. Add the second
  `viewMode` `Segmented` toggle here (reusing the local `Segmented` component already
  defined at lines 391–434) and branch to the extracted calendar component.
- `apps/convex/events.ts` — `list` (lines 251–292) needs the optional peek
  `chapterId`; `resolvePeekChapterId` (lines 1445–1462) is the helper to reuse,
  already used by `current` (1474–1499) and `past` (1511–1540).
- `apps/mobile/lib/ChapterContext.tsx` — `useChapterContext()`, the source of
  `context.kind === "peek"` and the peeked `chapterId`, already consumed by
  `index.tsx` (lines 62–65) the same way the calendar component will need it.

### New Files
- `apps/mobile/components/event/EventsCalendarView.tsx` — the extracted, peek-aware
  month grid + day agenda (moved out of `calendar.tsx`'s screen body). Single
  responsibility: render a chapter's events on a month calendar and let the caller
  start a new event on a selected day.

## Implementation Plan

### Phase 1: Foundation
Give `api.events.list` the same optional peek `chapterId` its siblings
(`events.current`, `events.past`) already have, so anything built on `list` — the
existing standalone calendar screen and the new embedded one — is peek-consistent
with the rest of the Events tab.

### Phase 2: Core Implementation
Extract `calendar.tsx`'s grid/agenda/legend into `EventsCalendarView.tsx`, parameterized
by `isPeeking` (gates "New event" CTAs and event-detail taps) and an optional
`chapterId` (passed straight through to `api.events.list`).

### Phase 3: Integration
- `calendar.tsx` becomes a thin `Screen` + `PageHeader` wrapper around
  `EventsCalendarView`, itself now peek-aware via `useChapterContext()`.
- `index.tsx` gains the `List`/`Calendar` `Segmented` toggle and renders
  `EventsCalendarView` when `viewMode === "calendar"`.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. `api.events.list` accepts an optional peek `chapterId`

**a. Write the failing test (RED).** In `apps/convex/tests/eventsProjectsPeek.test.ts`,
add a new `describe("events.list: central peek authz", ...)` block directly after the
existing `describe("events.current / events.past: central peek authz", ...)` block
(after line 238). Mirror its six tests exactly, swapping `api.events.current` for
`api.events.list` and adding `scope: "all"` to every call (so cancelled/past events
aren't silently excluded and would show up in a real calendar):
  - a central admin (superuser) CAN read a different chapter's events via `chapterId`
  - a PLAIN person with a genuine `scope:"central"` `financeRoles` grant CAN read a
    different chapter's events (not the superuser short-circuit)
  - a chapter-scoped manager CANNOT read a different chapter's events (expect it to
    throw)
  - passing the caller's OWN `chapterId` is unchanged (still returns that chapter's
    events)
  - no `chapterId` arg still resolves the caller's own chapter
  - a caller with no home chapter passing a foreign `chapterId` gets `NO_CHAPTER`, not
    a silent fallback

  Run `cd apps/convex && pnpm vitest run tests/eventsProjectsPeek.test.ts`. Confirm it
  fails: `list`'s current args validator (`apps/convex/events.ts:252-256`) has no
  `chapterId` field, so passing one throws a Convex `ArgumentValidationError` — a
  genuine RED (not the peek-authz behavior the test is pinning down).

**b. Implement the minimum to reach GREEN.** In `apps/convex/events.ts`'s `list` query
(lines 251–292):
  - Add `chapterId: v.optional(v.id("chapters"))` to `args`.
  - Rename the handler's destructured arg to avoid shadowing (e.g.
    `{ scope, includeTraining, chapterId: requestedChapterId }`).
  - Replace `const chapterId = await getChapterIdOrNull(ctx);` with
    `const chapterId = await resolvePeekChapterId(ctx, requestedChapterId);` (the
    function is declared later in the file but is a hoisted `function` declaration, so
    no reordering is needed — `current`/`past` already call it the same way despite
    being defined above it).
  - `resolvePeekChapterId` already returns `Id<"chapters"> | null` and already throws
    `NO_CHAPTER` for the foreign-chapter-no-home-chapter case, so the existing
    `if (!chapterId) return [];` guard needs no other change.

**c. Run the full suite before moving on:** `cd apps/convex && pnpm test`.

### 2. Extract `EventsCalendarView` from `calendar.tsx`

**a.** No new failing test — this is a like-for-like extraction of existing, already
git-tracked UI, and the project's own testing convention excludes component rendering
from coverage ("Only dependency-free logic is unit-tested; there are no component
render tests" — `.claude/PROJECT.md`). Verification for this step is: (1) `pnpm
typecheck` passes, (2) manual check in the browser (Step 5) that `/calendar` renders
identically to before the extraction.

**b. Implement.** Create `apps/mobile/components/event/EventsCalendarView.tsx`:
  - Move everything from `calendar.tsx` EXCEPT the outer `Screen`/`PageHeader`: the
    `useState` for `view`/`selected`, the `didInit` effect, the `byDay` memo, the month
    nav row, the month-grid `Card` + `DayCell`, the status legend, the `DayAgenda`, and
    all local helper components (`NavButton`, `DayCell`, `DayAgenda`, `AgendaRow`) and
    constants (`WEEKDAYS`, `MONTHS`, `WEEKDAYS_LONG`, `STATUS_CHIP`, `WIDE`).
  - New props: `{ isPeeking?: boolean; chapterId?: Id<"chapters"> }`.
  - `useQuery(api.events.list, { scope: "all", chapterId })` (was
    `useQuery(api.events.list, { scope: "all" })`).
  - `router.push("/event/new")` (unused inside the extracted body — that button stays
    in each caller's own `PageHeader`, see Step 3) is removed from this file; only
    `onNewOnDay` (`/event/new?date=...`) remains, and it is omitted from the rendered
    `DayAgenda` empty state when `isPeeking` is true (mirror `index.tsx`'s existing
    `isPeeking ? undefined : () => router.push(...)` guard, lines 128–134).
  - `onOpenEvent` (both the grid's chip taps and the agenda row taps) becomes a no-op
    (or the `Pressable`s render without an `onPress`) when `isPeeking` is true — mirror
    `index.tsx`'s `openEvent`/`isPeeking` guard (lines 107–115), matching
    `ChapterContext.tsx`'s documented invariant that "event DETAIL navigation is
    disabled while peeking."
  - Export `EventsCalendarView` as the default (or named) export from this file, and
    add it to `apps/mobile/components/event`'s barrel if one exists for this directory
    (check for `components/event/index.ts`; if none exists, import directly by path,
    matching how other files in `components/event/` are already imported).

**c. Update `apps/mobile/app/(app)/calendar.tsx`** to be a thin wrapper:
  - Keep `Screen`, `PageHeader` (title "Calendar", subtitle unchanged), and the
    "New event" `Button` action — but now call `useChapterContext()` here too (same
    import/usage as `index.tsx` lines 29, 62–65) and hide/guard that header button the
    same way `index.tsx` does (`isPeeking ? undefined : () => router.push(...)`).
  - Render `<EventsCalendarView isPeeking={isPeeking} chapterId={chapterId} />` in
    place of everything that moved out.
  - Delete the now-unused local copies of `DayCell`, `DayAgenda`, `AgendaRow`,
    `NavButton`, the `STATUS_CHIP`/`WEEKDAYS`/`MONTHS`/`WEEKDAYS_LONG` constants, and
    the `view`/`selected`/`byDay`/`didInit` state — all now live in
    `EventsCalendarView`. `calendar.tsx` should end up well under 100 lines.

**d. Run the full suite:** `pnpm typecheck && pnpm lint` (no behavior for `pnpm test`
to catch here — this step is pure UI refactor, per 2a).

### 3. Add the List/Calendar toggle to the Events tab

**a.** No new failing test, same rationale as Step 2a — this is UI wiring on a screen
this repo doesn't render-test. Verification is manual (Step 5) plus `pnpm typecheck`.

**b. Implement** in `apps/mobile/app/(app)/(tabs)/index.tsx`:
  - Add `type ViewMode = "list" | "calendar";` and
    `const [viewMode, setViewMode] = useState<ViewMode>("list");` alongside the
    existing `mode`/`setMode` state (line 74).
  - Render a second `Segmented<ViewMode>` — reusing the existing local `Segmented`
    component (lines 391–434) unchanged — with options
    `[{ key: "list", icon: "layout", label: "List" }, { key: "calendar", icon: "calendar", label: "Calendar" }]`,
    value `viewMode`, `onChange={setViewMode}`. Unlike the `mode` Segmented (admin/lead
    only, gated by `canManageTemplates`), this one renders whenever `mode === "events"`
    — i.e. for every tier that reaches this screen, not just admins/leads.
  - Inside the `mode === "events"` branch (currently lines 157–277), branch again on
    `viewMode`: when `"calendar"`, render
    `<EventsCalendarView isPeeking={isPeeking} chapterId={chapterId} />` (reusing the
    same `isPeeking`/`chapterId` already computed at lines 63–65) instead of the
    empty-state/table/cards/`PastEventsSection` block; when `"list"`, render exactly
    what's there today, unchanged.
  - Import `EventsCalendarView` from
    `"../../../components/event/EventsCalendarView"`.

**c. Run the full suite:** `pnpm typecheck && pnpm lint`.

### 4. Manual verification in the browser

**a.** No automated test — this is the project's documented practice for UI changes
("For UI or frontend changes, start the dev server and use the feature in a browser
before reporting the task as complete").

**b.** Start the app (`/run` skill or `pnpm dev` per this repo's dev-runner), sign in,
and on the Events tab:
  - Confirm the `List`/`Calendar` toggle appears for a member (no `Events`/`Templates`
    toggle) and for an admin/lead (both toggles visible, independently switchable).
  - Switch to Calendar: confirm the month grid renders with today ringed, events
    chipped on their day, and tapping an empty day then "New event" in the agenda
    navigates to `/event/new?date=<that day>` with the date pre-filled.
  - Tap an event chip/agenda row: confirm it opens that event's detail screen.
  - If a central-seat test account is available, enter peek mode for a different
    chapter and confirm the calendar shows THAT chapter's events, with "New event" and
    event-detail taps disabled.
  - Visit `/calendar` directly and confirm it still renders the same grid/agenda
    (now via the shared component) with its own "New event" header button working.

**c.** This is the final verification step — once it passes, run the Validation
Commands below.

## Testing Strategy

### Tests by Milestone

| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | `events.list` peek `chapterId` | `apps/convex/tests/eventsProjectsPeek.test.ts` (new `describe("events.list: central peek authz")` block) | Central/central-scope callers CAN read a different chapter's events via `chapterId`; chapter-scoped callers CANNOT; own/absent `chapterId` unchanged; foreign `chapterId` with no home chapter throws `NO_CHAPTER` — 6 assertions mirroring the existing `events.current` block | `list`'s args validator has no `chapterId` field today — passing one throws `ArgumentValidationError`, not the intended authz result |
| 2 | Extract `EventsCalendarView` | N/A — component extraction, no behavior change; verified via `pnpm typecheck` + manual check (Step 4) that `/calendar` is visually/functionally unchanged | N/A | N/A |
| 3 | Events tab List/Calendar toggle | N/A — UI wiring; verified via `pnpm typecheck` + manual check (Step 4) | N/A | N/A |

**Pattern followed:** `apps/convex/tests/eventsProjectsPeek.test.ts` — the exact peek
authz test shape (`describe("events.current / events.past: central peek authz")`,
lines 140–238) this plan's Milestone 1 tests mirror one-for-one.

### Integration Tests
N/A beyond Milestone 1's Convex peek tests — this repo has no component-level
integration tests for mobile screens (see `.claude/PROJECT.md`'s Testing Conventions:
"Only dependency-free logic is unit-tested; there are no component render tests").
The seam this feature adds (Events tab → `EventsCalendarView` → `api.events.list`) is
covered end-to-end by Milestone 1's backend test plus the manual pass in Step 4.

### Edge Cases
- **Peeking a chapter with zero events**: covered indirectly by Milestone 1's
  "central admin CAN read" test using the same fixtures as `events.current`'s
  equivalent test, which already exercises an otherwise-empty target chapter; the
  calendar component's existing empty-day `EmptyState` (already in `calendar.tsx`,
  unchanged by extraction) handles the zero-events case visually — verify in Step 4b.
- **A chapter-scoped (non-central) caller viewing their OWN chapter's calendar**:
  covered by Milestone 1's "own chapterId" and "no chapterId" tests — must behave
  identically to `events.current`'s equivalent, unauthorized cases must never
  silently fall back to the caller's own chapter's data.
- **Tapping "New event" while peeking**: covered manually in Step 4b — must be hidden,
  not merely disabled-but-visible, matching the existing list view's pattern of
  omitting the action entirely rather than rendering it inert.
- **Switching List↔Calendar while on the Templates mode's sibling toggle** (i.e. the
  two `Segmented`s must not interact): covered manually in Step 4b for an admin/lead
  account — switching `mode` to `"templates"` and back to `"events"` must preserve
  whatever `viewMode` was last selected (this falls out of them being independent
  `useState`s, but must be visually confirmed).

## Acceptance Criteria
- [ ] `api.events.list` accepts an optional `chapterId` argument with the same peek
      authorization semantics as `api.events.current`/`api.events.past`.
- [ ] The new `describe("events.list: central peek authz", ...)` test block in
      `eventsProjectsPeek.test.ts` passes (6 tests).
- [ ] `apps/mobile/components/event/EventsCalendarView.tsx` exists, exports the
      extracted month grid + day agenda, and accepts `isPeeking`/`chapterId` props.
- [ ] `apps/mobile/app/(app)/calendar.tsx` renders via `EventsCalendarView` and is
      under 100 lines.
- [ ] The Events tab (`apps/mobile/app/(app)/(tabs)/index.tsx`) shows a `List`/
      `Calendar` toggle for every tier that reaches the screen (member, lead, admin).
- [ ] Selecting `Calendar` on the Events tab renders the month grid + day agenda for
      the caller's own chapter (or the peeked chapter, if peeking).
- [ ] Tapping an empty day's "New event" in the embedded calendar navigates to
      `/event/new?date=<selected day>` with that date pre-filled in the form.
- [ ] While peeking a different chapter, the embedded calendar shows that chapter's
      events, with "New event" hidden and event-detail taps disabled — matching the
      existing list view's peek guards.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` all exit clean.

## Validation Commands
Execute every command. Every one must exit clean.
- `cd apps/convex && pnpm vitest run tests/eventsProjectsPeek.test.ts` — fast check of
  the new Milestone 1 tests specifically
- `pnpm test` — full suite (turbo → 3 packages), zero regressions
- `pnpm typecheck` — `tsc --noEmit` × 3 packages
- `pnpm lint` — zero errors (97 pre-existing warnings in `apps/mobile` are expected —
  see `.claude/PROJECT.md`, do not attribute new ones to this change without checking)
- `pnpm build` — web bundle export

## Notes
- **No new dependencies.** No calendar library is added — the project's existing
  dependency-free date math (`packages/shared/src/index.ts`) is reused as-is.
- **Academy**: this feature adds an alternate view of already-existing event data (no
  new vocabulary, money rule, role/seat, or taught flow) — per `CLAUDE.md`'s "Academy
  must track the product" rule, state explicitly in the PR description that this is
  judged **not training-worthy**, or update the Academy in the same PR if the reviewer
  disagrees.
- **Pre-existing gap, not introduced by this plan**: `calendarMonthGrid`, `groupByDay`,
  `soonestUpcoming`, and `startOfDay` (`packages/shared/src/index.ts:886-1048`) have no
  test coverage today despite `calendarMonthGrid`'s own doc comment claiming it's
  "unit-tested in `@events-os/shared`." This plan reuses them unchanged and does not
  add a milestone for them (a test written now would pass immediately against existing,
  correct behavior — not a genuine RED), but backfilling that coverage is a reasonable
  fast-follow now that a second, primary-nav-visible surface depends on them.
- **Placement of the second `Segmented` toggle** on the Events tab is left to the
  implementor's visual judgment (e.g. same row as the `Events`/`Templates` toggle when
  both are visible, or its own row) — the acceptance criteria only require that it's
  present and functional for every tier; match the existing `Segmented`'s pill styling
  exactly rather than inventing a new toggle visual.
