# Bug: @mentions don't work in the module-calendar Copy/Details box

## Bug Description

The Module Calendar's day-panel card (`ItemCard`) has a "Copy"/"Details" box
(`CopyEditor` in `apps/mobile/components/event/moduleCalendar/ItemCardText.tsx`)
that is a plain `TextInput`. Typing `@` in it does nothing — no suggestion
picker opens — and if the field's stored value already contains mention
markup (e.g. `@[Jordan](mention:person:p1)`, written from the grid's table
view where the same field IS mention-aware), the box renders that raw markup
as literal text instead of a tappable link.

**Expected** (parity with the grid cells shipped in #338/#342): typing `@`
opens the people/roles suggestion picker; picking inserts a mention token;
a value containing mentions renders as tappable links (person → their card,
role/seat → current holder) until tapped, then flips to the editable input.

**Actual:** `CopyEditor` has zero mention-system wiring — no `@`-trigger
detection, no suggestion popover, no `MentionText` rendering.

## Problem Statement

`CopyEditor` (comms calendar's "Copy" box, planning-doc's "Details" box —
same component, configured per-module via `moduleCalendar/config.ts`'s
`copyField`/`copyLabel`/`copyPlaceholder`) was never updated to use the
mention system when it was added to the app. It needs the same
display/edit-toggle + `@`-trigger behavior the grid's `longtext` cells and
`DutiesGrid`'s Notes cell already have, while keeping its own distinct visual
footprint (always-visible bordered `bg-sunken` box, `text-xs`, `border-accent`
on focus, `minHeight: 44`) — not the grid's borderless inline look.

## Solution Statement

Make `CopyEditor` mention-aware by delegating to the existing
`MentionInlineText` (display/edit toggle) instead of the current hand-rolled
`TextInput`, gated on `useMentionData()` returning non-null (mirrors both
existing integration points — `grid/cells.tsx`'s `GridCell` dispatcher and
`work/DutiesGrid.tsx`'s bespoke Notes cell). When `useMentionData()` returns
`null` (defensive fallback; in practice `ModuleCalendar` is always rendered
inside the event screen's `MentionDataProvider` — see Root Cause Analysis),
keep today's plain-`TextInput` behavior byte-for-byte, so no surface that
somehow renders `CopyEditor` outside a provider regresses.

To preserve `CopyEditor`'s box look (which differs from both existing
`MentionInlineText` call sites — the grid's borderless cell and
`DutiesGrid`'s borderless cell), add optional style-override props to
`MentionTextInput` (threaded through `MentionInlineText`) rather than forking
either component, per the bug report's own steer. Concretely:

- `MentionTextInput` gains optional `inputClassName` (replaces its default
  `className` string when provided) and `onFocusChange?: (focused: boolean) => void`
  (fires from its existing `onFocus`/`onBlur` handlers) — both default to
  today's behavior when omitted, so the grid and `DutiesGrid` call sites are
  unaffected.
- `MentionInlineText` gains the same two optional props and passes them
  through to `MentionTextInput` (its edit-mode child); its display-mode
  `Pressable` wrapping `MentionText` is left as-is (already unstyled/plain
  text — `CopyEditor` supplies the surrounding bordered box in both modes).
- `CopyEditor` keeps its own outer bordered `View` (border color driven by a
  `focused` state, as today) and renders `MentionInlineText` inside it when
  mention data is available, passing `inputClassName` matching its current
  `text-xs` styling and `onFocusChange` to drive the existing border-accent
  toggle. `MentionInlineText`'s display-mode (rendered links) is shown
  unwrapped inside the same bordered box, so the box border/background never
  disappears in either mode — only today's plain-`TextInput` behavior is
  being replaced.

This is the minimal change that reuses 100% of the existing trigger
detection, popover, encode/resolve logic (`mentionTrigger.logic.ts`,
`mentionResolve.logic.ts`, `MentionPopover(.web).tsx`) with zero duplication,
matching how `DutiesGrid.tsx` already integrates the same components outside
the grid-cell dispatcher.

**Alternative considered and rejected:** forking `MentionTextInput` into a
`CopyEditor`-specific variant. Rejected because it would duplicate the `@`
trigger/popover/insert logic that already has two working call sites
(#338/#342), doubling future maintenance for a purely cosmetic difference.

**Composer's copy field:** explicitly out of scope per the bug's own
Acceptance ("nice-to-have, not required") — do not touch
`moduleCalendar/Composer.tsx`.

## Steps to Reproduce

**Not interactively reproduced in a browser** (this planning pass does not
run the app). Instead, root cause was confirmed by static code inspection:

1. `grep -rn "MentionInlineText\|useMentionData\|MentionText\b" apps/mobile/components apps/mobile/app` —
   the only files importing any part of the mention system are
   `components/mentions/*` itself, `components/grid/cells.tsx`, and
   `components/work/DutiesGrid.tsx`. `components/event/moduleCalendar/ItemCardText.tsx`
   (or any other file in `moduleCalendar/`) does not appear.
2. Read `ItemCardText.tsx` in full (126 lines) — `CopyEditor` is a bare
   `TextInput` with `value`/`onChangeText`/`onFocus`/`onBlur`; no `@`
   detection, no popover, no `MentionText` rendering anywhere in the file.
3. Read `ItemCard.tsx` (the sole caller of `CopyEditor`) — it passes only
   `label`/`placeholder`/`initial`/`onSave`, confirming no mention data is
   threaded in at the call site either.

Given `CopyEditor` has literally no reference to any mention-system symbol,
a live repro would show exactly the reported symptom (typing `@` inserts a
literal `@` character and nothing else; a value with mention markup saved
elsewhere renders as raw `@[Label](mention:type:id)` text). The implementing
agent should still confirm this once, live, before starting (see Task 1 of
Step by Step Tasks), since this plan's confidence rests on static reading,
not an observed run.

## Root Cause Analysis

**File/line:** `apps/mobile/components/event/moduleCalendar/ItemCardText.tsx:78-125`
(`CopyEditor`) never imports or calls `useMentionData`, `MentionInlineText`,
`MentionText`, or `detectMentionTrigger`. It is the same plain-`TextInput`
implementation that existed before the mention system (#338/#342) was built;
those PRs wired mentions into the grid's `longtext`/`text` cell types
(`grid/columnRegistry.tsx`'s `mentionable: true` + `grid/cells.tsx`'s
`GridCell` dispatcher) and into `work/DutiesGrid.tsx`'s bespoke Notes column,
but never touched `moduleCalendar/`, which has its own, separate card
component (`ItemCard.tsx` → `ItemCardText.tsx`) that doesn't route through
either integration point.

Confirmed via `grep -rl "MentionInlineText\|useMentionData" apps/mobile/components apps/mobile/app`
returning only `components/mentions/*.tsx`, `components/grid/cells.tsx`, and
`components/work/DutiesGrid.tsx` — `moduleCalendar/` is entirely absent.

The data this needs is already available at this point in the tree:
`ModuleCalendar` (rendered by `ModuleSection`'s table/calendar toggle) sits
inside the event screen (`app/(app)/event/[id].tsx`), which mounts
`MentionDataProvider` around its whole body (line 558-974) — so
`useMentionData()` called from anywhere under `ItemCard`, including
`CopyEditor`, already returns real data with no new query or provider needed.

**Confidence:** high

**Why this is the root, not a symptom:** this isn't a bug where mention
detection misfires or a popover fails to open under some condition — the
component contains none of that code at all. There's no crash site to
mistake for the defect; the whole `@`-handling pathway is simply absent.
Fixing this (delegating to `MentionInlineText`) is also what fixes the
"existing tokens render as raw text" half of the bug report — both symptoms
share this one cause (no `MentionText`/`MentionInlineText` in the render
tree), so there's nothing left over to explain once this is wired up. The
Composer's copy field has the identical gap (also a plain `TextInput`,
`Composer.tsx`) but is explicitly out of scope (nice-to-have) per the bug
report.

## The Failing Test

**No automated test is being added for this fix — this is a deliberate,
documented deviation from the standard plan format, not an oversight.**

This repo has zero component-rendering test infrastructure by design:
`apps/mobile`'s Jest config (`apps/mobile/jest.config.js`) sets
`testEnvironment: "node"` (no DOM/JSDOM), there is no
`@testing-library/react-native` or `react-test-renderer` installed
(confirmed: `ls apps/mobile/node_modules/@testing-library` and
`ls apps/mobile/node_modules/react-test-renderer` both come up empty), and
there is no Playwright/Detox/e2e harness anywhere in the repo (confirmed:
`find . -iname "playwright*" -not -path "*/node_modules/*"` returns
nothing). `.claude/PROJECT.md`'s Testing Conventions states this explicitly:
"Only dependency-free logic is unit-tested; there are no component render
tests."

This exact situation already has a precedent in this codebase: the original
mention-system feature plan (`specs/mention-people-and-roles-in-notes.md`,
Steps 4-6) shipped `MentionText`, `MentionTextInput`, and the `DutiesGrid`
wiring with **no test file**, explicitly citing this same convention
("Steps 4–6 (components + grid wiring) have no dedicated test file... this
repo has no mobile component render tests by convention").

Adding real component-render coverage (installing
`@testing-library/react-native`, switching to a `jsdom`/RN test
environment) is exactly the kind of infra change the bug-planning
instructions say to flag rather than smuggle into a "minimal, surgical"
fix — it would touch the shared Jest config for every mobile test, not just
this bug.

**What replaces it:** this fix touches zero pure/dependency-free logic (it
reuses `detectMentionTrigger`, `splitMentionSegments`, `resolveMentionToken`,
and `encodeMention` completely unchanged — all already covered by
`mentionTrigger.logic.test.ts` and `mentionResolve.logic.test.ts`). The only
new code is JSX wiring and two optional style-override props. Acceptance is
therefore validated manually, exactly as scoped in the bug report's own
Acceptance section — this is made an explicit, mandatory step (Task 6,
"Manual verification (web)") in Step by Step Tasks below, not an optional
nicety.

If the implementing agent, while wiring `CopyEditor`, ends up extracting any
new pure predicate or helper (e.g. something beyond simple prop-threading),
it must get a colocated `*.test.ts` following the `mentionTrigger.logic.test.ts`
pattern — but do not manufacture an extraction solely to have something to
test; that would be adding an abstraction the fix doesn't need.

## Relevant Files

Use these files to fix the bug:

- `apps/mobile/components/event/moduleCalendar/ItemCardText.tsx` — `CopyEditor`
  is the component being fixed; `TitleEditor` in the same file is untouched
  (titles are never mention-aware, per the grid: only `title`'s `text` type
  and `longtext` are `mentionable`, but the bug report and grid precedent
  only ever apply mentions to the copy/notes field, not titles).
- `apps/mobile/components/event/moduleCalendar/ItemCard.tsx` — sole caller of
  `CopyEditor`; no prop changes needed here (mention data comes from context,
  not props), included for confirmation only.
- `apps/mobile/components/mentions/MentionInlineText.tsx` — needs the two new
  optional style-override props (`inputClassName`, `onFocusChange`), passed
  through to `MentionTextInput`; existing behavior for its two current
  callers (`grid/cells.tsx`, `work/DutiesGrid.tsx`) must be unchanged when
  the new props are omitted.
- `apps/mobile/components/mentions/MentionTextInput.tsx` — needs the same two
  new optional props: `inputClassName` overrides the hardcoded `className`
  on its `TextInput` (line ~159-161); `onFocusChange` fires from the existing
  `onFocus`-equivalent (there is currently no explicit `onFocus` handler on
  this `TextInput` — only `onBlur`; add a matching `onFocus` that calls
  `onFocusChange?.(true)`, and call `onFocusChange?.(false)` from the
  existing `onBlur`, alongside its current logic, not replacing it).
- `apps/mobile/components/mentions/MentionDataProvider.tsx` — read-only
  reference; confirms `useMentionData()` returns `null` off-provider (the
  fallback branch `CopyEditor` must keep) and real data under the event
  screen.
- `apps/mobile/components/work/DutiesGrid.tsx` (lines ~654-683) — the closest
  existing precedent: a **bespoke, non-grid-cell** component using
  `MentionInlineText`/`MentionText` directly (not through
  `grid/cells.tsx`'s dispatcher) — the pattern to imitate structurally, since
  `CopyEditor` is likewise not a grid cell.
- `apps/mobile/components/grid/cells.tsx` (lines ~812-898) — the other
  existing precedent (`GridCell`'s `useMentionData()` + conditional
  `MentionInlineText` render) — read for the gating pattern
  (`inline.mentionable && mentionData`), not to be edited.
- `apps/mobile/components/event/moduleCalendar/config.ts` — confirms
  `copyField`/`copyLabel`/`copyPlaceholder` per module (comms: `notes`;
  planning_doc: `details`); no changes needed, included for context.

## Step by Step Tasks

### 1. Capture the baseline and confirm the repro live
- Run `pnpm turbo run test` and confirm all 4 tasks pass with the same
  totals recorded in Notes below (no pre-existing failures to misattribute).
- Start the app (`pnpm dev`, per `apps/mobile` conventions) and open an
  event's Comms Schedule calendar in a browser. Type `@` into a day-panel
  item's Copy box and confirm no picker opens (matches the bug report).
  This confirms the static-analysis diagnosis above before any code changes.

### 2. Add style-override props to `MentionTextInput`
- In `apps/mobile/components/mentions/MentionTextInput.tsx`, add two new
  optional props to the component's prop type: `inputClassName?: string` and
  `onFocusChange?: (focused: boolean) => void`.
- Use `inputClassName ?? <the current hardcoded className string>` for the
  `TextInput`'s `className` (line ~159-161) so omitting the prop is a no-op
  for existing callers.
- Add an `onFocus={() => onFocusChange?.(true)}` handler to the `TextInput`
  (it currently has none) and call `onFocusChange?.(false)` inside the
  existing `onBlur` callback (in addition to, not instead of, its current
  `close()`/`onCommit`/`onDone` logic).

### 3. Thread the same props through `MentionInlineText`
- In `apps/mobile/components/mentions/MentionInlineText.tsx`, add
  `inputClassName?: string` and `onFocusChange?: (focused: boolean) => void`
  to its prop type and pass both straight through to its `MentionTextInput`
  child (the edit-mode branch, ~line 87-98). No change to the display-mode
  (`hasMentions && !editing`) branch — `CopyEditor` will supply its own
  wrapping box around whichever mode is showing.

### 4. Wire `CopyEditor` to the mention system
- In `apps/mobile/components/event/moduleCalendar/ItemCardText.tsx`, import
  `useMentionData` from `../mentions/MentionDataProvider` and
  `MentionInlineText` from `../mentions/MentionInlineText`.
- Inside `CopyEditor`, call `const mentionData = useMentionData();` at the
  top (mirrors `GridCell` in `grid/cells.tsx`).
- Keep the existing outer `View` (the bordered `bg-sunken` box, its label
  row, and the `CopyButton`) unchanged — only replace what currently renders
  inside it (the `TextInput`) with a conditional:
  - **When `mentionData` is non-null:** render `MentionInlineText` with
    `value={value}` (keep `CopyEditor`'s own `value`/`setValue` state and
    `commit` function — `MentionInlineText`'s `onCommit` calls this file's
    existing `commit`-shaped logic, i.e. trim-compare-against-`initial`
    before calling `onSave`, matching current behavior exactly), `placeholder`,
    `multiline`, `people={mentionData.people}`,
    `seatHoldings={mentionData.seatHoldings}`,
    `seatOptions={mentionData.seatOptions}`, `inputClassName` set to match
    the box's current `text-xs text-ink` (drop the `rounded-md border
    bg-sunken` — those stay on the outer `View`, not the input, to avoid a
    double border), and `onFocusChange={setFocused}` (replacing the current
    inline `onFocus`/`onBlur` on the bare `TextInput` for driving the
    `focused ? "border-accent" : "border-border"` box className).
  - **When `mentionData` is `null`:** render exactly today's `TextInput`
    unchanged (copy the current JSX as-is) — this is the fallback path, not
    expected to be hit in practice (see Root Cause Analysis) but must not
    regress if it ever is.
- Preserve the existing `commit`/`onSave`/trim-compare semantics — do not
  change when `onSave` fires or what value it receives; only the editor
  widget itself changes.

### 5. Typecheck and full test suite
- `pnpm typecheck` — must stay clean (new optional props must not break any
  existing caller of `MentionInlineText`/`MentionTextInput`).
- `pnpm turbo run test` — zero regressions; totals should match Task 1's
  baseline (no test file changes in this plan, so counts should be identical).
- `pnpm lint` — must stay at 0 errors (warnings may shift only if a new
  framework advisory legitimately applies to the touched files).

### 6. Manual verification (web) — the acceptance gate for this bug
Since no automated test exists for this behavior (see The Failing Test),
this step is mandatory, not optional:
- Open an event's Comms Schedule calendar (day-panel view) in a browser.
- Type `@` in a day's item's Copy box → suggestion picker opens (people +
  role/seat suggestions, matching by substring).
- Pick a person suggestion → a mention token is inserted and the field
  commits (matches `insertMention`'s immediate-commit behavior).
- Reload / navigate away and back → the saved value renders as a tappable
  link (not raw `@[...](mention:...)` markup); tapping a person link
  navigates to `/people?openId=<id>`; tapping a role link navigates to the
  seat's current holder.
- Tap the rendered link's surrounding area (not the link itself) → flips to
  the editable `MentionTextInput`, auto-focused.
- Type/edit a Copy box with **no** mentions in it (comms and planning_doc)
  → confirm it behaves exactly as before: commits on blur, same visual
  appearance (box border, `text-xs`, `border-accent` on focus,
  `minHeight: 44` all unchanged).
- Repeat on the Tasks (planning_doc) calendar's "Details" box to confirm the
  fix is config-driven (both modules share `CopyEditor`), not comms-specific.
- Confirm the "Copy to clipboard" button (`CopyButton`) still copies the
  RAW text (including any `@[Label](mention:type:id)` markup), not the
  rendered label — this must not change per the bug report.

## Validation Commands

Execute every command to validate the bug is fixed with zero regressions.

- `pnpm typecheck` — clean, 0 errors (verifies the new optional props and
  their call sites all type-check)
- `pnpm turbo run test` — all 4 tasks pass, same totals as the Task 1
  baseline (no new/changed test files in this plan — the fix is validated
  manually per Task 6, not by an automated test; see The Failing Test)
- `pnpm lint` — 0 errors (same 97 pre-existing warnings baseline, see Notes)
- Manual web verification per Task 6 above — this is the actual proof the
  bug is fixed; there is no CLI command that substitutes for it

## Regression Risk

- **`MentionInlineText`/`MentionTextInput`'s two existing callers**
  (`grid/cells.tsx`'s `GridCell`, `work/DutiesGrid.tsx`'s Notes cell) must
  render byte-for-byte identically after adding the two new optional props —
  a reviewer should diff their call sites to confirm neither passes
  `inputClassName`/`onFocusChange` and that the defaults reproduce the
  current hardcoded className and the current (missing) `onFocus` no-op.
- **`CopyEditor`'s commit-on-blur contract.** The existing `commit()`
  function (trim, compare against `initial`, call `onSave` only on change)
  must still gate every save — `MentionInlineText`'s `onCommit` should call
  into the same logic, not bypass it, or a value could get saved untrimmed
  or saved when unchanged (extra unnecessary Convex writes).
- **The `mentionData === null` fallback branch.** Untested by the manual
  verification (which exercises the event screen, always under the
  provider) — a reviewer should sanity-check this branch's JSX by reading
  it, since no runtime path currently exercises it.
- **Focus-driven box styling.** `onFocusChange` is new plumbing through two
  components; a reviewer should confirm the box's `border-accent` toggle
  still fires correctly when a suggestion is picked (which internally blurs
  then immediately re-manages focus state inside `MentionTextInput`'s
  `insertMention`) — the box border flickering or getting stuck are the
  likely failure modes to watch for here.

## Notes

**Pre-existing failures** (recorded at planning time — do NOT attribute
these to your changes): none — `pnpm turbo run test` ran fully green:
148 Convex test files / 2385 tests, plus `packages/shared` and `apps/mobile`
suites, 4/4 Turbo tasks successful (1 cached).

**Pre-existing lint baseline:** 0 errors, 97 warnings in `apps/mobile`
(framework advisories — see `.claude/PROJECT.md`), unrelated to this fix.

**No new dependency required.** This fix reuses existing components/logic
entirely; the only additions are two optional props threaded through two
already-existing files.

**Deliberately left unfixed / out of scope:**
- `moduleCalendar/Composer.tsx`'s copy `TextInput` (new-item composer) —
  explicitly "nice-to-have, not required" per the bug report's Acceptance.
- Any component-render test infrastructure — see The Failing Test for the
  full justification; this is a repo-wide convention, not something to
  bolt on for one bug fix.

**Never weaken, skip, or delete a test to reach green.** No existing test
touches this code path, so none needs weakening — the validation commands
above are the pre-existing suite run unchanged, plus the mandatory manual
check in Task 6.
