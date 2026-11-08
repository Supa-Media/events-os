/**
 * "YOUR CODING WAS APPROVED WITH CORRECTIONS" — the author's side of a
 * reviewer fixing a coding instead of sending it back.
 *
 * Dev2, 2026-11-08: "instead of sending back sometimes I may correct
 * categories budgets reasons etc, whenever I do email the person that it was
 * approved with corrections". A send-back already emails the author
 * (`cards.notifyCodingSentBack`); a correction used to be silent, so the
 * author never learned their purpose was reworded or their budget moved.
 *
 * Scheduled by `transactionCodings.approve` only when the coding carries
 * `reviewCorrections`, and only AFTER the undo window: an approval undone
 * seconds later never happened from the author's side (see
 * `lib/transactionCoding.ts#undoCodingApproval`), so the job re-reads the row
 * and sends only if that same approval still stands.
 */
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { codingForTransaction } from "./lib/transactionCoding";
import { sendEmail, emailShell } from "./ticketingEmails";
import {
  emailButtonRow,
  emailHeading,
  emailPanel,
  emailParagraph,
  emailTextStyle,
} from "./lib/emailShell";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";

/** Who to tell, and what changed. Null when the approval this job was
 *  scheduled for no longer stands (undone, or re-decided since), when nothing
 *  was corrected, when the reviewer approved their own coding (nobody to
 *  tell), or when the author has no reachable email. */
export const getApprovedWithCorrectionsContact = internalQuery({
  args: {
    transactionId: v.id("transactions"),
    decidedAt: v.number(),
  },
  returns: v.union(
    v.object({
      email: v.string(),
      authorName: v.string(),
      reviewerName: v.union(v.string(), v.null()),
      merchantName: v.union(v.string(), v.null()),
      amountCents: v.number(),
      postedAt: v.union(v.number(), v.null()),
      corrections: v.array(
        v.object({ label: v.string(), before: v.string(), after: v.string() }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, { transactionId, decidedAt }) => {
    const coding = await codingForTransaction(ctx, transactionId);
    if (!coding || coding.status !== "approved") return null;
    if (coding.decidedAt !== decidedAt) return null;
    const corrections = coding.reviewCorrections ?? [];
    if (corrections.length === 0) return null;
    if (
      (coding.codedByPersonId != null &&
        coding.codedByPersonId === coding.decidedByPersonId) ||
      (coding.codedByUserId != null &&
        coding.codedByUserId === coding.decidedByUserId)
    ) {
      return null;
    }
    // The AUTHOR is told, the same person a send-back would have reached.
    const person = coding.codedByPersonId
      ? await ctx.db.get(coding.codedByPersonId)
      : null;
    const user = coding.codedByUserId
      ? await ctx.db.get(coding.codedByUserId)
      : null;
    const email = person?.pwEmail ?? person?.email ?? user?.email ?? null;
    if (!email) return null;
    const reviewer = coding.decidedByPersonId
      ? await ctx.db.get(coding.decidedByPersonId)
      : null;
    const txn = await ctx.db.get(transactionId);
    return {
      email,
      authorName: person?.name ?? user?.name ?? "there",
      reviewerName: reviewer?.name ?? null,
      merchantName: txn?.merchantNameOverride ?? txn?.merchantName ?? null,
      amountCents: txn?.amountCents ?? 0,
      postedAt: txn?.postedAt ?? null,
      corrections: corrections.map(({ label, before, after }) => ({
        label,
        before,
        after,
      })),
    };
  },
});

/** Best-effort, like every other notification: logs and no-ops without
 *  `RESEND_API_KEY`, and never throws, because the approval it follows has
 *  already happened. */
export const notifyCodingApprovedWithCorrections = internalAction({
  args: {
    transactionId: v.id("transactions"),
    decidedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const contact = await ctx.runQuery(
        internal.codingCorrectionEmails.getApprovedWithCorrectionsContact,
        args,
      );
      if (!contact) return null;
      const dollars = `$${(Math.abs(contact.amountCents) / 100).toFixed(2)}`;
      const merchant = contact.merchantName ?? "a charge on your card";
      const when = contact.postedAt
        ? new Date(contact.postedAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/New_York",
          })
        : null;
      const byBit = contact.reviewerName
        ? ` by ${escapeHtml(contact.reviewerName)}`
        : "";
      const lead = `your coding for ${escapeHtml(merchant)} (${escapeHtml(dollars)}${when ? `, ${escapeHtml(when)}` : ""}) was approved${byBit}, with ${contact.corrections.length === 1 ? "one correction" : "a few corrections"}. You don't need to do anything.`;
      const rows = contact.corrections
        .map(
          (c) =>
            `<div style="${emailTextStyle({ margin: "0 0 10px" })}"><b style="color:inherit">${escapeHtml(c.label)}</b><br/>Was: ${escapeHtml(c.before)}<br/><span style="${emailTextStyle({ strong: true })}">Now: ${escapeHtml(c.after)}</span></div>`,
        )
        .join("");
      const link = appUrl("/code");
      await sendEmail(ctx, {
        to: contact.email,
        subject: `Your coding for ${merchant} (${dollars}) was approved with corrections`,
        html: emailShell(`
          ${emailHeading("Approved with corrections")}
          ${emailParagraph(`Hi ${escapeHtml(contact.authorName)}, ${lead}`)}
          ${emailPanel(rows)}
          ${emailParagraph("Your original answers are kept on the record alongside the corrections. If something looks wrong, raise it with the finance team.")}
          ${link ? emailButtonRow(link, "See your charges →") : ""}`),
      });
    } catch (err) {
      console.error(
        "notifyCodingApprovedWithCorrections: email failed",
        args.transactionId,
        err,
      );
    }
    return null;
  },
});
