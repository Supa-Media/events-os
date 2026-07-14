# Giving (M5.1) — donations on the Event page

**Status: building (autonomous, 2026-07-14).** First roadmap feature after the
Academy redesign. Self-contained per rebrand plan §7a/§7d — records the money
flow the schema couldn't (Eden's "donations QR + merch table": card + cash).

## Problem

The Event page tracks ticket revenue to the cent but has **no way to record a
donation** — the actual money flow at Eden was a donations QR + a cash merch
table, invisible to the schema. Giving adds a first-class donation record.

## Design (mirrors the ticket-order money machinery — no parallel system)

Money stays integer **cents**; `currency` stays `"usd"`. The design reuses the
existing verified Stripe + webhook + landing + admin patterns 1:1.

### Schema (`schema/ticketing.ts`)
- **`donations`** table — the donation record, shaped like `ticketOrders` minus
  line-items: `chapterId`, `eventId`, `name`, `email?` (lowercased), `amountCents`
  (int > 0), `currency`, `method` (`card` | `cash` | `other`), `status`
  (`pending` | `paid` | `refunded` | `canceled` | `expired`), `note?`, `rsvpId?`,
  `stripeCheckoutSessionId?`, `stripePaymentIntentId?`, `recordedBy?`
  (`Id<"users">`, set for manual entries), `createdAt`. Indexes `by_event`,
  `by_stripe_session`.
- **`eventPages`** gains: `givingEnabled?`, `givingPrompt?` (custom "support
  this event" copy), `suggestedAmountsCents?` (preset buttons), and the
  denormalized rollup **`donationsCents?`** + `donationsCount?` (siblings of
  `revenueCents`).

### Two ways money arrives (both write `donations`, both bump the rollup)
1. **Card (public, Stripe)** — mirrors `stripe.createCheckout` → `prepareOrder`
   → Stripe Checkout → webhook → `fulfill`:
   - `createDonationCheckout` action (public, no auth; published + givingEnabled
     gated) → `prepareDonation` internalMutation (validate amount > 0, ensure an
     rsvp identity like `prepareOrder`, insert `pending` donation) → single-line
     Stripe session (`metadata.donationId`) → return `{kind:"stripe", url}`.
   - The **shared `/stripe/webhook`** settles it: `markDonationPaid` (by session)
     is called alongside `markSessionPaid` — each no-ops if the session isn't
     theirs. `fulfillDonation` is idempotent (returns if already paid), sets
     `paid` + `stripePaymentIntentId`, bumps `page.donationsCents/Count`, marks
     the rsvp email verified, schedules a receipt email.
2. **Manual (internal, cash/other)** — `recordDonation` mutation (`requireEvent`
   gate): validates cents, inserts a `paid` donation with `recordedBy`, bumps the
   rollup. `removeDonation` decrements the rollup and deletes.

### Public endpoint + landing UI
- `/api/tickets/donate` joins `ticketApiRoutes` (`jsonPost` wrapper) → `createDonationCheckout`.
- `getPublicPage` payload gains `givingEnabled`, `givingPrompt`,
  `suggestedAmountsCents`, `donationsCents`, `donationsCount`.
- Landing (`landingPage.ts` + `landingPageClient.ts`): a `#givingcard` in the
  right aside next to `#ticketscard`; `renderGiving()` (suggested-amount buttons
  + custom amount + name/email + Give) and `startDonation()` (POST `/donate` →
  redirect to Stripe), mirroring `renderTickets`/`startCheckout`. Return
  `/e/<slug>?donated=1` shows a thank-you. Shows "$X raised" for social proof.

### Internal UI (mobile `TicketingTab`)
- A **"Given"** `StatCard` in the At-a-glance strip (`formatMoney(page.donationsCents)`).
- A **`GivingCard`**: total raised + count, the donation list (`listDonationsAdmin`),
  a "Record donation" manual-entry form (amount via `parseDollars`, method
  cash/other, name?, note?), and remove.
- A **Giving toggle** + prompt field in `PageSetupCard` (`updatePage.patch`).

### Access
Admin functions gate via `requireEvent`/`requireOwned` (`@publicworship.life` /
allowlist). Public functions gate only on the page being `published` +
`givingEnabled`, never `requireAccess` — identical to the ticket public surface.

### Emails
`sendDonationReceiptEmail` internalAction (sibling of `sendTicketsEmail`).

## Explicitly deferred (fast-follow, not this PR)
- Recurring/pledged giving; refunds beyond a status flag; a "donors" blast
  audience; per-donation tax receipts. Giving-into-Budget rollup lands with the
  Budget feature (M5.4).

## Verification
Backend tests: manual record + rollup, remove + decrement, access gating,
`prepareDonation` validation, `fulfillDonation` idempotency + rollup,
`markDonationPaid` by session, webhook double-path no-op safety. Full matrix +
a money-flow-focused adversarial review before merge.
