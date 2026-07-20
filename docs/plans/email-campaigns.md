# Email campaigns — audiences, designer, sends, replies

## Status

Shipped (code). In-app email marketing: build an audience, design a
block-based email, send it through the org's own Resend account
(`docs/plans/sms-comms.md`'s sibling), and read replies — no external ESP,
no second database to sync or clean.

## Where things live

| Piece | Files |
|---|---|
| Block model + renderer | `packages/shared/src/emailBlocks.ts`, `emailRender.ts`, `names.ts` — pure TS, shared by the Convex send path and the in-app live preview |
| Backend | `apps/convex/schema/campaigns.ts` (5 tables), `audiences.ts`, `campaigns.ts`, `lib/audienceResolve.ts`, `lib/campaignsAccess.ts`, `lib/unsubscribePage.ts`, `http.ts` (`/unsubscribe/<token>`, `/resend/webhook`) |
| UI | `apps/mobile/app/(app)/campaigns/` (desk: Campaigns · Audiences · Replies), `app/(app)/campaign/[id].tsx` (+ `/design`), `components/campaign/`, `components/email/EmailHtmlPreview` |
| Designer logic | `apps/mobile/lib/emailDesigner.ts` (pure block ops + undo/redo history, unit-tested) |

## Access

`audiences.myCampaignsAccess` — superuser or central ED/FM ("campaigns are
an org-leadership tool at launch"). The Campaigns nav entry, every query,
and every mutation share this one gate (`lib/campaignsAccess.ts`).

## Audiences

Three sources, resolved live with counts before any send:

- **guests** — every RSVP across active chapters (optionally one event),
  `email` set, `emailVerified !== false`, deduped by normalized email
  (most-recent row's name wins).
- **donors** — donor CRM rows across chapters + central; filters:
  `donorStatus`, `gaveWithinDays` (the "has given this month/year"
  pre-filter — a `gifts.by_scope_and_received` range scan). This is the
  supported way to segment by giving; per-recipient gift *amounts* are
  deliberately not merge-mergeable into email copy.
- **people** — chapter roster, active, non-placeholder, `pwEmail ?? email`.

Every source drops suppressed addresses (`emailSuppressions`) and reports
`excludedSuppressed` / `excludedUnverified` in the preview.

## The designer

Linear block stack (heading / text-markdown / image / button / divider /
spacer) with drag-reorder (`SortableRows`), per-block editing, image upload
via Convex storage, undo/redo (Cmd/Ctrl+Z on web), 600ms autosaved doc,
live rendered preview (iframe on web, WebView on native). Merge tags:
`{{firstName}}`, `{{name}}`, with `{{firstName|fallback}}` fallbacks —
substitution happens after HTML-escaping on both sides, so recipient data
can't inject markup.

## Sending

`campaigns.send` → materialize `campaignRecipients` (batches of 100, one
random unsubscribe token per row) → self-rescheduling delivery batches of
25 via the `by_campaign_and_status` index. Per recipient: suppression
recheck, personalized HTML + plaintext, `List-Unsubscribe` +
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, visible
footer unsubscribe link (`/unsubscribe/<token>`) and the org's mailing
address (CAN-SPAM). Reply-To is `campaign+<id>@<resendInboundDomain>` when
inbound is configured. Non-2xx Resend responses mark that one recipient
failed; transport failures throw and are recorded — a full outage can
never read as "sent". Test sends go to any address with `[Test]` prefixed.

## Suppression & webhooks

- `GET/POST /unsubscribe/<token>` — confirm page + one-click support;
  writes `emailSuppressions` (reason `unsubscribe`).
- `POST /resend/webhook` — Svix-signature-verified (secret stored
  write-only in Integrations), deduped via `webhookEvents`:
  `email.bounced`/`email.complained` → suppression (reasons
  `bounce`/`complaint`); inbound received → `emailReplies` matched by the
  `campaign+<id>` plus-address (unmatched replies still land in the
  org-wide Replies inbox).
- Suppressions also apply to event **blasts** (`blasts.ts`) — one
  do-not-email ledger for the whole app.

## Ops setup (one-time, in Resend)

1. Verify the sending domain (`publicworship.life`) — DKIM/SPF records in
   Cloudflare; set the from address + API key on Profile → Integrations.
2. Webhooks: add endpoint `https://<prod>.convex.site/resend/webhook`,
   subscribe to bounced/complained/inbound events, paste the `whsec_…`
   signing secret into Integrations.
3. Inbound/replies: add an inbound domain (e.g. `reply.publicworship.life`
   — one MX record to Resend), set it as the inbound domain in
   Integrations. Until then, campaigns send without a custom Reply-To and
   the Replies inbox stays an explained empty state.

## Deliberate limits (v1)

- Audiences created from the UI are org-wide (`"central"` scope); the
  schema supports per-chapter scope when chapters need their own sends.
- Merge fields are name-only. Gift amounts in email copy were considered
  and rejected (wrong-amount risk beats personalization value); segment
  with `gaveWithinDays` instead.
- Audience resolution caps at 5,000 recipients per send; delivery is
  25/batch. Raise deliberately, with Resend rate limits in mind.
- No open/click tracking yet — Resend webhooks carry these events, so it's
  an additive follow-up on the same webhook route.
