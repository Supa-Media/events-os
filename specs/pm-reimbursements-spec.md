# Reimbursements & Personal Charges — product spec

**Owner:** PM (events-os) · **Date:** 2026-08-14 · **Status:** proposal, not yet built
**Scope:** money OUT (org owes me — reimbursements) and money IN (I owe the org —
personal charges / repayments). No code written; every claim below is checked
against the repo at the file:line given.

---

## 0. The founder's complaints, restated as claims to verify

1. "The reimbursement stuff is hidden within cards." — **TRUE for a finance-seat
   holder, FALSE for a member.** See §1.1. *(Since 2026-08-30 the member's own
   tab bar is Ledger · My Card · Reimbursements · Budgets, and the queue itself
   is readable by any team member — so the seat/member split this spec turns on
   is now about what you can DO, not what you can see.)*
2. "It shows all reimbursements just in a line… doesn't collapse anything." —
   **TRUE.** The manager queue is one flat, ungrouped list of up to 200 rows
   including `paid`/`rejected`/`canceled`. See §1.2.
3. "I want to be able to send them to reimbursements, and then they see 'hey you
   owe this amount'." — **Partly exists.** The debt surface exists; the "send it
   to them" push exists only as a one-shot email at flag time. See §1.4.
4. "Select which ones you want to pay back… break up what card they use per
   transaction… multi-select." — **DOES NOT EXIST.** "Pay by card" pays
   *everything* outstanding in one Stripe Checkout. See §1.5.
5. "Add any Stripe fees associated with that." — **DOES NOT EXIST** on the
   repayment rail. The gross-up math *does* exist and is tested, but is only
   wired into giving. See §1.6.
6. "Once it's paid off, that should clear it out." — **Already true**, via the
   webhook → `settleRepayment`. See §1.7.
7. "It should probably ask to republish the public ledgers and statements." —
   **DOES NOT EXIST.** Nothing detects that a published month has gone stale.
   See §1.8.

---

## 1. Current state, honestly

### 1.1 Navigation — where reimbursements actually live

`apps/mobile/app/(app)/finances/_layout.tsx` is the finance tab bar. It branches
on `api.financeRoles.mySeats`:

- **Seat holder** (`SEAT_TABS`, `_layout.tsx:70-77`): Dashboard · Book · Receipts
  · Sales · Budgets · Cards (+ Accounts for ED/FM). **There is no Reimbursements
  chip.**
- **Member, no finance seat** (`MEMBER_TABS`, `_layout.tsx:83-87`): My Card ·
  **Reimbursements** · Budgets.

So for the exact persona who *approves* reimbursements, the only in-app door is a
single secondary button rendered at the top of the Cards page:

```
apps/mobile/app/(app)/finances/cards.tsx:62-70
  <Button title="Reimbursements" … onPress={() => router.navigate("/finances/reimbursements")} />
```

The comment above it (`cards.tsx:53-61`) admits the history: a tab-bar
flattening deleted the Cards sub-row that used to carry Reimbursements, and the
layout's comment claimed it had moved "to the Cards page's own menu" — a menu
that did not exist. The founder's read is exactly right, and the code already
says so in a comment. `_layout.tsx:36-60` is a standing founder directive
("ONE ROW, NO NESTING", 2026-08-13) that says a fifth thing under Cards should be
"a menu on the Cards page, not a second row here" — that directive is what
buried this.

**Also note:** the finance sub-nav is the *only* nav. There is no global
"Reimbursements" entry outside `/finances/*`. The public accountless surfaces are
separate: `/reimburse/<chapterSlug>` (server-rendered, `apps/convex/http.ts:1522`)
and `apps/mobile/app/reimburse-request.tsx` (sign-in-gated standalone form).

### 1.2 `/finances/reimbursements` — what exists today

One route file, 640 lines, two completely different screens
(`apps/mobile/app/(app)/finances/reimbursements/index.tsx`), chosen at
`:626-640` by `mySeats.length === 0`.

**A. Manager queue** (`ManagerReimbursementsScreen`, `:368-611`)

| Element | Line | Backend |
|---|---|---|
| Header "N open · $X" | `:502-508` | derived from `list` via `isOpen` (`helpers.ts:128`) |
| "Share request link" / "Request a reimbursement" | `:509-524` | client-only / `/finances/reimbursements/new` |
| "Personal charges outstanding" tile → `/finances/personal-charges` | `:538-558` | `api.cards.personalRepaymentsOutstanding` (`cards.ts:3243`) |
| Filter pills: All · Pre-approval · Submitted · Sent back · Paying | `:561-570`, `helpers.ts:37-55` | `api.reimbursements.list({status})` (`reimbursements.ts:2098`) |
| The queue itself | `:586-601` | one `RequestCard` per row, **no grouping, no sections, no collapse** |
| "How reimbursements work" | `:604-605` | static `HowItWorks.tsx` |

`api.reimbursements.list` (`reimbursements.ts:2098-2146`) takes up to **200 rows
newest-first** and, with no `status` arg (the default "All" pill), returns
`paid`, `rejected` and `canceled` requests interleaved with live ones. Each row
renders as a `RequestCard` (`components/finance/reimbursements/RequestCard.tsx`,
729 lines) whose only collapse is a per-card "View line items" toggle
(`RequestCard.tsx:134`, `:231`). That is the founder's complaint verbatim: paid
and unpaid in one line, nothing collapsed.

There is no "needs *my* action" concept: `submitted` and `preapproved` (the two
states `canApprove` allows, `helpers.ts:90-92`) sit next to `changes_requested`
(waiting on the claimant) and `approved`/`paying` (waiting on the bank) with the
same visual weight.

**B. Member screen** (`MemberReimbursementsScreen`, `:211-363`) — this one is
already close to right:

- "Needs your attention" — `changes_requested`, rendered as an editable
  `ReviseForm` (`:273-315`).
- "You owe Public Worship" — `OwedBanner` (`:319-336`), sourced from
  `api.cards.myPersonalRepayments`.
- "Public Worship owes you" — non-terminal own requests (`:339-351`).
- "History" — terminal own requests (`:354-359`).

So the *member* already has the bidirectional page the founder describes. The
*manager* has none of it.

### 1.3 Status model that exists

`REIMBURSEMENT_STATUSES` (`packages/shared/src/finance.ts:1369`):
`pending_preapproval`, `preapproved`, `submitted`, `changes_requested`,
`approved`, `paying`, `paid`, `rejected`, `failed`, `canceled`.
Terminal = `paid | rejected | canceled` (`finance.ts:1405`). `failed` is
deliberately non-terminal (`helpers.ts:132-158`).

`REPAYMENT_STATUSES` (`finance.ts:1694`): `pending`, `paid`, `failed` — three
states, no `processing`, no `refunded`, no `waived`.
`REPAYMENT_METHODS` (`finance.ts:1691`): `card`, `ach`.

### 1.4 Personal charges owed to the org — what exists

**Data.** `personalRepayments` (`apps/convex/schema/finances.ts:1022-1063`):
`chapterId`, `transactionId`, `payerPersonId`, `amountCents`, `method`, `status`,
`increaseRef`, `payerExternalAccountId`, `payerAccountLast4`,
`stripeCheckoutSessionId`, `stripePaymentIntentId`, `creditTransactionId`,
`createdAt`, `updatedAt`. Indexes: `by_chapter`, `by_person`, `by_transaction`,
`by_increase_ref`. **There is no `by_person_and_status` index and no
`feeCoverageCents`, `paidAt`, `batchId`, or `waived*` field.**

**How a charge becomes owed.** Three writers, all funnelling through
`convertChargeToPersonalRepayment` (`cards.ts:2594`):
1. `cards.flagPersonalCharge` (`cards.ts:2692`) — the payer or a manager. Idempotent,
   one repayment per transaction. A manager flagging someone else's charge schedules
   `notifyPersonalChargeFlagged` (`cards.ts:2957`), an email whose CTA is
   `appUrl("/finances/cards")` (`cards.ts:3011`).
2. `cards.autoConvertOverdueReceipts` (`cards.ts:4161`) — the no-receipt sweep.
3. `cards.advanceCodingReviewReminders` / the uncoded clock (same sweep family,
   `cause:"uncoded"`).

**Un-flagging.** `cards.unflagPersonalCharge` (`cards.ts:2838`) — deletes the
repayment row; refuses once `status === "paid" || creditTransactionId` is set.

**Reads.**
- `cards.myPersonalRepayments` (`cards.ts:3205`) — the caller's own, every status,
  no finance gate. Returns `{id, transactionId, amountCents, status, merchantName,
  postedAt, hasExternalAccount}`. Note: **no `description`, no `cardLast4`, no
  `categoryLabel`** — so a "which one is this?" multi-select UI needs more fields.
- `cards.personalRepaymentsOutstanding` (`cards.ts:3243`) — chapter aggregate
  `{count, totalCents}`, `requireFinanceRole(viewer)`.
- `cards.listPersonalRepayments` (`cards.ts:3300`) — every repayment in the
  chapter with payer name/avatar, `requireFinanceRole(viewer)`.

**Screens.**
- `apps/mobile/app/(app)/finances/personal-charges.tsx` is a **6-line re-export**
  of `components/finance/cards/PersonalChargesView.tsx` (306 lines) — the
  *collection* side: Outstanding / Repaid sections, "Mark repaid" (manager only,
  `PersonalChargesView.tsx:157`) and "Un-mark".
  **Is it reachable from nav? No.** It is reachable from exactly two tiles:
  `ManagerCardsView.tsx:199` and `reimbursements/index.tsx:556`. Both are
  manager-only surfaces gated `requireFinanceRole(viewer)`, so **a member who
  owes money can never open this route** (they'd hit the `FinanceBoundary`
  fallback at `PersonalChargesView.tsx:300`). That is defensible today because
  the screen is the collections view — but it means the phrase "personal charges
  page" currently means only the manager's page.
- `components/finance/cards/OwedBanner.tsx` — the *payer* side, mounted on both
  `MemberCardsView.tsx:228` and `reimbursements/index.tsx:335`.
- `components/finance/cards/MemberCardsView.tsx:230-309` — a per-charge "My
  charges" list with "Flag personal" / "Pay back $X" per row (single-charge
  `initiateRepayment`, which is the ACH rail and therefore currently a no-op).

### 1.5 The pay-back rails, honestly

**ACH debit is switched OFF.** `REPAYMENT_DEBIT_ENABLED = false`
(`cards.ts:3566`), with a documented reason: no `ach_transfer.*` bounce state
machine exists, so a 201 would settle a debt that later reverses. Every
`initiateRepayment` call therefore degrades to a still-`pending` row
(`cards.ts:3885-3891`). The "Pay by bank (ACH)" button and the inline
routing/account form (`OwedBanner.tsx:200-256`) collect real bank numbers and
then… do nothing but stamp an external-account id.

**Card is a real rail.** `stripe.createRepaymentCheckout`
(`apps/convex/stripe.ts:238-311`) → `cards.prepareRepaymentCheckout`
(`cards.ts:3729`, authorizes + prices server-side) → Stripe Checkout, one line
item per repayment, `metadata[repaymentIds]` comma-joined (`stripe.ts:275`) →
`cards.attachRepaymentStripeSession` (`cards.ts:3788`) → webhook
`checkout.session.completed` (`http.ts:767-784`) →
`cards.applyRepaymentPaidFromStripe` (`cards.ts:3827`) → `settleRepayment`
(`cards.ts:3366`).

**But the UI never lets you choose.** `OwedBanner.handlePayByCard`
(`OwedBanner.tsx:112-121`) passes `toRepay.map(r => r.id)` — i.e. *every*
outstanding repayment. There is no selection state anywhere in that component.
The backend is already multi-id-capable; only the UI is all-or-nothing. This is
the single cheapest gap in this whole spec to close.

### 1.6 Fees — what exists and what doesn't

**Exists (and is well-tested):** `packages/shared/src/processorFees.ts`
- `DEFAULT_FEE_SCHEDULE` (`:96-108`): `stripe:card` = 290 bps + 30¢ uncapped;
  `stripe:ach_debit` = 80 bps + 0¢ capped at $5.00; `cash_app:wallet` = 260 bps + 15¢.
- `feeOnCents` (`:164`), `netOfFeeCents` (`:171`), `grossUpCents` (`:213`),
  `feeCoverageCents` (`:243`), `describeFeeRate` (`:252`).
- Runtime override via `processorFeeSchedule` rows, read through
  `apps/convex/lib/feeSchedule.ts#resolveFeeRate` (`:64`). **Never read the table
  directly** — that's the house rule at the top of that file.
- Tests: `packages/shared/src/processorFees.test.ts`,
  `apps/convex/tests/givePageGrossUp.test.ts`, `apps/convex/tests/coverTheFees.test.ts`.

**Wired into:** giving only. `gifts.feeCoverageCents`
(`apps/convex/schema/givingPlatform.ts:346`), metadata key `giveIntendedCents`
(`http.ts:749-757`).

**Not wired into repayments at all.** `prepareRepaymentCheckout`
(`cards.ts:3729-3783`) bills exactly `repayment.amountCents` per line. So today
the org nets `amount − (2.9% + $0.30)` on every card repayment and eats the
difference silently. Worse, `applyRepaymentPaidFromStripe` (`cards.ts:3851-3858`)
compares Stripe's `amount_total` against the sum of outstanding `amountCents` and
`console.error`s on mismatch — **so naively adding a fee line would trip the
mismatch alarm on every single repayment.** Any fee work must extend that
reconciliation, not sneak past it.

**Where the actual Stripe fee lands:** `processorFees.syncStripeFees`
(`apps/convex/processorFees.ts:1022`) sweeps Stripe balance transactions and books
**one aggregated fee expense row per processor per month** (`upsertFeeRows`,
`:311`) against the NY chapter's "Bank & Fees" category, carrying `feeOrigin` so
it is auto-explained on the public ledger (`finance.ts:1834`). Fees are *not*
attached per payment. So fee recovery cannot be netted against "the fee for this
repayment" — it has to be booked as its own credit.

### 1.7 What settlement does today (this part is good — don't break it)

`settleRepayment` (`cards.ts:3366-3403`) is the ONE settlement core all three
rails go through. It:
1. Returns early if `creditTransactionId` is set (idempotent, at most one credit).
2. Inserts a `transactions` row: `source:"repayment"`, `flow:"transfer"`,
   `amountCents = repayment.amountCents`, `personId = payerPersonId`,
   `repaymentId`, `status:"reconciled"`.
3. Patches the repayment `status:"paid"`, `creditTransactionId`, and the rail ref.

Downstream, `personalExpenseState` (`packages/shared/src/finance.ts:1731`) derives
`personal_unpaid` → `personal_reimbursed` from `isPersonal` + repayment status.
`autoExplainedKind` (`finance.ts:1826`) classifies the charge as `"personal"` and
the credit as `"repayment_credit"`; both `countsInTotals:false` in the public
snapshot (`lib/publicLedgerSnapshot.ts:424-430`).

So "clear it out" already works. What does *not* exist is any user-visible
completion moment beyond the row changing badge.

### 1.8 Publishing — what "republish" means mechanically

- `financePublications` (`apps/convex/schema/publicLedger.ts:66-116`): one row per
  `(scope, periodKey)` with `status`, `liveRevision`, `isLive`, `amendmentReason`,
  `amendmentNote`.
- `publicLedger.publish` (`apps/convex/publicLedger.ts:680`) — `in_review` →
  published, writes revision N.
- **`publicLedger.republish` (`publicLedger.ts:765-826`)** — the one-shot
  correction the founder is describing. Requires `finance.ledger.publish` AND
  `finance.ledger` prepare, requires `status === "published"`, requires an
  `amendmentReason` + a note ≥ `MIN_AMENDMENT_NOTE_LENGTH`, rebuilds the whole
  snapshot with `buildSnapshot`, writes revision N+1. Revision N stays live until
  N+1 commits, so the public page never blinks.
- `publicLedger.startAmendment` (`:842`) — the three-step reviewed path.

**What a repayment actually changes on a published month:** two things.
1. The **charge's** published row (in the month the charge posted) carries an
   auto-explanation line derived from the live repayment status:
   `publicLedgerSnapshot.ts:456-462` calls
   `autoExplanationLine("personal", personalExpenseState(true, repayment.status))`.
   Settling flips that sentence from "awaiting repayment" to "paid back". **That
   month is now stale.**
2. The **credit** posts in the *current* month (`postedAt: now`,
   `cards.ts:3389`), so if the current month is already published it gains a new
   `repayment_credit` row.

**What detects this today: nothing.** `publicLedger.console_`
(`publicLedger.ts:292-395`) returns `status`, `liveRevision`, `publishedAt`,
`builtAt`, `submittedAt`, amendment fields — no drift/staleness signal at all.
`publishability.report` (`apps/convex/publishability.ts:346`) measures readiness
to publish, not divergence from what *is* published. A published month silently
goes out of date and only a human re-running the preview would notice.

### 1.9 Who can do what today

| Action | Gate | Where |
|---|---|---|
| Read the approval queue | `requireBooksRead` — chapter membership, since 2026-08-30 (was `requireFinanceRole(viewer)`) | `reimbursements.ts` · `lib/booksAccess.ts` |
| Approve / pre-approve / reject / send back | manager + SoD | `reimbursements.ts:2334-2501` |
| Pay by ACH / mark paid | manager + disbursement SoD | `increasePayouts.ts:300`, `:435` |
| Flag / un-flag a personal charge | payer **or** finance manager | `cards.ts:2745-2752`, `:2856-2862` |
| See own repayments | none (self-scoped) | `cards.ts:3205` |
| See the chapter's repayments | `requireFinanceRole(viewer)` | `cards.ts:3300` |
| Mark a repayment repaid | `requireFinanceManager` | `cards.ts:3419` |
| Link a bank account for a repayment | **payer only**, never a manager | `cards.ts:3441-3448` |
| Start a repayment checkout | payer **or** finance manager | `cards.ts:3752-3759` |
| Publish / republish the ledger | `finance.ledger.publish` power | `lib/publicLedgerAccess.ts:202` |

**Every one of these is an inline `requireFinanceRole` / `requireFinanceManager`
call inside the domain module.** There is no `lib/repaymentsAccess.ts` and no
`lib/reimbursementsAccess.ts` — the two domains in this spec are the ones that
have *not* been pulled behind named resolvers the way `campaignsAccess`,
`givingAccess`, and `publicLedgerAccess` have. That is a gap the CLAUDE.md rule
says to close on the way past.

---

## 2. Gap list, ranked

| # | Gap | Founder complaint | Sev |
|---|---|---|---|
| G1 | Reimbursements has no tab for a finance seat holder; the only door is a button on Cards | #1 | **P0** |
| G2 | Manager queue is one flat list; paid/rejected/canceled interleaved with live work; nothing collapses | #2 | **P0** |
| G3 | "Pay by card" pays ALL outstanding — no selection, no per-charge choice | #4 | **P0** |
| G4 | Zero fee recovery on card repayments — org nets 2.9%+30¢ less than the debt, every time | #5 | **P0** |
| G5 | The manager's personal-charges page is reachable only from two tiles, has no nav entry, and its name ("Personal charges") doesn't say it's the collections desk | #1, #3 | P1 |
| G6 | No "send this to them" action — a manager can't nudge an outstanding debt after the one-shot flag email | #3 | P1 |
| G7 | No republish prompt: settling a repayment silently staleness-rots any published month containing the charge | #7 | P1 |
| G8 | `myPersonalRepayments` lacks the fields a selection UI needs (description, card last-4, category) | #4 | P1 |
| G9 | "Pay by bank (ACH)" collects real routing + account numbers into a rail that is switched off (`REPAYMENT_DEBIT_ENABLED=false`) — a dark pattern by accident | — | P1 |
| G10 | No completion moment: after a successful checkout the user returns to `/finances/cards?repay=success` with no receipt, no confirmation, no "here's what cleared" | #6 | P1 |
| G11 | No repayment batch/receipt record — a settled repayment has a Stripe PI id but nothing a payer can be shown or emailed | #6 | P2 |
| G12 | Access is inline everywhere in `reimbursements.ts` / `cards.ts` (no `*Access.ts` resolver) — violates the standing CLAUDE.md gating rule | — | P2 |
| G13 | Repayment statuses have no `processing` state, so a card payment in flight is indistinguishable from an untouched debt | #4 | P2 |
| G14 | No refund/reversal path for a Stripe repayment (compare `givingReversals.ts` for giving) | — | P2 |

---

## 3. The spec

### 3a. Reimbursements page — money OUT (org owes me)

#### Nav placement (fixes G1)

Add **Reimbursements** to `SEAT_TABS` in
`apps/mobile/app/(app)/finances/_layout.tsx:70-77`, positioned after Receipts:

```
Dashboard · Book · Receipts · Reimbursements · Sales · Budgets · Cards [· Accounts]
```

`MEMBER_TABS` (`:83-87`) already has it — leave unchanged.
**Remove** the "Reimbursements" button from `cards.tsx:62-70` in the same PR; a
route with two doors is how the previous flattening produced the comment war
already sitting in that file. Delete the now-false comment at `cards.tsx:53-61`.

This is eight chips at the widest (ED/FM). That is one more than the founder's
"ONE ROW, NO NESTING" directive was reacting to — but the directive's own text
(`_layout.tsx:57-60`) says the answer for a *fifth thing under Cards* is a menu
on Cards, and this is the case where the menu never got built and the destination
went dark. **The tab wins over the directive here, and the PR description should
say so out loud** so the next agent doesn't re-bury it.

#### Information architecture — manager view

Replace the flat list at `reimbursements/index.tsx:586-601` with three collapsible
sections. Order is by *who is blocked*, not by status:

1. **`Waiting on you`** — `submitted`, `preapproved`, `pending_preapproval`.
   Expanded by default. Header: `N requests · $X`. This is the only section that
   renders decision buttons.
2. **`In flight`** — `approved`, `paying`, `failed`. Collapsed by default,
   header shows count + total; `failed` rows sort to the top of the section and
   carry a `danger` badge with the "Retry ACH / Mark paid" pair.
3. **`Sent back`** — `changes_requested`. Collapsed by default. This is work the
   *claimant* owes; showing it collapsed but counted is the point.
4. **`History`** — `paid`, `rejected`, `canceled` (`REIMBURSEMENT_TERMINAL_STATUSES`,
   `finance.ts:1405`). Collapsed by default, **capped at the 25 most recent** with a
   "See all" that pushes to `/finances/reimbursements/history`.

Rules:
- The section split is computed client-side from `isOpen`/`isTerminal`/`canApprove`
  in `components/finance/reimbursements/helpers.ts` — **do not invent a second
  status taxonomy.** Add one exported helper there, `queueSection(status):
  "waiting" | "in_flight" | "sent_back" | "history"`, and unit-test it against
  `REIMBURSEMENT_STATUSES` for exhaustiveness (same pattern as `STATUS_BADGE`,
  `helpers.ts:58-74`).
- Collapse state persists per-session in component state only. Do not persist to
  the server.
- The existing filter pills (`helpers.ts:37-55`) become **secondary**: keep them,
  but when a status filter is active, render one flat list and hide the section
  headers (a filter *is* a section).
- Header stays `N open · $X` (`index.tsx:502-508`) but the number now means
  "Waiting on you", not "not terminal" — rename the label to `N waiting on you`.

#### Information architecture — requester view

The member screen (`index.tsx:211-363`) is already right and stays. Two changes:

- The "You owe Public Worship" section becomes a **link to the new
  `/finances/repayments` page** (§3b) rather than an inline `OwedBanner`, once
  multi-select exists — a selection UI does not belong inside a banner inside a
  section header on a page about the opposite direction of money.
  Keep a one-line summary + "Pay it back →" CTA in its place.
- Give the seat holder this same block. Today a seat holder gets no "owes you"
  and no "you owe" section at all (`index.tsx:368-611` has neither) even though
  the file header at `:23-27` acknowledges "a seat holder is ALSO a chapter
  member". Render the member's four sections *below* the manager queue, behind a
  "Your own requests" section header, reading the same
  `api.reimbursements.myReimbursements` (no finance gate, `reimbursements.ts:1571`).

#### Empty states

| Section | Empty copy |
|---|---|
| Waiting on you | "Nothing waiting on you. Submitted reimbursements land here — the ACH payout starts automatically once approved." (icon `check`) |
| In flight | hide entirely when empty |
| Sent back | hide entirely when empty |
| History | hide entirely when empty |
| Member "owes you" | keep today's copy (`index.tsx:345-348`) |

#### Permission variants

| Persona | Sees |
|---|---|
| No finance seat | Member screen, **plus the chapter's queue read-only** (2026-08-30: the books opened to every team member). No decision buttons — same read-only treatment as `viewer` below. |
| `viewer` | Queue read-only: sections + counts, **no decision buttons**. Today `RequestCard` renders buttons that the server then refuses — surface the read-only state instead. |
| `manager` | Full queue + decisions; a request they submitted renders with decisions disabled and the reason "You can't approve your own request" (mirror the server's `SOD_VIOLATION`, `reimbursements.ts` approve path) rather than letting them press it and read a toast |
| ED/FM (central) | Same as manager, across any chapter's book via the existing scope machinery |

---

### 3b. Repayments — money IN (I owe the org)

#### New route

`/finances/repayments` — **the payer's page.** New file
`apps/mobile/app/(app)/finances/repayments.tsx` (thin route, house convention per
`personal-charges.tsx:1-6`) exporting a new
`components/finance/repayments/RepaymentsView.tsx`.

Rename the existing manager collections screen route from
`/finances/personal-charges` → keep the route (deep links exist in two tiles) but
retitle the screen **"Collect personal charges"** so the two pages are
distinguishable in a screenshot. Its tile CTAs stay where they are.

Nav: **no new tab.** `/finances/repayments` is reached from
(a) the "You owe Public Worship" block on the Reimbursements page (both personas),
(b) the `MemberCardsView` banner CTA (`MemberCardsView.tsx:228`),
(c) the `notifyPersonalChargeFlagged` email CTA (`cards.ts:3011` — change
`appUrl("/finances/cards")` to `appUrl("/finances/repayments")`),
(d) the new nudge email (§ "Send them to reimbursements").

#### The screen

```
You owe Public Worship $412.87
6 charges flagged personal · oldest Jun 12

[ Select all ]  [ Clear ]

☑  Delta Air Lines          Jun 12  $248.00   [ card ····4419 ]
☐  Sweetgreen               Jul 02  $ 18.44   [ card ····4419 ]
☑  Amazon                   Jul 09  $ 96.12   no card on file
☐  Uber                     Jul 21  $ 22.31   [ card ····4419 ]
…

── Selected: 2 charges ────────────────────────────
Charges                                    $344.12
Card processing fee (2.9% + $0.30)          $10.58
                                          ────────
You pay                                    $354.70
Public Worship receives                    $344.12

[ Pay $354.70 by card ]
```

**Selection UX rules:**

1. Multi-select checkboxes, **nothing selected by default.** The founder's exact
   ask — "it shouldn't be all at once" — means the all-in default is wrong.
2. "Select all" is a convenience, not the default.
3. The fee line is recomputed on every selection change, client-side, from the
   *same* `grossUpCents` in `@events-os/shared` the server uses. Show the total
   before the button, never only on the Stripe page.
4. `paid` rows move to a collapsed "Repaid" section below with the settle date;
   a `failed` row stays selectable and carries a `danger` badge.
5. A row with an in-flight checkout (new `processing` status, G13) is **not
   selectable** and reads "Payment in progress — refresh in a minute". This is
   what stops the double-charge the current UI invites.
6. **Per-transaction card choice**: the founder's "break up what card they use per
   transaction" is satisfied by *separate checkouts*, not by storing multiple
   cards. Each "Pay N charges" press opens its own Stripe Checkout with its own
   card entry. Do **not** build a saved-payment-method vault for this — see §6.

#### The fee gross-up math (exact)

**Who eats the fee: the payer.** The org must net the full debt. That is the
founder's instruction ("we have to get back whatever Stripe fees we lose") and it
matches how giving already does it.

**Formula** — reuse `grossUpCents` (`packages/shared/src/processorFees.ts:213`)
verbatim. Do not re-derive it.

```
intendedCents = Σ selected repayment.amountCents
rate          = await resolveFeeRate(ctx, "stripe", "card")   // lib/feeSchedule.ts:64
grossCents    = grossUpCents(intendedCents, rate)
feeCoverageCents = grossCents - intendedCents                 // == feeCoverageCents(), :243
```

With today's default rate (290 bps + 30¢, uncapped, `processorFees.ts:98`):

```
G = ceil( (intended + 30) * 10000 / (10000 - 290) )
```

then two correction loops (`processorFees.ts:233-234`) guarantee
`net(G) ≥ intended` and `net(G-1) < intended` — i.e. **the smallest gross that
still nets the debt.** Worked examples:

| Debt | Gross charged | Fee coverage | Stripe takes | Org nets |
|---|---|---|---|---|
| $18.44 | $19.30 | $0.86 | $0.86 | $18.44 |
| $100.00 | $103.30 | $3.30 | $3.30 | $100.00 |
| $344.12 | $354.70 | $10.58 | $10.58 | $344.12 |

**Rounding rules, stated so nobody re-litigates them:**
- All arithmetic is integer cents; the percentage is `round(gross * bps / 10000)`
  with the multiply first (`processorFees.ts:166`).
- The gross-up rounds **up** (`Math.ceil`), then trims down one cent at a time
  while the net still clears — so the payer is never charged more than covering
  requires, and the org is never short.
- **ONE gross-up over the whole selection, not per line.** Stripe charges its 30¢
  once per *payment*, not per line item. Grossing up per repayment would charge
  the payer 30¢ × N and over-collect. This is the single most likely
  implementation mistake; it must be asserted in a test.
- The fee is charged as **its own Stripe line item** labelled
  "Card processing fee (covered by you)", not baked into the repayment lines —
  so `applyRepaymentPaidFromStripe`'s per-line reconciliation stays honest.
- If the resolved rate has a cap (`stripe:ach_debit` does, card does not),
  `grossUpCents` already handles the capped branch (`processorFees.ts:217-224`);
  no special-casing at the call site.

**Where the extra money goes in the books.** `settleRepayment`
(`cards.ts:3366`) posts a `flow:"transfer"` credit for `amountCents` only. The
coverage cents must be booked too, or the bank feed will show more money arriving
than the ledger explains. Post a **second** transaction per settled batch:
- `source: "repayment"`, `flow: "transfer"`, `amountCents = feeCoverageCents`,
  `personId = payerPersonId`, `repaymentId` = the first repayment in the batch,
  `status: "reconciled"`, `description: "Card processing fee covered by payer"`.
- `flow:"transfer"` keeps it out of income and out of category/budget spend
  (`isSpend`), which is right: it is not a gift and not revenue, it is the payer
  reimbursing a cost the org would otherwise absorb. The actual Stripe fee still
  books monthly and aggregated via `processorFees.upsertFeeRows`
  (`processorFees.ts:311`) — these two do not net per-payment, and that's fine
  and expected. Say so in the module comment so a future reader doesn't try to
  "fix" it.

#### What happens on payment success

Sequence, extending the existing rails rather than replacing them:

1. Client calls `stripe.createRepaymentCheckout({ repaymentIds, coverFees: true })`.
2. `cards.prepareRepaymentCheckout` (extended, `cards.ts:3729`) re-authorizes,
   drops already-settled ids, computes `intendedCents`, resolves the rate,
   computes `grossCents` / `feeCoverageCents`, and **stamps
   `status:"processing"` + a new `repaymentBatchId` on each row**.
3. The action builds the Checkout: N repayment line items + 1 fee line item,
   `metadata[repaymentIds]` (as today, `stripe.ts:275`) **plus new
   `metadata[repaymentIntendedCents]` and `metadata[repaymentBatchId]`** —
   mirroring the `giveIntendedCents` precedent (`http.ts:749`).
4. `cards.attachRepaymentStripeSession` (`cards.ts:3788`) stamps the session id.
5. Webhook `checkout.session.completed` (`http.ts:767-784`) →
   `cards.applyRepaymentPaidFromStripe`, extended:
   - reconcile against `intendedCents` from metadata (falling back to the sum of
     outstanding amounts when absent, so old in-flight sessions still settle);
   - `amount_total` is now expected to equal `grossCents` — the mismatch
     `console.error` at `cards.ts:3852-3858` must compare against
     `intended + coverage`, not `intended`, or it fires on every payment;
   - settle each still-outstanding repayment through `settleRepayment` at its OWN
     `amountCents` (unchanged);
   - post the single fee-coverage credit for the batch;
   - stamp `paidAt`, `feeCoverageCents` (batch total, on the first row only, or on
     a new `repaymentBatches` row — see §3c).

**Records that mutate on success:**

| Table | Change |
|---|---|
| `personalRepayments` | `status: processing → paid`, `creditTransactionId`, `stripePaymentIntentId`, `paidAt`, `updatedAt` |
| `transactions` (new) | one `source:"repayment"` `flow:"transfer"` credit **per repayment** (existing behavior, `cards.ts:3383`) |
| `transactions` (new) | one `flow:"transfer"` fee-coverage credit **per batch** (new) |
| `transactions` (the original charge) | untouched — `isPersonal` stays true, receipt and coding intact. `personalExpenseState` now derives `personal_reimbursed` (`finance.ts:1731`) |
| `financeAuditLog` | new entry `action:"personal_repaid"` per settled repayment (today `settleRepayment` writes none — add it) |

#### Idempotency and failure handling

- **Idempotency is already correct and must not be weakened.**
  `settleRepayment`'s `creditTransactionId` guard (`cards.ts:3372-3380`) is the
  single at-most-once credit guarantee for all three rails. Stripe redelivers at
  least once and possibly out of order; the existing tests cover duplicate
  delivery (`apps/convex/tests/personalExpenseFlow.test.ts:563`).
  The new fee-coverage credit needs the **same** guard: key it on a new
  `feeCreditTransactionId` on the batch (or on the first repayment), checked
  before insert.
- **Abandoned checkout**: `status` goes back `processing → pending`. Stripe's
  `checkout.session.expired` and `checkout.session.async_payment_failed` branches
  already exist in `http.ts:1032-1044` and funnel into `cancelCheckoutSession`
  (`http.ts:845-859`), which today releases pending gifts, orders and donations —
  **but knows nothing about repayments.** Add
  `internal.cards.releaseRepaymentCheckout` to that shared release, mirroring the
  three calls already there. Belt-and-braces: also add
  `cards.expireStaleRepaymentCheckouts` (internal mutation, hourly cron)
  reverting any `processing` row older than 60 minutes with no
  `stripePaymentIntentId`, because a webhook Stripe never sends (user closed the
  tab and the session sat until its 24h expiry) would otherwise leave the row
  unselectable — gap 5 above becoming a lock-out.
- **Partial payment is impossible by construction** — Stripe Checkout is
  all-or-nothing per session. A *partial batch* (one repayment settled by a
  manager's `markRepaymentPaid` while the checkout was open) is already handled:
  `applyRepaymentPaidFromStripe` skips settled rows and logs the mismatch loudly
  (`cards.ts:3836-3858`). With fee coverage the over-collection is now real money;
  the log line must say "the payer over-paid by $X — refund or credit manually".
- **Un-flag races a live checkout**: already documented as a deliberate
  loud-fail (`cards.ts:2828-2836`). With `status:"processing"`, extend
  `unflagPersonalCharge` to **refuse** while a checkout is in flight, which
  removes the edge rather than logging it.
- **Failed payment**: `checkout.session.async_payment_failed` → `status:"failed"`,
  debt kept. The event branch exists (`http.ts:1032`); only the repayment arm of
  `cancelCheckoutSession` is missing (above). Distinguish it from `expired`
  (which reverts to `pending`, since nothing was refused — the payer just
  walked away).

#### The republish prompt (G7)

**Detection.** Add `publicLedger.staleMonths` (query): for a scope, return every
`financePublications` row with `status:"published"` whose `liveRevision`'s
`publishedAt` is older than the newest `updatedAt` among transactions/repayments
in that period. Cheapest honest implementation: stamp a
`financePublications.dirtySince: v.optional(v.number())` whenever a write touches
a transaction inside an already-published period, and clear it in `writeRevision`
(`publicLedger.ts:561`). One writer to add it from, for this spec's scope:
`settleRepayment` (`cards.ts:3366`) — it must mark **two** periods dirty:
- the period of the **charge** (`transaction.postedAt`) — its published
  auto-explanation line changes from "awaiting repayment" to "paid back"
  (`publicLedgerSnapshot.ts:456-462`);
- the period of the **credit** (`now`) — a new row appears.

**Who gets asked.** Only a holder of `finance.ledger.publish`
(`lib/publicLedgerAccess.ts:202`). A member paying back a charge must never see a
publishing prompt — it is not their decision and mentioning it to them is noise.
Surface it in two places:
1. `/finances/publish` — a "Needs republishing" chip on each dirty month, with
   the existing one-shot `republish` mutation (`publicLedger.ts:765`) behind it.
   The reason/note it already demands (`:776-782`) is pre-filled with
   `"Personal charge repaid — the affected rows now show the repayment."` and is
   **editable, never auto-submitted**. The amendment note is the whole reason a
   correction reads as credible rather than a quiet edit (`publicLedger.ts:745-751`);
   don't let this feature turn it into boilerplate nobody reads.
2. The finance Dashboard's `PublishabilityCard`
   (`apps/mobile/components/finance/dashboard/PublishabilityCard.tsx`) — a count.

**What re-renders.** `republish` calls `buildSnapshot` fresh
(`publicLedger.ts:798`) and `writeRevision` inserts a whole new revision's worth
of `financePublicationEntries`. So it is not a partial patch: the entire month is
rebuilt at revision N+1, revision N stays readable in the audit trail, and the
public page (`publicLedger.publicStatement`, `:1319`) flips atomically. Nothing
about that machinery needs changing — only the *prompt* is new.

**Deliberately NOT built:** auto-republish. A settled repayment must not push a
new public revision on its own. Publishing is the one finance action with an
outside audience and its own power for exactly that reason
(`powers.ts:274-287`).

---

### 3c. New backend surface

#### New Convex functions

| Name | Kind | Args | Returns | Notes |
|---|---|---|---|---|
| `cards.myRepaymentsDetailed` | **query** | `{}` | `Array<{id, transactionId, amountCents, status, merchantName, description, cardLast4, postedAt, flaggedAt, paidAt, hasExternalAccount, batchId}>` | Replaces `myPersonalRepayments` for the new screen (G8). Keep the old one until the last caller moves. Self-scoped, no finance gate — via `requireOwnRepaymentsRead` |
| `cards.quoteRepayment` | **query** | `{repaymentIds: Id<"personalRepayments">[]}` | `{intendedCents, feeCoverageCents, grossCents, rateLabel: string, skipped: Id[]}` | Server-side truth for the fee panel. `rateLabel` from `describeFeeRate` (`processorFees.ts:252`). Query, not action — no Stripe call, just `resolveFeeRate` |
| `cards.prepareRepaymentCheckout` | **internalMutation** (existing, `cards.ts:3729`) | + `coverFees: v.boolean()` | + `intendedCents`, `feeCoverageCents`, `grossCents`, `batchId` | Extend, don't fork. Also stamps `status:"processing"` |
| `stripe.createRepaymentCheckout` | **action** (existing, `stripe.ts:238`) | + `coverFees: v.optional(v.boolean())` | unchanged | **Must stay an action** — it `fetch`es Stripe |
| `cards.applyRepaymentPaidFromStripe` | **internalMutation** (existing, `cards.ts:3827`) | + `intendedCents: v.optional(v.number())`, `feeCoverageCents: v.optional(v.number())`, `batchId: v.optional(v.string())` | `null` | Extend the reconciliation; post the fee credit |
| `cards.releaseRepaymentCheckout` | **internalMutation** | `{sessionId, outcome: "expired" \| "failed"}` | `{released: number}` | Called from `cancelCheckoutSession` (`http.ts:845`), alongside the three release calls already there. `expired` → `pending`, `failed` → `failed`. No-ops when the session isn't a repayment's |
| `cards.expireStaleRepaymentCheckouts` | **internalMutation** | `{}` | `{reverted: number}` | Hourly cron; `processing` → `pending` after 60 min |
| `cards.nudgeRepayment` | **action** | `{repaymentIds: Id<"personalRepayments">[]}` | `{sent: number, skipped: number}` | "Send them to reimbursements" (G6). Action because it sends email via Resend. Manager-gated. Rate-limit 1/payer/24h, mirroring `cards.sendReceiptNudge` (`cards.ts:5173`) and its `MANUAL_NUDGE_WINDOW_MS` (`cards.ts:4880`) |
| `cards.getRepaymentNudgePayload` | **internalQuery** | `{repaymentIds}` | payer contact + charge list | Mirrors `getPersonalChargeFlagContact` (`cards.ts:2924`) |
| `cards.sendRepaymentNudgeEmail` | **internalAction** | `{payerPersonId, repaymentIds}` | `null` | Best-effort, never throws past itself |
| `publicLedger.staleMonths` | **query** | `{scope: v.optional(scopeValidator)}` | `Array<{periodKey, label, liveRevision, dirtySince}>` | Gated `requireLedgerConsole` |
| `publicLedger.markPeriodDirty` | **internalMutation** | `{scope, periodKey, at}` | `null` | Called from `settleRepayment` and any future writer |
| `reimbursements.queueCounts` | **query** | `{}` | `{waiting: {count, cents}, inFlight: {…}, sentBack: {…}}` | Section headers without pulling 200 rows client-side. `requireReimbursementQueueRead` |

#### New schema

**`personalRepayments`** (`apps/convex/schema/finances.ts:1022`) — add:
```
paidAt:              v.optional(v.number()),   // settle timestamp; today only updatedAt exists
batchId:             v.optional(v.string()),   // groups a multi-select checkout
feeCoverageCents:    v.optional(v.number()),   // this row's share, 0 for all but the batch anchor
feeCreditTransactionId: v.optional(v.id("transactions")), // idempotency for the fee credit
lastNudgedAt:        v.optional(v.number()),   // rate-limits nudgeRepayment
```
plus a new index `by_person_and_status: ["payerPersonId", "status"]` (today
`myPersonalRepayments` takes 500 by person and filters in memory, `cards.ts:3213-3218`).

**`REPAYMENT_STATUSES`** (`packages/shared/src/finance.ts:1694`) — add
`"processing"`: `["pending", "processing", "paid", "failed"]`.
`personalExpenseState` (`finance.ts:1731`) needs **no change** — it already treats
anything that isn't `"paid"` as `personal_unpaid`, which is the correct reading of
`processing`. Add a test asserting that.

**`financePublications`** (`apps/convex/schema/publicLedger.ts:66`) — add
`dirtySince: v.optional(v.number())`, cleared in `writeRevision`
(`publicLedger.ts:561`).

#### New capabilities + access resolvers (CLAUDE.md gating rule)

Two new files. Every call site uses the `require` form; nothing checks a seat or
a finance role inline.

**`apps/convex/lib/repaymentsAccess.ts`** — new powers in
`packages/shared/src/powers.ts:184-206`:

| Power | Meaning | Seats that carry it (`SEAT_DEFS`) |
|---|---|---|
| `finance.repayments.view` | See who owes the org money, chapter-wide | `treasurer`, `chapter_director`, `financial_manager`, `executive_director` |
| `finance.repayments.collect` | Mark a repayment received / un-flag / nudge a payer | `treasurer`, `financial_manager` |

Resolvers, following `lib/publicLedgerAccess.ts`'s shape exactly:

```
hasRepaymentsView / requireRepaymentsView        // body today: requireFinanceRole(viewer)
hasRepaymentsCollect / requireRepaymentsCollect  // body today: requireFinanceManager
hasOwnRepaymentsRead / requireOwnRepaymentsRead  // body today: "is the caller the payer?"
hasRepaymentPay / requireRepaymentPay            // body today: payer OR manager (cards.ts:3752-3759)
```

`requireOwnRepaymentsRead`'s body is *just the identity check* today — write it
anyway, with the comment "graduates to `finance.repayments.view.own` if the org
ever wants to let a delegate see someone's debts." That is the rule.

**`apps/convex/lib/reimbursementsAccess.ts`** — no new power strings needed on day
one; wrap what exists so the call sites stop being inline:

```
hasReimbursementQueueRead / requireReimbursementQueueRead   // finance viewer today
hasReimbursementDecide    / requireReimbursementDecide      // finance manager + SoD today
hasReimbursementPay       / requireReimbursementPay         // manager + disbursement SoD today
```
with a comment naming `finance.reimbursements.approve` as the power
`requireReimbursementDecide` graduates to. This closes G12 without a behavior
change, which is exactly the shape the rule asks for.

**Separation of duties is unchanged and stays in the mutations**
(`lib/finance.ts:609#assertSeparationOfDuties`), not in the resolvers — same
division `publicLedgerAccess.ts:79-83` documents.

---

## 4. Prioritized roadmap

### P0 — one PR, shippable (M)

**"Reimbursements gets its own page; repayments get multi-select and fee cover."**

| Change | Size | Files |
|---|---|---|
| Reimbursements tab for seat holders; delete the Cards button + its comment | S | `apps/mobile/app/(app)/finances/_layout.tsx:70-77`, `apps/mobile/app/(app)/finances/cards.tsx:53-70` |
| `queueSection()` helper + tests | S | `apps/mobile/components/finance/reimbursements/helpers.ts` |
| Collapsible sections in the manager queue; History capped at 25 | M | `apps/mobile/app/(app)/finances/reimbursements/index.tsx:586-601` |
| Seat holder gets their own "owes you / you owe" block | S | same file, `:368-611` |
| `/finances/repayments` route + `RepaymentsView` with multi-select | M | new `apps/mobile/app/(app)/finances/repayments.tsx`, new `apps/mobile/components/finance/repayments/RepaymentsView.tsx` |
| `cards.myRepaymentsDetailed`, `cards.quoteRepayment`, `by_person_and_status` index | M | `apps/convex/cards.ts`, `apps/convex/schema/finances.ts:1022` |
| Fee gross-up through the whole rail (prepare → checkout line → webhook reconcile → fee credit) | M | `apps/convex/cards.ts:3729/3827`, `apps/convex/stripe.ts:238-311`, `apps/convex/http.ts:767-784` |
| `processing` status + release-on-expire/fail + stale-checkout cron + unflag refusal while processing | S | `packages/shared/src/finance.ts:1694`, `apps/convex/cards.ts:2838`, `apps/convex/http.ts:845-859`, `apps/convex/crons.ts` |
| `lib/repaymentsAccess.ts` + two new powers; move `cards.ts` repayment call sites onto it | M | new file, `packages/shared/src/powers.ts`, `packages/shared/src/seats.ts` |
| Academy update (§5) + snapshot test | S | `packages/shared/src/academy/streams/finances.ts`, `packages/shared/src/academy.snapshot.test.ts` |

Tests that must land with it: the one-gross-up-per-batch assertion; duplicate
webhook delivery still settles once (extend
`apps/convex/tests/personalExpenseFlow.test.ts:563`); the reconciliation compares
against `intended + coverage`; `personalExpenseState("processing") ===
"personal_unpaid"`.

### P1 (S–M each)

- **Republish prompt** (M): `financePublications.dirtySince`,
  `publicLedger.staleMonths`, `markPeriodDirty` from `settleRepayment`, the
  "Needs republishing" chip on `/finances/publish` and the dashboard count.
  Files: `apps/convex/schema/publicLedger.ts:66`, `apps/convex/publicLedger.ts:561/765`,
  `apps/convex/cards.ts:3366`, `apps/mobile/app/(app)/finances/publish.tsx`.
- **Nudge / "send them to reimbursements"** (M): `cards.nudgeRepayment` +
  payload query + email action, rate-limited; a "Remind" button per row and a
  "Remind all" on the collections screen. Files: `apps/convex/cards.ts`,
  `apps/mobile/components/finance/cards/PersonalChargesView.tsx`.
- **Retitle + polish the collections screen** (S): "Collect personal charges",
  add a "Remind" column, sort oldest-debt-first.
  File: `apps/mobile/components/finance/cards/PersonalChargesView.tsx`.
- **Completion moment** (S): `/finances/repayments?repay=success` renders a
  confirmation card listing exactly what cleared and the fee covered, reading the
  now-`paid` rows. Change the Stripe `success_url` from `/finances/cards`
  (`stripe.ts:254`) to `/finances/repayments`.
- **Honest ACH** (S): hide "Pay by bank (ACH)" while `REPAYMENT_DEBIT_ENABLED ===
  false` (`cards.ts:3566`), or relabel it "Request bank details from a manager".
  Collecting routing + account numbers for a rail that cannot charge them is the
  worst version of this screen. File: `OwedBanner.tsx:125-156`, `:200-256`.
- **`lib/reimbursementsAccess.ts`** (S): wrap the existing inline gates.

### P2 (S–L)

- Repayment receipt email on settle (S) — mirrors the giving receipt path.
- `repaymentBatches` table if per-batch data outgrows the anchor-row approach (M).
- Refund/reversal path for a Stripe repayment, mirroring `givingReversals.ts` (L).
- ACH debit bounce state machine — the prerequisite to flipping
  `REPAYMENT_DEBIT_ENABLED` true; the TODO at `cards.ts:3556-3564` already
  specifies it in four steps (L).
- `/finances/reimbursements/history` full-history route with search (M).

---

## 5. Academy impact

Everything below is in `packages/shared/src/academy/streams/finances.ts`, and
**any content edit also requires updating `packages/shared/src/academy.snapshot.test.ts`**
(it pins slugs, section counts and block counts — see `:306`, `:512`, `:1063`).

| Module | Line | Goes stale because |
|---|---|---|
| `finance-reimbursements-and-flags` ("Reimbursement, and flagging a charge") | `:1114-1116` | Bullet at `:1129` says "**Both directions live in one place:** the Reimbursements tab shows 'Public Worship owes you' and 'you owe Public Worship' side by side" — with P0 the owe side moves to `/finances/repayments`. Bullet at `:1127` says "**Pay it back by card or by bank:** once flagged, pay it back instantly by card" — must now teach **multi-select** and that **the payer covers the card fee**. This is the primary lesson to update. |
| `finance-reconcile-grid` → rule "Collecting it back — and what settling actually does" | `:1352-1353` | Says the collecting happens on "Cards → 'Personal to repay'" and "The person pays from their own card or bank on their Cards tab". Both routes change (page renamed; payer moves to `/finances/repayments`). |
| `finance-reconcile-grid` → rule "Personal is a flag, not a status" | `:1342-1343` | Un-flag rules change: it will additionally be refused while a payment is `processing`. |
| `finance-publishing-the-books` | `:1771-1772`, rule "Published means frozen" `:1782` | Gains the republish-prompt behavior: a settled repayment marks a published month as needing an amendment. Teach that the prompt is a *nudge*, never an auto-publish, and that the amendment note still has to be written. |
| `finance-monthly-close` | `:1677-1678` | Close now has one more check: "any month flagged Needs republishing". |
| `finance-card-and-receipts` | `:622-623` | The auto-conversion email's CTA link changes from Cards to Repayments — minor, but the lesson describes the flow. |
| Course description, `finances-for-everyone` | `:2971-2977` | "both directions of reimbursement" is still accurate; check the wording once the routes move. |

**Role paths** (`packages/shared/src/academyPaths.ts`): the two new powers
(`finance.repayments.view` / `finance.repayments.collect`) land on
`treasurer`, `chapter_director`, `financial_manager`, `executive_director` —
all four already carry paths containing `treasurer` / `chapter-money-model`
courses, so **no new path entries are needed**. Verify with the existing
`academyPaths.test.ts`.

**Capstone templates** (`apps/convex/lib/seed/templates.ts`): grepped for
`reimburse` / `personal charge` / `Cards tab` — **no matches**, so no capstone
quest references these screens today. Nothing to fix there.

**Verdict on "is this training-worthy?"** — yes, unambiguously: it changes a
route, a money rule (who pays the processor), and a published-ledger process.

---

## 6. Risks and open questions for the founder

**Money / fees**

1. **Is card the right instrument at all?** Card repayment costs 2.9% + 30¢;
   Stripe ACH debit costs 0.8% capped at $5 (`processorFees.ts:101`). On a $248
   airline charge that's $7.49 versus $1.98 — and the difference is now coming out
   of the *member's* pocket, not the org's. The repo's own giving copy already
   nudges to ACH above $500 (`ACH_NUDGE_THRESHOLD_CENTS`, `processorFees.ts:297`).
   **Recommendation: ship card first (it's the only rail that actually works
   today) and add Stripe ACH debit as the cheaper option, not the Increase ACH
   debit that's switched off.** Question for you: are you comfortable asking a
   volunteer to pay $7.49 in fees to hand back $248, or should the org absorb the
   fee below some threshold?
2. **Fee coverage is not tax-deductible and is not a gift.** Booking it
   `flow:"transfer"` (my recommendation) keeps it out of income, which is right.
   Confirm with whoever does the 990 that a "payer covers our processing cost"
   receipt line is fine as a non-gift.
3. **Refunds.** There is no reversal path for a repayment (G14). If someone pays
   back a charge that was mis-flagged, today the only fix is a manual Stripe
   refund plus a hand-written correcting entry — and `unflagPersonalCharge`
   refuses outright once settled (`cards.ts:2867-2873`). Acceptable for now?
4. **Over-collection edge.** If a manager marks a repayment repaid while a
   checkout is open, the payer pays for a debt that no longer exists. Today that
   logs an error (`cards.ts:3852`). With fee coverage it's real money the org
   holds against no debt. **Do you want an automatic refund attempt, or a loud
   manual queue?** I recommend a manual queue: automated refunds on a nonprofit's
   money path are how you end up refunding the wrong thing at 3am.

**Operational**

5. **Should a manager be able to pay on someone's behalf?** They can today
   (`prepareRepaymentCheckout`'s OR-gate, `cards.ts:3752-3759`) — meaning a
   treasurer can put their own card in for a volunteer's debt. That's a real
   kindness and a real audit smell. Keep, restrict, or log loudly?
6. **The ACH form that does nothing.** `OwedBanner.tsx:200-256` collects real
   routing and account numbers into a rail that is off. I want to hide it in P1.
   Confirm nobody is relying on it as a "we have their bank details" record.
7. **How aggressive should the nudge be?** I've speced 1 email per payer per 24h,
   manager-initiated only. A cron that auto-chases outstanding debts weekly is
   easy to add and much easier to regret — say the word if you want it.

**Publishing**

8. **Republish is a prompt, never automatic — confirm.** A settled repayment
   changes a published month's wording from "awaiting repayment" to "paid back".
   I am deliberately *not* auto-publishing that. It means a published page can be
   briefly out of date with a note saying "awaiting repayment" for a charge that
   was just repaid. Are you OK with that lag, or do you want the public page to
   read live for this one field?
9. **Volume.** If a dozen people settle charges across six months, a publisher
   could face six "needs republishing" prompts at once, each demanding its own
   amendment note (`publicLedger.ts:776-782`). Do you want a batched
   "republish all affected months with one note"? That weakens the per-month
   amendment record, which is the thing that makes corrections credible.

**Scope check**

10. The founder's "break up what card they use per transaction" is delivered as
    *separate checkouts*, not stored cards. Building a saved-payment-method vault
    would mean holding Stripe Customer objects for volunteers and a whole
    card-management UI — much bigger, and nobody asked for "manage my saved
    cards". Confirm separate checkouts satisfy the ask.
