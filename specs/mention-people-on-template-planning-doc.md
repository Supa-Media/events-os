# Feature: @Mentions on template grids (planning doc and every other module)

## Feature Description
`@`-mentioning a person (or a seat) in a free-text grid cell — the planning
doc's notes, comms, run-of-show, supplies, etc. — currently only works once a
template has been turned into a real event. The identical grid, rendered on
the template editor, silently falls back to a plain text box: no `@` picker,
no rendered mention chips. This feature makes mentions work on the template
editor too, so a chapter lead can `@`-mention "whoever runs comms" or a named
person while still building out the reusable template — not just after
spinning up an event from it.

## User Story
As a chapter lead editing an event template
I want to `@`-mention a person or a seat in a template's planning doc (or any
other grid module) notes
So that the template itself documents who to loop in, without having to wait
until an event exists to add that context

## Problem Statement
`apps/mobile/components/grid/cells.tsx`'s `GridCell` only renders the
mention-aware editor (`MentionInlineText`) when `useMentionData()` returns
non-null. That hook reads from `MentionDataContext`, and the ONLY screen that
mounts `MentionDataProvider` is the live event workspace
(`apps/mobile/app/(app)/event/[id].tsx`). The template editor
(`apps/mobile/app/(app)/template/[id].tsx`) renders the exact same
`EditableGrid`/`GridCell` component tree (`mode="template"` instead of
`mode="event"`) but never mounts the provider, so `useMentionData()` returns
`null` there and every mentionable cell degrades to the plain `InlineText`
editor. This was a deliberate original decision (see the doc comments in
`MentionDataProvider.tsx`, `cells.tsx`, and `columnRegistry.tsx`), but the
user-reported gap shows it should not have been.

## Solution Statement
Mount `MentionDataProvider` around the template editor screen, the same way
`event/[id].tsx` already mounts it around the event workspace. No backend
change is needed: `MentionDataProvider` calls `api.people.list`,
`api.responsibilities.seatOptions`, and `api.responsibilities.
chapterSeatHoldings`, and all three resolve the caller's chapter from the
authenticated session (`getChapterIdOrNull(ctx)`) — none of them take an
`eventId`/`eventTypeId`/`isTemplate` argument, so they already return the
right roster/seat data for a template author in the same chapter. `GridCell`
itself is already mode-agnostic about mentions (the `mode === "template"` /
`mode === "event"` branches in `cells.tsx` only gate the owner cell and the
supplies source/status cells; the mention branch just checks
`inline.mentionable && mentionData`), so wrapping the template screen's JSX
in the provider is the entire functional fix.

This follows the exact pattern already established by
`apps/mobile/app/(app)/event/[id].tsx`, which is the file to model the change
on (marked below). The alternative — teaching `GridCell` a
`mode === "template"` mention rule, or adding a template-scoped mention
query — was rejected: the backend already returns identical, correctly
chapter-scoped data regardless of caller, so adding template-specific
plumbing would be duplicated code solving a problem that doesn't exist. The
gap is purely which screens mount the existing provider.

Several doc comments across the mention/grid code assert, as fact, that
templates deliberately don't get mentions. Those comments become false the
moment the provider mounts on the template screen and must be corrected in
the same change — a stale comment that asserts the old (now wrong) behavior
is worse than no comment.

## Scope
**In scope:**
- Mount `MentionDataProvider` around the template editor screen
  (`apps/mobile/app/(app)/template/[id].tsx`), enabling `@`-mentions on every
  mentionable grid cell it renders (planning doc, comms, run of show,
  supplies, volunteer expectations, and any other `text`/`longtext` column
  marked `mentionable: true` in `columnRegistry.tsx`).
- Correcting the now-stale "templates deliberately don't get mentions" doc
  comments in `MentionDataProvider.tsx`, `cells.tsx`, `columnRegistry.tsx`,
  and `event/[id].tsx`.
- A wiring test that pins the seam (both screens mount the provider) so a
  future edit can't silently drop it from either screen.

**Out of scope:**
- Any backend/schema change — the mention-suggestion queries already work
  chapter-generically and are untouched.
- Resolving/rendering mentions differently on a template vs. an event (e.g.
  showing "will resolve once assigned" for a seat with no current holder) —
  seat mentions already resolve to "no current holder" the same way on both
  surfaces via `resolveMentionToken`; no template-specific resolution logic
  is being added.
- Any change to `MentionTextInput`, `MentionPopover`, `MentionText`,
  `mentionTrigger.logic.ts`, or `mentionResolve.logic.ts` — none of them
  reference event/template mode today and none need to.
- Sandbox/training-mode mention behavior — templates aren't sandboxed.
- Academy content: no existing lesson documents the `@`-mention feature (the
  one Academy hit for "mention" is an unrelated quiz distractor string), so
  there is nothing to keep in sync. Call this out explicitly in the PR
  description per the Academy rule in `CLAUDE.md`.

## Relevant Files
- `apps/mobile/app/(app)/template/[id].tsx` — the template editor screen;
  gains the `MentionDataProvider` mount. This is the file being fixed.
- `apps/mobile/app/(app)/event/[id].tsx` — **pattern to follow**: already
  mounts `MentionDataProvider` around its workspace (lines ~559–568); its
  stale "template editors deliberately don't mount it" comment needs
  correcting in the same change.
- `apps/mobile/components/mentions/MentionDataProvider.tsx` — the provider
  itself (unchanged behavior); its module doc comment (lines 7–11) asserts
  templates shouldn't offer mentions and must be corrected.
- `apps/mobile/components/grid/cells.tsx` — `GridCell`'s two comments (lines
  815–816 and 881–883) about the mention gate being event-only must be
  corrected; the gating logic itself (`inline.mentionable && mentionData`,
  line 884) needs no code change.
- `apps/mobile/components/grid/columnRegistry.tsx` — the `mentionable` field
  doc comment (line 53–54) on `InlineTextConfig` must be corrected.

### New Files
- `apps/mobile/components/mentions/mentionProviderWiring.test.ts` — source-
  inspection wiring test asserting both the template editor and the event
  workspace mount `MentionDataProvider`. Follows the precedent in
  `apps/mobile/components/campaign/designer/canvas/placeholders.test.ts`
  (reads sibling `.tsx` source via `fs.readFileSync` and asserts on its
  content) — this codebase has no component-render test harness (mobile's
  `jest.config.js` runs a `node` test environment with no React Testing
  Library / jsdom setup), so a wiring/seam test here is a source-content
  assertion, not a render assertion.

## Implementation Plan

### Phase 1: Foundation
None needed — no new types, schema, or shared utility. The provider, the
mention encoding, and the chapter-scoped queries all already exist and are
reused unchanged.

### Phase 2: Core Implementation
Mount `MentionDataProvider` around the template editor screen's returned
JSX, mirroring `event/[id].tsx`'s existing wrap.

### Phase 3: Integration
Correct the doc comments across the four files listed above so none of them
still assert that templates are deliberately excluded from mentions. Add the
wiring test guarding both screens.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Write the failing wiring test (RED)
Create `apps/mobile/components/mentions/mentionProviderWiring.test.ts`:

```ts
/**
 * @mentions only work on a screen that mounts `MentionDataProvider` — every
 * mentionable grid cell (`cells.tsx#GridCell`) falls back to the plain
 * editor the moment `useMentionData()` returns null. This test reads the
 * two screens that render mentionable grids straight from source and pins
 * that both mount the provider, so a future edit to either screen can't
 * silently regress one of them back to a plain-text-only surface.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";

const read = (relPath: string) =>
  fs.readFileSync(path.join(__dirname, relPath), "utf8");

describe("MentionDataProvider is mounted on every screen that renders a mentionable grid", () => {
  test("the template editor mounts it", () => {
    const src = read("../../app/(app)/template/[id].tsx");
    expect(src).toContain(
      'import { MentionDataProvider } from "../../../components/mentions/MentionDataProvider";',
    );
    expect(src).toContain("<MentionDataProvider>");
  });

  test("the event workspace still mounts it (regression guard)", () => {
    const src = read("../../app/(app)/event/[id].tsx");
    expect(src).toContain(
      'import { MentionDataProvider } from "../../../components/mentions/MentionDataProvider";',
    );
    expect(src).toContain("<MentionDataProvider>");
  });
});
```

Run:
`pnpm --filter @events-os/mobile exec jest components/mentions/mentionProviderWiring.test.ts`

Confirm the FIRST test (template editor) fails — `template/[id].tsx` has no
`MentionDataProvider` import or mount today. The second test (event
workspace) should already pass; it stays in the suite as the regression
guard the milestone is also responsible for.

### 2. Mount `MentionDataProvider` on the template editor (GREEN)
In `apps/mobile/app/(app)/template/[id].tsx`:
- Add the import, alongside the other component imports:
  ```ts
  import { MentionDataProvider } from "../../../components/mentions/MentionDataProvider";
  ```
- Wrap the screen's returned JSX in `<MentionDataProvider>`, matching how
  `event/[id].tsx` wraps its own return (open tag right before the
  outermost element, close tag after it, same indentation level as the
  content it wraps — do not reindent the wrapped subtree, mirroring the
  existing precedent):
  ```tsx
  return (
    <MentionDataProvider>
    <Screen maxWidth={FULL_WIDTH}>
      ...
    </Screen>
    </MentionDataProvider>
  );
  ```
  This must wrap BOTH the early-return `data === null` "Template not found"
  branch and the main `Screen` branch is NOT required — only the branch that
  actually renders `EditableGrid` (the main return) needs the provider.
  Leave the loading (`data === undefined`) and not-found returns as they are.

Re-run the wiring test from Step 1; both assertions in the template-editor
`test()` now pass.

### 3. Correct the stale "templates don't get mentions" comments
Update each comment that currently states, as fact, that the template editor
doesn't/shouldn't offer mentions:

- `apps/mobile/components/mentions/MentionDataProvider.tsx` (module doc,
  lines 7–11): remove the claim that "surfaces like the template editor
  render the same grids but should NOT offer mentions, and they simply don't
  mount the provider." Replace with a description of what actually gates
  it now — any screen that renders a mentionable grid must mount this
  provider; today that's the event workspace and the template editor.
- `apps/mobile/components/grid/cells.tsx` line 815–816 (`mentionData` local):
  replace "Non-null only under a MentionDataProvider (event screens mount
  one; template editors don't)" with wording that no longer singles out
  templates as excluded.
- `apps/mobile/components/grid/cells.tsx` line 881–883 (inline-mentionable
  branch): replace "Free-text cells become @mention-aware when mention data
  is available (event screens); templates and other provider-less surfaces
  keep the plain editor below" the same way.
- `apps/mobile/components/grid/columnRegistry.tsx` line 53–54
  (`InlineTextConfig.mentionable` doc): replace "(when a MentionDataProvider
  is mounted — event screens, not templates)" with "(when a
  MentionDataProvider is mounted around the screen)".
- `apps/mobile/app/(app)/event/[id].tsx` lines ~563–567 (the comment above
  its own `<MentionDataProvider>` mount): drop the sentence "Template
  editors deliberately don't mount it, so their identical grids stay plain."

None of these are behavior changes; do not alter any code near them beyond
the comment text itself.

### 4. Run the full validation suite
Run every command in Validation Commands below. All must exit clean.

## Testing Strategy

### Tests by Milestone
| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | Mount `MentionDataProvider` on the template editor | `apps/mobile/components/mentions/mentionProviderWiring.test.ts` | `template/[id].tsx`'s source imports `MentionDataProvider` and contains a `<MentionDataProvider>` mount; `event/[id].tsx`'s source still does too | `template/[id].tsx` has neither the import nor the mount today — grep confirms zero hits |

**Pattern followed:** `apps/mobile/components/campaign/designer/canvas/placeholders.test.ts` — a source-content ("wiring") test using `fs.readFileSync`/`path.join` against sibling `.tsx` files, the established pattern in this repo for pinning an integration seam where no component-render test harness exists (mobile's `jest.config.js` is a `node` test environment; there is no React Testing Library/jsdom setup and no precedent for rendering a screen component in this repo's test suite).

### Integration Tests
N/A beyond the wiring test above — there is no backend seam to integration-
test (the mention-suggestion queries are unchanged and untouched by this
change; they were already chapter-generic, not event/template-scoped).

### Edge Cases
- **A template with zero people/seats in its chapter:** `MentionDataProvider`
  already handles this identically to the event screen — `people`,
  `seatOptions`, `seatHoldings` all default to `[]` while the underlying
  `useQuery` calls are loading or return empty (`MentionDataProvider.tsx`
  lines 30–37), so the `@` picker simply shows no suggestions. No new
  handling needed; covered by existing provider behavior, not a new test.
- **A vacant seat mentioned in a template's notes:** `resolveMentionToken`
  already resolves a seat mention with no current holder to a "no current
  holder" state (covered by the existing
  `mentionResolve.logic.test.ts`), and that logic is untouched by this
  change — no template-specific case to add.
- **The "Template not found" early-return branch:** deliberately NOT wrapped
  in `MentionDataProvider` (Step 2) since it renders no grid; confirm during
  Step 2 that this branch is unaffected by re-reading the diff, no
  standalone test needed since it renders no mentionable cell at all.

## Acceptance Criteria
- [ ] `apps/mobile/app/(app)/template/[id].tsx` imports and mounts
      `MentionDataProvider` around its main (non-loading, non-not-found)
      return.
- [ ] `apps/mobile/components/mentions/mentionProviderWiring.test.ts` exists
      and both its tests pass.
- [ ] Typing `@` into any mentionable free-text cell (e.g. the planning
      doc's notes column) on the template editor now behaves identically to
      the same cell on a live event: it triggers the suggestion picker and,
      on selection, renders a resolved mention chip. (Verified by the wiring
      test plus manual/`run` confirmation — no backend change is under test
      here since none was made.)
- [ ] None of `MentionDataProvider.tsx`, `cells.tsx`, `columnRegistry.tsx`,
      or `event/[id].tsx` still contains a comment asserting templates are
      deliberately excluded from mentions.
- [ ] No changes to any file under `apps/convex/` or `packages/shared/` —
      this is a frontend-only wiring fix.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm --filter @events-os/mobile exec jest components/mentions/mentionProviderWiring.test.ts` — the new wiring test, both assertions green
- `pnpm --filter @events-os/mobile test` — full mobile suite, zero regressions (includes the pre-existing `mentionTrigger.logic.test.ts` / `mentionResolve.logic.test.ts`, untouched by this change)
- `pnpm --filter @events-os/mobile typecheck` — if defined in `apps/mobile/package.json`; otherwise `pnpm --filter @events-os/mobile exec tsc --noEmit`
- `pnpm --filter @events-os/mobile lint`
- `pnpm turbo run test` — full monorepo suite, zero regressions
- `pnpm turbo run typecheck`
- `pnpm turbo run lint`

## Notes
- No new dependencies.
- No backend/Convex changes; `apps/convex` tests are unaffected by this PR
  and do not need to be re-run beyond the standard `pnpm turbo run test`
  fan-out.
- Deliberately not adding: a `mode`-aware mention resolution difference, a
  template-scoped mention query, or any change to how a seat mention
  resolves when vacant — none of that is needed, since the existing
  chapter-generic queries and resolution logic already produce correct
  results for a template author.
- Per `CLAUDE.md`'s Academy rule: this change is user-facing but there is no
  existing Academy lesson about the `@`-mention feature to keep in sync (the
  only "mention" hit in `packages/shared/src/academy/` is an unrelated quiz
  distractor string in `streams/events.ts`). State this explicitly in the PR
  description rather than silently skipping the question.
