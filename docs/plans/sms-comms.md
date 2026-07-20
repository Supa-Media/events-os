# SMS opt-out tracking + cost accounting (Attendance F)

**Status: shipped.** This is an addendum to the Attendance F SMS work
(`apps/convex/lib/twilio.ts`, `blasts.ts`, `ticketingSms.ts`). It adds three
things Attendance F shipped without: a queryable STOP/START opt-out ledger, a
per-send cost/usage ledger, and a cost preview in the blast composer.

## 1. Opt-out tracking

Twilio's Messaging Service already enforces STOP compliance at the carrier
level via **Advanced Opt-Out** — that's the real compliance guarantee, and it
keeps working even if everything below is broken or unconfigured. What
Advanced Opt-Out does NOT give the app is a way to **ask** "has this number
opted out?" before spending a send. `smsOptOuts` (`schema/smsOptOuts.ts`) is a
defense-in-depth **mirror** of that state, deployment-wide (not chapter-scoped
— STOP is a per-phone-number opt-out, not per-chapter):

```ts
smsOptOuts: {
  phone: string;          // normalized E.164
  source: "stop_webhook" | "manual";
  note?: string;
  createdAt: number;
  createdBy?: Id<"users">;
}
```

### The webhook

`POST /twilio/webhook` (`http.ts`) is Twilio's inbound-message callback.
Point a Messaging Service's inbound webhook at:

```
https://<deployment>.convex.site/twilio/webhook
```

Every request is validated against `X-Twilio-Signature`
(`lib/twilio.ts#validateTwilioSignature`, unit-tested in `tests/twilio.test.ts`)
before anything else happens — HMAC-SHA1 over the full request URL + the
sorted POST params, base64-encoded, using Web Crypto (`crypto.subtle`) since
Convex http actions run on V8, not Node (mirrors `verifyStripeSignature` /
`verifyIncreaseSignature`'s HMAC-SHA256 approach). `MessageSid` is deduped
through the existing `webhookEvents` ledger (shared with Stripe/Increase).

Keyword handling (case-insensitive, trimmed):

| Body | Effect |
| --- | --- |
| STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT | upsert an `smsOptOuts` row (`source: "stop_webhook"`) |
| START, UNSTOP, YES | delete the row (re-subscribe) |
| anything else | silent no-op — this app has no two-way SMS conversation |

The route always responds with empty TwiML (`<Response/>`, `text/xml`) so
Twilio never auto-replies on our behalf.

### Where it's enforced

`blasts.ts`'s `phoneRecipients()` takes an `optedOut: Set<string>`
(`smsOptOuts.ts#optedOutPhoneSet`) and filters the audience, reporting a
count separately (`optedOutCount`) rather than just silently shrinking the
list. It's checked **twice**:

1. **At preview/schedule time** — `previewBlastAudience` (composer) and
   `getBlastPayload` (the row `deliverBlast` actually sends from).
2. **At send time** — `deliverSmsBlast` re-fetches the current opt-out set
   right before sending (`smsOptOuts.listOptedOutPhones`), catching a STOP
   that lands in the gap between scheduling and the action actually running.

Verification codes (`ticketingSms.ts`) are transactional and do NOT check
this table — Attendance F's original design already omits the "Reply STOP"
disclosure line from them, and Advanced Opt-Out still blocks them at the
carrier level regardless.

## 2. Segment estimation + pricing

`packages/shared/src/sms.ts` — shared between the Convex backend and the Expo
app so the estimate never drifts between the composer's live preview and what
actually gets billed:

- `estimateSegments(body)` — GSM-7 vs UCS-2 detection (any character outside
  the GSM-7 basic+extension repertoire, most emoji included, downgrades the
  WHOLE message to UCS-2). 160 chars/segment single, 153/segment once
  concatenated for GSM-7; 70/67 for UCS-2. GSM-7 extension characters
  (`€ [ ] { } ^ | ~ \`) count DOUBLE (they need an escape sequence). An empty
  body still costs one segment.
- `SMS_SEGMENT_PRICE_USD_MICROS = 10_000` (≈ $0.01/segment) — an **estimate
  constant**, not a live rate pulled from Twilio's pricing API. Real
  per-segment cost varies by destination carrier and changes over time; this
  is a ballpark of US long-code/Messaging-Service SMS + typical carrier fees,
  good enough for a budget-planning preview, not a billing reconciliation.
- `estimateSmsCostUsdMicros(body, recipientCount)` — segments × price ×
  recipients.

## 3. Usage/cost ledger

`smsUsageEvents` (`schema/smsUsage.ts`) — one row per SEND ATTEMPT, the
Twilio analog of `aiUsageEvents` (finance auto-coding's OpenRouter audit
trail):

```ts
smsUsageEvents: {
  chapterId: Id<"chapters"> | "central";
  purpose: "blast" | "verification";
  blastId?: Id<"blasts">;
  eventId?: Id<"events">;
  phoneLast4: string;     // NEVER the full phone number
  segments: number;
  costUsdMicros: number;  // 0 for "failed"/"opted_out" — no real spend
  outcome: "sent" | "failed" | "opted_out";
  createdAt: number;
}
```

Written by:
- `blasts.ts#deliverSmsBlast` — one row per phone in the audience
  (`sent`/`failed`/`opted_out`), chapter-attributed from `blasts.chapterId`.
- `ticketingSms.ts#sendVerificationSms` — one row per code text
  (`purpose: "verification"`), chapter-attributed by looking up the RSVP's
  `chapterId`/`eventId` (`ticketingSms.ts#getRsvpScope`); falls back to
  `"central"` if the RSVP scope can't be resolved.

`smsUsage.getSmsSpendSummary` (central ED/FM-gated, same as
`aiCodingData.getUsageSummary`) rolls this up: current + previous UTC-calendar
-month totals split by purpose, plus a per-chapter breakdown for the current
month. Only `outcome: "sent"` rows count toward spend — a failed send or a
send skipped for an opt-out never actually billed. `TwilioUsageSummary.tsx`
(`apps/mobile/components/integrations/`) renders it; it is **exported but not
yet mounted** in `integrations.tsx` — drop it in below the Twilio connection
card.

## 4. Cost preview in the composer

`previewBlastAudience` takes an optional `body` (the draft message text) and
returns `estimatedSegments` / `estimatedCostUsdMicros` (computed against the
EXACT wire body, including the "Reply STOP to opt out." suffix
`deliverSmsBlast` appends) plus `smsOptedOut` (how many audience numbers were
excluded for having opted out). `BlastComposerCard.tsx` debounces the draft
body (400ms) before it drives the query, and renders:

```
112 people · ~2 segments each · est. $2.24 org cost
3 opted out and will be skipped.
```

## 5. Finance recipe

SMS spend is deliberately **not** metered per-text into the transaction
ledger — that would be a huge number of sub-cent line items for zero
bookkeeping value. Instead:

1. Create a **"SMS / Texting" budget category** (`finances.createCategory`,
   `kind: "lineItem"`) under whichever fund covers comms spend.
2. Create a **recurring monthly budget** against it
   (`finances.createBudget`, `type: "recurring"`, `cadence: "monthly"`) — a
   starting-point amount like $50/month covers most single-chapter SMS
   volume; raise it once `getSmsSpendSummary` shows it's tight.
3. **Chapter vs. central attribution**: start every chapter on ONE shared
   central "SMS / Texting" line (`chapterId: "central"` on the budget) unless
   a chapter is clearly heavy-volume. The usage ledger's per-chapter rollup
   (`getSmsSpendSummary.byChapter`) is exactly the signal for "this chapter
   should carry its own budget line" — when one chapter's monthly segment
   count dwarfs the others, give it its own chapter-scoped recurring budget
   instead of drawing down the shared central one.
4. When the actual Twilio invoice arrives, record it as a normal manual
   transaction against that budget/category (the existing manual-transaction
   flow, `finances.createManualTransaction`) — the usage ledger is a planning
   /estimate tool, not a substitute for the real invoiced actual.

## 6. Ops — Twilio console setup

- **Messaging Service → Integration → Inbound Settings**: set "A MESSAGE
  COMES IN" to a webhook, URL = `https://<prod-deployment>.convex.site/twilio/webhook`,
  method POST.
- **Advanced Opt-Out**: enable it on the Messaging Service (Twilio's own
  carrier-level STOP enforcement) — `smsOptOuts` is a mirror, not a
  replacement.
- **A2P 10DLC registration**: required before sending donor/marketing
  campaigns (blasts) to US numbers at any real volume — unregistered traffic
  gets filtered/throttled by carriers. Registration (brand + campaign) has a
  **multi-week lead time** through Twilio's review process — start it well
  before a launch date that depends on blasts working, not the week of.

## Open questions / follow-ups

- `TwilioUsageSummary.tsx` needs to be mounted in `integrations.tsx` by
  whoever owns that file next (not touched here — a concurrent change owned
  it during this work).
- `smsOptOuts.source: "manual"` is modeled in the schema but nothing writes
  it yet — a future "block this number" admin action could use it.
- No public/admin surface lists or clears `smsOptOuts` rows directly today;
  only the webhook and (implicitly) a future manual tool would write to it.
