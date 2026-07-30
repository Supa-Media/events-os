/**
 * WS2b — the tiptap preview action promised by
 * `packages/shared/src/emailDocFormat.ts`'s contract:
 *
 *   api.emailPreview.renderCampaignPreview({ campaignId }) → { html, text }
 *
 * The mobile bundle deliberately does NOT ship `packages/email-render`
 * (Metro weight — see the WS0 spike report), so a tiptap-format document's
 * preview has to be rendered server-side. `"html"`-format docs (PR 2,
 * "Paste HTML", 2026-07-30) go through the exact same door — the "Paste
 * HTML" composer has no client-side renderer of its own either, and reuses
 * this action's preview pane. Blocks-format docs keep their existing
 * CLIENT-side preview (`BlocksDocumentComposer.tsx`'s `renderCampaignEmail`
 * call) — this action throws `WRONG_FORMAT` for them rather than
 * half-supporting all three.
 *
 * Gated `requireCampaignsAccess`, NOT `requireCampaignCompose` — a preview is
 * a READ (anyone who can see the desk can preview a document on it, same as
 * a composer previews live while typing), unlike `sendTest`/`send`, which
 * mutate/dispatch mail and need compose power. Runs through the
 * action-callable pattern `campaigns.ts#assertAccessForAction` established
 * (an action has no `ctx.db`, so the gate — which reads `people`/
 * `seatAssignments` — can't run directly there).
 *
 * Works on BOTH campaign rows and template rows — `kind: "template"` rows are
 * documents too (the templates merge's whole point: "templates should
 * literally just be saved emails" — `docs/plans/maily-editor-overhaul.md`).
 * There is deliberately no `requireEmailKindRow`/`requireTemplateKindRow` call
 * here.
 */
import { ConvexError, v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireCampaignsAccess } from "./lib/campaignsAccess";
import { emailDocFormatOf, type EmailHtmlDocument } from "@events-os/shared";
import { renderEmailHtml, renderEmailTiptap } from "@events-os/email-render";
import type { JSONContent } from "@tiptap/core";
import { siteUrl } from "./lib/siteUrl";
import { tiptapMergeVariables } from "./lib/tiptapCampaignRender";

/** The same sample recipient the old client-side preview used
 *  (`BlocksDocumentComposer.tsx`/`CampaignTemplatesView.tsx`/
 *  `ThemeEditor.tsx`'s own `PREVIEW_RECIPIENT`) — so a document previews
 *  identically regardless of which format renders it. */
const PREVIEW_RECIPIENT = { name: "Ada Lovelace", email: "ada@example.com" };

/** Shown in the compliance footer in place of a real postal address when the
 *  org hasn't configured one yet — a preview must never THROW just because
 *  Profile → Integrations is incomplete (unlike a real/test send, which is
 *  send-BLOCKED without one; see `campaigns.ts#send`'s
 *  `requireOrgMailingAddress` call). This is a preview-only fallback string,
 *  never sent for real. */
const ORG_ADDRESS_PLACEHOLDER =
  "Add your organization's mailing address in Profile → Integrations to complete this email.";

/** `requireCampaignsAccess`, callable from an action via `ctx.runQuery` — the
 *  READ-gate twin of `campaigns.ts#assertAccessForAction` (which asserts the
 *  stronger `requireCampaignCompose`, appropriate for a send/test-send but
 *  too strong for a plain preview). */
export const assertReadAccessForAction = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireCampaignsAccess(ctx);
    return null;
  },
});

export const renderCampaignPreview = action({
  args: { campaignId: v.id("campaigns") },
  returns: v.object({ html: v.string(), text: v.string() }),
  // Explicit return type on the handler — this action calls a function in
  // its OWN file/module (`internal.emailPreview.assertReadAccessForAction`
  // below), which is exactly the self-reference the Convex guidelines warn
  // creates a TypeScript circularity (inferring this handler's type would
  // need `internal`'s type, which needs `typeof` THIS module, which needs
  // this handler's type) — annotating breaks the cycle.
  handler: async (ctx, { campaignId }): Promise<{ html: string; text: string }> => {
    const accessCheck: null = await ctx.runQuery(
      internal.emailPreview.assertReadAccessForAction,
      {},
    );
    void accessCheck;

    const campaign = await ctx.runQuery(internal.campaigns.getCampaignInternal, {
      campaignId,
    });
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    const docFormat = emailDocFormatOf(campaign);
    if (docFormat !== "tiptap" && docFormat !== "html") {
      throw new ConvexError({
        code: "WRONG_FORMAT",
        message: "This document uses the block editor — preview it in the composer instead.",
      });
    }

    const mailSettings = await ctx.runQuery(
      internal.integrationSettings.readCampaignsMailSettings,
      {},
    );
    const orgAddress = mailSettings.orgMailingAddress?.trim() || ORG_ADDRESS_PLACEHOLDER;

    // A dummy (non-functional) unsubscribe URL — same as `sendTest`'s: a
    // preview never materializes a real `campaignRecipients` row/token, and
    // no poll vote URLs either (matching `sendTest`'s own no-token graceful
    // degradation — the renderer draws inert pills instead of links to a URL
    // that would 404).
    const unsubscribeUrl = `${siteUrl()}/unsubscribe/test`;

    if (docFormat === "html") {
      return await renderEmailHtml((campaign.doc as EmailHtmlDocument).html, {
        unsubscribeUrl,
        orgAddress,
        preview: campaign.previewText,
      });
    }

    return await renderEmailTiptap(campaign.doc as JSONContent, {
      variables: tiptapMergeVariables(PREVIEW_RECIPIENT),
      unsubscribeUrl,
      orgAddress,
      preview: campaign.previewText,
    });
  },
});
