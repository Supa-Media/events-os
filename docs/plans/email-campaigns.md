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
`excludedSuppressed` / `excludedUnverified` in the preview, plus `truncated`
/ `truncatedCount` when the audience exceeds the 5,000-recipient cap (see
"Deliberate limits" below) — the preview says "showing the first 5,000"
rather than silently under-counting.

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
random unsubscribe token per row; also records `audienceTruncated` — see
"Deliberate limits") → self-rescheduling delivery batches of up to 100 via
the `by_campaign_and_status` index. Each batch is ONE Resend request
(`POST /emails/batch`, `lib/resend.ts#sendResendEmailBatch`) carrying every
recipient's personalized item (own `to`/html/text/headers/reply-to) — the
same per-recipient personalization as an individual send, just one HTTP
round trip for up to 100 of them. Batches are paced ~600ms apart
(`applyDeliveryBatch`'s continuation) to stay comfortably under Resend's
default ~2 requests/second rate limit; a 5,000-recipient send is ~50
requests, well under a minute of pacing. Per recipient: suppression
recheck, personalized HTML + plaintext, `List-Unsubscribe` +
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, visible
footer unsubscribe link (`/unsubscribe/<token>`) and the org's mailing
address (CAN-SPAM). Reply-To is `campaign+<id>@<resendInboundDomain>` when
inbound is configured. A non-2xx Resend response marks EVERY recipient in
that request's batch failed (Resend rejects a batch request wholesale on
any per-item validation error — there's no per-item result on failure);
transport failures throw and are recorded the same way — a full outage can
never read as "sent". Test sends go to any address with `[Test]` prefixed.

**Sender ("send as a person").** A campaign can optionally set `fromName`/
`fromEmail` (`CampaignMetaCard`'s "Send as" section) to send as a named
person instead of the org's default Resend sender — e.g. `AJ
<aj@publicworship.life>`. `fromEmail`, when set, must be a bare address on
the SAME domain as the org's configured Resend from address
(`campaigns.ts#validateSenderFields`); setting one before Resend itself is
configured is rejected with a message pointing at Profile → Integrations.
Leaving both blank (the default) sends as the org's address, unchanged.
Both the real send and `sendTest` apply the same override
(`lib/resend.ts#formatFromAddress` → `sendResendEmail`/`sendResendEmailBatch`'s
`from` param); the send-confirm dialog and status card both show the
effective sender before/after sending.

## Suppression & webhooks

- `GET/POST /unsubscribe/<token>` — confirm page + one-click support;
  writes `emailSuppressions` (reason `unsubscribe`).
- `POST /resend/webhook` — Svix-signature-verified (secret stored
  write-only in Integrations), deduped via `webhookEvents`:
  `email.bounced`/`email.complained` → suppression (reasons
  `bounce`/`complaint`); inbound received → `emailReplies` matched by the
  `campaign+<id>` plus-address (unmatched replies still land in the
  org-wide Replies inbox). When a matched reply's campaign has `fromEmail`
  set, the webhook also SCHEDULES (never awaits inline, to keep the webhook
  fast) a best-effort forward (`internal.campaigns.forwardReplyToSender`) of
  the reply to that address — subject `Re: <campaign subject> — reply from
  <replier>`, plaintext+HTML body containing the reply text with the
  replier's address prominent, and `Reply-To` set to the REPLIER (not the
  campaign) so hitting reply in Gmail goes straight to the guest. Forward
  failures (no Resend configured, a transport error) are caught and logged,
  never surfaced to the webhook caller or retried.
- Suppressions also apply to event **blasts** (`blasts.ts`) — one
  do-not-email ledger for the whole app.

## Ops setup (one-time, in Resend)

**Google Workspace coexistence — read first.** The org's real mail
(`hello@`, `give@`, groups) is Google Workspace on the apex domain. Resend
breaks that in exactly two ways, both avoidable: enabling Resend *Inbound*
on the root domain (its MX replaces Google's → all receiving dies — this is
what happened to supa.media once), or replacing/duplicating the apex SPF
TXT (two SPF records on one name = permerror). The rule: **Google owns the
apex MX and apex SPF, forever; Resend only ever gets subdomains for
anything that receives mail.** Root-domain *sending* verification is safe —
Resend's records for it are a `resend._domainkey` DKIM TXT plus MX/SPF on
its own `send.` subdomain (bounce return-path), none of which collide with
Google's apex records.

1. Verify the sending domain (`publicworship.life`) in Resend — add its
   records **by hand** in Cloudflare (no auto-configure wizard): the
   `resend._domainkey` TXT and the `send.publicworship.life` MX + SPF TXT.
   Do NOT touch the apex MX or apex SPF. Decline any "receive email on
   this domain" option. Then set the from address + API key on Profile →
   Integrations. Verify with `dig MX publicworship.life` (Google's servers,
   unchanged) + a test email *to* hello@ + a test send *from* the app.
2. Webhooks: add endpoint `https://<prod>.convex.site/resend/webhook`,
   subscribe to bounced/complained/inbound events, paste the `whsec_…`
   signing secret into Integrations.

**Which Resend plan.** Only the **Transactional** plan, ever — Resend's
separate "Marketing" product is their hosted audience/broadcast tool,
priced per contact stored with them; our audiences/campaigns live in
Convex and every send goes through the transactional API, billed per
email. Free tier works for setup/testing but caps at 100 emails/day;
upgrade to Transactional Pro ($20/mo, 50k emails/mo, no daily cap) before
the first real campaign. While upgrading, note the account's rate limit
(default ~2 req/s) — `campaigns.ts#DELIVER_BATCH_PACING_MS` is tuned to it.

**First-campaign smoke test (one-time).** Before the first real send, run
a campaign to a 2–3 address test audience (your own inboxes) and check in
Gmail's "Show original": the per-recipient `List-Unsubscribe` /
`List-Unsubscribe-Post` headers are present and each recipient's
unsubscribe link is distinct. This validates the one unverified Resend
assumption in the batch path (per-item `headers`/`reply_to`/`from` support
on `POST /emails/batch`); if headers are missing, flag it — the delivery
code would need to fall back to individual sends.
3. Inbound/replies: add `reply.publicworship.life` as the inbound domain
   (one MX record on that subdomain only → Resend), set it as the inbound
   domain in Integrations. Until then, campaigns send without a custom
   Reply-To and the Replies inbox stays an explained empty state.
4. Recommended: an apex `_dmarc` TXT (`v=DMARC1; p=none;
   rua=mailto:hello@publicworship.life`) — Google and Resend both
   DKIM-align on the domain, so DMARC passes for both; tighten to
   `p=quarantine` once reports look clean.
5. If bulk volume ever grows to many thousands/month, move campaign sends
   to a dedicated from-subdomain (e.g. `news.publicworship.life`) so
   marketing reputation can't drag on the root domain the org's personal
   Google mail sends from. Not needed at current scale.

## Deliberate limits (v1)

- Audiences created from the UI are org-wide (`"central"` scope); the
  schema supports per-chapter scope when chapters need their own sends.
- Merge fields are name-only. Gift amounts in email copy were considered
  and rejected (wrong-amount risk beats personalization value); segment
  with `gaveWithinDays` instead.
- Audience resolution caps at 5,000 recipients per send (`AUDIENCE_RESOLVE_LIMIT`,
  `lib/audienceResolve.ts`) — surfaced, not silent: `truncated`/`truncatedCount`
  come back from `previewAudience` (exact, live) and `audienceTruncated`
  (boolean, a durable record of what was true at send time) is stored on the
  campaign row at materialize time; the composer preview, send-confirm, and
  status card all show a warning when it binds. Delivery batches at up to
  100 recipients per Resend request, paced ~600ms apart — comfortably under
  Resend's default rate limit with room for other Resend traffic the
  deployment sends concurrently. Raise either cap deliberately.
- No open/click tracking yet — Resend webhooks carry these events, so it's
  an additive follow-up on the same webhook route.
- Campaigns is for announcements/newsletters, not personal outreach — the
  Academy's Development stream teaches that a donor re-signup ask is
  PERSONAL outreach (a call, a 1:1 email, a conversation), never a blast.
  Nothing here enforces that distinction in-app; it's a norm the training
  carries. Open follow-up for the org lead: cross-link (or update) the
  relevant Academy lesson so it references Campaigns explicitly now that the
  feature exists — do not edit Academy content as part of this change.
