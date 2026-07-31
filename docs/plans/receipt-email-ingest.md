# Receipt email ingest — inbound OCR → reconcile pipeline

Backfilling a large pile of receipts by hand is slow. This pipeline lets a
receipt be **emailed** to `receipts@publicworship.life`; the backend OCRs it,
matches it to an already-synced card transaction that's missing a receipt, and
attaches it automatically when the match is unambiguous. Everything ambiguous
lands in a bookkeeper review queue.

## Two addresses, one inbox

- **`receipts@publicworship.life`** — the **Google Group** humans know and use.
- **`receipts@reply.publicworship.life`** — the Resend inbound address, a
  **member** of that group. Mail sent straight here works too.

Google relays every post to the group on to its member, so both routes land on
the same webhook. Two things fall out of the relay, and the pipeline handles
both explicitly:

1. **The relayed post still names the GROUP in `To:`.** Our member address only
   appears on the SMTP envelope, which Resend surfaces as `received_for`. The
   route matches on To + Cc + `received_for`, and both addresses are in the
   inbox allow-list — matching on the member address alone silently dropped
   every group-forwarded receipt.
2. **Google rewrites `From:`** to the list (`"Jane D. via receipts"
   <receipts@publicworship.life>`) whenever the poster's domain publishes a
   strict DMARC policy. The real poster is stamped into `X-Original-Sender`, so
   `resolveListSender` reads it back before classifying — otherwise a team
   member's receipt resolves to no roster row and can never auto-attach. The
   header is only honored on mail that actually arrived via a list (`List-Id` /
   `List-Post` / `Mailing-list` present).

A courtesy reply is never sent to either address (`isReceiptInboxSelf`) — that
would fan a robot ack out to every group member and be relayed straight back in
as a fresh receipt.

## Flow

```
email → receipts@publicworship.life  (Google Group; relays to its member,
                                      receipts@reply.publicworship.life)
      → Resend inbound (email.received webhook, Svix-signed)
      → POST /resend/inbound            (http.ts — verify + address-filter on
                                         To + Cc + received_for + dedup +
                                         schedule; mail to any OTHER address
                                         on the domain is ack'd and skipped)
      → recordInboundReceipt            (dedup on Resend's email_id)
      → processInboundReceipt (action)  (receiptInbox.ts)
           0. recover the poster behind a list relay (X-Original-Sender)
           1. resolve sender → people row (auth gate; unknown → ignored)
           2. get content: image/PDF attachment (Resend Attachments API)
              — a forwarded-as-attachment .eml is OPENED first and replaced
                by the receipt(s) inside it (lib/emlMessage.ts)
              else the email body text
           3. read the total:
                • body  → parseReceiptFromText   (regex, ZERO LLM)
                • image → ocrReceiptImage         (OpenRouter vision, cheap model)
           4. findReceiptMatches: exact-cent, ±14 days, sender's chapter
           5. exactly one → attach + (reconcile if already categorized) + unlock card
              0 or >1 or unreadable → needs_review / no_match
           6. queue the outcome into the sender's reply digest (debounced)
```

## One reply per sender, not one per receipt

The courtesy reply is **debounced**. The first receipt from an address opens a
batch (`receiptReplyBatches`) and schedules its flush `REPLY_DEBOUNCE_MS`
(10 minutes) later; every receipt from that address in the meantime joins the
same batch, and the flush sends exactly **one** digest covering all of them.

- Someone forwarding a stack of receipts in one sitting gets one email, and a
  backfill replaying months of receipts can't blast a burst of them.
- The window is fixed from the **first** receipt, never extended by later ones,
  so a steady trickle can't postpone a reply indefinitely — a sender always
  hears back within 10 minutes of their first receipt.
- The flush **claims** the batch (stamps `sentAt`) in the same transaction it
  reads the items, so a double-fired schedule can never send the same digest
  twice. A send failure loses that digest rather than risking a duplicate —
  the reply is best-effort by contract, and every receipt's terminal status was
  written long before the flush ran.
- A **single** receipt reads exactly as it always did; only a multi-receipt
  batch gets the summary-plus-list voice. Past 50 items a batch counts the rest
  into `overflowCount` and says "+N more" rather than dropping them.
- The loop guard applies before a batch is opened: nothing is ever queued for
  the receipts inbox or the group fronting it.

**Money safety:** the model never categorizes or moves money — it only reads a
total off a receipt. The single money-adjacent write (`applyReceiptAttachment`)
only attaches a receipt and, at most, flips an *already-categorized* charge to
`reconciled`. Ambiguity always defers to a human. Mirrors the AI-coding rule.

## Forwarding a receipt email

Two shapes both work:

- **Forward inline** (the ordinary "Forward") — the merchant's text comes
  through in the body, and any receipt image/PDF rides along as an attachment.
  The forward banner Gmail/Apple Mail/Outlook paste above the quoted message
  is parsed for the ORIGINAL envelope (`parseInlineForwardEnvelope`), so the
  merchant reads as "Uber Receipts", not as whatever line the forwarded
  marketing email happened to lead with (or the forwarder's own "paying it
  back" note).
- **Forward as attachment** (Gmail/Apple Mail/Outlook) — the original message
  arrives wrapped as a `message/rfc822` (`.eml`) attachment, with an empty
  outer body. `lib/emlMessage.ts` (a small, dependency-free MIME parser) opens
  it and hands the pipeline what's inside: the original's own image/PDF
  attachments if it has any, otherwise its body text. A forward chain (a
  forward of a forward) is unwrapped up to `MAX_EML_NESTING_DEPTH`, and several
  messages forwarded in one email each become their own receipt (bounded by
  `MAX_RECEIPT_SOURCES`).

  The merchant fallback (`deriveMerchantFromEmail`) uses the **forwarded
  message's** envelope, not the forwarder's — a receipt forwarded by a team
  member reads as "Google Payments", never as their own mail host. An `.eml`
  nothing could be read out of is still stored as a document for the review
  queue rather than silently ignored.

## Matching defaults (tunable in `receiptInbox.ts`)

- **Amount:** exact to the cent.
- **Date window:** ±14 days of the charge's `postedAt` (`MATCH_WINDOW_MS`) —
  settlement lags the receipt date.
- **Scope:** the sender-person's chapter (indexed `by_chapter_and_postedAt`).
- **Merchant:** token overlap is a confidence booster / tiebreak, never a filter.
- **Auto-attach** only on a *unique* candidate; `reconciled` only if the charge
  was already `categorized` (an `unreviewed` charge is left for the AI coder /
  human to code).

## Setup

### 1. DNS (already done for `reply.publicworship.life`)
Inbound MX records for the subdomain must point at Resend's inbound servers.

### 2. Resend webhook
In the Resend dashboard → **Webhooks**, add a webhook for the `email.received`
event pointing at:

```
https://<your-convex-deployment>.convex.site/resend/inbound
```

Copy the webhook's **signing secret** (`whsec_…`).

### 3. Environment variables (Convex dashboard → Settings → Environment Variables)

| Variable | Purpose |
| --- | --- |
| `RESEND_INBOUND_WEBHOOK_SECRET` | The `whsec_…` signing secret from step 2 (required — the route 500s without it, unless set in-app instead — see below). |
| `RESEND_API_KEY` | Already set (outbound). Also used to fetch inbound attachments + reply. |
| `OPENROUTER_API_KEY` | Already set (AI coding). Used for image OCR only. |
| `RECEIPT_OCR_MODEL` | *Optional.* Override the OCR model. Defaults to a cheap vision model (`google/gemini-2.0-flash-001`). Point it at any OpenRouter vision model — free/cheap for a big backfill, stronger if scans read poorly. |
| `RECEIPT_INBOUND_ADDRESSES` | *Optional.* Comma-separated allow-list of addresses treated as the receipts inbox, matched against To + Cc + `received_for`. Defaults to `receipts@reply.publicworship.life,receipts@publicworship.life` (the inbound address and the Google Group fronting it). Mail to any other address on the domain is acknowledged but not processed. **Overriding this replaces the default entirely — include the group address, or group-relayed receipts stop being ingested.** |

The webhook signing secret can instead be set IN-APP at profile >
integrations (superuser-only, "Receipt inbox (Resend)" section) rather than
as a deployment env var — the stored setting wins over
`RESEND_INBOUND_WEBHOOK_SECRET` when both are present, same resolution order
as the Givebutter API key and Twilio credentials on that screen.

Degrades gracefully: no `OPENROUTER_API_KEY` → image receipts route to review
(the file is still stored); no `RESEND_API_KEY` → no attachment fetch/reply.

## Review queue (in-app, bookkeeper+)

- `receiptInbox.listInboundReceipts` — the rows a human must act on
  (`needs_review` + `no_match`), each with a servable URL for the stored file.
- `receiptInbox.manualMatchInboundReceipt` — attach a queued receipt to a chosen
  transaction (same effect as the auto path).
- `receiptInbox.dismissInboundReceipt` — mark a non-receipt / duplicate `ignored`.

(These backend functions exist; a dedicated mobile UI for the queue is a
follow-up — today a bookkeeper can drive them directly.)

## Who can email receipts

Anyone can send; the endpoint is public and Svix-signed. Sender identity is an
AUTOMATION axis, not a gate: only a sender that resolves to a `people` roster
row (matched against `email` or `pwEmail`, case-insensitive — after list-relay
recovery, see above) may trigger an **auto-attach**. Everything else is still
OCR'd and stored, but routed to the bookkeeper review queue and never replied
to.

## Recovering receipts sent before the relay was handled

`apps/convex/receiptInboxBackfill.ts` is the catch-up, for two distinct losses.
Both passes are internal (ops-dispatch only — no UI, no cron), **dry-run by
default**, and idempotent. Run the dry run first and read the counts.

| Pass | Fixes | Dry run | Execute |
| --- | --- | --- | --- |
| `backfillMissedReceiptEmails` | Group-relayed mail the address filter dropped before it recognized the group. These have **no row at all** — they exist only on Resend's side. | `{}` | `{ execute: true }` |
| `reattributeRelayedReceipts` | Rows that WERE recorded but attributed to the list instead of the poster (Google's DMARC `From:` rewrite), so they never drew a person or chapter. | `{}` | `{ execute: true }` |
| `restoreEmailBodyDocuments` | Receipts whose stored document was written from the message's plain-text alternative with no charset — the wall of run-together text with mojibake. Re-fetches each message and rebuilds the document through `buildBodyDocument`. | `{}` | `{ execute: true }` |

Both take `limit` (default 100, max 500); the first also takes `sinceMs` to
bound how far back it looks.

- Pass 1 lists Resend's received mail, keeps what was addressed to a receipts
  inbox address, skips anything already recorded (the same `emailId` dedup that
  guards the webhook), and schedules the ordinary pipeline — so a recovered
  receipt gets the same OCR, matching, and auto-attach bar it would have had.
- Pass 2 is **metadata only** and never attaches a receipt to a charge: a
  months-old match is a human's call, and those rows are already sitting in the
  review queue for one.
- Pass 3 swaps the **file and nothing else** — no re-OCR, no re-matching, and
  every receipt↔transaction link stays as a human left it. It repoints the
  denormalized `transactions.receiptStorageId` cache in the same transaction as
  the swap (otherwise a reconciled charge would point at a deleted blob), and
  only deletes the old file once that has committed. A message Resend no longer
  holds is left exactly as it is rather than replaced with nothing. Its
  idempotency marker is the stored blob's own charset.
- Pass 1 matches on the list response's `to`/`cc`. Resend's `received_for` is
  not dependable on the *list* endpoint (only on a single retrieve), so a
  message that named neither receipts address in its headers — a pure BCC or
  alias delivery — won't be picked up. Nothing observed so far has that shape:
  a group relay always names the group in `To:`.
- Retention: Resend stores received email server-side, but its retention window
  isn't documented publicly. If a very old receipt doesn't come back, it's
  likely aged out of Resend, and re-forwarding it is the fix.

### DNS caveat for the group route

Google Groups accepts a post before it relays, so mail to
`receipts@publicworship.life` bounces at Google, not at us, if the group's
posting permissions reject the sender. If a team member reports "I sent it and
nothing happened," check the group's **Who can post** setting first — a
rejected post never reaches Resend and so leaves no inbound row at all.

## SMS/MMS ingest (Twilio) — the same pipeline, texted instead of emailed

A receipt can also be **texted** (photo or a typed total) to a dedicated
Twilio number. It feeds the exact same `receipts`/`receiptLinks` tables and
the exact same OCR → match → auto-attach policy as the email pipeline above —
see `apps/convex/smsReceipts.ts`'s module doc for the full walkthrough.

### Flow

```
text/MMS → the receipts number
         → Twilio inbound-message webhook (form-encoded, X-Twilio-Signature)
         → POST /twilio/receipts          (http.ts — verify signature +
                                            dedup + schedule; acks an empty
                                            TwiML <Response/> either way)
         → recordSmsReceipt               (dedup on Twilio's MessageSid)
         → processSmsReceipt (action)     (smsReceipts.ts)
              1. classify sender by PHONE → team / roster / external
                 (no "internal" — a phone has no org-domain equivalent)
              2. get content: every MMS photo (Twilio media API, Basic auth)
                 else the SMS Body text
              3. read the total:
                   • body  → parseReceiptFromText (reused from receiptInbox.ts,
                             ZERO LLM)
                   • photo → ocrReceiptImage (reused, OpenRouter vision — the
                             only LLM call)
              4. findReceiptMatches (the SAME matcher email uses): exact-cent,
                 ±14 days, sender's chapter
              5. exactly one candidate + team/roster sender → attach +
                 (reconcile if already categorized) + unlock card, source
                 "sms" / link source "auto_sms"
                 0 or >1 or unreadable or an external sender → needs_review /
                 no_match
              6. reply by text — ONLY to team/roster senders
```

### Twilio console setup

1. Buy or designate ONE phone number as the org's receipts number. **This is
   the owner's only real decision here** — everything else below is
   mechanical config.
2. In the Twilio console, open that number → **Messaging** → "A message
   comes in" → set the webhook to:

   ```
   https://vivid-rhinoceros-688.convex.site/twilio/receipts
   ```

   (HTTP POST). Point it at the Convex deployment's own `.convex.site`
   origin directly, **not** the `publicworship.life`-proxied path — see the
   signature subtlety below.
3. The Account SID + Auth Token are already configurable in-app, at
   **profile → integrations** (superuser-only) — the SAME Twilio
   credentials screen the RSVP phone-verification and SMS-blast features
   already use (`integrationSettings.setTwilioCredentials`). Nothing new to
   set up there if Twilio is already configured; if not, set the trio once
   and every Twilio feature (inbound receipts included) picks it up.

### The signature subtlety

Twilio signs its webhook over the **exact URL it POSTed to** (HMAC-SHA1 of
`url + sorted POST params`, base64). The httpAction validates that signature
against `req.url` by default — which is correct **only** if Twilio is
configured to hit the Convex site origin directly (step 2 above). If the
number's webhook were instead pointed at the `pw-router`-proxied
`https://publicworship.life/twilio/receipts` path, the Cloudflare Worker
rewrites the request's host to the Convex origin before forwarding
(`infra/router/src/route.ts`), so `req.url` inside the httpAction would no
longer match what Twilio actually signed — every inbound text would be
rejected as an invalid signature.

`TWILIO_RECEIPTS_WEBHOOK_URL` (Convex dashboard → Settings → Environment
Variables, optional) exists for exactly that case: set it to the literal URL
configured in Twilio's console, and signature verification uses that instead
of `req.url`. With the direct-origin setup in step 2, no override is needed.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_MESSAGING_SERVICE_SID` | Already set for RSVP phone verification / SMS blasts, or set in-app (see above) — reused as-is; no new Twilio secret. |
| `TWILIO_RECEIPTS_WEBHOOK_URL` | *Optional.* The exact public URL Twilio is configured to POST to — only needed if that URL differs from what the httpAction sees as `req.url` (the proxied-request case above). |
| `RECEIPT_OCR_MODEL` | *Optional, shared with the email pipeline.* Same override. |
| `OPENROUTER_API_KEY` | Already set (AI coding + email OCR). Reused for MMS photo OCR. |

Degrades gracefully, same as email: no Twilio credentials configured → the
route 500s (nothing to verify a signature against) rather than silently
accepting unauthenticated webhooks; no `OPENROUTER_API_KEY` → MMS photos
route to review (the file is still stored); a reply always best-effort
swallows its own failures.

### Who can text receipts

Every text is processed end to end (the endpoint is public and
signature-gated, not sender-gated) — but only a phone number that resolves to
a `people` roster row (`phone`, formatting-agnostic — digits-only, last-10
compared) may trigger an auto-attach. An unresolved number is always
`external`: its receipt is still OCR'd and stored for the review queue, but
never auto-attached and never texted a reply.
