# Run of Show — v1 (start-time anchor + segment ranges)

Status: implemented on `claude/run-of-show`.
Scope owner: Run of Show grid module (`run_of_show`).

## Why this exists

The Run of Show is the `run_of_show` grid module (`packages/shared` CORE_MODULES,
`offsetMode: "minutes"`). Its rows are `eventItems` carrying a **signed
`offsetMinutes`** from the event start (T-0). Wall-clock time is always DERIVED
via `computeRunTime(eventStart, offsetMinutes)` — we never store wall-clock on a
row. The whole model hangs off one anchor: `events.eventDate`, a full timestamp
that is *meant* to include the time-of-day.

**The bug.** The new-event form only ever collected a calendar DATE. It ran that
through `parseDateInput`, which returns **local midnight**. So `eventDate` landed
at 12:00 AM, and every derived time — the Day-of "now / up-next" block and every
segment's rendered clock time — showed up at 12:xx AM. The timeline was correct
*relative to itself* but anchored to midnight instead of the real start.

v1 fixes the anchor and adds **segment ranges** (a duration per segment so the
Day-of view can show start–end and track "now" against a real end), and nothing
else. Everything below under "Deferred" is intentionally NOT built.

## Ground truth (verified)

- `run_of_show` default columns: `packages/shared/src/index.ts` `DEFAULT_COLUMNS`
  (title / offset / role / owner / notes — no duration originally).
- Rows: `eventItems` with optional `offsetMinutes` (`apps/convex/schema/shared.ts`
  `itemFieldsBase`). `fields` is a typed `record(string, any)` bag; typed number
  columns (`qty`, `cost`) already live there — this is the established typed-cell
  pattern, NOT an untyped promoted field.
- Wall-clock: `computeRunTime(eventStart, offsetMinutes)` (`shared`).
- Day-of view: `apps/mobile/app/(app)/event/[id]/day-of.tsx` + backend
  `api.events.dayOf` (`apps/convex/events.ts`). The now/next loop uses each
  segment's start and the *next* segment's start as the window, with a 2h cap on
  the final segment.
- Reschedule: `events.reschedule({ eventId, eventDate })` patches `eventDate` and
  re-derives every day-offset item's `dueDate`. Minute-offset segments store no
  derived value — they read `eventDate` live, so they self-correct the instant
  the anchor moves. The event-detail header already opens a calendar+time popover
  (`DateTimePanel`) wired to `reschedule`, so changing the start on an existing
  event already carries time-of-day.
- Default-column backfill precedent: `migrations.ts:backfillMissingDefaultColumns`
  (generic, already ledgered) + the numbered `MIGRATIONS` registry in
  `migrations/index.ts`, tested in `tests/migrations.test.ts`.

## What v1 implements

### A. Start-time anchor (the fix)

1. **New-event form** (`apps/mobile/app/(app)/event/new.tsx`): a **required**
   start-time field sits beside the date. Web uses `<input type="time">`; native
   uses a typed hour:minute pair plus the app's AM·PM `MeridiemButton` chips
   (the same aesthetic as `RunTimeCell` / `DateTimeField`). Both paths emit a
   canonical `HH:mm` (24h) string, mirroring how the date field emits `YYYY-MM-DD`.
   Submit is blocked until both date and time are valid. Date + time are combined
   by `parseDateTimeInput(dateStr, timeStr)` (new, in `lib/format.ts`) into the
   `eventDate` timestamp passed to `createFromTemplate` — carrying the chosen
   local time, never midnight.

2. **Change start time on an existing event**: we **reuse `events.reschedule`**
   (`{ eventId, eventDate }`) rather than inventing a redundant `setStartTime`.
   `reschedule` already patches `eventDate` (with time-of-day) and re-runs the
   day-offset re-derivation; minute segments self-correct. It is surfaced two
   ways: (a) the event-detail header's date popover (pre-existing), and (b) a new
   "Set a start time" affordance on the Day-of view.

3. **Existing midnight events**: `isLocalMidnight(ts)` (new, in `shared`) detects
   an `eventDate` whose local time-of-day is exactly 00:00. The Day-of view shows
   a dismissible, non-blocking "Set a start time" prompt when it's true. A data
   migration can't *infer* the real start, so this reaches old events without
   guessing.

### B. Segment ranges (durations)

4. **`duration` column**: added to `DEFAULT_COLUMNS.run_of_show` as a typed
   **custom `number`** column (`key: "duration"`, label "Length"), stored in the
   item `fields` bag exactly like `qty`/`cost`. No schema change, no new column
   type, no `v.any()` promoted field — it rides the existing typed-number inline
   cell. Sensible durations are seeded on the three seeded run_of_show row sets
   (`lib/seed/templates.ts`).

5. **Backfill**: `migrations/0019_backfill_run_of_show_duration.ts` inserts the
   `duration` default column into every existing `run_of_show` template/event
   column group that lacks it (idempotent: present → skip). Registered in
   `migrations/index.ts`; `REGISTRY_NAMES` in `tests/migrations.test.ts` updated.
   A segment with no duration (0 or absent) gracefully falls back to today's
   "until the next segment starts" behavior.

6. **Day-of end times**: `runOfShowSegmentEnd(start, durationMinutes, nextStart)`
   (new, in `shared`) computes each segment's END = `start + duration` when a
   positive duration is set, else the next segment's start, else `start + 2h`
   cap for the final row. Day-of now renders **start–end** and the now/up-next
   window uses the real end, so "NOW" clears when a segment actually finishes.

## Timezone

All event times are LOCAL (the derived clock, the picker, `isLocalMidnight`, and
`runOfShowSegmentEnd` all operate in local time via `computeRunTime` +
`Date`). Reminder emails independently normalize to America/New_York elsewhere;
v1 changes nothing about that path. We never store wall-clock — only the
`eventDate` anchor plus signed minute offsets.

## Deferred (fast-follows, intentionally NOT in v1)

- **Segment `kind` enum** (setup / worship / talk / transition …) for coloring
  and filtering Day-of.
- **Typed segment table** graduating run_of_show off the generic grid.
- **Worship ↔ setlist link** (bind a worship segment to its song set).
- **Minute-level reminders** ("5 min to doors") off segment starts/ends.
- **Hard integer/≥0 validation** on the duration cell: v1 uses the standard
  number cell (any finite number); Day-of already guards with `duration > 0`.
