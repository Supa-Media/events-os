# Chore: Add missing house-style block comments to five test suites

## Chore Description

This repo's house style (documented in `.claude/PROJECT.md`'s "Testing
Conventions" section, and modeled by `apps/convex/tests/siteUrl.test.ts`)
requires every test suite to open with a **prose `/** ... */` block comment
explaining why the unit exists and what breaks if it regresses** — not what
the code does mechanically, but why it's worth testing. Five suites are
missing this comment. This chore adds it to each, with no other changes.

This is comment-only maintenance: no test logic, assertion, or import may
change, and every existing test must keep passing exactly as before.

## Scope

**In scope:**
- Adding one `/** ... */` block comment near the top of each of the five
  files listed below.
- Nothing else in these files changes.

**Out of scope:**
- Any other test file in the repo (only these five are missing the comment).
- Any change to test logic, assertions, `describe`/`test` names, imports, or
  fixture data.
- Any change to the source modules under test (`academyPaths.ts`,
  `seatManagers.ts`, `seats.ts`, `packages/shared/src/index.ts`,
  `apps/convex/tests/setup.helpers.ts`).
- Reformatting or reflowing existing comments already present in these files
  (e.g. the `EMPTY_PATH` fixture comment in `academyPaths.test.ts`, the
  seniority-filter comments in `seatManagers.test.ts`) — leave them exactly
  as they are; only insert the new block above them.

## Relevant Files

- `apps/convex/tests/smoke.test.ts` — missing the block comment; add above
  the single `test(...)` call.
- `packages/shared/src/academyPaths.test.ts` — missing the block comment;
  add above the existing `EMPTY_PATH` fixture and its inline comment.
- `packages/shared/src/seatManagers.test.ts` — missing the block comment;
  add above the existing `SEAT_DEFS` fixture and its inline comment.
- `packages/shared/src/seats.test.ts` — missing the block comment; add above
  the first `describe(...)` block.
- `packages/shared/src/supplySource.test.ts` — missing the block comment;
  add above the first `describe(...)` block.

Reference (already correct, do not modify): `apps/convex/tests/siteUrl.test.ts`
— shows the exact placement (block comment sits between the import block and
the first executable statement, separated by a blank line on each side) and
tone (explains the *consequence* of the unit breaking, in plain prose, no
bullet lists).

## Step by Step Tasks

### 1. `apps/convex/tests/smoke.test.ts`

Current top of file:
```ts
import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, setupChapter } from "./setup.helpers";

test("setupChapter yields an authed client that resolves a chapter", async () => {
```

Insert this block comment between the import block and the `test(...)` call
(replacing the blank line with: blank line, comment, blank line):

```ts
import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, setupChapter } from "./setup.helpers";

/**
 * A smoke test for the shared test harness itself (`setupChapter` / `newT`
 * in `setup.helpers.ts`), not for `eventTypes`. Every other Convex suite
 * builds on `setupChapter` to get an authed, chapter-scoped client — if the
 * harness's auth + chapter + allowlist wiring ever breaks, this is the test
 * that should fail first and point straight at the harness instead of a
 * confusing failure in an unrelated suite.
 */

test("setupChapter yields an authed client that resolves a chapter", async () => {
```

### 2. `packages/shared/src/academyPaths.test.ts`

Current top of file (after the `import` block ending `} from "./academyPaths";`)
has a blank line, then an existing single-line comment block about
`EMPTY_PATH`, then the `EMPTY_PATH` const. Insert the new block comment
**before** that existing comment (do not touch the existing one):

```ts
} from "./academyPaths";

/**
 * `academyPaths.ts` maps each org-chart seat / event hat to the ordered
 * Academy course playlist a person in that role is expected to complete,
 * and derives progress against it. The Roles view (and any "what should
 * this person learn next" prompt) reads straight off these lookups, so a
 * broken (kind, seatSlug) identity, a stale progress fraction, or a wrong
 * "next module" pick would silently mis-route someone's training.
 */

// Every real path now carries the Foundations trio, so none has an empty
// `courseSlugs`. This hand-built path exercises the "no written courses yet"
// behavior (empty required set → fraction 0, no next module) that a
// coming-soon-only path used to represent.
const EMPTY_PATH: RolePath = {
```

### 3. `packages/shared/src/seatManagers.test.ts`

Current top of file (after the `import` block ending `} from "./seatManagers";`)
has a blank line, then an existing comment block about the trimmed
`SEAT_DEFS` fixture, then the `SEAT_DEFS` const. Insert the new block
comment **before** that existing comment:

```ts
} from "./seatManagers";

/**
 * `seatManagers.ts` is the pure algorithm that turns the org chart's shape
 * (seat defs + who currently holds each seat) into "who manages this
 * person" — powering 1:1 check-ins and manager-visibility gates. It mirrors
 * the mobile Org Chart tab's client-side walk, and encodes several
 * owner-approved, non-obvious rulings (self-held ancestors don't count,
 * mutual-pair seniority tie-breaks, the intentional "blanket" seniority
 * filter over a narrower cycle-scoped one). If this drifts from those
 * rulings, people gain or lose visibility into check-ins they shouldn't.
 */

// A trimmed slice of the real taxonomy, enough to exercise chapter→central
// rollup, multi-holder parents, and self-held ancestors without dragging in
// the full SEAT_DEFS template.
const SEAT_DEFS: SeatManagerSeatDef<string>[] = [
```

### 4. `packages/shared/src/seats.test.ts`

Current top of file (after the `import` block ending `} from "./seats";`) has
a blank line then `describe("SEAT_IDS / SEAT_DEFS", () => {`. Insert:

```ts
} from "./seats";

/**
 * `seats.ts` is the owner-approved seed template for the org-chart seat
 * taxonomy (central + per-chapter), including the parent/child tree shape
 * and which seats carry which capability strings. This suite pins that
 * taxonomy — both its structural invariants (acyclic, single root per
 * chart, child chart matches parent chart) and an exact snapshot of the
 * capabilities per seat — so an edit to SEAT_DEFS trips a loud, specific
 * failure here instead of silently drifting from the approved flowchart.
 */

describe("SEAT_IDS / SEAT_DEFS", () => {
```

### 5. `packages/shared/src/supplySource.test.ts`

Current top of file (after the `import` block ending `} from "./index";`)
has a blank line then `describe("normalizeSupplySource", () => {`. Insert:

```ts
} from "./index";

/**
 * Supply "source" is a provenance model (chapter storage vs. borrowed vs.
 * bought, etc.) that decides whether a supply row is inventory-backed and
 * feeds the derived acquisition Status shown in the grid, calendar, and
 * packing screen. Legacy events still carry retired source values
 * ("storage", "misc") from before the provenance model existed, so this
 * suite pins the alias table and its effect on both inventory-backed
 * detection and derived status for those legacy rows.
 */

describe("normalizeSupplySource", () => {
```

### 6. Validate

Run every command in Validation Commands below and confirm all are clean,
with test counts unchanged from before this chore (no test added, removed,
or modified — only comments).

## Validation Commands

Execute every command. Every one must exit clean.

- `cd apps/convex && pnpm vitest run tests/smoke.test.ts` — fast check of the one edited Convex file
- `cd packages/shared && pnpm test` — 5 files / 60 tests, all four edited shared files run here
- `pnpm test` — full suite (turbo → 3 packages); confirm total test count is unchanged from the pre-chore baseline (2432 tests passing per `.claude/PROJECT.md`)
- `pnpm typecheck` — must stay clean; comments cannot affect this, but confirms nothing else was accidentally touched
- `pnpm lint` — must stay clean (0 errors; pre-existing 97 warnings in `apps/mobile` are expected and not caused by this chore)
- `git diff --stat` — confirm only the five listed files changed, and manually skim `git diff` to confirm every change is an added comment block (no `-` lines removing test code, no changed assertions)

## Notes

- `.claude/PROJECT.md`'s embedded copy of `siteUrl.test.ts` shows slightly
  different function names (`eventPageUrl`/`eventPath`) than the file
  currently on disk (`rsvpPageUrl`/`rsvpPath`) — the doc excerpt is stale
  from a later rename, but the comment **placement and tone convention** it
  illustrates is still exactly correct and is what this chore follows.
- Pre-existing lint warnings (97, in `apps/mobile`) and the `GITHUB_TOKEN`
  install noise are known repo baseline per `.claude/PROJECT.md` — do not
  attribute either to this chore.
- No new dependencies. No schema, migration, or Academy content changes —
  this chore does not touch user-facing behavior, vocabulary, or seat
  definitions, so it is explicitly **not** an Academy-tracking trigger.
