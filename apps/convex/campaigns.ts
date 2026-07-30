/**
 * Email campaigns — the in-app newsletter/announcement composer
 * (`schema/campaigns.ts#campaigns`). CENTRAL-only (`lib/campaignsAccess.ts`).
 *
 * Lifecycle: `createCampaign` (draft) → `updateCampaignMeta`/`updateCampaignDoc`
 * while still `draft`/`changes_requested` → `submitForApproval` (below) →
 * `approveCampaign`/`requestCampaignChanges`/`denyCampaign` → `send` (only
 * from `approved` or `failed` now — see the "Two-party approval" section)
 * validates (audience exists, the block document is non-empty, Resend is
 * configured — any failure is a RECORDED failure on the campaign row, never a
 * thrown error, mirroring `blasts.ts#finishBlast`'s philosophy) and flips
 * `status` to "sending", scheduling `materializeRecipients` (an
 * internalAction — it resolves the audience via
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
 * ── Two-party approval (founder requirement, 2026-07-24) ─────────────────────
 * Every MASS send needs sign-off from a DIFFERENT person holding campaign-
 * approval power before it can go out — even the Executive Director needs
 * another approval-power holder (e.g. the Marketing Director) to sign off on
 * theirs. `sendTest` and every transactional email elsewhere in the app are
 * UNCHANGED — only a real mass send is gated. Event blasts (`blasts.ts`) are
 * explicitly OUT of scope (deferred).
 *
 * State machine: `draft`/`changes_requested` → `submitForApproval` (purpose
 * required, a REVIEWER is CHOSEN from a dropdown of `campaigns.approve`
 * holders — not a broadcast — see `listCampaignApprovers`; everything `send`
 * validates today is re-validated here, loudly, since nothing is in flight
 * yet) → `pending_approval`. Submitting schedules
 * `campaignApprovalEmails.sendApprovalTestPair`, which renders the campaign
 * exactly like `sendTest` and sends TWO copies — one to the submitter
 * ("[Test] "), one to the chosen reviewer ("[For Approval] ", with a review
 * link appended at the very BOTTOM of the rendered email, after every real
 * block — a deliberate proof-of-read placement per the founder's spec: the
 * reviewer scrolls through the whole email to reach the decision link).
 * From `pending_approval`, ONLY the chosen reviewer
 * (`assertCallerIsChosenReviewer`) may decide, via exactly one of:
 *   - `approveCampaign` → `approved`. Recomputes the content+audience-
 *     definition snapshot hash (`computeCampaignSnapshotHash`) and compares
 *     it to the submit-time value stored in `approvedSnapshotHash` —
 *     mismatch throws `CONTENT_DRIFT` (the campaign or its audience's
 *     targeting changed while pending; `audiences.updateAudience` isn't
 *     status-locked, so this is the only thing that catches an audience edit
 *     made mid-review). Stamps a live `approvedRecipientCount`.
 *   - `requestCampaignChanges` (note REQUIRED) → `changes_requested`.
 *     Content editing re-opens (`assertEditable`); the submitter resubmits
 *     (same or a different reviewer — the whole approval cycle restarts,
 *     including a fresh test pair).
 *   - `denyCampaign` (note REQUIRED) → `denied`. TERMINAL for sending — not
 *     editable, not re-submittable. `revertToDraft` copies the content back
 *     to an editable `draft` so it can be reused.
 * `cancelApprovalRequest` lets the submitter (or any access holder) withdraw
 * a still-pending request back to `draft` — no log row (a withdrawal isn't a
 * decision; see `campaignApprovalLog`'s doc).
 * NO SUPERUSER BYPASS anywhere in this chain (unlike budgets'
 * `approvalParty: "single"` relaxation) — a stuck pending request is resolved
 * by the writer canceling and re-picking a reviewer, not an admin override.
 * `send` itself re-verifies the snapshot hash ONE more time right before
 * materializing (an `approved → sending` or a `failed → sending` retry both
 * re-check it — a transport-failure retry isn't a content change, but the
 * hash is cheap insurance against an audience edit that landed in between).
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
 * `campaignRecipients` ledger. Deliberately UNGATED by approval — a preview
 * send was never the founder's concern, only a real mass send is.
 */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import {
  hasCampaignApprovalPower,
  holdsCampaignCapabilityAt,
  requireCampaignCompose,
  requireCampaignsAccess,
  resolveCampaignCallerPersonId,
  resolveCampaignCallerPersonIds,
} from "./lib/campaignsAccess";
import { siteUrl } from "./lib/siteUrl";
import {
  MAILING_ADDRESS_LOCATION,
  requireOrgMailingAddress,
} from "./integrationSettings";
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
  emailDocFormatOf,
  emailHtmlDocContentIsEmpty,
  renderCampaignEmail,
  renderCampaignText,
  validateEmailDocument,
  validateEmailHtmlDocument,
  validateTiptapEmailDoc,
  type EmailDocFormat,
  type EmailDocument,
  type EmailHtmlDocument,
  type EmailTheme,
} from "@events-os/shared";
import { renderEmailHtml, renderEmailTiptap } from "@events-os/email-render";
import type { JSONContent } from "@tiptap/core";
import { tiptapVariablesFor } from "./lib/tiptapCampaignRender";
import { resolveScopeTheme, throwThemesRetired } from "./emailThemes";
// From lib/, not campaignTemplates.ts — that module imports applyThemeToDoc
// from here, so importing the seeder back from it would close a cycle.
import { seedBuiltInTemplates } from "./lib/builtInTemplates";
import { isTemplateRow, requireEmailKindRow } from "./lib/campaignKind";
import { CAMPAIGN_STATUSES } from "./schema/campaigns";
// Reused rather than re-implemented — same SOD_VIOLATION error code, pure
// (no ctx) so it's trivially testable either way. See its own doc in
// `lib/finance.ts` for the reimbursement/budget precedent this mirrors.
import { assertSeparationOfDuties } from "./lib/finance";
import { sha256Hex } from "./lib/sha256";
import { hasEffectiveExcludeCriteria, resolveAudienceRecipients } from "./lib/audienceResolve";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

// ── CRUD ──────────────────────────────────────────────────────────────────

/** EMAIL-kind rows only — a template-kind row must never surface on the
 *  emails list (the kind-blindness sweep this PR's templates merge requires;
 *  see `lib/campaignKind.ts`'s doc). `by_scope`/the unscoped scan are the same
 *  bounded reads as before; the JS `.filter()` afterward is the SAME
 *  after-`.take()` shape `campaignTemplates.listTemplates` already used for
 *  `archived` — plain array filtering, not the forbidden Convex query
 *  `.filter()`. */
export const listCampaigns = query({
  args: { scope: v.optional(scopeValidator) },
  handler: async (ctx, { scope }) => {
    await requireCampaignsAccess(ctx);
    const rows = scope
      ? await ctx.db
          .query("campaigns")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .order("desc")
          .take(200)
      : await ctx.db.query("campaigns").order("desc").take(200);
    return rows.filter((c) => !isTemplateRow(c));
  },
});

export const getCampaign = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => {
    await requireCampaignsAccess(ctx);
    const campaign = await ctx.db.get(campaignId);
    // A template-kind row is treated as NOT_FOUND here — this endpoint is for
    // emails; `campaignTemplates.getTemplate` is its template-kind twin. See
    // `lib/campaignKind.ts`'s doc on the row-kind boundary.
    if (!campaign || isTemplateRow(campaign)) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
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

// ── Theming ───────────────────────────────────────────────────────────────
// A campaign's theme is stored INLINE on its document (`EmailDocument.theme`),
// as a RESOLVED SNAPSHOT rather than a pointer to an `emailThemes` row. Two
// reasons, both load-bearing:
//
//  1. What a reviewer approved is what sends. The approval snapshot hash
//     (`computeCampaignSnapshotHash`) already hashes `campaign.doc` WHOLESALE,
//     so an inline theme rides along for free — restyling a pending campaign
//     changes its hash and correctly invalidates the approval, with no new key
//     in that payload (adding one would have re-hashed every existing campaign
//     on deploy; see that function's doc for why the payload shape is frozen).
//  2. A campaign already sent must never restyle. If the doc pointed at a row,
//     editing the org theme in November would silently rewrite what October's
//     archived send appears to have looked like.
//
// Existing campaigns are never rewritten by any of this — their stored docs
// keep no `theme` key and keep hashing byte-identically, and the renderer
// falls back to `DEFAULT_EMAIL_THEME` for them.

/** True iff `doc` already carries its own theme — the "don't overwrite what
 *  the author chose" check for every seeding path. Written defensively because
 *  `doc` is `v.any()` at the boundary. */
export function docHasTheme(doc: unknown): boolean {
  return (
    typeof doc === "object" &&
    doc !== null &&
    !Array.isArray(doc) &&
    (doc as Record<string, unknown>).theme !== undefined
  );
}

/** Stamp `theme` onto `doc`. Pure and non-mutating — the caller decides
 *  WHETHER to stamp (`docHasTheme`); this only decides HOW. */
export function applyThemeToDoc(doc: unknown, theme: EmailTheme): EmailDocument {
  return { ...(doc as EmailDocument), theme };
}

/** The tiptap twin of the blocks format's `validated.doc.blocks.length === 0`
 *  "write the email first" check — a coarse, ROOT-LEVEL-ONLY empty check
 *  (unlike mobile's `mailyDoc.ts#isTiptapDocEmpty`, which recurses to catch
 *  an all-whitespace document too), since this only has to catch the
 *  degenerate "never wrote anything" case at the send-blocking gate, not
 *  drive empty-state copy in a composer. Written defensively (`doc` is
 *  `v.any()` at the boundary) — anything not shaped like a tiptap doc counts
 *  as empty rather than throwing. */
function tiptapDocContentIsEmpty(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return true;
  const content = (doc as { content?: unknown }).content;
  return !Array.isArray(content) || content.length === 0;
}

/**
 * Validate `doc` against the write gate its `docFormat` names, dispatching
 * exactly like `emailDocFormatOf`'s resolver reads it back — the ONE place
 * "which validator does this document go through" is decided, so a call site
 * can never validate against one format and store a document shaped like the
 * other. Pure dispatch ONLY — no theme stamping (a blocks-format document's
 * `theme` key is whatever it already was; an EDIT must never silently
 * restamp it). Create-time theme stamping is each format's own concern at its
 * own call site — see `createCampaign`'s and `campaignTemplates.ts#
 * duplicateCampaignRow`'s own theme-stamping, which apply ONLY to blocks
 * documents: a `"tiptap"` document is never theme-stamped at all — tiptap
 * docs carry no theme, full stop (see the themes-freeze note on
 * `emailThemes.ts`'s module doc).
 */
function validateDocForFormat(docFormat: EmailDocFormat, doc: unknown): unknown {
  if (docFormat === "tiptap") {
    const validated = validateTiptapEmailDoc(doc);
    if (!validated.ok) {
      throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
    }
    return doc;
  }
  if (docFormat === "html") {
    // Real sanitization already happened once, upstream, in
    // `emailHtmlImport.ts`'s "use node" action — this is the coarse
    // regex-based BACKSTOP `emailHtmlDoc.ts`'s module doc describes, run at
    // every write regardless of how the doc got here.
    const validated = validateEmailHtmlDocument(doc);
    if (!validated.ok) {
      throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
    }
    return validated.doc;
  }
  const validated = validateEmailDocument(doc);
  if (!validated.ok) {
    throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
  }
  return validated.doc;
}

export const createCampaign = mutation({
  args: {
    scope: scopeValidator,
    name: v.string(),
    subject: v.string(),
    previewText: v.optional(v.string()),
    audienceId: v.id("audiences"),
    doc: v.any(),
    // Set ONCE, here, and IMMUTABLE thereafter — see `schema/campaigns.ts`'s
    // `docFormat` doc. Absent (or `"blocks"`) behaves exactly as it always
    // has; `"tiptap"` is the maily editor's document shape, `"html"` is
    // "Paste HTML" (PR 2 of the founder's editor feedback, 2026-07-30).
    docFormat: v.optional(
      v.union(v.literal("blocks"), v.literal("tiptap"), v.literal("html")),
    ),
    fromName: v.optional(v.string()),
    fromEmail: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { scope, name, subject, previewText, audienceId, doc, docFormat, fromName, fromEmail },
  ) => {
    await requireCampaignCompose(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ConvexError({ code: "EMPTY", message: "Name the email first." });
    }
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) {
      throw new ConvexError({ code: "EMPTY", message: "Write a subject line first." });
    }
    const audience = await ctx.db.get(audienceId);
    if (!audience) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audience not found." });
    }
    const format: EmailDocFormat =
      docFormat === "tiptap" ? "tiptap" : docFormat === "html" ? "html" : "blocks";
    // Stamp the scope's current default theme BEFORE validating, so the theme
    // the document actually stores is the one the validator saw — BLOCKS
    // format only (only when the incoming doc brought none of its own: a
    // composer that already picked a theme, or a template that carries one,
    // is never overridden). A tiptap document is never theme-stamped — tiptap
    // docs carry no theme at all.
    const themedDoc =
      format === "blocks" && !docHasTheme(doc)
        ? applyThemeToDoc(doc, await resolveScopeTheme(ctx, scope))
        : doc;
    const validatedDoc = validateDocForFormat(format, themedDoc);
    const sender = await validateSenderFields(ctx, fromName, fromEmail);

    // Make sure the built-in templates exist. Migration 0049 is the fast path
    // for deployments that already had users when it ran, but `runPending`
    // ledgers a no-op as a completed run — so on a freshly scaffolded
    // deployment (no users at the first deploy) the migration would never fire
    // again and the template picker would be permanently empty. Here we always
    // have a real user, so this is the guarantee; it's idempotent and bounded,
    // and campaigns are created rarely enough that the extra indexed read
    // doesn't matter.
    await seedBuiltInTemplates(ctx, scope, userId);

    const now = Date.now();
    return await ctx.db.insert("campaigns", {
      scope,
      name: trimmedName,
      subject: trimmedSubject,
      previewText: previewText?.trim() || undefined,
      audienceId,
      doc: validatedDoc,
      // Absent-means-"blocks" (the contract's own default) — only stamp the
      // column for "tiptap"/"html", so a blocks-format row hashes and reads
      // byte-identically to one created before this field existed.
      docFormat: format === "blocks" ? undefined : format,
      kind: "email",
      status: "draft",
      fromName: sender.fromName,
      fromEmail: sender.fromEmail,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Assert `campaign.status` is `"draft"` or `"changes_requested"` — every
 *  metadata/content edit is blocked once a campaign is submitted for
 *  approval (or has started/finished sending), so a campaign's history stays
 *  a faithful record of what a reviewer actually approved / what was
 *  actually sent. `changes_requested` is editable so the submitter can act
 *  on the reviewer's note before resubmitting. */
function assertEditable(campaign: Doc<"campaigns">): void {
  if (campaign.status !== "draft" && campaign.status !== "changes_requested") {
    throw new ConvexError({
      code: "NOT_EDITABLE",
      message: "Only a draft (or changes-requested) email can be edited.",
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
    await requireCampaignCompose(ctx);
    const existing = await ctx.db.get(campaignId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    requireEmailKindRow(existing);
    assertEditable(existing);

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new ConvexError({ code: "EMPTY", message: "Name the email first." });
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

/** `docFormat` is IMMUTABLE (`schema/campaigns.ts`'s doc) — this never accepts
 *  one as an argument. Instead it reads the row's OWN format
 *  (`emailDocFormatOf`) and validates `doc` against whatever gate that row
 *  was created with, so a tiptap-format row is always re-validated as tiptap
 *  and a blocks-format row always as blocks, no matter what shape `doc`
 *  happens to be this time. */
export const updateCampaignDoc = mutation({
  args: { campaignId: v.id("campaigns"), doc: v.any() },
  handler: async (ctx, { campaignId, doc }) => {
    await requireCampaignCompose(ctx);
    const existing = await ctx.db.get(campaignId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    requireEmailKindRow(existing);
    assertEditable(existing);
    const validatedDoc = validateDocForFormat(emailDocFormatOf(existing), doc);
    await ctx.db.patch(campaignId, { doc: validatedDoc, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Restyle a campaign: resolve a saved theme (`themeId`) or a built-in preset
 * (`presetName`), write it into `doc.theme`, revalidate, patch. Exactly one of
 * the two must be given.
 *
 * `assertEditable` applies — this is a CONTENT edit like any other. Letting a
 * pending or approved campaign be restyled would mean a reviewer signed off on
 * one email and a different-looking one went out; letting a SENT one be
 * restyled would rewrite history. (The snapshot hash would catch the first
 * case at send time anyway, since it hashes the whole doc — but failing loudly
 * at the edit is better than failing confusingly at the send.)
 *
 * A saved theme must belong to the campaign's own scope. Presets are global
 * and carry no scope, so they're always available.
 */
export const setCampaignTheme = mutation({
  args: {
    campaignId: v.id("campaigns"),
    themeId: v.optional(v.id("emailThemes")),
    presetName: v.optional(v.string()),
  },
  returns: v.null(),
  // Explicit return type — see `emailThemes.ts#createTheme`'s identical note
  // on why a bare `return throwThemesRetired()` without one poisons
  // downstream callers' inferred types.
  handler: async (ctx, { campaignId, themeId, presetName }): Promise<null> => {
    await requireCampaignCompose(ctx);
    // Themes freeze (2026-07-29) — retired for EVERY row, regardless of
    // format or status. See `emailThemes.ts#throwThemesRetired`'s doc.
    return throwThemesRetired();
  },
});

// ── Two-party approval (founder requirement, 2026-07-24) ─────────────────────
// See the module doc's "Two-party approval" section for the full state
// machine. This block: the snapshot-hash helper, the transition/reviewer
// guards, the append-only log helper, then the five mutations + three
// queries in submit→decide order.

/** Assert a campaign's status permits `action` — mirrors
 *  `finances.ts#assertBudgetTransition` exactly (same shape, same intent). */
function assertCampaignTransition(
  current: (typeof CAMPAIGN_STATUSES)[number],
  allowedFrom: readonly (typeof CAMPAIGN_STATUSES)[number][],
  action: string,
): void {
  if (!allowedFrom.includes(current)) {
    throw new ConvexError({
      code: "ILLEGAL_TRANSITION",
      message: `Can't ${action} an email that's "${current}".`,
    });
  }
}

/**
 * Deterministic hash over everything an approval decision BINDS: the
 * campaign's own content/sender fields, and its audience's TARGETING
 * DEFINITION (source/scope/filters, AND — person-centric audiences Phase 3
 * — its hand-picked includePersonIds/excludePersonIds, AND its property-level
 * excludeFilters) — deliberately NOT the audience's live resolved
 * MEMBERSHIP, which naturally drifts as people/donors/guests come and go (a
 * "matches everyone in Springfield" audience gaining a new match overnight
 * isn't content drift; someone silently changing WHAT it targets is). A
 * hand-pick list IS part of the targeting DEFINITION, not live membership —
 * `audiences.updateAudience` can edit `includePersonIds`/`excludePersonIds`/
 * `excludeFilters` exactly like `filters`, so omitting ANY of them here
 * would let that edit slip past both the approve-time and send-time checks
 * below (a reviewer approves audience X, the campaign sends to X′) — this
 * is exactly the #399×#407 cross-feature hole class: a NEW targeting
 * dimension added after two-party approval shipped, that must be bound into
 * the hash the moment it exists or it's a silent approval-bypass. Recomputed
 * and compared at three points: stored at
 * submit time (`approvedSnapshotHash`), recomputed and checked at approve
 * time (`approveCampaign`), and recomputed and checked again at send time
 * (`send`) — the last check catches an audience-definition edit made AFTER
 * approval but before the send actually runs (`audiences.updateAudience`
 * isn't status-locked, so this is the only thing that catches that case).
 *
 * `normalizePersonIdList` SORTS its input and treats `undefined`/`[]`
 * identically — array ORDER must never affect the hash (two saves of the
 * same picks in a different order must match), and a legacy/no-hand-pick
 * audience (`undefined`) must hash IDENTICALLY to an explicitly-cleared one
 * (`[]`), or clearing a list would itself look like drift.
 *
 * Plain `JSON.stringify` over a freshly-built object literal is
 * deterministic here (not a general-purpose canonical serializer) because
 * every call builds the SAME object with the SAME key insertion order —
 * there's no need to sort keys for that to hash identically call to call.
 *
 * `audienceExcludeFilters` (verification-round finding B) is a DELIBERATE
 * EXCEPTION to "every field always in the payload": the key is only added
 * when `excludeFilters` is set AND `hasEffectiveExcludeCriteria` says it has
 * ≥1 real criterion. Every campaign that was `pending_approval`/`approved`
 * BEFORE this field existed was hashed under a payload shape that never had
 * this key at all — unconditionally adding it (even as `null`) would have
 * changed EVERY such campaign's hash the moment this code deployed, throwing
 * `CONTENT_DRIFT` on its next `approveCampaign` or failing its next `send`
 * from the deploy alone, not from any real edit. Omitting the key for the
 * (overwhelmingly common, and after `audiences.ts`'s write-time
 * normalization, the ONLY reachable) "no effective excludeFilters" case
 * keeps the payload — and therefore the hash — byte-identical to the
 * pre-this-PR shape for every campaign that doesn't use the feature. A
 * campaign that DOES set a real `excludeFilters` still gets full drift
 * protection: the key is present, and editing it after submit still changes
 * the hash exactly like every other targeting field.
 */
function normalizePersonIdList(ids: Id<"people">[] | undefined): string[] {
  return [...(ids ?? [])].map(String).sort();
}

/** `campaign.audienceId`, asserted present — the field is `v.optional` on the
 *  schema ONLY to accommodate template-kind rows (`schema/campaigns.ts`'s
 *  `kind` doc); every EMAIL-kind row carries one (`createCampaign` requires
 *  it as an argument). Every caller here has already asserted email-kind via
 *  `requireEmailKindRow`, so a missing `audienceId` at this point is a
 *  genuine data-integrity problem, not a template slipping through — this
 *  throws rather than silently proceeding against `undefined`. */
function requireAudienceId(campaign: Doc<"campaigns">): Id<"audiences"> {
  if (!campaign.audienceId) {
    throw new ConvexError({
      code: "NO_AUDIENCE",
      message: "This email has no audience on file.",
    });
  }
  return campaign.audienceId;
}

async function computeCampaignSnapshotHash(
  ctx: QueryCtx | MutationCtx,
  campaign: Doc<"campaigns">,
): Promise<string> {
  const audience = await ctx.db.get(requireAudienceId(campaign));
  const payload: Record<string, unknown> = {
    doc: campaign.doc,
    subject: campaign.subject,
    previewText: campaign.previewText ?? null,
    fromName: campaign.fromName ?? null,
    fromEmail: campaign.fromEmail ?? null,
    audienceSource: audience?.source ?? null,
    audienceScope: audience?.scope ?? null,
    audienceFilters: audience?.filters ?? null,
    audienceIncludePersonIds: normalizePersonIdList(audience?.includePersonIds),
    audienceExcludePersonIds: normalizePersonIdList(audience?.excludePersonIds),
  };
  // Key omitted entirely (not even `: null`) for every campaign that isn't
  // using excludeFilters — see the doc above for why this is load-bearing,
  // not cosmetic.
  if (audience?.excludeFilters && hasEffectiveExcludeCriteria(audience.excludeFilters)) {
    payload.audienceExcludeFilters = audience.excludeFilters;
  }
  // Targeting v2 — same key-omission rule for the same reason: every
  // campaign hashed before this field existed must keep hashing identically
  // until its audience actually adopts `targeting` (at which point the edit
  // IS drift a reviewer should re-approve — migration 0042 deliberately
  // skips audiences referenced by in-flight approvals so a deploy alone
  // never invalidates one; see that migration's doc). `audiences.ts`'s
  // write-time normalization guarantees a stored `targeting` is never
  // present-but-inert, mirroring `excludeFilters`.
  if (audience?.targeting) {
    payload.audienceTargeting = audience.targeting;
  }
  return sha256Hex(JSON.stringify(payload));
}

/** Live resolved recipient count for `audienceId` — reuses
 *  `resolveAudienceRecipients` (the exact same primitive
 *  `audiences.ts#previewAudience` and `resolveAudienceForSend` already call)
 *  rather than duplicating audience resolution here. `undefined` when the
 *  audience no longer exists.
 *
 *  Deliberately leaves `includeDiagnostics` at its `false` default: this is
 *  polled repeatedly (campaign detail views, approval cards), so the extra
 *  data-trust transparency scans `previewAudience` opts into would be paid
 *  on every poll for a value (`recipients.length`) that never surfaces
 *  them — see `resolveAudienceRecipients`'s doc. */
async function liveAudienceCount(
  ctx: QueryCtx | MutationCtx,
  audienceId: Id<"audiences">,
): Promise<number | undefined> {
  const audience = await ctx.db.get(audienceId);
  if (!audience) return undefined;
  const resolution = await resolveAudienceRecipients(ctx, audience);
  return resolution.recipients.length;
}

/** Append one durable row to `campaignApprovalLog` — see that table's schema
 *  doc for why this is append-only and never touched again. Called ONLY by
 *  `submitForApproval`/`approveCampaign`/`requestCampaignChanges`/
 *  `denyCampaign` — `cancelApprovalRequest` deliberately does NOT log (a
 *  withdrawal, not a decision). */
async function logCampaignDecision(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  action: "submitted" | "approved" | "changes_requested" | "denied",
  personId: Id<"people">,
  extra: { note?: string; purpose?: string; recipientCount?: number } = {},
): Promise<void> {
  await ctx.db.insert("campaignApprovalLog", {
    campaignId,
    action,
    personId,
    at: Date.now(),
    ...extra,
  });
}

/**
 * Every `campaigns.approve` holder at central, as `{personId, name}`,
 * EXCLUDING every one of the CALLER's own non-placeholder `people` rows —
 * feeds the "pick a reviewer" dropdown on the submit-for-approval modal. A
 * submitter must not be able to pick themselves even if they hold approval
 * power under a different roster row (`submitForApproval`'s own
 * `assertSeparationOfDuties` call is the actual enforcement; this list is
 * just the UI's candidate set, kept consistent with it).
 */
export const listCampaignApprovers = query({
  args: {},
  returns: v.array(v.object({ personId: v.id("people"), name: v.string() })),
  handler: async (ctx) => {
    await requireCampaignsAccess(ctx);
    const ownIds = await resolveCampaignCallerPersonIds(ctx);

    const assignments = await ctx.db
      .query("seatAssignments")
      .withIndex("by_scope", (q) => q.eq("scope", "central"))
      .collect();
    const approverIds = new Set<Id<"people">>();
    for (const a of assignments) {
      const def = await ctx.db.get(a.seatDefId);
      if (def?.derived) continue;
      if (def?.capabilities.includes("campaigns.approve")) approverIds.add(a.personId);
    }

    const approvers: { personId: Id<"people">; name: string }[] = [];
    for (const personId of approverIds) {
      if (ownIds.has(personId)) continue;
      const p = await ctx.db.get(personId);
      if (p) approvers.push({ personId, name: p.name });
    }
    return approvers;
  },
});

/** Assert the caller IS the campaign's chosen reviewer — the ONLY identity
 *  allowed to decide on a pending request (no superuser bypass; see the
 *  module doc). Returns the reviewer's personId (== `campaign.reviewerPersonId`)
 *  for the caller's convenience.
 *
 *  DEFENSE IN DEPTH (2026-07-24 — SOD bypass via multiple `people` rows):
 *  `submitForApproval` already refuses to let a submitter pick ANY of their
 *  OWN rows as reviewer (see its own doc), but this checks it again here
 *  independently — a `submittedByPersonId` that's ALSO one of the caller's
 *  own rows is refused even if it somehow got there another way (a row
 *  linked/created after submission, or a direct write) — one human owning
 *  two `campaigns.approve` rows can never decide on their own submission,
 *  full stop, regardless of which of their rows ended up as which field. */
async function assertCallerIsChosenReviewer(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
): Promise<Id<"people">> {
  if (!campaign.reviewerPersonId) {
    throw new ConvexError({
      code: "NO_REVIEWER",
      message: "This email has no reviewer on file.",
    });
  }
  const ownPersonIds = await resolveCampaignCallerPersonIds(ctx);
  if (!ownPersonIds.has(campaign.reviewerPersonId)) {
    throw new ConvexError({
      code: "NOT_CHOSEN_REVIEWER",
      message: "Only the reviewer picked when this email was submitted can decide on it.",
    });
  }
  if (campaign.submittedByPersonId && ownPersonIds.has(campaign.submittedByPersonId)) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message: "You can't decide on an email you submitted.",
    });
  }
  return campaign.reviewerPersonId;
}

/** Load a campaign for a reviewer decision (approve/deny/request-changes):
 *  fetch it, then assert the caller is its chosen reviewer. Shared so the
 *  three decision mutations can never gate differently. */
async function loadCampaignForReviewerDecision(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
): Promise<Doc<"campaigns">> {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
  }
  requireEmailKindRow(campaign);
  await assertCallerIsChosenReviewer(ctx, campaign);
  return campaign;
}

export const submitForApproval = mutation({
  args: {
    campaignId: v.id("campaigns"),
    purpose: v.string(),
    reviewerPersonId: v.id("people"),
  },
  returns: v.null(),
  handler: async (ctx, { campaignId, purpose, reviewerPersonId }) => {
    await requireCampaignCompose(ctx);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    requireEmailKindRow(campaign);
    // `"failed"` is included so a hash mismatch caught at send-time (an
    // audience edit made after approval) has a way back INTO review without
    // needing content to be edited first — content itself is locked outside
    // draft/changes_requested, so only the audience's own definition could
    // have drifted; re-submitting just re-signs the current state.
    assertCampaignTransition(
      campaign.status,
      ["draft", "changes_requested", "failed"],
      "submit",
    );

    const trimmedPurpose = purpose.trim();
    if (!trimmedPurpose) {
      throw new ConvexError({
        code: "EMPTY",
        message: "Say why this email is being sent before submitting it.",
      });
    }

    // Everything `send` validates today — fail LOUDLY here (a thrown
    // ConvexError, not `recordSendFailure`) since nothing is in flight yet;
    // unlike `send`, a submit that can't proceed shouldn't silently flip the
    // campaign to a recorded failure.
    const audience = await ctx.db.get(requireAudienceId(campaign));
    if (!audience) {
      throw new ConvexError({ code: "NOT_FOUND", message: "The target audience no longer exists." });
    }
    const submitDocFormat = emailDocFormatOf(campaign);
    if (submitDocFormat === "tiptap") {
      const validated = validateTiptapEmailDoc(campaign.doc);
      if (!validated.ok) {
        throw new ConvexError({ code: "INVALID_DOC", message: `Invalid email content: ${validated.error}` });
      }
      if (tiptapDocContentIsEmpty(campaign.doc)) {
        throw new ConvexError({ code: "EMPTY", message: "Write the email first." });
      }
    } else if (submitDocFormat === "html") {
      const validated = validateEmailHtmlDocument(campaign.doc);
      if (!validated.ok) {
        throw new ConvexError({ code: "INVALID_DOC", message: `Invalid email content: ${validated.error}` });
      }
      if (emailHtmlDocContentIsEmpty(campaign.doc)) {
        throw new ConvexError({ code: "EMPTY", message: "Paste the HTML first." });
      }
    } else {
      const validated = validateEmailDocument(campaign.doc);
      if (!validated.ok) {
        throw new ConvexError({ code: "INVALID_DOC", message: `Invalid email content: ${validated.error}` });
      }
      if (validated.doc.blocks.length === 0) {
        throw new ConvexError({ code: "EMPTY", message: "Write the email first." });
      }
    }
    const settings = await ctx.db.query("integrationSettings").first();
    const resendReady = !!settings?.resendApiKey || !!process.env.RESEND_API_KEY;
    if (!resendReady) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message: "Resend isn't connected — configure it in Profile → Integrations.",
      });
    }
    // CAN-SPAM: no postal address on file means every message in this campaign
    // would ship a footer missing its legally required line. Caught HERE, at
    // submit, so a reviewer is never asked to sign off on a send that can't
    // legally go out (`send` re-checks — see its own call).
    await requireOrgMailingAddress(ctx);

    const reviewer = await ctx.db.get(reviewerPersonId);
    if (!reviewer) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Reviewer not found." });
    }
    const reviewerEligible = await holdsCampaignCapabilityAt(
      ctx,
      reviewerPersonId,
      "central",
      "campaigns.approve",
    );
    if (!reviewerEligible) {
      throw new ConvexError({
        code: "INVALID_REVIEWER",
        message: "Pick a reviewer who holds email-approval power.",
      });
    }

    // SOD, the REAL check (2026-07-24): `people.userId` has no uniqueness —
    // one human can own several `people` rows. Comparing just the resolved
    // `submittedByPersonId` against `reviewerPersonId` (below) would miss a
    // caller picking a DIFFERENT one of their OWN rows as reviewer — reject
    // outright if `reviewerPersonId` is any row this caller controls, not
    // just the one that would've been auto-picked as submitter.
    const ownPersonIds = await resolveCampaignCallerPersonIds(ctx);
    if (ownPersonIds.has(reviewerPersonId)) {
      throw new ConvexError({
        code: "SOD_VIOLATION",
        message: "Pick a reviewer other than yourself.",
      });
    }

    const submittedByPersonId = await resolveCampaignCallerPersonId(ctx);
    // Same-id belt-and-suspenders (now implied by the set check above, since
    // `submittedByPersonId` is always drawn from `ownPersonIds` — kept for
    // the explicit "approver != requester" documentation `assertSeparationOfDuties`
    // gives, and as a backstop if `resolveCampaignCallerPersonId`'s selection
    // logic ever changes to not be a strict subset of `ownPersonIds`).
    assertSeparationOfDuties(reviewerPersonId, submittedByPersonId);

    const hash = await computeCampaignSnapshotHash(ctx, campaign);
    const now = Date.now();
    await ctx.db.patch(campaignId, {
      status: "pending_approval",
      purpose: trimmedPurpose,
      submittedByPersonId,
      submittedAt: now,
      reviewerPersonId,
      approvedSnapshotHash: hash,
      // Fresh review cycle — clear any PRIOR decision's leftovers so a
      // resubmit-after-changes-requested doesn't show a stale note/decider.
      approvedByPersonId: undefined,
      approvedAt: undefined,
      reviewNote: undefined,
      approvedRecipientCount: undefined,
      error: undefined,
      updatedAt: now,
    });

    const recipientCount = await liveAudienceCount(ctx, requireAudienceId(campaign));
    await logCampaignDecision(ctx, campaignId, "submitted", submittedByPersonId, {
      purpose: trimmedPurpose,
      recipientCount,
    });

    // Best-effort, scheduled (never awaited inline — Resend needs an action
    // context). Sends the submitter+reviewer test pair — see the module doc.
    await ctx.scheduler.runAfter(0, internal.campaignApprovalEmails.sendApprovalTestPair, {
      campaignId,
    });
    return null;
  },
});

/** Withdraw a still-pending request back to `draft`. No log row (see
 *  `campaignApprovalLog`'s doc — a withdrawal isn't a decision). Any access
 *  holder may cancel, not just the original submitter — mirrors how any
 *  access holder may edit a draft. */
export const cancelApprovalRequest = mutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, { campaignId }) => {
    await requireCampaignCompose(ctx);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    requireEmailKindRow(campaign);
    assertCampaignTransition(campaign.status, ["pending_approval"], "cancel the approval request on");
    await ctx.db.patch(campaignId, {
      status: "draft",
      submittedByPersonId: undefined,
      submittedAt: undefined,
      reviewerPersonId: undefined,
      approvedSnapshotHash: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const approveCampaign = mutation({
  args: { campaignId: v.id("campaigns"), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { campaignId, note }) => {
    const campaign = await loadCampaignForReviewerDecision(ctx, campaignId);
    assertCampaignTransition(campaign.status, ["pending_approval"], "approve");
    const reviewerPersonId = campaign.reviewerPersonId as Id<"people">; // asserted by loadCampaignForReviewerDecision
    assertSeparationOfDuties(reviewerPersonId, campaign.submittedByPersonId);

    const freshHash = await computeCampaignSnapshotHash(ctx, campaign);
    if (freshHash !== campaign.approvedSnapshotHash) {
      throw new ConvexError({
        code: "CONTENT_DRIFT",
        message:
          "The campaign or its audience changed since it was submitted — cancel the request and re-submit for a fresh review.",
      });
    }

    const recipientCount = await liveAudienceCount(ctx, requireAudienceId(campaign));
    const trimmedNote = note?.trim() || undefined;
    await ctx.db.patch(campaignId, {
      status: "approved",
      approvedByPersonId: reviewerPersonId,
      approvedAt: Date.now(),
      reviewNote: trimmedNote,
      approvedRecipientCount: recipientCount,
      updatedAt: Date.now(),
    });
    await logCampaignDecision(ctx, campaignId, "approved", reviewerPersonId, {
      note: trimmedNote,
      recipientCount,
    });
    await ctx.scheduler.runAfter(0, internal.campaignApprovalEmails.notifyCampaignDecision, {
      campaignId,
    });
    return null;
  },
});

export const requestCampaignChanges = mutation({
  args: { campaignId: v.id("campaigns"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { campaignId, note }) => {
    const campaign = await loadCampaignForReviewerDecision(ctx, campaignId);
    assertCampaignTransition(campaign.status, ["pending_approval"], "request changes on");
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      throw new ConvexError({
        code: "EMPTY",
        message: "Say what needs to change before requesting changes.",
      });
    }
    const reviewerPersonId = campaign.reviewerPersonId as Id<"people">;
    assertSeparationOfDuties(reviewerPersonId, campaign.submittedByPersonId);

    await ctx.db.patch(campaignId, {
      status: "changes_requested",
      approvedByPersonId: reviewerPersonId,
      approvedAt: Date.now(),
      reviewNote: trimmedNote,
      updatedAt: Date.now(),
    });
    await logCampaignDecision(ctx, campaignId, "changes_requested", reviewerPersonId, {
      note: trimmedNote,
    });
    await ctx.scheduler.runAfter(0, internal.campaignApprovalEmails.notifyCampaignDecision, {
      campaignId,
    });
    return null;
  },
});

export const denyCampaign = mutation({
  args: { campaignId: v.id("campaigns"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { campaignId, note }) => {
    const campaign = await loadCampaignForReviewerDecision(ctx, campaignId);
    assertCampaignTransition(campaign.status, ["pending_approval"], "deny");
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      throw new ConvexError({
        code: "EMPTY",
        message: "Say why this email is being rejected.",
      });
    }
    const reviewerPersonId = campaign.reviewerPersonId as Id<"people">;
    assertSeparationOfDuties(reviewerPersonId, campaign.submittedByPersonId);

    await ctx.db.patch(campaignId, {
      status: "denied",
      approvedByPersonId: reviewerPersonId,
      approvedAt: Date.now(),
      reviewNote: trimmedNote,
      updatedAt: Date.now(),
    });
    await logCampaignDecision(ctx, campaignId, "denied", reviewerPersonId, { note: trimmedNote });
    await ctx.scheduler.runAfter(0, internal.campaignApprovalEmails.notifyCampaignDecision, {
      campaignId,
    });
    return null;
  },
});

/** Copy a `denied` campaign's content back to an editable `draft`, clearing
 *  every approval field — the writer's escape hatch to reuse the content
 *  instead of starting a new campaign from scratch. */
export const revertToDraft = mutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, { campaignId }) => {
    await requireCampaignCompose(ctx);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    requireEmailKindRow(campaign);
    assertCampaignTransition(campaign.status, ["denied"], "move back to draft");
    await ctx.db.patch(campaignId, {
      status: "draft",
      purpose: undefined,
      submittedByPersonId: undefined,
      submittedAt: undefined,
      reviewerPersonId: undefined,
      approvedByPersonId: undefined,
      approvedAt: undefined,
      reviewNote: undefined,
      approvedSnapshotHash: undefined,
      approvedRecipientCount: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Approval-surface read for one campaign: whether the CALLER is its chosen
 * reviewer (able to act right now — only true while `pending_approval`),
 * whether they're its submitter, and its full decision log (newest first) —
 * so the UI doesn't have to guess either from the raw campaign row alone.
 */
export const getCampaignApproval = query({
  args: { campaignId: v.id("campaigns") },
  returns: v.object({
    canDecide: v.boolean(),
    isSubmitter: v.boolean(),
    // Resolved server-side (not via a chapter-scoped `people.get` the client
    // could call itself — a submitter/reviewer's roster row may live in a
    // DIFFERENT chapter than the caller's own, which `requireOwned` would
    // reject) so the review card can show "by so-and-so" without a second,
    // chapter-scoped round trip that might come back empty.
    submitterName: v.union(v.string(), v.null()),
    reviewerName: v.union(v.string(), v.null()),
    log: v.array(
      v.object({
        _id: v.id("campaignApprovalLog"),
        _creationTime: v.number(),
        campaignId: v.id("campaigns"),
        action: v.union(
          v.literal("submitted"),
          v.literal("approved"),
          v.literal("changes_requested"),
          v.literal("denied"),
        ),
        personId: v.id("people"),
        note: v.optional(v.string()),
        purpose: v.optional(v.string()),
        recipientCount: v.optional(v.number()),
        at: v.number(),
      }),
    ),
  }),
  handler: async (ctx, { campaignId }) => {
    await requireCampaignsAccess(ctx);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    requireEmailKindRow(campaign);
    const ownIds = await resolveCampaignCallerPersonIds(ctx);
    const canDecide =
      campaign.status === "pending_approval" &&
      campaign.reviewerPersonId != null &&
      ownIds.has(campaign.reviewerPersonId);
    const isSubmitter =
      campaign.submittedByPersonId != null && ownIds.has(campaign.submittedByPersonId);
    const submitter = campaign.submittedByPersonId
      ? await ctx.db.get(campaign.submittedByPersonId)
      : null;
    const reviewer = campaign.reviewerPersonId
      ? await ctx.db.get(campaign.reviewerPersonId)
      : null;
    const log = await ctx.db
      .query("campaignApprovalLog")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .order("desc")
      .take(50);
    return {
      canDecide,
      isSubmitter,
      submitterName: submitter?.name ?? null,
      reviewerName: reviewer?.name ?? null,
      log,
    };
  },
});

/** Every `pending_approval` campaign where the CALLER is the chosen
 *  reviewer — feeds the "Awaiting your approval" strip. SOFT-gated on
 *  holding approval power at all (`hasCampaignApprovalPower`, non-throwing —
 *  mirrors `myCampaignsAccess`'s shape): a compose-only caller (this PR's own
 *  lower access tier) gets `[]` back, NOT a thrown `FORBIDDEN` — this is a
 *  list surface a widely-rendered strip calls unconditionally, so it must
 *  degrade gracefully the same way a soft visibility check does, never crash
 *  the screen for a caller who simply doesn't hold the power (2026-07-24 —
 *  found in adversarial review: the mobile strip crashed the whole Campaigns
 *  tab for compose-only callers). The per-row filter below is what actually
 *  decides which rows are the caller's to act on. */
export const listPendingApprovals = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("campaigns"), name: v.string(), purpose: v.optional(v.string()) })),
  handler: async (ctx) => {
    if (!(await hasCampaignApprovalPower(ctx))) return [];
    const ownIds = await resolveCampaignCallerPersonIds(ctx);
    const pending = await ctx.db
      .query("campaigns")
      .withIndex("by_status", (q) => q.eq("status", "pending_approval"))
      .take(200);
    return pending
      // Structurally impossible today (a template-kind row never reaches
      // `pending_approval` — every path that sets it goes through
      // `submitForApproval`, which refuses a template-kind row first), but
      // this is a LIST surface, exactly the "a reviewer dropdown that
      // suddenly includes templates" class of bug the kind-blindness sweep
      // exists to catch — kept explicit rather than relying on that
      // invariant holding forever.
      .filter((c) => !isTemplateRow(c))
      .filter((c) => c.reviewerPersonId != null && ownIds.has(c.reviewerPersonId))
      .map((c) => ({ _id: c._id, name: c.name, purpose: c.purpose }));
  },
});

// ── Internal access/read helpers (action-callable) ───────────────────────────

/** `requireCampaignCompose`, callable from an action via `ctx.runQuery` (an
 *  action has no `ctx.db`, so the gate — which reads `people`/`specializedRoles`
 *  — can't run directly there). Throws through to the caller unchanged.
 *
 *  COMPOSE, not mere desk access. `seats.ts` says test-sends aren't gated by
 *  the campaign capabilities, and that remains true in the sense it was
 *  written: a test send needs no APPROVAL — you don't need two-party sign-off
 *  to mail yourself a draft. It must not be read as letting a `campaigns.design`
 *  holder take any campaign in the org, including one mid-approval, and mail
 *  its contents to an arbitrary address of their choosing. `sendTest` takes a
 *  campaign id, not a template, so a designer proofing her own template isn't
 *  served by it anyway — that's what the composer preview is for. */
export const assertAccessForAction = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireCampaignCompose(ctx);
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
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    requireEmailKindRow(campaign);
    const docFormat = emailDocFormatOf(campaign);
    let blocksDoc: EmailDocument | undefined;
    if (docFormat === "tiptap") {
      const validated = validateTiptapEmailDoc(campaign.doc);
      if (!validated.ok) {
        throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
      }
    } else if (docFormat === "html") {
      const validated = validateEmailHtmlDocument(campaign.doc);
      if (!validated.ok) {
        throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
      }
    } else {
      const validated = validateEmailDocument(campaign.doc);
      if (!validated.ok) {
        throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
      }
      blocksDoc = validated.doc;
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
    // The per-campaign sender, when set — same override the real send uses,
    // so a test send previews the actual From line too.
    const fromOverride = campaign.fromEmail
      ? formatFromAddress(campaign.fromName, campaign.fromEmail)
      : undefined;

    let html: string;
    let text: string;
    if (docFormat === "tiptap") {
      // No `campaignRecipients` row/token for a test send, so no poll vote
      // URLs — `pwPoll` renders its options as inert pills, matching the
      // blocks renderer's own no-token graceful degradation.
      const rendered = await renderEmailTiptap(campaign.doc as JSONContent, {
        variables: tiptapVariablesFor(campaign.doc, recipient),
        unsubscribeUrl,
        orgAddress: mailSettings.orgMailingAddress ?? "",
        preview: campaign.previewText,
      });
      html = rendered.html;
      text = rendered.text;
    } else if (docFormat === "html") {
      // "Paste HTML" carries no merge tags — the doc is the sanitized,
      // image-re-hosted HTML verbatim.
      const rendered = await renderEmailHtml((campaign.doc as EmailHtmlDocument).html, {
        unsubscribeUrl,
        orgAddress: mailSettings.orgMailingAddress ?? "",
        preview: campaign.previewText,
      });
      html = rendered.html;
      text = rendered.text;
    } else {
      const renderOpts = { recipient, unsubscribeUrl, orgAddress: mailSettings.orgMailingAddress };
      html = renderCampaignEmail(blocksDoc as EmailDocument, renderOpts);
      text = renderCampaignText(blocksDoc as EmailDocument, renderOpts);
    }

    const sendResult = await sendResendEmail(settings, {
      to,
      subject: `[Test] ${campaign.subject}`,
      html,
      text,
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
    await requireCampaignCompose(ctx);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    requireEmailKindRow(campaign);
    // Two-party approval gate: `draft → sending` is no longer possible — a
    // campaign must clear `submitForApproval` → `approveCampaign` first. A
    // `"failed"` retry keeps its approval (a transport failure isn't a
    // content change) but still re-verifies the snapshot hash below.
    if (campaign.status !== "approved" && campaign.status !== "failed") {
      throw new ConvexError({
        code: "NOT_APPROVED",
        message:
          "This campaign isn't approved to send yet — submit it for approval first.",
      });
    }

    const audience = await ctx.db.get(requireAudienceId(campaign));
    if (!audience) {
      await recordSendFailure(ctx, campaignId, "The target audience no longer exists.");
      return null;
    }

    // Re-verify the approval snapshot hash ONE more time right before
    // materializing — see `computeCampaignSnapshotHash`'s doc. No hash on
    // record at all means this campaign (or this attempt) never actually
    // cleared approval — closes the gap for any row from before this
    // feature shipped, not just a genuine content-drift case.
    const freshHash = await computeCampaignSnapshotHash(ctx, campaign);
    if (!campaign.approvedSnapshotHash || freshHash !== campaign.approvedSnapshotHash) {
      await recordSendFailure(
        ctx,
        campaignId,
        "This campaign's content or audience changed since it was approved — submit it for approval again before sending.",
      );
      return null;
    }

    const docFormat = emailDocFormatOf(campaign);
    if (docFormat === "tiptap") {
      const validated = validateTiptapEmailDoc(campaign.doc);
      if (!validated.ok) {
        await recordSendFailure(ctx, campaignId, `Invalid email content: ${validated.error}`);
        return null;
      }
      if (tiptapDocContentIsEmpty(campaign.doc)) {
        await recordSendFailure(ctx, campaignId, "Write the email first.");
        return null;
      }
    } else if (docFormat === "html") {
      const validated = validateEmailHtmlDocument(campaign.doc);
      if (!validated.ok) {
        await recordSendFailure(ctx, campaignId, `Invalid email content: ${validated.error}`);
        return null;
      }
      if (emailHtmlDocContentIsEmpty(campaign.doc)) {
        await recordSendFailure(ctx, campaignId, "Paste the HTML first.");
        return null;
      }
    } else {
      const validated = validateEmailDocument(campaign.doc);
      if (!validated.ok) {
        await recordSendFailure(ctx, campaignId, `Invalid email content: ${validated.error}`);
        return null;
      }
      if (validated.doc.blocks.length === 0) {
        await recordSendFailure(ctx, campaignId, "Write the email first.");
        return null;
      }
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
    // CAN-SPAM, re-checked here at the point of send (the address can be
    // cleared between approval and send). This is a PRE-FLIGHT, not the last
    // word: the real last-moment check is in `deliverCampaignBatch`, which is
    // what actually renders the footer and is also reachable WITHOUT passing
    // through here (`sweepStuckSends` reschedules it directly). Deliberately a THROW rather than
    // `recordSendFailure`: a missing org-wide setting is not a fault of THIS
    // campaign, so it must not burn the campaign's approval by flipping it to
    // "failed" — the composer sees the error, a superuser fills the field in,
    // and the same approved campaign sends unchanged.
    await requireOrgMailingAddress(ctx);

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
 * Drop this campaign's poll votes. Paired with `clearRecipientsBatch` and
 * drained the same way (one bounded batch per call, caller loops to zero).
 *
 * Load-bearing, not tidiness. `send` is legally re-runnable from `"failed"`
 * (a transport failure, or `sweepStuckSends`), and `materializeRecipients`
 * then DELETES every `campaignRecipients` row and re-inserts with fresh
 * `unsubscribeToken`s. One-vote-per-person is enforced by
 * `campaignPollVotes.by_recipient_and_block` — keyed on a `recipientId` that
 * no longer exists after that wipe. Leaving the votes behind means the same
 * human, on the second copy of the email, inserts a SECOND row: both counted,
 * tally wrong, and the orphaned rows accumulate against `POLL_TALLY_CAP`
 * (whose safety argument is precisely that votes can't exceed the recipient
 * cap).
 *
 * Deleting rather than re-pointing is deliberate: a re-send re-delivers to
 * everyone, so the honest reading is that the poll re-opens with the new
 * send. Re-pointing would need a stable person identity that recipient rows
 * don't carry.
 */
export const clearPollVotesBatch = internalMutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.number(),
  handler: async (ctx, { campaignId }) => {
    const rows = await ctx.db
      .query("campaignPollVotes")
      // Prefix query on the compound index — every block for this campaign.
      .withIndex("by_campaign_and_block", (q) => q.eq("campaignId", campaignId))
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
    // Structural refusal (Run-10 escalation class): only reachable via `send`
    // (already gated) or the stuck-send sweep (status-gated to "sending",
    // which a template-kind row can never reach) — a template arriving here
    // is a bug, not a recorded per-campaign failure, so this THROWS rather
    // than following `recordSendFailure`'s "never throw" convention.
    requireEmailKindRow(campaign);

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
    // Poll votes are keyed to the recipient rows just deleted — see
    // `clearPollVotesBatch`'s doc for why leaving them lets one person vote
    // twice on a re-sent campaign.
    for (;;) {
      const dropped = await ctx.runMutation(internal.campaigns.clearPollVotesBatch, {
        campaignId,
      });
      if (dropped === 0) break;
    }

    const resolution = await ctx.runQuery(internal.audiences.resolveAudienceForSend, {
      audienceId: requireAudienceId(campaign),
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

/**
 * Halt an IN-FLIGHT send with a recorded failure, without sending anything
 * (`blasts.ts#finishBlast`'s philosophy — an action can't throw usefully at
 * anyone). Only ever acts on a campaign still in "sending", so a late/duplicate
 * call can't reopen one that already finalized.
 *
 * The approval survives: `send` accepts a retry from "failed" and re-verifies
 * the snapshot hash, so once the blocking condition is fixed (today: a
 * superuser filling in the org's postal address) the SAME approved campaign
 * sends again — no re-submission, no second reviewer. Any still-"queued"
 * recipient rows are left where they are; `materializeRecipients` clears them
 * on the retry.
 */
export const haltSendWithFailure = internalMutation({
  args: { campaignId: v.id("campaigns"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { campaignId, error }) => {
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) return null;
    if (campaign.status !== "sending") return null;
    await recordSendFailure(ctx, campaignId, error);
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
      // Belt-and-suspenders from adversarial review: a template row can never
      // legitimately reach "sending" through any public mutation (proven by
      // probe), so this only fires if a FUTURE bug lets one acquire a live
      // status — in which case rescheduling delivery against it would be the
      // second bug. Skip rather than throw: the sweep must keep draining the
      // rest of the backlog.
      if (isTemplateRow(campaign)) continue;
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
 * rest of the send. ORG-WIDE blockers are different: a missing CAN-SPAM postal
 * address stops the WHOLE send here (`haltSendWithFailure`) rather than
 * shipping a footer without it.
 */
export const deliverCampaignBatch = internalAction({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx: ActionCtx, { campaignId }) => {
    const batch = await ctx.runQuery(internal.campaigns.getQueuedBatch, { campaignId });
    if (!batch) return null;
    // Structural refusal — checked BEFORE the empty-rows short-circuit below,
    // which a template-kind row would always hit (it never has materialized
    // `campaignRecipients`) and which would otherwise silently flip its
    // `status` via `finishCampaignSend`. See `materializeRecipients`'s
    // identical guard for why this throws instead of recording a
    // per-recipient failure.
    requireEmailKindRow(batch.campaign);
    if (batch.rows.length === 0) {
      await ctx.runMutation(internal.campaigns.finishCampaignSend, { campaignId });
      return null;
    }

    const { campaign, rows } = batch;
    const docFormat = emailDocFormatOf(campaign);
    // One doc validity check up front, format-dispatched — mirrors `send`'s
    // own dispatch (`schema/campaigns.ts`'s `docFormat` doc: set once at
    // create time, so every read of this row uses the SAME validator every
    // other function that touches it does). Keeps the VALIDATED blocks doc
    // (not the raw `campaign.doc`) for rendering, matching every other
    // blocks-format call site's "validate once, render the validated result"
    // shape; a tiptap doc has no such normalization step (`doc` is used
    // as-is once `.ok`).
    const docValidity: { ok: true; blocksDoc?: EmailDocument } | { ok: false; error: string } =
      docFormat === "tiptap"
        ? validateTiptapEmailDoc(campaign.doc)
        : docFormat === "html"
          ? validateEmailHtmlDocument(campaign.doc)
          : (() => {
              const result = validateEmailDocument(campaign.doc);
              return result.ok
                ? { ok: true as const, blocksDoc: result.doc }
                : { ok: false as const, error: result.error };
            })();
    const resendSettings = await resolveResendSettings(ctx);
    const suppressedNow = new Set(
      await ctx.runQuery(internal.emailSuppressions.listSuppressedEmails, {}),
    );
    const mailSettings = await ctx.runQuery(
      internal.integrationSettings.readCampaignsMailSettings,
      {},
    );

    // CAN-SPAM, at the LAST possible moment — the only check that actually
    // guards the footer this action is about to render. `send` refuses without
    // an address, but (a) the setting is org-wide and can be cleared in the gap
    // between `send` and any batch of a long, paced delivery, and (b) this
    // action is reachable WITHOUT `send` at all: `sweepStuckSends` reschedules
    // it directly, and `applyDeliveryBatch` re-schedules it per batch. Without
    // this the renderer's `opts.orgAddress ? … : ""` (`emailRender.ts`) would
    // quietly drop the legally required line and the campaign would land
    // "sent" — the exact silent degrade `requireOrgMailingAddress` exists to
    // prevent. Recorded, never thrown (`blasts.ts#deliverEmailBlast` does the
    // same at the same point), and the approval survives — see
    // `haltSendWithFailure`.
    const orgAddress = mailSettings.orgMailingAddress?.trim();
    if (!orgAddress) {
      await ctx.runMutation(internal.campaigns.haltSendWithFailure, {
        campaignId,
        error: `No postal mailing address on file — US CAN-SPAM requires it in every message. A superuser can set it at ${MAILING_ADDRESS_LOCATION}, then send this campaign again.`,
      });
      return null;
    }

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
      if (!docValidity.ok) {
        results.push({
          recipientId: row._id,
          outcome: "failed",
          error: `Invalid email content: ${docValidity.error}`,
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
      // Poll option links are PER-RECIPIENT: the same random token that backs
      // this row's unsubscribe link identifies the voter, so one person's
      // vote can be found and MOVED when they change their mind
      // (`campaignPolls.ts#recordPollVote`). Only the real send builds
      // these — `sendTest` and the approval preview have no
      // `campaignRecipients` row and therefore no token, so they leave the
      // vote-url builder unset and the renderer draws inert pills instead of
      // links to a URL that would 404 (both formats' renderers share this
      // exact contract — see `tiptapCampaignRender.ts#tiptapPollVariables`'s
      // doc for the tiptap side).
      const pollVoteUrl = (blockId: string, optionId: string) =>
        `${siteUrl()}/poll/${campaign._id}/${row.unsubscribeToken}/${encodeURIComponent(blockId)}/${encodeURIComponent(optionId)}`;

      let html: string;
      let text: string;
      if (docFormat === "tiptap") {
        const rendered = await renderEmailTiptap(campaign.doc as JSONContent, {
          variables: tiptapVariablesFor(campaign.doc, recipient, pollVoteUrl),
          unsubscribeUrl,
          // Non-empty by construction — the refusal above already returned.
          orgAddress,
          preview: campaign.previewText,
        });
        html = rendered.html;
        text = rendered.text;
      } else if (docFormat === "html") {
        // "Paste HTML" carries no merge tags/poll links — the doc is the
        // sanitized, image-re-hosted HTML verbatim, same for every recipient.
        const rendered = await renderEmailHtml((campaign.doc as EmailHtmlDocument).html, {
          unsubscribeUrl,
          orgAddress,
          preview: campaign.previewText,
        });
        html = rendered.html;
        text = rendered.text;
      } else {
        const renderOpts = { recipient, unsubscribeUrl, orgAddress, pollVoteUrl };
        // `docValidity.ok` was already checked above (the `continue` a few
        // lines up), so `blocksDoc` is set here — it's only ever absent on
        // the `!ok` branch we already skipped past.
        html = renderCampaignEmail(docValidity.blocksDoc as EmailDocument, renderOpts);
        text = renderCampaignText(docValidity.blocksDoc as EmailDocument, renderOpts);
      }

      toSend.push({
        recipientId: row._id,
        email: {
          to: row.email,
          subject: campaign.subject,
          html,
          text,
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
    await requireCampaignCompose(ctx);
    const reply = await ctx.db.get(replyId);
    if (!reply) return null; // already deleted — marking read is best-effort
    if (!reply.read) await ctx.db.patch(replyId, { read: true });
    return null;
  },
});

// ── /unsubscribe/<token> (http.ts) ───────────────────────────────────────────
//
// TWO kinds of bulk mail mint tokens that land here, and there is deliberately
// only ONE resolution path for both:
//  - `campaignRecipients` — the newsletter composer's per-address rows.
//  - `blastRecipients` — an EVENT BLAST's per-address rows (`blasts.ts`).
//    Event announcements are organiser-composed promotional mail to a whole
//    event audience, i.e. bulk mail, and used to ship with no unsubscribe at
//    all. Rather than a second route/page/handler (three more places for the
//    two flavours to drift apart), the two lookups below simply fall back to
//    the blast table — `http.ts`'s route and `lib/unsubscribePage.ts` are
//    untouched and can't tell the difference.
// Tokens are 32 random chars from the same `newGuestToken()` alphabet, so a
// collision between the tables is not a practical concern; the campaign table
// is checked first purely because it is the older, higher-volume one.

/** Read-only lookup for the GET confirm page — just enough to show "unsubscribe
 *  `<email>`?" without a write. Campaign recipients first, then blast
 *  recipients (see the section note above). */
export const getRecipientByToken = internalQuery({
  args: { token: v.string() },
  returns: v.union(v.object({ email: v.string() }), v.null()),
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_token", (q) => q.eq("unsubscribeToken", token))
      .first();
    if (row) return { email: row.email };
    const blastRow = await ctx.db
      .query("blastRecipients")
      .withIndex("by_token", (q) => q.eq("unsubscribeToken", token))
      .first();
    return blastRow ? { email: blastRow.email } : null;
  },
});

/** The actual unsubscribe write (POST only — see `lib/unsubscribePage.ts`'s
 *  module doc on why GET never writes). Idempotent: a repeat POST for an
 *  already-suppressed address just re-marks the row, no duplicate
 *  `emailSuppressions` row. Resolves a BLAST recipient's token too (see the
 *  section note above); either way the suppression is deployment-wide, so one
 *  opt-out silences newsletters AND event announcements. A token only ever
 *  names the ONE address its own row carries — nobody can unsubscribe anybody
 *  else. */
export const unsubscribeByToken = internalMutation({
  args: { token: v.string() },
  returns: v.union(v.object({ email: v.string() }), v.null()),
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_token", (q) => q.eq("unsubscribeToken", token))
      .first();
    const blastRow = row
      ? null
      : await ctx.db
          .query("blastRecipients")
          .withIndex("by_token", (q) => q.eq("unsubscribeToken", token))
          .first();
    const email = row?.email ?? blastRow?.email;
    if (!email) return null;

    const existing = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!existing) {
      await ctx.db.insert("emailSuppressions", {
        email,
        reason: "unsubscribe",
        campaignId: row?.campaignId,
        createdAt: Date.now(),
      });
    }
    if (row) await ctx.db.patch(row._id, { status: "suppressed" });
    // A blast row keeps its delivery outcome ("sent"/"failed") and records the
    // opt-out alongside it, rather than overwriting what actually happened.
    if (blastRow) await ctx.db.patch(blastRow._id, { unsubscribedAt: Date.now() });
    return { email };
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
      // Kind guard (adversarial review): the plus-address resolver is
      // attacker-influenced input — an inbound mail to a guessed template id
      // must not accrue reply counts against a template. The reply row above
      // is still kept (unmatched replies deliberately survive, per this
      // mutation's doc); only the campaign-side counter is gated.
      if (campaign && !isTemplateRow(campaign)) {
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
