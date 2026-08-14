# Backer Portal — product + architecture discovery

Status: DISCOVERY. No code. Everything below is grounded in tables and
functions that exist in this repo today; where something does not exist, it
says so.

## Product thesis

A backer gave $50 a month to a *city*, not to a brand — and the thing they
actually bought is a seat in the room. The portal is that seat: a private,
signed-in place where the org tells a backer the same things it tells itself,
in the same numbers, without being asked. We already publish our books to the
entire internet (`/finances`, `apps/convex/publicLedger.ts`) and we already
publish every gift that comes through checkout (`schema/givingActivity.ts`) —
so the portal is not a new act of disclosure, it is the *personal* cut of a
disclosure we have already made, plus the two things the public page can never
carry: **your** giving, and **your** city's position. The instinct to show the
books is right and is already institutional policy; the discipline this
document adds is that radical transparency about the ORG is not a licence to
be loose about PEOPLE — donors, volunteers, contractors and minors all appear
in the same tables as the money, and the portal must be built so that a
forgotten projection cannot leak them (the structural rule
`financePublicationGiverKeys` already sets: don't omit the field, don't *write*
it into the reachable table).

---

## Settled decisions (owner, 2026-08-14)

These replace the defaults this document originally proposed. They are
decisions, not open questions.

1. **Every chapter, not just yours.** A backer sees all chapters — Central, New
   York, and the prospect/proposed ones — each with its backer count. The
   portal is not scoped to the city you back.
2. **Name the people.** Names and positions ship: who runs the chapter, who
   manages the money. The consent concern is noted and overruled; module 9 is
   now a spec for doing it responsibly rather than an argument against it.
3. **A backer editing their amount may not drop below $50/mo**
   (`BACKER_UNIT_CENTS`). See module 1 — this is a real technical constraint,
   because Stripe's portal has no concept of a minimum.
4. **Access after pause/cancel: 60 days**, then giving-history-only.
5. **Dunning is a weekly escalating sequence**, not a single email. See module 2.

## A note on register

On-screen copy states what the thing is. It does not defend itself. "Roles, not
names — nobody has agreed to be listed" is an argument the reader never asked
for and did not know they needed; it makes the product sound guilty. The
reasoning belongs in this document, where the people building it can find it —
the screen says "Who runs New York" and lists them.

Applies throughout: no captions that explain a design constraint, no
apologising for a missing number, no "we believe in transparency." Show the
number; the transparency is the fact that it's there.

---

## What a backer sees — modules, prioritised

Cost key: **S** = a day or two inside one PR. **M** = a PR of its own.
**L** = multi-PR, or needs a new consent/policy decision first.

### 1. Your backing — and the billing home  · **S**
**Pitch:** "You've backed Brooklyn since March 2026. $50/mo. Next charge Sep 12.
Update your card, change the amount, or stop — right here, right now."

**This is the portal's reason to exist, and the code is already written.**

- **Feeds:** `pledges` (`schema/givingPlatform.ts`) — `amountCents`, `status`,
  `startedAt`, `currentPeriodEnd`, `origin`, `canceledAt`; `pledgeEvents`
  by_pledge for the paused/resumed/card-failed timeline; `donors`
  by_scope_and_email for the identity.
- **The Stripe handoff already exists and is unused.**
  `givingPledges.createPortalSession` (an `action`, `givingPledges.ts` ~L1166)
  POSTs `${STRIPE_API}/billing_portal/sessions` with `customer` +
  `return_url` and returns `{ url }`. The customer id is resolved server-side
  by the internal query `portalCustomerId` (email + chapterId → `donors`
  by_scope_and_email → `pledges` by_donor → the first pledge with a
  `stripeCustomerId`, preferring an `active` one). **`grep` across `apps/` and
  `packages/` finds zero callers outside its own file** — we built the billing
  handoff and never gave it a front door. The portal is that front door.
- **Card data:** never touches us. The module doc is explicit — "REST over
  `fetch` in the default Convex runtime — no SDK, no `"use node"`. Card data
  never touches our code (Stripe-hosted Checkout + billing portal)." The flow
  is: portal page → `POST /api/backer/billing-portal` (session-authenticated) →
  the existing action → `302` to Stripe's hosted portal → Stripe returns the
  backer to `return_url`. Update card, change amount, and cancel all happen on
  Stripe's page; `customer.subscription.updated` / `.deleted` come back through
  the `/stripe/webhook` fan-out in `http.ts` (L1142/L1156) into
  `syncPledgeSubscription` / `cancelPledgeSubscription`, which already patch
  `amountCents`, `status`, `currentPeriodEnd` and recompute
  `chapters.backerCount`. **Nothing new has to be built on the money path.**
- **Two changes it does need:**
  1. `return_url` is hardcoded `${siteUrl()}/` — point it at `/backer`.
  2. **Security hole to close in the same PR.** `createPortalSession` is
     `action({ args: { email, chapterId } })` with **no auth at all**. Anyone
     who knows a backer's email address can mint that person's billing-portal
     link and read their card last-4 and invoice history, or cancel their
     giving. It is unreachable today only because nothing links to it. The
     moment we wire it up it must take a portal session instead of a raw email.

#### The $50 floor problem — and the answer

**Decision 3 cannot be enforced inside Stripe's billing portal.** Concretely:

- **Stripe has no "minimum amount" setting.** The only lever
  `billing_portal.configurations` offers is
  `features.subscription_update.products` — an **allow-list of specific
  Products and their Prices** the customer may switch to, plus
  `default_allowed_updates` (`price` / `quantity` / `promotion_code`). There is
  no floor, no range, no validation hook. You either enumerate the exact prices
  or you allow whatever the subscription already permits.
- **Our subscriptions aren't on enumerable prices.**
  `startPledgeCheckout` builds an **inline ad-hoc price** —
  `line_items[0][price_data][unit_amount] = prepared.amountCents`, with
  `price_data[product_data][name] = "Monthly backer — <Chapter>"`
  (`givingPledges.ts` ~L722–732). Every backer therefore sits on their own
  one-off Price attached to their own one-off Product. An allow-list can't
  name them, so `subscription_update` cannot be made to work over the existing
  book without first migrating everyone onto real, reusable `Price` objects.
- **And the floor we'd be defending is not the floor the code has.**
  `PLEDGE_FLOOR_CENTS = 500` — **$5**, not $20 (`schema/givingPlatform.ts`
  still says "int ≥ 2000 ($20 floor)"; that comment is stale and should be
  fixed). So an unrestricted portal genuinely will accept $5, and
  `syncPledgeSubscription` will dutifully patch `amountCents` down and drop the
  chapter's `backerCount`. The owner's worry is precisely correct.

**Recommendation — split the portal's job in two:**

- **Stripe keeps card + cancel.** Create one `billing_portal.configuration`
  with `features.payment_method_update.enabled = true`,
  `features.subscription_cancel.enabled = true`, and
  **`features.subscription_update.enabled = false`**. Pass its `bpc_…` id as
  `configuration` on the `billing_portal/sessions` call the existing action
  already makes — a one-line addition to that `URLSearchParams` body. Cancel
  still flows home through `customer.subscription.deleted` →
  `cancelPledgeSubscription`, untouched.
- **We keep amount changes.** A small "change your amount" step in our own UI,
  validated server-side, then `POST /v1/subscriptions/{id}` with
  `items[0][id]` (the existing item) + `items[0][price_data]` — the *same*
  ad-hoc price shape `startPledgeCheckout` already posts, so no migration and
  no Price catalogue — plus an explicit `proration_behavior`. Written as a new
  action in `givingPledges.ts` in the house style (REST over `fetch`, no SDK).
  `customer.subscription.updated` then lands on `syncPledgeSubscription`, which
  already patches `amountCents` and recomputes `backerCount` — so the write
  path we'd be adding is the *only* new code, and the read path is free.
- **The rule that action enforces:** if the pledge is currently at or above
  `BACKER_UNIT_CENTS`, the new amount must also be ≥ `BACKER_UNIT_CENTS`.
  Below that floor it may move freely down to `PLEDGE_FLOOR_CENTS` — because a
  $30/mo monthly giver is a real, supported thing this codebase distinguishes
  on purpose (`backerWelcomeEmail.ts` even changes the noun: "backer" above
  the floor, "giving monthly" below it). Decision 3 is "a backer must stay a
  backer", not "nobody may give less than $50".
- **The alternative, rejected:** migrate every pledge onto a fixed ladder of
  real Prices ($50/$75/$100/$150/$250) and let the portal do it. Cleaner
  long-term, but it needs a Price catalogue per chapter, a migration of live
  subscriptions, and it kills arbitrary amounts at signup — which the `/give`
  form deliberately supports. Revisit only if we ever want tiers as a product.
- **Backstop either way:** `syncPledgeSubscription` should notice a pledge
  crossing below `BACKER_UNIT_CENTS` and flag it, because a Stripe dashboard
  edit by staff can still do it. Detection is cheap; it's the only guard that
  survives someone bypassing our UI.
- **Honesty/PII risk:** `origin: "imported"` pledges (Givebutter recurrences
  whose card lives in Givebutter's Stripe) have no `stripeCustomerId`; the
  action already throws `NO_STRIPE_CUSTOMER`. The portal must render that as
  "your monthly gift is on our old platform — here's how to move it," not an
  error. And `status: "paused"` is a *local* overlay: we deliberately do not
  call Stripe `pause_collection`, so **a paused pledge may still be charging**
  (`setPledgeStatus`'s doc says so out loud). Never render "paused" as "you are
  not being charged."
- **What it replaces:** `lib/backerWelcomeEmail.ts` currently signs off with
  *"Need to change your amount, update your card, or stop your monthly gift?
  Just reply to this email — a person reads it, and we'll send you a secure
  link. No hoops, ever."* The monthly receipt
  (`ticketingEmails.sendPledgeReceiptEmail`) says the same thing. That is a
  human being manually minting billing links, today, forever. The portal turns
  both sentences into a button.

### 2. When the card fails — dunning as a first-class screen  · **S–M**
**Pitch:** "Your September payment didn't go through. Update your card and
we'll retry — your backing of Brooklyn hasn't stopped."

- **Feeds:** `pledges.status` + `pledgeEvents` (kind `"status"`, with `from`/
  `to` and an absent `actorUserId` meaning "system/billing"), driven by the
  webhook lifecycle in `givingPledges.ts`:
  `invoice.payment_failed` → `markPledgePastDue` (→ `past_due`);
  `invoice.paid` → `recordPledgeInvoice` (records the gift **and** recovers a
  `past_due` pledge back to `active`, refreshing `currentPeriodEnd`);
  `customer.subscription.deleted` → `cancelPledgeSubscription` (→ `canceled`,
  stamps `canceledAt`).
- **The gap this closes:** the `invoice.payment_failed` branch in `http.ts`
  (L1135) calls `markPledgePastDue` and **sends the backer nothing**. Stripe
  Smart Retries dun in the background; the org's own record flips to
  `past_due`; the person whose card expired hears from us only if Stripe's
  dashboard settings happen to mail them. Meanwhile `chapters.backerCount`
  silently drops (`recomputePledgeCounters`) and the city's milestone ladder
  moves backwards — for a $50 card that needs three taps to fix.
- **What the portal shows per status** (the state machine is real; render all
  five):

  | `status` | Portal state | Call to action |
  |---|---|---|
  | `active` | "Backing Brooklyn since Mar 2026 · $50/mo · next charge Sep 12" (`startedAt`, `currentPeriodEnd`) | Manage card / amount → Stripe portal |
  | `past_due` | **Banner, top of page, red.** "Your last payment didn't go through. Your backing is still on — we'll keep trying for a few days." | **Update your card** → Stripe portal (primary, everything else demoted) |
  | `paused` | "On hold." Plus the honest caveat that a pause is our-side and billing may still run. | Contact us / manage in Stripe |
  | `canceled` | "Your monthly backing ended on <`canceledAt`>. Thank you for the N months you gave." Giving history stays. | Start again (→ `/give/<slug>`) |
  | `incomplete` | "We never received a first payment." | Finish signing up (→ `/give/<slug>`) |
  | `origin: "imported"` | "This monthly gift is on our old platform." | Move it over → `/give/<slug>` |

#### The dunning sequence (decision 5)

A weekly ladder that runs **alongside** Stripe Smart Retries, not against it.
Stripe's default retry schedule fires roughly on days 3, 5 and 7 and then gives
up, at which point the subscription's `cancel`-or-leave-unpaid behaviour
applies. Ours is a *conversation* on a slower clock, so the two never collide:
Stripe is trying the card, we are asking the person.

| # | When | Subject register | What it says | CTA |
|---|---|---|---|---|
| 1 | Day 0 (on entering `past_due`) | Neutral, practical | "Your September payment didn't go through — probably an expired card. Your backing of New York is still on; we'll keep trying for a few days." | Update your card |
| 2 | Day 7 | Warmer, personal | "Still no luck with the card. New York is 8 backers from Eden and you're one of them — two taps and you're back." | Update your card |
| 3 | Day 14 | Direct, asks the real question | "Do you still want to back what New York is doing? Totally fine either way — just tell us, and we'll stop asking." | Update your card · **Stop my backing** |
| 4 | Day 21 | Final, gracious, no guilt | "We're going to stop emailing about this. Your backing is paused. Thank you for the 14 months — the door's open whenever." | Start again |

**Stop conditions — any one of them ends the sequence immediately:**
- **Recovered.** `invoice.paid` → `recordPledgeInvoice` already flips
  `past_due` → `active` and refreshes `currentPeriodEnd`. That transition is
  the cancel signal; nothing further sends.
- **Cancelled.** `customer.subscription.deleted` → `cancelPledgeSubscription`.
- **Paused by staff.** `setPledgeStatus` → `paused`.
- **They replied.** These are transactional sends from a real reply-to address;
  a human answering means a human takes over. Not automatable — call it out in
  the runbook rather than pretending a flag exists.

**How to schedule it without inventing a scheduler.** Do **not** chain
`ctx.scheduler.runAfter` calls three weeks deep — a pledge that recovers on day
6 would still have live timers. Instead, `crons.ts` runs a daily sweep that
reads pledges `by_scope_and_status` at `past_due`, computes days-since from the
`pledgeEvents` row recording the `→ past_due` transition, and sends the rung
that matches. Re-entering `past_due` after a recovery starts the ladder at #1
again, because the `pledgeEvents` trail gives a fresh transition timestamp. The
sweep is idempotent per (pledge, rung) — stamp the rung on send so a double run
can't double-mail.

**One warning worth stating plainly:** *never email about a charge that has
already succeeded.* The daily sweep must re-read the pledge's **current**
status at send time, not trust the row it selected — Stripe's retry can succeed
between the sweep's read and its send, and "your payment failed" arriving after
"your monthly gift came through" is the single worst email in this whole
design.

- **The emails themselves:** a new `lib/backerDunningEmails.ts`, pure (payload
  in, `{subject, html}` out) and painted with `emailShell`, exactly like
  `lib/backerWelcomeEmail.ts`. **Transactional** — no unsubscribe footer, no
  `emailSuppressions` consult, per the split `givingComms.ts` documents. Tone
  is set by `givingComms.ts#onAchFailed`, whose doc already gets it right: a
  declined payment is a typo or an expiry, never an accusation, and a raw bank
  code (`R01`) must never reach a donor. Rung 4 must not read as punishment —
  it is the org being easy to leave, which is what makes it worth staying in.
- **Where the portal link comes from:** add `backerPortalUrl()` beside
  `givePageUrl()` in `lib/siteUrl.ts` (same `siteUrl()` base, degrading to
  `null` when unset, as `appUrl` already does). Because a sign-in code is
  required, the link in an email is just `/backer` — no secret in the URL, so a
  forwarded receipt leaks nothing. Then: swap the "just reply to this email"
  sentence in `backerWelcomeEmail.ts` and in `sendPledgeReceiptEmail` for a
  real button, and make it the primary CTA of the new payment-failed email.
- **Honesty/PII risk:** essentially none — it is the backer's own billing
  state. The one discipline: don't paraphrase Stripe's decline reason. We
  don't currently store one (`markPledgePastDue` takes only a subscription id),
  and inventing "your bank declined it" when we don't know is worse than the
  generic sentence.

### 3. Your giving — the complete personal record  · **M**
**Pitch:** "Everything you've ever given us, every rail, with the receipts —
and the one time a bank took $500 back, and why."

- **Feeds:** `gifts` by_donor (`amountCents`, `receivedAt`, `method`,
  `feeCoverageCents`, `note`, `eventId`); `donors` rollups (`lifetimeCents`,
  `giftCount`, `firstGiftAt`); `donorIdentities` (`by_email`) to union a giver
  who gives to central *and* a chapter — this is the whole reason that layer
  exists (`lib/donorIdentity.ts`); `pendingGifts` by_session for ACH in flight;
  `giftReversals` by_donor for money that ran backwards.
- **Honesty/PII risk:** This is the module where being honest is the feature.
  `giftReversals` exists precisely so "your lifetime total went down" has an
  answer — show it. `feeCoverageCents` is *inside* `amountCents` (schema
  invariant, migration 0072) — a receipt that adds it again overstates the
  gift. Show pending ACH as pending, never as given.
- **Do not** join to `financePublicationGiverKeys` here or anywhere — that
  table is documented as never reachable by a public query, and the portal is
  a semi-public surface.

### 4. The books — every chapter  · **M**
**Pitch:** "Brooklyn, August: $4,120 in, $3,780 out. Here is every line — and
here's Central, and New York, and every city on the map."

**Decision 1:** not scoped to the city you back. A chapter picker at the top,
defaulting to the backer's own city, with Central and every other chapter — 
including prospect/proposed ones — one tap away, each showing its backer count.

- **Feeds:** `financePublications` + `financePublicationRevisions` +
  `financePublicationEntries` — already frozen, already approved for
  publication, already served anonymously at `/finances` via
  `publicLedger.publicStatement`.
- **The gap:** `publicStatement` **merges every book for a month** into one
  statement (`mergeLive`, `publicLedger.ts` ~L1180) and returns `books[]` as
  labels only. There is no per-scope public statement query. This module needs
  a new `publicLedger.publicScopeStatement({ scope, periodKey })` built from
  the same frozen rows — a genuine, contained piece of work, and reusable by
  the public page later.
- **Honesty/PII risk:** Low, because the freeze already did the work: entries
  carry `counterparty`, `purpose`, `categoryLabel`, `headcount` +
  `affiliationMix` — and deliberately **no attendee names, ever** (owner
  decision 2026-08-08, some attendees are minors). Carry the disclosure fields
  through (`reconstructedCents`, `undocumentedCents`, `unexplainedCents`) — a
  transparency page that drops its own caveats is worse than one that never
  had them. Never return `sourceTransactionId`.
- **Collision to flag:** `financePublications.staleSince` means the live books
  have moved since publication. The portal must render "as published on X" and
  never imply currency.

### 5. Is my city healthy? — the gap, honestly  · **S–M**
**Pitch:** "20 backers = $1,000/mo. Your floor is $670. Central takes 15%.
You're $180 clear. 10 more backers unlocks Eden."

- **Feeds:** pure `chapterAffordability()` in `packages/shared/src/finance.ts`
  (`BACKER_UNIT_CENTS` 5000, `OPERATING_FLOOR_FIXED_CENTS` 57000,
  `OPERATING_FLOOR_PER_TEAMMATE_CENTS` 2000, `CENTRAL_SKIM_PCT` 0.15), the
  Convex wrapper `finances.chapterAffordability`, and `chapters.backerCount`
  (kept current by `givingPledges.recomputeChapterBackerCount`).
- **Honesty/PII risk:** `discretionaryCents` **can be negative** — the type
  comment says callers clamp the *display*, not the value. Showing "under water
  by $310" to the people funding you is the honest move and is probably the
  single most motivating number in the product. But note the morale risk: it
  is also a public statement that a specific volunteer team is failing, and
  those volunteers did not choose to be measured in front of donors. Frame it
  as the org's number, not the team's.
- **NEVER expose `dashboardCharts.chapterHealth`.** It carries
  `unattributedCents`, `toReviewCount`, `pendingApprovalsCount` — internal
  bookkeeping hygiene. "We have 14 uncoded transactions" is a fact about our
  admin backlog, not about our integrity, and it will be read as the latter.

### 6. What your backing unlocks next — the ladder  · **S**
**Pitch:** "At 30 backers Brooklyn commits to Eden. You're 8 away."

- **Feeds:** `backerMilestones.listMilestones` (owner-editable, capped at 10),
  falling back to `AFFORDABILITY_TIERS`; `PUBLIC_BACKER_TIERS` and
  `MONTHLY_OPERATING_LINES` in `packages/shared/src/finance.ts`;
  `territories.getPublicTerritory` for `targetBackers` / `nextMilestone` /
  `launchFund`.
- **Honesty/PII risk:** None — every figure here is already rendered to
  anonymous visitors by `lib/givePage.ts` / `lib/givePageSections.ts`. The
  tiers are documented as *guarantees, not ceilings*; keep that wording.

### 7. What's coming up in your city  · **S**
**Pitch:** "Worship With Strangers, Sep 14, Fort Greene Park. You're on the list."

- **Feeds:** `eventPages` by_published + `events` by_chapter_date.
- **The gap:** `ticketing.listPublishedUpcoming` (the query behind
  `/api/events/upcoming`) is **org-wide** — no chapter filter. Needs a
  chapter-scoped variant, which is trivial (`events.by_chapter_date` exists).
  Skip `event.isTraining` rows, as that query already does.
- **Honesty/PII risk:** None. Published event pages are public by definition.

### 8. The identity join — which records count as "yours"  · **S**, foundational
**Not a screen.** The resolver every personal module (3, 12, 13) reads through.
Specified once here so three modules can't each invent their own rule.

The portal authenticates **one email**. That email has to fan out to every
record the person owns, across books and across addresses, without ever
reaching a record that isn't theirs.

- **The fan-out, in order of strength:**
  1. `donorIdentities.by_email` → its `donors` rows (`by_identity`) → their
     `gifts` and `pledges`. This is the money side, and it is exact: the
     identity layer exists precisely to group one human's scope-partitioned
     donor rows (`lib/donorIdentity.ts`).
  2. `personEmails.by_email` (with `verified`) → `personId` → **every other
     address that person owns**. This is what catches a backer who gives with
     `sam@gmail.com` and bought a ticket with `sam@work.com`. Trust order is
     `SOURCE_RANK` (`manual` > `pw` > `roster` > `donor` > `rsvp`).
  3. Direct email equality on the record itself — `tickets.attendeeEmail`,
     `ticketOrders.email`, `registrations.email`, `rsvps.email`. Simple, exact,
     and (per module 12) far more useful than this document first assumed.
  4. `donors.personId` / `rsvps.personId` — the best-effort roster links
     stamped by `lib/givingDonors.ts#linkDonorToPerson` and
     `lib/rsvpPeople.ts#linkRsvpToPerson`. Use these to **widen** a match,
     never as the sole basis for a claim about a person.
- **Where it is genuinely lossy, and what follows:** `donors.personId` is never
  set for `"central"` donors (central donors are CRM-only, by design); the RSVP
  backfill deliberately leaves divergent-name matches unlinked rather than
  guessing; `rsvps.email` is optional, so imported name-only guests can never
  be matched at all. **Consequence:** a missing record is normal and must
  render as absence, never as "you have never been to a night."
- **The rule:** normalize with `normalizeEmail` (`lib/access.ts`) everywhere —
  it is the same trim+lowercase every one of these tables keys on. Never match
  on name. Ever. Two people share a name; that is how a stranger's giving ends
  up on somebody's screen.
- **Honesty/PII risk:** this resolver is the single highest-leverage place to
  get authorization wrong, which is exactly why it is one function
  (`lib/backerAccess.ts`) and not a join repeated in four queries.

### 9. Who runs this chapter — named  · **M**
**Pitch:** "New York is run by five volunteers. Here's who does what, and who
looks after the money."

**Decision 2: names ship.** Below is how to do it without leaking a roster.

- **The right source is `seatAssignments`, and it is remarkably clean.** The
  table is `{ seatDefId, scope, personId, grantedBy, createdAt }`
  (`schema/seats.ts` L104) — no PII of its own. `seats.chart({ scope })` already
  walks it and returns `seatNodeValidator` nodes of
  `{ defId, slug, title, parentSlug, maxHolders, derived, sortOrder, holders,
  vacant }`, where each holder resolves to `{ personId, name, imageUrl, … }`
  via a helper that **already skips `isPlaceholder` rows**. So the safe
  projection — title, display name, photo — is a projection the codebase
  computes today for the internal org chart.
- **Do NOT read `people` directly for this.** That row carries `email`,
  `phone`, `pwEmail`, `address`-adjacent fields, `vettingStatus`, `notes`,
  `status: "transitioning_out"`, `consentedAt`, and `isContactOnly` flags. The
  portal query must select **exactly four fields** — `seatDefs.title`,
  `people.name` (or `firstName` alone, see below), the resolved photo URL, and
  the seat's `scope` — and must be written as an explicit allow-list, never a
  spread of the person doc. Same discipline `financePublicationEntries`
  documents: the safety shouldn't depend on every future reader remembering to
  drop a field.
- **`userProfiles` is the wrong table** — it is the *authenticated user's* own
  profile (name + phone, written at onboarding), keyed by `userId`, and most
  chapter volunteers are `people` rows with no user account at all. It would
  both miss people and carry a phone number.
- **Never travels:** email, phone, address, `vettingStatus`, `notes`,
  `status`, `consentedAt`, `personEmails`, `grantedBy`, `assignmentId`,
  `createdAt` (when someone got a seat is nobody's business), and any seat the
  person no longer holds. Also never: `SEAT_DEFS[].capabilities` — "this person
  can approve payments" is an attack surface, not a bio.
- **Which seats to show:** the chapter chart's leadership seats
  (`chapter_director`, `treasurer`, `music_lead`, `event_lead`,
  `marketing_lead`) plus Central's (`executive_director`,
  `financial_manager`, `development_director`). Skip multi-holder roster seats
  (`musicians`, `artists`, `event_organizers` — `maxHolders ===
  MULTI_HOLDER_CAP`): listing forty volunteers is a roster dump, and those
  seats are where the churn is. **Vacant seats render as vacant** — "Treasurer
  — open" is honest and doubles as recruiting.
- **First name or full name?** Recommend **full name for leadership seats,
  first name only for anyone else**, because the money seats are the ones a
  funder is entitled to identify and the rest are volunteers. `people.firstName`
  exists and is backfilled where the split was unambiguous
  (`splitPersonName`); fall back to the first token of `name`.
- **The opt-out — propose it, don't block on it.** One boolean on `people`,
  `hideFromPublicChart`, default false, editable by the person or their chapter
  director, checked by the portal query. It costs one schema field and one
  filter; it is the difference between "we published a volunteer's name and
  face" and "we published it and they could have said no." Ships in the same PR
  as the module. Not a gate — nothing waits on it.
- **Honesty/PII risk after the above:** low, and comparable to what any
  non-profit puts on a "Our team" page. The residual risks are real but small:
  a photo of a volunteer is biometric-adjacent and some people will not want
  it (the opt-out covers this), and a seat change becomes visible to donors
  (acceptable — it is an org fact, and we show no reason).
- **Copy on screen:** "Who runs New York" · "Ada Lee — Chapter Director" ·
  "Treasurer — open". No caption explaining the policy.

### 10. The year's plan — budget and progress against it  · **M–L**
**Pitch:** "New York planned $18,400 for 2026. Here's what it's for, line by
line, and here's the $11,200 raised toward it."

- **Feeds:** `budgets` (`schema/finances.ts` L177) — `amountCents`,
  `approvedCents`, `label`, `type` (`one_time`/`recurring`), `cadence`
  (`per_instance`/`monthly`/`quarterly`/`yearly`/`one_off`), `year`, `month`,
  `quarter`, `categoryId`, `fundId`, and `approvalStatus`. Line items are
  `budgetLines` (`by_budget`) — `{ description, plannedCents, categoryId,
  sortOrder }`. Actuals come from `transactions.budgetId` through
  `finances.ts`'s exported `txnCountsTowardBudget` / `effectiveCapCents` /
  `isSpend`, which is exactly what `budgetGlance.ts` and `budgetDetail.ts`
  already do — reuse those primitives, never re-derive.
- **The fiscal period is a calendar year.** There is no separate fiscal-year
  concept: `budgets.year` is a plain number with optional `month`/`quarter`
  narrowing, all bucketed in America/New_York (`easternParts`). "The year's
  budget" is therefore `by_chapter_and_period` at `(chapterId, year)`.
- **Show `effectiveCapCents`, never bare `amountCents`.** A budget mid-increase
  has `amountCents` already moved to the requested figure while
  `approvedCents` holds the cap actually in force. Every internal surface
  compares against the effective cap; the portal must too, or it will publish a
  number nobody approved.
- **Only show approved budgets.** Filter to `approvalStatus === "approved"` (or
  grandfathered-legacy, per `effectiveBudgetApprovalStatus`). A `submitted` or
  `changes_requested` budget is a proposal, and publishing proposals as plans
  is the same error as publishing the live ledger instead of the frozen one.
- **Precedent that this is already sanctioned:**
  `financePublicationRevisions.spendByBudget` **already publishes
  `allocatedCents` beside `spentCents` per budget label**, to the open
  internet, with a schema doc explaining that plan-vs-actual in two columns of
  one row is precisely the question a reader is asking. The portal version is
  the same shape, live and forward-looking rather than frozen and monthly.
- **⚠ The line-item risk, and it is real.** `budgetLines.description` is
  **free text**, written by a treasurer for internal use. Nothing stops it
  saying "Marcus — sound engineer, $400/night" or "Pastor J honorarium." That
  is compensation for a named person, which the public ledger goes out of its
  way never to publish (contractor spend appears under the constant
  `CONTRACTOR_LEDGER_COUNTERPARTY`). **Do not publish `budgetLines.description`
  verbatim.** Two options: (a) show line items grouped by `categoryId` only —
  category label + planned total, no free text; or (b) add an explicit
  `publicDescription` on `budgetLines` mirroring the `publicPurpose ??
  businessPurpose` resolution `financePublicationEntries.purpose` already uses,
  and show only lines that have one. **Recommend (a) for Phase 2** — it needs
  no new field, no back-filling, and category labels are already curated. (b)
  is the Phase 3 upgrade if the owner wants the detail.
- **"Raised toward it"** is a different question from "spent against it" and
  the module should show both. Raised = the revenue side for that scope and
  year (gifts + tickets + sales + registrations, the four streams
  `INCOME_STREAMS` names); spent = `transactions` linked to those budgets.
  Reuse `lib/bookBalance.ts`'s definition of revenue rather than summing
  `gifts` by hand, or the portal and `/finances` will disagree.
- **Honesty/PII risk:** medium, entirely concentrated in the free-text line
  descriptions. With option (a) it drops to low.

### 11. Share your city  · **S** unattributed · **M** attributed
**Pitch:** "New York is 8 backers from Eden. Send this to someone."

- **What exists:** nothing. There is **no referral, share, or attribution
  primitive anywhere in this repo.** Checkout metadata carries only
  `pledgeId`, `giveDonation`, `giveDonorId`, `giveScope`, `giveShowOnWall`
  (`givingPledges.ts` L714–735, `givingDonations.ts` L198–208); there is no
  UTM parsing in `giveApiRoutes.ts` or `givePageClient.ts`, and
  `givingActivity` records the gift, not where the giver came from.
- **Unattributed — cheap, ship it.** A share block with the city's
  `/give/<slug>` URL (`givePageUrl(slug)`), a copy button, and
  `navigator.share()` where available. Pre-written copy the backer can send as
  is: *"I back Public Worship New York — they're 8 backers from putting on
  Eden. $50/mo. <link>"* The numbers come from `territories.getPublicTerritory`
  (`backerCount`, `targetBackers`, `nextMilestone`), which is already public.
  Cost: one block, no backend.
- **Attributed — real work, and mostly Stripe plumbing.** Mint a per-backer
  referral code, append it as `?ref=<code>` on the shared link, have
  `givePageClient.ts` carry it into the `/api/give/pledge` POST, thread it into
  `startPledgeCheckout` as `metadata[giveRef]`, and read it back on settle in
  the webhook fan-out to write an attribution row. That is four files plus a
  table — genuinely **M**, and it changes the checkout payload, which is the
  most safety-critical path in the codebase.
- **Recommendation:** ship unattributed in Phase 1 (it is a button), and only
  build attribution if the owner actually wants leaderboards. "You brought 3
  backers" is a lovely thing to show and a poor thing to be wrong about.
- **Honesty/PII risk:** none unattributed. Attributed, one to watch: never show
  *who* someone referred — a name and an amount is another person's giving.
  Counts only.

### 12. Events you've attended  · **M**
**Pitch:** "You've been to four Public Worship nights. Here they are."

The owner wants this listed, not hedged. Here is exactly how far the data goes.

- **Ticketed events — provable, and the join is trivial.** `tickets`
  (`schema/ticketing.ts` L359) carries **`attendeeEmail` on every admission**,
  plus `status: "checked_in"` and `checkedInAt`/`checkedInBy`. So "did this
  person walk through the door" is a **direct email match** — no fragile
  person link needed at all. This is much stronger than this document
  originally assumed.
- **Free RSVP events — we know they said yes, not that they came.**
  `checkedInAt` exists **only** on `tickets`. `rsvps` has no check-in field of
  any kind (`status` is `going`/`maybe`/`not_going`). There is no attendance
  table. So for a free night the honest claim is "you RSVP'd", full stop.
- **Classes:** `registrations` carries `email` + optional `personId` and a
  `paid` status — that is a *registration*, not an attendance, and should read
  as "you registered for Worship Beyond The Walls."
- **`checkIns.ts` is not attendance.** Despite the name it is the manager's 1:1
  log. Never join to it.
- **The honest render, and it needs no hedging language:**
  - checked-in ticket → **"You were there."** with the date and venue.
  - valid ticket, never scanned → "You had a ticket." (Door scanning is not
    universal; absence of a scan is not absence of a person.)
  - RSVP `going` → "You RSVP'd."
  - registration `paid` → "You registered."
  Four plain statements, each true. No asterisks, no "we think".
- **Identity reach:** match on every address the person owns —
  `donorIdentities.by_email` for the giving side, and `personEmails`
  (`by_email`, with `verified`) to catch a backer who gave with one address
  and bought a ticket with another. `donors.personId` /
  `lib/rsvpPeople.ts#linkRsvpToPerson` are the weaker, best-effort links; use
  them to *widen* the match, never as the only basis for a claim.
- **Honesty/PII risk:** low — it is the backer's own history. One caveat:
  `tickets.attendeeName`/`attendeeEmail` can be a *guest* the buyer assigned a
  ticket to. Match on `attendeeEmail` for "you were there" and on
  `ticketOrders.email` for "you bought these" — they are different questions
  and conflating them will tell someone they attended a night they gifted to a
  friend.

### 13. Things you've bought  · **S–M**
**Pitch:** "Two tickets to Field Day, a class registration, and a shirt. Thank
you."

- **Ticket orders — clean and complete.** `ticketOrders` carries `email`,
  `name`, `items[]` (`{ticketTypeId, name, quantity, unitPriceCents}`),
  `totalCents`, `status`, `createdAt`, plus `donationCents` for a bundled gift.
  Indexed `by_rsvp` and `by_event`; an email match across events is the
  portal's read. Precedent: the RSVP page **already renders a signed-in
  guest's own tickets** (`ticketing.ts` ~L1017 `myTickets`, resolved through
  `getViewerRsvp` by guest token) — but **per event only**. A cross-event
  purchase history would be the first of its kind.
- **Class registrations** — `registrations` (`email`, `projectId`,
  `amountCents`, `status`), also a clean email match.
- **⚠ Merch cannot be attributed, structurally.** `sales`
  (`schema/ticketing.ts` L544) has **no buyer identity at all** — no name, no
  email, no `rsvpId`, no `personId`. It is an in-person Tap-to-Pay row
  (`com.pocketvendor.payment`) carrying `grossCents`, `feeCents`, `items[]`
  and a `channel`. The processor never sends us who paid. So "you bought a
  shirt" is **not buildable** for in-person sales and no amount of joining will
  fix it — the data was never captured. Say so to the owner plainly rather
  than shipping a history that silently omits merch.
  - `sales.donationCents` / `donationGiftId` is the one exception: where a
    bundled gift was split out of a sale, the resulting `gifts` row **is**
    attributed, and already appears in module 3. So the money shows up; the
    shirt doesn't.
- **Honesty/PII risk:** low. Show `items[].name` and quantities — these are
  product names the buyer chose, not free text an operator wrote. Do not show
  `feeCents` (our processing cost is not their business and reads as a
  deduction from their gift).

### 14. Does it add up?  · **S** — the best "inner workings" module we have
**Pitch:** "Our books say $47,312. The bank says $47,312. Difference: $0.00."

- **Feeds:** `reconciliation.reconciliationSummary` (`reconciliation.ts`
  ~L3786) and the pure arithmetic in `lib/reconciliationGap.ts` — book value
  vs bank available + pending + Stripe balance, org-wide.
- **Why it's the strongest one:** it is the single number that proves the rest
  of the portal isn't theatre, it is PII-free by construction (account totals,
  no rows), and the module doc already explains why it is an **org total and
  never per-book** — per-book "book vs bank" is meaningless because every
  processor payout lands in Central's account. Show the org figure; do not
  offer a per-chapter cut.
- **Honesty/PII risk:** low, with one judgement call — a non-zero gap is a real
  possibility and showing it is the whole point. Render it plainly ("Difference:
  $312 — being investigated"), never hidden, never spun. Do **not** surface the
  actionable "leads" the internal query returns alongside it (unrecorded
  inflows, per-account anomalies) — those are a work queue.

### 15. The gear your backing bought  · **S**
**Pitch:** "New York owns 34 of the 41 things a chapter needs. Here's what's
still missing."

- **Feeds:** `assets` (`schema/inventory.ts` L27) — `name`, `tags`,
  `quantity`, **`acquired`** ("on the list, not yet acquired" — a Chapter Kit
  target), `condition`, `photoStorageId`, all `by_chapter`. Pair with
  `LAUNCH_EQUIPMENT_LINES` in `packages/shared/src/finance.ts` (the ~$4,287
  starter kit) for the target list and prices.
- **Why it's good:** it is the most *tangible* thing money buys — four SM58s, a
  mixer, two speakers — and `acquired: false` gives a genuine, honest gap list
  that doubles as an ask. Photos already exist.
- **Honesty/PII risk:** none. No person appears in this table. Skip
  `note`/`stateNote` (free text, operational: "charge the battery").

### 16. The map — every city's progress  · **S**
**Pitch:** "Nine cities. Three launched, four raising, two proposed."

- **Feeds:** `territories.getPublicMapData` (already public, already powers
  `/give`) — per-territory `stage`, `backerCount`, `targetBackers`, `slug`,
  `region`; plus `getPublicTerritory` for `launchFund { cents, targetCents,
  months[] }` and `nextMilestone`.
- **Why it's here:** it is decision 1's natural home — the fleet view a backer
  gets *because* they back one city. Every figure is already rendered to
  anonymous visitors, so it is a re-composition, not a disclosure.
- **Honesty/PII risk:** none.

### 17. A note from your chapter director  · **L** — no data exists
There is no backer-update table. `campaigns.ts` is the email machine and
`campaigns.approve` already exists as an outside-audience power. Deliberately
deferred; do not invent a CMS for it in Phase 1.

**Two more "inner workings" candidates, considered and rejected for now:**
*Campaign/blast cadence* ("we sent 14 emails last month") — computable from
`campaigns`/`blasts`, but it measures our activity, not our impact, and invites
"why are you emailing so much." *Chapter readiness*
(`territories.prelaunchReadiness`) — genuinely interesting, but it is an
internal checklist whose unchecked items read as unpreparedness to a funder.

---

## Why billing outranks the books

The owner's instinct is right, and the code agrees for reasons that are not
about product taste:

1. **The billing path is already built and disconnected.**
   `createPortalSession` + `portalCustomerId` exist, work, and have zero
   callers. The webhook lifecycle behind them (`syncPledgeSubscription`,
   `cancelPledgeSubscription`, `recomputeChapterBackerCount`) is live and
   tested by every real subscription we have. Wiring a front door to finished
   plumbing is the cheapest large win available. Module 4 (the books) needs a
   query that **does not exist** — `publicStatement` merges every book and
   cannot produce a per-chapter cut.
2. **Today, changing your card requires emailing a human.** Two production
   emails instruct backers to reply and wait for a person to send a link. That
   is a real operational cost per backer per card expiry, and it scales with
   exactly the number the org is trying to grow.
3. **A silent `past_due` costs the org the thing the portal is meant to
   celebrate.** `markPledgePastDue` drops `chapters.backerCount`, which moves
   the milestone ladder on the public `/give` page backwards — over a card that
   expired. There is no email. Fixing that is revenue, not transparency.
4. **The books are already public.** `/finances` serves them to anonymous
   visitors today. Nothing is being *withheld* from backers while module 4
   waits; only the personal cut is missing. Billing is the thing a backer
   genuinely cannot do anywhere.

The counter-argument, honestly stated: the *emotional* case for the portal is
transparency, and a portal that is only a billing page is a Stripe redirect
with a logo. Which is why Phase 1 also carries the giving history, the ladder,
and the upcoming nights — enough for the page to feel like a room rather than
an invoice — and why module 4 is Phase 2 rather than Phase 3.

---

## The NOT list — and why

One clarification, since the portal now handles money: **"billing home" does
not mean we handle cards.** Every card, amount change and cancellation happens
on Stripe's hosted portal. We store no PAN, no CVC, and no card token — only
`pledges.stripeCustomerId` / `stripeSubscriptionId`, which are already in the
schema. Nothing in this document adds a PCI surface.

| Do not show | Table / module | Why |
|---|---|---|
| The live ledger | `transactions`, `moneyViews.ts`, `budgetGlance.ts` | Unpublished, unreconciled, un-approved. `/finances` publishes a *frozen, two-party-approved* copy for a reason (`schema/publicLedger.ts`). Live numbers move under the reader's feet. |
| Card spend | `cards.ts`, card transactions, `receipts.ts`, `receiptInbox.ts` | Individual staff purchases, merchant names, receipt images. Also personal-charge flags — an accusation-shaped field. |
| Contractor pay | `contractorPayments.ts`, `contractorProfiles.ts` | Individual compensation, bank last-4, W-9/W-8 documents. The public ledger already publishes contractor spend under the constant `CONTRACTOR_LEDGER_COUNTERPARTY` precisely so the *person* never publishes. Do not undo that. |
| Reimbursements | `reimbursements.ts`, `repaymentLinks.ts` | Volunteer out-of-pocket spending, tied to a named person. |
| Anyone else's giving | `donors`, `gifts`, `pledges`, `donorIdentities` | Donor PII. The only per-person giving a backer sees is their own. |
| The giver roll identities | `financePublicationGiverKeys` | The schema doc says it is never returned by any public query, in whole or in part. The portal is not an exception. |
| Wall internals | `givingActivity.refKey`, `consent`, `hiddenBy` | `refKey` identifies a payment; attribution is gated on `consent`/`consentIndexable` and *absent means no*. |
| Bookkeeping hygiene | `chapterHealth`'s `unattributedCents` / `toReviewCount` / `pendingApprovalsCount`, `transactionCodings.reviewNote`, `financeAuditLog`, `receiptExceptions` | Reads as scandal, is actually a to-do list. |
| Unsettled / disputed money | others' `pendingGifts`, `givingCandidates`, `dismissedGiftCandidates` | Money that has not arrived, or a human judgement that a deposit was not a gift. |
| 1:1 records | `checkIns.ts` | Despite the name this is the manager's 1:1 log — pulse notes and follow-up plans. Not attendance. Not for donors. Not even for the subject. |
| Unpublished statements | `financePublications` where `isLive !== true`, plus `reviewNote` / `amendmentNote` drafts | A draft is not a statement. |
| Seat politics | `seatProposals`, `seatStructureLog`, `responsibilities`, `seatAssignments.createdAt`/`grantedBy` | Org changes in flight, and when someone got a seat. Module 9 shows the seat and the person — never the history. |
| Seat powers | `SEAT_DEFS[].capabilities` | "This person can approve payments" is an attack surface, not a bio. |
| Budget line free text | `budgetLines.description` | Written by a treasurer for internal use; can name a person's pay. See module 10 — publish category groupings, not the text. |
| Unapproved budgets | `budgets` where `approvalStatus !== "approved"` | A proposal is not a plan. |
| Processing costs | `sales.feeCents`, `gifts.feeCoverageCents` as a deduction | Our cost of doing business; reads as a haircut on someone's gift. |
| Reconciliation leads | the per-account anomalies and unrecorded-inflow list in `reconciliationSummary` | Module 14 shows the gap. The leads behind it are a work queue. |
| Chapter readiness | `territories.prelaunchReadiness` | An internal checklist; unchecked items read as unpreparedness. |

**Where the owner's instinct collides with a real risk:**

1. *"Show them the books of every place"* — we already do, at `/finances`, for
   everyone. The genuine new capability is the **per-chapter cut**, which
   `publicStatement` cannot produce today. Build the query; don't reach past
   the frozen tables into `transactions`.
2. *"These are the people running the chapter"* — that data is a volunteer
   roster with PII and no consent. Ship the generic role list now; the named
   version needs an opt-in field.
3. *"This is the gap"* — real and shippable, but it names a specific
   volunteer team's shortfall to that team's donors. Frame as org, not people.
4. *Attendance* — the person↔donor link is documented as best-effort. Silence
   beats a wrong claim.

---

## Auth — the recommendation

The identity we must authenticate is a **normalized email**, because that is
what `donors` is documented to key on (`by_scope_and_email`, `by_email`) and
what `donorIdentities.key` groups on (`e:<email>` first, `lib/donorIdentity.ts`).
Consequence to accept up front: desk-entered cash/check donors with no email
cannot use the portal. That is correct — we have no way to prove they are them.

**Option A — bare signed-token link** (`/backer?token=…`), the shape of
`lib/contractPage.ts`, `lib/reimbursePage.ts`, `/p/<token>` project actions,
and `rsvps.token`. Cheapest possible; `newGuestToken()` (`ticketing.ts` L68)
already mints them. **Rejected as primary:** a forwarded or archived email
becomes permanent, un-revocable access to a person's complete giving history.
Fine for a one-shot contractor agreement; wrong for a standing account.

**Option B — email code → short-lived session. RECOMMENDED.**
Server-rendered page at `/backer`, same house pattern as `/give`, `/finances`,
`/contract`: `httpAction` + inline CSS/JS + a same-origin `/api/backer/*` JSON
surface (copy `lib/giveApiRoutes.ts`'s `jsonPost` wrapper verbatim — the give
and contract routes each keep their own local copy on purpose).

Reused primitives, all of them already in the repo:
- 6-digit code generation, hashing, and policy — `lib/emailCodes.ts`
  (15-minute TTL, 5 attempts, one send per minute) and `lib/sha256.ts`. Store
  only the hash, exactly as `rsvpEmailCodes` does.
- Session token — `newGuestToken()` (32 chars, crypto-random), stored hashed,
  with an `expiresAt` and a `by_token` index. `financePublicationPreviewTokens`
  is the in-repo model for "token row carries coordinates, not data."
- Per-IP rate limiting — `assertContractNotRateLimited` over
  `reimbursementSubmitAttempts.by_key_and_time`, with its own key prefix
  (`backer_code_ip:`, `backer_verify_ip:`) so one endpoint cannot burn
  another's budget. IP extraction: `clientIpFromRequest` in
  `contractApiRoutes.ts` (last hop, not first — the spoofable one).
- Mail — `emailShell.ts` + `ticketingEmails.sendEmail`, transactional, **no
  unsubscribe footer and no `emailSuppressions` consult**, matching the
  documented split in `givingComms.ts`. A sign-in code is not marketing.
- Links — `siteUrl()`; add a `backerPortalUrl()` beside `givePageUrl()`.

New tables (two, both small): `backerPortalCodes` (email hash, code hash,
expiresAt, attempts, lastSentAt) and `backerPortalSessions` (token hash,
`identityId`/email, expiresAt, createdAt, lastSeenAt). Both are pure
capability rows — no money, no PII beyond a normalized email.

**Why not Option C — a real account in the app.** `apps/convex/auth.ts` uses
`createSupaAuth` email OTP and every data function goes through
`lib/access.ts#requireAccess`, which admits an email only if it is
`@publicworship.life` or has an active `accessAllowlist` row. Granting backers
allowlist rows technically works and there is a precedent for a *scoped* grant:
`doorAccess.ts` stamps `grantedVia: "door"` and `profiles.completeOnboarding`
explicitly refuses to let a door-stamped row become a chapter member. But note
what that precedent actually shows — a scoped allowlist row is **one forgotten
check away from full membership**, and that check had to be added by hand in a
second file. Multiplying that hazard by a donor list is a bad trade for a
read-only page, and it puts donors inside the Expo web bundle at `/os` (heavy,
and full of surfaces that would then need per-screen defence).

**Fallback / later:** if a backer ever needs to *do* something inside the OS,
Option C is the graduation path and it is real — add `grantedVia: "backer"` to
`accessAllowlist`, mirror the `completeOnboarding` refusal and the revoke
cleanup that `doorAccess.ts` already models, and link with
`guestSignInUrl(email)` (`lib/siteUrl.ts`), which already deep-links the Expo
login screen into guest mode pre-filled (`loginHelpers.ts#initialGuestState`).

---

## Gating it behind a power (CLAUDE.md: "Gate It Behind a Power")

Backers hold no seat, so the resolver has two halves and they must not be
confused. New file: **`apps/convex/lib/backerAccess.ts`**.

**Half 1 — authenticate the reader (a session, not a user).**
```
hasBackerSession(ctx, token) / requireBackerSession(ctx, token)
  -> { identityId, donorIds, scopes, isBacker }
```
Body today: resolve the session row → the `donorIdentities` row → its
`donors` rows (`by_identity`) → their `scopes`; `isBacker` uses the **exact**
existing predicate — an `active` pledge with `amountCents >= BACKER_UNIT_CENTS`
(`givingPledges.recomputeChapterBackerCount`, mirrored in
`givingPlatform.giverMarks`). Never re-derive that floor by hand.

**Half 2 — authorise each module (this is the "power" the house rule means).**
```
hasBackerModule(ctx, session, module) / requireBackerModule(...)
```
where `module` is a string from a new shared tuple `BACKER_PORTAL_MODULES`
(`packages/shared/src/`) — `"giving"`, `"backing"`, `"books"`, `"health"`,
`"events"`, `"people"`. Every portal query calls the `require` form; nothing
checks `isBacker` or a scope inline. Today the body is: own-giving modules
open to any authenticated giver; `books`/`health` require `isBacker` at that
scope. When the owner later wants "books off for Denver until it launches",
that is one resolver body, not fifty call sites — which is the entire point of
the rule.

**Half 3 — the staff side is a real seat capability.** Managing the portal
(see who has access, resend a link, revoke a session, flip a chapter's `books`
module) is a normal internal power and goes in `POWERS`
(`packages/shared/src/powers.ts`, domain `giving`, action `edit`) as
**`giving.portal.edit`**, carried by `development_director` and
`executive_director` in `SEAT_DEFS`, resolved through the existing
`lib/givingAccess.ts` machinery (`resolveGivingAccess` → central reach vs
chapter reach). Until that string ships, the resolver's body is
`requireGivingManage(ctx, scope)` with a comment naming the graduation —
exactly the pattern `backerMilestones.saveMilestones` already uses for its
`TODO(giving.manage)`.

**Academy:** a new power and a new user-facing surface both trip the Academy
rule in CLAUDE.md. Phase 1's PR must either add a lesson (a Development-path
lesson on what backers can see) or state "not training-worthy" explicitly, and
`packages/shared/src/academyPaths.ts` should be checked if a seat gains
`giving.portal.edit`.

---

## Phasing

### Phase 1 — one PR: "manage my backing, see my giving"
Everything here reads data that already exists; no new public claims about the
org are made, so nothing needs an owner policy decision first.

1. `lib/backerAccess.ts` (both halves above) + `BACKER_PORTAL_MODULES`.
2. `backerPortalCodes` + `backerPortalSessions` tables.
3. `lib/backerPortalPage.ts` (server-rendered, `landingPageStyles` palette) +
   `lib/backerApiRoutes.ts` (`/api/backer/code`, `/api/backer/verify`,
   `/api/backer/billing-portal`, `/api/backer/signout`) + the `/backer` route
   in `http.ts`. `no-store, private` on every response — the `/finances`
   preview-token branch documents exactly why a session-bearing URL must never
   be cacheable.
4. **Billing home (module 1).** Wire `createPortalSession` to the portal;
   **security fix in the same PR** — it stops taking `{ email, chapterId }`
   from anyone and takes a portal session instead; `return_url` → `/backer`.
   Handle `NO_STRIPE_CUSTOMER` and `origin: "imported"` as copy, not errors.
5. **Amount changes, ours (module 1).** New `changePledgeAmount` action:
   validate ≥ `BACKER_UNIT_CENTS` when the pledge is already at/above it, then
   `POST /v1/subscriptions/{id}` with `items[0][price_data]`. Create the
   `billing_portal.configuration` with `subscription_update.enabled = false`
   and pass its id on the session call. Fix the stale "$20 floor" comment on
   `pledges.amountCents`.
6. **Dunning rung 1 only (module 2).** `lib/backerDunningEmails.ts` with the
   day-0 email, scheduled from `markPledgePastDue`; all five
   `pledges.status` states rendered, `past_due` as a top-of-page banner. The
   weekly ladder is Phase 2 — one honest email beats a half-built sequence.
7. **Module 8 — the identity join** in `lib/backerAccess.ts` (foundational;
   modules 3, 12 and 13 all read through it), then modules 3, 6, 7 and
   11-unattributed (giving history / ladder / upcoming / share button).
8. `backerPortalUrl()` in `lib/siteUrl.ts`; replace the "just reply to this
   email" sentence in `lib/backerWelcomeEmail.ts` and
   `ticketingEmails.sendPledgeReceiptEmail` with a real button. The portal is
   worthless if backers never learn it exists — and the welcome email, which
   already lands on this branch, is the single best place to say so.
9. 60-day post-cancel access window (decision 4) in `lib/backerAccess.ts`.

### Phase 2 — the books, the map, the people
1. `publicLedger.publicScopeStatement({ scope, periodKey })` over the frozen
   `financePublication*` rows (reusable by the public page too).
2. **Module 4 with the chapter picker (decision 1)** — every book, not just
   yours, with the disclosure counters carried through; plus module 5
   (affordability + the gap + the milestone distance) and **module 16** (the
   map), which is a re-composition of already-public territory data.
3. **Module 9 — named people (decision 2).** Allow-list projection off
   `seats.chart`; leadership seats only; `hideFromPublicChart` opt-out on
   `people` shipped in the same PR.
4. **Module 14 — does it add up.** Org-wide gap from `reconciliationSummary`.
5. **Dunning rungs 2–4 (decision 5).** The `crons.ts` daily sweep, the
   rung stamp, and the re-read-status-at-send-time guard.
6. "As published on X" + a visible note when `staleSince` is set.
7. Per-chapter `books` module flag, flipped by `giving.portal.edit`.

### Phase 3 — the record and the plan
1. **Module 10 — the year's budget and progress**, with line items grouped by
   category (option (a)); `budgetLines.description` stays internal.
2. **Module 12 — events you've attended**, on the four-statement render.
3. **Module 13 — things you've bought** (tickets + registrations; merch is
   structurally unattributable and is simply absent).
4. **Module 15 — the gear**, from `assets.acquired` against
   `LAUNCH_EQUIPMENT_LINES`.
5. Billing follow-ups deliberately skipped earlier: a real Stripe
   `pause_collection` so `paused` stops being a local-only overlay (the
   documented follow-up in `setPledgeStatus`).
6. Optional / on demand: attributed sharing (module 11), a
   `budgetLines.publicDescription` field (module 10 option (b)), backer-only
   updates (module 17), and the `grantedVia: "backer"` allowlist graduation
   if a backer ever needs to write something.

---

## Screens — blocks in render order

Server-rendered, one column, max ~640px, `landingPageStyles` cream/dark-red
palette and `FONTS`/`FAVICON`, same as `/give` and `/contract`. Screens A–D are
Phase 1; E–H are the later phases, drawn to the same level so the mockup can
carry them.

**Copy rule throughout:** headings name the thing, numbers stand alone, no
caption defends a decision. See "A note on register" above.

### Screen A — Sign in  (`GET /backer`, no session)

1. **Wordmark + one line.** "Public Worship — Backer portal."
2. **H1.** "See your giving." Sub: "Enter the email you give with and we'll
   send you a 6-digit code."
3. **Email field + button** "Send me a code." Posts `/api/backer/code`.
4. **Code state** (same page, swapped): "We sent a code to s•••@gmail.com."
   Six-digit input, **Verify**, and a "Resend code" link that is disabled for
   60s (`RESEND_INTERVAL_MS`, `lib/emailCodes.ts`).
5. **Footer note.** "Not a backer yet? See the cities → `/give`" and "Our books
   are public → `/finances`."

**States.** *Unknown email:* deliberately identical to the success state — "If
that email is on file, a code is on its way." No enumeration oracle (the
`/finances` preview 404 sets this precedent). *Wrong code:* "That code didn't
match. N attempts left." (max 5). *Expired:* "That code has expired — send a
new one." (15 min). *Rate limited:* "Too many attempts recently. Please try
again in a bit." — the exact string `assertContractNotRateLimited` already uses.

### Screen B — Home  (`GET /backer`, signed in) — the main screen

1. **Header bar.** Wordmark · "Hi, Shante" (`greetingName(donor.name)`,
   `lib/backerWelcomeEmail.ts`) · "Sign out".
2. **⚠ Alert banner — ONLY when `pledges.status === "past_due"`.** Full-width,
   dark red, above everything. "Your last payment didn't go through." Body:
   "Your backing of Brooklyn is still on — we'll keep trying for a few days.
   Updating your card fixes it immediately." Button: **Update your card** →
   `/api/backer/billing-portal`. This block outranks the hero when present.
3. **Hero card — "Your backing."** The largest thing on the page.
   - Amount, huge: `formatCents(pledges.amountCents)` + "/month"
   - City: `chapters.name` for `pledges.scope`
   - "Backing since <`startedAt`>" · "Next charge <`currentPeriodEnd`>"
   - Status pill: Active / Past due / On hold / Ended
   - **Three buttons, and note the split** (module 1): **Change amount** opens
     our own step (block 3a); **Update card** and a quiet **Cancel** both go to
     Stripe's portal. Stripe never shows an amount control.
   - *Empty state* (a giver with no pledge): "You've given to Brooklyn, but
     you're not backing it monthly yet." → **Become a backer** (`/give/<slug>`).
   - *`canceled`*: "Your monthly backing ended on <`canceledAt`>. Thank you for
     the 14 months you gave." → **Start again**.
   - *`incomplete`*: "We never received a first payment." → **Finish signing up**.
   - *`origin: "imported"`*: "This monthly gift is on our old platform, so we
     can't manage it here." → **Move it over**.
3a. **"Change your amount" — our own step**, revealed inline (not a Stripe
   redirect). Preset chips $50 / $75 / $100 / $150 / $250 + a custom field,
   then **Confirm**. The **minimum selectable is $50** for a backer: chips
   below it don't render, and the custom field's inline hint reads "Backers
   give $50 a month or more." Server re-validates — the field is not the guard.
   Below the chips, live: "At $75/month you'd be part of getting New York to
   Eden." *Non-backer at $30/mo:* the floor shown is $5 and the copy says
   "Give $50 a month or more to become a backer." *On success:* the hero
   re-renders with the new amount and a quiet "Updated — your next charge is
   $75 on Sep 12."
4. **Stat strip — three tiles.** Lifetime given (`donors.lifetimeCents`, or
   `donorIdentities.lifetimeCents` across books) · Gifts (`giftCount`) · Backing
   since (`firstGiftAt`).
5. **"What your backing unlocks" card.** The ladder from
   `backerMilestones.listMilestones` (fallback `AFFORDABILITY_TIERS`), with a
   progress bar: current `chapters.backerCount` / `nextMilestone.minBackers`,
   and one line — "Brooklyn is 8 backers from Eden." Rungs render as
   `label` + `commitment`; the reached ones are ticked.
   *Empty:* if `nextMilestone` is null (top rung reached) — "Brooklyn has
   cleared every milestone."
6. **"Coming up in Brooklyn" card.** Up to 3 rows from published `eventPages`
   filtered to the backer's chapter: cover thumb (`/rsvp/<slug>/cover`), event
   name, date, venue, → the RSVP page. *Empty:* "Nothing on the calendar yet —
   we'll email you."
7. **"Your giving" preview.** Last 3 gifts (date · amount · method label) and a
   **See all** link to Screen C.
8. **"Send this to someone" card** (module 11, unattributed). One line —
   "New York is 8 backers from Eden." — the `/give/<slug>` link in a read-only
   field, **Copy link**, and a **Share** button where `navigator.share` exists.
   Pre-written text sits beneath, selectable: *"I back Public Worship New York
   — they're 8 backers from putting on Eden. $50/mo."*
9. **"How a chapter runs" card** — Phase 1 only, the generic
   `CHAPTER_CORE_ROLES` five roles with what each owns. **Replaced outright by
   Screen F's named block in Phase 2** — this is a placeholder, not a
   companion.
10. **Footer.** "Our books, every month → `/finances`" · "Questions? Reply to
   any email from us."

### Screen C — Your giving  (`GET /backer/giving`)

1. **Back link** + H1 "Your giving."
2. **Summary row.** Lifetime · Gifts · First gift · Cities backed
   (`donorIdentities.scopes` → chapter names).
3. **⚠ In-flight strip** — only when a `pendingGifts` row exists: "One gift of
   $50 is on its way — bank transfers take 2–4 business days." Never counted in
   the totals above.
4. **The list**, newest first, one row per `gifts` row: date · city · amount ·
   method label (`GIFT_METHODS`; `stripe` renders "Chapter OS") · an optional
   "covered the processing fee" tag when `feeCoverageCents > 0` (a note, never
   an addition — it is already inside `amountCents`).
5. **Reversal rows, inline and in place** — a `giftReversals` row renders where
   its gift was, struck through: "$500 · returned by your bank on Sep 3." This
   is the block that makes the page trustworthy; do not hide it in a tab.
6. **Grouped by year** with a per-year subtotal.
   *Empty:* "Your first gift will show up here."

### Screen D — Payment failed  (email → `/backer`)

Not a separate URL — it is Screen B with block 2 present and blocks 5–9
collapsed below the fold. Worth drawing separately because it is the screen a
declined backer actually lands on from `lib/backerDunningEmails.ts`, and the
whole page should read as one question with one button. At rung 3 the banner
gains a second, quieter action — **Stop my backing** — sitting beside "Update
your card". Rung 4's banner reads "Your backing is paused." with **Start
again**.

### Screen E — The books  (`GET /backer/books`) — Phase 2

1. **Back link** + H1 "The books."
2. **Chapter picker — a horizontal scroll of chips**, the backer's own city
   first and pre-selected, then Central, then every other chapter. Each chip
   carries name + backer count: `New York · 22` / `Central` / `Atlanta · 9` /
   `Denver · proposed`. Prospect/raising chapters render with their stage word
   instead of a count where `backerCount` is 0.
3. **Month picker** — a plain `<select>` of published months for the selected
   book, newest first, defaulting to the latest. Falls back to "Not published
   yet" when a chapter has no live publication, which is a real and honest
   state for a new city.
4. **Headline row — three big numbers.** In · Out · Net, for that book and
   month. Beneath, small: "Published <date> · revision N."
5. **"Where it came from"** — `incomeByStream` as a labelled bar list.
6. **"Where it went"** — two toggling views over the same money, **By
   category** and **By project**, each a bar list with amount and count.
7. **"Against the plan"** — `spendByBudget` rows: label, allocated, spent, and
   a bar. Rows with no allocation show "—", never "$0".
8. **Disclosure strip.** Small, plain, always present when non-zero:
   "3 lines reconstructed from records · 2 with no receipt · 1 with no
   explanation." No apology, no expansion of what it means.
9. **"Every line"** — the entry table, scrollable in its own container: date ·
   counterparty · purpose · category · amount · direction. Internal transfers
   and payouts render greyed with a "not counted" marker. **Download CSV**.
10. **Stale note** — only when `staleSince` is set: "The live books have moved
   since this was published."
11. **Footer link** — "Every book, every month → `/finances`."

### Screen F — Who runs it  (`GET /backer/people`) — Phase 2

1. **Back link** + H1 "Who runs New York." (Chapter picker as Screen E,
   block 2.)
2. **The chapter's leadership grid** — one card per seat, in chart order:
   photo (or initials), **name**, **seat title**. Five cards for a full
   chapter. A vacant seat renders in the same grid, greyed: "Treasurer — open."
3. **"Central"** — the same grid for `executive_director`,
   `financial_manager`, `development_director`, labelled "The people behind
   every chapter."
4. **One line, plain:** "Chapter leadership is volunteer." (This is a fact
   about the org, not a defence of the page.)
5. *No block explaining what is or isn't shown.*

### Screen G — The plan  (`GET /backer/plan`) — Phase 3

1. **Back link** + H1 "New York's 2026 plan." (Chapter picker; year select.)
2. **Headline pair.** "Planned $18,400" · "Raised so far $11,200", with a
   single progress bar between them.
3. **"What it's for"** — the approved budgets for that `(chapter, year)`, one
   row each: label, planned (`effectiveCapCents`), spent, bar. Sorted by
   planned, descending.
4. **Line items, grouped by category** — expandable under each budget row:
   category label + planned total only. **No free-text descriptions.**
5. **"The monthly floor"** — `MONTHLY_OPERATING_LINES` as a labelled list
   summing to ~$670, with one line: "What it costs to run a chapter for a
   month."
6. **Empty state:** "New York hasn't published a 2026 plan yet."

### Screen H — Your history  (`GET /backer/history`) — Phase 3

One screen, three stacked sections — it is all "what you've done with us".

1. **"Nights you've been to"** (module 12). One row per event: cover thumb,
   name, date, venue, and one of four plain labels — **"You were there"**
   (checked-in ticket) · "You had a ticket" · "You RSVP'd" · "You registered".
   Newest first. *Empty:* "We'll list nights here once you've been to one."
2. **"Things you've bought"** (module 13). Ticket orders and class
   registrations: date, event/class, items and quantities, total. *No merch* —
   and no note explaining its absence.
3. **"The gear your backing bought"** (module 15). A two-column list against
   the chapter kit: owned items with photo thumbs, then a **"Still needed"**
   sub-list from `assets.acquired === false` with the target price from
   `LAUNCH_EQUIPMENT_LINES`. Header line: "New York owns 34 of 41."

### Shared block — "Does it add up?" (module 14) — Phase 2

A single strip, rendered at the foot of Screen B **and** Screen E:

> **Does it add up?**
> Books say **$47,312** · We can point at **$47,312** · Difference **$0.00**

Three numbers on one line, the difference in the accent colour. When non-zero
it reads "Difference **$312** — being investigated" in the same plain register.
Org-wide only; no per-chapter cut, ever.

---

## Open questions for the owner

The five previously-open questions are now answered — see "Settled decisions".
These are what the new scope opened up.

1. **Portal for backers only, or every giver?** Still open, and it now matters
   more: decision 1 means the portal shows *every* chapter's books, so "who
   gets in" is the only remaining gate on that.
   *Recommended:* every giver with an email signs in and sees their own giving;
   the books, the plan, the people and the gap need an active pledge ≥ $50/mo.
   It keeps "backer-only" meaningful without telling a $30/mo giver we don't
   know who they are.
2. **Do we show a city's gap when it's negative?**
   *Recommended:* yes — the most honest and most motivating number we have.
   Framed as the org's position, never as a team's failure, and never with the
   bookkeeping-hygiene counters attached.
3. **Full names, or first names, for the chapter team?** (Decision 2 settled
   *that* we name them, not *how*.)
   *Recommended:* full name for the leadership seats a funder is entitled to
   identify — Chapter Director, Treasurer, and the three central seats — and
   first name only for anyone else. Photos for all, with the
   `hideFromPublicChart` opt-out.
4. **Budget line items: categories now, or free text later?**
   *Recommended:* categories only (module 10, option (a)). Free-text
   descriptions can name a person's pay, and publishing them would undo the
   care the public ledger takes to keep contractor identities out. If the
   detail is genuinely wanted, it's a `publicDescription` field and a pass by
   the treasurer — a Phase 3 decision, not a Phase 2 shortcut.
5. **Attributed sharing — do we want to know who brought whom?**
   *Recommended:* not yet. The share button is free; attribution is four files
   and a change to the checkout payload, which is the most safety-critical path
   in the codebase. Build it when there's a reason to show the number, and even
   then show counts only — never who.
6. **Merch history can't be built. Is that acceptable, or worth fixing at the
   till?** `sales` captures no buyer identity at all, because the Tap-to-Pay
   app sends none.
   *Recommended:* accept it. The fix is asking for an email at a merch table
   mid-event, which costs more in friction than the module is worth — and the
   giving half of a bundled sale is already attributed via `donationGiftId`.
