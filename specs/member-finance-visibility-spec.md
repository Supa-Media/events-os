# Member finance visibility — every team member sees the books

**Status: PROPOSED — awaiting founder go-ahead. Nothing in this spec is implemented yet.**
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

`showFinances` becomes true for **any signed-in caller with a non-placeholder
roster person** in the chapter. The tier grandfather becomes redundant and is
folded in. Placeholder rows stay excluded (existing `viewerPerson` behavior).

### 3.2 Membership-derived viewer (`apps/convex/lib/finance.ts`)

Per the repo's "gate it behind a power" rule, the mechanism is the existing
resolver, not call-site edits: `getFinanceRole` unions a third source into
the role — alongside stored `financeRoles` grants and seat-derived powers,
**chapter membership itself derives `viewer` at the member's own chapter**.

- `FinanceAccess` grows `membershipOnly: boolean` — true when the role would
  be `null` without the membership baseline. Carve-outs (3.3) key on it.
- `getFinanceRoleAtScope("central")` is **unchanged**: membership grants
  nothing at central; org-level money still needs a central grant/seat.
- Every write stays bookkeeper/manager. Reconcile rows already render
  `canEdit: false` for read-only callers.

This automatically fixes two shipped inconsistencies the audit found:
`/finances/budgets/[id]` (member-visible glance links into a viewer-gated
detail) and `/finances/personal-charges` (linked from the member
reimbursements area but viewer-gated).

### 3.3 Carve-outs (what "the full thing" does NOT include)

Each stays behind an **explicit** finance role (stored grant or seat), i.e.
refuses `membershipOnly` access, via its existing named resolver:

1. **Contractor payments** (`lib/contractorPaymentsAccess.ts`) — a person's
   livelihood; the public ledger deliberately never names contractor payees
   (one-way door, Academy finance stream). Recommendation: keep gated.
2. **Publish console** (`lib/publicLedgerAccess.ts#requireLedgerConsole`) —
   a working surface holding unpublished drafts and preview tokens; a
   member reads published months on the public page like everyone else.
3. **Attendee names on coded transactions** (`requireCodingNamesView`) —
   internal-only forever (decided 2026-08-08); recommendation: keep at
   explicit-role, members see headcount + affiliation exactly as the public
   page does. (Founder may open this — flagged below.)
4. **Accounts tab** — unchanged, ED + FM only (PRD §0.2, owner-refined).
5. **Receipts desk, sales, coding review queue** — unchanged (bookkeeper+).
6. **Reconcile notes** — stays hidden from members; that is a separately
   tracked owner decision (`docs/plans/finance-handoff.md` open queue #5).

**Reimbursements queue** (others' reimbursements, viewer-gated today):
recommendation **open to members** — the public ledger already publishes
"Reimbursement to \<name\>" with amounts. Implementation must verify the
`list`/`get` payloads leak nothing beyond name/amount/status/receipts (no
bank-linking details) to a `membershipOnly` viewer.

### 3.4 Tab bar + screens (`apps/mobile/app/(app)/finances/`)

- `_layout.tsx`: the member (seatless) tab set becomes **Dashboard · Book ·
  Budgets · My Card · Reimbursements**. Seat holders keep `SEAT_TABS`.
  Drive the split from a capability summary (extend `financeRoles.mySeats`
  or a sibling query) rather than `seats.length` alone.
- `index.tsx`: drop the member redirect-to-cards and the client-side tier
  wall; members land on the (read-only) dashboard.
- Verify write affordances on Book/Budgets render nothing for a viewer
  (they already key on bookkeeper/manager access).

### 3.5 Cards — no policy change

The request→approve flow already matches the ask. Two follow-ups only:
make sure `MemberCardsView`'s "request a card" CTA is prominent once the
tab is visible, and confirm the `@publicworship.life` eligibility rule
still matches "everybody on the team" (flagged below).

### 3.6 Academy + governance (same-PR obligations)

- Academy finance stream teaches the member view as "card, receipts due,
  what-I-owe" — update the lesson(s) + quizzes to teach "every team member
  reads the books; editing needs a seat." Run the academy tests.
- `docs/plans/finance-v2-split-prd.md` §0.2 member row gets an amendment
  note pointing here (the PRD is historical record; don't rewrite it).
- Operating Manual: §4/§5 prose describing internal visibility gets a
  sentence; no money constants or anchored lifecycle blocks change.
  `governance.test.ts` should stay green — verify.

### 3.7 Tests

- `org.nav showFinances`: seatless member flips to `true`; placeholder
  still `false`.
- `getFinanceRole`: membership derives viewer at own chapter only; central
  unchanged; `membershipOnly` flag correct when a stored/seat grant exists.
- Carve-out resolvers refuse `membershipOnly` access.
- Member can read `listReconcile` (rows `canEdit: false`), `budgetDetail`,
  `dashboardChapter`; member writes (create/categorize/approve) still throw.

## 4. Decisions for the founder

1. **Contractor payments visible to all members?** Recommended NO (keep
   behind an explicit finance seat) — livelihoods, never published.
2. **Attendee names on transactions visible to all members?** Recommended
   NO — keep the narrow internal circle; members see headcount, as the
   public does.
3. **Card eligibility**: today a card requires a `@publicworship.life`
   email. Still the rule for "everybody on the team"?
4. **Others' reimbursements visible to members?** Recommended YES
   (consistent with the public ledger), with a payload-leak check.
