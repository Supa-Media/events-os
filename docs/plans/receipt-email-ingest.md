# Receipt email ingest — inbound OCR → reconcile pipeline

Backfilling a large pile of receipts by hand is slow. This pipeline lets a
receipt be **emailed** to `reply.publicworship.life`; the backend OCRs it,
matches it to an already-synced card transaction that's missing a receipt, and
attaches it automatically when the match is unambiguous. Everything ambiguous
lands in a bookkeeper review queue.

## Flow

```
email → reply.publicworship.life
      → Resend inbound (email.received webhook, Svix-signed)
      → POST /resend/inbound            (http.ts — verify + dedup + schedule)
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
| `RESEND_INBOUND_WEBHOOK_SECRET` | The `whsec_…` signing secret from step 2 (required — the route 500s without it). |
| `RESEND_API_KEY` | Already set (outbound). Also used to fetch inbound attachments + reply. |
| `OPENROUTER_API_KEY` | Already set (AI coding). Used for image OCR only. |
| `RECEIPT_OCR_MODEL` | *Optional.* Override the OCR model. Defaults to a cheap vision model (`google/gemini-2.0-flash-001`). Point it at any OpenRouter vision model — free/cheap for a big backfill, stronger if scans read poorly. |

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
