/**
 * Blasts — host announcements to attendees, over email (Resend) or SMS
 * (Twilio, Attendance F).
 *
 * Lifecycle: `sendBlast` (admin mutation) inserts a `sending` row and
 * schedules `deliverBlast` (internal action) which reaches every recipient in
 * the audience — emails for `channel:"email"`, texts for `channel:"sms"` — and
 * finalizes the row via `finishBlast`. SMS degrades to a recorded error when
 * Twilio isn't configured (setting → `TWILIO_*` env → not configured); the
 * composer previews this via `previewBlastAudience.smsConfigured`.
 *
 * Audiences resolve identically for both channels; SMS just targets the rows
 * that carry a phone whose `phoneVerified !== false` (the mirror of the email
 * verification gate), de-duped by normalized phone. Email-less phone-only
 * imported guests — unreachable by email — ARE reached by SMS.
 *
 * ── A blast is BULK mail, and is treated as such ────────────────────────────
 * An event announcement is organiser-composed promotional copy sent to a whole
 * audience — legally the same thing a newsletter campaign is, not a
 * transactional message. So an EMAIL blast carries exactly what
 * `campaigns.ts` sends carry, and refuses on the same terms:
 *  - a per-recipient unsubscribe link in the footer, backed by a
 *    `blastRecipients` row (`schema/ticketing.ts` documents why that's a table
 *    rather than a token derived from something already on hand) and resolving
 *    through the SAME `/unsubscribe/<token>` route campaign recipients use;
 *  - `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058 one-click) headers,
 *    minted per recipient;
 *  - the org's postal mailing address, which `sendBlast` REFUSES to send
 *    without (`integrationSettings.requireOrgMailingAddress`), re-checked at
 *    delivery time in `deliverEmailBlast` because an org-wide setting can be
 *    cleared in the gap;
 *  - a NAMED send gate, `lib/campaignsAccess.ts#requireBlastSend`, rather than
 *    an inline membership check — today it still resolves to "any admin of the
 *    event's chapter", so nothing about who may fire a blast has changed.
 * SMS blasts keep their own equivalent — the "Reply STOP to opt out." line
 * `deliverSmsBlast` appends. Transactional mail (receipts, RSVP
 * confirmations, verification codes) gets NONE of this: `emailShell`'s bulk
 * footer is opt-in per call site precisely so those messages stay clean.
 */
import { escapeHtml } from "./lib/html";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireEvent, requireUserId } from "./lib/context";
import { requireBlastSend } from "./lib/campaignsAccess";
import { normalizeEmail } from "./lib/access";
import { rsvpPageUrl, siteUrl } from "./lib/siteUrl";
import {
  EMAIL_THEME,
  emailButton,
  emailEyebrow,
  emailHeading,
  emailParagraph,
  emailShell,
} from "./lib/emailShell";
import { resolveResendSettings, sendResendEmailBatch } from "./lib/resend";
import { newGuestToken } from "./ticketing";
import { requireOrgMailingAddress } from "./integrationSettings";
import {
  normalizePhone,
  resolveTwilioCredentials,
  sendSms,
} from "./lib/twilio";
import { optedOutPhoneSet } from "./smsOptOuts";
import { suppressedEmailSet } from "./emailSuppressions";
import { estimateSegments, SMS_SEGMENT_PRICE_USD_MICROS } from "@events-os/shared";

const audienceValidator = v.union(
  v.literal("everyone"),
  v.literal("going"),
  v.literal("maybe"),
  v.literal("ticket_holders"),
);

export const listBlasts = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);
    return await ctx.db
      .query("blasts")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(100);
  },
});

/**
 * Fire a blast. Inserts the row and schedules delivery.
 *
 * Gated by the NAMED `requireBlastSend` (`lib/campaignsAccess.ts`), not by an
 * inline `requireEvent`. Who may fire one is UNCHANGED — the resolver's body
 * is today exactly the event-admin membership check this line used to do
 * inline — but "who can send bulk mail to a whole audience" is now a question
 * with one answer in one file, per CLAUDE.md's "gate it behind a power, even
 * when it's open today". See that resolver's doc for what it graduates to.
 */
export const sendBlast = mutation({
  args: {
    eventId: v.id("events"),
    channel: v.union(v.literal("email"), v.literal("sms")),
    subject: v.optional(v.string()),
    body: v.string(),
    audience: audienceValidator,
  },
  handler: async (ctx, args) => {
    const event = await requireBlastSend(ctx, args.eventId);
    const userId = await requireUserId(ctx);
    // SMS is no longer refused here — `deliverBlast` records a clear error if
    // Twilio isn't configured (and the composer previews availability), so a
    // send is never silently dropped.
    const body = args.body.trim();
    if (!body) {
      throw new ConvexError({ code: "EMPTY", message: "Write the blast first." });
    }
    // An email blast is BULK mail — organiser-composed promotional copy to a
    // whole event audience — so it carries the same CAN-SPAM obligations a
    // newsletter campaign does, and refuses on the same terms
    // (`campaigns.ts#submitForApproval`/`#send`). SMS is unaffected: its
    // opt-out disclosure is the "Reply STOP" line `deliverSmsBlast` appends.
    if (args.channel === "email") await requireOrgMailingAddress(ctx);
    const blastId = await ctx.db.insert("blasts", {
      eventId: args.eventId,
      chapterId: event.chapterId,
      channel: args.channel,
      subject: args.subject?.trim() || undefined,
      body,
      audience: args.audience,
      status: "sending",
      createdBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.blasts.deliverBlast, { blastId });
    return blastId;
  },
});

type Audience = "everyone" | "going" | "maybe" | "ticket_holders";

/** What `deliverBlast` fans out from — blast row + resolved recipient lists. */
type BlastPayload = {
  blast: Doc<"blasts">;
  emails: string[];
  phones: string[];
  eventName: string;
  slug: string | null;
  hostName: string;
} | null;

/** Read the RSVP rows that fall inside an audience (bounded, index-only). */
async function audienceRsvps(
  ctx: QueryCtx,
  eventId: Id<"events">,
  audience: Audience,
): Promise<Doc<"rsvps">[]> {
  const rows =
    audience === "going" || audience === "maybe"
      ? await ctx.db
          .query("rsvps")
          .withIndex("by_event_status", (q) =>
            q.eq("eventId", eventId).eq("status", audience),
          )
          .take(2000)
      : await ctx.db
          .query("rsvps")
          .withIndex("by_event", (q) => q.eq("eventId", eventId))
          .take(2000);
  return audience === "ticket_holders"
    ? rows.filter((r) => r.source === "ticket")
    : rows;
}

/**
 * The email recipient set for an audience: rows with an email that didn't fail
 * to verify (undefined = legacy = verified), de-duped by address (an attendee
 * can RSVP + buy). Email-less imported rows drop out here — SMS reclaims them.
 *
 * `suppressed` (normalized lowercase → suppressed, see `emailSuppressions.ts`)
 * excludes any address that unsubscribed from (or bounced/complained on) an
 * email campaign — a person who opted out of campaign mail shouldn't still
 * get event blasts. Reported separately in `suppressedCount` so callers (the
 * composer preview) can disclose it rather than silently shrinking the count,
 * mirroring `phoneRecipients`' `optedOutCount`.
 */
function emailRecipients(
  rows: Doc<"rsvps">[],
  suppressed: Set<string> = new Set(),
): { recipients: string[]; suppressedCount: number } {
  const filtered = rows.filter(
    (r): r is Doc<"rsvps"> & { email: string } =>
      !!r.email && r.emailVerified !== false,
  );
  const deduped = [...new Set(filtered.map((r) => r.email))];
  const recipients: string[] = [];
  let suppressedCount = 0;
  for (const email of deduped) {
    // `normalizeEmail` (trim + lowercase) matches exactly how
    // `emailSuppressions.email` is stored — a plain `.toLowerCase()` alone
    // would miss a suppressed address whose rsvp row carries stray
    // whitespace (`"  x@y.com "` !== `"x@y.com"` after only lowercasing).
    if (suppressed.has(normalizeEmail(email) ?? email.toLowerCase())) {
      suppressedCount++;
    } else {
      recipients.push(email);
    }
  }
  return { recipients, suppressedCount };
}

/**
 * The SMS recipient set for an audience: rows with a parseable phone whose
 * `phoneVerified !== false` (the mirror of the email gate — undefined =
 * imported/synced = reachable), de-duped by NORMALIZED phone so "(917)
 * 555-0000" and "9175550000" collapse to one text. Phone-only imported guests
 * with no email ARE included — the payoff of the SMS channel.
 *
 * `optedOut` (normalized E.164 → opted-out, see `smsOptOuts.ts`) is filtered
 * out of `recipients` and counted separately in `optedOutCount` so callers
 * (the composer preview, the delivery path) can both skip AND disclose it.
 * Pure + synchronous so it stays trivially unit-testable — callers resolve
 * the opt-out set themselves (`optedOutPhoneSet`) before calling in.
 */
function phoneRecipients(
  rows: Doc<"rsvps">[],
  optedOut: Set<string> = new Set(),
): { recipients: string[]; optedOutCount: number } {
  const seen = new Set<string>();
  const recipients: string[] = [];
  let optedOutCount = 0;
  for (const r of rows) {
    if (!r.phone || r.phoneVerified === false) continue;
    const normalized = normalizePhone(r.phone);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (optedOut.has(normalized)) {
      optedOutCount++;
      continue;
    }
    recipients.push(normalized);
  }
  return { recipients, optedOutCount };
}

/** Everything delivery needs in one read: blast + event + recipient lists. */
export const getBlastPayload = internalQuery({
  args: { blastId: v.id("blasts") },
  handler: async (ctx, { blastId }) => {
    const blast = await ctx.db.get(blastId);
    if (!blast) return null;
    const event = await ctx.db.get(blast.eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", blast.eventId))
      .unique();

    const rows = await audienceRsvps(ctx, blast.eventId, blast.audience);
    const optedOut = await optedOutPhoneSet(ctx);
    const suppressed = await suppressedEmailSet(ctx);
    return {
      blast,
      emails: emailRecipients(rows, suppressed).recipients,
      phones: phoneRecipients(rows, optedOut).recipients,
      eventName: event?.name ?? "Event",
      slug: page?.slug ?? null,
      hostName: page?.hostName ?? "Public Worship",
    };
  },
});

/**
 * Whether SMS blasts can send right now — the Twilio trio is configured via
 * the in-app superuser setting OR the `TWILIO_*` env vars. Boolean only (no
 * secret leaves the table), so the event-admin composer can hint at Profile →
 * Integrations without being a superuser itself.
 */
function smsConfigured(settings: Doc<"integrationSettings"> | null): boolean {
  const setting =
    !!settings?.twilioAccountSid &&
    !!settings?.twilioAuthToken &&
    !!settings?.twilioMessagingServiceSid;
  const env =
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_MESSAGING_SERVICE_SID;
  return setting || env;
}

/**
 * Composer preview: recipient counts per channel for an audience, plus whether
 * SMS can send. Event-gated (any admin), never returns addresses/numbers.
 *
 * `body` is the DRAFT message text (optional — the composer may not have
 * typed anything yet). When present it drives `estimatedSegments` /
 * `estimatedCostUsdMicros` for the SMS channel (the "Reply STOP to opt out."
 * suffix `deliverSmsBlast` appends is included in the estimate, so the
 * preview matches what actually ships). `smsOptedOut` is how many numbers in
 * this audience were excluded because they've opted out — surfaced so the
 * composer can disclose "N opted out and will be skipped" rather than just
 * silently shrinking the recipient count.
 */
export const previewBlastAudience = query({
  args: {
    eventId: v.id("events"),
    audience: audienceValidator,
    body: v.optional(v.string()),
  },
  returns: v.object({
    emailRecipients: v.number(),
    emailSuppressed: v.number(),
    smsRecipients: v.number(),
    smsConfigured: v.boolean(),
    smsOptedOut: v.number(),
    estimatedSegments: v.number(),
    estimatedCostUsdMicros: v.number(),
  }),
  handler: async (ctx, { eventId, audience, body }) => {
    await requireEvent(ctx, eventId);
    const rows = await audienceRsvps(ctx, eventId, audience);
    const settings = await ctx.db.query("integrationSettings").first();
    const optedOut = await optedOutPhoneSet(ctx);
    const sms = phoneRecipients(rows, optedOut);
    const suppressed = await suppressedEmailSet(ctx);
    const email = emailRecipients(rows, suppressed);
    // Mirror deliverSmsBlast's exact wire body so the estimate matches reality.
    const draftWithSuffix = `${body ?? ""}\n\nReply STOP to opt out.`;
    const estimatedSegments = body ? estimateSegments(draftWithSuffix) : 0;
    return {
      emailRecipients: email.recipients.length,
      emailSuppressed: email.suppressedCount,
      smsRecipients: sms.recipients.length,
      smsConfigured: smsConfigured(settings),
      smsOptedOut: sms.optedOutCount,
      estimatedSegments,
      estimatedCostUsdMicros:
        estimatedSegments * SMS_SEGMENT_PRICE_USD_MICROS * sms.recipients.length,
    };
  },
});

export const finishBlast = internalMutation({
  args: {
    blastId: v.id("blasts"),
    recipientCount: v.number(),
    sentCount: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { blastId, recipientCount, sentCount, error }) => {
    await ctx.db.patch(blastId, {
      status: error && sentCount === 0 ? "failed" : "sent",
      recipientCount,
      sentCount,
      error,
      sentAt: Date.now(),
    });
    return null;
  },
});

/** How many `blastRecipients` rows one mutation materializes / updates —
 *  the `campaigns.ts#MATERIALIZE_BATCH_SIZE` slice size, for the same reason
 *  (an audience can be up to 2000 addresses; one transaction shouldn't try to
 *  write them all). */
const BLAST_RECIPIENT_BATCH_SIZE = 100;

/** How many personalized emails ride in ONE Resend request — the batch
 *  endpoint's own per-request maximum, and the same value
 *  `campaigns.ts#DELIVER_BATCH_SIZE` uses. */
const RESEND_BATCH_SIZE = 100;

/** Wait between successive Resend batch requests of the same blast — the
 *  `campaigns.ts#DELIVER_BATCH_PACING_MS` value, for the identical reason
 *  (Resend's default limit is ~2 requests/second). Campaigns pace by
 *  scheduling the next invocation; a blast's audience is capped at 2,000
 *  addresses (`audienceRsvps`) — at most ~20 requests — so it paces inside the
 *  one action instead of building a second scheduled state machine. */
const RESEND_BATCH_PACING_MS = 600;

/** Sleep helper for the pacing above (mirrors `aiActions.ts`'s). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Materialize (or re-read) one slice of an email blast's per-address rows,
 * returning each address with the unsubscribe token that names IT and nothing
 * else. Idempotent per (blast, address) — a retried `deliverBlast` reuses the
 * tokens it already minted rather than issuing a second set, so a link in an
 * already-delivered message never goes dead.
 *
 * Addresses are normalized (trim + lowercase) here because that's the form
 * `emailSuppressions` stores and compares against; a duplicate that only
 * differed by case/whitespace collapses to ONE row and therefore one send.
 */
export const ensureBlastRecipients = internalMutation({
  args: { blastId: v.id("blasts"), emails: v.array(v.string()) },
  returns: v.array(v.object({ email: v.string(), token: v.string() })),
  handler: async (ctx, { blastId, emails }) => {
    const blast = await ctx.db.get(blastId);
    if (!blast) return [];
    const out: { email: string; token: string }[] = [];
    const seen = new Set<string>();
    for (const raw of emails) {
      const email = normalizeEmail(raw);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const existing = await ctx.db
        .query("blastRecipients")
        .withIndex("by_blast_and_email", (q) =>
          q.eq("blastId", blastId).eq("email", email),
        )
        .first();
      if (existing) {
        out.push({ email, token: existing.unsubscribeToken });
        continue;
      }
      const token = newGuestToken();
      await ctx.db.insert("blastRecipients", {
        blastId,
        eventId: blast.eventId,
        email,
        status: "queued",
        unsubscribeToken: token,
      });
      out.push({ email, token });
    }
    return out;
  },
});

/** Persist one slice of per-recipient delivery outcomes (the
 *  `campaigns.ts#applyDeliveryBatch` shape, minus the scheduling — a blast
 *  sends in one pass and finalizes through `finishBlast`). */
export const applyBlastDelivery = internalMutation({
  args: {
    blastId: v.id("blasts"),
    results: v.array(
      v.object({
        email: v.string(),
        sent: v.boolean(),
        error: v.optional(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { blastId, results }) => {
    for (const result of results) {
      const row = await ctx.db
        .query("blastRecipients")
        .withIndex("by_blast_and_email", (q) =>
          q.eq("blastId", blastId).eq("email", result.email),
        )
        .first();
      if (!row) continue;
      await ctx.db.patch(row._id, {
        status: result.sent ? "sent" : "failed",
        error: result.error,
        sentAt: result.sent ? Date.now() : undefined,
      });
    }
    return null;
  },
});

/**
 * Deliver an email blast: one branded email per recipient, best-effort.
 *
 * ── Why this sends through `lib/resend.ts` rather than `sendEmail` ─────────
 * Every recipient gets a DIFFERENT message: their own `/unsubscribe/<token>`
 * link in the footer and their own `List-Unsubscribe` header. The shared
 * `ticketingEmails.sendEmail` chokepoint takes only `{to, subject, html}` —
 * it has no way to carry per-recipient headers — so this path resolves the
 * Resend settings once and posts the personalized messages itself.
 *
 * ── Why BATCHED (`sendResendEmailBatch`), like campaigns ───────────────────
 * This used to POST one Resend request per address, sequentially and unpaced
 * — up to 2,000 requests for a big event, comfortably over Resend's default
 * ~2 requests/second limit. `sendResendEmailBatch` carries per-recipient
 * `to`/`html`/`headers` PER ITEM, so nothing about the personalization
 * changes; `campaigns.ts#deliverCampaignBatch` already sends exactly this way
 * (100 per request, ~600ms apart) and this now matches it, sub-batching
 * within the one action rather than across scheduled invocations (a blast is
 * capped at 2,000 addresses — ~20 requests, ~12s of pacing — so it stays
 * inside one action comfortably).
 *
 * Both failure modes are preserved: a non-2xx RESPONSE is a RECORDED
 * rejection of the addresses it covers (counted, never fatal), a `fetch`
 * REJECTION is a real outage and propagates into the catch below, which is
 * what makes an outage land the blast "failed" rather than "sent with 0".
 * Resend rejects a batch request WHOLESALE on any per-item validation error
 * (no per-item results), so the addresses a non-2xx covers are every address
 * in THAT request — the same coarser granularity `deliverCampaignBatch`
 * documents, not a different kind of failure.
 */
async function deliverEmailBlast(
  ctx: ActionCtx,
  payload: NonNullable<BlastPayload>,
): Promise<{ recipientCount: number; sentCount: number; error?: string }> {
  const { blast, emails, eventName, slug, hostName } = payload;
  const subject = blast.subject || `An update on ${eventName}`;
  // ESCAPE FIRST, then substitute <br/>. `lib/emailShell.ts`'s helpers all
  // take already-escaped HTML (they interpolate raw), and every one of these
  // four values is author- or organiser-supplied: `blast.body` and
  // `blast.subject` are typed into the composer, `hostName`/`eventName` come
  // from records anyone with event access can edit. The line-break markup is
  // deliberate, so it has to be added AFTER escaping or it would be escaped
  // too.
  const paragraphs = blast.body
    .split(/\n{2,}/)
    .map((p) =>
      emailParagraph(escapeHtml(p).replace(/\n/g, "<br/>"), {
        size: 15,
        margin: "0 0 14px",
        strong: true,
      }),
    )
    .join("");
  // The message body — identical for everyone. Only the FOOTER differs per
  // recipient (their own unsubscribe link), so the expensive part is built once.
  const inner = `
      ${emailEyebrow(`${escapeHtml(hostName)} · ${escapeHtml(eventName)}`, { margin: "0 0 8px" })}
      ${emailHeading(escapeHtml(subject), { margin: "0 0 16px" })}
      ${paragraphs}
      ${slug ? `<div style="margin-top:6px">${emailButton(rsvpPageUrl(slug), "View event")}</div>` : ""}`;

  // `sendBlast` already refused a blast with no postal address on file, but it
  // could have been cleared in the gap before delivery ran — a recorded
  // failure, never a message that ships without the required line.
  const mailSettings = await ctx.runQuery(
    internal.integrationSettings.readCampaignsMailSettings,
    {},
  );
  const orgAddress = mailSettings.orgMailingAddress?.trim();
  if (!orgAddress) {
    return {
      recipientCount: emails.length,
      sentCount: 0,
      error:
        "No postal mailing address on file — a superuser must set it in Profile → Integrations before bulk email can go out.",
    };
  }

  const settings = await resolveResendSettings(ctx);
  if (!settings) {
    // Recorded, not thrown — the row lands `failed` with a clear reason, the
    // same shape `deliverSmsBlast` uses for an unconfigured Twilio.
    return {
      recipientCount: emails.length,
      sentCount: 0,
      error: "Resend isn't connected — configure it in Profile → Integrations.",
    };
  }

  // One row (and one token) per address, in slices — see
  // `ensureBlastRecipients`.
  const recipients: { email: string; token: string }[] = [];
  for (let i = 0; i < emails.length; i += BLAST_RECIPIENT_BATCH_SIZE) {
    recipients.push(
      ...(await ctx.runMutation(internal.blasts.ensureBlastRecipients, {
        blastId: blast._id,
        emails: emails.slice(i, i + BLAST_RECIPIENT_BATCH_SIZE),
      })),
    );
  }

  let sent = 0;
  let lastError: string | undefined;
  const results: { email: string; sent: boolean; error?: string }[] = [];
  for (let i = 0; i < recipients.length; i += RESEND_BATCH_SIZE) {
    const slice = recipients.slice(i, i + RESEND_BATCH_SIZE);
    if (i > 0) await sleep(RESEND_BATCH_PACING_MS);
    try {
      const result = await sendResendEmailBatch(
        settings,
        slice.map(({ email, token }) => {
          const unsubscribeUrl = `${siteUrl()}/unsubscribe/${token}`;
          return {
            to: email,
            subject,
            html: emailShell(inner, EMAIL_THEME, { unsubscribeUrl, orgAddress }),
            headers: {
              // RFC 8058 one-click: the same pair campaign sends carry, per
              // recipient, so a mail client's own "unsubscribe" button POSTs
              // straight to this recipient's token.
              "List-Unsubscribe": `<${unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          };
        }),
      );
      if (result.ok) {
        for (const recipient of slice) {
          sent++;
          results.push({ email: recipient.email, sent: true });
        }
      } else {
        lastError = `Resend responded ${result.status}`;
        for (const recipient of slice) {
          results.push({ email: recipient.email, sent: false, error: lastError });
        }
      }
    } catch (err) {
      // A transport failure — the outage case. Recorded against every address
      // in this request, exactly as the per-recipient catch did before.
      lastError = String(err);
      for (const recipient of slice) {
        results.push({ email: recipient.email, sent: false, error: lastError });
      }
    }
  }

  for (let i = 0; i < results.length; i += BLAST_RECIPIENT_BATCH_SIZE) {
    await ctx.runMutation(internal.blasts.applyBlastDelivery, {
      blastId: blast._id,
      results: results.slice(i, i + BLAST_RECIPIENT_BATCH_SIZE),
    });
  }
  return { recipientCount: recipients.length, sentCount: sent, error: lastError };
}

/** Last 4 digits of an E.164 number — enough to spot-check a usage row
 *  without storing a reachable phone number in the cost ledger. */
function phoneLast4(phone: string): string {
  return phone.slice(-4);
}

/** Deliver an SMS blast: one text per normalized phone, best-effort. Records
 *  one `smsUsageEvents` row per recipient (sent/failed/opted_out) — the cost
 *  ledger behind `smsUsage.getSmsSpendSummary`.
 *
 *  Exported (not just internal to the module) so tests can exercise the
 *  send-time opt-out recheck directly against a hand-built payload — the
 *  scenario it guards against (everyone in `phones` opting out in the real
 *  gap between `sendBlast` scheduling this and this action actually running)
 *  can't be reproduced by racing `deliverBlast`'s own two sequential reads
 *  from outside. Not called from anywhere but `deliverBlast` in production. */
export async function deliverSmsBlast(
  ctx: ActionCtx,
  payload: NonNullable<BlastPayload>,
): Promise<{ recipientCount: number; sentCount: number; error?: string }> {
  const { blast, phones } = payload;

  // Recheck opt-outs right before sending — `payload.phones` was already
  // filtered when the blast was scheduled (`getBlastPayload`), but a STOP can
  // arrive in the gap between scheduling and this action actually running.
  const optedOutNow = new Set(
    await ctx.runQuery(internal.smsOptOuts.listOptedOutPhones, {}),
  );
  const eligible: string[] = [];
  for (const phone of phones) {
    if (optedOutNow.has(phone)) {
      await ctx.runMutation(internal.smsUsage.recordUsageEvent, {
        chapterId: blast.chapterId,
        purpose: "blast",
        blastId: blast._id,
        eventId: blast.eventId,
        phoneLast4: phoneLast4(phone),
        segments: 0,
        costUsdMicros: 0,
        outcome: "opted_out",
      });
    } else {
      eligible.push(phone);
    }
  }

  if (eligible.length === 0 && phones.length > 0) {
    // Everyone in the audience opted out in the gap between `sendBlast`
    // scheduling this delivery and this recheck actually running — without
    // this, `lastError` stays undefined and `finishBlast` marks the blast
    // "sent" with `sentCount:0` (its `error && sentCount === 0` failure test
    // never trips). A blast that reached nobody is a failure worth
    // disclosing, not a silent success.
    return {
      recipientCount: phones.length,
      sentCount: 0,
      error: `All ${phones.length} recipient${phones.length === 1 ? "" : "s"} had opted out by delivery time.`,
    };
  }

  const creds = await resolveTwilioCredentials(ctx);
  if (!creds) {
    // Recorded, not thrown — the row lands `failed` with a clear reason.
    return {
      recipientCount: phones.length,
      sentCount: 0,
      error: "Twilio isn't connected — configure it in Profile → Integrations.",
    };
  }
  // Marketing bodies carry the opt-out line. STOP itself is honored by the
  // Twilio Messaging Service automatically (Advanced Opt-Out); this suffix is
  // the visible disclosure carriers/A2P registration expect. Transactional
  // verification codes (ticketingSms.ts) deliberately omit it.
  const body = `${blast.body}\n\nReply STOP to opt out.`;
  const segments = estimateSegments(body);
  const costPerRecipient = segments * SMS_SEGMENT_PRICE_USD_MICROS;

  let sent = 0;
  let lastError: string | undefined;
  for (const to of eligible) {
    try {
      await sendSms(creds, { to, body });
      sent++;
      await ctx.runMutation(internal.smsUsage.recordUsageEvent, {
        chapterId: blast.chapterId,
        purpose: "blast",
        blastId: blast._id,
        eventId: blast.eventId,
        phoneLast4: phoneLast4(to),
        segments,
        costUsdMicros: costPerRecipient,
        outcome: "sent",
      });
    } catch (err) {
      lastError = String(err);
      await ctx.runMutation(internal.smsUsage.recordUsageEvent, {
        chapterId: blast.chapterId,
        purpose: "blast",
        blastId: blast._id,
        eventId: blast.eventId,
        phoneLast4: phoneLast4(to),
        segments,
        costUsdMicros: 0,
        outcome: "failed",
      });
    }
  }
  return { recipientCount: phones.length, sentCount: sent, error: lastError };
}

/** Deliver a blast over its channel, then finalize the row. */
export const deliverBlast = internalAction({
  args: { blastId: v.id("blasts") },
  handler: async (ctx, { blastId }) => {
    const payload = await ctx.runQuery(internal.blasts.getBlastPayload, {
      blastId,
    });
    if (!payload) return null;
    const result =
      payload.blast.channel === "sms"
        ? await deliverSmsBlast(ctx, payload)
        : await deliverEmailBlast(ctx, payload);
    await ctx.runMutation(internal.blasts.finishBlast, {
      blastId,
      recipientCount: result.recipientCount,
      sentCount: result.sentCount,
      error: result.error,
    });
    return null;
  },
});
