/**
 * Email campaigns — the in-app newsletter/announcement composer
 * (`schema/campaigns.ts#campaigns`). CENTRAL-only (`lib/campaignsAccess.ts`).
 *
 * Lifecycle: `createCampaign` (draft) → `updateCampaignMeta`/`updateCampaignDoc`
 * while still draft → `send` validates (audience exists, the block document
 * is non-empty, Resend is configured — any failure is a RECORDED failure on
 * the campaign row, never a thrown error, mirroring `blasts.ts#finishBlast`'s
 * philosophy) and flips `status` to "sending", scheduling
 * `materializeRecipients` (an internalAction — it resolves the audience via
 * `audiences.ts#resolveAudienceForSend` and writes one `campaignRecipients`
 * row per address in batches of 100, the house `backfillGiftsFromDonations`
 * slice pattern) → `deliverCampaignBatch` (an internalAction, self-
 * rescheduling) sends 25 at a time and persists the results, until the
 * `campaignRecipients.by_campaign_and_status "queued"` index comes back empty
 * → `finishCampaignSend` sets the final status/counts/`sentAt`.
 *
 * `sendTest` is a synchronous action (not a scheduled send) — it renders
 * against the caller's own name/email and a dummy unsubscribe URL, and sends
 * exactly one email with a "[Test] " subject prefix, so a composer can
 * preview the real Resend render without touching any audience or the
 * `campaignRecipients` ledger.
 */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { requireCampaignsAccess } from "./lib/campaignsAccess";
import { siteUrl } from "./lib/siteUrl";
import { resolveResendSettings, sendResendEmail } from "./lib/resend";
import {
  renderCampaignEmail,
  renderCampaignText,
  validateEmailDocument,
} from "@events-os/shared";
import { CAMPAIGN_STATUSES } from "./schema/campaigns";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

/** URL-safe random token — the `rsvps.token`/`newGuestToken` precedent
 *  (`crypto.getRandomValues`, the safe random source available in both
 *  Convex mutations and actions). */
function randomToken(length = 32): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export const listCampaigns = query({
  args: { scope: v.optional(scopeValidator) },
  handler: async (ctx, { scope }) => {
    await requireCampaignsAccess(ctx);
    return scope
      ? await ctx.db
          .query("campaigns")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .order("desc")
          .take(200)
      : await ctx.db.query("campaigns").order("desc").take(200);
  },
});

export const getCampaign = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => {
    await requireCampaignsAccess(ctx);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found." });
    }
    return campaign;
  },
});

export const createCampaign = mutation({
  args: {
    scope: scopeValidator,
    name: v.string(),
    subject: v.string(),
    previewText: v.optional(v.string()),
    audienceId: v.id("audiences"),
    doc: v.any(),
  },
  handler: async (ctx, { scope, name, subject, previewText, audienceId, doc }) => {
    await requireCampaignsAccess(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ConvexError({ code: "EMPTY", message: "Name the campaign first." });
    }
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) {
      throw new ConvexError({ code: "EMPTY", message: "Write a subject line first." });
    }
    const audience = await ctx.db.get(audienceId);
    if (!audience) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
    }
    const validated = validateEmailDocument(doc);
    if (!validated.ok) {
      throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
    }

    const now = Date.now();
    return await ctx.db.insert("campaigns", {
      scope,
      name: trimmedName,
      subject: trimmedSubject,
      previewText: previewText?.trim() || undefined,
      audienceId,
      doc: validated.doc,
      status: "draft",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Assert `campaign.status === "draft"` — every metadata/content edit is
 *  blocked once a send has started (or finished), so a campaign's history
 *  stays a faithful record of what was actually sent. */
function assertDraft(campaign: Doc<"campaigns">): void {
  if (campaign.status !== "draft") {
    throw new ConvexError({
      code: "NOT_DRAFT",
      message: "Only a draft campaign can be edited.",
    });
  }
}

export const updateCampaignMeta = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.optional(v.string()),
    subject: v.optional(v.string()),
    previewText: v.optional(v.union(v.string(), v.null())),
    audienceId: v.optional(v.id("audiences")),
  },
  handler: async (ctx, { campaignId, name, subject, previewText, audienceId }) => {
    await requireCampaignsAccess(ctx);
    const existing = await ctx.db.get(campaignId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found." });
    }
    assertDraft(existing);

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new ConvexError({ code: "EMPTY", message: "Name the campaign first." });
      }
      patch.name = trimmed;
    }
    if (subject !== undefined) {
      const trimmed = subject.trim();
      if (!trimmed) {
        throw new ConvexError({ code: "EMPTY", message: "Write a subject line first." });
      }
      patch.subject = trimmed;
    }
    if (previewText !== undefined) patch.previewText = previewText ?? undefined;
    if (audienceId !== undefined) {
      const audience = await ctx.db.get(audienceId);
      if (!audience) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
      }
      patch.audienceId = audienceId;
    }
    await ctx.db.patch(campaignId, patch);
    return null;
  },
});

export const updateCampaignDoc = mutation({
  args: { campaignId: v.id("campaigns"), doc: v.any() },
  handler: async (ctx, { campaignId, doc }) => {
    await requireCampaignsAccess(ctx);
    const existing = await ctx.db.get(campaignId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found." });
    }
    assertDraft(existing);
    const validated = validateEmailDocument(doc);
    if (!validated.ok) {
      throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
    }
    await ctx.db.patch(campaignId, { doc: validated.doc, updatedAt: Date.now() });
    return null;
  },
});

// ── Internal access/read helpers (action-callable) ───────────────────────────

/** `requireCampaignsAccess`, callable from an action via `ctx.runQuery` (an
 *  action has no `ctx.db`, so the gate — which reads `people`/`specializedRoles`
 *  — can't run directly there). Throws through to the caller unchanged. */
export const assertAccessForAction = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireCampaignsAccess(ctx);
    return null;
  },
});

export const getCampaignInternal = internalQuery({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => ctx.db.get(campaignId),
});

// ── sendTest ──────────────────────────────────────────────────────────────

export const sendTest = action({
  args: { campaignId: v.id("campaigns"), to: v.string() },
  returns: v.null(),
  handler: async (ctx, { campaignId, to }) => {
    await ctx.runQuery(internal.campaigns.assertAccessForAction, {});

    const campaign = await ctx.runQuery(internal.campaigns.getCampaignInternal, {
      campaignId,
    });
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found." });
    }
    const validated = validateEmailDocument(campaign.doc);
    if (!validated.ok) {
      throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
    }

    const settings = await resolveResendSettings(ctx);
    if (!settings) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message: "Resend isn't connected — configure it in Profile → Integrations.",
      });
    }

    const identity = await ctx.auth.getUserIdentity();
    const mailSettings = await ctx.runQuery(
      internal.integrationSettings.readCampaignsMailSettings,
      {},
    );
    const recipient = { name: identity?.name ?? null, email: to };
    // A dummy (non-functional) unsubscribe URL — a test send never
    // materializes a real `campaignRecipients` row/token.
    const unsubscribeUrl = `${siteUrl()}/unsubscribe/test`;
    const renderOpts = { recipient, unsubscribeUrl, orgAddress: mailSettings.orgMailingAddress };

    const sendResult = await sendResendEmail(settings, {
      to,
      subject: `[Test] ${campaign.subject}`,
      html: renderCampaignEmail(validated.doc, renderOpts),
      text: renderCampaignText(validated.doc, renderOpts),
    });
    if (!sendResult.ok) {
      // A test send is interactive — surface the rejection to the composer
      // instead of silently resolving (sendResendEmail only throws on
      // transport failures, not non-2xx responses).
      throw new ConvexError({
        code: "SEND_FAILED",
        message: `Resend rejected the test send (HTTP ${sendResult.status}). Check the API key and from address on the Integrations screen.`,
      });
    }
    return null;
  },
});

// ── send ──────────────────────────────────────────────────────────────────

/** Patch a campaign to a RECORDED failure (never throw) — the
 *  `blasts.ts#finishBlast` philosophy applied to the pre-flight checks. */
async function recordSendFailure(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  error: string,
): Promise<void> {
  await ctx.db.patch(campaignId, {
    status: "failed",
    error,
    updatedAt: Date.now(),
  });
}

export const send = mutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, { campaignId }) => {
    await requireCampaignsAccess(ctx);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found." });
    }
    if (campaign.status !== "draft" && campaign.status !== "failed") {
      throw new ConvexError({
        code: "ALREADY_SENDING",
        message: "This campaign has already been sent (or is sending now).",
      });
    }

    const audience = await ctx.db.get(campaign.audienceId);
    if (!audience) {
      await recordSendFailure(ctx, campaignId, "The target audience no longer exists.");
      return null;
    }
    const validated = validateEmailDocument(campaign.doc);
    if (!validated.ok) {
      await recordSendFailure(ctx, campaignId, `Invalid email content: ${validated.error}`);
      return null;
    }
    if (validated.doc.blocks.length === 0) {
      await recordSendFailure(ctx, campaignId, "Write the email first.");
      return null;
    }
    const settings = await ctx.db.query("integrationSettings").first();
    const resendReady = !!settings?.resendApiKey || !!process.env.RESEND_API_KEY;
    if (!resendReady) {
      await recordSendFailure(
        ctx,
        campaignId,
        "Resend isn't connected — configure it in Profile → Integrations.",
      );
      return null;
    }

    await ctx.db.patch(campaignId, {
      status: "sending",
      error: undefined,
      recipientCount: undefined,
      sentCount: undefined,
      failedCount: undefined,
      suppressedCount: undefined,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.campaigns.materializeRecipients, {
      campaignId,
    });
    return null;
  },
});

// ── materialize ───────────────────────────────────────────────────────────

const MATERIALIZE_BATCH_SIZE = 100;

/** Insert one batch of `campaignRecipients` rows (status "queued"), each with
 *  a fresh `unsubscribeToken`. Called repeatedly by `materializeRecipients`
 *  in slices of `MATERIALIZE_BATCH_SIZE` (the `backfillGiftsFromDonations`
 *  slice pattern, adapted for an action driving fixed-size chunks instead of
 *  a `.paginate()` cursor — the whole resolved list is already in hand). */
export const insertRecipientBatch = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    recipients: v.array(v.object({ email: v.string(), name: v.optional(v.string()) })),
  },
  returns: v.null(),
  handler: async (ctx, { campaignId, recipients }) => {
    for (const r of recipients) {
      await ctx.db.insert("campaignRecipients", {
        campaignId,
        email: r.email,
        name: r.name,
        status: "queued",
        unsubscribeToken: randomToken(),
      });
    }
    return null;
  },
});

export const setRecipientCount = internalMutation({
  args: { campaignId: v.id("campaigns"), recipientCount: v.number() },
  returns: v.null(),
  handler: async (ctx, { campaignId, recipientCount }) => {
    await ctx.db.patch(campaignId, { recipientCount, updatedAt: Date.now() });
    return null;
  },
});

/** Delete up to 200 `campaignRecipients` rows for a campaign, returning how
 *  many were removed — the bounded-batch-delete house pattern (the
 *  guidelines forbid deleting an unbounded set in one mutation). Called in a
 *  loop by `materializeRecipients` so a retry-from-"failed" send never
 *  accumulates duplicate rows alongside a prior attempt's. */
export const clearRecipientsBatch = internalMutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.number(),
  handler: async (ctx, { campaignId }) => {
    const rows = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(200);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

/**
 * Resolve the campaign's audience and materialize it into `campaignRecipients`
 * rows, batching inserts at `MATERIALIZE_BATCH_SIZE`. Zero matching
 * recipients is a RECORDED failure (not an error) — the campaign never
 * dangles in "sending" with nothing to deliver. On success, schedules the
 * first `deliverCampaignBatch` invocation.
 */
export const materializeRecipients = internalAction({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx: ActionCtx, { campaignId }) => {
    const campaign = await ctx.runQuery(internal.campaigns.getCampaignInternal, {
      campaignId,
    });
    if (!campaign) return null;

    // Clear any leftover rows from a prior attempt (a retry-from-"failed"
    // send) before re-resolving — otherwise a retry would pile duplicate
    // rows on top of the earlier attempt's instead of starting clean.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const deleted = await ctx.runMutation(internal.campaigns.clearRecipientsBatch, {
        campaignId,
      });
      if (deleted === 0) break;
    }

    const recipients = await ctx.runQuery(internal.audiences.resolveAudienceForSend, {
      audienceId: campaign.audienceId,
    });
    if (!recipients || recipients.length === 0) {
      await ctx.runMutation(internal.campaigns.finishCampaignSend, {
        campaignId,
        zeroRecipientsError: "No recipients matched this audience.",
      });
      return null;
    }

    for (let i = 0; i < recipients.length; i += MATERIALIZE_BATCH_SIZE) {
      await ctx.runMutation(internal.campaigns.insertRecipientBatch, {
        campaignId,
        recipients: recipients.slice(i, i + MATERIALIZE_BATCH_SIZE),
      });
    }
    await ctx.runMutation(internal.campaigns.setRecipientCount, {
      campaignId,
      recipientCount: recipients.length,
    });
    await ctx.scheduler.runAfter(0, internal.campaigns.deliverCampaignBatch, {
      campaignId,
    });
    return null;
  },
});

// ── deliver ───────────────────────────────────────────────────────────────

const DELIVER_BATCH_SIZE = 25;

/** Up to `DELIVER_BATCH_SIZE` still-"queued" recipients for a campaign, plus
 *  the campaign row itself (subject/doc). An empty `rows` array is the
 *  self-reschedule loop's termination signal — no explicit cursor needed
 *  since a processed row always leaves the "queued" status behind. */
export const getQueuedBatch = internalQuery({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => {
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) return null;
    const rows = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign_and_status", (q) =>
        q.eq("campaignId", campaignId).eq("status", "queued"),
      )
      .take(DELIVER_BATCH_SIZE);
    return { campaign, rows };
  },
});

type DeliveryOutcome = "sent" | "failed" | "suppressed";

/** Persist one batch's per-recipient outcomes + the campaign's rollup
 *  counters, in a single mutation call (the action does all the network I/O;
 *  this does all the writes — "as few action→mutation calls as possible"). */
export const applyDeliveryBatch = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    results: v.array(
      v.object({
        recipientId: v.id("campaignRecipients"),
        outcome: v.union(v.literal("sent"), v.literal("failed"), v.literal("suppressed")),
        error: v.optional(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { campaignId, results }) => {
    let sentDelta = 0;
    let failedDelta = 0;
    let suppressedDelta = 0;
    for (const r of results) {
      const patch: Record<string, unknown> = { status: r.outcome };
      if (r.outcome === "sent") {
        patch.sentAt = Date.now();
        sentDelta++;
      } else if (r.outcome === "failed") {
        patch.error = r.error;
        failedDelta++;
      } else {
        suppressedDelta++;
      }
      await ctx.db.patch(r.recipientId, patch);
    }
    const campaign = await ctx.db.get(campaignId);
    if (campaign) {
      await ctx.db.patch(campaignId, {
        sentCount: (campaign.sentCount ?? 0) + sentDelta,
        failedCount: (campaign.failedCount ?? 0) + failedDelta,
        suppressedCount: (campaign.suppressedCount ?? 0) + suppressedDelta,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/** Finalize a campaign once no "queued" rows remain (or immediately, for the
 *  zero-recipients short-circuit via `zeroRecipientsError`). Status mirrors
 *  `blasts.ts#finishBlast`: "failed" iff at least one row was processed and
 *  NONE of them sent; "sent" otherwise (including a mixed partial-failure
 *  send — the per-row `failedCount` still tells that story). */
export const finishCampaignSend = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    zeroRecipientsError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { campaignId, zeroRecipientsError }) => {
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) return null;

    if (zeroRecipientsError !== undefined) {
      await ctx.db.patch(campaignId, {
        status: "failed",
        recipientCount: 0,
        sentCount: 0,
        failedCount: 0,
        suppressedCount: 0,
        error: zeroRecipientsError,
        sentAt: Date.now(),
        updatedAt: Date.now(),
      });
      return null;
    }

    const sentCount = campaign.sentCount ?? 0;
    const failedCount = campaign.failedCount ?? 0;
    const suppressedCount = campaign.suppressedCount ?? 0;
    const processed = sentCount + failedCount + suppressedCount;
    const status = processed > 0 && sentCount === 0 ? "failed" : "sent";
    await ctx.db.patch(campaignId, { status, sentAt: Date.now(), updatedAt: Date.now() });
    return null;
  },
});

/**
 * Send up to `DELIVER_BATCH_SIZE` queued recipients, then self-reschedule.
 * Terminates (and finalizes the campaign) once a fetch comes back empty.
 * Every per-recipient failure — suppressed, Resend unreachable, an invalid
 * document — is RECORDED on that row, never thrown; one bad address never
 * stalls the rest of the send.
 */
export const deliverCampaignBatch = internalAction({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx: ActionCtx, { campaignId }) => {
    const batch = await ctx.runQuery(internal.campaigns.getQueuedBatch, { campaignId });
    if (!batch) return null;
    if (batch.rows.length === 0) {
      await ctx.runMutation(internal.campaigns.finishCampaignSend, { campaignId });
      return null;
    }

    const { campaign, rows } = batch;
    const validated = validateEmailDocument(campaign.doc);
    const resendSettings = await resolveResendSettings(ctx);
    const suppressedNow = new Set(
      await ctx.runQuery(internal.emailSuppressions.listSuppressedEmails, {}),
    );
    const mailSettings = await ctx.runQuery(
      internal.integrationSettings.readCampaignsMailSettings,
      {},
    );

    const results: {
      recipientId: Id<"campaignRecipients">;
      outcome: DeliveryOutcome;
      error?: string;
    }[] = [];

    for (const row of rows) {
      if (suppressedNow.has(row.email)) {
        results.push({ recipientId: row._id, outcome: "suppressed" });
        continue;
      }
      if (!validated.ok) {
        results.push({
          recipientId: row._id,
          outcome: "failed",
          error: `Invalid email content: ${validated.error}`,
        });
        continue;
      }
      if (!resendSettings) {
        results.push({
          recipientId: row._id,
          outcome: "failed",
          error: "Resend isn't connected — configure it in Profile → Integrations.",
        });
        continue;
      }

      const unsubscribeUrl = `${siteUrl()}/unsubscribe/${row.unsubscribeToken}`;
      const recipient = { name: row.name ?? null, email: row.email };
      const renderOpts = {
        recipient,
        unsubscribeUrl,
        orgAddress: mailSettings.orgMailingAddress,
      };
      const replyTo = mailSettings.resendInboundDomain
        ? `campaign+${campaign._id}@${mailSettings.resendInboundDomain}`
        : undefined;

      try {
        const sendResult = await sendResendEmail(resendSettings, {
          to: row.email,
          subject: campaign.subject,
          html: renderCampaignEmail(validated.doc, renderOpts),
          text: renderCampaignText(validated.doc, renderOpts),
          replyTo,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        // `sendResendEmail` only THROWS on transport failures; an ordinary
        // non-2xx (bad address, rate limit) comes back as {ok:false} and
        // must be counted as a failed recipient, not a sent one.
        results.push(
          sendResult.ok
            ? { recipientId: row._id, outcome: "sent" as const }
            : {
                recipientId: row._id,
                outcome: "failed" as const,
                error: `Resend responded ${sendResult.status}`,
              },
        );
      } catch (err) {
        results.push({ recipientId: row._id, outcome: "failed", error: String(err) });
      }
    }

    await ctx.runMutation(internal.campaigns.applyDeliveryBatch, { campaignId, results });
    await ctx.scheduler.runAfter(0, internal.campaigns.deliverCampaignBatch, { campaignId });
    return null;
  },
});

// ── Replies (the inbox surface) ──────────────────────────────────────────────

const REPLIES_LIMIT = 200;

/** Replies inbox — org-wide (`campaignId` omitted; the Replies tab) or scoped
 *  to one campaign (the campaign detail's replies section). Rows come from
 *  the Resend inbound webhook (`http.ts` → `recordInboundReply`); newest
 *  first, bounded like every other list surface. */
export const getReplies = query({
  args: { campaignId: v.optional(v.id("campaigns")) },
  handler: async (ctx, { campaignId }) => {
    await requireCampaignsAccess(ctx);
    if (campaignId) {
      return await ctx.db
        .query("emailReplies")
        .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
        .order("desc")
        .take(REPLIES_LIMIT);
    }
    return await ctx.db
      .query("emailReplies")
      .withIndex("by_time")
      .order("desc")
      .take(REPLIES_LIMIT);
  },
});

export const markReplyRead = mutation({
  args: { replyId: v.id("emailReplies") },
  returns: v.null(),
  handler: async (ctx, { replyId }) => {
    await requireCampaignsAccess(ctx);
    const reply = await ctx.db.get(replyId);
    if (!reply) return null; // already deleted — marking read is best-effort
    if (!reply.read) await ctx.db.patch(replyId, { read: true });
    return null;
  },
});

// ── /unsubscribe/<token> (http.ts) ───────────────────────────────────────────

/** Read-only lookup for the GET confirm page — just enough to show "unsubscribe
 *  `<email>`?" without a write. */
export const getRecipientByToken = internalQuery({
  args: { token: v.string() },
  returns: v.union(v.object({ email: v.string() }), v.null()),
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_token", (q) => q.eq("unsubscribeToken", token))
      .first();
    return row ? { email: row.email } : null;
  },
});

/** The actual unsubscribe write (POST only — see `lib/unsubscribePage.ts`'s
 *  module doc on why GET never writes). Idempotent: a repeat POST for an
 *  already-suppressed address just re-marks the row, no duplicate
 *  `emailSuppressions` row. */
export const unsubscribeByToken = internalMutation({
  args: { token: v.string() },
  returns: v.union(v.object({ email: v.string() }), v.null()),
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_token", (q) => q.eq("unsubscribeToken", token))
      .first();
    if (!row) return null;

    const existing = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_email", (q) => q.eq("email", row.email))
      .first();
    if (!existing) {
      await ctx.db.insert("emailSuppressions", {
        email: row.email,
        reason: "unsubscribe",
        campaignId: row.campaignId,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(row._id, { status: "suppressed" });
    return { email: row.email };
  },
});

// ── /resend/webhook (http.ts) ────────────────────────────────────────────────

/** Record an inbound reply, matched to a campaign (or not — a stray reply
 *  still gets a row rather than silently vanishing) via the plus-address the
 *  `/resend/webhook` route parsed out of the `to` header. */
export const recordInboundReply = internalMutation({
  args: {
    campaignId: v.optional(v.id("campaigns")),
    fromEmail: v.string(),
    fromName: v.optional(v.string()),
    subject: v.optional(v.string()),
    textBody: v.optional(v.string()),
    htmlBody: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { campaignId, fromEmail, fromName, subject, textBody, htmlBody }) => {
    await ctx.db.insert("emailReplies", {
      campaignId,
      fromEmail,
      fromName,
      subject,
      textBody,
      htmlBody,
      receivedAt: Date.now(),
      read: false,
    });
    if (campaignId) {
      const campaign = await ctx.db.get(campaignId);
      if (campaign) {
        await ctx.db.patch(campaignId, { replyCount: (campaign.replyCount ?? 0) + 1 });
      }
    }
    return null;
  },
});

/** Resolve a `campaign+<id>@<domain>` plus-address back to a real campaign
 *  id, or `null` if it doesn't match that shape or the id doesn't resolve.
 *  Exported for the http.ts route's own unit-testable parsing. */
export const findCampaignByPlusAddress = internalQuery({
  args: { address: v.string() },
  returns: v.union(v.id("campaigns"), v.null()),
  handler: async (ctx, { address }) => {
    const match = /^campaign\+([a-zA-Z0-9]+)@/.exec(address);
    if (!match) return null;
    try {
      const campaign = await ctx.db.get(match[1] as Id<"campaigns">);
      return campaign ? campaign._id : null;
    } catch {
      return null; // Not a well-formed id for this table.
    }
  },
});

// Re-exported for tests / other modules that only need the status tuple.
export { CAMPAIGN_STATUSES };
