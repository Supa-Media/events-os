# Reconcile — the default, and the states

**Status:** proposal. Nothing here is implemented; no behaviour has changed.
**Owner ask (2026-08-09):** *"I also hate that the reconcile page defaults to
need budget… also the different states are confusing or wrong… investigate and
act as a product director to fix these values and the default so that it's best
for our needs."*

Everything below is measured against **production** on 2026-08-09 (359
`transactions` rows, 355 after the sandbox/`excluded` drop, 9 hidden transfer
legs, 346 in the default queue). Where a claim comes from the code rather than
the data, it says so. The predicates were re-implemented from `finances.ts`
against a `convex data --prod` dump and reproduce the owner's screenshot
exactly — 127 to clear, 14 / 42 / 45 / 0 / 0 / 7 / 9 / 219 — so the numbers here
are the same numbers on his screen.

---

## 1. What the page is actually doing

The header says **"Reconcile — 127 TO CLEAR"** and the grid shows **14 rows**,
because `reconcile.tsx:196` seeds the State filter with `["needs_budget"]` when
the URL carries nothing. Two numbers, no stated relationship, one of them
invisible in the header.

That is the complaint. The data makes it worse than it looks.

### The 127 is one number doing two jobs

`toClearCount` is *every row in scope whose status isn't `reconciled`*
(`finances.ts:8364`). Split by what is actually outstanding:

| | rows |
| --- | ---: |
| Open, and something is genuinely outstanding | **51** |
| Open, nothing outstanding — categorised, budgeted, documented, just never closed | **76** |
| **"to clear"** | **127** |

**Sixty percent of the backlog headline is rows where the only remaining act is
pressing "Mark reconciled".** They are not a backlog, they are a keystroke. The
oldest is 2025-03-08 and the newest 2026-08-04, so they are not a recent
batch — they have been accumulating since the book opened, and there is no
filter that finds them. You can only reach them by scrolling 346 rows and
eyeballing each one.

### The 14 is mostly not work

The default filter's 14 rows, itemised from production:

| what it is | rows | $ |
| --- | ---: | ---: |
| Stripe / Cash App processor-fee rows waiting on a **draft** budget approval | 8 | $318.69 |
| Rows already `reconciled` (`needsBudget` has no status gate) | 4 | $1,083.27 |
| The half-unmarked $1,000 transfer leg (a bug — §4.1) — also one of the 4 above | 1 | $1,000.00 |
| Genuinely new, unbudgeted, needs a human | **2** | **$85.60** |

(The 14 rows sum to $1,487.56; the three groups above overlap by design — the
$1,000 leg is one of the four reconciled rows.)

`needsBudget` is `isSpend(tr) && tr.budgetId == null` (`finances.ts:1197`) with
no status gate, unlike `needsDocumentation` which stops at `reconciled`. So the
landing view of the money app opens on 14 rows of which **2 are work**, and the
single largest dollar figure in it is a transfer that shouldn't be spend at all.

### The default breaks search

`filterReconcileRows(rows, query)`
(`apps/mobile/components/finance/reconcile/helpers.ts:122`) filters the rows the
server already narrowed. With the default filter in force, the search box
searches **14 of 346 transactions**. Type "Olive Garden" on a fresh page load
and you get nothing, because Olive Garden is budgeted.

This is the strongest single argument against having *any* default State filter,
and it is independent of which filter you pick.

---

## 2. Recommendation — the default

**Ship no default State filter. Replace the header's one number with three
tappable numbers.**

```
Reconcile   [ 51 need attention ]  [ 76 ready to close ]  [ 219 done ]
```

- Nothing is selected on arrival, so the grid shows all 346 rows newest-first
  and **search searches the book**.
- Each chip is a filter key: tapping sets it, the chip renders selected, the URL
  carries it (`?filters=needs_attention`), and the existing multi-select
  contract is untouched.
- The number the header announces is now a number you can *get to* by tapping
  it, which is the rule the rest of this area already follows
  (`countsTowardFacet`'s doc comment, `reconcileFilters.ts`).

Two new filter keys carry the chips:

- `needs_attention` — open **and** at least one of `unreviewed` / needs budget /
  needs documentation / personal unpaid. **51 today.**
- `ready_to_close` — open and **none** of those. **76 today.**

They are complements over the open set, so `needs_attention + ready_to_close =
toClearCount` by construction, and the header stops being able to lie.

Put both in the **header only**, not in the State dropdown. They are roll-ups
over the other states; sitting them in the same list would put a 51 next to a 7
and a 42 that are subsets of it, which is exactly the "which number is the real
one" problem this fix exists to end.

**What the person opening this page is trying to do.** One of two things: *"what
happened since I last looked"* (newest-first, no filter, the top of the list) or
*"where is that transaction"* (search). A default filter serves neither and
actively breaks the second. The daily worklist — "what needs me" — is a real
third job, and it deserves a **one-tap** affordance in the header rather than a
silent pre-selection.

**Where I was torn.** A default filter makes the first screen shorter and puts
work in front of a treasurer without a tap. That is a real benefit and it is why
`needs_budget` was chosen originally. I am picking "no default" anyway, on two
grounds: the search defect makes any default a correctness problem rather than a
taste problem, and `ready_to_close` — 76 rows, the single biggest actionable
bucket in the book — argues that the *right* daily action isn't triage at all,
it's bulk-closing. `BulkBar`'s "Mark reconciled" already exists; it has never
had a way to find its rows.

---

## 3. Recommendation — the states, one by one

Live counts from production, 2026-08-09.

### Kind — keep all three, unchanged

| key | count | verdict |
| --- | ---: | --- |
| `spend` | 299 | Keep. Drill-down target for the dashboards' "Spent" tile. |
| `transfers` | 9 | Keep. The one inclusion filter — it un-hides the legs #557 removed from the queue. Doc comment in `reconcileFilters.ts` explains it well; nothing to fix. |
| `payouts` | 21 | Keep. 15 Givebutter, 3 Stripe, 3 other; 6 still owe a settlement report. |

### State

**1. `to_review` — 7 — keep, keep the name.**
Status `unreviewed`: nobody has touched it. Five of the seven are inflows
(four Givebutter deposits, one $2,304.76 ACH), two are card purchases. It is the
smallest and freshest queue and the only one that means "new". Worth noting the
name is honest — `status: "categorized"` is set the moment *any* of fund /
category / budget is assigned (`finances.ts:9059`), so it means "touched", not
"has a category".

**2. `needs_budget` — 14 → 10 — keep the state, gate the FACET on open rows.**
Four of the 14 are already `reconciled`; a closed row is not queue work. Change
the reconcile facet to `needsBudget(tr) && tr.status !== "reconciled"`, matching
what `needsDocumentation` already does. **Do not change `needsBudget` itself** —
the dashboards' unbudgeted-spend dollar tiles (`finances.ts:3264`, `:3592`,
`:3906`) want every status, because unattributed money is unattributed whether
someone closed the row or not. This is a queue-population change, not a
predicate change.

The remaining 10 are still mostly not work: 8 are the processor-fee rows.

**3. Processor-fee rows — the answer is "leave the predicate alone, fix the
approval".**
`processorFees.ts:340` creates the Bank & Fees budget as
`approvalStatus: "draft"` and `:425` refuses to attach a row to it until it is
`approved` — deliberately: *"a draft budget is a proposal, not authority, and
`categorizeTransaction` would refuse the same link from a human."* That is
right, and I would not weaken it. The rows genuinely need a budget.

But the owner should not be *triaging* them. They are machine-generated, they
will keep arriving monthly, and every one of them is blocked on a **single
approval** — approve the draft and 8 rows and $318.69 leave the queue at once,
permanently, for that year. Recommendation: surface that as a banner on this
page ("8 fee rows are waiting on the draft *Bank & Fees 2026* budget — approve
it"), not as 8 rows in a work queue. `processorFees.ts:556` already emits
exactly this sentence to a log nobody reads.

Counting a row whose budget exists but is unapproved as "needs budget" is
**correct** and should stay — the link genuinely cannot be made yet.

**4. `missing_receipt` / "Needs documentation" — 42 — keep both the predicate
and the label.**
The label was the owner's own call on 2026-08-05 and the reasoning in
`reconcileFilters.ts` holds. No change.

**5. `undocumented` / "Undocumented" — 45 → redefine the FACET, rename to
"Closed without documentation" — 3.**

This is the one the owner is right about, and the data says exactly how right.

In production the two populations are: overlap **42**, only-undocumented **3**,
only-missing-receipt **0**. `missing_receipt` is a *strict subset* of
`undocumented`. So the dropdown offers "Needs documentation 42" and
"Undocumented 45" — near-identical labels, near-identical numbers — and picking
the bigger one shows you the 42 rows you just looked at plus 3 you didn't. The
entire distinction, which costs a paragraph of doc comment and has confused the
owner into filing this ticket, buys **3 rows**.

The distinction is nonetheless real and worth keeping. The fix is to make the
facet the **difference** rather than the superset:

```
undocumented facet := isUndocumented(tr) && tr.status === "reconciled"
label            := "Closed without documentation"
```

Now the two options are disjoint, both labels are literally true, and the
publishing backlog is the OR of the two — which, being one group, is what
multi-select already gives you (45). Three rows today: a $174.87 Cash App
inflow, a $513.99 GLOBAL ECHO PUBL inflow, and a $5.25 MTA fare, all reconciled
with nothing behind them.

**`isUndocumented` the function does not change.** It is the publishing
predicate and mirrors `documentationState(...)` for the ledger; only the
reconcile facet's population and label move. Grep confirms `counts.undocumented`
has no consumer outside the dropdown and three tests
(`correctTransaction.test.ts:291`, and the receipt-exception suite) — the change
is contained.

**6. `uncoded` / "Needs coding" — 0 — hide until armed. Not broken, not
adopted: not yet possible.**

`DEFAULT_CODING_REQUIRED_SINCE_MS = Date.UTC(2026, 8, 1)`
(`packages/shared/src/finance.ts:600`) — **2026-09-01**. Production
`financeSettings` carries no `codingRequiredSinceMs` override (checked; the row
has no such field), so the default applies. `requiresCoding` is
`tr.postedAt >= sinceMs && isSpend(tr)`, and today is 2026-08-09, so **no
transaction that exists can require a coding for another three weeks**. The
count is zero by calendar, not by adoption.

**7. `coding_review` / "Coding review" — 0 — hide until armed.**
`tr.codingState === "submitted"`. The `transactionCodings` table in production
is **empty — zero rows**. Nobody has voluntarily coded anything pre-policy,
which is unsurprising since nothing asks them to yet.

For both: gate the option's presence on `codingSinceMs <= Date.now() ||
counts[key] > 0`. Don't delete them — #555 is real and lands on 2026-09-01 —
but a dropdown that offers an option which *cannot* return a row teaches people
the list is broken, and there are two of them sitting in the middle of it. This
is a display rule, three lines, and it self-heals on the policy date.

**8. `personal_unpaid` / "Personal (unpaid)" — 9 — keep, unchanged.**
All nine have a `personalRepayments` row with status `pending`; $113.74 total,
mostly recurring Webflow and MTA charges. Real work, correctly counted,
correctly labelled.

**9. `reconciled` — 219 — keep, unchanged.**
The "find the thing I already closed" escape hatch. Its size is the point.

### The proposed State dropdown

```
To review                      7
Needs budget                  10   ← open rows only
Needs documentation           42
Closed without documentation   3   ← was "Undocumented 45"
Personal (unpaid)              9
Reconciled                   219
[ Needs coding      ]              ← hidden until 2026-09-01
[ Coding review     ]              ← hidden until a coding exists
```

Six options today, eight from September. Every one can return a row. No two
overlap in a way the labels don't explain. The two roll-ups (`51`, `76`) live in
the header where the misleading number used to be.

---

## 4. Broken, not confusing

These are defects. They are separate from the naming discussion on purpose.

### 4.1 The Stripe Financial Connections sync silently un-marks transfers

**This is a money bug and it is the root cause of the row the owner spotted.**

`apps/convex/stripeFinance.ts:694–701`, the `existing` branch of the FC upsert:

```ts
// Refresh the volatile fields (a pending authorization posting, an
// amount/date correction) but never touch a human's categorization or
// status, and never insert a second row.
const patch: Partial<Doc<"transactions">> = {
  amountCents,
  flow,            // ← re-derived from the feed's amount sign, every sweep
  postedAt: row.postedAt,
  pending: row.pending,
  ...
};
```

`flow` **is** a human's categorisation once `markAsTransfer` has run — it is the
field the marking writes (`finances.ts:9894`) and the field `isSpend` reads. The
sweep overwrites it from the bank feed's sign and leaves `preMarkFlow`,
`transferGroupId` and `transferDirection` behind as orphan residue. No audit
entry is written, because `logFinanceAudit` only fires from the mark/unmark
mutations.

**Evidence, from production:**

| leg | source | flow now | `preMarkFlow` | last audit entry |
| --- | --- | --- | --- | --- |
| `w17443p52…` PUBLIC WORSHIP $1,000 | `increase_ach` | `transfer` | inflow | marked 2026-08-08 03:38 |
| `w179bmq4…` PUBLIC WORSHIP \| Transfer $1,000 | `stripe_fc` | **`outflow`** | outflow | marked 2026-08-08 03:38 |
| `w1796k11…` Return from AMAZON $26.12 | `stripe_fc` | **`inflow`** | inflow | marked 2026-08-07 03:25 |
| `w17d2tw6…` Purchase from AMAZON $26.12 | `stripe_fc` | **`outflow`** | outflow | marked 2026-08-07 03:25 |
| `w173v57p…` / `w177p3ep…` $2,873.21 pair | `increase_ach` | `transfer`, `transfer` | inflow, outflow | marked 2026-08-08 02:19 |

Three of three `stripe_fc` marked legs have reverted. Three of three
`increase_ach` marked legs have survived. **The audit log contains no unmark for
any of them** — `financeAuditLog` has 14 `transfer_mark` entries and the newest
for each of these groups is a mark, not an unmark. Nothing but the sync could
have written those flows.

The sweep is not a narrow window: `syncTransactions`' incremental phase re-reads
newest-first up to `MAX_SYNC_PAGES (50) × FC_PAGE_SIZE (100)` = **5,000 rows**
every run, and there are **97** `stripe_fc` rows in the book. Every one is
re-patched on every sweep — a daily 07:00 UTC cron plus every refresh webhook.
**A transfer marking on a Stripe-sourced row survives at most until the next
morning.**

Consequences today:

- **$1,000 of internal transfer is being counted as spend.** That leg is
  `flow: "outflow"`, so `isSpend` is true, so it is in the org's spend actuals,
  in "Needs budget", and in the unbudgeted-spend dollar tiles. Total unbudgeted
  spend reads **$1,487.56**; **$1,000 of it is this bug** and $318.69 is the
  pending fee-budget approval, leaving **$168.87** genuinely unattributed. The
  tile overstates by a factor of nine.
- **The row can't be fixed from itself.** `isMarkedTransfer` requires
  `flow === "transfer"`, so Un-mark isn't offered on the reverted leg, and
  `markAsTransfer` refuses to re-pair it (`NOT_A_PAIR` — the other leg is no
  longer `outflow`/`inflow`). The only recovery is to find the *other* leg via
  Kind → Transfers and un-mark there, which restores both through the group
  index. Nothing in the UI suggests that.
- **The Amazon pair double-counts.** $26.12 posts as spend and $26.12 posts as
  revenue, with no `refundedByTransactionId` linking them, because the marking
  that reconciled them was wiped.

**Fix:** don't re-derive `flow` on a row a human has classified. Narrowest
version — skip the `flow` key when `existing.preMarkFlow != null ||
existing.flow === "transfer"`. There is a case for never patching `flow` on an
existing row at all: a posted bank line's direction does not change, and a
sign flip arrives as its own row. I'd take the narrow fix plus a test, and treat
the broader question separately.

Plus a one-off data fix for the three residue rows (clear `preMarkFlow` /
`transferGroupId` on the two Amazon legs, re-pair the $1,000 pair) — otherwise
the fix locks the bad state in.

### 4.2 Search only searches the current filter's rows

`filterReconcileRows` runs client-side over the server-narrowed `rows`
(`helpers.ts:122`). Any active State filter shrinks what search can find; with
today's default it shrinks it to 14 of 346. Fix: when `query` is non-empty,
either drop the State constraint for that request or run the search
server-side over the full scan. This is worth fixing **even if the default
changes**, because the same trap springs on anyone who filters and then
searches.

### 4.3 `needs_budget` counts closed rows (see §3.2)

Listed here too so it doesn't get lost in the naming section: 4 of the 14 rows
in the default view are already `reconciled`. Facet-level fix, predicate
untouched.

---

## 5. What I would not change, and what that costs

**`needsDocumentation` vs `isUndocumented` as predicates.** Both stay exactly as
written. The founder rule they encode — a *marked* internal transfer and a
marked processor payout still owe a receipt, so marking a row can never be a way
to stop being chased — is load-bearing and pinned by
`markTransferPayout.test.ts` and `receiptChase.test.ts`. Only the facet's
population and label move. *Cost of keeping:* two similar predicates that a
future reader will keep wanting to merge; `needsDocumentation`'s own doc comment
is what stops them, and it should stay long.

**`needsBudget` as a predicate.** Unchanged, for the dashboards. *Cost:* the
reconcile facet and the dashboard tile will now be computed from the same
function with different gates, which is a drift risk. Mitigate by putting the
gate in `listReconcile`'s `flagsFor`, next to the other facet logic, not in a
new predicate.

**The hidden-transfer-leg rule (#557).** Keep. It removes 9 rows of pure noise
from a 355-row book and the escape hatch (Kind → Transfers) works. *Cost:* the
one class of row a human cannot reach without knowing about a filter — which is
precisely how the broken $1,000 leg stayed invisible.

**Facet counts rather than global counts.** Keep. The reasoning in
`countsTowardFacet` is right: a global count next to a narrowed grid promises
rows the selection can't produce. *Cost:* the numbers in the State dropdown move
when you change Kind, which surprises people the first time. Worth it.

**`toClearCount`.** Keep computing it — it is the honest "open items" figure and
`51 + 76` must equal it. It just stops being the only number in the header.

**The Kind group.** No changes at all.

---

## 6. Sizing

| change | where | size |
| --- | --- | --- |
| Drop the `needs_budget` default | `reconcile.tsx:196` | 1 line |
| Header chips + two roll-up keys | `reconcile.tsx`, `reconcileFilters.ts`, `finances.ts` `flagsFor` | small |
| `needs_budget` facet: open rows only | `finances.ts` `flagsFor` | 1 line + test |
| `undocumented` facet → reconciled-only, relabel | `finances.ts` `flagsFor`, `reconcileFilters.ts` labels | small; 3 tests to update |
| Hide the two coding options until armed | `reconcile.tsx` option build | ~3 lines |
| Fee-budget approval banner | `reconcile.tsx` + a query | small |
| **FC sync `flow` clobber** | `stripeFinance.ts` | **1 condition + test + a data fix** |
| Search ignores the State filter | `reconcile.tsx` / `listReconcile` | small |

The sync fix is the only one that touches money, and it is the one I would ship
first and on its own.

**Academy:** the reconcile lesson names the current state labels. Renaming
"Undocumented" and adding the header chips is a training-worthy change and the
lesson + quiz go in the same PR.
