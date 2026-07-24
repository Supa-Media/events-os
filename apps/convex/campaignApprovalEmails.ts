/**
 * Two-party campaign approval emails — the founder-specified flow (2026-07-24,
 * verbatim intent): "I pick the audience, write the email, pick a reviewer
 * ... and click to send a test to myself and the reviewer. The email should
 * look the exact same except with [For Approval] to the reviewer and [Test]
 * to me, and at the bottom of the reviewer's email (to verify they read it) a
 * link to the screen where they see audience details, purpose, number
 * targeted, and approve, deny, or request changes."
 *
 * Two hops, both best-effort Resend (never throw — a notification failure
 * must never block or corrupt the approval workflow itself):
 *  - `sendApprovalTestPair` — scheduled by `campaigns.ts#submitForApproval`.
 *    Renders the campaign EXACTLY like `campaigns.ts#sendTest` (same dummy
 *    unsubscribe URL, same merge-tag fallbacks, same per-campaign sender
 *    override) and sends it TWICE: once to the submitter ("[Test] "
 *    subject, unchanged body — a normal preview), once to the chosen
 *    reviewer ("[For Approval] " subject, with one extra block APPENDED at
 *    the very bottom of the rendered email — after every real campaign
 *    block — linking to the campaign's review screen. That placement is
 *    deliberate: a reviewer has to scroll through the whole email to reach
 *    the decision link, which is the founder's own "proof they read it"
 *    mechanism).
 *  - `notifyCampaignDecision` — scheduled by `campaigns.ts`'s
 *    `approveCampaign`/`requestCampaignChanges`/`denyCampaign`. Emails the
 *    SUBMITTER back once any of the three decisions lands, including the
 *    reviewer's note where one exists (required for changes-requested and
 *    denied, optional for an approval). Mirrors `budgetDecisionEmails.ts`'s
 *    exact shape/contract (best-effort, no-ops without `RESEND_API_KEY` so
 *    dev/CI never send) — kept in its own file for the same reason that one
 *    is: a new, self-contained file for a notification stays out of any
 *    concurrent `campaigns.ts` refactor's diff.
 *
 * NOT here: a broadcast to every approver. The founder flow chose a SINGLE
 * reviewer at submit time (`campaigns.ts#listCampaignApprovers` feeds that
 * picker) — there is no "notify all approvers" surface in this file.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { escapeHtml } from "./lib/html";
import { appUrl, siteUrl } from "./lib/siteUrl";
import {
  formatFromAddress,
  resolveResendSettings,
  sendResendEmail,
} from "./lib/resend";
import { renderCampaignEmail, renderCampaignText, validateEmailDocument } from "@events-os/shared";
import { sendEmail, emailShell } from "./ticketingEmails";

// ── submit-time test pair ────────────────────────────────────────────────────

/** The submitter's and the chosen reviewer's contact info, resolved from the
 *  campaign's `submittedByPersonId`/`reviewerPersonId` — either (or both) can
 *  be `null` (no email on file, or the field isn't set yet), and each copy is
 *  skipped silently rather than failing the whole pair. */
export const getReviewContacts = internalQuery({
  args: { campaignId: v.id("campaigns") },
  returns: v.object({
    submitter: v.union(v.object({ name: v.string(), email: v.string() }), v.null()),
    reviewer: v.union(v.object({ name: v.string(), email: v.string() }), v.null()),
  }),
  handler: async (ctx, { campaignId }) => {
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) return { submitter: null, reviewer: null };
    const submitterPerson = campaign.submittedByPersonId
      ? await ctx.db.get(campaign.submittedByPersonId)
      : null;
    const reviewerPerson = campaign.reviewerPersonId
      ? await ctx.db.get(campaign.reviewerPersonId)
      : null;
    return {
      submitter: submitterPerson?.email
        ? { name: submitterPerson.name, email: submitterPerson.email }
        : null,
      reviewer: reviewerPerson?.email
        ? { name: reviewerPerson.name, email: reviewerPerson.email }
        : null,
    };
  },
});

/**
 * Insert `insert` immediately BEFORE the LAST `</body>` in `html` — used to
 * land the reviewer's proof-of-read block INSIDE the document
 * `renderCampaignEmail` returns (a full, self-contained `<html>…</html>`
 * document, NOT a fragment `emailShell` wraps — see that function in
 * `@events-os/shared`), rather than concatenated after its closing `</html>`
 * (invalid HTML — content outside the document root entirely; the bug this
 * fixes, 2026-07-24). `lastIndexOf` (not `indexOf`) so this is correct even
 * if a campaign block's own content happened to contain the literal string
 * `</body>` in escaped/quoted form. Falls back to a plain append (should
 * never trigger against `renderCampaignEmail`'s fixed shape, but a missing
 * `</body>` should never crash a best-effort notification send). */
function injectBeforeBodyClose(html: string, insert: string): string {
  const idx = html.lastIndexOf("</body>");
  if (idx === -1) return html + insert;
  return html.slice(0, idx) + insert + html.slice(idx);
}

/** A visible divider + a proof-of-read line + the review link, appended to
 *  the bottom of the REVIEWER's copy only (via `injectBeforeBodyClose`, so it
 *  lands INSIDE the document). Plain inline styles matching the rest of this
 *  codebase's hand-rolled transactional HTML (`ticketingEmails.ts` /
 *  `budgetDecisionEmails.ts`) — no shared component, this is the only place
 *  it's needed. */
function reviewBlock(reviewUrl: string | null): { html: string; text: string } {
  const lead =
    "You've been asked to approve this campaign. Review the audience, purpose, and recipient count, then decide:";
  const html =
    `<hr style="margin:24px 0;border:none;border-top:1px solid #E4CFCB" />` +
    `<p style="margin:0 0 12px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.6;color:#7A5A5A">${escapeHtml(lead)}</p>` +
    (reviewUrl
      ? `<p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600"><a href="${reviewUrl}" style="color:#fff;background:#D23B3A;text-decoration:none;border:1px solid #D23B3A;border-radius:999px;padding:6px 12px;display:inline-block">Review this campaign →</a></p>`
      : "");
  const text = `\n\n---\n${lead}\n${reviewUrl ?? "(open the app to review)"}`;
  return { html, text };
}

/**
 * Send the submit-time test pair — see the module doc. Best-effort: any
 * failure (Resend unconfigured, the campaign's doc somehow re-invalidated
 * between submit and this scheduled run, a network error) is caught and
 * logged, never thrown — `submitForApproval` has already committed the
 * status transition by the time this runs, and a notification failure must
 * never roll that back or block the reviewer from finding the campaign some
 * other way (the "Awaiting your approval" strip still shows it).
 */
export const sendApprovalTestPair = internalAction({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, { campaignId }) => {
    try {
      const campaign = await ctx.runQuery(internal.campaigns.getCampaignInternal, {
        campaignId,
      });
      if (!campaign) return null;
      const validated = validateEmailDocument(campaign.doc);
      if (!validated.ok) return null; // submitForApproval already validated this — defensive no-op only
      // Captured into its own binding (not read off `validated.doc` inside
      // the nested `render` closure below) — TS's control-flow narrowing on
      // `validated.ok` doesn't propagate into a function DECLARED after the
      // guard, only INTO code that reads `validated` directly at this level.
      const doc = validated.doc;

      const settings = await resolveResendSettings(ctx);
      if (!settings) return null; // no RESEND_API_KEY configured — dev/CI degrade

      const contacts = await ctx.runQuery(internal.campaignApprovalEmails.getReviewContacts, {
        campaignId,
      });
      const mailSettings = await ctx.runQuery(
        internal.integrationSettings.readCampaignsMailSettings,
        {},
      );
      const fromOverride = campaign.fromEmail
        ? formatFromAddress(campaign.fromName, campaign.fromEmail)
        : undefined;
      // Deep link into the authenticated app's campaign detail screen — the
      // reviewer must be signed in to see audience/purpose/recipient-count,
      // so this is `appUrl` (the in-app deep link), NOT `siteUrl` (the
      // public guest-facing site).
      const reviewUrl = appUrl(`/campaign/${campaignId}`);

      function render(to: string, name: string | null, appendReview: boolean) {
        const unsubscribeUrl = `${siteUrl()}/unsubscribe/test`;
        const recipient = { name, email: to };
        const renderOpts = { recipient, unsubscribeUrl, orgAddress: mailSettings.orgMailingAddress };
        let html = renderCampaignEmail(doc, renderOpts);
        let text = renderCampaignText(doc, renderOpts);
        if (appendReview) {
          const block = reviewBlock(reviewUrl);
          // INSIDE the document, right before `</body>` — never after
          // `</html>` (see `injectBeforeBodyClose`'s doc). The plain-text
          // variant has no markup to violate, so a plain append already
          // puts the review link on the last line, as intended.
          html = injectBeforeBodyClose(html, block.html);
          text += block.text;
        }
        return { html, text };
      }

      if (contacts.submitter) {
        const { html, text } = render(contacts.submitter.email, contacts.submitter.name, false);
        await sendResendEmail(settings, {
          to: contacts.submitter.email,
          subject: `[Test] ${campaign.subject}`,
          html,
          text,
          from: fromOverride,
        });
      }
      if (contacts.reviewer) {
        const { html, text } = render(contacts.reviewer.email, contacts.reviewer.name, true);
        await sendResendEmail(settings, {
          to: contacts.reviewer.email,
          subject: `[For Approval] ${campaign.subject}`,
          html,
          text,
          from: fromOverride,
        });
      }
    } catch (err) {
      console.error("[campaignApprovalEmails] failed to send the submit-time test pair", err);
    }
    return null;
  },
});

// ── decision notification (approved / changes_requested / denied) ──────────

/**
 * Everything `notifyCampaignDecision` needs: the submitter's contact, the
 * campaign's name, which of the three decisions was made, the reviewer's
 * `reviewNote`, and the reviewer's name for a "by so-and-so" line. `null`
 * when the campaign doesn't exist, isn't at a decided status, has no
 * recorded submitter, or that submitter has no reachable email — every case
 * degrades to "send nothing," never a throw (mirrors
 * `budgetDecisionEmails.ts#getBudgetDecisionContext`).
 */
export const getCampaignDecisionContext = internalQuery({
  args: { campaignId: v.id("campaigns") },
  returns: v.union(
    v.object({
      campaignName: v.string(),
      submitterEmail: v.string(),
      submitterName: v.string(),
      decision: v.union(
        v.literal("approved"),
        v.literal("changes_requested"),
        v.literal("denied"),
      ),
      reviewNote: v.union(v.string(), v.null()),
      reviewerName: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { campaignId }) => {
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) return null;
    const status = campaign.status;
    if (status !== "approved" && status !== "changes_requested" && status !== "denied") {
      return null;
    }
    if (!campaign.submittedByPersonId) return null;
    const submitter = await ctx.db.get(campaign.submittedByPersonId);
    const email = submitter?.email;
    if (!submitter || !email) return null;

    // `approvedByPersonId` doubles as "last reviewer" for all three
    // decisions (see `schema/campaigns.ts`'s doc comment).
    const reviewer = campaign.approvedByPersonId
      ? await ctx.db.get(campaign.approvedByPersonId)
      : null;

    return {
      campaignName: campaign.name,
      submitterEmail: email,
      submitterName: submitter.name,
      decision: status,
      reviewNote: campaign.reviewNote ?? null,
      reviewerName: reviewer?.name ?? null,
    };
  },
});

/**
 * Email the submitter that their campaign was approved, denied, or sent back
 * for changes — best-effort Resend, same degrade contract as
 * `sendApprovalTestPair`. Scheduled (never awaited inline) from
 * `campaigns.ts`'s three decision mutations.
 */
export const notifyCampaignDecision = internalAction({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, { campaignId }) => {
    const decision = await ctx.runQuery(
      internal.campaignApprovalEmails.getCampaignDecisionContext,
      { campaignId },
    );
    if (!decision) return null;

    const heading =
      decision.decision === "approved"
        ? "Campaign approved"
        : decision.decision === "denied"
          ? "Campaign denied"
          : "Changes requested";
    const subject = `${heading}: ${decision.campaignName}`;
    const verb =
      decision.decision === "approved"
        ? "approved"
        : decision.decision === "denied"
          ? "denied"
          : "sent back for changes";
    const byBit = decision.reviewerName ? ` by ${escapeHtml(decision.reviewerName)}` : "";
    const lead = `Your campaign "${escapeHtml(decision.campaignName)}" was ${verb}${byBit}.`;
    const noteLabel = decision.decision === "approved" ? "Note" : "Why";
    const noteBlock = decision.reviewNote
      ? `<div style="background:#fff;border:1px dashed #E4CFCB;border-radius:14px;padding:14px 18px;margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#210909"><b>${noteLabel}:</b> ${escapeHtml(decision.reviewNote)}</div>`
      : "";
    const link = appUrl(`/campaign/${campaignId}`);

    await sendEmail(ctx, {
      to: decision.submitterEmail,
      subject,
      html: emailShell(`
        <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${heading}</h1>
        <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Hi ${escapeHtml(decision.submitterName)} — ${lead}</p>
        ${noteBlock}
        ${
          link
            ? `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600"><a href="${link}" style="color:#fff;background:#D23B3A;text-decoration:none;border:1px solid #D23B3A;border-radius:999px;padding:6px 12px;display:inline-block">Open the campaign →</a></div>`
            : ""
        }`),
    });
    return null;
  },
});
