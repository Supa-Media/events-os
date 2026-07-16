# Finance v2 PRD — Building the Split

**Status:** APPROVED by owner 2026-07-16 ("Confirmed, go") · **Author:** Claude (orchestrator session, 2026-07-16)
**Source inputs:** owner voice feedback (2026-07-16), org chart (E-Myth structure), City Launch Playbook (Notion), current codebase state after PRs #128–#134.

---

## 0. Why this document exists

The finance page is not a bookkeeping tool. Its job is to **execute the City Launch Playbook's financial model in software**:

> A 5-person team + 25 backers at $50/mo makes a city self-sustaining — and a slice of
> every chapter funds the launch of the next.

Today one blended NYC team operates as both Central and Chapter. The playbook's split
(triggered at 25 non-team backers) requires the money to actually separate: central gets its
own budgets/teams/projects, the chapter gets a self-contained money loop, and ~239 historical
transactions get retroactively divided. **The software is the mechanism of the split.**

The organizing loop for all spending features is: **Plan → Approve → Spend → Reconcile.**
- Plan: budgets with categorized line items ("what do you plan to spend this $3,000 on")
- Approve: scope-aware approval — the delegation mechanism that makes the split function
- Spend: cards + reimbursements, free under the approved cap
- Reconcile: every dollar explicitly attached to its event/project/budget; unattributed
  dollars are loudly unattributed

**North-star metric:** a Chapter Treasurer closes their month in under 30 minutes, and the
central Financial Manager trusts every chapter's numbers without asking anyone.

## 0.1 Playbook facts the system must encode

These come from the playbook and are product constants (put in `packages/shared/src/finance.ts`
as editable constants, NOT hardcoded inline):

| Constant | Value | Notes |
|---|---|---|
| `BACKER_UNIT_CENTS` | 5000/mo | One person = one backer; headcount, never dollars |
| `CENTRAL_SKIM_PCT` | ~15% | Chapter → central City Launch Fund, monthly (open decision: flat vs escalating) |
| Tier table | **20/30/50 backers** → WWS / +Eden / +LTN | Owner-confirmed 2026-07-16 (the deep-dive numbers; the one-pager's 25/50/75 is stale) |
| Chapter operating formula | $520 fixed + $50/teammate | + conference sinking fund per funded seat ($275÷12 east / $500÷12 flight) |
| Monthly operating floor | $770 (5-person team) | Line items: WWS film $200 · WWS food $160 · transport $100 · meeting food $100 · storage $60 · software $150 |
| One-time launch cost | ~$7,800–8,300/city | Equipment ~$4,300 + NYC training trip ~$3,500–4,000; funded by central |
| Conference lodging cap | $200/person | Chapter funds its delegation; central caters sessions |

**Money flows the system must model (both directions):**
- **UP:** ~15% skim, chapter → central City Launch Fund, recurring monthly
- **DOWN:** one-time launch grant, central → new chapter (equipment + training trip)

## 0.2 Seats (from the org chart) and their finance surface

| Seat | Scope | Finance page role |
|---|---|---|
| Executive Director | central | Sees everything; approves central budgets; Accounts access |
| Financial Manager | central | **Approves and audits ALL chapters** (playbook: treasurers report up to FM); chases receipts; Accounts access; the drill-down (#131) is their audit tool |
| Chapter Director | chapter | Raises money (backers); approves chapter budgets; sees chapter dashboard. Playbook mirror: ED + Development |
| Treasurer | chapter | Records & manages: Reconcile grid is their home; budgets, records, reimbursements. Playbook mirror: Financial Manager. **Never fundraises** |
| Event/Music/project Leads | chapter or central | Budget *requesters*: submit plans for approval, spend under cap. See their own event/project Money tab — NOT the finance dashboard |
| Member / cardholder | — | Card, receipts due, what-I-owe / what-I'm-owed. Nothing else |

**Raise → record → oversee across three different people** (playbook rule): Director raises,
Treasurer records, central FM oversees. This is a mandated three-party separation — identity-based
SoD (already built, keyed on personId) enforces approver ≠ requester within it.

**Dual-hatting is a transition state, not a feature.** Today the same humans hold central and
chapter seats (Seyi = ED + Chapter Director). Post-split, the playbook says "no dual-hatting
across both teams." So: model **seats** (one person, multiple real seats), give multi-seat
holders an honest **seat switcher** ("which desk are you at?"), and treat multi-seat as a
transition-period state that naturally empties out at the split. This replaces the fake
Preview-as switcher, which is deleted.

Out of scope for this page, forever: **backer/donor management** (Development Director's
future Giving page). The finance page consumes backer *count/revenue* as an input (tier →
budget envelope) but never manages donors. This separation is deliberate playbook governance.

---

## 1. Invariants (restate in every work package — agents must not violate)

1. Money is integer `amountCents`; direction is `flow` (`outflow`/`inflow`/`transfer`), never a sign.
2. `transactions` is the ONLY table summed for Actuals. Estimated (budget lines, `events.budget`,
   `projects.budgetUsd`, item costs, engagements) is NEVER summed with Actuals.
3. `flow:"transfer"` rows are excluded from category/budget spend (skim transfers, launch grants,
   reimbursement payouts, repayments are all transfers).
4. Every finance table chapter-scoped; central is the string sentinel `"central"`, never null.
5. Authz through `apps/convex/lib/finance.ts`; failures are `ConvexError`, never `Error`.
6. SoD is identity-based (personId + auth email), never role-based; approver ≠ requester, payer ≠ payee.
7. Enum tuples in `packages/shared/src/finance.ts`; validators built from them.
8. TDD with convex-test; CI green before merge; merge = prod deploy — money movement must stay
   gated (account active + destination + sandbox off) so a merge never fires real money.

**Agent execution rules:** one WP = one PR = one agent in an isolated worktree. No design
decisions inside a WP — if a WP is ambiguous, STOP and report, don't improvise. Schema changes
only where the WP explicitly grants them. Adversarial review before merge; findings fixed or
explicitly waived by the owner.

---

## 2. Work packages

### Phase 0 — Trust the numbers *(prerequisite for everything; do first)*

**WP-0.1 · Kill derived attribution (fixes the "Education & Growth eats everything" bug)**
- Root cause: `matchesBudgetNarrowers` (`apps/convex/finances.ts` ~626) returns true vacuously
  for a recurring budget with no category/fund/team narrowers → it derive-matches every
  uncategorized txn in period.
- Change: budget "spent" totals count ONLY transactions with an explicit `budgetId` link
  (the linked-only rule already used for tag totals — make it universal). Delete derive-matching
  (`matchesBudget`/`matchesBudgetNarrowers` and callers). Dashboard shows an explicit
  **"Unattributed: $X"** bucket for spend with no budgetId — loud, first-class, with a one-tap
  path into Reconcile filtered to those txns.
- Migration note: audit existing rollups/tests that relied on derive-matching; update tests to
  assert the new rule. No schema change.
- Files: `finances.ts`, dashboard components, tests. ~1 agent.

**WP-0.2 · Seats + seat switcher (replaces Preview-as) — owner-approved: no preview of any kind**
- Resolve the caller's real seats from financeRoles + specialized roles. Route by seat:
  central seat → central dashboard; chapter seat → chapter dashboard; no finance seat → member view.
- If (and only if) a person holds seats at BOTH central and a chapter: render a seat switcher
  listing their REAL seats. Single-seat users never see a switcher. Delete the Preview-as UI.
- Files: `apps/mobile/app/(app)/finances/index.tsx`, `_layout.tsx`, dashboard components;
  a `mySeats` query in convex. ~1 agent.

**WP-0.3 · Central budgets UI + central rollup row**
- "New budget" flow available in the central dashboard creating `chapterId:"central"` budgets
  (backend already supports the sentinel — this is UI + the query plumbing).
- Central appears as its own row in the by-chapter rollup with the same drill-down behavior
  chapters got in #131.
- Files: dashboard components, `finances.ts` (central rollup inclusion), tests. ~1 agent.

**WP-0.4 · Land the in-flight work** (already specced, resume — not new agents' scope):
`#134` (authz hardening — review then merge), `#135` (receipt timeline — rebase then review/merge),
A2+A3 (ACH destinations + paid→returned reversal — finish, review, merge).

### Phase 1 — Model the org

**WP-1.1 · Seat vocabulary + role mapping**
- Name the seats per the org chart: `executive_director`, `financial_manager` (central);
  `chapter_director`, `treasurer` (chapter). Map onto the existing specialized-roles/financeRoles
  system (treasurer = the chapter finance manager/bookkeeper seat; do NOT build a parallel roles
  system). Growth-team leads (event/music/marketing) are NOT finance seats — they interact only
  via budget requests (Phase 3).
- Update Governance page labels accordingly. Constants for seat names in shared.
- ⚠️ naming: owner says "president" verbally, chart says "Chapter Director" — use **Chapter
  Director** in UI copy, keep identifiers generic.

**WP-1.2 · Accounts go fully opaque + automatic (owner-refined 2026-07-16)**
- **One Increase account per chapter INCLUDING CENTRAL** — central's own account is where the
  City Launch Fund lives (feeds WP-4.1's skim destination). Account creation is fully
  automatic: (a) a backfill ops function provisions an account for every chapter (and central)
  that lacks one; (b) new chapters get an account auto-provisioned at creation. Idempotency-Key
  discipline from #123 applies (no duplicate-account cascades).
- **No manual linking in the normal path** — `linkIncreaseAccount` demotes to an ops escape
  hatch (run-convex-function workflow only); the paste-an-id UI is removed. Owner deletes the
  stray manually-created accounts on the Increase dashboard; the backfill creates fresh ones.
- Accounts tab becomes a quiet **status/audit view** visible ONLY to ED + FM seats (tighter
  than #134's central-scope gate — build on it). Chapters never see any of it — they just have
  a working card program. Relay/legacy sections: same ED/FM-only visibility, collapsible in Cards.
- Files: `accounts.tsx`, `_layout.tsx` gating, `increase.ts` (backfill fn + auto-provision
  hook + gate tightening), tests.
- Context: the 2026-07-16 prod link/provision failures were a corrupted `INCREASE_API_BASE`
  (trailing comma in the 1Password fields, faithfully synced to Convex) — fixed at source and
  re-synced. #128's error diagnostics found it; keep error surfaces that specific.

**WP-1.3 · Member view strip-down + bidirectional owe surface + copy sweep**
- Members (no finance seat): tabs reduce to My Card · My Transactions (mini-reconcile: attach
  receipt, flag personal on OWN txns only) · Reimbursements (submit + "what I'm owed" + "what I owe").
- Manager-initiated personal flag: ED/FM/Chapter Director/Treasurer can mark any chapter txn
  as personal-expense-needing-repayment → triggers the owe flow for that cardholder.
- De-church copy sweep: "church card" → "Public Worship card", etc. (grep-driven, copy-only).

**WP-1.4 · "Defund" the UI — funds go backend-only (owner-directed 2026-07-16)**
- Everything is unrestricted today; fund pickers are pure noise for treasurers/FMs (and the
  owner). Funds stay in the schema (donor-restricted giving may resurrect them via the future
  Giving page) but disappear from the product surface.
- (a) **One General Fund per chapter**: migration merges the second seeded fund into General
  Fund (reassign all fundId references), and the seed stops creating two. (b) Server-side
  default: every creation path (budgets, transactions, synced accounts) silently assigns the
  chapter's General Fund — no picker required anywhere. (c) **Hide every fund UI control**:
  budget create/edit fund+designation pickers, the Accounts "Default fund" selector, fund
  labels/filters wherever rendered. The existing "hide when ≤1 fund" rule becomes true
  everywhere once (a) lands — extend it to the surfaces that ignore it rather than adding a
  parallel mechanism.
- Sonnet-tier; dispatch after WP-0.1 merges (dashboard-file overlap). Migration runs via
  `run-convex-function.yml`.

### Phase 2 — The split (the headline event)

**WP-2.1 · Let money belong to central**
- Schema: `transactions.chapterId` → `v.union(v.id("chapters"), v.literal("central"))`
  (`schema/finances.ts:189` — the never-built "PR 4"). Audit EVERY query/rollup touching
  `transactions.chapterId` (indexes still work — sentinel is a string key) and every
  `.withIndex("by_chapter")` caller for central-correctness. High-blast-radius; one agent,
  full-suite green required, extensive tests.

**WP-2.2 · Bulk reattribution + audit trail**
- Reconcile multi-select gains "Reassign to → Central / [chapter]". Writes an audit record
  (who, when, from→to, txn ids). Rule-assisted suggestions seeded from the playbook's boundary
  table (canon-event-linked → chapter; expansion/conference/brand merchants → central) — rules
  suggest, human confirms, never auto-applies.
- Also covers **project ownership transfer** (playbook Step 3: "all current NY projects transfer
  ownership") — a project moves scope with its budgets and linked txns in one operation.

**WP-2.3 · Split runbook** (doc, not code): the operational checklist for split day — run the
backer campaign check, reattribute history per the boundary table, transfer projects, seat the
new Chapter Director, empty the dual-hat seats. Lives in `docs/plans/`.

### Phase 3 — Plan → Approve → Spend

**WP-3.1 · Budget line items**
- `budgetLineItems` (or embedded lines): description, categoryId, plannedCents. A budget's plan
  is the sum of its lines. Estimated-side only (invariant #2).

**WP-3.2 · Budget approval workflow**
- States: `draft → submitted → approved | changes_requested`. Approver by scope: chapter budget →
  Chapter Director (Treasurer can also approve if Director submitted — SoD picks the other);
  central budget → ED (FM if ED submitted). Identity SoD throughout; when one human holds both
  sides, escalate to the other central officer.
- Approved = spend freely under `totalCents` cap. Over-cap = loud warning on the budget +
  dashboard attention item (advisory now; card-control integration explicitly deferred).
- The FM sees a cross-chapter approval/audit queue (extends the attention queue from #131).

**WP-3.3 · Event Money tab**
- One tab on the event page assembling what already exists: planned side = budget lines + gear
  items marked needs-payment + people engagements with amounts + `events.budget`; actual side =
  txns linked via `eventId`. Grouped by category (people / location / gear / supplies / other),
  planned vs actual per group. AI auto-coding (shipped #132) suggests the links.
- The $3,000 music-project scenario is the acceptance test, via WP-3.4's identical component.

**WP-3.4 · Project Money tab + auto-budget per project**
- Same component, parent = project. Auto-create a one_time budget per project (mirror #125's
  per-event backfill + a create-time hook). Project budgets tag-linkable (e.g. "experimental")
  for rollups — keep tags as-is, no new tag investment (owner: "budgets down pat before tags").
- **Owner rule: budgets only exist when money does.** Many projects (and events) are
  work-tracking only — time, $0 — so no budget object is created unless a positive dollar
  amount is entered, whether at creation or later (entering a number on a previously $0/unset
  project or event summons its budget then). Zero-budget projects/events stay budget-free; a
  one-off ops cleanup (`removeEmptyAutoBudgets`) removes the zero-amount budgets the pre-rule
  backfills created. Events get the identical create-time hook + rule (parity with projects).

**WP-3.5 · Chapter budget template ("one repeatable structure any city can carry")**
- Stamp a new chapter with the standard recurring budgets from the playbook's operating table
  ($520 fixed lines + per-teammate + conference sinking fund), as editable defaults. Template
  lives in shared constants (see §0.1). This is how central launches a city with its finances
  pre-modeled.

### Phase 3.5 — Cards v2 (owner-directed 2026-07-16)

Card management grows from manager-issued-only into a full lifecycle, plus brand + wallet.
Digital only — no physical cards.

**WP-C.1 · Card lifecycle** — (a) **self-serve freeze/unfreeze**: every cardholder can freeze
their OWN card instantly (suspected foul play), distinct from the receipt auto-lock; (b)
**cancel/close**: FM + Treasurer seats only; (c) **request-a-card**: members request → FM/
Treasurer approves → card issues (keep direct-issue for managers). Card carries the holder's
name (verify name flows to Increase at issuance). Builds on cards.ts issue/lock/setControls.

**WP-C.2 · Card art + Digital Card Profile** — 1536×969 PNG (white PW kneeling logo on brand
red `#D23B3A`; draft generated 2026-07-16, needs the Visa logo placed per Visa's Figma/
Illustrator template — owner/designer step) + 100×100 notification icon. Upload via the
Increase Files API → create a Digital Card Profile → attach to new cards + backfill existing;
last-4 text color white. Spec: increase.com/documentation/card-art.

**WP-C.3 · Digital wallet (Apple/Google Pay)** — wallet tokenization flows through the SAME
real-time decisions system as card auth: handle `real_time_decision.digital_wallet_token_requested`
(approve active+unlocked cards, decline locked/canceled) and `digital_wallet_authentication_requested`
(2FA one-time-code contact methods from the cardholder's person record) in the existing
webhook. In-app secure card-details reveal enables manual add-to-wallet on day one; native
push-provisioning ("Add to Apple Wallet" button, requires Apple PassKit entitlement) is
explicitly DEFERRED. **Dependency: the RTD-enablement support request covers this too — the
message to Increase should mention digital wallet tokenization alongside card authorizations.**

### Phase 4 — The model's money flows

**WP-4.1 · The skim**: monthly chapter → central transfer (~15% of backer revenue). Modeled as
`flow:"transfer"` pairs; automated via Increase account-to-account transfer once accounts are
live. Central City Launch Fund = a central fund whose balance is visible.
**WP-4.2 · Launch grants**: central → new-chapter one-time transfer with a stamped launch budget
(equipment ~$4,300 + training trip lines). The launch grant and the launch budget are created together.
**WP-4.3 · Affordability header** (chapter dashboard): backers → tier → monthly envelope → floor
→ surplus → skim → **discretionary**. Answers "can we afford this event?" in one line. Backer
count is manual-entry until the Giving page exists (explicit stub, no donor management here).
**WP-4.4 · Conference sinking fund**: a recurring budget that accumulates rather than resets
(the one genuinely new budget behavior; per-funded-seat monthly savings).

### Phase 5 — Enablement (Academy)

The finance system only works if every role knows their part. The Academy (existing module —
see `docs/plans/academy-redesign.md` and the academy code; three streams, role capstones)
gains a **Finances section** with progressively intense courses. Content must teach the
workflows this PRD builds, so author alongside Phases 0–3 and publish per phase.

**WP-5.1 · Finances curriculum structure** — study the existing academy stream/course/module
model FIRST; add the Finances section wired into it (no parallel content system). Courses:

| Course | Audience | Covers |
|---|---|---|
| **Finances for Everyone** | all members | Where PW money comes from (backers — stewardship framing); what to spend / not spend on; using your card + the 7-day receipt rule; asking for reimbursement; flagging a personal charge; **getting a budget approved for your event/project** (basics) |
| **Treasurer** | chapter treasurers | The Reconcile workflow; chasing receipts; the three buckets; monthly close (<30 min target); reimbursement queue; reporting up to the central FM |
| **Chapter Director** | chapter directors | Raise-vs-manage separation; approving budgets — the 85% principle, mission/vision confines; why SoD blocks self-approval; tiers & the covenant; the skim |
| **Financial Manager** | central FM | Cross-chapter audit + drill-down; approvals oversight; receipt escalation; accounts & cards administration; the City Launch Fund |
| **Executive Director** | central ED | Central budgets; launch grants; governance/seat assignment; transparency duties |

Placement decision (owner was unsure): budget-approval basics live in **Finances for
Everyone**, with pointer modules from event/project training — approval is a finance workflow,
so it's taught once, referenced everywhere.

**WP-5.2 · Course content authoring** — one agent per course, cheap-model-friendly (content
work). Gate each course's publication on its underlying features existing (e.g. don't publish
the approval module before WP-3.2 ships).

---

## Appendix A — Flagged future features (documented, not scheduled)

Owner-flagged 2026-07-16, riding on "finances + events + inventory now live in one place."
Each is spec-sketched enough to promote to a WP later; none blocks Phases 0–5.

**F-1 · Equipment purchase → Inventory link.** When a transaction is categorized as equipment
(category match or merchant heuristic), Reconcile prompts "Add to inventory?" → creates an
inventory item linked to the txn (purchase price, date, chapter). Equipment-category txns
without a linked inventory item become a treasurer/FM reconciliation nudge ("physical items
must have an inventory record — it's ours, wherever it lives").

**F-2 · Returns → inventory.** An inflow/refund transaction can link to the inventory item it
reverses → item marked returned/disposed; the money and the stuff stay in sync.

**F-3 · Custody & liability.** Inventory items track custody (whose house is it at). If
inventory says an item is with a person and it's lost/unreturned, generate an owed-to-PW
charge through the personal-expense/"what you owe" flow (WP-1.3) — custody creates
accountability, not just records.

**F-4 · Mini-budget rollups to the FM.** Already covered: Event/Project Money tabs (WP-3.3/3.4)
+ the FM's cross-chapter audit queue (WP-3.2) ARE this feature. No new work.

**F-5 · Chapter-innovation adoption.** A mechanism for a chapter's novel project to be adopted
by other chapters/central (owner: central makes canon, chapters innovate). Giving-page-era idea.

**F-6 · Giving platform (separate PRD when ready).** Internal build on Stripe: $50 backer
floor with above-and-beyond; **church-backer class** (~$200–300/mo, tied to a regional church
list used for evangelism follow-up); backer counts feed WP-4.3's affordability header and the
tier system. Owned by the Development side, separate surface from finance.

---

## 3. Owner decisions (resolved 2026-07-16)

1. **Tiers: 20/30/50 backers** (deep-dive numbers are current; one-pager stale).
2. **Music project is CENTRAL-owned** — organized across chapters; per-chapter recording
   infrastructure doesn't make sense. NYC *event* music (worship at events) stays local.
   This is the one explicit exception to playbook Step 3's "all NY projects transfer" —
   WP-2.2's reattribution rules must reflect it.
3. **Skim: flat 15% confirmed.** Framing: backer *revenue* is managed on the future Giving
   page; the skim is a real chapter→central money *movement*, so finance models the transfer
   (WP-4.1) while giving manages the income. **The 85% principle (owner-stated):** within
   their 85%, chapters go wild — the Chapter Director approves freely within mission/vision.
   Consequence for WP-3.2: chapter budgets are approved BY THE CHAPTER DIRECTOR, never
   pre-approved by central; central's control is the FM's audit oversight, not a gate.
   No templated projects: "anything that comes from central is gospel" (central projects
   like merch don't replicate down). Future concept (not a WP): a mechanism for a chapter's
   innovative project to be adopted by other chapters/central.
4. **Backer platform will be built internally** — the future Giving page IS the platform
   (Stripe-based; $50 backer floor with above-and-beyond giving; plus a church-backer class
   at ~$200–300/mo tied to a regional church list for evangelism follow-up). Separate PRD
   when ready; finance's WP-4.3 uses a manual backer count until then.
5. **WP-0.1 (explicit-only attribution): CONFIRMED** — derived budget matching dies entirely;
   explicit `budgetId` links only + loud "Unattributed" bucket.

## 4. Sequencing & dependencies

```
Phase 0: WP-0.4 (in-flight) ─┐
         WP-0.1 ─────────────┼─→ Phase 1 (WP-1.1 → WP-1.2/1.3) ─→ Phase 2 (WP-2.1 → WP-2.2 → split day)
         WP-0.2 → WP-0.3 ────┘                                        ↓
                                       Phase 3 (WP-3.1 → WP-3.2; WP-3.3/3.4 parallel; WP-3.5 after 3.1)
                                       Phase 4 (WP-4.x after Phase 2; WP-4.3 anytime after 0.1)
```
Rules: WPs touching `finances.ts`/dashboard files serialize unless explicitly disjoint (learned
the hard way — three rebase-conflict cycles on 2026-07-16). Phase 2 WP-2.1 merges alone on a
quiet main. A live Playwright pass over the deployed app gates the start of each phase.
