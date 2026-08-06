# Feature: Tapping a @mention opens a person preview modal instead of navigating

## Feature Description
Everywhere a `@mention` (a person or role/seat mention, e.g. `@Ada Okafor` or
`@Music Director`) renders as tappable text — planning-doc/duties/comms grid
cells, run-of-show card notes — tapping it currently navigates away to the
People tab. This feature replaces that navigation with an in-place modal
showing the person's name, photo, role, and contact info, plus a "View full
profile" button for anyone who does want to jump to their full People-tab
record.

## User Story
As a chapter lead filling out a planning table
I want to tap a mentioned person's name and see who they are without leaving
the page I'm working on
So that checking "who is `@Music Director` these days?" doesn't blow away my
place in the table I'm editing

## Problem Statement
`MentionText` (`apps/mobile/components/mentions/MentionText.tsx`) renders
every resolved mention as a `<Text onPress={... router.push("/people?openId=...")}>`.
On mobile and web alike, tapping a name mid-edit jumps the whole app to the
People tab, discarding the user's place in whatever grid/card they were
editing — jarring specifically because it happens *while the user is still
working on the same page* (per the founder's framing in the linked
screenshot: clicking "Ada Okafor" from inside a task cell shouldn't feel like
leaving the task).

## Solution Statement
Give `MentionText` a lightweight, chapter-scoped preview modal to open in
place of navigating, and put a "View full profile" button on it for the
user who does want the full People-tab record.

This is not a new pattern: `apps/mobile/components/event/CrewSections.tsx`
already has an almost-identical "read-only contact + engagement history"
modal (`PersonDetail`/`PersonDetailBody`/`ContactLink`, lines 401–550) that
opens when a crew-roster name is tapped, built on the exact same
`api.people.get` + `api.engagements.historyForPerson` queries this feature
needs. Rather than write a *third* near-duplicate of that modal shape (the
People tab's own heavier, editable `PersonDetail` being the second), this
plan extracts CrewSections' version into a shared, reusable
`PersonPreviewModal` component, adds the one thing it's missing (a "View
full profile" link out to the People tab, plus a real photo instead of
always-initials), and points both `MentionText` and `CrewSections` at it.
This is the smaller, more consistent change than building a fourth modal
from scratch, and it removes ~150 lines of duplicated modal chrome from
`CrewSections.tsx` in the process.

**Alternative considered:** building a brand-new mention-specific modal from
scratch. Rejected — it would be the third near-identical "tap a name, see a
read-only contact card" implementation in this codebase (People tab's
`PersonDetail`, CrewSections' `PersonDetail`, and a new one), which is
exactly the kind of invented-pattern duplication `/plan_feature` guards
against when a close analogue already exists.

## Scope
**In scope:**
- A new shared `PersonPreviewModal` component (name, avatar/photo, role,
  company, email/phone as tappable links, event history, "View full
  profile" button, close affordance).
- `apps/convex/people.ts#get` resolving `imageUrl` from the person's stored
  photo (mirrors the resolution `people.ts#list` already does), so the new
  modal (and the People-tab deep-link fallback that already calls `get`)
  can show a real photo instead of always falling back to initials.
- `CrewSections.tsx` adopting the shared modal in place of its local
  `PersonDetail`/`PersonDetailBody`/`ContactLink`.
- `MentionText.tsx` opening the shared modal on tap instead of calling
  `router.push`, for every mention-rendering surface that uses it
  (`EditableGrid`/`cells.tsx`, `DutiesGrid.tsx`, `ItemCardText.tsx`) — no
  changes needed at those call sites since `MentionText`'s public props are
  unchanged.

**Out of scope:**
- Editing a person's info from inside the preview modal (the People tab's
  own `PersonDetail`/`PersonDetailBody` stays the one editable, full-detail
  sheet — this new modal is read-only, matching CrewSections' existing one).
- Changing what a mention *resolves to* (`resolveMentionToken`,
  `MentionDataProvider`) — untouched.
- `apps/mobile/app/(app)/giving/donors.tsx`'s own `/people?openId=` link (a
  different tap target, not a mention) — untouched.
- `apps/mobile/app/(app)/(tabs)/people.tsx`'s `openPersonFallback` merge
  (currently hardcodes `imageUrl: null` for a cross-tab deep link whose
  person isn't on the loaded page) — `get` gaining a real `imageUrl` makes
  that hardcoding stale, but changing that merge line is a separate,
  unrequested cleanup; flagged in Notes.
- Adding a component-rendering test harness (e.g. `@testing-library/react-native`)
  to this repo — see Notes.

## Relevant Files
- `apps/mobile/components/event/CrewSections.tsx` — **the existing pattern
  to follow.** Its `PersonDetail`/`PersonDetailBody`/`ContactLink` (lines
  401–550) is the read-only preview modal this feature generalizes; it also
  owns the 3 call sites (`onOpen` at lines 674, 788, and the mount at
  987–991) that must keep working unchanged after the extraction.
- `apps/mobile/components/mentions/MentionText.tsx` — change the resolved-
  mention `onPress` (currently `router.push`) to open the shared modal;
  update its module doc comment (lines 1–13), which currently documents the
  navigate-away behavior.
- `apps/convex/people.ts` — extend the `get` query (currently ~line 639) to
  resolve `imageUrl`, mirroring `list`'s own `p.image ? await ctx.storage.getUrl(p.image) : null`
  (lines 215, 445, 598).

### New Files
- `apps/mobile/components/people/PersonPreviewModal.tsx` — the shared
  read-only person preview modal (name, avatar/photo, role/company, contact
  links, event history, "View full profile" button, close). Generalizes
  CrewSections' `PersonDetail`/`PersonDetailBody`/`ContactLink`.
- `apps/convex/tests/peopleGet.test.ts` — characterizes `people.get`'s new
  `imageUrl` resolution.

## Implementation Plan

### Phase 1: Foundation
`people.get` resolves `imageUrl` from the stored photo, exactly like `list`
already does — the data the new modal (and CrewSections' existing one, for
free) needs to show a real photo instead of always falling back to
initials.

### Phase 2: Core Implementation
Extract CrewSections' `PersonDetail`/`PersonDetailBody`/`ContactLink` into
`apps/mobile/components/people/PersonPreviewModal.tsx`, adding the photo
(now available from Phase 1) and a "View full profile" button that
navigates to `/people?openId=<personId>` and closes the modal. Point
`CrewSections.tsx` at the new shared component, deleting its local copy.

### Phase 3: Integration
`MentionText.tsx` opens `PersonPreviewModal` (self-contained local state)
instead of calling `router.push` on a resolved mention tap. No other
mention call site (`cells.tsx`, `DutiesGrid.tsx`, `ItemCardText.tsx`,
`MentionInlineText.tsx`) needs to change — they all consume `MentionText`
through its unchanged public props.

## Step by Step Tasks

### Milestone 1: `people.get` resolves `imageUrl`

**a. Write the failing test (RED).** Create
`apps/convex/tests/peopleGet.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, storeBlob } from "./setup.helpers";

describe("people.get", () => {
  test("resolves a stored photo to imageUrl, and null when there is none", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storeBlob(t);

    const withPhoto = await s.as.mutation(api.people.create, {
      name: "Ada Okafor",
      image: storageId,
    });
    const withoutPhoto = await s.as.mutation(api.people.create, {
      name: "No Photo",
    });

    const a = await s.as.query(api.people.get, { personId: withPhoto });
    const b = await s.as.query(api.people.get, { personId: withoutPhoto });

    expect(typeof a.imageUrl).toBe("string");
    expect(b.imageUrl).toBeNull();
  });
});
```

Run `pnpm --filter @events-os/convex exec vitest run tests/peopleGet.test.ts`
and confirm it fails with `a.imageUrl` being `undefined` (the field doesn't
exist on `get`'s return today), not a setup/import error.

**b. Implement the minimum to reach GREEN.** In `apps/convex/people.ts`,
change the `get` query's handler:

```ts
export const get = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const person = await requireOwned(ctx, "people", personId, "Person");
    return {
      ...person,
      imageUrl: person.image ? await ctx.storage.getUrl(person.image) : null,
    };
  },
});
```

**c. Run the full suite before moving on.**
`pnpm --filter @events-os/convex test` — confirm `peopleGet.test.ts` passes
and nothing in `orgProjects.test.ts` (the other direct `api.people.get`
caller) regresses.

### Milestone 2: Extract `PersonPreviewModal`, adopt it in `CrewSections.tsx`

**a. Write the failing test (RED).** There is no component-rendering test
harness in this repo (`apps/mobile/jest.config.js` runs Jest in a plain
`node` environment for colocated `*.logic.test.ts` pure-function tests only
— no `react-test-renderer` / `@testing-library/react-native` dependency is
installed, and none of `MentionText`, `MentionInlineText`, or
CrewSections' existing `PersonDetail` have ever had a render test). This
milestone has no automatable RED step; skip straight to (b) and verify
manually per the Acceptance Criteria and Testing Strategy notes below.

**b. Implement.**
1. Create `apps/mobile/components/people/PersonPreviewModal.tsx`. Move
   `PersonDetail`, `PersonDetailBody`, and `ContactLink` out of
   `CrewSections.tsx` into it, with these changes:
   - Rename `PersonDetail` → `PersonPreviewModal` (same props:
     `personId: string | null`, `name: string`, `onClose: () => void`).
   - `Avatar` gets a `uri={person?.imageUrl ?? null}` prop (falls back to
     initials while `person` is loading or has no photo) — the field
     Milestone 1 added.
   - Add a role/company subtitle line under the name when
     `person?.role` or `person?.company` is set (skip the line entirely
     when both are empty — don't render a bare separator).
   - Add a "View full profile" button in the footer, below the event
     history section, following the `TransactionDetailModal.tsx`
     (`apps/mobile/components/finance/dashboard/TransactionDetailModal.tsx:434-441`)
     nav-from-modal precedent:
     ```tsx
     <Pressable
       onPress={() => {
         onClose();
         router.push(`/people?openId=${personId}` as never);
       }}
       accessibilityRole="button"
       className="flex-row items-center justify-center gap-1 border-t border-border px-5 py-3 active:opacity-70 web:hover:opacity-90"
     >
       <Text className="text-sm font-medium text-accent">View full profile</Text>
       <Icon name="chevron-right" size={13} color={colors.accent} />
     </Pressable>
     ```
     (`useRouter` from `expo-router`, imported fresh in the new file.)
2. In `CrewSections.tsx`: delete the moved `PersonDetail`/`PersonDetailBody`/
   `ContactLink` functions (lines 401–550); import
   `{ PersonPreviewModal } from "../people/PersonPreviewModal"`; change the
   JSX at the mount site (lines 987–991) from `<PersonDetail ...>` to
   `<PersonPreviewModal ...>` with identical props — the three `onOpen`
   call sites (lines 674, 788, 639–641) need no changes.
3. Remove now-unused imports from `CrewSections.tsx`: `ScrollView`,
   `Modal`, `Linking` (from `react-native`), `Badge` (from `../ui`), and
   the `formatDate` import (from `../../lib/format`) — all were only used
   inside the code just moved out.

**c. Run the full suite before moving on.**
`pnpm --filter @events-os/mobile typecheck` and
`pnpm --filter @events-os/mobile lint` (catches the unused-import removals
and any prop-shape mismatch from the rename). Manually verify in a dev
build (`/run`): open an event's Crew view, tap a volunteer/vendor name —
the same modal (name, avatar, contact links, event history) still opens,
and now also shows a real photo when the person has one and a "View full
profile" button that lands on their People-tab record.

### Milestone 3: `MentionText` opens the modal instead of navigating

**a. Write the failing test (RED).** Same constraint as Milestone 2 — no
render/interaction test harness exists for this behavior. The pre-existing
`apps/mobile/components/mentions/mentionResolve.logic.test.ts` already pins
the *resolution* logic (which mention taps to a person at all) and needs no
changes; this milestone only changes what happens after resolution, which
this repo has no way to unit test. Skip straight to (b); verify manually.

**b. Implement.** In `MentionText.tsx`:
1. Add `const [openPerson, setOpenPerson] = useState<{ id: string; name: string } | null>(null);`.
2. Replace the resolved-mention `onPress` body:
   ```tsx
   onPress={(e) => {
     e?.stopPropagation?.();
     setOpenPerson({ id: resolved.personId, name: resolved.displayName });
   }}
   ```
   (the `stopPropagation` call is unchanged — still needed so a tap inside
   `MentionInlineText`'s tap-to-edit cell opens the modal instead of
   flipping the cell into edit mode).
3. Remove the now-unused `useRouter` import; add
   `import { PersonPreviewModal } from "../people/PersonPreviewModal";`.
4. Wrap the returned `<Text>` in a fragment and render the modal alongside
   it:
   ```tsx
   return (
     <>
       <Text className="px-2 text-sm text-ink" numberOfLines={numberOfLines}>
         {/* ...segments unchanged... */}
       </Text>
       <PersonPreviewModal
         personId={openPerson?.id ?? null}
         name={openPerson?.name ?? ""}
         onClose={() => setOpenPerson(null)}
       />
     </>
   );
   ```
5. Update the module doc comment (lines 1–13) to describe the modal-on-tap
   behavior and the modal's "View full profile" escape hatch, replacing the
   "jumps to that person's card on the People page" line.

**c. Run the full suite before moving on.**
`pnpm --filter @events-os/mobile typecheck`,
`pnpm --filter @events-os/mobile lint`, and
`pnpm --filter @events-os/mobile test` (confirms
`mentionResolve.logic.test.ts` and `mentionTrigger.logic.test.ts` still
pass unchanged). Manually verify: in a planning-doc/duties/comms grid cell
or a run-of-show card with a note containing `@Ada Okafor` or
`@Music Director`, tapping the mention opens the preview modal in place —
the underlying page does not navigate and does not lose scroll position —
and tapping "View full profile" lands on that person's card on the People
tab. Tap an unresolved mention (deleted person / vacant seat) and confirm
it's still plain, non-interactive italic text — no modal, no crash. Tap a
mention inside a grid cell (`MentionInlineText`) and confirm the cell does
NOT also flip into edit mode.

### Final step
Run every command in Validation Commands and confirm all exit clean.

## Testing Strategy

### Tests by Milestone

| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | `people.get` resolves `imageUrl` | `apps/convex/tests/peopleGet.test.ts` (new) | A person created with a stored photo resolves `imageUrl` to a string URL; one without resolves it to `null` | `get`'s handler returns the raw `people` doc with no `imageUrl` field at all — `a.imageUrl` is `undefined`, not a string |
| 2 | Extract + adopt `PersonPreviewModal` | *(manual verification — no RN render-test harness in this repo; see milestone step (a) and Notes)* | Crew-name tap still opens the same modal shape, now with a real photo and a "View full profile" button; `CrewSections.tsx` has no local `PersonDetail`/`PersonDetailBody`/`ContactLink` left | N/A — not an automatable test in this repo today |
| 3 | `MentionText` opens the modal on tap | *(manual verification — same constraint; existing `mentionResolve.logic.test.ts` must keep passing unchanged as a regression guard)* | Tapping a resolved mention opens the modal instead of navigating to `/people`; an unresolved mention stays non-interactive | N/A — not an automatable test in this repo today; `mentionResolve.logic.test.ts` guards the one piece of this milestone that *is* pure logic (mention resolution, untouched by this plan) |

**Pattern followed:** `apps/convex/tests/territories.test.ts:161-226`
("share-card image: stores, flags on the public page, serves via storage
id, and clears") for the storage→URL resolution test shape, using the
`storeBlob(t)` helper from `apps/convex/tests/setup.helpers.ts:56-62`. For
milestones 2–3: this repo's established practice of extracting *pure*
mention logic into `*.logic.ts` + `*.logic.test.ts` pairs
(`mentionResolve.logic.ts`/`.test.ts`) already covers the one genuinely
testable piece of this feature (mention resolution); this plan doesn't
touch that pair, and there is no equivalent extractable pure logic in the
tap→modal wiring itself.

### Integration Tests
N/A — the only backend/frontend seam this feature adds (`people.get`
returning `imageUrl`) is covered directly by Milestone 1's test; there is
no additional cross-service integration to exercise.

### Edge Cases
- **Unresolved mention** (deleted person, vacant seat): must remain plain,
  non-interactive italic text — no tap handler, no modal. Already covered
  by `resolveMentionToken`'s existing null-return tests; this plan's
  `onPress` change only applies to the already-resolved branch, so this
  case needs no new code, just manual confirmation in Milestone 3.
- **Person with no stored photo**: `imageUrl` resolves to `null` (Milestone
  1's second assertion); `PersonPreviewModal`'s `Avatar` falls back to its
  existing initials rendering (`uri` prop is falsy) — no new fallback logic
  needed.
- **Tapping a mention inside a grid cell** (`MentionInlineText`): the
  `stopPropagation` call must survive the `onPress` body swap so the modal
  opens without also flipping the cell into edit mode — covered in
  Milestone 3's manual verification.
- **Tapping a different mention while the modal is already open**: the
  self-contained `useState` in `MentionText` overwrites `openPerson`, so
  the modal's content swaps to the newly tapped person rather than stacking
  — inherent to the `useState` design, no extra code needed.
- **"View full profile" navigation**: must close the modal before/while
  navigating (`onClose()` then `router.push`), so returning to the
  originating page later doesn't leave the modal re-opening underneath —
  covered by Milestone 2's implementation, manually verified.

## Acceptance Criteria
- [ ] Tapping a resolved mention anywhere `MentionText` renders (planning
      grids, duties grid, run-of-show card notes) opens `PersonPreviewModal`
      in place; the app does not navigate to `/people` and the page behind
      it does not unmount or lose its state.
- [ ] The modal shows the person's name, avatar (real photo when
      `people.image` is set, else initials), role/company when present, and
      email/phone as tappable `mailto:`/`tel:` links when present.
- [ ] The modal has a "View full profile" button that navigates to
      `/people?openId=<personId>` and closes the modal.
- [ ] The modal has a close (×) button and closes on backdrop tap, matching
      every other modal in this app (`DuplicatesSheet`, the People tab's own
      `PersonDetail`).
- [ ] An unresolved mention (deleted person, vacant seat) still renders as
      non-interactive italic text — no modal opens, no crash.
- [ ] `CrewSections.tsx` contains no local `PersonDetail`, `PersonDetailBody`,
      or `ContactLink` definitions — it renders the shared
      `PersonPreviewModal` and its crew-name tap behavior is otherwise
      unchanged (name, avatar, contact links, event history all still show).
- [ ] `apps/convex/people.ts#get` returns `imageUrl: string | null` alongside
      the existing person fields.
- [ ] All Validation Commands exit clean.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm install --frozen-lockfile` — install deps
- `pnpm --filter @events-os/convex typecheck` — typecheck backend
- `pnpm --filter @events-os/convex exec vitest run tests/peopleGet.test.ts` — fast feedback on Milestone 1
- `pnpm --filter @events-os/convex test` — full backend suite, zero regressions
- `pnpm --filter @events-os/mobile typecheck` — typecheck the app
- `pnpm --filter @events-os/mobile lint` — catches unused imports from the CrewSections extraction
- `pnpm --filter @events-os/mobile test` — mobile Jest suite (mention `.logic.test.ts` files)
- `pnpm turbo run test` — full workspace fan-out, zero regressions
- `pnpm turbo run typecheck` — full workspace fan-out
- `pnpm turbo run lint` — full workspace fan-out

## Notes
- **No new dependency.** This plan does not add
  `@testing-library/react-native` or any other component-rendering test
  harness. `apps/mobile/jest.config.js` runs Jest in a plain `node`
  environment specifically for dependency-free pure-logic tests
  (`*.logic.test.ts`); adding a real component-render harness is a bigger,
  unrequested change and every existing modal in this codebase
  (`PersonDetail` ×2, `DuplicatesSheet`, etc.) already ships with zero
  render-test coverage. Milestones 2 and 3 are verified manually per their
  step (c) and the Acceptance Criteria instead.
- **Pre-existing gap.** `MentionText`'s tap behavior and every modal it's
  compared against here (`PersonDetail` in both `people.tsx` and
  `CrewSections.tsx`, `DuplicatesSheet`) have never had automated render
  coverage. This plan doesn't regress that; it extends the same
  already-untested surface.
- **Deferred cleanup (not part of this plan):** `people.tsx`'s
  `openPersonFallback` merge (`apps/mobile/app/(app)/(tabs)/people.tsx:413`)
  hardcodes `imageUrl: null` for a cross-tab `?openId=` deep link whose
  person isn't on the currently loaded page. Now that `people.get` resolves
  a real `imageUrl` (Milestone 1), that hardcoded `null` is stale — it will
  keep showing initials instead of the real photo for that one deep-link
  path. Fixing it is a one-line, unrelated cleanup; flagging it here rather
  than folding it into this PR's diff.
- **Design decision to confirm before implementation:** extracting
  CrewSections' existing modal into the new shared component gives
  CrewSections' crew-name tap a "View full profile" button and real photos
  it didn't have before, as a side effect of the dedup. If the founder
  wants CrewSections' behavior to stay pixel-identical to today, say so and
  Milestone 2 can add the button/photo only inside `MentionText`'s usage
  instead (at the cost of reintroducing the duplication this plan removes).
- **Design decision to confirm before implementation:** the new modal
  includes the "Event history" section (`api.engagements.historyForPerson`)
  for full parity with the CrewSections pattern being followed. If a
  leaner preview (no history) is preferred for the mention-tap context
  specifically, that section can be made optional via a prop — not planned
  here since nothing in the request asked for it.
