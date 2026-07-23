# Receipt email ingest — inbound OCR → reconcile pipeline

Backfilling a large pile of receipts by hand is slow. This pipeline lets a
receipt be **emailed** to `receipts@reply.publicworship.life`; the backend OCRs it,
matches it to an already-synced card transaction that's missing a receipt, and
attaches it automatically when the match is unambiguous. Everything ambiguous
lands in a bookkeeper review queue.

## Flow

```
email → receipts@reply.publicworship.life
      → Resend inbound (email.received webhook, Svix-signed)
      → POST /resend/inbound            (http.ts — verify + address-filter +
                                         dedup + schedule; mail to any OTHER
                                         address on the domain is ack'd and
                                         skipped)
      → recordInboundReceipt            (dedup on Resend's email_id)
      → processInboundReceipt (action)  (receiptInbox.ts)
           1. resolve sender → people row (auth gate; unknown → ignored)
           2. get content: image/PDF attachment (Resend Attachments API)
              else the email body text
           3. read the total:
                • body  → parseReceiptFromText   (regex, ZERO LLM)
                • image → ocrReceiptImage         (OpenRouter vision, cheap model)
           4. findReceiptMatches: exact-cent, ±14 days, sender's chapter
           5. exactly one → attach + (reconcile if already categorized) + unlock card
              0 or >1 or unreadable → needs_review / no_match
           6. reply to the sender with the outcome
```

**Money safety:** the model never categorizes or moves money — it only reads a
total off a receipt. The single money-adjacent write (`applyReceiptAttachment`)
only attaches a receipt and, at most, flips an *already-categorized* charge to
`reconciled`. Ambiguity always defers to a human. Mirrors the AI-coding rule.

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
| `RECEIPT_INBOUND_ADDRESSES` | *Optional.* Comma-separated allow-list of inbound addresses treated as the receipts inbox. Defaults to `receipts@reply.publicworship.life`. Mail to any other address on the domain is acknowledged but not processed. |

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

Only addresses that resolve to a `people` roster row (matched against `email`
or `pwEmail`, case-insensitive). The endpoint is public and Svix-signed;
roster membership is the auth gate. Unknown senders are recorded as `ignored`
and never OCR'd.

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
