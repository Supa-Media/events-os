# Territories — addendum to the Giving Platform PRD (F-6)

**Status: shipped (Territories P2, this PR). Owner-approved.** This is an
addendum to `docs/plans/giving-platform.md` §5 (the public `/give` map). It
records the decisions that replace the `cityCampaigns` model with
**territories**, and supersedes PRD **B6** ("prospect cities are
`cityCampaigns`, not fake `chapters` rows") and resolves PRD **Appendix C#3**
(where prospect-city money is held).

## The model, in one line

A **territory** maps **1:1 with a real `chapters` row**. Creating a prospect
territory creates a real but inactive **"shadow chapter"** (`isActive: false`)
in the same mutation. Prospect pledges/donors/gifts scope **directly** to that
chapter. Launch is a flag-flip (`chapters.isActive: true`), not a data move.

## Decisions

### D1 — Territories 1:1 chapters (supersedes B6)

PRD B6 kept prospect cities OUT of `chapters` so "chapter" always meant
"operating chapter". That bought a clean noun at the cost of a whole parallel
scoping convention ("central + `cityCampaignId`") and a re-scope migration
deferred to launch. We reverse it:

- A territory **is** a chapter from creation. `isActive` — already on
  `chapters`, already the fleet-enumeration gate — is what distinguishes a
  shadow (prospect/raising) chapter from a live one. "Operating chapter" now
  means `isActive === true`.
- `territories.saveTerritory` is THE product chapter-creation flow the
  `seed.ts:ensureChapters` comment promised. It inserts the shadow chapter +
  the territory row atomically. Increase provisioning is **not** run at create
  — only at launch.
- There is no `backerCount` on a territory: the count is ALWAYS read from the
  linked `chapter.backerCount` (derived by
  `givingPledges.recomputeChapterBackerCount`). One number per place, no drift.
- Slug uniqueness is enforced against **both** `territories.by_slug` **and**
  `chapters.by_slug` (a shadow chapter carries the territory's slug).

### D2 — Direct-to-chapter scoping (resolves Appendix C#3)

Because a prospect territory's shadow chapter is a real `chapters` row, a
prospect backer's donor/pledge/gift scope **directly to that chapter** — the
"central-held + `cityCampaignId`" convention is retired. This resolves the
Appendix C#3 open question ("held designated for that city vs general central
revenue") by making it moot: the money was never central's; it belongs to the
(shadow) chapter from the first pledge.

- `preparePledge` takes a `chapterId` only. Guard: an **inactive** chapter is
  backable only through a `publiclyVisible` territory still in
  `prospect`/`raising` — otherwise NOT_FOUND (a bare inactive/demo chapter can
  never be pledged to).
- **Launch moves nothing.** `setTerritoryStage → launched` flips
  `chapters.isActive: true`, stamps `launchedAt`, schedules
  `internal.increase.provisionAccountForScope`, and seeds the chapter's default
  roles/templates (mirroring `ensureChapters`). Backers are already on the
  chapter. Launched is terminal in v1.

### D3 — The launch pot (rules set here; wiring next PR)

`territories.launchFundCents` (init 0) + `launchFundTargetCents` (default
`launchTemplateTotalCents()`) are on the schema now so the next PR needs no
second schema migration. The **rules**, recorded here:

- **100% accrual.** While a territory is `prospect`/`raising`, backer money
  accrues to its pot toward the launch grant.
- **Freeze at launch.** When the territory launches, the pot freezes — the
  chapter is live and funds itself from ongoing backer revenue (85/15 split).

The accrual/freeze **wiring is deferred to the next PR**; this PR ships the
fields only.

### D7 — The canonical import (Territories P6)

*(D4–D6, D8–D9 cover sibling Territories/Giving PRs, tracked in their own PRs'
docs, not renumbered here.)*

One row schema, two-phase (preview → commit), replaces the Givebutter-only
`importGivebutterCsv` (donors + gifts) and `importGivebutterRecurring`
(pledge-shaped cutover rows) — both deleted. The owner context that drove the
design: Givebutter consolidates ticket sales AND mission donations in the same
export, and the bank only ever sees the lump payout, never the split — so the
import must CLASSIFY every row before writing anything, or a ticket-sales file
imported naively as "gifts" inflates the donor CRM with everyone who ever
bought a ticket.

- **One row, four `rowType`s**: `gift` (match-or-create donor + a `gifts`
  row), `ticket` (NEVER a donor/gift — match-or-create a chapter `people`
  contact, best-effort link purchase history to a real event via `eventHint` +
  email), `contact` (match-or-create a person only), `recurring`
  (match-or-create donor + an `origin:"imported"`, `status:"past_due"` pledge —
  the same cutover shape `importGivebutterRecurring` used, ported verbatim).
- **Preview is read-only** (`previewImport`, a query): classifies every row
  via an in-memory per-call simulation (a query can't write) and returns a
  disposition + a summary — the gift/ticket row-count split is what catches a
  misclassified export before `importCanonical` commits anything.
- **Dedup**: a gift's `externalRef` is the authoritative global dedup key when
  present (`by_externalRef`); without one, a SUSPECTED-duplicate heuristic
  applies — same donor + same `amountCents` + `receivedAt` within 24h of a
  gift already counted for them — and is skipped on commit unless the caller
  passes `allowSuspected: true`. A recurring row dedups its `externalRef`
  within the matched donor's own pledges only.
- `findDonorInScope` (`lib/givingDonors.ts`) gained a phone-match fallback
  (email → phone → name) — the `by_scope_and_phone` index existed since P5 but
  was unused until this PR.
- See `apps/convex/givingImport.ts` for the implementation and full
  classification/dedup doc comments.

### D10 — Bank-credit gift candidates (Territories P7)

Some giving arrives as a direct bank credit (Zelle/wire straight to the
account) that never touches Stripe, so it never becomes a `gifts` row on its
own. The development team needs to SEE those credits and either confirm one
into a real gift (linked to the source transaction as evidence) or dismiss it.

- **`gifts.transactionId`** (+ `by_transaction`) is the evidence link.
  `transactions` stays the only actuals ledger — the link never causes a
  dollar to be summed twice; `confirmExternalGift` always takes the gift's
  amount/date FROM the transaction, never a client-sent value.
- **The exclusion rule** (a candidate is a recent inflow transaction that
  ISN'T…):
  1. **A card refund** — `cardId` set (the owner's heuristic: "a credit WITH
     an associated card is a refund of a card purchase, NOT a gift").
  2. **A transfer-flow leg** — `flow !== "inflow"` drops every skim /
     launch_grant / settlement / reimbursement / repayment leg (all always
     written `flow:"transfer"` by schema convention).
  3. **A provider lump-sum payout (Stripe or Givebutter)** — neither provider
     writes a dedicated `transactions.source` for "payout" today; a lump
     deposit lands via `stripe_fc`/`relay_csv` exactly like any other bank
     credit, but its bank-statement descriptor always NAMES the processor
     (`merchantName`/`description`). Excluded by a case-insensitive
     `"stripe"`/`"givebutter"` match on those two fields — a description
     convention, not a structural guarantee, deliberately narrow so a real
     donor is never coincidentally swept in.
  4. **Already gift-linked** — a row in `gifts.by_transaction`.
  5. **Already dismissed** — a row in `dismissedGiftCandidates.by_transaction`
     (a tiny append-only table: `transactionId` + `dismissedBy` +
     `dismissedAt`, a durable "not a gift" decision — no un-dismiss surface).
- **Access**: `candidateExternalGifts` uses the same dual gate as
  `prelaunchReadiness` — `giving.manage` at the scope OR central finance
  viewer rank — so a finance auditor can see what development is about to
  confirm as revenue even without a giving seat. `confirmExternalGift` /
  `dismissGiftCandidate` stay manage-only.
- See `apps/convex/givingCandidates.ts` for the implementation and full
  exclusion-rule doc comment.

## Migration & rollout

- `migrations/0029_territories_cutover.ts` seeds the New York territory
  (launched, on the live `new-york` chapter), turns every legacy `cityCampaigns`
  row into a territory (creating shadow chapters for prospect/raising rows), and
  re-scopes campaign-linked pledges/donors/gifts directly onto chapters with
  paired `applyScopeDelta`s so central/chapter rollups net to zero. Idempotent.
- Public URLs are unchanged (`/give`, `/give/<slug>`), so already-shared links
  survive the cutover.
- **Deploy B**: `cityCampaigns` (schema + `cityCampaigns.ts`) and
  `pledges.cityCampaignId` / `by_cityCampaign` stay registered ONLY so 0029 can
  read the legacy rows. A follow-up PR removes them once 0029 has run in prod —
  see the `DEPLOY-B(territories):` markers.

## Academy

Training-worthy: yes. The development-stream lessons were updated in the same PR
— "prospect city" → "prospect territory", the shadow-chapter model, and
direct-to-chapter scoping (the old "backers stay central-held until launch"
teaching is obsolete).

Territories P6 (D7, canonical import) also updated the stream in its own PR:
`dev-import-and-backfill` was rewritten end to end for the preview-then-commit
canonical import (retitled "The canonical import: preview, classify, commit"),
`dev-giving-vocabulary`'s "Gift" bullet + quiz now teach the gift-vs-ticket
classification rule, `dev-donor-crm-basics` gained a note on the People tab's
giver marks (P5, previously undocumented), and `dev-givebutter-migration`'s
import bullets point at the canonical import instead of the deleted
Givebutter-only tool.
