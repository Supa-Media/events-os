# Giving Platform (F-6) — backers, donors, sponsorships, and the city map

**Status: PRD, first pass (2026-07-18). Nothing here is built yet.** This is the
"separate PRD when ready" that `finance-v2-split-prd.md` Appendix F-6 promised.
Source material: the City Launch Playbook (Notion), the AJ/Seyi development
1:1s (Nov 2025 – Jul 2026), and the seams the finance build deliberately left
open. Owner review needed on the Appendix C open questions before Phase 1 starts.

## 0. Why now, and the contract with finance

Public Worship is moving **all giving off Givebutter onto chapter OS**. That
means this feature is load-bearing from day one: it must work for central, for
the NYC chapter, for chapters to come, for the development team, and for the
supporters themselves — and it must be transparent to all of them.

The finance system was built to *consume* backer revenue without owning donors.
The contract (finance-v2-split-prd §0.2, F-6, owner decision #4) is:

> **Giving owns donors and backer revenue. Finance consumes backer count and
> models the money movements.** The finance page never manages donors; the
> Giving page never becomes a second ledger.

Seams already waiting for this build:

| Seam | Where | What it says |
|---|---|---|
| Manual backer count | `chapters.backerCount` (`apps/convex/schema/chapters.ts`) | "MANUAL entry until the Giving page (F-6) exists to report it directly" |
| Affordability model | `chapterAffordability()` (`packages/shared/src/finance.ts`) | backers × $50 → tier → floor → 15% skim → discretionary |
| Skim + launch grants | `apps/convex/transfers.ts` | chapter→central City Launch Fund transfers, already modeled |
| Development seats | `packages/shared/src/seats.ts` | `development_director`, `fundraising_associate`, `partnership_associate` — all `capabilities: []` today |
| Event donations | `apps/convex/giving.ts` + `donations` table | one-time card/cash giving per event, shipped (M5.1) |
| Donor-restricted funds | `funds.restriction: "designated"` | dormant-but-ready (`lib/seed/finance.ts` comment) |
| Blast audience | `giving.md` deferred list | "a 'donors' blast audience" explicitly deferred to here |

### Vocabulary (canonical — the Academy will teach these)

- **Donor** — any person or org that has ever given. The CRM record.
- **Backer** — a donor with an **active recurring monthly pledge** to a specific
  city (live chapter or prospect city). Backers are what the affordability
  tiers count. $50/mo is the floor (`BACKER_UNIT_CENTS`), above-and-beyond
  welcome; a **church backer** is the same mechanic at a higher unit
  (~$200–500/mo, owner to confirm — F-6 said $200–300, the Jun 2026 strategy
  said $500).
- **Sponsor / partner** — an *organization-level relationship* (church,
  business, foundation) attached to a **sponsor package tier**, possibly tied
  to specific events (Love Thy Neighbor, Field Day) or a full year.
- **Prospect city** — a dot on the map raising backers toward a chapter launch
  ("potential chapter in Ohio"). Not a `chapters` row until it launches.
- **Gift** — one dollar-amount received, ever, from any source (Stripe cycle,
  cash, check, imported Givebutter history, in-kind). The unit of giving
  history.

## 1. Donor CRM — the development team's desk

The heart of the feature: replace the Givebutter donor list + the Monday.com
experiment with a first-class, chapter-and-central-aware donor database.

### Schema — new domain `apps/convex/schema/giving-platform.ts`

(Working table names. All money integer cents; all counters denormalized per
Convex rules; indexes for every access path.)

```
donors
  scope: Id<"chapters"> | "central"     // who stewards the relationship
  kind: "individual" | "church" | "business" | "foundation"
  name, email? (lowercased), phone?
  status: "prospect" | "active" | "lapsed"   // derived from lastGiftAt (90-day
                                             // lapse rule from the AJ system),
                                             // recomputed on gift write + cron
  ownerPersonId?: Id<"people">          // relationship owner (AJ's "owners")
  notes?, source? ("givebutter-import" | "event-donation" | "manual" | "map")
  // denormalized rollups (bumped on gift settle, clamped ≥ 0):
  lifetimeCents, giftCount, lastGiftAt?, firstGiftAt?
  userId?: Id<"users">                  // linked if the donor is also a member

gifts
  donorId, scope: Id<"chapters"> | "central" | { cityCampaignId }  // see §5
  amountCents (int > 0), currency ("usd"), receivedAt
  method: "stripe" | "cash" | "check" | "wire" | "in_kind" | "imported"
  pledgeId?                             // set for recurring cycles
  sponsorshipId?                        // set for sponsorship payments
  eventId?                              // set when it came through an event page
  externalRef?                          // Givebutter transaction id (dedup key)
  stripeInvoiceId?, stripePaymentIntentId?
  recordedBy?: Id<"users">              // manual/backfill entries
  note?
```

Design decisions:

- **`gifts` is the giving history; `transactions` stays the only actuals.**
  A gift is a *source record* (like a reimbursement request), not a ledger
  row. Stripe payouts land in Increase and are reconciled as `transactions`
  through the existing reconcile flow — giving never double-counts into spend
  or revenue rollups on the finance side (see §7).
- **Existing event `donations` dual-write a `gifts` row on settle** (in
  `fulfillDonation` / `recordDonation`), keyed by email → donor match-or-create.
  The `donations` table and event rollups stay exactly as shipped — the event
  page keeps working untouched; the CRM simply gains the history. A one-time
  migration backfills `gifts` from existing paid `donations`.
- **Backfill is first-class, not an afterthought.** Two paths:
  1. **CSV import** (Givebutter export → donors + gifts, `externalRef` dedup,
     re-runnable). Admin-gated action + preview screen.
  2. **Manual gift entry** on the donor detail screen ("they gave $500 by
     check in March") — the "backfill people's giving history" requirement.

### Views (chapter lens vs central lens)

- **Chapter lens** (NYC today): my donors, my backers (active pledges), lapsed
  list (reactivation queue), lifetime totals, per-donor history. Sorted by
  lifetime giving — the "top 5 donors" relationship workflow needs this
  ordering on day one.
- **Central lens**: all-org rollup + per-chapter fleet cards (mirrors
  `CentralView`/`ChapterFleet` in `components/finance/`), central's own donors
  (givers to the movement, not a city), and the sponsorship pipeline (§4).
- **Donor detail**: identity, status, owner, full gift history, active pledge,
  sponsorship links, notes + next-touchpoint — enough to run the donor
  interview/avatar program and the "every donor gets a personal thank-you"
  practice from the development meetings.

## 2. Backers — recurring giving on our own rails (Stripe Billing, v1)

**Owner-confirmed direction:** the backer platform is built internally
(finance-v2 owner decision #4); Givebutter is exited. So v1 does real recurring
billing — not pledge bookkeeping with money collected elsewhere.

### Schema

```
pledges
  donorId, scope: Id<"chapters"> | { cityCampaignId }   // what city they back
  amountCents (int ≥ 2000; presets $20 / $50 / $100, floor for "backer"
               status = BACKER_UNIT_CENTS unless owner says partial counts)
  status: "incomplete" | "active" | "past_due" | "canceled"
  stripeCustomerId, stripeSubscriptionId (unique index)
  startedAt, canceledAt?, currentPeriodEnd?
```

### Stripe integration (house style: REST via `fetch`, no SDK, no `"use node"`)

Extends the shipped pattern in `apps/convex/stripe.ts` + the shared
`/stripe/webhook` in `http.ts` (`verifyStripeSignature` already exists):

- **Subscribe**: public checkout action → Stripe Checkout `mode=subscription`
  (`metadata.pledgeId`), price created inline per amount (or a small set of
  Prices per preset — implementation detail). Return URL = the city page with
  a thank-you state.
- **Webhook events** (added to the existing fan-out, each idempotent):
  - `checkout.session.completed` → activate pledge, link customer/subscription.
  - `invoice.paid` → **write one `gifts` row per billing cycle** and bump donor
    rollups. This is what makes backer giving show up as giving history.
  - `invoice.payment_failed` / `customer.subscription.updated` → status
    transitions (`active` ⇄ `past_due`); Stripe Smart Retries does the dunning.
  - `customer.subscription.deleted` → `canceled`, recount backers.
- **Self-serve management**: a Stripe **customer portal** link (emailed, and on
  the city page via email lookup) for card update / amount change / cancel — we
  never store card data and never build our own card UI.

**Framework note (upstream-first rule):** `@supa-media/convex` ships
`supaPaymentTables` + subscription helpers, but they model SaaS
user-account paywalls (userId ⇄ customer). Donation semantics differ (donor ≠
authed user, per-city scoping, gifts ledger), so this stays **app-local, like
the shipped one-time donation flow** — this paragraph is the divergence note
the framework rule requires. If a second Supa app ever needs donation billing,
extract upstream then.

### Backer count becomes derived (retiring the manual number)

`chapters.backerCount` is recomputed from active pledges (count where
`status = "active"` and scope = chapter) on every pledge transition —
`setBackerCount` and `BackerCountModal` retire once parity is proven (keep
during migration as an override with an audit note, then remove). The
affordability header, skim math, and transfer automation don't change at all;
they just stop being fed by hand.

### Givebutter migration

1. Export donors + transaction history → CSV import (§1) with `externalRef`
   dedup. History lands as `method: "imported"` gifts.
2. Recurring donors **cannot be ported** (cards live in Givebutter's Stripe).
   Each gets a personal re-signup ask (the development team's relationship
   workflow, not a blast): link to their city's page → new pledge on our rails.
3. Cutover window: both rails live; imported Givebutter recurrences tracked as
   pledge-shaped rows with `status` reflecting reality until re-signed or
   lapsed. Dashboard shows re-signup progress. Givebutter closes when the
   count hits agreed threshold (owner call).

## 3. The backer model — a configurable milestone ladder

The playbook's promise: at N backers, the chapter commits to canon events.
Owner decision #1 (2026-07-16) confirmed **20 → WWS monthly, 30 → +Eden,
50 → +LTN** (the Notion one-pager's 25/50/75 is stale). But the model must be
**editable at the development director's discretion** — that's an explicit
product requirement, so thresholds move from constants to config:

```
backerMilestones          // dev-director-editable, ordered
  scope: "global" | Id<"chapters">   // global ladder, per-chapter override later
  minBackers, label ("WWS"), commitment ("Worship With Strangers, monthly"),
  description?          // shown publicly on city pages
  sortOrder
```

- Seeded from `AFFORDABILITY_TIERS`; `chapterAffordability()` gains an optional
  tiers argument — the shared constant stays as the fallback so finance never
  breaks if config is empty.
- Public city pages render the ladder as **promises with progress**: "17 of 20
  backers — 3 more unlock monthly Worship With Strangers in Columbus."
- Changing the ladder is a money-rule change → Academy update required (§8).

## 4. Sponsorships & partnerships — institutional giving at tiers

From the Jun–Jul 2026 strategy: churches (~$500/mo, one per borough, deep
relationship not transactional referral), businesses, foundations; sponsor
packages per event scale (~300-person event, ~1,000-person event, WWS) in 2–3
tiers, plus full-year packages; packages for Field Day and LTN already being
drafted by hand. The system makes those artifacts first-class:

```
sponsorPackages           // dev-director-authored tier definitions
  name ("LTN Gold"), tierRank (1..n), audience: "church"|"business"|"any"
  pricing: { kind: "one_time" | "monthly" | "annual", amountCents }
  scope: { kind: "event", eventId } | { kind: "season" } | { kind: "annual" }
  benefits: string[]      // logo on flyers, joint social post, website logo,
                          // Sunday announcement, stage mention…
  commitments: string[]   // what WE commit to deliver at this tier
  active: boolean

sponsorships              // one org × one package = one agreement
  donorId (kind: church/business/foundation), packageId
  status: "prospect" | "pitched" | "committed" | "active" | "lapsed" | "declined"
  eventIds?: Id<"events">[]   // attach to future events
  ownerPersonId, dueDiligenceNotes?, terms?, nextTouchpointAt?
  // money arrives as gifts with sponsorshipId set
```

- **Packages are editable rows, not constants** (the `templateRoles`/`seatDefs`
  admin-config precedent) — the dev director creates tiers, attaches them to
  future events, and revises them as pitches teach us what lands. "Refined as
  we go" is the stated expectation.
- **Church partnerships** get the due-diligence field (statement of beliefs,
  pastor relationship, visited-a-service) and the lighter "Sunday announcement
  + QR" option — which is *not* a sponsorship, just their congregation hitting
  the city's backer page (§5) via a shareable link, attributable by source.
- Pipeline view (prospect → pitched → committed → active) lives on the central
  lens; this is the dev team's OKR surface ("two packages sent this month").

## 5. The public map — `/give`

The public acquisition surface, core to v1. House pattern: server-rendered
self-contained HTML from a Convex `httpAction` (like `lib/landingPage.ts` —
inline CSS/JS, OG tags, no external assets), backed by no-auth queries that
expose **aggregates only** (never donor PII).

```
cityCampaigns             // prospect cities; live chapters appear via chapterId
  name ("Columbus"), region ("OH"), lat, lng, slug (unique)
  status: "prospect" | "raising" | "launched"
  chapterId?              // set at launch — the dot turns into the chapter
  targetBackers (default from first milestone), story?, heroImage?
  createdBy, createdAt
```

- **`/give`** — the map: dots for live chapters (from `chapters`) and raising
  cities (from `cityCampaigns`). Inline SVG map + plotted dots (no external
  tile service — CSP-clean, self-contained like every public page we serve).
  Click a dot → city page.
- **`/give/<slug>`** — the city campaign page:
  - backer count + progress bar to next milestone, the full milestone ladder
    as promises (§3);
  - "how chapters happen" explainer: 5-person core team, $50/mo backers, the
    85/15 split, the City Launch Fund, the ~$10k launch grant, how recruiting
    works — the transparency section, straight from the playbook;
  - become-a-backer flow: preset amounts ($20/$50/$100 + custom) → Stripe
    subscription checkout (§2);
  - shareable by design (OG image with the progress state): "already 3 backers
    here — send the link, get it to 20, launch a chapter."
- Prospect cities are created from the Giving admin surface ("add a potential
  chapter in Ohio") by central/dev-director capability holders.
- **Where prospect-city money goes**: pledges scoped to a `cityCampaign` are
  central-scope revenue held for that city (candidate mechanism: the dormant
  `funds.restriction: "designated"`), released as the launch grant at launch.
  Owner to confirm (Appendix C).
- On launch: campaign `status: "launched"`, `chapterId` set, its pledges
  re-scope to the chapter, its backers count toward the chapter's tiers.

## 6. Permissions, seats, navigation

- **New capabilities** in `SEAT_CAPABILITIES` (`packages/shared/src/seats.ts`):
  - `giving.manage` — full CRM + config write (milestones, packages, cities);
  - `giving.view` — read the development desk;
  - `nav.giving` — surface the desk in navigation.
  Attach: `development_director` (all three — the seat finally gets its
  powers), `fundraising_associate` + `partnership_associate` (`giving.view` +
  scoped manage), `executive_director` (all), chapter `chapter_director` +
  `treasurer` (chapter-lens view; chapter director manages their own donors —
  they're the seat the playbook says "raises money (backers)").
- **Enforcement**: new `apps/convex/lib/giving.ts` gate mirroring
  `requireFinanceRole` — stored grants unioned with seat-derived capabilities
  via `getSeatDerivedCapabilities`, `ConvexError({code, message})` on refusal.
  Public endpoints gate only on published/active state, like the event pages.
- **Surface**: new stacked route group `apps/mobile/app/(app)/giving/` — its
  own desk beside `finances/`, with pill nav: **Dashboard · Donors · Backers ·
  Sponsorships · Cities**. Development is an org function, not a finance tab;
  the finance dashboard keeps its affordability header, now fed live.

## 7. Playing nicely with financials

- **One home per dollar, still.** `gifts` = giving history (who gave, why,
  toward what). `transactions` = actuals (what hit the bank). Stripe payouts
  arrive in Increase and reconcile as inflow transactions exactly as today;
  a reconcile hint ("this payout ≈ these N gifts") is a fast-follow, not v1.
- The skim (WP-4.1) keeps reading `chapters.backerCount` × `BACKER_UNIT_CENTS`
  — now a derived, truthful number. No transfer-automation changes.
- **Receipts**: per-gift email receipt extends the shipped
  `sendDonationReceiptEmail` pattern; recurring cycles get a receipt per
  `invoice.paid`. Year-end giving statements: named, deferred (Phase 4+).
- **Transparency outward**: city pages show live backer counts and milestone
  progress; donors can see what their giving unlocked. The "impact per dollar"
  narrative content is editorial, not schema.

## 8. Academy impact

This build creates new vocabulary (backer/donor/sponsor/prospect city), new
money rules (derived backer count, configurable ladder), and a new seat power
(`development_director` gains a desk). Per the Academy rule:

- New **development stream** lessons: the backer model, donor stewardship,
  sponsorship tiers, the map/city-launch story.
  `academyPaths.ts` already lists `comingSoon: ["Fundraising & donor ops"]`
  for `development_director` — this is that content.
- Finance stream touch-ups: the affordability lesson's "manual backer count"
  teaching becomes "reported by the Giving page."
- Each build phase updates the Academy in the same PR, per house rule.

## 9. Phasing

All phases are one release train ("v1"), but build order matters:

1. **P1 — Donor CRM + history**: schema, donors/gifts, event-donation
   dual-write + backfill migration, CSV import, chapter/central lens screens,
   capabilities + gate. *Ships value immediately: the donor list AJ is running
   in Monday.com moves home.*
2. **P2 — Recurring rails**: pledges, Stripe subscription checkout + webhook
   cycle-gifts, customer portal, derived backer count, Givebutter cutover
   tooling. *Backers exist; the manual count retires.*
3. **P3 — Public map**: cityCampaigns, `/give` + `/give/<slug>`, milestone
   ladder config + public rendering, prospect-city pledge scoping.
4. **P4 — Sponsorships**: packages, agreements pipeline, event attachment,
   pitch-tracking views.

Each phase: full test coverage in `apps/convex/tests/` (money-flow adversarial
review before merge, per the giving.md precedent) + Academy updates.

## 10. Explicitly out of scope (named so nobody wonders)

- Grants tracking (sourcing/applications/deadlines) — real need, separate
  small PRD; likely folds into the partnerships desk later.
- Donor newsletter — the August newsletter owns it; the CRM provides the
  "donors" audience segment when blasts want it.
- Volunteer CRM — separate thread (volunteers-database-redesign.md).
- Tax-receipt/990 automation beyond email receipts; year-end statements
  deferred.
- Escalating skim, grace periods — playbook open questions, finance-side.
- Native in-app giving UI for members — the public web flow serves everyone
  in v1.

---

## Appendix A — source-of-truth references

- `docs/plans/finance-v2-split-prd.md` — §0.1 playbook facts, §0.2 seat map,
  §3 owner decisions (#1 tiers 20/30/50, #3 flat 15% skim + 85% principle,
  #4 internal Stripe build + church-backer class), Appendix F-6.
- `docs/plans/giving.md` — the shipped event-donation machinery this extends.
- `packages/shared/src/finance.ts` — `BACKER_UNIT_CENTS`, `CENTRAL_SKIM_PCT`,
  `AFFORDABILITY_TIERS`, `chapterAffordability`, `CENTRAL` sentinel.
- `apps/convex/transfers.ts` — skim / launch-grant / settlement transfers.
- `apps/convex/lib/landingPage.ts` (+ Client/Styles) — public page pattern.
- `apps/convex/lib/finance.ts` + `lib/seats.ts` — the gate pattern to mirror.
- City Launch Playbook (Notion) — backer ladder narrative, 85/15, ~$10k
  launch grant, core-team structure.

## Appendix B — decisions made in this PRD

| # | Decision | Why |
|---|---|---|
| B1 | Gifts are source records; `transactions` stay the only actuals | preserves finance-v2's core invariant |
| B2 | Event `donations` dual-write gifts; table stays | zero risk to shipped event flow |
| B3 | Stripe Billing in v1, app-local (not `supaPaymentTables`) | Givebutter exit is the point; donation ≠ SaaS paywall semantics |
| B4 | Backer count derived from active pledges | retires the manual seam as designed |
| B5 | Milestone ladder + sponsor packages are editable rows | dev-director discretion is a stated requirement |
| B6 | Prospect cities are `cityCampaigns`, not fake `chapters` rows | chapters keep meaning "operating chapter" |
| B7 | Public surface is server-rendered httpAction pages | house pattern; shareable, OG-friendly, no PII |
| B8 | Development desk is its own route group, not a finance tab | matches the org chart: Development ≠ Finance |

## Appendix C — open questions for the owner

1. **Church-backer price point**: F-6 says ~$200–300/mo; the Jun 2026 strategy
   says $500/mo. Pick the floor (or make it a package tier and drop the
   special class).
2. **Partial backers**: does a $20/mo pledge count toward backer milestones,
   or only ≥ $50? (Affects the derived count and the public progress bars.)
3. **Prospect-city money**: held designated for that city vs general central
   revenue until launch?
4. **Givebutter cutover threshold**: what re-signup % (or date) closes it?
5. **Milestone ladder scope**: one global ladder, or per-chapter overrides
   from day one? (Schema supports both; UI can start global-only.)
6. **Map geography**: US-only at v1, or is Toronto-style international in the
   first cut? (Affects the SVG base map choice, nothing else.)
