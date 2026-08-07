# Feature: Delete button on the Comms Schedule day-panel card

## Feature Description
Adds a delete (trash) affordance to the day-panel item card in the Module
Calendar — the calendar view a Comms Schedule row renders as (see the
attached screenshot: title, "Set status" pill, timing chip, Copy/Send row).
Tapping it confirms, then permanently removes that row. The card component is
shared with Planning Doc, so the same affordance appears there too — no
special-casing one module over the other on a component that already treats
both identically for every other action (status, timing, fields, copy).

## User Story
As a Comms Lead
I want to delete a comms send (or planning task) directly from its calendar day-panel card
So that I can remove a row I no longer need without switching to the Table view first

## Problem Statement
`items.removeEventItem` (the delete mutation) and its UI already exist — but
only on the Table view (`EditableGrid.tsx`'s per-row trash icon,
`apps/mobile/components/grid/EditableGrid.tsx:933`). The Comms Schedule opens
on the **Calendar** view by default (`config.ts#defaultCalendarView`), and its
day-panel card (`ItemCard.tsx`, rendered via `ModuleCalendar` /
`useModuleCalendar.ts`) has no delete affordance at all — every other action
(status, timing, title, copy, channels) is editable in place on the card, but
removing the row entirely means switching to the Table toggle first. That's
the gap in the screenshot: no delete option anywhere on the card.

## Solution Statement
Wire the day-panel card to the SAME `items.removeEventItem` mutation the
Table view already calls (`useGridData.ts:187,262`) — no backend or schema
change, since that mutation already has full cascade-delete handling and is
already gated by `requireEvent` (bare event/chapter membership, the same gate
the Table's delete already relies on; this PR adds a second UI entry point to
an existing capability, not a new one, so CLAUDE.md's "gate it behind a
power" doesn't introduce a new resolver here).

On the frontend, follow the app's established per-item delete pattern —
a quiet trash icon that opens the cross-platform `confirmAction` dialog
(`components/event/ticketing/helpers.ts#confirmAction`, already reused across
`ProjectCard.tsx`, `WorkloadView.tsx`, `orgchart/SeatActions.tsx`, etc.) before
calling the mutation — rather than the Table view's un-confirmed inline
delete, since a full-card action is a heavier commitment than a table-row
trash icon buried in a dense grid.

`useModuleCalendar.ts` gets a `removeItem(item)` action (mirroring its
existing `reschedule`/`setStatus`/`saveField` shape); `ItemCard.tsx` gets the
button + confirm dialog; `index.tsx`'s `renderItemCard` threads it through —
the same three-file wiring shape the most recent card feature
(`specs/comms-send-to-google-chat.md`, milestone 5) used for the Send button.

## Scope
**In scope:**
- A delete button on the day-panel `ItemCard` (calendar view), gated behind a
  confirm dialog, for both Comms Schedule and Planning Doc (the card is
  shared; scoping it to comms only would mean forking a component that is
  otherwise fully generic).
- Wiring `useModuleCalendar.ts` to call the existing `items.removeEventItem`
  mutation.
- Cleanly exiting "move mode" if the item being deleted is the one currently
  mid-move ("pick a day on the calendar").

**Out of scope:**
- Any change to the Table view's existing delete (`EditableGrid.tsx`) — it
  already works and is untouched.
- Any change to `items.removeEventItem` itself, its cascade logic, or its
  access gate — all already correct and already exercised by the Table view.
- An Undo-after-delete toast. The confirm dialog is the safety net (matches
  every other per-item delete in this app — `ProjectCard.tsx`,
  `WorkloadView.tsx` — none of which add Undo on top of a confirm).
- Bulk/multi-select delete.
- A new seat capability (`comms.delete` or similar) — this reuses the
  existing `requireEvent` gate the mutation already has; see Solution
  Statement.

## Relevant Files
- `apps/mobile/components/event/moduleCalendar/ItemCard.tsx` — **pattern for
  card structure**; add the delete button + confirm dialog next to the
  existing `StatusPill` in the card's header row.
- `apps/mobile/components/event/moduleCalendar/useModuleCalendar.ts` — add the
  `removeItem` action, mirroring the existing `reschedule`/`setStatus` shape.
- `apps/mobile/components/event/moduleCalendar/index.tsx` — thread
  `itemNoun` and `onDelete` into `renderItemCard`'s `<ItemCard .../>` call,
  the same config-driven wiring already used for `canSendGoogleChat`.
- `apps/mobile/components/team/ProjectCard.tsx` — **pattern to follow**: the
  existing `confirmAction` + `trash-2` icon + `colors.faint` per-item delete
  affordance this feature copies (`apps/mobile/components/team/ProjectCard.tsx:241-260`).
- `apps/mobile/components/event/ticketing/helpers.ts` — `confirmAction`, the
  shared cross-platform confirm dialog (Alert on native, `window.confirm` on
  web) this feature reuses as-is; no changes.
- `apps/convex/items.ts` — `removeEventItem` (`apps/convex/items.ts:1138`),
  the existing mutation this feature calls; **no changes**.
- `apps/mobile/components/grid/useGridData.ts` — shows the Table view already
  calling this same mutation (`removeEvt`, lines 187/262) — confirms no
  backend work is needed.

## Implementation Plan

### Phase 1: Foundation
N/A — no new types, schema, or shared utilities. `removeEventItem`,
`confirmAction`, and every UI primitive this feature needs already exist.

### Phase 2: Core Implementation
- `useModuleCalendar.ts`: `removeItem(item)` action wrapping
  `useMutation(api.items.removeEventItem)`.
- `ItemCard.tsx`: delete button + confirm dialog, new `itemNoun` / `onDelete`
  props.

### Phase 3: Integration
- `index.tsx`: pass `config.itemNoun` and `cal.removeItem` down through
  `renderItemCard`.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Delete button on the day-panel card

**a. Confirm the gap (RED).** This repo has no component-render test harness
for React Native (`apps/mobile/package.json` has no
`@testing-library/react-native`; every existing `*.test.tsx`/`*.test.ts` file
under `apps/mobile` tests pure logic, never a rendered component — confirmed:
`find apps/mobile -iname "*.test.tsx"` returns zero results). The most recent
card feature in this exact file set,
`specs/comms-send-to-google-chat.md` (milestones 4–5), hit the same wall and
recorded "No new test file... verify by running the app" — follow that
precedent rather than inventing test infrastructure for one button. The RED
here is the screenshot itself and a manual check: open an event's Comms
Schedule (opens on the Calendar view by default), select a day with an item,
confirm the day-panel card has no delete affordance anywhere on it.

**b. Implement.**

In `apps/mobile/components/event/moduleCalendar/useModuleCalendar.ts`:
- Add `const removeEventItemMutation = useMutation(api.items.removeEventItem);`
  alongside the other mutations at the top of the hook.
- Add, near `reschedule`/`setStatus`:
  ```ts
  // Delete an item outright (day panel's delete button, confirmed by the
  // caller before this runs). If it was mid-move ("pick a day on the
  // calendar"), exit move mode too — otherwise the "Moving …" banner would
  // keep referencing a row that no longer exists.
  const removeItem = (item: ScheduleItem) => {
    if (moving?._id === item._id) setMoving(null);
    void removeEventItemMutation({ itemId: item._id as Id<"eventItems"> });
  };
  ```
- Add `removeItem` to the hook's returned object (next to `saveTitle`/`createItem`).

In `apps/mobile/components/event/moduleCalendar/ItemCard.tsx`:
- Add imports: `Icon` from `"../../ui/Icon"`, `colors` from
  `"../../../lib/theme"`, `confirmAction` from `"../ticketing/helpers"`.
- Add two props to `ItemCard`'s signature:
  `itemNoun: string` and `onDelete: () => void`, with a one-line doc comment
  each (matching the file's existing prop-doc density).
- In the card's header row (`<View className="flex-row items-start gap-3">`),
  wrap the existing trailing `<StatusPill .../>` in a column so the delete
  button sits above it:
  ```tsx
  <View className="items-end gap-1.5">
    <Pressable
      onPress={() =>
        confirmAction({
          title: `Delete this ${itemNoun}?`,
          message: item.title
            ? `“${item.title}” will be permanently deleted.`
            : `This ${itemNoun} will be permanently deleted.`,
          confirmLabel: "Delete",
          destructive: true,
          onConfirm: onDelete,
        })
      }
      hitSlop={6}
      accessibilityLabel={`Delete ${itemNoun}`}
      className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
    >
      <Icon name="trash-2" size={13} color={colors.faint} />
    </Pressable>
    <StatusPill option={statusOpt} onPress={openStatus} />
  </View>
  ```

In `apps/mobile/components/event/moduleCalendar/index.tsx`:
- In `renderItemCard`, pass two more props to `<ItemCard .../>`:
  `itemNoun={config.itemNoun}` and `onDelete={() => cal.removeItem(item)}`
  (same one-line, config-driven style already used for `canSendGoogleChat`
  just above it).

**c. Run the full suite.** `pnpm --filter @events-os/mobile typecheck`,
`pnpm --filter @events-os/mobile lint`, `pnpm --filter @events-os/mobile test`
(no new/changed logic tests, but must stay green), then verify by running the
app (`pnpm dev` or the `/run` skill): open an event's Comms Schedule
(calendar view), confirm the trash icon appears above the status pill on a
day-panel card, tap it, confirm the dialog reads "Delete this send?", cancel
it (item unchanged), tap again and confirm (item disappears from the day
panel, the month grid's day cell, and — if unscheduled — the Unscheduled
list). Repeat once on a Planning Doc card (dialog should read "Delete this
task?"). Confirm the Table view's own delete icon (`EditableGrid.tsx`) is
unaffected.

### 2. Final validation
Run every command in Validation Commands below and confirm a clean exit.

## Testing Strategy

### Tests by Milestone

| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | Delete button on the day-panel card | N/A — manual verification via the app (see step 1c); this repo has zero component-render tests under `apps/mobile` (no `@testing-library/react-native`), and the most recent card feature in this same file set (`specs/comms-send-to-google-chat.md`, milestones 4–5) recorded the identical "no test file, verify by running the app" call for the same reason | Trash icon appears on the day-panel card (comms + planning doc); confirm dialog gates the delete; confirming removes the row everywhere it's shown (day panel, month grid, unscheduled list); canceling leaves it untouched; mid-move deletion exits move mode cleanly | The button doesn't exist — the card currently has no delete affordance at all (per the reported screenshot) |

**Pattern followed:** `apps/mobile/components/team/ProjectCard.tsx` (confirm
dialog + trash icon shape) and `specs/comms-send-to-google-chat.md` (the
identical three-file wiring shape — hook action → card prop → `renderItemCard`
— for the most recent addition to this exact card).

### Integration Tests
N/A — the mutation this feature calls (`items.removeEventItem`) is already
integration-tested indirectly via the Table view's existing usage
(`apps/convex/tests/templateSync.test.ts:198`,
`apps/convex/tests/inventorySupplyBridge.test.ts:229`) and unchanged by this
PR. There's no new backend seam to cover.

### Edge Cases
- **Item mid-move when deleted**: covered by step 1's `removeItem` guard
  (`if (moving?._id === item._id) setMoving(null)`) and verified manually in
  step 1c.
- **A stale Undo toast referencing a since-deleted item**: `updateEventItem`
  already no-ops on a missing `itemId` (`items.ts:621`,
  `if (!item) return itemId;`), so tapping Undo after a delete is a harmless
  no-op — no new guard needed.
- **Last item on a selected day**: the day panel's existing `EmptyState`
  (`DayPanel.tsx`) renders automatically once the Convex query drops to zero
  items for that day — no code change needed, reactive by construction.
- **Cross-chapter / unauthorized delete**: already rejected by
  `requireEvent` inside `removeEventItem`, unchanged by this PR — the same
  gate the Table view's delete already relies on.
- **Canceling the confirm dialog**: `confirmAction`'s `onConfirm` never fires
  on Cancel (native `Alert.alert`'s `style: "cancel"` button, or `window.confirm`
  returning `false` on web) — no mutation call, item untouched. Verified
  manually in step 1c.

## Acceptance Criteria
- [ ] The day-panel card (Module Calendar view) shows a delete (trash) icon
      for both Comms Schedule and Planning Doc items.
- [ ] Tapping it opens a confirm dialog naming the action as destructive
      before anything is deleted.
- [ ] Canceling the dialog leaves the item fully unchanged.
- [ ] Confirming calls `items.removeEventItem` and the item disappears from
      the day panel, the month grid cell, and the Unscheduled list (whichever
      applies).
- [ ] Deleting an item that is currently mid "pick a day on the calendar"
      move exits move mode (no stale "Moving …" banner left behind).
- [ ] The Table view's existing per-row delete is unchanged.
- [ ] `pnpm --filter @events-os/mobile typecheck` passes with no new errors.
- [ ] `pnpm --filter @events-os/mobile lint` passes with no new errors.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm --filter @events-os/mobile typecheck` — typecheck the changed files
- `pnpm --filter @events-os/mobile lint` — lint the changed files
- `pnpm --filter @events-os/mobile test` — mobile Jest suite, zero regressions
- `pnpm --filter @events-os/convex test` — backend suite, confirms
  `removeEventItem` (unchanged) still passes its existing coverage
- `pnpm turbo run test` — full suite, zero regressions
- `pnpm turbo run typecheck` — full typecheck, zero regressions
- `pnpm turbo run lint` — full lint, zero regressions

## Notes
- **No new dependencies.**
- **No backend changes.** `items.removeEventItem` and its `requireEvent` gate
  are reused exactly as the Table view already uses them.
- **Academy:** not training-worthy. This adds a second UI entry point to a
  delete capability the Table view already exposes (and which the Academy
  does not currently teach as a distinct mechanic); the mental model of
  "a comms row can be removed" is unchanged. State this explicitly in the PR
  description per CLAUDE.md's "decide explicitly... or 'not training-worthy'".
- Manual verification (step 1c) is required before merge, per CLAUDE.md's
  UI-change expectations — this is a UI-only change with no automated
  render-level coverage available in this repo today.
