# Chapter OS — Native Finance System (build spec)

The native money layer that replaces KleerCard / Bill.com. Because the app
already holds events, projects, supplies, teams and people, every dollar attaches
to the exact event/project/item it was spent on. **The prototype IS the spec** —
`~/Code/public-worship/public/artifacts/chapter-os/{finances,reimburse}.html`
(live at publicworship.life/artifacts/chapter-os/). Design tokens: `apps/mobile/lib/theme.ts`.

## Invariants (non-negotiable)

- **Money is always integer `amountCents`** (USD), never floats. Direction is
  carried by `flow` (`outflow`/`inflow`/`transfer`), not a sign. UI shows charges
  as `−$64.20`, payouts/reimbursements positive.
- Every table is chapter-scoped (`chapterId` + `by_chapter` index). Finance
  actors are `people` (resolve caller via `people` `by_user`).
- **Estimated ≠ Actual (anti-double-count).** Estimated = planned (`budgets`,
  `projects.budgetUsd`, `events.budget`, item `fields.cost`, `engagements.amountUsd`).
  Actual = the `transactions` table ONLY. Never sum across them. Reimbursement
  payouts post as `flow:"transfer"` → excluded from category/budget spend.
- Enum validators are built from the `packages/shared/src/finance.ts` tuples
  (the `EVENT_STATUSES` pattern). Money-format via `formatCents`; period
  bucketing (`easternParts`/`quarterOfMonth`) in America/New_York.
- Authz: the graded ladder in `lib/finance.ts` — `viewer < bookkeeper < manager`,
  a central/org tier, superuser-implicit-manager, separation-of-duties
  (approver ≠ requester). Gate every read with `requireFinanceRole(...,"viewer")`,
  categorize/reconcile with `"bookkeeper"`, budgets/funds/cards/approvals with
  `requireFinanceManager`, org roll-up with `requireFinanceCentral`.

## Money model

- **Increase = payouts AND cards, one bank Account per chapter** (Entity +
  Account via the Platform API; `increaseAccounts` keyed by chapter). That account
  is the source of truth: budgets are logical allocations of its balance, member
  cards are issued on it, ACH reimbursement payouts originate from it. **No Stripe
  Issuing / Connect.**
- **Stripe Financial Connections = read-only** sync of legacy external bank/card
  accounts (`legacyAccounts`), reusing `stripe.ts` + `/stripe/webhook`.
- **Budgets = scope × cadence × categories** (one `budgets` table). scope ∈
  event/project/template/team/bucket/chapter; cadence ∈
  per_instance/monthly/quarterly/yearly/one_off. New budget shapes are config,
  not code. Rollover deferred (`rolloverPolicy` reserved).
- **Cards are person-owned** — each holder owns their receipts + reconciliation.
  Only two hard controls: a monthly safety cap + a validity window. Auto-lock if a
  receipt is >7 days late (unlock on upload). Personal charges: flag + repay via
  own debit/ACH → offsetting `flow:"transfer"` credit, no reimbursement paperwork.
- **AI auto-coding** — a `"use node"` action (OpenRouter, `aiActions.ts` raw-fetch
  pattern) proposes `{fund, category, event/instance link}` per incoming charge
  from card + time + merchant + the week's calendar. A human confirms; the model
  never moves money.

## Three perspectives (from the caller's `financeRoles` level)

- **central** — org-wide roll-up (by template across chapters, by chapter, global
  total). `requireFinanceCentral`.
- **chapter** — one chapter: events & projects, recurring buckets, team budgets,
  recent transactions w/ AI-coding accept, "needs attention".
- **member** — own card, personal-repayment banner, my transactions, my
  reimbursements.

## Finance-app tabs (in order)

`Dashboard` · `Reimbursements` · `Reconcile` · `Cards` · `How it works` · `Tech spec`.
(Budgets live ON the dashboard — project/recurring/team budget cards + a "New
budget" create flow + "Add transaction" manual entry — not a separate tab.)

---

## UI/data spec per surface (distilled from the prototype)

Money fields below are ALL integer cents backend-side. This is the contract the
dashboard read queries return and the screens render.

### Dashboard — CENTRAL
- **tiles**: `[{label, value, meta}]` — Spent·month·all-chapters (money),
  a named-template total ("across N chapters"), Active chapters (count), To review·org (count).
- **templateRollup** (By template, across chapters): `[{templateName, cadence,
  scopeLabel, monthTotalCents, perChapter:[{chapterName, amountCents, barPct}]}]`.
- **chapterRollup** (By chapter): `[{chapterName, subtitle, spentCents, budgetCents,
  barPct, status:"ok"|"warn"}]` (Boston row has a "View" → chapter perspective).

### Dashboard — CHAPTER
- **tiles**: `[{label, value, subValueCents?, meta}]` — Spent·month, a per-instance
  budget `spent/budget · pct`, a monthly bucket `spent/budget`, To review (count).
- **projectBudgets** (Events & projects this month): `[{name, cadence:"per_instance"|
  "one_off", sourceBadge?, dateLabel, subtitle, spentCents, budgetCents, pct,
  remainingCents, status, categories:[{name, spentCents, barPct}]}]`.
- **recurringBudgets** (monthly/quarterly/yearly buckets): `[{name, cadence,
  spentCents, budgetCents, pct, status, categories?:[{name, spentCents, barPct}], note?}]`.
- **recentTransactions**: `[{_id, date, merchant, cardLast4?, spenderName, timeOrNote,
  codedTo?:{fundOrProject, category}, aiSuggestion?:{fund, category}, amountCents,
  flow, status:"reconciled"|"needs_accept"|"paid"}]` (Accept button when aiSuggestion + needs_accept).
- **attention**: `[{kind, title, badgeCount, detail, actionLabel}]` — reimbursements
  to approve; cards nearing auto-lock.
- AI auto-coding banner (static copy).

### Dashboard — MEMBER
- **card**: `{last4, cardholderName, status, spentThisMonthCents, receiptsDueBadge?}` + virtual-card art.
- **repaymentBanner?**: `{owedCents, flaggedCharge:{merchant, date}}` → Pay by card / Pay back.
- **myTransactions**: `[{_id, date, merchant, cardLast4?, note, amountCents,
  status:"receipt_due"|"personal_to_repay"|"reconciled"|"repaid"}]`.
- **myReimbursements**: `[{_id, date, what, fundCategory, receiptNote, amountCents,
  status:"awaiting_approval"|"paid"}]`.

### Reimbursements
- Manager queue: count "N open · $X"; filter pills All/Pre-approval/Submitted/Paying.
  `[{_id, requesterName, requesterType:"volunteer"|"team", avatarInitials, submittedDate,
  source?, lineItems:[{description, fundCategory, receiptOk, amountCents}], statusBadge,
  totalCents}]`. Actions per state: Reject · Approve lines… (partial) · Approve & pay ·
  Pre-approve · (paying → ACH info). SoD warn strip on own request.
- Member submission form (in-app twin of reimburse.html): name, email, pay-to bank
  (last4 only), fund; line-items grid `[Description, Qty, Rate, Amount, ×]` + per-line
  receipt; receipts dropzone; notes; total; Submit / Ask for pre-approval.

### Reconcile (manager/bookkeeper)
- Header "N to clear"; pills Needs review / Missing receipt / Ready. Two-pane list+detail.
- list: `[{_id, merchant, date, cardLast4?, spenderOrSource, state:"uncategorized"|
  "receipt_due"|"ready", amountCents}]`.
- detail: `{merchant, amountCents, meta, receiptState:"none"|"due"|"ok", aiRationale,
  aiSuggested:{fundOrProject, category, eventLink?}, receiptReminderTimeline}`. Editable
  Fund/project, Category, Link-to-event selects. Actions Edit · Accept & reconcile.
- Receipt-reminder timeline: Purchased→reminder · End-of-day flag · Day-3 escalate ·
  Day-7 auto-lock (unlock on upload).

### Cards (later phase for issuance; UI shell now)
- Manager tiles: Team cards (count), Spent·month, Receipts due (count), Personal to repay (money).
- cardholders: `[{_id, holderName, avatarInitials, cardType:"Virtual"|"Physical", last4,
  receiptsStatus, spentMonthCents, cardStatus:"active"|"locked"|...}]`. Issue card.
- Card philosophy cards (static). Member card detail: art + status + receipt warning +
  personal-repay flow (Pay by card / Pay by bank ACH).

### Public reimburse.html (Phase 3 httpAction, not an app screen)
- Form state: name, email, "what's this for?" (event/project → fund auto-fill), line-items
  grid with per-line category + receipt, pay-to bank (last4), notes, total, Submit / pre-approval.
- Status state: reference #, timeline Submitted→Under review→Approved→Paid by ACH, "what you
  submitted" summary, add-receipt / edit-until-approved.

### How it works / Tech spec tabs
- Prose + a permissions matrix (capability × Central/Chapter/Bookkeeper/Member). Content
  is the prototype's; can be an in-app help screen or deferred.

## Visual system (tokens: `apps/mobile/lib/theme.ts`, NativeWind classes)
- Church-brand red/cream: surface `#FDF6F6`, raised `#FFFFFF`, sunken `#FAEEE9`; ink
  `#210909`, muted `#7A5A5A`; accent `#D23B3A`. Semantic success `#2F7D5B`, warn
  `#B4761A`, danger=accent, info `#4A6BC0`. Tabular-nums for money.
- Components (use the UI kit in `components/ui`): `Card`, `Table`/`Row`/`Cell`, `Badge`
  (neutral/success/warn/danger/accent/info), `Pill`, cadence chips, AI sparkle chip,
  `ProgressBar` (budget spent/allocated), timelines (receipt-reminder + reimbursement
  status), virtual-card art (red gradient), two-pane sticky detail on Reconcile.

## Phased rollout (single feature branch, PR per phase → merge to main)
0. **Foundation** (DONE, PR #89) — schema, shared tuples, `lib/finance.ts` authz, nav, API stubs.
1. **No-vendor core** — `finances.ts` real (funds/categories/teams/budgets, transactions
   CRUD/categorize/flagPersonal, dashboard/rollup/budgetVsActual/teamActuals) + dashboard/budgets/
   manual-entry UI + reconcile shell + `aiCoding.ts` + `financeRoles.ts`. Usable with no vendor.
2. Stripe FC sync. 3. Reimbursements (public form + receipts + reminders). 4. Increase ACH payouts.
5. Increase cards + personal repayment.
</content>
