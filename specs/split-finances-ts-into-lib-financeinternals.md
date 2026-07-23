# Chore: Split `apps/convex/finances.ts` into `apps/convex/lib/financeInternals/*`

## Chore Description

`apps/convex/finances.ts` is 8,642 lines — by far the largest non-generated,
non-binary, non-lockfile source file in the repo (next largest source files:
`apps/convex/tests/cards.test.ts` at 4,155, `apps/convex/increase.ts` at 3,603,
`apps/convex/aiActions.ts` at 3,568, `apps/convex/cards.ts` at 3,211; everything
above those is a generated lockfile or binary media asset — see "Search commands
used" below). It mixes ~70 Convex-registered handlers (`query`/`mutation`/
`internalQuery`/`internalMutation`/`internalAction`) with dozens of private
calculation/projection/migration-runner helper functions, making it hard to
navigate and review.

**Hard constraint driving this plan's shape:** Convex derives a function's public
API namespace from the file it is physically defined in — a handler in
`apps/convex/finances.ts` is `api.finances.X` / `internal.finances.X`. There are
**945** call sites of `api.finances.*` and **90** of `internal.finances.*` across
the repo (mobile app, other Convex files, tests). This repo's local environment
cannot install dependencies or run `tsc`/`vitest` (no `GITHUB_TOKEN` with
`read:packages` for the private `@supa-media/*` registry — see `.claude/PROJECT.md`
"Validation Commands"), so a change that renames any of those 945+ call sites
cannot be verified before CI runs. Renaming the API is explicitly **out of scope**.

Therefore this chore does **not** move any Convex-registered handler. Every
`query`/`mutation`/`internalQuery`/`internalMutation`/`internalAction` stays
physically in `finances.ts`, in its current position, with an unchanged
`args`/`returns`/`handler` shape. What moves is the ~4,500 lines of **private
helper functions, projection/summary functions, dashboard-math functions, and
one-off migration-runner bodies** that those handlers call — relocated into a
new `apps/convex/lib/financeInternals/` directory, organized by responsibility,
and imported back into `finances.ts`. This is a pure code-motion chore: no
behavior changes, no API changes, no schema changes.

`apps/convex/lib/finance.ts` already exists as a **file** (auth/role helpers:
`requireFinanceRole`, `requireFinanceManager`, etc. — already imported into
`finances.ts`). A new directory must not collide with it, hence the
`financeInternals` name (not `finance/`).

## Scope

**In scope:**
- Creating 19 new files under `apps/convex/lib/financeInternals/` (18 flat +
  1 `migrations/` subdirectory of 6 files, listed exactly in "Relevant Files" →
  "New Files" below).
- Moving the private helper functions, type aliases, and migration-runner
  bodies listed in Step by Step Tasks out of `apps/convex/finances.ts` into
  those new files, verbatim (no logic changes).
- One small mechanical **pre-move restructuring**: `removeEmptyAutoBudgets`
  (currently an `internalMutation` with its migration logic inline in the
  `handler`) gets its body factored into a `runRemoveEmptyAutoBudgets(ctx,
  chapterId)` function, matching the shape every sibling migration
  (`backfillEventBudgets`, `migrateLinksToBudgets`, etc.) already uses. This is
  the only place code is restructured rather than purely relocated — behavior
  is unchanged.
- Updating `apps/convex/finances.ts`'s import block to pull the moved symbols
  back in from the new files.
- Adding `export { ... } from "./lib/financeInternals/..."` re-export
  statements in `finances.ts` for the 16 symbols listed in "Relevant Files"
  that other files currently import via `from "./finances"` / `from
  "../finances"` — so those 15 external files need **zero changes**.
- Deleting the moved declarations (and their leading JSDoc comments) from
  `finances.ts` once they exist in their new home.

**Out of scope:**
- Any change to `api.finances.*` / `internal.finances.*` naming, or to any of
  the ~70 handlers' `args`/`returns`/`handler` logic.
- Any change to the 15 external files that `import ... from "./finances"` (they
  keep importing from `"./finances"` unchanged — re-exports make this work).
- Splitting any other file (`increase.ts`, `aiActions.ts`, `cards.ts`,
  `cards.test.ts`) — `finances.ts` is the single largest offender and the only
  one this chore touches.
- Moving the private row-shape `v.object` validator constants at the top of
  `finances.ts` (roughly lines 109–479, e.g. `refKindValidator` and friends).
  These are purely mechanical to move too but are lower value and add ~40 more
  cross-references to verify; leave them in `finances.ts`.
- Deleting the unused `type PeriodMode` (dead code, never referenced elsewhere
  in the file) — move it as-is with the rest of `dashboardMath.ts`. Do not
  delete dead code as a side effect of this chore.
- Any change to `apps/convex/lib/finance.ts` (the existing auth/role-helper
  file) beyond nothing — it is not touched.
- Regenerating or hand-editing anything under `apps/convex/_generated/`.
- Updating the Academy (`packages/shared/src/academy/`) — this chore has no
  user-facing behavior change, so no Academy update is triggered.

## Relevant Files

**Search commands used:**
```
git ls-files | xargs -I{} wc -l {} 2>/dev/null | sort -rn | head -30
grep -na "^export const\|^export function\|^export async function\|^async function\|^function " apps/convex/finances.ts
grep -rna "api\.finances\." --include="*.ts" --include="*.tsx" . | grep -v _generated | wc -l   # 945
grep -rna "internal\.finances\." --include="*.ts" --include="*.tsx" . | grep -v _generated | wc -l   # 90
grep -rna "from \"\./finances\"\|from \"\.\./finances\"" --include="*.ts" apps/convex
```
(Note: `finances.ts` must be grepped with `grep -na`, not plain `grep` — the
file contains a byte sequence that makes plain `grep` treat it as binary and
print nothing.)

- `apps/convex/finances.ts` — the file being shrunk. Every step below either
  reads from or edits this file.
- `apps/convex/lib/finance.ts` — existing auth/role-helper file; **not
  edited**, but its existence is why the new directory is named
  `financeInternals`, not `finance`.
- `apps/convex/tests/setup.helpers.ts:21` — `import.meta.glob("../**/*.*s")` is
  the module map `convex-test` uses; it is a recursive glob rooted at
  `apps/convex/`, so new files under `lib/financeInternals/**` are picked up
  automatically. No test-harness change needed — confirmed by reading this
  line, do not skip re-confirming it if the glob pattern looks different by
  the time you implement.
- 15 files that `import { ... } from "./finances"` or `"../finances"` and must
  keep working unchanged via re-exports added to `finances.ts`:
  `apps/convex/projectActions.ts`, `apps/convex/projects.ts`,
  `apps/convex/seatStructure.ts`, `apps/convex/dashboardDrill.ts`,
  `apps/convex/reimbursements.ts`, `apps/convex/docs.ts`,
  `apps/convex/seats.ts`, `apps/convex/events.ts`,
  `apps/convex/reminders.ts`, `apps/convex/ai.ts`,
  `apps/convex/reconcileSuggest.ts`, `apps/convex/transfers.ts`,
  `apps/convex/aiCodingData.ts`, `apps/convex/moneyViews.ts`,
  `apps/convex/dashboardCharts.ts`, `apps/convex/financeRoles.ts`,
  `apps/convex/migrations/0026_migrate_budget_v1_lines.ts`,
  `apps/convex/migrations/0027_sync_linked_budget_identity.ts`,
  `apps/convex/lib/templates.ts`.
  (18 files listed; some appear once for multiple symbols.) The 16 symbols
  they need, and which must therefore be re-exported from `finances.ts`:
  `ROLLUP_SCAN_LIMIT`, `isSpend`, `txnMatchesMode`, `inPeriod`, `isSuggestible`,
  `assertIntegerCents`, `effectiveCapCents`, `isAttributableBudget`,
  `effectiveType`, `effectiveRefKind`, `createEventBudget`, `hasBudgetForRef`,
  `getBudgetForRef`, `syncBudgetIdentityForRef`, `createProjectBudget`,
  `eventBudgetLabel`, `ensureBudgetForRef`, `setBudgetAmount`, `ensureTag`.
  (`ensureTag` and `hasBudgetForRef` currently have zero external importers but
  are already `export`ed — re-export them too for safety/consistency, at no
  extra cost.)

### New Files

All under `apps/convex/lib/financeInternals/`. For each file: the functions
moving into it (with **current** line ranges in `finances.ts` as of this
plan's authoring — re-verify each range by reading the file directly before
cutting, since earlier moves in the same session shift later line numbers;
locate by function name, not blind line numbers), its responsibility, and its
own new imports.

1. **`constants.ts`** — shared primitive constants.
   - `ROLLUP_SCAN_LIMIT` (line 474, `export`)
   - `DAY_MS` (line 479)
   - `MONTH_NAMES` (lines 1415–1428)
   - No internal imports.

2. **`txnGuards.ts`** — chapter-tenancy + money/period primitives (lowest-level
   shared kernel).
   - `assertIntegerCents` (685–692, `export`)
   - `requireInCallerChapter` (700–720)
   - `isSpend` (725–732, `export`)
   - `needsBudget` (739–741, `export`)
   - `isSuggestible` (756–758, `export`)
   - `inPeriod` (764–775, `export`)
   - `loadPeriodTxns` (788–816)
   - `txnMatchesMode` (831–834, `export`)
   - `readChapterId` (1228–1233)
   - `cleanPatch` (1218–1225)
   - `nextSortOrder` (1236–1243)
   - Imports: `ConvexError` from `"convex/values"`; `Doc, Id` from
     `"../../_generated/dataModel"`; `type MutationCtx, QueryCtx` from
     `"../../_generated/server"`; `CENTRAL, countsAsSpend, easternParts,
     quarterOfMonth, matchesMode` from `"@events-os/shared"`; `type
     FinanceScope` from `"../finance"`; `getChapterIdOrNull` from
     `"../context"`; `ROLLUP_SCAN_LIMIT, DAY_MS` from `"./constants"`.

3. **`budgetCore.ts`** — pure functions of a `Doc<"budgets">` (type/ref/cap
   resolution).
   - `budgetApprovalCardFields` (512–520)
   - `effectiveCapCents` (543–553, `export`)
   - `isAttributableBudget` (574–576, `export`)
   - `budgetDisplayName` (633–635)
   - `budgetEffectivePeriod` (852–876)
   - `effectiveType` (883–886, `export`)
   - `effectiveRefKind` (892–896, `export`)
   - `txnCountsTowardBudget` (923–931)
   - `type BudgetLevel` (1247)
   - `tagLevelAllowed` (1254–1257)
   - Imports: `isSpend, inPeriod` from `"./txnGuards"`; `CENTRAL,
     BUDGET_TYPE_LABELS, effectiveBudgetApprovalStatus, quarterOfMonth,
     easternParts, type BudgetType, type BudgetRefKind` from
     `"@events-os/shared"`; `Doc, Id` from `"../../_generated/dataModel"`.

4. **`readProjections.ts`** — "row → summary shape" projections shared across
   read handlers.
   - `toCategorySummary` (482–492)
   - `toTeamSummary` (494–501)
   - `toBudgetSummary` (604–627)
   - `toTxnSummary` (637–655)
   - `toMemberTxnSummary` (668–675)
   - `toBudgetTagSummary` (5373–5381)
   - `actualsForRef` (3699–3727)
   - Imports: `budgetApprovalCardFields, effectiveType, effectiveRefKind,
     budgetDisplayName` from `"./budgetCore"`; `needsBudget, isSpend` from
     `"./txnGuards"`; `ROLLUP_SCAN_LIMIT` from `"./constants"`; `CENTRAL` from
     `"@events-os/shared"`; `Doc, Id` and `type QueryCtx`.

5. **`dashboardMath.ts`** — the `DashPeriod`-based aggregation engine behind
   `dashboardChapter`/`dashboardCentral`/`tagDrilldown` (the largest single
   new file — read it back once written and confirm it type-shapes cleanly
   before moving on).
   - `type PeriodMode` (940) — dead code, move as-is, do not delete
   - `type DashPeriod` (941, `export`)
   - `inDashRange` (944–949, `export`)
   - `inYtdBudgetWindow` (960–967)
   - `txnCountsTowardBudgetDash` (975–983)
   - `txnCountsTowardTagAgg` (1008–1014, `export`)
   - `recurringAppliesToDash` (1017–1023)
   - `recurringAppliesToMonth` (1930–1939)
   - `ytdCadenceAllocationCents` (1051–1065)
   - `monthEquivForDash` (1078–1087)
   - `monthEquivalentBudgetCents` (1951–1973)
   - `budgetAllocationForDash` (1097–1101, `export`)
   - `tagAllocationForDash` (1127–1137, `export`)
   - `resolveBudgetRef` (1172–1200, `export`)
   - `refDateForBudget` (1209–1215, `export`)
   - `easternDateStr` (1737–1741, `export`)
   - `pctOf` (1751–1754, `export`)
   - `statusFor` (1762–1764, `export`)
   - `barPctOf` (1767–1770, `export`)
   - `sumSpend` (1773–1775, `export`)
   - `spendBreakdownFor` (1781–1807)
   - `budgetSpendBreakdown` (1821–1832, `export`)
   - `monthOnlySpendCentsForBudget` (1850–1861, `export`)
   - `oneTimeCardBreakdown` (1880–1890, `export`)
   - `oneTimeCardAppliesToDash` (1912–1927, `export`)
   - `nameCache` (1976–1998, `export`)
   - Imports: `effectiveCapCents, effectiveType, effectiveRefKind,
     budgetDisplayName, budgetApprovalCardFields` from `"./budgetCore"`;
     `isSpend, inPeriod` from `"./txnGuards"`; `MONTH_NAMES` from
     `"./constants"`; `CENTRAL, quarterOfMonth, easternParts` from
     `"@events-os/shared"`.

6. **`attentionQueue.ts`** — the chapter "needs attention" queue (single
   caller today, `dashboardChapter`, but thematically distinct — reimbursement
   + card data, not budget math).
   - `APPROVABLE_REIMBURSEMENT_STATUSES` (2005)
   - `chapterAttentionQueue` (2017–2127, `export`)
   - Imports: `DAY_MS` from `"./constants"`; `isMissingReceiptCharge` from
     `"../../cards"`; `formatCents, RECEIPT_GRACE_DAYS` from
     `"@events-os/shared"`.

7. **`budgetTags.ts`** — the managed-tag graph (find-or-create, level gating,
   budget↔tag links).
   - `requireTagInLevel` (1260–1273)
   - `ensureTag` (1280–1314, `export`)
   - `linkBudgetTag` (1317–1332)
   - `autoTagEventBudget` (1339–1367, `export`)
   - `autoTagProjectBudget` (1376–1390, `export`)
   - `loadBudgetTags` (1393–1412)
   - Imports: `type BudgetLevel, tagLevelAllowed` from `"./budgetCore"`;
     `ROLLUP_SCAN_LIMIT` from `"./constants"`.

8. **`budgetRefLifecycle.ts`** — one-time-budget creation/discovery/sync for
   an event/project ref.
   - `eventBudgetLabel` (1442–1455, `export`)
   - `autoCreatedBudgetApprovalStatus` (1488–1490)
   - `createEventBudget` (1492–1539, `export`)
   - `hasBudgetForRef` (1550–1560, `export`)
   - `getBudgetForRef` (1571–1580, `export`)
   - `syncBudgetIdentityForRef` (1616–1631, `export`)
   - `projectBudgetLabel` (1645–1657, `export`)
   - `createProjectBudget` (1675–1734, `export`)
   - Imports: `autoTagEventBudget, autoTagProjectBudget` from
     `"./budgetTags"`; `type BudgetLevel` from `"./budgetCore"`; `MONTH_NAMES,
     ROLLUP_SCAN_LIMIT` from `"./constants"`; `easternParts, type
     BudgetRefKind` from `"@events-os/shared"`.

9. **`budgetApproval.ts`** — draft→submitted→approved/changes_requested state
   machine helpers.
   - `assertBudgetTransition` (4910–4921)
   - `logBudgetDecision` (4933–4947)
   - `loadBudgetForApprovalDecision` (5118–5151)
   - Imports: `requireInCallerChapter` from `"./txnGuards"`; `CENTRAL,
     BUDGET_APPROVAL_STATUS_LABELS` from `"@events-os/shared"`;
     `requireFinanceManager, requireCentralEdOrFm, resolveCallerPersonId` from
     `"../finance"`; `holdsApprovalSeatAt` from `"../seats"`.

10. **`categoriesAndFunds.ts`** — General-Fund resolution + default-category
    seeding.
    - `findGeneralFundId` (3977–3991)
    - `seedDefaultCategoriesForChapter` (4002–4011)
    - `categoryAncestorHits` (4072–4086)
    - Imports: `ROLLUP_SCAN_LIMIT` from `"./constants"`; `ensureDefaultFunds,
      insertDefaultExpenseCategories` from `"../seed/finance"`.

11. **`budgetCrudHelpers.ts`** — budget-row write helpers shared by
    finance-side and entity-side (events/projects) mutations.
    - `verifyBudgetRefs` (4422–4456)
    - `ensureBudgetForRef` (4356–4402, `export`)
    - `setBudgetAmount` (4631–4686, `export`)
    - `cascadeDeleteBudget` (5302–5316)
    - Imports: `requireInCallerChapter, assertIntegerCents` from
      `"./txnGuards"`; `effectiveCapCents, effectiveRefKind` from
      `"./budgetCore"`; `createEventBudget, createProjectBudget` from
      `"./budgetRefLifecycle"`; `ROLLUP_SCAN_LIMIT` from `"./constants"`.

12. **`txnAttribution.ts`** — transaction write-guard cluster (reconcile
    authz, note/receipt/category carve-out, approval-status attribution gate).
    - `assertBudgetApprovedForAttribution` (588–602)
    - `verifyTxnRefs` (7199–7218)
    - `requireReconcileTxn` (7233–7256)
    - `eventForTxn` (7271–7286)
    - `requireTxnNoteReceiptCategoryAccess` (7306–7331)
    - Imports: `requireInCallerChapter` from `"./txnGuards"`;
      `isAttributableBudget, budgetDisplayName` from `"./budgetCore"`;
      `callerHasEventEditRights` from `"../org"`; `requireFinanceCentral,
      requireFinanceRole, type FinanceScope` from `"../finance"`; `CENTRAL,
      financeRoleAtLeast, FINANCE_ROLE_LABELS` from `"@events-os/shared"`.

13. **`reassignment.ts`** — bulk-reassign / project-and-event scope-transfer
    engine.
    - `requireCentralWrite` (7830–7844)
    - `type ReattributionPriorState` (7849–7860, `export`)
    - `snapshotPriorState` (7864–7877, `export`)
    - `keepTargetOwnedPerson` (7886–7895)
    - `computeReassignmentPatch` (7933–7962, `export`)
    - `financeScopeName` (7966–7970, `export`)
    - `buildReassignSummary` (7973–7984, `export`)
    - `moveBudgetScope` (8099–8146)
    - `transferRefScope` (8164–8254, `export`)
    - Imports: `tagLevelAllowed` from `"./budgetCore"`; `ROLLUP_SCAN_LIMIT`
      from `"./constants"`; `requireChapterId, requireUserId` from
      `"../context"`; `requireFinanceCentral, defaultFundId, type
      FinanceScope` from `"../finance"`; `CENTRAL, financeRoleAtLeast,
      FINANCE_ROLE_LABELS` from `"@events-os/shared"`.

14. **`migrations/budgetScope.ts`**
    - `runBudgetScopeMigration` (5541–5624, `export`)
    - Imports: `ensureTag, linkBudgetTag, autoTagEventBudget` from
      `"../budgetTags"`; `type BudgetLevel` from `"../budgetCore"`; `type
      BudgetType, type BudgetRefKind` from `"@events-os/shared"`.

15. **`migrations/eventProjectBackfill.ts`**
    - `runBackfillEventBudgets` (5689–5823, `export`)
    - `runBackfillProjectBudgets` (5884–6008, `export`)
    - Imports: `eventBudgetLabel, projectBudgetLabel` from
      `"../budgetRefLifecycle"`; `autoTagEventBudget, autoTagProjectBudget`
      from `"../budgetTags"`; `ROLLUP_SCAN_LIMIT` from `"../constants"`;
      `easternParts` from `"@events-os/shared"`.

16. **`migrations/emptyBudgetsCleanup.ts`**
    - `runRemoveEmptyAutoBudgets` (export) — this function does not exist yet;
      it is created by the pre-move restructuring step (see Step by Step
      Tasks) that extracts the current inline handler body of
      `removeEmptyAutoBudgets` (handler body currently at ~6078–6135, between
      `export const removeEmptyAutoBudgets = internalMutation({` at 6070 and
      its closing `});`) into this new function.
    - Imports: `cascadeDeleteBudget` from `"../budgetCrudHelpers"`;
      `ROLLUP_SCAN_LIMIT` from `"../constants"`.

17. **`migrations/linksToBudgets.ts`**
    - `type MigrationConflict` (6204–6217)
    - `refDisplayName` (6223–6234)
    - `runMigrateLinksToBudgets` (6250–6378, `export`)
    - Imports: `ensureBudgetForRef` from `"../budgetCrudHelpers"`;
      `budgetDisplayName` from `"../budgetCore"`; `CENTRAL` from
      `"@events-os/shared"`; `type BudgetRefKind` from `"@events-os/shared"`.
    - Note: the `v.object` `returns:` validators for the still-resident
      `migrateLinksToBudgets` mutation (`migrateLinksToBudgetsConflict`,
      `migrateLinksToBudgetsResult`, ~6155–6200) **stay in `finances.ts`** —
      they belong to the handler declaration, not the runner body. Only the
      `MigrationConflict` **type** (used inside the runner body) moves.

18. **`migrations/entityBudgetDrift.ts`**
    - `runReconcileEntityBudgetDrift` (6455–6573, `export`)
    - `runHealRowlessEntityBudgets` (6647–6736, `export`)
    - Imports: `effectiveRefKind` from `"../budgetCore"`; `createEventBudget,
      createProjectBudget, hasBudgetForRef, getBudgetForRef` from
      `"../budgetRefLifecycle"`; `type BudgetRefKind` from
      `"@events-os/shared"`.

19. **`migrations/mergeFunds.ts`**
    - `runMergeFundsIntoGeneralForChapter` (6791–6924, `export`)
    - Imports: `findGeneralFundId` from `"../categoriesAndFunds"`;
      `ROLLUP_SCAN_LIMIT` from `"../constants"`.
    - Note: `runMergeFundsIntoGeneral`'s registered-mutation body (~6937–6987)
      already delegates to this function per-chapter — it needs **no**
      restructuring, only its import line changes.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom. Steps 1–13 create
lower-level files before the files that depend on them (each file only
imports from files created in an earlier step, plus `@events-os/shared`,
`_generated/*`, or existing sibling `lib/*` files — never forward-references a
later step). After each file-creation step, move the listed code out of
`finances.ts` immediately (don't batch all moves to the end) so a mid-plan
`git diff` always shows a consistent, buildable-in-spirit state.

### 1. Create `apps/convex/lib/financeInternals/constants.ts`
Move `ROLLUP_SCAN_LIMIT`, `DAY_MS`, `MONTH_NAMES` out of `finances.ts` into
this new file, `export`ed as listed in "New Files" item 1. Leave a `// TODO`
nowhere — just move the code verbatim with its imports resolved as described.

### 2. Create `apps/convex/lib/financeInternals/txnGuards.ts`
Move the 11 functions listed in "New Files" item 2, verbatim, including their
leading JSDoc comments. Import `ROLLUP_SCAN_LIMIT, DAY_MS` from `./constants`.

### 3. Create `apps/convex/lib/financeInternals/budgetCore.ts`
Move the 10 declarations listed in item 3. Import `isSpend, inPeriod` from
`./txnGuards`.

### 4. Create `apps/convex/lib/financeInternals/readProjections.ts`
Move the 7 functions listed in item 4. Import from `./budgetCore`,
`./txnGuards`, `./constants` as listed.

### 5. Create `apps/convex/lib/financeInternals/dashboardMath.ts`
Move the 24 declarations listed in item 5 (the largest cluster — take care
matching every helper's full body, including nested closures). Import from
`./budgetCore`, `./txnGuards`, `./constants` as listed.

### 6. Create `apps/convex/lib/financeInternals/attentionQueue.ts`
Move `APPROVABLE_REIMBURSEMENT_STATUSES` and `chapterAttentionQueue` (item 6).
Import `DAY_MS` from `./constants`, `isMissingReceiptCharge` from
`../../cards` (note: `finances.ts` already imports `isMissingReceiptCharge`
from `./cards` — the new file is one directory deeper, hence `../../cards`).

### 7. Create `apps/convex/lib/financeInternals/budgetTags.ts`
Move the 6 declarations listed in item 7. Import `type BudgetLevel,
tagLevelAllowed` from `./budgetCore`.

### 8. Create `apps/convex/lib/financeInternals/budgetRefLifecycle.ts`
Move the 8 declarations listed in item 8. Import from `./budgetTags`,
`./budgetCore`, `./constants` as listed.

### 9. Create `apps/convex/lib/financeInternals/budgetApproval.ts`
Move the 3 functions listed in item 9. Import `requireInCallerChapter` from
`./txnGuards`; the finance-role helpers from `../finance`
(`apps/convex/lib/finance.ts` — one directory up from
`lib/financeInternals/`); `holdsApprovalSeatAt` from `../seats`.

### 10. Create `apps/convex/lib/financeInternals/categoriesAndFunds.ts`
Move the 3 functions listed in item 10. Import `ensureDefaultFunds,
insertDefaultExpenseCategories` from `../seed/finance`
(`apps/convex/lib/seed/finance.ts`).

### 11. Create `apps/convex/lib/financeInternals/budgetCrudHelpers.ts`
Move the 4 functions listed in item 11. Import from `./txnGuards`,
`./budgetCore`, `./budgetRefLifecycle`, `./constants` as listed.

### 12. Create `apps/convex/lib/financeInternals/txnAttribution.ts`
Move the 5 functions listed in item 12. Import `callerHasEventEditRights`
from `../org` (`apps/convex/lib/org.ts`); role helpers from `../finance`.

### 13. Create `apps/convex/lib/financeInternals/reassignment.ts`
Move the 9 declarations listed in item 13. Import `requireChapterId,
requireUserId` from `../context`; `requireFinanceCentral, defaultFundId` from
`../finance`.

### 14. Restructure `removeEmptyAutoBudgets` in `finances.ts` (mechanical, no behavior change)
Before moving migration runners, bring `removeEmptyAutoBudgets` in line with
every other migration's shape. Find `export const removeEmptyAutoBudgets =
internalMutation({` in `finances.ts` (currently ~line 6070). Extract its
entire `handler: async (ctx, args) => { ... }` body into a new top-level
function `async function runRemoveEmptyAutoBudgets(ctx: MutationCtx,
chapterId: Id<"chapters"> | undefined) { ...same body... }` placed
immediately above the `removeEmptyAutoBudgets` declaration, and replace the
handler with:
```ts
export const removeEmptyAutoBudgets = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: removeEmptyAutoBudgetsResult,
  handler: async (ctx, args) => await runRemoveEmptyAutoBudgets(ctx, args.chapterId),
});
```
Adjust the parameter name/type to match whatever the original handler
destructured from `args` — read the current body first to get this exactly
right (do not guess the return type; it must match `removeEmptyAutoBudgetsResult`).

### 15. Create the 6 files under `apps/convex/lib/financeInternals/migrations/`
In this order (each only depends on earlier ones plus files from steps 1–13):
1. `migrations/budgetScope.ts` — move `runBudgetScopeMigration` (item 14).
2. `migrations/eventProjectBackfill.ts` — move `runBackfillEventBudgets` and
   `runBackfillProjectBudgets` (item 15).
3. `migrations/emptyBudgetsCleanup.ts` — move the `runRemoveEmptyAutoBudgets`
   function created in Step 14 (item 16).
4. `migrations/linksToBudgets.ts` — move `type MigrationConflict`,
   `refDisplayName`, `runMigrateLinksToBudgets` (item 17). Leave the
   `migrateLinksToBudgetsConflict` / `migrateLinksToBudgetsResult` `v.object`
   validators in `finances.ts`.
5. `migrations/entityBudgetDrift.ts` — move `runReconcileEntityBudgetDrift`
   and `runHealRowlessEntityBudgets` (item 18).
6. `migrations/mergeFunds.ts` — move `runMergeFundsIntoGeneralForChapter`
   (item 19).

### 16. Update `apps/convex/finances.ts`'s import block
Add these imports (grouped as shown) near the existing `./lib/finance`,
`./lib/context`, etc. imports at the top of the file:
```ts
import { ROLLUP_SCAN_LIMIT, DAY_MS, MONTH_NAMES } from "./lib/financeInternals/constants";
import {
  assertIntegerCents, requireInCallerChapter, isSpend, needsBudget, isSuggestible,
  inPeriod, loadPeriodTxns, txnMatchesMode, readChapterId, cleanPatch, nextSortOrder,
} from "./lib/financeInternals/txnGuards";
import {
  effectiveCapCents, isAttributableBudget, budgetApprovalCardFields, budgetDisplayName,
  effectiveType, effectiveRefKind, budgetEffectivePeriod, txnCountsTowardBudget,
  type BudgetLevel, tagLevelAllowed,
} from "./lib/financeInternals/budgetCore";
import {
  toCategorySummary, toTeamSummary, toBudgetSummary, toTxnSummary, toMemberTxnSummary,
  toBudgetTagSummary, actualsForRef,
} from "./lib/financeInternals/readProjections";
import {
  type PeriodMode, type DashPeriod, inDashRange, txnCountsTowardTagAgg,
  budgetAllocationForDash, tagAllocationForDash, resolveBudgetRef, refDateForBudget,
  easternDateStr, pctOf, statusFor, barPctOf, sumSpend, budgetSpendBreakdown,
  monthOnlySpendCentsForBudget, oneTimeCardBreakdown, oneTimeCardAppliesToDash, nameCache,
} from "./lib/financeInternals/dashboardMath";
import { chapterAttentionQueue } from "./lib/financeInternals/attentionQueue";
import {
  requireTagInLevel, ensureTag, autoTagEventBudget, autoTagProjectBudget, loadBudgetTags,
} from "./lib/financeInternals/budgetTags";
import {
  eventBudgetLabel, createEventBudget, hasBudgetForRef, getBudgetForRef,
  syncBudgetIdentityForRef, projectBudgetLabel, createProjectBudget,
} from "./lib/financeInternals/budgetRefLifecycle";
import { assertBudgetTransition, logBudgetDecision, loadBudgetForApprovalDecision } from "./lib/financeInternals/budgetApproval";
import { seedDefaultCategoriesForChapter, categoryAncestorHits } from "./lib/financeInternals/categoriesAndFunds";
import {
  verifyBudgetRefs, ensureBudgetForRef, setBudgetAmount, cascadeDeleteBudget,
} from "./lib/financeInternals/budgetCrudHelpers";
import {
  assertBudgetApprovedForAttribution, verifyTxnRefs, requireReconcileTxn, eventForTxn,
  requireTxnNoteReceiptCategoryAccess,
} from "./lib/financeInternals/txnAttribution";
import {
  requireCentralWrite, type ReattributionPriorState, snapshotPriorState,
  computeReassignmentPatch, financeScopeName, buildReassignSummary, transferRefScope,
} from "./lib/financeInternals/reassignment";
import { runBudgetScopeMigration } from "./lib/financeInternals/migrations/budgetScope";
import { runBackfillEventBudgets, runBackfillProjectBudgets } from "./lib/financeInternals/migrations/eventProjectBackfill";
import { runRemoveEmptyAutoBudgets } from "./lib/financeInternals/migrations/emptyBudgetsCleanup";
import { runMigrateLinksToBudgets, type MigrationConflict } from "./lib/financeInternals/migrations/linksToBudgets";
import { runReconcileEntityBudgetDrift, runHealRowlessEntityBudgets } from "./lib/financeInternals/migrations/entityBudgetDrift";
import { runMergeFundsIntoGeneralForChapter } from "./lib/financeInternals/migrations/mergeFunds";
```
Note `keepTargetOwnedPerson` and `moveBudgetScope` (private, non-exported
helpers of `reassignment.ts`) are used only inside `transferRefScope` /
`computeReassignmentPatch`, which are themselves imported — do not import
them separately into `finances.ts`.

### 17. Add re-export statements to `apps/convex/finances.ts`
Immediately after the import block from Step 16, add:
```ts
export { ROLLUP_SCAN_LIMIT } from "./lib/financeInternals/constants";
export { isSpend, txnMatchesMode, inPeriod, isSuggestible, assertIntegerCents } from "./lib/financeInternals/txnGuards";
export { effectiveCapCents, isAttributableBudget, effectiveType, effectiveRefKind } from "./lib/financeInternals/budgetCore";
export { eventBudgetLabel, createEventBudget, hasBudgetForRef, getBudgetForRef, syncBudgetIdentityForRef, createProjectBudget } from "./lib/financeInternals/budgetRefLifecycle";
export { ensureBudgetForRef, setBudgetAmount } from "./lib/financeInternals/budgetCrudHelpers";
export { ensureTag } from "./lib/financeInternals/budgetTags";
```
This is the highest-risk step to skip: without it, the 18 external files
listed in "Relevant Files" that `import { X } from "./finances"` break with no
local typecheck available to catch it before CI runs.

### 18. Delete the moved declarations from `finances.ts`
Now that every moved symbol is available via the imports/re-exports added in
Steps 16–17, delete each function/type/const listed in "New Files" items 1–19
from its original location in `finances.ts` (including its leading JSDoc
comment). Do not delete the `export const X = query({...})` /
`mutation({...})` / `internal*({...})` handler declarations themselves — only
the private helpers and the small number of previously-`export`ed
non-handler symbols now re-exported in Step 17. Confirm nothing was
double-deleted or left half-moved by diffing `finances.ts` before/after this
step's line count drops from ~8,642 to roughly 4,000–4,200 lines.

### 19. Run the Validation Commands
Run every command below. Every one must exit clean.

## Validation Commands
Execute every command. Every one must exit clean. (Per `.claude/PROJECT.md`,
none of these can run locally in this environment — no `GITHUB_TOKEN` with
`read:packages` for `@supa-media/*`, so `pnpm install` fails before any of
these can even start. They run in CI on the PR. If a `GITHUB_TOKEN` happens to
be available when you implement this, run them locally first and fix any
failure before opening the PR; otherwise open the PR and watch CI.)

- `pnpm install --frozen-lockfile` — install deps
- `pnpm --filter @events-os/convex typecheck` (`tsc --noEmit`) — must pass
  with zero errors; this is the primary signal the extraction was done
  correctly (every moved symbol resolves, every import path is correct)
- `pnpm --filter @events-os/convex test` (`vitest run`) — zero regressions;
  the `import.meta.glob` module map in `apps/convex/tests/setup.helpers.ts`
  picks up the new files automatically, no test-harness change needed
- `pnpm --filter @events-os/convex lint` (`eslint .`)
- `grep -rn "from \"\./finances\"\|from \"\.\./finances\"" apps/convex --include="*.ts" | grep -v _generated` —
  confirm the same 18 files still import from `"./finances"` unchanged (no
  external file should need an import-path edit)
- `pnpm turbo run test` — full monorepo suite, zero regressions
- `pnpm turbo run typecheck` — full monorepo typecheck, zero regressions

## Notes

- **Local validation is unavailable in this environment** (see
  `.claude/PROJECT.md`) — the implementing agent should still self-review the
  diff carefully (every moved function present exactly once, every import
  path correct, every re-export present) before opening the PR, since CI is
  the only place this gets checked.
- Line numbers throughout this plan are a snapshot as of planning time and
  **will drift** as soon as the first move happens — always locate code by
  function/const name via `grep -na "functionName" apps/convex/finances.ts`,
  never by trusting a stale line number from this plan.
- `type PeriodMode` in `dashboardMath.ts` is unused dead code, discovered
  during research. It's moved as-is per this chore's no-behavior-change rule;
  a follow-up chore could delete it, but don't do that here.
- Optional, explicitly deferred: the private `v.object` row-shape validator
  constants near the top of `finances.ts` (~lines 109–479) could also move to
  a `lib/financeInternals/validators.ts` in a future chore — left out here to
  keep this PR's diff reviewable.
- No pre-existing test failures are known (the suite could not be run in this
  environment to confirm a clean baseline before this chore starts — if CI is
  currently red on `main` for unrelated reasons, do not attribute that to this
  chore).
