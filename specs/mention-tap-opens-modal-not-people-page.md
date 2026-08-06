# Bug: Tapping an @mention navigates away to the People page instead of opening a modal

## Bug Description

Anywhere a free-text note contains an `@mention` (typed as `@Seyi Olujide` or
`@Music Director` and stored as `@[label](mention:person:<id>)` /
`@[label](mention:seat:<id>)` markup), the rendered mention is tappable. Today,
tapping it immediately navigates the whole screen to the People tab
(`router.push('/people?openId=<personId>')`). Reported symptom: doing this from
the Tasks table on an event's planning screen (see the screenshot of tapping
"Ada Okafor") yanks the user off the page they were actively working on — jarring
mid-edit.

**Expected:** tapping a mention opens a modal, in place, showing that person's
info (contact + event history). The modal has a "View full profile" button that
is the *deliberate* way to leave for the People tab; simply reading who was
mentioned should never navigate away.

**Actual:** tapping a mention unconditionally calls `router.push`, leaving the
current page immediately with no modal step.

## Problem Statement

`MentionText` (`apps/mobile/components/mentions/MentionText.tsx`) is the single
read-mode renderer for every mention-aware surface in the app — the event
planning grid's Tasks/Comms/Run of Show/Supplies/Permits/Debrief notes columns,
and the Duties grid's Notes column. Its mention `onPress` handler navigates
instead of surfacing an in-place modal, and no "person modal that isn't tied to
a specific feature's own table" exists yet to reuse.

## Solution Statement

Give `MentionText` local state for "which person is open" and have a tap set it
instead of navigating; render a new shared, read-only `PersonDetailModal`
(contact info + event history, modeled on the near-identical modal already
private to `components/event/CrewSections.tsx`) when a person is open. The
modal's own "View full profile" button performs the `router.push` that used to
fire on every tap, so leaving the page is still one tap away, just no longer the
default outcome of tapping a name.

This is the minimal fix because `MentionText` is the *only* place the wrong
`router.push` call exists (confirmed by grep — see Root Cause Analysis) and it
is already the single choke point every mention-aware surface renders through,
so fixing it here fixes every surface in one change with no per-feature wiring.

**Alternative considered and rejected:** extracting/merging with the People
tab's own detail sheet (`app/(app)/(tabs)/people.tsx`'s `PersonDetail`) or with
`CrewSections.tsx`'s local modal. Both are heavier, editable/feature-specific
surfaces (the People tab's sheet has a full edit form; `CrewSections`' modal is
purpose-built for its own crew list) — touching either risks unrelated
regressions for a bug that only needs a small, read-only, reusable modal. Left
both files untouched.

## Steps to Reproduce

Could not run the Expo app in this environment to reproduce interactively. The
defect is unambiguous from static reading, not a "maybe" — `MentionText`'s
`onPress` handler (`apps/mobile/components/mentions/MentionText.tsx:59-62`)
calls `router.push` unconditionally for every resolved mention tap, with no
conditional path and no modal ever rendered by this component today.

Manual reproduction for a human tester (matches the reported screenshot):
1. Open any event with a Tasks table populated, `pnpm run:local` (or the
   project's normal `expo start` flow).
2. In a task's Description/Notes cell, ensure it contains a mention (type `@`
   then a person's name, or a seat like `Music Director`, and pick a match —
   see `apps/mobile/components/mentions/MentionTextInput.tsx` for the picker).
   Tap elsewhere to commit and leave edit mode so the cell renders the mention
   as a link.
3. Tap the mentioned person's name.
4. **Actual:** the app immediately switches to the People tab.
   **Expected:** a modal opens in place, over the Tasks table, showing that
   person's contact info and event history, with the Tasks table still behind
   it.

## Root Cause Analysis

**File/line:** `apps/mobile/components/mentions/MentionText.tsx:59-62` (current,
pre-fix code):

```tsx
onPress={(e) => {
  e?.stopPropagation?.();
  router.push(`/people?openId=${resolved.personId}` as any);
}}
```

**Causal chain:** every mention-aware cell (grid `text`/`longtext` columns via
`columnRegistry.tsx`'s `mentionable: true` → `cells.tsx`'s `GridCell` →
`MentionInlineText` → `MentionText`; and `DutiesGrid.tsx`'s Notes column
directly) renders a resolved mention as a `<Text onPress=...>` whose only
behavior is this `router.push`. There is no branch, no modal, no way to display
the person in place — the navigation *is* the entire tap behavior today.

**Confidence:** high.

**Why this is the root, not a symptom:** this is the only `router.push` call
tied to mention taps in the codebase (`grep -rn "router.push.*openId" apps/mobile`
returns exactly this line plus the unrelated Donors-grid "Linked person" column
— see Regression Risk). It's not a downstream effect of some other bug; it's the
literal, sole implementation of "what happens when you tap a mention." Fixing it
here — replacing the call with local modal-open state — fixes every mention
surface at once: the reported Tasks table, plus Comms/Run of Show/Supplies/
Permits/Debrief notes and the Duties grid's Notes column, all of which route
through this same component (confirmed via grep — see Sweep below). Patching
anywhere downstream (e.g. in `cells.tsx` or `DutiesGrid.tsx` individually) would
require duplicating the fix per surface and miss the reusable-modal aspect of
the ask.

## The Failing Test

**Tooling gap, stated up front:** this repo's mobile test harness has no
React-render testing capability at all — `apps/mobile/jest.config.js` runs
`testEnvironment: "node"` and `testMatch` only picks up `*.test.ts` (not
`.tsx`); no `@testing-library/react-native` or `react-test-renderer` is a
dependency anywhere in the workspace. Every existing test under
`components/mentions/` (`mentionResolve.logic.test.ts`,
`mentionTrigger.logic.test.ts`) is therefore a **pure-function** test against a
colocated `*.logic.ts` file, not a rendered-component test — that is the
established pattern for anything in this directory, and it's the only kind of
automated test this bug can get in this repo without introducing new test
infrastructure (out of scope for a surgical bug fix — not proposed here).

Given that, the fix follows the same pattern: extract the one piece of this
change that *is* a pure function — the People-tab deep-link route the "View
full profile" button still needs to build — into its own `*.logic.ts`, and pin
it with a real test. This guards that the one remaining navigation path (the
explicit button) keeps using the exact `/people?openId=<id>` contract the
People tab's `openId` deep-link consumption depends on
(`apps/mobile/app/(app)/(tabs)/people.tsx` — see Explore findings). It does
**not**, on its own, prove that tapping a mention no longer navigates — that
half of the fix is verified manually (see the Manual Verification task below),
because this repo has no automated way to assert on-tap behavior for a
component that renders through React Native's runtime.

- **File:** `apps/mobile/components/people/personProfileRoute.logic.test.ts`
  (new)
- **Follows the pattern in:**
  `apps/mobile/components/mentions/mentionResolve.logic.test.ts` — same
  `@jest/globals` import style (this package has no `@types/jest` ambient
  globals configured), same "pure function, plain `expect().toBe(...)`" shape.
- **Bug kind:** closest table entry is "Rendering / output," but per the gap
  above, the automatable portion of this fix is the route-string contract, which
  is closer to "Wrong value / calculation" in shape: pin the exact expected
  output for the exact input.
- **Name:** `"builds the People tab deep link for a person id"`
- **Asserts:** `personProfileRoute("p1")` returns exactly `"/people?openId=p1"`
  — the same string the old (buggy) unconditional `router.push` used to send,
  now used only by the modal's explicit "View full profile" button.
- **Expected failure before the fix:** `Cannot find module
  './personProfileRoute.logic'` — the module doesn't exist yet at all (this is
  a new file created as part of the fix, so the "RED" state is an import
  failure, not an assertion failure; see the discrimination table in step 2 of
  the implementation task list, and treat this specific "module doesn't exist
  yet" case as expected/correct RED, not a broken test, since the fix task
  itself creates that module).

**Manual verification (not automated — see tooling gap above), required before
calling this fixed:**
1. Follow "Steps to Reproduce" above through step 3.
2. Confirm a modal opens over the Tasks table (URL/route does *not* change —
   still on the event screen) showing the tapped person's name, contact info
   (if any), and event history.
3. Tap the modal's "View full profile" button; confirm it closes the modal and
   navigates to the People tab, landing on that same person's detail sheet
   (the existing `openId` deep-link behavior on `app/(app)/(tabs)/people.tsx`).
4. Repeat steps 1-3 for a **seat** mention (e.g. `@Music Director`) — confirm
   the modal shows the seat's current holder, matching `resolveMentionToken`'s
   existing role-resolution behavior (unchanged by this fix).
5. Repeat from the Duties grid's Notes column (`app/(app)/(tabs)/team.tsx` or
   `.../responsibilities.tsx`) to confirm the same fix applies there too (same
   root cause, same component).

## Relevant Files

Use these files to fix the bug:

- `apps/mobile/components/mentions/MentionText.tsx` — the defect. Its `onPress`
  handler is what changes: `router.push(...)` → local `setOpenPersonId(...)`
  state, plus rendering the new `PersonDetailModal` when a person is open.
- `apps/mobile/components/event/CrewSections.tsx` (read-only reference, not
  modified) — its private `PersonDetail`/`PersonDetailBody` (search for `//
  ── Person detail modal (read-only contact + engagement history)
  ──────────────`, currently around lines 401-522) is the template: same
  `Modal`/`Pressable` overlay chrome, same `api.people.get` +
  `api.engagements.historyForPerson` queries, same contact-link and event-
  history rendering. Copy its shape into the new shared modal; do not import
  from or edit this file — it stays local to the crew list, which reaches it
  via a name tap in its own table, not a mention.
- `apps/mobile/components/mentions/mentionResolve.logic.ts` — unchanged;
  `MentionText` already calls `resolveMentionToken` to get `{ personId,
  displayName }` before deciding what to do with a tap. Only the "what to do"
  changes.
- `apps/mobile/components/mentions/MentionInlineText.tsx` — unchanged, but read
  to confirm `MentionText` is always rendered as a standalone child (inside a
  `Pressable`, never nested inside another `Text`), so returning a `Fragment`
  (a `Text` plus a conditional `Modal`) from `MentionText` is safe here.
- `apps/mobile/components/work/DutiesGrid.tsx` (around lines 654-683, the Notes
  column) — unchanged, but confirms the second, independent consumer of
  `MentionText` that this fix also covers (see Sweep task).
- `apps/mobile/app/(app)/(tabs)/people.tsx` — unchanged; confirms the
  `?openId=<personId>` deep-link contract (`useLocalSearchParams<{ openId?:
  string }>()`, around lines 270-293) that the modal's "View full profile"
  button must keep sending traffic to.
- `apps/convex/people.ts` (`get` query, ~line 639) and
  `apps/convex/engagements.ts` (`historyForPerson`) — unchanged backend
  queries the new modal calls, identical to what `CrewSections.tsx` already
  calls.
- `apps/mobile/components/ui/index.ts` — barrel for `Avatar`, `Badge`,
  `Button`, `Icon`, all reused by the new modal exactly as `CrewSections.tsx`
  already uses them.
- `apps/mobile/components/mentions/mentionResolve.logic.test.ts` — the pattern
  the new `personProfileRoute.logic.test.ts` follows (import style, assertion
  style).

### New Files

- `apps/mobile/components/people/PersonDetailModal.tsx` — the shared, read-only
  person modal (contact info + event history + "View full profile" button),
  modeled on `CrewSections.tsx`'s private `PersonDetail`/`PersonDetailBody`.
- `apps/mobile/components/people/personProfileRoute.logic.ts` — the one-line
  pure function building the `/people?openId=<personId>` route string, used by
  the modal's "View full profile" button.
- `apps/mobile/components/people/personProfileRoute.logic.test.ts` — the
  failing/passing test for the above.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Capture the baseline
- Run `pnpm turbo run test`. At planning time this was **fully green**: 5/5
  tasks successful, including `@events-os/convex:test` (240 files / 3909 tests
  passing) and `@events-os/mobile:test` (jest). Record this baseline; any
  failure the implementing agent sees is caused by their own change, not
  pre-existing (see `Notes`).

### 2. Write the failing test (RED)
- Create `apps/mobile/components/people/personProfileRoute.logic.test.ts` per
  "The Failing Test" above, importing from
  `./personProfileRoute.logic` (which does not exist yet).
- Run it: `pnpm --filter @events-os/mobile exec jest
  components/people/personProfileRoute.logic.test.ts`.
- **Expected RED:** a module-not-found error (`Cannot find module
  './personProfileRoute.logic'`) — this is the correct RED state for a new
  file whose implementation is created in the next step, not a sign of a
  broken test. Record the actual output.

### 3. Add `personProfileRoute.logic.ts`
- Create `apps/mobile/components/people/personProfileRoute.logic.ts`:

  ```ts
  /**
   * personProfileRoute — the expo-router path to a person's full profile on
   * the People tab. Centralizes the `?openId=` deep-link contract (consumed
   * by apps/mobile/app/(app)/(tabs)/people.tsx's `useLocalSearchParams`) so
   * the one remaining caller that navigates there — PersonDetailModal's
   * "View full profile" button — can't drift from it.
   */
  export function personProfileRoute(personId: string): string {
    return `/people?openId=${personId}`;
  }
  ```
- Re-run the test from step 2. It should now pass (assertion, not import,
  RED→GREEN).

### 4. Add the shared `PersonDetailModal`
- Create `apps/mobile/components/people/PersonDetailModal.tsx`, porting the
  shape of `CrewSections.tsx`'s `PersonDetail`/`PersonDetailBody` (see
  "Relevant Files" for the exact lines to mirror):
  - Same outer `Modal`/`Pressable` overlay chrome (`visible={personId !==
    null}`, `transparent`, `animationType="fade"`, backdrop `Pressable` that
    closes on tap, inner `Pressable` with `onPress={() => {}}` to swallow taps
    so the card itself doesn't close the modal).
  - `useQuery(api.people.get, { personId })` for contact info, `useQuery(
    api.engagements.historyForPerson, { personId })` for event history —
    identical queries to `CrewSections.tsx`.
  - Header: `Avatar` + person's name (from the `people.get` result — unlike
    `CrewSections.tsx`'s version, this modal doesn't already have the name
    from a table row, so read it off the query result; show "Loading…" while
    `person` is `undefined`), close (`x`) button.
  - Body: contact links (email/phone via `Linking.openURL`) + event history
    list, same rendering as `CrewSections.tsx`.
  - Footer: a `Button` (`title="View full profile"`, `variant="secondary"`,
    `icon="external-link"`) whose `onPress` calls `onClose()` then
    `router.push(personProfileRoute(personId) as any)` (the `as any` cast
    matches the existing cast in the code being replaced — the route isn't in
    expo-router's generated static route list).
- Export `PersonDetailModal({ personId, onClose }: { personId: string | null;
  onClose: () => void })` as the public shape — same prop contract as
  `CrewSections.tsx`'s private version, so it's a drop-in for `MentionText`.

### 5. Rewire `MentionText`'s tap handler
- In `apps/mobile/components/mentions/MentionText.tsx`:
  - Import `useState` from `"react"` and `PersonDetailModal` from
    `"../people/PersonDetailModal"`.
  - Add `const [openPersonId, setOpenPersonId] = useState<string | null>(null);`
    at the top of the component.
  - Remove `const router = useRouter();` and the `useRouter` import (no longer
    needed — the component no longer navigates).
  - In the mention `onPress`, replace `router.push(\`/people?openId=${resolved.personId}\` as any);`
    with `setOpenPersonId(resolved.personId);` (keep the
    `e?.stopPropagation?.()` line — that guard is unrelated to this bug and
    still needed so a tap inside `MentionInlineText` doesn't also flip the
    cell into edit mode).
  - Change the component's `return` from a bare `<Text>...</Text>` to a
    `Fragment` (`<>...</>`) containing that same `<Text>` plus, as a sibling,
    `{openPersonId ? <PersonDetailModal personId={openPersonId} onClose={() => setOpenPersonId(null)} /> : null}`.
  - Update the file's top-of-file doc comment (currently says a mention "jumps
    to that person's card on the People page") to describe the modal-first
    behavior instead (see the Solution Statement's phrasing for what changed
    and why).

### 6. Prove the test guards the fix (PROVE)
- Temporarily revert `personProfileRoute.logic.ts` (delete it, or restore the
  pre-step-3 empty state) and re-run
  `pnpm --filter @events-os/mobile exec jest components/people/personProfileRoute.logic.test.ts`.
- **Fails again** (module not found) → ✅ guards the fix. Restore the file from
  step 3.
- Confirm green again before continuing.

### 7. Sweep for siblings (SWEEP)
- Search: `grep -rn "router.push\|router.navigate" apps/mobile/components apps/mobile/app --include="*.tsx" | grep -i "openid\|people"`
- Expect exactly two hits pre-fix: the (now-changed) `MentionText.tsx` line,
  and one unrelated hit in `app/(app)/(tabs)/people.tsx`'s own comment/doc
  describing the Donors-grid "Linked person" column's `router.navigate('/people?openId=...')`
  (a *different* feature — a dedicated grid column that always points at one
  specific person, not an `@mention` token; it's a deliberate "go look at this
  record" action, not a passing reference inside a note). Leave that one
  alone — same destination route, different UX intent, out of scope for this
  bug. If the grep turns up any *other* mention-tap navigation site beyond
  what's already accounted for here, treat it the same as this one (same root
  cause, same fix) rather than leaving it half-fixed.
- Also confirm (already established during planning, re-verify after your
  edit): `grep -rn "MentionText" apps/mobile/components --include="*.tsx"`
  shows only two direct-render sites — `MentionInlineText.tsx` and
  `DutiesGrid.tsx` — both fixed automatically since they render the same
  `MentionText` component; no per-file changes needed there.
- Academy check (per `CLAUDE.md`'s "Academy Must Track the Product"): grepped
  `packages/shared/src/academy/` for "mention" at planning time — every hit
  teaches the *concept* of @mentioning someone in an update/note, none
  documents the click-through UI behavior being changed here. No Academy
  update needed for this fix; re-confirm with the same grep if the
  implementation ends up describing tap behavior anywhere the Academy might
  reference.

### 8. Run the Validation Commands
- Every command below. Zero new regressions.

## Validation Commands

Execute every command to validate the bug is fixed with zero regressions.

- `pnpm --filter @events-os/mobile exec jest components/people/personProfileRoute.logic.test.ts` — fails before the fix (module not found), passes after
- `pnpm --filter @events-os/mobile test` — full mobile jest suite, zero regressions
- `pnpm --filter @events-os/mobile typecheck` — new/changed `.tsx` files type-check (verified script: `tsc --noEmit`, present in `apps/mobile/package.json`)
- `pnpm turbo run test` — full suite, zero regressions (5/5 tasks, was green at baseline)
- Manual verification per "The Failing Test" → "Manual verification" above —
  this is the only way to confirm the actual reported bug (tap no longer
  navigates) is fixed, given the tooling gap.

## Regression Risk

- **`MentionInlineText.tsx`'s tap-to-edit toggle:** it wraps `MentionText` in a
  `Pressable` whose own `onPress` flips the cell into edit mode; a mention's
  `onPress` calls `stopPropagation()` specifically so tapping a link doesn't
  also trigger that. This fix keeps that call — verify it wasn't accidentally
  dropped, or mention taps inside an editable cell will both open the modal
  AND flip the cell into edit mode underneath it.
- **`Fragment` return from `MentionText`:** changing its return from a single
  `<Text>` to a `Fragment` (`Text` + conditional `Modal`) is safe everywhere it
  is rendered today (`MentionInlineText.tsx`'s `Pressable`, `DutiesGrid.tsx`'s
  `Cell`) because neither nests it inside another `<Text>` — React Native
  would reject a non-`Text` child there. Re-check this if `MentionText` is
  ever used from a new call site.
- **Multiple `MentionText` instances on one screen:** each now owns its own
  `openPersonId` state independently (no shared context/provider). This is
  intentional and correct — only one instance's modal can be open at a time
  from a real single tap — but don't "fix" it into a shared context later
  without a reason; it would be unnecessary complexity for this bug.
- **The Donors-grid "Linked person" column** (`app/(app)/(tabs)/people.tsx`'s
  `openId` consumption) is explicitly untouched — it's a different feature
  reusing the same destination route, not an `@mention`. A reviewer should
  confirm this fix didn't touch that column's own navigation.
- **`CrewSections.tsx`** is read-only reference material here, not edited. A
  reviewer should confirm no accidental edits crept in there — it's tempting
  to "consolidate" its private `PersonDetail`/`PersonDetailBody` into the new
  shared modal, but that's out of scope for this bug fix (flagged as a
  follow-up cleanup opportunity, not done here, to keep this change surgical).

## Notes

**Pre-existing failures** (recorded at planning time — do NOT attribute these
to your changes): none — `pnpm turbo run test` was fully green (5/5 tasks,
240 convex test files / 3909 tests passing) at planning time.

**New dependencies:** none.

**Deliberately left unfixed / out of scope:**
- The Donors-grid "Linked person" column's own `router.navigate('/people?openId=...')`
  (different feature, same destination route) — see Regression Risk.
- Consolidating the three now-parallel read-only-ish person modals
  (`CrewSections.tsx`'s private one, the People tab's own editable
  `PersonDetail`, and this fix's new shared `PersonDetailModal`) into one
  implementation — real duplication, but merging them risks unrelated
  regressions in features this bug report didn't touch. Worth a follow-up
  cleanup ticket, not bundled here.

**Never weaken, skip, or delete a test to reach green.** If an existing test
genuinely encodes wrong behavior, escalate it to the user with reasoning — do
not quietly edit it. Silently editing a test to accommodate a change is how a
real defect ships behind a green suite.
