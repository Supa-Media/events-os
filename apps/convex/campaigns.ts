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
 * slice pattern; `setRecipientCount`, its final write, schedules the first
 * `deliverCampaignBatch` itself, and also records `audienceTruncated` — see
 * `lib/audienceResolve.ts`) → `deliverCampaignBatch` (an internalAction)
 * sends up to `DELIVER_BATCH_SIZE` (100) recipients per invocation as ONE
 * Resend batch request (`lib/resend.ts#sendResendEmailBatch`); `applyDeliveryBatch`,
 * the mutation that persists each batch's results, ATOMICALLY decides — in
 * the same transaction — whether to schedule the next batch ~600ms later
 * (more "queued" rows remain, paced to stay under Resend's default ~2
 * requests/second rate limit) or finalize the campaign
 * (`completeCampaignSend`) right there. Every continuation is scheduled from
 * a mutation, never from the action after the fact, so a crash between
 * "recorded the write" and "scheduled what's next" can't happen — see
 * `applyDeliveryBatch`'s doc. A safety-net cron (`crons.ts`) reschedules any
 * "sending" campaign that's gone quiet (a crash mid-action, before it ever
 * reaches a mutation, is the one gap that leaves nothing scheduled).
 *
 * Per-campaign sender ("send as a person"): `fromName`/`fromEmail`
 * (`schema/campaigns.ts`), validated at write time by `validateSenderFields`
 * — `fromEmail`, when set, must be a bare address on the SAME domain as the
 * org's configured Resend from address (`getSenderDefaults` surfaces that
 * domain to the UI). `deliverCampaignBatch`/`sendTest` build the `From:`
 * header via `lib/resend.ts#formatFromAddress` and pass it as `sendResendEmail`/
 * `sendResendEmailBatch`'s `from` override, falling back to the org default
 * when unset.
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
import {
  emailDomain,
  formatFromAddress,
  resolveResendSettings,
  sendResendEmail,
  sendResendEmailBatch,
} from "./lib/resend";
import { escapeHtml } from "./lib/html";
import { newGuestToken } from "./ticketing";
import {
  renderCampaignEmail,
  renderCampaignText,
  validateEmailDocument,
} from "@events-os/shared";
import { CAMPAIGN_STATUSES } from "./schema/campaigns";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

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

// ── Per-campaign sender ("send as a person") ──────────────────────────────

/** A `From:`/`fromName` value must never carry a header-breaking character —
 *  both are interpolated straight into an email header (`formatFromAddress`
 *  → `sendResendEmail`'s `from`). */
const HEADER_UNSAFE_RE = /[\r\n<>]/;

/** Resolve the org's currently configured Resend from-address (the in-app
 *  setting, else the `AUTH_EMAIL_FROM` env var) — NOT the hardcoded
 *  `lib/resend.ts` fallback, which isn't a deliberate org choice and
 *  shouldn't anchor what domain a per-campaign sender is allowed to use.
 *  `undefined` means "nothing configured yet". */
async function resolveOrgFromAddress(ctx: MutationCtx): Promise<string | undefined> {
  const settings = await ctx.db.query("integrationSettings").first();
  return settings?.resendFromAddress ?? process.env.AUTH_EMAIL_FROM;
}

/**
 * Validate + normalize the optional per-campaign sender fields. `fromName`
 * just needs to be header-safe. `fromEmail`, when non-blank, must be a BARE
 * address (no "Name <addr>" wrapper — `fromName` is the separate display-name
 * field) whose domain matches the org's configured Resend from-address domain
 * EXACTLY; if the org hasn't configured one at all, setting `fromEmail` is
 * rejected with a message pointing at Profile → Integrations rather than
 * silently accepting an address with nothing to validate it against. Passing
 * either field as an empty/blank string clears it (reverts to the org
 * default at send time).
 */
async function validateSenderFields(
  ctx: MutationCtx,
  fromName: string | undefined,
  fromEmail: string | undefined,
): Promise<{ fromName?: string; fromEmail?: string }> {
  const trimmedName = fromName?.trim() || undefined;
  if (trimmedName && HEADER_UNSAFE_RE.test(trimmedName)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Sender name can't contain line breaks or angle brackets.",
    });
  }

  const trimmedEmail = fromEmail?.trim() || undefined;
  if (!trimmedEmail) {
    return { fromName: trimmedName, fromEmail: undefined };
  }
  if (HEADER_UNSAFE_RE.test(trimmedEmail) || trimmedEmail.split("@").length !== 2) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Sender email must be a bare address, e.g. aj@publicworship.life.",
    });
  }

  const orgFrom = await resolveOrgFromAddress(ctx);
  if (!orgFrom) {
    throw new ConvexError({
      code: "NOT_CONFIGURED",
      message:
        "Configure Resend's from address first (Profile → Integrations) before setting a per-campaign sender.",
    });
  }
  const orgDomain = emailDomain(orgFrom);
  const candidateDomain = emailDomain(trimmedEmail);
  if (!orgDomain || !candidateDomain || candidateDomain !== orgDomain) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Sender email must be @${orgDomain ?? "your organization's domain"}, matching your Resend sender.`,
    });
  }
  return { fromName: trimmedName, fromEmail: trimmedEmail };
}

/** Non-secret defaults the composer UI needs to render the "Send as" section
 *  (the hint text's domain, and the org default sender to show when a
 *  campaign has no override) — gated the same as everything else here
 *  (`requireCampaignsAccess`, NOT superuser-only; the from-address itself is
 *  already surfaced in full by `getIntegrationsStatus`, per that file's doc). */
export const getSenderDefaults = query({
  args: {},
  returns: v.object({
    orgFromAddress: v.union(v.string(), v.null()),
    orgDomain: v.union(v.string(), v.null()),
  }),
  handler: async (ctx) => {
    await requireCampaignsAccess(ctx);
    const settings = await ctx.db.query("integrationSettings").first();
    const orgFrom = settings?.resendFromAddress ?? process.env.AUTH_EMAIL_FROM ?? null;
    return { orgFromAddress: orgFrom, orgDomain: orgFrom ? emailDomain(orgFrom) : null };
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
    fromName: v.optional(v.string()),
    fromEmail: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { scope, name, subject, previewText, audienceId, doc, fromName, fromEmail },
  ) => {
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
    const sender = await validateSenderFields(ctx, fromName, fromEmail);

    const now = Date.now();
    return await ctx.db.insert("campaigns", {
      scope,
      name: trimmedName,
      subject: trimmedSubject,
      previewText: previewText?.trim() || undefined,
      audienceId,
      doc: validated.doc,
      status: "draft",
      fromName: sender.fromName,
      fromEmail: sender.fromEmail,
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
    // `null` clears the field (reverts to the org default sender);
    // `undefined` leaves it unchanged — the `previewText` null-sentinel
    // convention.
    fromName: v.optional(v.union(v.string(), v.null())),
    fromEmail: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (
    ctx,
    { campaignId, name, subject, previewText, audienceId, fromName, fromEmail },
  ) => {
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
    if (fromName !== undefined || fromEmail !== undefined) {
      // Re-validate the COMBINED effective value — a change to just one of
      // the pair still needs the other's current value to build a correct
      // `From:` line, and `fromEmail`'s domain check runs off whichever
      // value is now in play.
      const nextFromName = fromName === undefined ? existing.fromName : (fromName ?? undefined);
      const nextFromEmail =
        fromEmail === undefined ? existing.fromEmail : (fromEmail ?? undefined);
      const sender = await validateSenderFields(ctx, nextFromName, nextFromEmail);
      patch.fromName = sender.fromName;
      patch.fromEmail = sender.fromEmail;
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
    // The per-campaign sender, when set — same override the real send uses,
    // so a test send previews the actual From line too.
    const fromOverride = campaign.fromEmail
      ? formatFromAddress(campaign.fromName, campaign.fromEmail)
      : undefined;

    const sendResult = await sendResendEmail(settings, {
      to,
      subject: `[Test] ${campaign.subject}`,
      html: renderCampaignEmail(validated.doc, renderOpts),
      text: renderCampaignText(validated.doc, renderOpts),
      from: fromOverride,
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
        unsubscribeToken: newGuestToken(),
      });
    }
    return null;
  },
});

/** Record the resolved recipient count (+ whether the audience was truncated
 *  at the `AUDIENCE_RESOLVE_LIMIT` cap — `lib/audienceResolve.ts`) AND
 *  schedule the first `deliverCampaignBatch` invocation in the SAME mutation
 *  — scheduling from a mutation commits atomically with its writes, so a
 *  crash right after this call can never leave the campaign
 *  materialized-but-never-started (the `applyDeliveryBatch` doc below has the
 *  full rationale; this is the materialize-side half of the same fix). */
export const setRecipientCount = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    recipientCount: v.number(),
    audienceTruncated: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { campaignId, recipientCount, audienceTruncated }) => {
    await ctx.db.patch(campaignId, {
      recipientCount,
      audienceTruncated,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.campaigns.deliverCampaignBatch, {
      campaignId,
    });
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
 * dangles in "sending" with nothing to deliver. On success, `setRecipientCount`
 * itself schedules the first `deliverCampaignBatch` invocation (atomically —
 * see its doc), so there's nothing left to schedule here.
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

    const resolution = await ctx.runQuery(internal.audiences.resolveAudienceForSend, {
      audienceId: campaign.audienceId,
    });
    if (!resolution || resolution.recipients.length === 0) {
      await ctx.runMutation(internal.campaigns.finishCampaignSend, {
        campaignId,
        zeroRecipientsError: "No recipients matched this audience.",
      });
      return null;
    }

    const { recipients, truncated } = resolution;
    for (let i = 0; i < recipients.length; i += MATERIALIZE_BATCH_SIZE) {
      await ctx.runMutation(internal.campaigns.insertRecipientBatch, {
        campaignId,
        recipients: recipients.slice(i, i + MATERIALIZE_BATCH_SIZE),
      });
    }
    await ctx.runMutation(internal.campaigns.setRecipientCount, {
      campaignId,
      recipientCount: recipients.length,
      audienceTruncated: truncated,
    });
    return null;
  },
});

// ── deliver ───────────────────────────────────────────────────────────────

// Resend's batch endpoint accepts up to 100 items per request; matching this
// exactly means one action invocation == one Resend API call, keeping
// `deliverCampaignBatch` simple (no sub-batching within an invocation) while
// still comfortably clearing Resend's default ~2 requests/second rate limit
// with the ~600ms pacing between invocations (`applyDeliveryBatch`'s
// continuation, below) — a 5,000-recipient send is ~50 requests, under a
// minute of wall-clock pacing.
const DELIVER_BATCH_SIZE = 100;

/** Delay between successive `deliverCampaignBatch` invocations of the SAME
 *  campaign (`applyDeliveryBatch`'s continuation, below) — one Resend batch
 *  request per invocation, so this alone paces the whole send comfortably
 *  under Resend's default ~2 requests/second rate limit (with headroom for
 *  any other Resend traffic the deployment sends concurrently). */
const DELIVER_BATCH_PACING_MS = 600;

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

/** Shared "no queued rows remain" finalize logic — status mirrors
 *  `blasts.ts#finishBlast`: "failed" iff at least one row was processed and
 *  NONE of them sent; "sent" otherwise (including a mixed partial-failure
 *  send — the per-row `failedCount` still tells that story). Factored out so
 *  `applyDeliveryBatch`'s atomic continuation can call it directly (same
 *  transaction, no extra scheduled hop) as well as `finishCampaignSend`. */
async function completeCampaignSend(ctx: MutationCtx, campaignId: Id<"campaigns">): Promise<void> {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) return;
  const sentCount = campaign.sentCount ?? 0;
  const failedCount = campaign.failedCount ?? 0;
  const suppressedCount = campaign.suppressedCount ?? 0;
  const processed = sentCount + failedCount + suppressedCount;
  const status = processed > 0 && sentCount === 0 ? "failed" : "sent";
  await ctx.db.patch(campaignId, { status, sentAt: Date.now(), updatedAt: Date.now() });
}

/**
 * Persist one batch's per-recipient outcomes + the campaign's rollup
 * counters (the action does all the network I/O; this does all the writes —
 * "as few action→mutation calls as possible"), THEN — in the very same
 * transaction — decide what happens next: schedule the next
 * `deliverCampaignBatch` if "queued" rows remain, or finalize the campaign
 * right here if none do.
 *
 * This atomic continuation is the fix for a real failure mode: the OLD shape
 * had the action call this mutation and THEN separately call
 * `ctx.scheduler.runAfter` — two independent steps. A crash in the action
 * between those two calls (deploy restart, an uncaught error after this
 * mutation resolved) stranded the campaign in "sending" forever, since
 * actions aren't retried by Convex. Scheduling from INSIDE a mutation commits
 * atomically with its writes, so that gap no longer exists — either this
 * whole batch (row patches + counters + the next step) commits together, or
 * none of it does. (The safety-net sweep cron in `crons.ts` covers the
 * OTHER gap this doesn't — a crash in the action BEFORE it ever calls this
 * mutation, e.g. mid-Resend-call.) */
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
    if (!campaign) return null;
    await ctx.db.patch(campaignId, {
      sentCount: (campaign.sentCount ?? 0) + sentDelta,
      failedCount: (campaign.failedCount ?? 0) + failedDelta,
      suppressedCount: (campaign.suppressedCount ?? 0) + suppressedDelta,
      updatedAt: Date.now(),
    });

    const stillQueued = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign_and_status", (q) =>
        q.eq("campaignId", campaignId).eq("status", "queued"),
      )
      .take(1);
    if (stillQueued.length > 0) {
      await ctx.scheduler.runAfter(DELIVER_BATCH_PACING_MS, internal.campaigns.deliverCampaignBatch, {
        campaignId,
      });
    } else {
      await completeCampaignSend(ctx, campaignId);
    }
    return null;
  },
});

/** Finalize a campaign — either immediately for the zero-recipients
 *  short-circuit (`zeroRecipientsError`), or via `completeCampaignSend`'s
 *  shared "no queued rows remain" logic. Kept as its own callable mutation
 *  for `materializeRecipients`'s zero-recipients path, `deliverCampaignBatch`'s
 *  empty-fetch safety net, and the sweep cron — `applyDeliveryBatch`'s own
 *  atomic continuation calls `completeCampaignSend` directly instead of
 *  routing through here (no reason to pay for an extra mutation hop when
 *  it's already inside one). */
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

    await completeCampaignSend(ctx, campaignId);
    return null;
  },
});

// ── stuck-send sweep (crons.ts safety net) ──────────────────────────────────

const STUCK_SEND_STALE_MS = 10 * 60 * 1000; // 10 minutes
const STUCK_SEND_SCAN_LIMIT = 50;

/**
 * Safety-net sweep (see the module doc's "atomic continuation" note) — catches
 * the one gap atomic scheduling can't: a crash INSIDE an action before it
 * ever reaches a mutation (mid Resend network call, mid audience resolution),
 * which leaves nothing scheduled at all. Finds campaigns stuck in "sending"
 * whose `updatedAt` hasn't moved in `STUCK_SEND_STALE_MS` — a healthy active
 * send bumps `updatedAt` on every `applyDeliveryBatch`/`setRecipientCount`
 * write, so a fresh send is never mistaken for stuck — and reschedules the
 * next step: `materializeRecipients` when `recipientCount` is still unset
 * (materialize never finished — idempotent, it clears any stale rows first),
 * else `deliverCampaignBatch` (idempotent — driven entirely by "queued" rows,
 * never rows already terminal). Bounded per run via `by_status`; a backlog
 * larger than the bound drains across runs (the
 * `maintenance.sweepRateLimitAttempts` precedent). Returns the number of
 * campaigns rescheduled, for tests.
 */
export const sweepStuckSends = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - STUCK_SEND_STALE_MS;
    const candidates = await ctx.db
      .query("campaigns")
      .withIndex("by_status", (q) => q.eq("status", "sending"))
      .take(STUCK_SEND_SCAN_LIMIT);

    let rescheduled = 0;
    for (const campaign of candidates) {
      if (campaign.updatedAt >= cutoff) continue; // still actively progressing
      rescheduled++;
      if (campaign.recipientCount === undefined) {
        await ctx.scheduler.runAfter(0, internal.campaigns.materializeRecipients, {
          campaignId: campaign._id,
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.campaigns.deliverCampaignBatch, {
          campaignId: campaign._id,
        });
      }
    }
    return rescheduled;
  },
});

/**
 * Send up to `DELIVER_BATCH_SIZE` queued recipients; `applyDeliveryBatch`
 * then decides — atomically, in the mutation that persists these results —
 * whether to schedule the next batch or finalize the campaign (see its doc).
 * Also finalizes directly (via `finishCampaignSend`) if this fetch itself
 * comes back with nothing queued — the sweep cron's re-invocation of an
 * already-fully-processed campaign, or the natural empty-fetch case in the
 * older shape, both land here safely (idempotent either way). Every
 * per-recipient failure — suppressed, Resend unreachable, an invalid document
 * — is RECORDED on that row, never thrown; one bad address never stalls the
 * rest of the send.
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

    // The per-campaign sender override, when set — same value for every
    // recipient in this batch (it's a campaign-level field), unlike the
    // per-recipient unsubscribe token/headers below.
    const fromOverride = campaign.fromEmail
      ? formatFromAddress(campaign.fromName, campaign.fromEmail)
      : undefined;
    const replyTo = mailSettings.resendInboundDomain
      ? `campaign+${campaign._id}@${mailSettings.resendInboundDomain}`
      : undefined;

    // Build the personalized batch — each item keeps its own unsubscribe
    // token/URL and `List-Unsubscribe` header even though they all travel in
    // ONE Resend request (`sendResendEmailBatch`'s per-item shape). Rows that
    // fail a pre-flight check (suppressed, invalid doc, Resend unconfigured)
    // never make it into the batch at all — recorded directly instead.
    const toSend: {
      recipientId: Id<"campaignRecipients">;
      email: {
        to: string;
        subject: string;
        html: string;
        text: string;
        from?: string;
        replyTo?: string;
        headers: Record<string, string>;
      };
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

      toSend.push({
        recipientId: row._id,
        email: {
          to: row.email,
          subject: campaign.subject,
          html: renderCampaignEmail(validated.doc, renderOpts),
          text: renderCampaignText(validated.doc, renderOpts),
          from: fromOverride,
          replyTo,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        },
      });
    }

    if (toSend.length > 0 && resendSettings) {
      // `sendResendEmailBatch` only THROWS on transport failures; an
      // ordinary non-2xx comes back as `{ok:false}` — and Resend rejects the
      // WHOLE batch request on any per-item validation error (no per-item
      // result on failure), so a non-2xx here means every recipient in THIS
      // batch failed, not just one.
      try {
        const batchResult = await sendResendEmailBatch(
          resendSettings,
          toSend.map((s) => s.email),
        );
        for (const s of toSend) {
          results.push(
            batchResult.ok
              ? { recipientId: s.recipientId, outcome: "sent" as const }
              : {
                  recipientId: s.recipientId,
                  outcome: "failed" as const,
                  error: `Resend responded ${batchResult.status}`,
                },
          );
        }
      } catch (err) {
        for (const s of toSend) {
          results.push({ recipientId: s.recipientId, outcome: "failed", error: String(err) });
        }
      }
    }

    // `applyDeliveryBatch` schedules the NEXT batch (or finalizes the
    // campaign) itself, atomically with these writes — see its doc. Nothing
    // left to schedule here.
    await ctx.runMutation(internal.campaigns.applyDeliveryBatch, { campaignId, results });
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

const INBOUND_TEXT_BODY_LIMIT = 50_000;
const INBOUND_HTML_BODY_LIMIT = 150_000;
const TRUNCATION_MARKER = "… [truncated]";

/** Cap an inbound body at `limit` chars, appending a visible marker — an
 *  inbound webhook payload is attacker/third-party-controlled (Resend just
 *  forwards whatever the sender sent), so an unbounded body could otherwise
 *  blow past Convex's 1MB document size limit or bloat the replies inbox. */
function truncateBody(body: string | undefined, limit: number): string | undefined {
  if (body === undefined || body.length <= limit) return body;
  return `${body.slice(0, limit)}${TRUNCATION_MARKER}`;
}

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
      textBody: truncateBody(textBody, INBOUND_TEXT_BODY_LIMIT),
      htmlBody: truncateBody(htmlBody, INBOUND_HTML_BODY_LIMIT),
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

/**
 * Best-effort forward of an inbound reply to the campaign's per-campaign
 * sender (`fromEmail`), when one is set — scheduled by `http.ts`'s
 * `/resend/webhook` route right after `recordInboundReply` commits, so the
 * webhook handler itself stays fast (one write + one `ctx.scheduler` call,
 * no outbound Resend call inline). No-ops (never throws) when the campaign
 * has no `fromEmail`, or Resend isn't configured — a forward is a
 * nice-to-have layered on top of an already-recorded reply, and must never
 * turn into a Resend webhook retry storm the way a thrown error here would
 * (Resend retries non-2xx webhook responses; this action runs AFTER the
 * webhook has already responded, but the discipline — catch and log,
 * never throw — matches every other best-effort path in this route).
 *
 * `replyTo` is set to the REPLIER's address, not the campaign's, so hitting
 * "reply" in the recipient's mail client goes straight to the guest — the
 * whole point of the forward.
 */
export const forwardReplyToSender = internalAction({
  args: {
    campaignId: v.id("campaigns"),
    replyFromEmail: v.string(),
    replyFromName: v.optional(v.string()),
    replyText: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { campaignId, replyFromEmail, replyFromName, replyText }) => {
    try {
      const campaign = await ctx.runQuery(internal.campaigns.getCampaignInternal, {
        campaignId,
      });
      if (!campaign?.fromEmail) return null; // no per-campaign sender to forward to

      const settings = await resolveResendSettings(ctx);
      if (!settings) return null; // Resend isn't connected — can't forward either

      const replierLabel = replyFromName ? `${replyFromName} <${replyFromEmail}>` : replyFromEmail;
      const body = truncateBody(replyText, INBOUND_TEXT_BODY_LIMIT)?.trim() || "(no message body)";
      const text = [
        `${replierLabel} replied to "${campaign.subject}":`,
        "",
        body,
        "",
        "—",
        `Reply to this email to respond directly to ${replierLabel}.`,
      ].join("\n");
      const html =
        `<p><strong>${escapeHtml(replierLabel)}</strong> replied to "${escapeHtml(campaign.subject)}":</p>` +
        `<p style="white-space:pre-wrap">${escapeHtml(body)}</p>` +
        `<p>Reply to this email to respond directly to ${escapeHtml(replierLabel)}.</p>`;

      // Sent from the ORG's Resend settings (not the campaign's custom
      // sender) — this is mail TO the campaign's fromEmail person, not FROM
      // them.
      await sendResendEmail(settings, {
        to: campaign.fromEmail,
        subject: `Re: ${campaign.subject} — reply from ${replierLabel}`,
        html,
        text,
        replyTo: replyFromEmail,
      });
    } catch (err) {
      console.error("[campaigns] failed to forward reply to sender", err);
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
