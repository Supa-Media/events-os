# Links → Budgets Migration Runbook (WP-U phase A)

**Audience:** whoever deploys `feat/kill-link-budget-only` to production (owner or a
maintainer agent). **What this is:** the operational checklist for running
`finances:migrateLinksToBudgets` against production — deploy timing, the exact
command, per-chapter completeness verification, and the conflict review procedure.
**What this isn't:** a design doc — see `docs/plans/finance-v2-split-prd.md` §"one
home per dollar" for the why, and the doc comments on `migrateLinksToBudgets` /
`ensureBudgetForRef` in `apps/convex/finances.ts` for the mechanics.

Do not run this migration ad hoc. Follow the order below.

---

## 1. Why deploy and migration must run back-to-back

This PR flips `eventActuals`/`projectActuals`/the dashboard's "recent transactions"
card from FK-first (`transactions.eventId`/`projectId`) to **budget-first**
(`transactions.budgetId`). The read switch ships in the SAME deploy as the code that
stops writing the FKs — there is no flag gating it.

**The gap:** every transaction written *before* this deploy carries the legacy FK but
not `budgetId`. Until `migrateLinksToBudgets` backfills it, that transaction is
**invisible to `eventActuals`/`projectActuals` — it reads as $0 spend**, not "spend
pending migration." A leader opening an event's actuals page in that window sees an
undercounted (possibly $0) total. This is a real, visible regression for the duration
of the gap — not a cosmetic one.

**The rule:** deploy `feat/kill-link-budget-only` to production, then run the full
migration (§3) to completion (§4 proves it) **in the same maintenance window**,
before any leader is expected to trust actuals. Don't merge-and-walk-away. If the
migration can't be run immediately after deploy for some reason, say so explicitly
and treat every event/project actuals page as unreliable until it's done.

---

## 2. Preconditions

- [ ] `feat/kill-link-budget-only` is merged and deployed to production
      (`vivid-rhinoceros-688` — see `reference_events_os_infra`).
- [ ] You have access to run the maintainer-only `run-convex-function.yml` workflow
      (`gh workflow run` requires repo write access) — or a local `CONVEX_DEPLOY_KEY`
      for `--prod`, if you prefer to run it synchronously instead (§3 covers both).
- [ ] No `Sync Secrets` workflow is running concurrently (see
      `reference_events_os_secret_sync` — don't race a Convex deploy/secret push).

---

## 3. Running the migration

### Preferred: the maintainer workflow (async, logged to the Action run)

First page:

```
gh workflow run run-convex-function.yml -f function=finances:migrateLinksToBudgets -f args='{}'
```

This runs on the whole deployment (every chapter), one page of up to 500 transactions
(`MIGRATION_PAGE_SIZE` in `apps/convex/finances.ts`). Watch it:

```
gh run watch $(gh run list --workflow=run-convex-function.yml -L1 --json databaseId -q '.[0].databaseId')
```

Then read the printed result from the run log (the `npx convex run` output, or the
job's stdout) — you need `isDone` and, if `isDone` is `false`, `continueCursor`:

```
gh run view $(gh run list --workflow=run-convex-function.yml -L1 --json databaseId -q '.[0].databaseId') --log | grep -A2 '"isDone"'
```

If `isDone` is `false`, run the next page with the `continueCursor` from the
previous result:

```
gh workflow run run-convex-function.yml -f function=finances:migrateLinksToBudgets -f args='{"paginationOpts":{"numItems":500,"cursor":"<continueCursor-from-previous-run>"}}'
```

Repeat until a run returns `isDone: true`. Do not stop earlier — an `isDone: false`
run means there is more of the `transactions` table left to examine; a partial run is
NOT "mostly migrated," it's an unknown subset migrated (see §4 for how to actually
prove you're done).

### Alternative: synchronous local run (if you hold a prod deploy key)

Equivalent, but you see the JSON result immediately instead of digging through Action
logs:

```
npx convex run --prod finances:migrateLinksToBudgets '{}'
# then, per page, until isDone:
npx convex run --prod finances:migrateLinksToBudgets '{"paginationOpts":{"numItems":500,"cursor":"<continueCursor>"}}'
```

### Per-chapter runs (optional, for isolating a specific chapter)

Pass `chapterId` alongside (or instead of) `paginationOpts` to scope a run to one
chapter — useful if you want to verify chapters one at a time rather than trusting a
single whole-deployment pass:

```
npx convex run --prod finances:migrateLinksToBudgets '{"chapterId":"<chapter id>"}'
```

A chapter-scoped run still paginates internally (500/page) and still returns
`isDone`/`continueCursor` — page through it the same way if a chapter has more than
500 FK-bearing transactions.

---

## 4. Per-chapter completeness verification

`isDone: true` on the LAST page of a run proves every row in that run's scope
(the whole table, or one chapter) was examined — this is the pagination fix from the
phase-A review (the old `.take(ROLLUP_SCAN_LIMIT)` implementation could silently
truncate past 5,000 rows with no way to tell). To positively confirm nothing was
missed, after the run reaches `isDone: true`:

1. **Re-run the whole migration from scratch** (`args='{}'`, cursor `null`), paging
   through to `isDone: true` again. On a fully-migrated deployment, every page's
   `backfilled` should be `0` (everything is now `alreadySet`, `conflictCount`, or
   `skipped`). A nonzero `backfilled` on this second pass means either new
   transactions landed between runs (fine — re-run once more) or the first pass
   missed something (not fine — stop and investigate before declaring done).
2. **Sum `scanned` across every page of the final clean run** and sanity-check it
   against Convex dashboard data (`mcp__convex__tables` or the dashboard UI) — the
   `transactions` table's total row count should be in the right ballpark relative to
   `scanned` (rows with neither `eventId` nor `projectId` are legitimately excluded
   from `scanned`, so an exact match isn't expected, but a huge gap is a red flag).
3. **Spot-check a few chapters individually** via the per-chapter run (§3) — each
   chapter's own `isDone: true` + zero-`backfilled` re-run is the strongest per-chapter
   proof, since it isolates that chapter's data from the rest of the table.

Only once step 1's re-run comes back clean (zero `backfilled` everywhere) is the
migration actually done — that's the signal to tell leaders event/project actuals are
trustworthy again.

---

## 5. Conflict review procedure

A **conflict** is a transaction that already had a `budgetId` set — to something
OTHER than its FK's ref budget — before the migration examined it. This means a human
explicitly re-attributed that transaction (via the reconcile "For" picker) sometime
after the legacy FK was written but before this migration ran. The migration NEVER
overwrites that explicit choice — it logs the conflict and moves on.

Each run's result includes a `conflicts` array (also echoed to `console.log`,
retrievable via `mcp__convex__logs` or the Convex dashboard's Logs tab, prefixed
`[finances] migrateLinksToBudgets conflict:`). Each entry has everything needed to
review it without a follow-up query:

| Field | What it tells you |
|---|---|
| `transactionId` | The conflicted transaction — open it directly in Reconcile. |
| `merchantName`, `postedAt`, `amountCents` | Identify the transaction in the review conversation ("the $150 Guitar Center charge from March 3"). |
| `refKind`, `refId`, `refName` | The event/project the legacy FK pointed at, by NAME (not just an id). |
| `refBudgetId`, `refBudgetLabel` | The budget the FK's ref resolves to — what this txn WOULD have been attributed to. |
| `currentBudgetId`, `currentBudgetLabel` | The budget the txn is CURRENTLY (and remains) attributed to. |
| `message` | Ready-to-paste sentence: e.g. *"$150.00 at Guitar Center (2026-03-03) will no longer appear in Fall Retreat Worship's actuals — it's already attributed to 'Ops Fund' instead of 'Fall Retreat Worship'."* |

For each conflict:

1. **Read the `message`.** In the overwhelming majority of cases the human's later
   re-code was intentional (e.g. a worship-supplies purchase that turned out to be
   general ops spend, not tied to one event) — no action needed, the conflict is
   informational only.
2. **If the re-code looks like a mistake** (e.g. `currentBudgetLabel` is clearly
   unrelated to the transaction, or the bookkeeper who set it doesn't recall doing
   so), open the transaction in Reconcile and re-categorize it to `refBudgetLabel`
   via the "For" picker (`categorizeTransaction` with `budgetId: refBudgetId`) —
   this is a normal in-app bookkeeper action, not something to do via CLI.
3. **Do not bulk-resolve conflicts.** Each one represents a specific human decision at
   some point in the past; treat the list as a review queue, not a batch to
   auto-apply a rule against.

A conflict is never "fixed" by re-running the migration — it isn't a bug, and the
migration will keep reporting the same conflict on every re-run until a bookkeeper
either confirms it's correct (nothing to do) or manually re-categorizes the
transaction in-app.
