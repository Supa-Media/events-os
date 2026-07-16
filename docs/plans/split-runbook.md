# The NYC Split Runbook

**Audience:** the owner (ED), the incoming NYC Chapter Director, the central Financial
Manager (FM). **What this is:** the operational checklist for split day — the day one
blended NYC team becomes a Central team + a self-contained NYC Chapter. Follow it in
order; don't improvise mid-run. **What this isn't:** a design doc — see
`docs/plans/finance-v2-split-prd.md` for the why (read §0–§0.2 and §3 first if you
haven't already).

This is WP-2.3 of the finance v2 PRD. It depends on WP-2.1 (money can belong to
central — **merged**, PR #151) and WP-2.2 (bulk reattribution + project transfer —
**lands separately**; the mechanical steps below name its functions and assume they
exist by the time you run this).

---

## 1. Preconditions

Do not start the mechanical steps until every box is checked.

- [ ] **20 non-team backers reached.** The playbook's tier trigger (owner-confirmed
      2026-07-16: **20 / 30 / 50** backers → WWS / +Eden / +LTN; this is the deep-dive
      table, not the stale one-pager's 25/50/75). Confirm the current backer count
      manually (Giving page doesn't exist yet — WP-4.3 stub) before treating this as
      satisfied.
- [ ] **NYC Chapter Director chosen** via the open selection process (outside this
      doc's scope — this runbook starts once a name is confirmed).
- [ ] **Teammates have picked lanes.** Every current NYC teammate has declared
      central vs. local (playbook Step 3) — nobody is left assuming they're both.
- [ ] **WP-2.2 merged** (`reassignTransactions` / `suggestSplitAssignments` /
      `transferProjectScope` exist in `apps/convex/finances.ts`). Do not attempt the
      mechanical steps against `runMergeFundsIntoGeneral`-style hand-rolled scripts —
      use the shipped ops functions.
- [ ] **Prod Increase accounts active** for both central and NY (`increaseAccounts`
      rows, `provisionChapterAccount` already run for both — see WP-1.2). Verify on
      the Accounts screen (ED/FM-only view) that both show `active`, not `pending`.
- [ ] A **live Playwright pass** over the deployed app (per PRD §4's phase-gate rule) —
      confirm `dashboardCentral` and the chapter dashboard both load without errors
      before you start moving money.

If any box is unchecked, stop and resolve it first. Nothing below is designed to run
against half-satisfied preconditions.

---

## 2. The boundary rules

Restated operationally from the playbook's functional-boundary table + the owner's
2026-07-16 decisions (PRD §3, decisions 2–3). When in doubt, this table is the
source of truth — not memory of the old blended team's habits.

### Reattributes to CENTRAL

| What | Why |
|---|---|
| Expansion spend (new-city scouting, launch trips) | Central funds city launches (PRD §0.1) |
| Conference spend (session catering, speaker costs) | Central caters conference sessions; chapters only fund their own delegation's lodging (cap $200/person) |
| Brand spend (logo, brand assets, brand licensing) | Brand is a central asset, not a chapter one |
| City Launch Fund itself (the skim destination) | It's central's fund by definition (WP-4.1) |
| **The Music Project** | **Owner decision, 2026-07-16 — the one explicit exception to "all NY projects transfer."** Organized across chapters; per-chapter recording infrastructure doesn't make sense. Transfer via `transferProjectScope(projectId, "central")`. |

### Stays / reattributes to CHAPTER (NYC)

| What | Why |
|---|---|
| All canon-event execution (WWS, Eden, LTN — the events themselves) | Chapter runs its own events; canon-event-linked txns are chapter spend by rule |
| All NY projects **except Music** | Playbook Step 3 default: "all current NY projects transfer [scope with the chapter]" |
| Local ops (storage, local transport, local software) | Chapter operating floor line items (PRD §0.1: $520 fixed + $50/teammate) |
| Monthly team meeting costs | Chapter operating floor, not central |

### Gray-area resolutions (apply these, don't re-litigate them)

- **NYC event-linked music spend** (worship at an NYC event) stays **chapter** — only
  the *Music Project* (the cross-chapter recording/production effort) is central. Don't
  conflate "music the project" with "music at an event."
- **A transaction with no canon-event link and no project link** is not automatically
  chapter or central — it goes through `suggestSplitAssignments` and a human confirms
  (see §3b). Rules suggest; they never auto-apply.
- **Multi-city or ambiguous merchants** (e.g. a vendor used by both central and NYC
  historically): treat as central unless the txn is clearly linked to an NYC canon
  event or an NYC-owned project. Default-to-central only applies to genuinely
  ambiguous rows, not to volume convenience.

---

## 3. The mechanical steps, in order

Run these in order. Each step's completion is a precondition for the next — don't
jump ahead.

### (a) Run suggestSplitAssignments, review buckets in Reconcile

- Run `suggestSplitAssignments` (WP-2.2) over the ~239 historical NYC transactions.
  It seeds suggestions from the boundary table in §2 (canon-event-linked → chapter;
  expansion/conference/brand merchants → central) plus the music-project exception.
- Open Reconcile, filtered to the suggested-but-unconfirmed bucket. Walk every row —
  do not bulk-accept without eyeballing amount + merchant + linked event/project.
- Anything the tool can't confidently bucket lands in a genuine "needs a human call"
  pile — resolve those against §2 before moving on, don't leave them for later.

### (b) Bulk-reassign confirmed sets — central first, then residuals

- Use `reassignTransactions` (Reconcile's "Reassign to → Central / [chapter]"
  multi-select action, WP-2.2) to commit the confirmed CENTRAL bucket first, then
  the confirmed CHAPTER bucket.
- **Central first** so the residual pool you're staring at afterward is
  chapter-shaped, not a mix — easier to sanity-check.
- Every bulk op writes an audit row (who, when, from→to, txn ids — see §4). After
  each batch, pull the audit rows for that batch and confirm the **count** of txns
  reassigned matches the count you selected in Reconcile. If they don't match, stop
  and investigate before running the next batch — don't compound a discrepancy.

### (c) transferProjectScope for each project

- For every NYC project: `transferProjectScope(projectId, targetScope)`.
  - Music Project → `"central"`.
  - Every other NYC project → the NYC chapter id.
- This moves the project's budgets and linked transactions with it in one operation
  (PRD WP-2.2) — don't manually re-run (b) against project-linked txns afterward,
  the scope transfer already carried them.
- Verify each project's Money tab (event/project actuals) still shows planned vs.
  actual lining up post-transfer — a project moving scope should not change its own
  total, only which chapter/central row it rolls up into.

### (d) Reassign / verify budgets

- **Central budgets already exist** (WP-0.3 shipped the central budgets UI) — do not
  recreate them. Confirm the City Launch Fund and any other central recurring
  budgets are the ones catching the reassigned central transactions from (b)/(c).
- **Chapter budgets stay** on the NYC chapter — no action needed unless a budget was
  incorrectly scoped pre-split (rare; fix via the same budget edit UI, not a bulk op).
- Spot-check `budgetVsActual` for the 2–3 largest central and chapter budgets —
  planned vs. actual should look sane, not like it's still absorbing the other
  scope's spend.

### (e) Seat changes

- **Grant the new Chapter Director + Treasurer their seats** at the NYC chapter scope:
  `assignSpecializedRole` (title `chapter_director` / `treasurer`, scope = NYC
  chapter id). Confirm the corresponding `financeRoles` grant lands too (Chapter
  Director / Treasurer need chapter-scope finance access, not just the title).
- **Remove the owner's chapter seat.** Playbook: **no dual-hatting post-split.** Use
  `removeSpecializedRole` to pull the owner's NYC-chapter-scoped title(s), and revoke
  the matching chapter-scoped `financeRoles` grant. The owner keeps their
  **central** ED seat only.
- **Verify the seat switcher empties.** Log in as the owner (or check `mySeats` for
  their personId): they should now resolve to a single seat (central ED) and land
  directly on the central dashboard — no switcher shown. If a switcher still
  appears, a chapter-scoped grant wasn't fully removed; go back and find it.

### (f) Verify

- **`dashboardCentral` partition check**: chapter rollup rows + the Central row must
  sum to the org total (`totalMonthSpendCents`). This isn't a vibe check — the
  dashboard computes it this way by construction (central-linked chapter spend is
  excluded from the chapter's own row and surfaced only in Central's, see
  `dashboardCentral`'s partition comment in `apps/convex/finances.ts`). If the
  numbers don't foot, a batch from (b) or (c) missed a re-point somewhere.
- **Unattributed drained or accounted.** Check `orgUnattributedCents` (central
  dashboard) and each chapter's own `dashboardChapter` unattributed figure. Anything
  still unattributed after (a)–(d) needs an explicit decision — either it's genuinely
  ambiguous (loop back into Reconcile) or it's a stray the reassignment missed.
  Don't close split day with unattributed dollars nobody's looked at.

### (g) Going-forward (post-split, not split-day work)

- **Skim** (WP-4.1) and **launch-fund** (WP-4.2) flows are Phase 4 — they model the
  ongoing chapter→central monthly skim and any future central→new-chapter launch
  grants. Not part of split day itself; note as post-split work and pick up when
  Phase 4 ships.

---

## 4. Rollback / safety

- **Every bulk op writes an audit row** — `who`, `when`, `from → to`, and the exact
  txn ids touched. Nothing in this runbook is a silent mutation.
- **Reassignment is reversible.** If a batch from §3(b) or §3(c) turns out wrong,
  re-run the same operation with the `from`/`to` targets swapped, scoped to the same
  txn ids from the audit row. This is a normal, expected recovery path — don't treat
  a bad batch as a crisis, just reverse it and re-bucket.
- **Nothing here deletes money data.** Reassignment moves `chapterId`/scope
  pointers; it never deletes a `transactions`, `budgets`, or `projects` row. If
  something looks wrong, the ground truth is still there to re-derive from.
- **Seat changes are also reversible** — `assignSpecializedRole` replaces the holder
  of a (scope, title) slot; nothing about seat removal deletes historical audit
  trail (who approved what, when) tied to the removed person.

---

## 5. Comms checklist

Before split day, tell the team (not after — surprises here cause real friction):

- [ ] **Lanes are final.** Everyone knows whether they're central or NYC chapter as
      of split day; no more "I'll help with both."
- [ ] **New approval chains:**
  - Chapter budgets → approved by the **Chapter Director** (Treasurer can also
    approve if the Director submitted — SoD picks the other approver).
  - Central budgets → approved by the **ED** (FM if the ED submitted).
  - **85% principle**: within the chapter's budget, the Chapter Director approves
    freely per mission/vision — central does not pre-approve chapter spend. Central's
    control is the FM's audit oversight (the cross-chapter attention queue), not a
    gate. Say this explicitly — it's a change from today's blended-team habit of
    everything routing through the owner.
- [ ] **The Treasurer reports up to the central FM** — monthly close, reimbursement
      queue, and receipt chasing are the Treasurer's job; the FM audits, doesn't do
      the bookkeeping.
- [ ] **The owner is off the NYC chapter desk.** After (e), the owner has no NYC
      chapter seat — questions that used to go to "Seyi as chapter lead" go to the new
      Chapter Director instead.
- [ ] Everyone knows where to look: the finance dashboard routes by seat
      automatically post-split (WP-0.2) — nobody needs to remember a switcher because
      single-seat holders never see one.
