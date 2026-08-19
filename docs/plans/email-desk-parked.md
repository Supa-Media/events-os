# The in-app Emails desk is parked — bulk email goes out through Mailchimp

**Decided:** 2026-08-19 · **Decider:** founder · **Status:** in effect

Public Worship's newsletters and announcements are sent from **Mailchimp**.
The in-app Emails desk (`campaigns.ts`, `audiences.ts`, the document editor,
themes, templates, the image library, two-party approval, the reply inbox) is
**still in the tree and still works**, but it is hidden from nav by default and
nobody should start a new send there.

This document is the decision, what replaced it, and — the part worth keeping —
**what the custom stack would still need before it was truly ready to use.**

---

## Why Mailchimp

Not because the desk failed at what it was built to do. Because of what
surrounds it:

- **Pasted HTML formats better.** The concrete trigger. Design made in Canva or
  by hand survives the paste into Mailchimp; through our own sanitizer and
  vendored renderer it degrades.
- **Tracking exists.** Opens, clicks, per-campaign reports. We have none.
- **The ecosystem.** Templates, signup forms, automations, deliverability
  tooling, and a labour market that already knows the product.

The build was not wasted. The *rules* it encoded are org policy now and carry
over to how Mailchimp gets used — see "What should survive" below.

## What replaced it

| Thing | Where it lives now |
| --- | --- |
| Composing + sending bulk email | Mailchimp |
| Keeping the list accurate | `mailchimpSync.ts` — nightly cron + "Sync now" |
| Unsubscribes / bounces / complaints | `/mailchimp/webhook` → `emailSuppressions` |
| Credentials + the desk's visibility flag | Profile → Integrations |

**Transactional email did NOT move** and is unaffected: RSVP verification,
budget-decision notices, reimbursement and approval mail, receipt inbound OCR,
door-access links, event blasts. Those still send through Resend from this app.

### The suppression ledger is shared, deliberately

An unsubscribe in Mailchimp writes a row into `emailSuppressions`, the same
deployment-wide do-not-email ledger `blasts.ts` already reads. Someone who
unsubscribes from the newsletter therefore also stops receiving event blasts.
Without that pull-back the two systems would disagree and this app would be the
one in the wrong.

The reverse does **not** happen: a re-subscribe in Mailchimp does not
un-suppress an address here. Un-suppressing stays a deliberate human act
(`emailSuppressions.unsuppressEmail`) — see
`MAILCHIMP_SUPPRESSION_EVENTS`' doc for why.

---

## What the custom stack would need before it was truly ready

Every claim here was checked against the code at the time of parking. Ordered
by what actually blocked adoption.

### Blocking — the reasons we left

1. **Rendering fidelity for pasted HTML.** `docFormat: "html"` (#472) runs
   pasted markup through `emailHtmlCss.ts` / `emailHtmlImport.ts` and re-hosts
   images. Needs a real CSS inliner with a documented supported-property list,
   table-layout normalization, and a regression corpus of actual exported
   designs.
2. **No engagement tracking at all.** No opens, no clicks, no per-campaign
   report — `/resend/webhook` treats tracking events as a deliberate no-op and
   there is no `openedAt`/`clickedAt` in the schema. Needs a tracking pixel,
   link rewriting, per-recipient event rows, and a report screen. **This is the
   prerequisite for every item in the next section** — they are all measured by
   it.
3. **No client-rendering verification.** The preview pane is *our* renderer,
   not a real mail client. Nobody has ever seen a send in Outlook for Windows.
   Needs an inbox-placement service or a manual client matrix per template
   change.
4. **Deliverability is invisible.** No bounce-rate or complaint-rate dashboard,
   no automatic send pause at a threshold, no domain reputation view, no seed
   list. We would learn about a problem from recipients.

### Important — needed for a real marketing practice

5. **Scheduled sends.** No `scheduledFor`/`sendAt` on `campaigns` — a send
   happens when a human presses the button. No timezone awareness.
6. **A/B testing.** No variant concept anywhere in the schema.
7. **Automations / journeys.** Welcome series, lapsed-backer re-engagement,
   post-event follow-up — all manual.
8. **List-growth surfaces.** No signup form, embed, landing page, or QR code.
9. **Double opt-in and a preference center.** Neither exists. Consent is one
   bit (`people.marketingOptOut`) plus the suppression ledger, so a recipient
   cannot opt *down* to "events only" — their only lever is to leave entirely.
10. **Template library.** One built-in newsletter plus whatever the team saves.

### Structural — the cost of keeping it

11. **Send throughput and reliability.** `deliverCampaignBatch` sends 100 per
    action invocation, paced 600ms, self-rescheduling — and needs a "stuck
    campaign send sweep" cron to rescue sends that die mid-flight. The
    sweeper's existence is the honest measure of that path's fragility.
12. **Soft-bounce handling is coarse.** `classifyBounce` treats anything not
    explicitly transient as permanent, including unclassifiable bounces.
    Deliberate and documented, but good addresses get suppressed on ambiguous
    signals and only a human can undo it.
13. **The maintenance surface.** ~44,600 lines across ~150 files, including a
    **vendored fork of the maily.to renderer** (`packages/email-render`) tracked
    upstream by hand, wired into seats/powers, Academy lessons, governance docs
    and 7+ migrations.

### What should survive — and does

These are the parts worth more than the code, and they are now *practice*
rather than tooling:

- **Two-party approval** with a chosen reviewer and a snapshot hash that
  invalidates on edit. Mailchimp has no equivalent, so this is a rule the org
  holds itself to when sending from Mailchimp.
- **Suppression checked twice** — at materialize and again immediately before
  each send — shared across campaigns *and* event blasts. The sync keeps this
  true across the Mailchimp boundary.
- **Consent beats a hand-pick.** An explicitly added person is still dropped if
  suppressed or opted out. Carry this into Mailchimp segment building.
- **The segment builder's plain-English recap** and per-person "why" explainer.
  Genuinely better than Mailchimp's own segment UI.

---

## If we ever restart

Start at 1–4, in order, and build nothing from "Important" until tracking (2)
exists. Realistic cost to reach parity with what Mailchimp gives us for free:
substantially more than the eight days (2026-07-20 → 07-30, 12 PRs,
+67.5k/−8.4k lines) that built the current stack.

## Turning the desk back on

Profile → Integrations → Mailchimp → "Show the Emails desk". It is a
nav-visibility flag only (`integrationSettings.legacyEmailDeskEnabled`); every
campaigns route stays reachable by direct URL with its in-screen guards
unchanged, so an in-flight send can always be finished and the history stays
readable.
