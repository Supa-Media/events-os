# Finances → Budgets: make the number openable

**Owner:** PM · **Date:** 2026-08-14 · **Repo state:** `ef52332` (main)
**Scope:** the Finances tab's budgeting experience — the `Budgets` tab, the
dashboard's budget tables, and the budget detail page.

## The feedback (verbatim, founder, voice transcript)

> "On the financial tab, that needs to be fixed. One of the biggest things is
> the budgeting section. Budgeting section leaves a lot to be desired. It just
> gives an amount. Doesn't give details. It doesn't give any concrete things.
> For events, you can't even click through to the event, go to the money page
> for a project. You can't even go to where the project details are. We should
> just be able to drop down and see the different expenses per budget. It
> should just be a lot more interactable."

**Diagnosis in one line:** she is describing `/finances/budgets` — the tab
literally labelled **Budgets** in the finance tab bar
(`apps/mobile/app/(app)/finances/_layout.tsx:63`, present in *both* the seat
bar and the member bar, lines 70–87). That screen renders a flat list of
non-interactive cards: name, `$spent of $cap`, room left, a meter. There is not
one `Pressable` on it. Every complaint in the transcript is literally true of
that screen, and only partly true of the surfaces around it.

---

## 1. Current state, honestly

### 1a. `/finances/budgets` — the Budgets tab (the screen she means)

`apps/mobile/app/(app)/finances/budgets.tsx` (125 lines total).

| What it renders | Where |
| --- | --- |
| Title + one paragraph of copy | `budgets.tsx:83-90` |
| Section "Events & projects" → `GlanceCard[]` | `budgets.tsx:100-109` |
| Section "Recurring" → `GlanceCard[]` | `budgets.tsx:110-119` |
| `GlanceCard`: name, `dateLabel`, `$spent of $cap`, `$X left`/`$X over`, `<Meter/>` | `budgets.tsx:40-71` |
| Empty state (`pie-chart`, "No budgets to show yet") | `budgets.tsx:92-98` |
| Loading: full-screen `<Screen loading />` | `budgets.tsx:76` |

`GlanceCard` is a plain `<View>` (`budgets.tsx:44`). **No `onPress`, no
`Pressable`, no `Link`, no chevron, no href anywhere in the file.** Nothing on
this screen navigates. Nothing expands. `/finances/budgets/[id]` — the detail
page that *does* exist — is unreachable from the tab named Budgets; the only
inbound links to it are `finances/index.tsx:226` (dashboard row tap) and
`components/money/MoneyView.tsx:94` ("Open budget" on an event/project page).

Backed by `api.finances.budgetsGlance` (`apps/convex/finances.ts:5300-5390`,
row validator at `5254-5266`). It returns exactly nine fields per row:
`id, name, dateLabel, type, cadence, capCents, spentCents, remainingCents, pct,
status`. It does **not** return `refKind`, `scopeRefId`, `approvalStatus`,
`categories`, or anything transaction-shaped — so today the screen *could not*
deep-link even if the UI wanted to. The `id` is returned and thrown away.

Other true-today limits of this screen:
- Current Eastern year only, hard-coded (`finances.ts:5309`, `5321`). No year picker.
- Caller's own chapter only (`readChapterId`, `finances.ts:5311` / `2044-2049`).
  A central seat holder sees their home chapter's budgets here, never central's.
- Approved-cap budgets only (`finances.ts:5345`) — a Draft or Awaiting-approval
  budget is invisible on this tab with no explanation.
- Zero-cap zero-spend rows hidden (`finances.ts:5355`).

### 1b. `/finances` dashboard → `BudgetTableGroup` (chapter desk)

`apps/mobile/components/finance/dashboard/BudgetTable.tsx` (515 lines),
fed by `ChapterView.tsx:257-294` (`oneTimeRows`, `recurringRows`) and rendered
at `ChapterView.tsx:371-393`.

This surface is genuinely much richer than the Budgets tab, and it's the reason
the founder's complaint is *half* wrong:

- Row: status dot, name + chip, meta line, 56px meter, `$spent / $cap`, `%` or
  `OverChip` (`BudgetTable.tsx:313-341`).
- Row body tap → `/finances/budgets/[id]` (`finances/index.tsx:224-227`).
- **An `external-link` icon** on rows with a live ref → `/event/[id]` or
  `/project/[id]` (`BudgetTable.tsx:358-371`; handler `ChapterView.tsx:244-247`).
- Chevron tap → expands **category mini-bars** in place (`BudgetTable.tsx:395-432`).
- Each category bar has its *own* chevron → lazily mounts `TransactionList`
  (`BudgetTable.tsx:502-512`), which lists real transactions with date,
  description, person, receipt tick, amount (`TransactionList.tsx:110-137`).
- A transaction tap → `TransactionDetailModal` (`ChapterView.tsx:438-444`),
  which itself carries a "Part of: `<name>` ›" deep link
  (`TransactionDetailModal.tsx:441-457`).
- Awaiting-approval rows pin to top with inline Approve / Request changes
  (`BudgetTable.tsx:434-438`).

So expenses per budget **are** reachable on the dashboard — but only after
*two* chevron taps through a category you have to guess at, and the affordance
is a bare chevron with no label. There is no "show me everything charged here."

Three real defects in this path:
1. **Dead chevron.** `expanded && (hasCategories || openRef)`
   (`BudgetTable.tsx:395`) — a budget with no spend yet expands to *nothing*.
   The chevron animates and produces empty space.
2. **The drill-down doesn't sum to the bar it drills into (one-time budgets).**
   A one-time card's `categories` are computed by `oneTimeCardBreakdown`
   (`finances.ts:2696-2706`) over the whole loaded **year**, deliberately not
   month-narrowed. But the drill-down period passed down is
   `{ year, month: period === "month" ? month : undefined }`
   (`ChapterView.tsx:236`). In Month mode the bar says the year's total and the
   expanded list shows one month's rows. This is exactly the "PR #231 lesson"
   `dashboardCharts.ts:728` warns about, unfixed for the one-time table.
3. **Three answers to "what has this budget spent."** `budgetsGlance` and
   `oneTimeCardBreakdown` both sum the *loaded year's* transactions;
   `budgetDetail.getBudgetDetail` reads `by_budget` with **no year filter** at
   all (`budgetDetail.ts:221-235`, and its module doc at lines 16–23 says so).
   A budget with spend in a prior year reports a smaller number on the
   dashboard/Budgets tab than on its own detail page.

### 1c. `/finances` dashboard → `CentralView` budget table

`apps/mobile/components/finance/dashboard/CentralView.tsx:167-193`, rendered at
`338-353`. Same component, deliberately degraded:
- `refKind`/`scopeRefId` are **never** set on central rows, and `onOpenRef` is
  not wired — documented at `CentralView.tsx:149-156` and
  `BudgetTable.tsx:152-161`: `/event/[id]` and `/project/[id]` are hard-scoped
  to the caller's own chapter via `requireOwned`, so a central budget whose ref
  lives in another chapter has no safe link today. This is a genuine unsolved
  problem, not an oversight.
- **Inconsistency:** central row body tap opens `BudgetCreateModal` directly
  (`finances/index.tsx:232-234`), while a chapter row tap opens the detail page
  (`finances/index.tsx:224-227`). Two desks, two different meanings for the
  same gesture.

### 1d. `/finances/budgets/[id]` — the budget detail page

`apps/mobile/app/(app)/finances/budgets/[id].tsx` (335 lines). This shipped
2026-08-12 in #680 in response to earlier founder feedback, and it is good:
header + approval chip + Edit, share-URL copy, cap-vs-actual card with
`BudgetBar`, an **embedded `MoneyView`** for ref-linked budgets
(`[id].tsx:214-221`) giving planned-vs-actual by category / unallocated /
unplanned / income / net, `PlanGrid` for recurring budgets, the full linked
transaction list, and `ApprovalHistory`.

Remaining gaps on this page:
- **Transactions are inert.** `TxnRowView` (`[id].tsx:306-335`) is a plain
  `<View>`. The one screen dedicated to a budget has a list of its charges that
  cannot be tapped, while the *dashboard*'s two-chevrons-deep version can.
- The "Open event/project" link (`[id].tsx:291-304`) pushes
  `/${refKind}/${scopeRefId}` — for an event that lands on the **plan
  overview**, not the Money tab. Literally the founder's "go to the money page
  for a project" complaint: the link exists, it just doesn't go to money.
- The list is capped at 200 (`budgetDetail.ts:100`) with no paging and no
  "view the rest in the Book" escape hatch (the dashboard drill-down *does*
  have one — `TransactionList.tsx:138-149`).
- No grouping/sorting control; fixed newest-first (`budgetDetail.ts:255`).
- No committed / encumbered figure.

### 1e. Backend data that already exists and is NOT surfaced (the cheap wins)

This is the most important section of this document.

| Already in the backend | Where | Not surfaced where |
| --- | --- | --- |
| `dashboardCharts.budgetTransactions` accepts **no category** — `categoryName` and `categoryId` are both optional (`dashboardCharts.ts:771-783`). Omit them and you get **every** spend row for the budget in the period. | `dashboardCharts.ts:771` | Nothing calls it that way. `TransactionList` always passes a `categoryName` (`TransactionList.tsx:78-84`). A one-tap "all expenses for this budget" list is a *client-only* change. |
| `budgetTransactions` rows already carry `merchantNameOverride`, `categoryId`, `personId`, `personName`, `hasReceipt`, `status`, `isPersonal`, `note` (`dashboardCharts.ts:675-706`). | | `TransactionList.tsx:110-137` renders 5 of the 13 fields. |
| `budgets.refKind` / `budgets.scopeRefId` + `resolveBudgetRef` (`finances.ts:1988`) | schema `apps/convex/schema/finances.ts:148-156` | Not returned by `budgetsGlance` at all (`finances.ts:5254-5266`). |
| `budgets` approval workflow fields (`approvalStatus`, `approvedCents`, `reviewNote`, `approvalParty`) + `budgetApprovalLog` | `schema/finances.ts:174-264` | Not returned by `budgetsGlance`. The Budgets tab can't say "this is awaiting approval". |
| `budgetLines` (the planned lines: `description`, `categoryId`, `plannedCents`) and `budgetLines.budgetPlanSummary` (`totalCents`/`plannedCents`/`remainingCents`/`overPlanned`/`lineCount`) | `budgetLines.ts:206-238`, schema `313-323` | Never read on the Budgets tab or the dashboard rows. |
| `moneyViews.refMoney` — planned vs actual by category, `unplannedCents`, `unallocatedPlannedCents`, `incomeCents`, `totalRemainingCents` | `moneyViews.ts:532-612` | Only on `/event/[id]?tab=money`, `/project/[id]`, and the embedded copy on the budget detail page. |
| `transactionCodings.status` (`submitted` / `changes_requested` / `approved`) via `codingForTransaction` | `lib/transactionCoding.ts:91-99`, `packages/shared/src/finance.ts:786-800` | No budget surface shows whether a charge is substantiated. |
| `reimbursementRequests` carry `eventId` / `projectId` / `budgetId` and a status ladder including `preapproved`, `approved`, `paying` (`schema/finances.ts:845-856`, `finance.ts:1369-1388`) | | Nothing anywhere computes "committed but not yet spent." |
| Paid `engagements` with `paymentStatus !== "paid"` are already priced into the plan grid as committed-but-unpaid (`moneyViews.ts:449-478`) | | Never rolled up into a budget's headline number. |
| `dashboardCharts.spendByMonth` returns `canRecordTransactions` | `ChapterView.tsx:255` | The budget detail page has no equivalent, so it can't offer edit controls. |

**Bottom line: the single biggest visible win — a budget row that drops down to
its actual expenses — needs zero new backend on the dashboard, and one new
query on the Budgets tab (only because that tab's totals are lifetime, not
year-scoped, and re-using the year-scoped query would violate the house rule
that a drill-down must sum to the number it drills into).**

---

## 2. Gap list, ranked

Ranked by (founder pain) × (users affected) × (1 / cost).

| # | Gap | Founder quote it answers | Files |
| --- | --- | --- | --- |
| **G1** | The Budgets tab is 100% non-interactive: no tap target, no drop-down, no link. | "just gives an amount… should be a lot more interactable" | `budgets.tsx:40-71` |
| **G2** | No way to see the expenses behind a budget's number in one gesture, anywhere. Dashboard needs 2 chevrons + a category guess; Budgets tab offers nothing. | "should just be able to drop down and see the different expenses per budget" | `BudgetTable.tsx:395-432,458-515`, `budgets.tsx` |
| **G3** | Budgets tab can't reach the event/project at all — `budgetsGlance` doesn't return the ref. | "you can't even click through to the event… you can't even go to where the project details are" | `finances.ts:5254-5266` |
| **G4** | Where a ref link *does* exist, it lands on the plan overview, not money. | "go to the money page for a project" | `budgets/[id].tsx:295`, `ChapterView.tsx:247` |
| **G5** | Project has no addressable money view — `/project/[id]` renders Money as an inline section with no `?tab=`/anchor, unlike `/event/[id]?tab=money`. | "the money page for a project" | `project/[id].tsx:172-198`, `event/[id].tsx:339,799` |
| **G6** | Budget detail page's transaction rows are inert. | "doesn't give any concrete things" | `budgets/[id].tsx:306-335` |
| **G7** | No committed/encumbered figure anywhere. "Room left" overstates reality whenever an approved reimbursement or an unpaid vendor is outstanding. | "doesn't give details" | new |
| **G8** | Dead chevron: a zero-spend budget expands to empty space. | "more interactable" | `BudgetTable.tsx:395` |
| **G9** | One-time drill-down period ≠ the bar's period in Month mode. | correctness | `ChapterView.tsx:236` vs `finances.ts:2696` |
| **G10** | Three different "spent" answers (year-scoped ×2, lifetime ×1). | correctness | `finances.ts:5347`, `2704`, `budgetDetail.ts:234` |
| **G11** | Budgets tab hides Draft / Awaiting-approval budgets with no explanation; no approval state shown at all. | "doesn't give details" | `finances.ts:5345` |
| **G12** | Central desk: row tap opens the edit modal, chapter desk opens the detail page. | consistency | `finances/index.tsx:224-234` |
| **G13** | Budgets tab is current-year, own-chapter only, with no controls to change either. | "leaves a lot to be desired" | `finances.ts:5309,5311,5321` |
| **G14** | Central budget rows can never link to their ref (`requireOwned` scoping). Real constraint, currently un-messaged — the icon is simply absent. | "you can't even click through" | `CentralView.tsx:149-156` |
| **G15** | Planned lines (`budgetLines`) are invisible outside the detail page / PlanGrid — a budget row can't say "planned $X across N lines." | "doesn't give details" | `budgetLines.ts:206` |

---

## 3. The spec

### 3.0 Product principle

> **A budget number is never a dead end.** Every dollar figure on a budget
> surface either expands in place into the rows that make it up, or links to
> the screen that owns it. One gesture, not two.

### 3.1 The Budgets tab (`/finances/budgets`) — rebuilt as an accordion

The tab keeps its identity: "what's been spent and how much room is left, per
budget, readable by every team member." It stops being a poster.

#### Collapsed row (the default)

Replaces `GlanceCard`. Dense row, same visual language as `BudgetTable`'s rows
so the two surfaces read as one system:

```
● │ Worship With Strangers     [Event]  AUG 23    ▓▓▓▓▓░░░  $1,240 / $2,000   62%  ▾
  │ 14 expenses · $310 committed
```

- Status dot — `<MeterDot pct/>` (`Meter.tsx:42`).
- Name, then a `<Chip/>` (`parts.tsx:256`) for `Event` / `Project` / `Monthly` /
  `Quarterly` / `Yearly`, then `dateLabel`.
- `<Meter pct size="sm"/>`, `$spent / $cap`, `%` (or `<OverChip/>` past 100).
- Second line (new): `N expenses` and, when non-zero, `$X committed`.
- Trailing chevron. **Always live** — see empty states below; it never expands
  into nothing (fixes G8).
- An `approvalStatus !== "approved"` row shows `<BudgetApprovalChip/>`
  (`BudgetApprovalActions.tsx:54`) and uses the pinned amber treatment
  `BudgetTable.tsx:388` already defines (fixes G11).

#### Expanded row — one tap, three blocks

**Block A — the money, spelled out.** A three-up figure strip:

| Spent | Committed | Left |
| --- | --- | --- |
| `$1,240` | `$310` | `$450` |

plus a **segmented** bar: solid = spent, 50%-opacity = committed, track =
available. Over-budget: whole bar `danger`, the third figure flips to
`$X over` in `text-danger` (mirrors `budgets.tsx:60-66`'s existing wording so
nobody has to relearn it). Below it, when the budget has planned lines:
`Planned $1,800 across 6 lines` (from `budgetLines.budgetPlanSummary`).

**Block B — deep links.** A row of text links, only those that resolve:

| Link label | href | Exists today? |
| --- | --- | --- |
| `Open event ›` | `/event/{scopeRefId}` | ✅ `app/(app)/event/[id].tsx` |
| `Event money ›` | `/event/{scopeRefId}?tab=money` | ✅ `event/[id].tsx:339` parses `tab=money`; **hidden when `event.isTraining === true`** (same invariant as `event/[id].tsx:334-340`) |
| `Open project ›` | `/project/{scopeRefId}` | ✅ `app/(app)/project/[id].tsx` |
| `Project money ›` | `/project/{scopeRefId}?section=money` | ❌ **NEW WORK** — `/project/[id]` renders Money as an inline `<SectionHeader title="Money">` at `project/[id].tsx:172-198` with no param and no anchor. Needs a `?section=` param + scroll-to. |
| `Budget page ›` | `/finances/budgets/{id}` | ✅ `app/(app)/finances/budgets/[id].tsx` |
| `See in the Book ›` | `/finances/reconcile?filter=all` | ✅ (route + `?filter=` used at `finances/index.tsx:213`) — shown only to a caller with the Book tab |

Rules: no link is rendered when `refLive === false` (the ref was deleted) —
same guard `budgets/[id].tsx:161-163` already applies. `Open event`/`Event
money` are suppressed while peeking another chapter, matching
`ChapterView.tsx:244-247`'s documented `requireOwned` constraint.

**Block C — the expenses.** This is the thing she asked for.

- Header: a segmented control — **`Recent` · `By category` · `By person`** —
  default **`Recent`**.
- `Recent`: flat, `postedAt` **descending**. One line per transaction.
- `By category`: groups sorted by group total **descending** (matching
  `spendBreakdownFor`'s own ordering, `finances.ts:2597`), rows inside each
  group newest-first, each group header showing `name · $total` and a
  `<MiniBar/>`. Groups collapsed past the first three.
- `By person`: same, grouped on `personName` with an `Unassigned` bucket.
- **Per line:** `MMM D` · merchant (resolved through `displayMerchantName`, so
  a bookkeeper's rename wins — the rule `dashboardCharts.ts:684-689` already
  states) · person · category chip · receipt state · amount.
- **Receipt state** is a three-state indicator, not a tick:
  `check-circle` success = receipt attached; `alert-circle` warn = missing and
  chased (`reminderStage !== "none"`); nothing = missing, un-chased. Plus a
  small `Coding: awaiting review / changes requested` badge when
  `codingStatus !== "approved"` and the viewer is finance-gated.
- **Tap → `TransactionDetailModal`** with `source = { kind: "detail", txn,
  budgetName, refKind, scopeRefId }` (`TransactionDetailModal.tsx:100-110`) and
  `canRecordTransactions` from the new query. This reuses the modal that
  already exists; it is read-only for a viewer and for a peeking caller
  (`TransactionDetailModal.tsx:171-174`), so nothing widens.
- **Truncation:** at 100 rows, footer `N more — see in the Book ›` →
  `/finances/reconcile`, mirroring `TransactionList.tsx:138-149` verbatim.

#### States

| State | Treatment |
| --- | --- |
| Screen loading | Keep `<Screen loading/>` for first paint (`budgets.tsx:76`). |
| Row expanding | Inline `Loading expenses…` line inside the expanded block — never a screen-level spinner. Query is mounted **only while expanded** (the "skip until expanded" rule `TransactionList.tsx:20-24` documents). |
| Budget with zero spend | Block C renders `No spend against this budget yet.` plus, when planned lines exist, the plan lines as a preview. Blocks A + B still render. **The chevron is never a no-op.** |
| No budgets at all | Keep today's `EmptyState` (`budgets.tsx:92-98`) but add a line: "Budgets appear here once they're approved. A draft budget lives on its event or project page." (fixes the silent-hiding half of G11.) |
| Ref deleted (`refLive === false`) | Block B renders no ref links; the name falls back to `budget.label` (already `resolveBudgetRef`'s behavior). |
| **Caller lacks spend detail** (see 3.4) | Blocks A + B render in full. Block C renders **category mini-bars only** (aggregate, no person, no merchant) with a footer line: *"Line-by-line detail needs finance access — ask a finance manager."* Never a permission wall, never a dead chevron. |
| Peeking another chapter | Ref links suppressed (see Block B rules); expenses list still read-only-viewable, matching the dashboard's existing behavior. |

### 3.2 The dashboard's `BudgetTable` — an "All expenses" first row

Minimal, high-value change to `BudgetTable.tsx`'s expanded block
(`BudgetTable.tsx:395-432`):

1. Insert an **"All expenses · $total"** pseudo-row above the category bars,
   with its own chevron, mounting `<TransactionList/>` with **`categoryName`
   omitted** — `dashboardCharts.budgetTransactions` already supports this
   (`dashboardCharts.ts:775-777`, both category args optional). Zero backend
   change.
2. Change the expand guard from `expanded && (hasCategories || openRef)` to
   `expanded` — the block now always has content (fixes G8).
3. Rename the chevron's `accessibilityLabel` from `"Expand categories"` to
   `"Show expenses"` (`BudgetTable.tsx:376`).
4. **Fix G9:** the one-time table's `drilldownPeriod` must equal the period its
   bars were computed over. `oneTimeCardBreakdown` (`finances.ts:2696-2706`)
   never narrows to a month, so `ChapterView.tsx:236` must pass
   `{ year, month: undefined, rangeNote: period === "month" ? "this year" : undefined }`
   for the **one-time** group specifically (the recurring group's per-row
   `drilldownPeriod` at `ChapterView.tsx:292` is already correct and stays).

### 3.3 The budget detail page (`/finances/budgets/[id]`)

1. **Make transactions tappable** (G6). `TxnRowView` (`[id].tsx:306-335`)
   becomes a `Pressable` opening `TransactionDetailModal` in `kind: "detail"`
   mode. This requires widening `budgetDetail.ts`'s `txnRow` validator
   (`budgetDetail.ts:86-97`) to be a superset of `dashboardCharts.ts`'s
   `budgetTxnRow` (`dashboardCharts.ts:675-706`) — it must gain
   `merchantNameOverride`, `categoryId`, `isPersonal`, `note`. All four are
   plain reads off the doc; no new scan.
2. `getBudgetDetail` gains `canRecordTransactions: v.boolean()` —
   `financeRoleAtLeast(access.role, "bookkeeper")`, using the `FinanceAccess`
   it already resolves at `budgetDetail.ts:155-166`.
3. **Ref links go to money** (G4): `RefLink` (`[id].tsx:291-304`) becomes two
   links — `Open event` → `/event/{id}`, `Event money` → `/event/{id}?tab=money`
   (project equivalents once 3.5 lands).
4. Reuse the same `Recent · By category · By person` control from 3.1 Block C
   over the already-fetched `detail.transactions`, and add the
   `N more — see in the Book ›` footer when
   `transactionTotalCount > transactions.length` (today it only says the count,
   `[id].tsx:250-254`).

### 3.4 Permissions — gate it behind a power, per `CLAUDE.md`

Two distinct reads with two distinct audiences; today one is membership-gated
and the other is finance-viewer-gated, and both checks are inline.

**New file: `apps/convex/lib/budgetsAccess.ts`** — the domain resolver pair the
house rule requires. No call site checks seats inline.

```ts
/** Who may see the chapter's budget headline figures (name, cap, spend,
 *  room left, approval state). TODAY: any member of the chapter — the
 *  deliberate posture `finances.budgetsGlance` already documents
 *  (finances.ts:5273-5280). Will graduate to the `finance.budgets.view`
 *  capability string when the org wants to restrict it. */
export async function hasBudgetGlance(ctx: QueryCtx, chapterId: Id<"chapters">): Promise<boolean>
export async function requireBudgetGlance(ctx: QueryCtx, chapterId: Id<"chapters">): Promise<void>

/** Who may see the LINE-LEVEL expenses behind those figures — merchant, who
 *  spent it, receipt state, coding state. TODAY: `financeRoleAtLeast(role,
 *  "viewer")` at the budget's own chapter, or central reach through the
 *  caller's home chapter — the identical gate `budgetDetail.getBudgetDetail`
 *  (budgetDetail.ts:150-166) and `dashboardCharts.budgetTransactions`
 *  (dashboardCharts.ts:794-805) already apply inline. Will graduate to
 *  `finance.view` (POWERS, powers.ts:186). */
export async function hasBudgetSpendDetail(ctx: QueryCtx, budget: Doc<"budgets">): Promise<boolean>
export async function requireBudgetSpendDetail(ctx: QueryCtx, budget: Doc<"budgets">): Promise<FinanceAccess>
```

`budgetDetail.getBudgetDetail` and `dashboardCharts.budgetTransactions` are
refactored to call `requireBudgetSpendDetail` instead of their two hand-copied
copies of the same 12 lines — one behavior, one file, per the precedents named
in `CLAUDE.md` (`lib/givingAccess.ts`, `lib/campaignsAccess.ts`).

**No new capability string ships in P0** — the resolver bodies are the checks
that exist today. That means no `SEAT_CAPABILITIES` change, no
`packages/shared/src/seats.ts` change, and therefore no `academyPaths.ts`
change (see §5).

### 3.5 New / changed Convex functions

#### (a) `finances.budgetsGlance` — widen the row (changed)

`apps/convex/finances.ts:5254-5390`. Args unchanged (`{}`). `glanceBudgetRow`
gains:

```ts
refKind: v.union(refKindValidator, v.null()),        // from effectiveRefKind(b)
scopeRefId: v.union(v.string(), v.null()),
refLive: v.boolean(),                                 // ref doc still resolves
isTraining: v.boolean(),                              // event refs only; gates the money link
approvalStatus: approvalStatusValidator,              // effectiveBudgetApprovalStatus(b.approvalStatus)
approvedCents: v.union(v.number(), v.null()),
requestedCents: v.number(),                           // b.amountCents
committedCents: v.number(),                           // see (c)
transactionCount: v.number(),
plannedCents: v.number(),                             // Σ budgetLines.plannedCents
plannedLineCount: v.number(),
canSeeSpendLines: v.boolean(),                        // hasBudgetSpendDetail(ctx, b)
```

`resolveBudgetRef` (`finances.ts:1988`) already resolves `name`/`dateLabel`/
`refDate` from the ref doc, so `refLive`/`isTraining` are free at that call
site (`finances.ts:5357`). `plannedCents` costs one `by_budget` read per budget
(the same shape `loadCrossBookTxnsForChapterBudgets` at `finances.ts:1159`
already does).

Also (fixes G11's silent hiding): add a top-level
`hiddenPendingCount: v.number()` — how many budgets were skipped by the
`isAttributableBudget` filter at `finances.ts:5345` — so the screen can say
"3 budgets are still awaiting approval" instead of silently omitting them.

#### (b) `budgetDetail.budgetSpendLines` — NEW

Lives in `apps/convex/budgetDetail.ts` (same file as `getBudgetDetail`, same
imported primitives — that file's module doc already explains why it's a
sibling of `finances.ts` rather than an addition to it).

```ts
export const budgetSpendLines = query({
  args: {
    budgetId: v.id("budgets"),
    groupBy: v.optional(v.union(v.literal("none"), v.literal("category"), v.literal("person"))),
    limit: v.optional(v.number()),           // default 100, hard cap 200
  },
  returns: v.object({
    // The period these lines cover, so the client can label it honestly.
    scope: v.union(v.literal("lifetime"), v.literal("cadence_window")),
    scopeLabel: v.union(v.string(), v.null()),   // "this month" / "this quarter" / "this year" / null
    totalCents: v.number(),                       // MUST equal budgetsGlance.spentCents for this budget
    totalCount: v.number(),
    groups: v.array(v.object({
      key: v.string(),                            // "" for groupBy "none"
      label: v.string(),                          // category / person name, or ""
      totalCents: v.number(),
      rows: v.array(budgetSpendLineRow),          // superset of dashboardCharts#budgetTxnRow
    })),
  }),
});
```

`budgetSpendLineRow` = `dashboardCharts.ts`'s `budgetTxnRow`
(`dashboardCharts.ts:675-706`) **plus**:

```ts
// `tr.receiptReminderStage ?? "none"` — the exact derivation
// `finances.ts:1030` and `moneyViews.ts:244` already use.
reminderStage: v.union(v.literal("none"), v.literal("flagged"), v.literal("escalated")),
// `(await codingForTransaction(ctx, tr._id))?.status ?? null`
// (`lib/transactionCoding.ts:91-99`; statuses `shared/src/finance.ts:786-790`).
codingStatus: v.union(v.literal("submitted"), v.literal("changes_requested"),
                      v.literal("approved"), v.null()),
```

**Period rule (non-negotiable):** this query must apply the *same* rule
`budgetsGlance` applies, or the drill-down won't sum to the number it drills
into — the house rule at `dashboardCharts.ts:726-733`. That is:
`effectiveType(b) === "one_time"` → lifetime (`budgetId` link + `isSpend`, no
period filter), `recurring` → the current cadence window via
`txnCountsTowardBudget` (`finances.ts:1739`). `scope`/`scopeLabel` in the
return exist so the UI can *say which*. This is precisely why the existing
year-scoped `dashboardCharts.budgetTransactions` cannot be reused here.

**Gate:** `requireBudgetSpendDetail(ctx, budget)`.

**Bound:** one `by_budget` `.take(ROLLUP_SCAN_LIMIT)` (the shape
`budgetDetail.ts:221-224` already uses), then sort + slice. Person names via the
same `personCache`/`cardCache` read-through `budgetDetail.ts:259-277` already
implements — extract it to a helper in that file and share it.

#### (c) `committedCents` — a new shared helper, NOT a new table

`apps/convex/lib/budgetCommitments.ts` (new):

```ts
/** Money a budget is on the hook for but hasn't paid yet — never summed with
 *  actuals (INVARIANT: estimated money is never summed with actual money,
 *  finances.ts:26), always displayed as its own segment. */
export async function committedCentsForBudget(ctx: QueryCtx, b: Doc<"budgets">): Promise<number>
```

Sums, mode-filtered:
- `reimbursementRequests` targeting this budget (via `budgetId`, or via
  `eventId`/`projectId` matching `b.scopeRefId`) with `status ∈ {preapproved,
  submitted, approved, paying}` — `approvedCents ?? totalCents`.
  (`schema/finances.ts:845-856`; statuses `packages/shared/src/finance.ts:1369-1388`.)
- For an event ref: paid `engagements` with `paymentStatus !== "paid"`,
  `dollarsToCents(amountUsd)` — the same rows `moneyViews.ts:449-478` already
  prices as committed-but-unpaid.

Consumed by `budgetsGlance`, `getBudgetDetail`, and (P1) the dashboard cards.

#### (d) Nothing new needed for the dashboard's "All expenses" row

`dashboardCharts.budgetTransactions` already answers it with both category args
omitted (`dashboardCharts.ts:771-783`). Client change only.

### 3.6 Route work

| Route | Status | Action |
| --- | --- | --- |
| `/finances/budgets` | exists | rebuilt (3.1) |
| `/finances/budgets/[id]` | exists | extended (3.3) |
| `/event/[id]` | exists | none |
| `/event/[id]?tab=money` | **exists** (`event/[id].tsx:339`) | become the default "money" target; respect `isTraining` |
| `/project/[id]` | exists | none |
| `/project/[id]?section=money` | **does not exist** | **NEW (P1, S):** accept a `section` param in `project/[id].tsx`, `scrollTo` the Money `<SectionHeader>` (`project/[id].tsx:172-198`). Mirrors the `?tab=` convention `event/[id].tsx` already uses. |
| `/finances/reconcile?filter=…` | exists | reused as the truncation escape hatch |

---

## 4. Prioritized roadmap

### P0 — "The Budgets tab drops down" · one PR

Ships the founder's literal ask. Sized **L** overall.

| Item | Size | Files |
| --- | --- | --- |
| `lib/budgetsAccess.ts` + refactor the two inline gates onto it | S | `apps/convex/lib/budgetsAccess.ts` (new), `apps/convex/budgetDetail.ts:150-166`, `apps/convex/dashboardCharts.ts:794-805` |
| `lib/budgetCommitments.ts` (`committedCentsForBudget`) | S | new |
| Widen `finances.budgetsGlance` (§3.5a) incl. `hiddenPendingCount` | M | `apps/convex/finances.ts:5249-5390` |
| New `budgetDetail.budgetSpendLines` (§3.5b) | M | `apps/convex/budgetDetail.ts` |
| Rebuild `/finances/budgets` as the accordion (§3.1) | L | `apps/mobile/app/(app)/finances/budgets.tsx`; new `apps/mobile/components/finance/budgets/BudgetGlanceRow.tsx`, `BudgetSpendLines.tsx` |
| Dashboard: "All expenses" row + live chevron + `accessibilityLabel` (§3.2 items 1–3) | S | `apps/mobile/components/finance/dashboard/BudgetTable.tsx:372-432` |
| Fix the one-time drill-down period (§3.2 item 4, G9) | S | `apps/mobile/components/finance/dashboard/ChapterView.tsx:236,371-381` |
| Academy: update the two lessons named in §5 | S | `packages/shared/src/academy/streams/finances.ts` |
| Tests | M | `budgetSpendLines` sums == `budgetsGlance.spentCents` (the anti-drift assert); grouping/sort pure helpers get their own `*.test.ts` next to the component, matching `rowOrdering.test.ts` |

Deliberately **out** of P0: no new capability string, no seat change, no schema
change, no route added.

### P1 — "Every number links to its owner"

| Item | Size | Files |
| --- | --- | --- |
| Budget detail page: tappable transactions + `canRecordTransactions` + widened `txnRow` (§3.3.1–2, G6) | M | `apps/convex/budgetDetail.ts:86-97,143-322`, `apps/mobile/app/(app)/finances/budgets/[id].tsx:246-335` |
| `?section=money` on `/project/[id]` (G5) | S | `apps/mobile/app/(app)/project/[id].tsx:172-198` |
| Point every ref link at money, not the plan overview (G4) | S | `budgets/[id].tsx:291-304`, `ChapterView.tsx:244-247`, new glance row |
| Committed segment on dashboard cards + detail page (G7) | M | `apps/convex/finances.ts` (`projectBudgetCard`/`recurringBudgetCard` at `665-722`), `BudgetTable.tsx`, `budgets/[id].tsx` |
| Reconcile the three "spent" answers (G10) — pick lifetime for one-time everywhere, document it once | M | `apps/convex/finances.ts:2696,5347`, `apps/convex/budgetDetail.ts:234` |
| Central desk: row tap → detail page, not the edit modal (G12) | S | `apps/mobile/app/(app)/finances/index.tsx:232-234` |
| Group/sort control + truncation footer on the detail page (§3.3.4) | S | `budgets/[id].tsx:246-269` |

### P2 — "The budget page you'd send someone"

| Item | Size | Files |
| --- | --- | --- |
| Year picker + central-scope toggle on the Budgets tab (G13) | M | `budgets.tsx`, `finances.budgetsGlance` args |
| Message the central→ref link constraint instead of hiding it (G14): a disabled `external-link` with a tooltip "This event belongs to another chapter" | S | `CentralView.tsx:149-193`, `BudgetTable.tsx:358-371` |
| Planned lines rendered inside the expanded row for zero-spend budgets (G15) | M | new glance row + `budgetLines.listLines` |
| Per-category **planned vs actual** for recurring budgets (today only ref-linked budgets get it, via the embedded `MoneyView`) | L | `moneyViews.ts`, `budgets/[id].tsx:222-244` |
| Budget owner ("who do I text before I swipe") — see open question Q4 | M | schema + `finances.ts` |
| CSV export of a budget's spend lines | S | `apps/convex/dataExports.ts` |

---

## 5. Academy impact

`CLAUDE.md`'s rule applies: this changes user-facing behavior *and* vocabulary,
so the Academy must move with it. It does **not** change seats, roles, money
rules, or org process, so `packages/shared/src/academyPaths.ts` and
`packages/shared/src/seats.ts` are untouched.

**Must update in P0:**

1. `packages/shared/src/academy/streams/finances.ts:434` — **`finance-three-tracks`**
   ("Before you spend: three tracks"). Line **451** currently reads:
   > "**Is there enough left in it?** … Open it and look; the app knows."

   This is the single most-affected sentence in the whole catalog: it tells
   every volunteer to go look, and today the place it sends them shows a number
   and nothing else. It must name the surface and the gesture: *Finances →
   Budgets, tap the budget to drop it open and see every charge already against
   it.* Its quiz at `560-570` ("Budget, room, track — in that order") stays
   valid.

2. `packages/shared/src/academy/streams/finances.ts:2758` —
   **`finance-budget-lifecycle`**. It teaches where a budget lives and how to
   reach it ("tap **Add budget** on the event or project's own page"). With the
   Budgets tab becoming a real destination that shows approval state
   (`hiddenPendingCount`, the approval chip), add a clause: a Draft budget is
   *not* on the Budgets tab, and the tab now says how many are waiting.

**Check, likely update in P1:**

3. `packages/shared/src/academy/streams/finances.ts:1971` —
   **`finance-approving-budgets`**. Two separate issues: (a) it says approve /
   request-changes happen "straight from that same card," which stays true of
   the dashboard but should mention the budget page; (b) **pre-existing drift**:
   it says the button is **"Submit for approval"** twice (lines ~1988, ~1998)
   while the actual control reads **"Send for review"**
   (`BudgetApprovalActions.tsx:112`) — and `finance-budget-lifecycle` already
   uses the correct wording. Fix in whichever PR touches this lesson.

4. `packages/shared/src/academy/streams/finances.ts:2515` —
   **`finance-central-budgets`** — only if P2's central-scope toggle ships.

5. `packages/shared/src/academy/streams/finances.ts:2966` —
   **`finances-for-everyone`** course description mentions "getting your budget
   approved"; re-read once the tab shows approval state.

**Not affected:** `apps/convex/lib/seed/templates.ts` — its only budget
references (`:334`, `:1143`) are about setting a budget on an event, not about
the Finances Budgets tab. `packages/shared/src/academyPaths.ts` — no seat or
capability change in P0/P1. Run the academy integrity tests regardless; they
catch structural drift but not a lesson that now teaches the wrong thing, which
is why items 1–2 are hand-listed above.

---

## 6. Risks and open questions for the founder

**Q1 — Should a cardholder with no finance seat see line-level expenses?**
This is the one real policy decision in the spec. `budgetsGlance` is
*deliberately* the only ungated finance read (`finances.ts:5273-5280`) — it
gives the whole team spend-vs-cap so nobody has to ask the FM before swiping.
Line detail is different: it exposes *who* spent, *at what merchant*, and
whether they've turned in a receipt. This spec defaults to **gated**
(finance-viewer+), with an honest "needs finance access" line rather than a
wall. Flipping it to open later is a one-line change in
`lib/budgetsAccess.ts#hasBudgetSpendDetail` and nothing else — which is exactly
why it's behind a named resolver. **Decision needed before P0 merges.**

**Q2 — Lifetime or this-year?** Three surfaces currently disagree (G10). The
budget detail page says lifetime; the dashboard and the Budgets tab say
this-year. For an event budget these are the same number 99% of the time and
wildly different for a multi-year project. This spec assumes **lifetime for
one-time budgets, cadence-window for recurring** — the rule `budgetDetail.ts`'s
module doc already argues for — and proposes fixing the other two to match in
P1. Confirm that's the answer you want, because it will change some numbers on
screen the day it ships.

**Q3 — Is "committed" a number you'll trust?** `committedCents` is assembled
from approved-but-unpaid reimbursements and unpaid vendor engagements. It is
*good* data but it is not the whole picture — a verbal promise to a vendor isn't
in the system. Showing a "Left after commitments" figure that's occasionally
optimistic may be worse than not showing one. Options: (a) ship it as its own
labelled segment (this spec's default), (b) ship it only on the detail page,
(c) skip it. **P1 decision.**

**Q4 — Who owns a budget?** `finance-three-tracks` teaches "every event and
project has one person who owns its budget — tell them before you spend"
(`finances.ts:509`). There is **no owner field on `budgets`** in the schema
(`apps/convex/schema/finances.ts:136-231`) — only `createdBy`, `submittedBy`,
`approvedBy`. So the app teaches a rule it can't answer. Do you want a real
`ownerPersonId` on budgets (P2, M) so the expanded row can show "Ask Sarah",
or should the Academy be softened to "the event's lead"?

**Q5 — Central budgets and their refs.** A central budget's linked event can
live in any chapter, and `/event/[id]` is hard-scoped to the caller's own
chapter via `requireOwned` — so central rows genuinely cannot link out today
(`CentralView.tsx:149-156`). Options: (a) leave it, message it (P2 default),
(b) build a central-reach read path for event/project detail — a real piece of
work touching a foundational primitive, not a budgets-tab change. Which?

**Q6 — Risk: the Budgets tab is the one screen every volunteer sees.** It is
in the *member* tab bar (`_layout.tsx:83-87`), so ~16 cardholders hit it. A
rebuild that regresses its load time or its read-only-ness is a bigger blast
radius than any other finance screen. Mitigation baked into the spec: queries
mount only while a row is expanded, blocks A+B render for everyone, and no
write path is added to this screen at all.

**Q7 — Risk: two implementations of "the expenses under a budget."** The
dashboard's `TransactionList` and the new `BudgetSpendLines` will both exist.
They must not drift. Mitigation: `BudgetSpendLines` is a *component*, and the
dashboard's "All expenses" row should be migrated onto it in P1 once the
period-rule difference is reconciled (Q2). Flag if you'd rather do that
migration inside P0 — it's the difference between an L and an XL PR.
