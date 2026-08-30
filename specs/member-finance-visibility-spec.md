# Member finance visibility — every team member sees the books

**Status: SHIPPED 2026-08-30.** Founder approved all four open decisions in §4.
This file records the design AS BUILT; §3.2 in particular changed during
implementation, and why it changed is the most useful thing here.
Branch: `claude/finances-tab-visibility-qcrw2s`. Date: 2026-08-30.

## 0. The ask (founder, 2026-08-30, paraphrased)

> People can't see the Finances tab to manage their cards. Everybody on the
> team should be able to get a [Public Worship] card, and therefore see
> Finances — reimbursements and the rest. Honestly they can see the ledger
> too, the full thing — it's public anyway. They just can't edit.

Three parts: (a) the tab is invisible to plain members — fix it; (b) every
team member can get a card; (c) members get **read** access to the books,
never write.

## 1. Why the tab is hidden today (the actual bug)

The member finance experience **already exists and works** — it was built as
WP-1.3 of `docs/plans/finance-v2-split-prd.md` (member tabs: My Card ·
Reimbursements · Budgets; self-scoped reimbursement submit; `cards.myCard`
needs no finance role at all; `cards.requestCard` needs only a roster person
with a `@publicworship.life` email). But the **nav tab that leads to it is
gated separately** in `apps/convex/org.ts` (`showFinances`, ~line 297): it
shows only for tier `admin`/`lead` (a transition grandfather) or a seat
carrying any `finance.*` power.

So a plain team member — exactly the person the member view was built for —
has no way to reach it except a deep link. The two halves of the same PRD
work package disagree; WP-0.2's routing rule ("no finance seat → member
view") presumes members arrive at all.

## 2. What the product requirements say today

- **PRD §0.2** (`finance-v2-split-prd.md`): member/cardholder = "Card,
  receipts due, what-I-owe / what-I'm-owed. Nothing else." The founder's ask
  above **supersedes the "nothing else"** — this spec is the amendment.
- **Budgets glance is already open to every member** — prior owner decision,
  recorded at `apps/convex/finances.ts` (~6266): "per the owner every team
  member should see it," driven by the FM's ask that cardholders shouldn't
  have to ask before swiping.
- **The books are public** — Bylaws Article XI (draft) + shipped public
  ledger (`docs/plans/public-ledger.md`): every non-excluded transaction
  publishes, month by month, with named redactions (donor identities,
  attendee/traveler names, per-person compensation). "The fact of knowing
  that the transactions are going to be public is going to really get the
  team on their toes."
- **Cards are person-owned and request-based** — any member can request one
  (one open request at a time), FM/Treasurer approves, optional Academy
  course gate at issuance. No change needed to policy; the surface just has
  to be reachable.
- **Open question this resolves**: `specs/pm-budgets-spec.md` Q1 (should a
  seatless cardholder see line-level budget expenses?) — the founder's "they
  can see the full thing" answers it **open**.

## 3. The change

### 3.1 Nav (`apps/convex/org.ts`)

`showFinances` is true for **any caller with a non-placeholder roster person**,
except the `volunteer` tier — somebody signed up to help at one event, whose
lobby is Briefing and nothing else by design. `admin`/`lead` stay listed
explicitly so a chapter admin with no roster row of their own keeps the tab.
The seat-derived `hasFinancesNavSeat` helper is deleted with the old gate.

### 3.2 A named books-read power (`apps/convex/lib/booksAccess.ts`)

**This is the part that changed during implementation, and the change matters.**

The plan was to make `getFinanceRole` derive `viewer` from chapter membership,
so a member would pass every `requireFinanceRole(..., "viewer")` in the app.
Counting the call sites killed it: **~50 gates sit at the viewer rank**, and
they are not one surface. They include the Increase/Stripe payout rails
(`increasePayouts.ts`, `stripeFinance.ts`), bank-account reads
(`increaseAccounts.ts`), processor fee detail, the donor-adjacent
`givingCandidates.ts` and `territories.ts` lookups, and event
`registrationsAccess.ts`. Lowering the floor opens all of them at once and
leaves every carve-out to be *remembered* — an opt-OUT design whose failure
mode is silently publishing somebody's bank rail or a donor's name to the whole
team because a resolver wasn't on the list.

So the power is its own resolver, granted per surface:
`lib/booksAccess.ts#requireBooksRead`, whose body today is a membership check
(the same membership `budgetsGlance` has always used) and which graduates to a
`finance.books.read` capability string the day the org wants it narrowed.
Opening a screen is now an explicit edit to that screen's gate, and the failure
mode inverts: a surface nobody thought about stays CLOSED, and a member reports
a lock icon instead of a stranger reading the payout rails.

`getFinanceRole` and the graded ladder are **untouched**. Every write stays
bookkeeper/manager.

Four surfaces opted in — see 3.4. This also fixed the shipped inconsistency
where the member-visible Budgets glance linked into a viewer-gated detail page.
`/finances/personal-charges` was left gated instead (see 3.3).

### 3.3 Carve-outs (what "the full thing" does NOT include)

Because the design is opt-in, **none of these needed a guard written against
them** — they were simply not changed, and still sit on `requireFinanceRole` /
`requireFinanceCentral` as before. Founder confirmed all four decisions in §4:

1. **Contractor payments** (`lib/contractorPaymentsAccess.ts`) — a person's
   livelihood; the public ledger deliberately never names contractor payees
   (one-way door, Academy finance stream). **Kept gated.**
2. **Publish console** (`lib/publicLedgerAccess.ts#requireLedgerConsole`) —
   a working surface holding unpublished drafts and preview tokens; a
   member reads published months on the public page like everyone else.
3. **Attendee names on coded transactions** (`requireCodingNamesView`) —
   internal-only forever (decided 2026-08-08). **Kept gated** — members see
   headcount + affiliation exactly as the public page does.
4. **Accounts tab** — unchanged, ED + FM only (PRD §0.2, owner-refined).
5. **Receipts desk, sales, coding review queue** — unchanged (bookkeeper+).
6. **Reconcile notes** — still hidden from members, since the Book itself did
   not open; that remains a separately tracked owner decision
   (`docs/plans/finance-handoff.md` open queue #5).
7. **Roster-wide personal charges** (`cards.listPersonalRepayments`) — who owes
   the org for a mis-swipe is a debt between one person and the organization,
   not a line of the books. Members see their own via `myPersonalRepayments`.
   This is the one place the plan changed direction: rather than opening it to
   fix the member-satellite link, it stayed closed.

### 3.4 What actually opened, and the tab bar

Member tabs are **Ledger · My Card · Reimbursements · Budgets**. The plan said
Dashboard + Book; both were dropped, for the same reason:

- **A new read-only Ledger screen**, not the Book. `reconcile.tsx` is 2,660
  lines of working surface — bulk coding, the receipt chase, nudges, the publish
  console — and a read-only copy would mean auditing every affordance now and
  again each time that screen grows one. The Ledger instead renders
  `publicLedger.teamStatement`, which reuses the PUBLIC page's own snapshot
  builder and projection. That reuse is the redaction guarantee: attendee names,
  contractor payees and donor identities are excluded once, in the builder, for
  both readers, and cannot drift apart later. A member sees what the world will
  see when the month publishes — earlier, and for months still open.
- **The dashboard stays a seat tool.** Its drill-downs, chase queues and manager
  tiles are writes a member would be refused. `index.tsx` redirects a seatless
  caller to the Ledger, and its client-side tier wall is gone.
- **Budget line detail** (answers §4's Q1 open) and **the chapter's
  reimbursement queue** opted in as planned.

One gap found while wiring the client: `BudgetApprovalActions` rendered
Approve / Request-changes off the budget's STATUS alone, so a member opening a
submitted budget would have been shown buttons that throw. `getBudgetDetail`
now returns `canSubmit`/`canDecide` mirroring the mutations' own gates, and the
component takes them as props.

### 3.5 Cards — no policy change

The request→approve flow already matches the ask. Two follow-ups only:
make sure `MemberCardsView`'s "request a card" CTA is prominent once the
tab is visible, and confirm the `@publicworship.life` eligibility rule
still matches "everybody on the team" (flagged below).

### 3.6 Academy + governance (same-PR obligations)

- Academy: a new "The team reads it first" rule block on
  *Publishing the books* teaches the Ledger tab and that the redactions are
  already true of the internal copy; the reimbursements bullet now says the
  chapter's queue is visible team-wide; the *Finances for Everyone* course
  description names the Ledger. The *three tracks* lesson's "tap any budget to
  drop it open" line was aspirational-but-false before this change (detail was
  viewer-gated) and is now simply true. Academy + snapshot tests green.
- `docs/plans/finance-v2-split-prd.md` §0.2 member row gets an amendment
  note pointing here (the PRD is historical record; don't rewrite it).
- Operating Manual: §4/§5 prose describing internal visibility gets a
  sentence; no money constants or anchored lifecycle blocks change.
  `governance.test.ts` should stay green — verify.

### 3.7 Tests (as built)

`apps/convex/tests/teamLedger.test.ts` — 13 new:

- a seatless member reads their chapter's month, published or not;
- a caller with no roster profile, and one whose only roster row is a
  placeholder, are both refused;
- the month picker reaches the book's earliest transaction (the fixed-window
  bug the publish console already had to fix once — founder, 2026-08-12);
- writes still throw: `createManualTransaction`, `approveBudget`;
- every carve-out still refuses: reconcile, contractor payments, the publish
  console, roster personal charges;
- the reimbursement queue opens, and its payload carries no bank fields or
  token; deciding on one still throws;
- budget detail reads, with `canEdit`/`canSubmit`/`canDecide` all false.

`tests/lobbies.test.ts` — the two `showFinances` cases that pinned the old
policy are inverted (seatless member → `true`), a volunteer-tier case is added
(→ `false`), and the placeholder case is unchanged (→ `false`).
`tests/reimbursements.test.ts` — "a non-viewer cannot read the queue" becomes
"a member with no finance role reads the queue", plus a new case that somebody
with no roster profile still cannot.

## 4. Decisions — all answered by the founder, 2026-08-30

1. **Contractor payments visible to all members?** **NO.** Livelihoods; the
   public ledger never names a contractor payee, and that is a one-way door.
2. **Attendee names on transactions visible to all members?** **NO.** Members
   see headcount and affiliation mix, exactly as the public does.
3. **Card eligibility.** Confirmed: "everyone on the team that wants a card has
   a publicworship.life email" — the existing `isCardEligible` rule stands, no
   code change.
4. **Others' reimbursements visible to members?** **YES.** The payload was
   checked before widening: a name, an amount, a status, dates, a receipts-state
   summary — no bank account, no last4, never the token, i.e. no more than the
   public ledger already prints of a paid reimbursement. The individual request
   (`get`) deliberately did not widen with the list: it opens receipts, line
   items and the payout trail.
