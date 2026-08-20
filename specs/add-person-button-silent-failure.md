# Bug: The "Add person" button on the People roster does nothing visible

## Bug Description

On the People tab (`apps/mobile/app/(app)/(tabs)/people.tsx`), the row at the
bottom of the roster grid reading **"+ Add person"** is meant to let a staffer
add a new person to the chapter roster. The reporter (issue #783, screenshot
attached) expects clicking it to open a modal to add someone. Instead:

- **On success**, the tap silently inserts a blank `"New person"` row into the
  (sorted, paginated) grid and does *nothing else* — no modal, no toast, no
  scroll-to, no indication a row was even created. In a roster of hundreds of
  people sorted by first name, a user who just clicked the button has no
  signal anything happened at all.
- **On failure** (e.g. a transient network hiccup, or the rarer case of a
  caller with no chapter membership), the thrown error is never caught. It
  becomes an unhandled promise rejection — again, completely silent from the
  user's point of view.

Both paths read identically to the user: click the button, watch nothing
happen. That is the reported "the button is not working."

**Expected:** clicking "Add person" opens a modal to add the person (per the
issue) — at minimum, immediate, visible feedback that the click did something
(the new person's detail sheet), and a visible error if the mutation fails.

**Actual:** the click is a true no-op from the user's perspective in both the
success and failure case.

## Problem Statement

`handleAddRow` (the tap handler wired to the "Add person" row) creates the
person but never surfaces the result to the UI: it discards the mutation's
return value (no modal opens) and has no error handling (a rejection vanishes
silently).

## Solution Statement

Wire `handleAddRow` to the modal-opening state (`setOpenId`) that this exact
screen already uses for every other "show me this person" entry point (row
tap, cross-tab deep links) — `PersonDetail`/`setOpenId` is a fully-built modal
already rendered at the bottom of this component. Capture the id the `create`
mutation resolves to and pass it to `setOpenId`, so the moment the row is
created its detail sheet opens — satisfying the issue's "opening up a modal
to do so" ask with the modal infrastructure that already exists, rather than
building a new one. Wrap the call in the same `try/catch` + `alertError(err)`
pattern already used elsewhere in this file (e.g. the manager-picker's
`onPick` handler) so a failed create surfaces a real error instead of
vanishing.

This is preferred over building a brand-new "create person" modal because
that would duplicate `PersonDetailBody`'s name/contact/detail fields for no
reason — the reporter's ask is satisfied by opening the existing detail sheet
immediately after creation, and it is the smallest change that fixes both the
success-silence and failure-silence symptoms at their single shared origin.

## Steps to Reproduce

**Not reproduced via a live UI session** — the mobile app was not launched
interactively for this plan. Instead, the bug was traced statically end to
end, entry point through to the defect, which is sufficient here because nothing
about the defect is conditional or flaky — it fires on every single click,
100% of the time, by inspection of the code:

1. Entry point: `apps/mobile/app/(app)/(tabs)/people.tsx:719-725` — the
   `Pressable` rendering the "+ Add person" row, `onPress={handleAddRow}`.
2. `handleAddRow` (`people.tsx:423-425`):
   ```ts
   async function handleAddRow() {
     await create({ name: "New person" });
   }
   ```
   `create` is `useMutation(api.people.create)` (`people.tsx:197`).
3. `create`'s only effect on component state: none. The return value
   (the new person's `Id<"people">`) is never read. No call to `setOpenId`
   (the state that controls the `PersonDetail` modal, `people.tsx:284`,
   rendered at `people.tsx:739-743`) is ever made from this handler.
4. There is no `try`/`catch` around the `await create(...)` call, unlike
   every other mutation call site in this same file (e.g. `people.tsx:1041-1049`,
   which wraps `update(...)` in `try { … } catch (err) { alertError(err); }`).
   A rejected `create(...)` promise here is unhandled.
5. Net effect of a click: the person is inserted into the `people` table
   (confirmed by reading `apps/convex/people.ts:699-772`'s `create` handler —
   it always succeeds for any authenticated chapter member) but the screen's
   only observable change is a new, easy-to-miss `"New person"` row somewhere
   in the sorted grid — or, on any failure, nothing at all.

This matches the issue's screenshot exactly: the "+ Add person" row is the
button in question, and the roster shown is exactly the kind of long, sorted,
paginated grid where a silently-inserted row is invisible.

## Root Cause Analysis

**File/line:** `apps/mobile/app/(app)/(tabs)/people.tsx:423-425`
(`handleAddRow`), called from the `Pressable` at `people.tsx:719-725`.

**Mechanism:** `handleAddRow` calls the `create` mutation but (a) discards its
resolved id instead of passing it to `setOpenId` (the state already wired to
open `PersonDetail`, this screen's existing person-editing modal — see
`people.tsx:284`, `298-302`, `739-743`), and (b) has no `try/catch`, unlike
every other mutation call in this file, so any rejection is an unhandled
promise rejection instead of an `alertError(err)` call.

**Confidence:** high.

**Why this is the root, not a symptom:** there is no deeper layer to this —
the backend `create` mutation (`apps/convex/people.ts:699-772`) does exactly
what it's supposed to (inserts the row, returns its id) and is otherwise
unrelated to the bug; the defect is entirely in this one handler's failure to
consume the mutation's outcome. Fixing this one function fixes BOTH observed
symptoms at once (success looks like a no-op; failure looks like a no-op) —
the same missing wiring explains both, which is the signal this is the root
and not a crash site. If only the missing-modal half were patched (e.g. by
scrolling to the new row) the silent-failure half would remain; if only a
`try/catch` were added without opening the modal, a *successful* add would
still be invisible. Both must be fixed together, and both are fixed by the
same four-line change.

## The Failing Test

- **File:** `apps/mobile/components/people/addPerson.logic.ts` (new — the pure
  decision logic extracted out of the hook-bound handler, so it is testable
  without rendering the component) and
  `apps/mobile/components/people/addPerson.logic.test.ts` (new).
- **Follows the pattern in:** `apps/mobile/components/mentions/mentionTrigger.logic.ts`
  + `apps/mobile/components/mentions/mentionTrigger.logic.test.ts` — this repo's
  established convention for extracting a small pure function out of a
  component so `apps/mobile`'s Jest config (which is explicitly a **node**
  environment for dependency-free logic, *not* a component-rendering
  environment — see the header comment in `apps/mobile/jest.config.js`) can
  test it directly, importing `describe`/`expect`/`test` from `@jest/globals`
  (no ambient jest types configured for this package).
- **Bug kind:** State/lifecycle (what the "add" action's outcome resolves to —
  a new id to open, or a caught error — not just "the initial render").
- **Name:** `addPersonAndGetOpenId`
- **Asserts:**
  1. On a `create` that resolves to an id, the function returns
     `{ id: "<that id>" }` (the shape the caller uses to call `setOpenId`).
  2. On a `create` that rejects, the function returns `{ error }` (the
     rejection is CAUGHT and returned, not re-thrown/left unhandled) — i.e.
     `await addPersonAndGetOpenId(create)` never throws even when `create`
     rejects.
  3. On success, `create` was called with `{ name: "New person" }` (the
     default the row currently relies on — pin this so the fix doesn't
     silently change what a blank add creates).
- **Expected failure before the fix:** this exact module doesn't exist yet
  (the logic is presently inline in `handleAddRow` with no return value and
  no catch), so the test fails on
  `Cannot find module './addPerson.logic' from 'addPerson.logic.test.ts'`
  until the extraction is done as part of the fix. (There is no way to write
  a RED test against the *current* `handleAddRow` in place — it isn't a
  separately-callable, testable unit; the extraction in Task 2 IS the fix's
  first step, immediately followed by the test in the same task.)

**Regression test at the symptom (manual/documented, not automated):** there
is no component-rendering harness in `apps/mobile` (confirmed: no
`react-test-renderer`, no `@testing-library/react-native`, and
`jest.config.js` documents its Jest instance is a plain node environment,
"NOT the component runtime"). Introducing one would be a testing-infrastructure
change far beyond this bug's scope. The user-visible regression check for this
bug is therefore manual: after the fix, tap "+ Add person" and confirm the
`PersonDetail` modal opens immediately showing "New person" (see Validation
Commands).

## Relevant Files

Use these files to fix the bug:

- `apps/mobile/app/(app)/(tabs)/people.tsx` — contains `handleAddRow`
  (`:423-425`), the `create` mutation hook (`:197`), the `openId`/`setOpenId`
  state (`:284`), and the already-rendered `PersonDetail` modal (`:739-743`)
  this fix wires the new person into. This is the only file with a behavior
  change.
- `apps/mobile/lib/errors.ts` — `alertError`, already imported into
  `people.tsx` (`:39`) and used at `:1047` for exactly this "fire-and-forget
  tap action" failure mode (see its own doc comment). Reuse it, don't
  reinvent error surfacing.
- `apps/mobile/components/mentions/mentionTrigger.logic.ts` +
  `.logic.test.ts` — the pattern to copy for extracting a pure, testable
  function out of this component (import style, `@jest/globals` usage, file
  naming).
- `apps/convex/people.ts:699-772` — the `create` mutation. Read for
  confirmation only; **not** touched by this fix (it already returns the new
  person's id correctly).

### New Files

- `apps/mobile/components/people/addPerson.logic.ts` — the extracted,
  testable `addPersonAndGetOpenId` function.
- `apps/mobile/components/people/addPerson.logic.test.ts` — its unit test.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Capture the baseline

- Run `pnpm turbo run test`. As of planning time this is fully green — 343
  test files / 5831 tests in `@events-os/convex`, 98 suites / 1349 tests in
  `@events-os/mobile`, all passing, plus `@events-os/shared` and
  `@events-os/router`. Confirm the same before starting; do not attribute any
  pre-existing red to this change (there shouldn't be any).

### 2. Extract the pure logic + write the failing test (RED)

- Create `apps/mobile/components/people/addPerson.logic.ts`:
  ```ts
  /**
   * What "Add person" should do with the roster-create mutation's outcome:
   * hand back the new person's id so the caller opens its detail sheet
   * immediately, or hand back the caught error so the caller can surface it —
   * never let a rejection go unhandled. (See #783 — before this existed,
   * `handleAddRow` neither opened anything on success nor caught anything on
   * failure, so every click looked like a no-op.)
   */
  export async function addPersonAndGetOpenId(
    create: (args: { name: string }) => Promise<string>,
    name = "New person",
  ): Promise<{ id: string; error?: undefined } | { id?: undefined; error: unknown }> {
    try {
      const id = await create({ name });
      return { id };
    } catch (error) {
      return { error };
    }
  }
  ```
- Create `apps/mobile/components/people/addPerson.logic.test.ts` following
  `mentionTrigger.logic.test.ts`'s shape (import `describe`/`expect`/`test`
  from `@jest/globals`, `jest.fn` from `@jest/globals` too), asserting the
  three behaviors in **The Failing Test** above.
- Run it: `pnpm --filter @events-os/mobile exec jest components/people/addPerson.logic.test.ts`.
  It should PASS immediately (this is a fresh, self-contained module — there
  is no RED state to observe here because the current bug lives in
  `people.tsx`, not in code this test imports yet). This is the exception the
  plan format allows for: the extraction *is* part of the fix, so write it
  and its test together, then prove it guards the real fix in Task 4.

### 3. Wire `handleAddRow` to the extracted logic

In `apps/mobile/app/(app)/(tabs)/people.tsx`:

- Add the import near the other `components/people/...` import (`:54`):
  ```ts
  import { addPersonAndGetOpenId } from "../../../components/people/addPerson.logic";
  ```
- Replace `handleAddRow` (`:423-425`):
  ```ts
  async function handleAddRow() {
    const result = await addPersonAndGetOpenId(create);
    if (result.error !== undefined) {
      alertError(result.error);
      return;
    }
    setOpenId(result.id);
  }
  ```
  (`create` and `setOpenId` are already in scope — `:197` and `:284`
  respectively — and `alertError` is already imported at `:39`.)

### 4. Prove the test guards the fix (PROVE)

- Temporarily revert `people.tsx`'s `handleAddRow` to its original body
  (discard the result, no `setOpenId`/`alertError`) while leaving
  `addPerson.logic.ts` + its test in place.
- Re-run `pnpm --filter @events-os/mobile exec jest components/people/addPerson.logic.test.ts`
  — it still passes (the unit test exercises the extracted function directly,
  not `handleAddRow`), which is expected and fine: the unit test's job is to
  pin the *contract* `addPerson.logic.ts` must honor, not to detect whether
  `people.tsx` calls it correctly. The thing that actually proves the fix is
  the manual check in Task 5 (open the modal). Confirm that with
  `handleAddRow` reverted, tapping "+ Add person" (manually, per Task 5) goes
  back to being silent — then restore the Task-3 wiring.
- Restore the Task 3 change. Confirm `addPerson.logic.test.ts` is green and
  `handleAddRow` is back to the fixed version before continuing.

### 5. Manual confirmation (the actual user-visible regression check)

- Using the `/run` skill (or `pnpm --filter @events-os/mobile dev` /
  `expo start --web`), open the People tab, click "+ Add person", and confirm:
  - The `PersonDetail` modal opens immediately, showing "New person" as the
    name (and the row exists in the roster once the modal is closed).
  - (If reachable) force a `create` rejection (e.g. temporarily throw in a
    local dev build, or note this is covered by the unit test's error-path
    assertion since it isn't practically forceable through the real UI) and
    confirm an alert/message appears instead of nothing.

### 6. Sweep for siblings (SWEEP)

- Search for other fire-and-forget mutation calls in this same file that
  lack the `try { … } catch (err) { alertError(err); }` wrapper:
  `grep -n "await create(\|await update(\|await remove(" apps/mobile/app/\(app\)/\(tabs\)/people.tsx`
  and check each result's surrounding lines for a `catch`.
- Any other call site with the exact same "no catch, discarded result" shape
  as `handleAddRow` had → note it in the PR description as a follow-up (do
  **not** fix it here — it needs its own diagnosis of what the caller should
  do with the result, which is out of scope for this bug). Do not expand this
  fix's blast radius beyond `handleAddRow`.

### 7. Run the Validation Commands

- Every command below. Zero new regressions vs. the Task 1 baseline (fully
  green).

## Validation Commands

- `pnpm --filter @events-os/mobile exec jest components/people/addPerson.logic.test.ts` —
  new test; passes once `addPerson.logic.ts` exists (Task 2), and continues
  to pass after the `people.tsx` wiring (Task 3).
- `pnpm --filter @events-os/mobile test` — full mobile suite, zero
  regressions (98 suites / 1349 tests passing at baseline).
- `pnpm --filter @events-os/mobile typecheck` — the `people.tsx` edit and new
  `.logic.ts` file must typecheck cleanly (no explicit `returns` validator on
  `api.people.create` is fine — confirmed by an existing precedent capturing
  its sibling mutations' ids the same way, e.g.
  `apps/mobile/app/(app)/event/new.tsx:383`).
- `pnpm --filter @events-os/mobile lint` — lint clean.
- `pnpm turbo run test` — full suite, zero regressions across all packages.

## Regression Risk

- **Low.** The change is scoped to one handler in one file; `setOpenId` and
  `PersonDetail` are pre-existing, already-exercised-by-every-row-click
  machinery — this fix is simply one more caller of state that already works
  correctly (row-tap already calls `setOpenId(p._id)` at `:695`, and the deep
  -link path already opens `PersonDetail` via the same state on mount).
- **What a reviewer should look at hardest:** that `alertError` is only
  called on the error path (not also on success — a double-fire would show a
  spurious error alert on every successful add), and that `result.error`
  is checked as `!== undefined` rather than a truthy check (an error value of
  `0`/`""`/`false` is not realistic here since it's always a thrown
  `unknown`, but the discriminated-union shape should still be checked
  correctly per the type).
- Nothing about pagination, sorting, or the `people.list`/`people.get`
  queries changes — the newly-created person is found via the SAME
  `openPersonOnPage` / `openPersonFallback` lookup (`people.tsx:298-302`)
  already used for row-taps and deep links, so it is proven-correct
  machinery, not new risk.

## Notes

**Pre-existing failures** (recorded at planning time): none — `pnpm turbo run
test` is fully green (343 test files / 5831 tests in `@events-os/convex`, 98
suites / 1349 tests in `@events-os/mobile`, `@events-os/shared` and
`@events-os/router` also green).

**No new dependencies.** The extraction to `addPerson.logic.ts` is not a
refactor for its own sake — it's the minimum structural change required to
make this fix unit-testable at all under `apps/mobile`'s existing Jest setup
(a node-only environment for dependency-free logic; no
`react-test-renderer`/`@testing-library/react-native` is installed, and
adding either would be test-infrastructure scope creep well beyond a
surgical bug fix). This mirrors an existing, deliberate pattern in the same
package (`components/mentions/*.logic.ts`), not a new one invented for this
bug.

**Left deliberately unfixed:** any other fire-and-forget mutation call sites
this file may have beyond `handleAddRow` (see Task 6's sweep) — each would
need its own diagnosis of what "surface this to the user" should mean for
that specific action, which is out of scope here.

**Never weaken, skip, or delete a test to reach green.** If an existing test
genuinely encodes wrong behavior, escalate it to the user with reasoning —
do not quietly edit it.
