# Chore: Split `apps/convex/seats.ts` into `apps/convex/seats/*` modules

## Chore Description

`apps/convex/seats.ts` is 1477 lines — nearly 5× the ~300-line file limit in
`.claude/standards/CLEAN_CODE.md`. This is the **first** repo-wide clean-code
pilot refactor: split the file into focused modules that each stay under 300
lines, with **zero behavior change**. Correctness matters far more than
cleverness — this establishes the pattern every subsequent file-length chore
will follow, so do the caller rewiring exhaustively and conservatively.

The file already has clean internal seams (its own section banner comments),
but two of those five sections are themselves too large for one file each and
need a further split. The plan below names the exact resulting files.

## Scope

**In scope:**
- Splitting `apps/convex/seats.ts` into 8 new files under `apps/convex/seats/`.
- Updating every real caller (TS imports, `api.seats.*` / `internal.seats.*`
  references) across `apps/convex`, `apps/mobile`, `packages/shared` to the
  new paths.
- Deleting `apps/convex/seats.ts` once its contents are fully moved.
- Regenerating `apps/convex/_generated/api.d.ts` / `api.js` (committed
  generated files — see `git log`: "chore(convex): regenerate api.d.ts to
  match committed source") via `npx convex codegen`.
- Fixing the one code-adjacent stale doc-comment this move directly breaks
  (the `npx convex run --prod seats:bridgeDriftAuditSystem` example inside
  `bridgeDriftAuditSystem`'s own doc comment — see Task 8).

**Out of scope:**
- `apps/convex/lib/seats.ts` — a **different, unrelated file** (seat-derived
  finance capability helpers). Do not touch it. Several grep hits below
  (`lib/finance.ts`, `lib/givingAccess.ts`) import from `./seats` but resolve
  to *this* file, not the one being split — verified by relative path (they
  live in `apps/convex/lib/`, so `./seats` = `apps/convex/lib/seats.ts`).
- `packages/shared/src/seats.ts` — the seat *template* (`SEAT_DEFS`, etc.).
  Different file, not touched.
- The money-handling modules: `finances.ts`, `cards.ts`, `increase.ts`,
  `stripeFinance.ts`. `seats.ts` imports one constant from `finances.ts`
  (`ROLLUP_SCAN_LIMIT`) — only the *import path* changes, `finances.ts` itself
  is not edited.
- Prose doc-comment mentions of `seats.ts` scattered across *other* modules
  that are not being edited for any other reason — e.g. `seatStructure.ts`,
  `responsibilities.ts`, `org.ts`, `lib/finance.ts`, `lib/seatStructure.ts`,
  `lib/givingAccess.ts`, `schema/seats.ts`, migration files, and most
  `tests/*.test.ts` doc comments (`cdBudgetApproval.test.ts`,
  `financeGatesSeatUnion.test.ts`, etc.). These reference "`seats.ts`" as
  informal shorthand for "the seat-assignment logic" — they remain accurate
  enough in spirit and updating them is unbounded comment grooming, not part
  of a pure move. Chasing all of them is explicitly **not required** by this
  chore (see "no 'while I'm here' cleanup" in the chore description).
- Any behavior, signature, or validator change to a moved function.
- `docs/plans/academy-revamp.md`'s one mention of `api.seats.mySeatAssignments`
  — a historical design doc, not code; leave it.

## Relevant Files

### Files to split (source)
- `apps/convex/seats.ts` (1477 lines) — the file being split; deleted at the
  end once everything is moved out.

### New Files
All under `apps/convex/seats/` (a new directory — Convex supports nested
function directories; a function in `apps/convex/seats/mutations.ts` named
`assignSeat` registers as `api.seats.mutations.assignSeat`, per
`apps/convex/_generated/ai/guidelines.md`'s "Function references" section).

| File | Contents (from original `seats.ts` line ranges) | Est. lines |
|------|---|---|
| `seats/validators.ts` | `seatChartValidator`, `seatCapabilityValidator`, `MAX_CHART_SEATS`, `chartHolderValidator`, `seatNodeValidator`, `chapterSubtreeValidator` (orig. lines 53–84) | ~35 |
| `seats/internal.ts` | `DetailedHolder` type + `resolvePerson`, `detailedHoldersForScope`, `fetchChapterChartDefs`, `findChapterRootDef`, `boundedChapters`, `detailedDerivedHolders`, `toChartHolder`, `buildNode`, `centralSeats`, `chapterSeats` (orig. lines 86–291, the "Internal helpers" section) | ~210 |
| `seats/chartQueries.ts` | Module header doc comment (orig. lines 1–22) + `chart` + `seatDetail` (orig. lines 294–480) | ~230 |
| `seats/deskQueries.ts` | `mySeatAssignments` + `specializedTitleValidator` + `myDeskChapters` + `assignablePeople` (orig. lines 482–745) | ~275 |
| `seats/sodHelpers.ts` | `APPROVE_SEAT_SLUGS`, `RECORD_SEAT_SLUGS`, the two module-load `throw` assertions, `seatSodGroup`, `personHoldsOtherGroupSeatInScope`, `reverseSeatWriteThrough`, `deleteSeatAssignment` (orig. lines 762–867) | ~120 |
| `seats/mutations.ts` | "Write mutations" section banner comment + `MAX_SLOT_READ` + `assignSeatImpl` + `assignSeat` + `unassignSeatImpl` + `unassignSeat` (orig. lines 747–1099, minus the SoD helpers now in `sodHelpers.ts`) | ~260 |
| `seats/givingPower.ts` | "Giving power editor" section (orig. lines 1101–1200): `GIVING_CAPS`, `givingPowerValidator`, `givingCapsForPower`, `setSeatGivingPower` | ~110 |
| `seats/bridgeDriftAudit.ts` | "Bridge drift audit" section (orig. lines 1202–1477): `AUDIT_TABLE_SCAN_LIMIT`, `AUDIT_MISMATCH_CAP`, `bridgeDriftMismatchKindValidator`, `bridgeDriftAuditReturns`, `bridgeDriftAuditImpl`, `bridgeDriftAudit`, `bridgeDriftAuditSystem` | ~280 |

These estimates already include each file's own imports/header — all land
comfortably under 300. If any file lands over 300 once actually assembled,
split it further along an existing internal seam (e.g. `deskQueries.ts` could
split `assignablePeople` out into its own file) and say so plainly in the PR
description — do not compress by deleting comments or documentation.

### Callers to update (exhaustive — found via the greps in "Search commands
used" below)

**Direct TS import (not `api.*`) — one file:**
- `apps/convex/seatProposals.ts:86` — `import { assignSeatImpl, unassignSeatImpl } from "./seats"` → `from "./seats/mutations"`

**`api.seats.*` / `internal.seats.*` references — Convex tests (`apps/convex/tests/`):**
- `chapterGating.test.ts` (1 hit: `api.seats.chart`)
- `financeGatesSeatUnion.test.ts` (2 hits: `api.seats.assignSeat`, `api.seats.unassignSeat`)
- `seatStructure.test.ts` (2 hits: `api.seats.seatDetail`)
- `seats.test.ts` (~90 hits: `api.seats.chart`, `api.seats.seatDetail`, `api.seats.mySeatAssignments`, `api.seats.myDeskChapters`, `api.seats.assignSeat`, `api.seats.unassignSeat`, `api.seats.assignablePeople` — this is the safety-net suite, see "Test-first" below)
- `bridgeDriftAudit.test.ts` (7 hits: `api.seats.bridgeDriftAudit`, `api.seats.assignSeat`, `internal.seats.bridgeDriftAuditSystem` ×2)
- `givingPower.test.ts` (9 hits: `api.seats.setSeatGivingPower`)
- `seatProposals.test.ts` (2 hits: `api.seats.assignSeat`)

**`api.seats.*` references — `apps/mobile/`:**
- `app/(app)/org-chart.tsx` (3 hits: `api.seats.chart`, `api.seats.mySeatAssignments`, `api.seats.seatDetail`)
- `app/(app)/academy/path/[seatSlug].tsx` (2 hits: `api.seats.chart`)
- `app/(app)/(tabs)/academy.tsx` (4 hits: `api.seats.chart`, `api.seats.mySeatAssignments`)
- `components/orgchart/CapabilityProbe.tsx` (1 hit: `api.seats.seatDetail`)
- `components/orgchart/GivingPowerControl.tsx` (1 hit: `api.seats.setSeatGivingPower`)
- `components/orgchart/treeUtils.ts` (2 hits: `api.seats.chart`, `api.seats.seatDetail` — both inside `FunctionReturnType<typeof ...>` type positions)
- `components/orgchart/SeatActions.tsx` (4 hits: `api.seats.assignablePeople` ×2, `api.seats.assignSeat`, `api.seats.unassignSeat`)
- `lib/ChapterContext.tsx` (1 hit: `api.seats.myDeskChapters`)

**Not callers — verified and left alone:**
- `apps/mobile/lib/financeSeats.ts` — mentions `api.seats.myDeskChapters` only inside prose doc comments, no code reference. No change needed.
- `apps/convex/lib/finance.ts`, `apps/convex/lib/givingAccess.ts` — import from `apps/convex/lib/seats.ts` (a different file), not `apps/convex/seats.ts`.
- `packages/shared/src/academyPaths.ts`, `packages/shared/src/seatManagers.ts`, `packages/shared/src/index.ts` — import from `packages/shared/src/seats.ts` (the seat template), not the Convex file.

### Generated files
- `apps/convex/_generated/api.d.ts`, `apps/convex/_generated/api.js` —
  regenerated by `npx convex codegen` after the split (must be committed,
  same as the last commit on this branch: "chore(convex): regenerate api.d.ts
  to match committed source").

### Search commands used (re-run these to confirm the caller list above is
still complete before starting — code may have moved since this plan was written)
```
grep -rn "api\.seats\." --include="*.ts" --include="*.tsx" apps packages | grep -v _generated
grep -rn "internal\.seats\." --include="*.ts" --include="*.tsx" apps packages | grep -v _generated
grep -rn "from [\"'].*[/\"]seats[\"']" --include="*.ts" --include="*.tsx" apps packages | grep -v _generated
```

## Step by Step Tasks

### 0. Baseline
- From `apps/convex`, run `pnpm vitest run tests/seats.test.ts` and confirm
  all 61 tests pass (this was verified true when this plan was written — if
  it's not true when you start, stop and report, don't proceed on a red
  baseline).

### 1. Create `apps/convex/seats/validators.ts`
- Move `seatChartValidator`, `seatCapabilityValidator`, the `MAX_CHART_SEATS`
  constant (with its doc comment), `chartHolderValidator`, `seatNodeValidator`,
  `chapterSubtreeValidator` verbatim from `seats.ts` (orig. lines 53–84).
- Imports needed: `v` from `"convex/values"`; `SEAT_CHARTS`, `SEAT_CAPABILITIES`
  from `"@events-os/shared"`.
- Export all six names.

### 2. Create `apps/convex/seats/internal.ts`
- Move the entire "Internal helpers" section verbatim (orig. lines 86–291):
  the `DetailedHolder` type, `resolvePerson`, `detailedHoldersForScope`,
  `fetchChapterChartDefs`, `findChapterRootDef`, `boundedChapters`,
  `detailedDerivedHolders`, `toChartHolder`, `buildNode`, `centralSeats`,
  `chapterSeats` — including all of their doc comments, unchanged.
- Imports needed (paths corrected for the new directory depth — everything is
  now one level deeper, so `./x` becomes `../x`):
  - `Doc`, `Id` from `"../_generated/dataModel"`
  - `type { QueryCtx }` from `"../_generated/server"`
  - `MULTI_HOLDER_CAP` from `"@events-os/shared"` (package import, unchanged)
  - `ROLLUP_SCAN_LIMIT` from `"../finances"` (was `"./finances"`)
  - `MAX_CHART_SEATS` from `"./validators"`
- Export every function; `DetailedHolder` type must also be exported (used by
  `chartQueries.ts` and `deskQueries.ts` are not expected to need it directly,
  but keep it exported for parity with the original module — it costs
  nothing and avoids a second, narrower audit of internal type usage).

### 3. Create `apps/convex/seats/sodHelpers.ts`
- Move verbatim (orig. lines 762–867): the "SoD groups" comment block,
  `APPROVE_SEAT_SLUGS`, `RECORD_SEAT_SLUGS`, both module-load `throw`
  assertions (the `if (APPROVE_SEAT_SLUGS.size !== 2)` / `RECORD_SEAT_SLUGS`
  checks — these must still run at import time, unchanged), `seatSodGroup`,
  `personHoldsOtherGroupSeatInScope`, `reverseSeatWriteThrough`,
  `deleteSeatAssignment`.
- Do **not** move `MAX_SLOT_READ` here — it belongs with `mutations.ts` (see
  Task 5), it's only used inside `assignSeatImpl`.
- Imports needed:
  - `Doc`, `Id` from `"../_generated/dataModel"`
  - `type { MutationCtx }` from `"../_generated/server"`
  - `SEAT_IDS`, `SEAT_DEFS`, `titleKind` from `"@events-os/shared"`
  - `removeSpecializedRoleImpl` from `"../specializedRoles"` (was
    `"./specializedRoles"`)
- Export `seatSodGroup`, `personHoldsOtherGroupSeatInScope`,
  `deleteSeatAssignment` (needed by `mutations.ts`). `reverseSeatWriteThrough`
  can stay module-private (only `deleteSeatAssignment` calls it, same as the
  original).

### 4. Create `apps/convex/seats/chartQueries.ts`
- Move the module's top header doc comment (orig. lines 1–22, the
  "org-transparent" owner-decision block) verbatim to the top of this file —
  it explicitly names `chart`/`seatDetail`/`mySeatAssignments`, and this file
  houses the first two. `mySeatAssignments` (which moves to `deskQueries.ts`)
  already carries its own doc comment that says "Aligns with
  `chart`/`seatDetail`", so nothing is lost by not duplicating this header
  there — do not copy it into `deskQueries.ts` too.
- Move `chart` and `seatDetail` verbatim, doc comments included (orig. lines
  294–480).
- Imports needed:
  - `query` from `"../_generated/server"`
  - `ConvexError`, `v` from `"convex/values"`
  - `Doc`, `Id` from `"../_generated/dataModel"`
  - `requireAccess` from `"../lib/context"`
  - `isSuperuser` from `"../lib/superuser"`
  - `canEditChart` from `"../lib/seatStructure"`
  - `seatChartValidator`, `seatCapabilityValidator`, `seatNodeValidator`,
    `chapterSubtreeValidator` from `"./validators"`
  - `fetchChapterChartDefs`, `findChapterRootDef`, `boundedChapters`,
    `detailedDerivedHolders`, `detailedHoldersForScope`, `centralSeats`,
    `chapterSeats` from `"./internal"`

### 5. Create `apps/convex/seats/deskQueries.ts`
- Move `mySeatAssignments`, `specializedTitleValidator`, `myDeskChapters`,
  `MAX_PEOPLE_SCAN_PER_CHAPTER`, `MAX_ASSIGNABLE_PEOPLE`, `assignablePeople`
  verbatim, doc comments included (orig. lines 482–745).
- Imports needed:
  - `query` from `"../_generated/server"`
  - `ConvexError`, `v` from `"convex/values"`
  - `Doc`, `Id` from `"../_generated/dataModel"`
  - `requireAccess`, `requireUserId` from `"../lib/context"`
  - `SPECIALIZED_ROLE_TITLES`, `type SpecializedRoleTitle` from
    `"@events-os/shared"`
  - `seatChartValidator`, `chartHolderValidator` from `"./validators"`
  - `boundedChapters` from `"./internal"` (`assignablePeople`'s `scope:
    "central"` branch calls it — do not miss this cross-file dependency)

### 6. Create `apps/convex/seats/mutations.ts`
- Move the "Write mutations" section banner comment (orig. lines 747–756),
  `MAX_SLOT_READ` (orig. lines 757–760), `assignSeatImpl`, `assignSeat`,
  `unassignSeatImpl`, `unassignSeat` verbatim (orig. lines 869–1099), doc
  comments included.
- Imports needed:
  - `mutation` from `"../_generated/server"`
  - `ConvexError`, `v` from `"convex/values"`
  - `Doc`, `Id` from `"../_generated/dataModel"`
  - `type { MutationCtx }` from `"../_generated/server"`
  - `MULTI_HOLDER_CAP` from `"@events-os/shared"`
  - `requireUserId` from `"../lib/context"`
  - `requireSuperuser` from `"../lib/superuser"`
  - `assignSpecializedRoleImpl` from `"../specializedRoles"`
  - `seatSodGroup`, `personHoldsOtherGroupSeatInScope`, `deleteSeatAssignment`
    from `"./sodHelpers"`
- Export `assignSeatImpl`, `assignSeat`, `unassignSeatImpl`, `unassignSeat` —
  the first and third are the ones `seatProposals.ts` imports directly (Task
  9), so they must stay exported exactly as before.

### 7. Create `apps/convex/seats/givingPower.ts`
- Move the "Giving power editor" section banner comment, `GIVING_CAPS`,
  `givingPowerValidator`, `givingCapsForPower`, `setSeatGivingPower` verbatim
  (orig. lines 1101–1200).
- Imports needed:
  - `mutation` from `"../_generated/server"`
  - `ConvexError`, `v` from `"convex/values"`
  - `type { SeatCapability }` from `"@events-os/shared"`
  - `requireChartEditor`, `assertNoSelfLockout`, `type DefOverride` from
    `"../lib/seatStructure"`
  - `seatCapabilityValidator` from `"./validators"`

### 8. Create `apps/convex/seats/bridgeDriftAudit.ts`
- Move the "Bridge drift audit" section banner comment, `AUDIT_TABLE_SCAN_LIMIT`,
  `AUDIT_MISMATCH_CAP`, `bridgeDriftMismatchKindValidator`,
  `bridgeDriftAuditReturns`, `bridgeDriftAuditImpl`, `bridgeDriftAudit`,
  `bridgeDriftAuditSystem` verbatim (orig. lines 1202–1477).
- Imports needed:
  - `query`, `internalQuery` from `"../_generated/server"`
  - `v` from `"convex/values"`
  - `Doc`, `Id` from `"../_generated/dataModel"`
  - `type { QueryCtx }` from `"../_generated/server"`
  - `requireSuperuser` from `"../lib/superuser"`
- This file has **no** dependency on `validators.ts` or `internal.ts` — it's
  fully self-contained in the original, keep it that way.
- One doc-comment fix directly caused by this move: `bridgeDriftAuditSystem`'s
  doc comment (orig. line ~1464) says `npx convex run --prod
  seats:bridgeDriftAuditSystem` — update this to `npx convex run --prod
  seats/bridgeDriftAudit:bridgeDriftAuditSystem` so the ops instruction it
  gives stays correct (this is fixing a reference the move itself broke, not
  general cleanup).

### 9. Update `apps/convex/seatProposals.ts`
- Change line 86 from `import { assignSeatImpl, unassignSeatImpl } from
  "./seats";` to `import { assignSeatImpl, unassignSeatImpl } from
  "./seats/mutations";`.

### 10. Delete `apps/convex/seats.ts`
- Confirm every export and every internal helper has a new home (cross-check
  against the table in "Relevant Files" above), then delete the file.

### 11. Update `api.seats.*` / `internal.seats.*` references — Convex tests
Apply this substitution table (old → new) to every `.test.ts` file listed
under "Callers to update" above. These are the **only** edits
`seats.test.ts` needs — no assertion, fixture, or expectation changes:
```
api.seats.chart               → api.seats.chartQueries.chart
api.seats.seatDetail          → api.seats.chartQueries.seatDetail
api.seats.mySeatAssignments   → api.seats.deskQueries.mySeatAssignments
api.seats.myDeskChapters      → api.seats.deskQueries.myDeskChapters
api.seats.assignablePeople    → api.seats.deskQueries.assignablePeople
api.seats.assignSeat          → api.seats.mutations.assignSeat
api.seats.unassignSeat        → api.seats.mutations.unassignSeat
api.seats.setSeatGivingPower  → api.seats.givingPower.setSeatGivingPower
api.seats.bridgeDriftAudit    → api.seats.bridgeDriftAudit.bridgeDriftAudit
internal.seats.bridgeDriftAuditSystem → internal.seats.bridgeDriftAudit.bridgeDriftAuditSystem
```
Files: `chapterGating.test.ts`, `financeGatesSeatUnion.test.ts`,
`seatStructure.test.ts`, `seats.test.ts`, `bridgeDriftAudit.test.ts`,
`givingPower.test.ts`, `seatProposals.test.ts`.

### 12. Update `api.seats.*` references — `apps/mobile`
Apply the same substitution table to: `app/(app)/org-chart.tsx`,
`app/(app)/academy/path/[seatSlug].tsx`, `app/(app)/(tabs)/academy.tsx`,
`components/orgchart/CapabilityProbe.tsx`,
`components/orgchart/GivingPowerControl.tsx`,
`components/orgchart/treeUtils.ts` (both hits are inside
`FunctionReturnType<typeof api.seats.X>` — the substitution still applies
literally inside the type position), `components/orgchart/SeatActions.tsx`,
`lib/ChapterContext.tsx`.

### 13. Regenerate the committed generated API
- From `apps/convex`, run `npx convex codegen`.
- Confirm `apps/convex/_generated/api.d.ts` now contains `seats/chartQueries`,
  `seats/deskQueries`, `seats/mutations`, `seats/givingPower`,
  `seats/bridgeDriftAudit` module entries and no bare `seats` entry:
  `grep -n '"seats' apps/convex/_generated/api.d.ts` should show the new
  nested paths only.

### 14. Run every file's own line count and the full validation suite
- `wc -l apps/convex/seats/*.ts` — every file must be under 300.
- Run the Validation Commands below. All must exit clean.

## Validation Commands
Execute every command. Every one must exit clean.
- `wc -l apps/convex/seats/*.ts` — confirm every new file is under 300 lines; `apps/convex/seats.ts` must no longer exist
- `grep -rn "api\.seats\.chart\b\|api\.seats\.seatDetail\b\|api\.seats\.mySeatAssignments\b\|api\.seats\.myDeskChapters\b\|api\.seats\.assignablePeople\b\|api\.seats\.assignSeat\b\|api\.seats\.unassignSeat\b\|api\.seats\.setSeatGivingPower\b\|api\.seats\.bridgeDriftAudit\b" --include="*.ts" --include="*.tsx" apps packages` — should return zero matches outside `_generated/api.d.ts` (proves no dangling old-shape reference remains). Caveat: `api.seats.bridgeDriftAudit\b` also matches inside the new, correct `api.seats.bridgeDriftAudit.bridgeDriftAudit` (the dot after the first `bridgeDriftAudit` still satisfies `\b`) — for that one specific pattern, eyeball each hit and confirm it's followed by `.bridgeDriftAudit` (new/correct) rather than something else (old/dangling), don't just trust a nonzero count as a failure
- `grep -rln "from [\"'].*[/\"]seats[\"']" apps/convex/seatProposals.ts` — confirm it now reads `./seats/mutations`
- `cd apps/convex && pnpm vitest run tests/seats.test.ts` — must still be 61 passing, zero diff in assertions
- `pnpm typecheck` — `tsc --noEmit` × 3 packages
- `pnpm lint` — 0 errors (97 pre-existing `apps/mobile` warnings are fine, see Notes)
- `pnpm test` — full suite (turbo → 3 packages), zero regressions
- `pnpm build` — web bundle export

## Notes
- **Pre-existing state (verified when this plan was written, 2026-07-19):**
  `pnpm test`/`typecheck`/`lint`/`build` are all green;
  `apps/convex/tests/seats.test.ts` has 61 passing tests. `apps/mobile` has 97
  pre-existing lint warnings (native-only `Alert`, unwrapped forms) — not
  attributable to this change.
- `npx convex codegen` needs no running dev server or deployment — it's a
  pure local regeneration of `_generated/api.d.ts`/`api.js` from the
  `apps/convex/` source tree.
- The academy-track check from `CLAUDE.md` ("does the Academy need updating?")
  does not apply here — this is a pure internal file reorganization, no
  user-facing behavior, vocabulary, money rule, or role changed.
- If the caller-graph turns out to be larger than what's listed above (the
  search commands in "Relevant Files" should be re-run to confirm), or any
  single new file resists staying under 300 lines without contorting the
  code, stop and do the part that's safe — state plainly in the PR what was
  left and why, per the chore's own instructions. Do not weaken
  `seats.test.ts` or any other test, and do not leave a dangling
  `api.seats.*`/`internal.seats.*` reference to force a green run.
