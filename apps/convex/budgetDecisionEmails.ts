/**
 * Budget-decision emails to the SUBMITTER — approve / request-changes.
 *
 * `finances.ts#notifyBudgetApprovers` (WP-wave4 item 3) already emails a
 * budget's APPROVERS when it's sent for review; nothing emailed the
 * SUBMITTER back once a decision landed — an approval or a changes-requested
 * `reviewNote` could sit unseen until they happened to reopen the budget.
 * `approveBudget`/`requestBudgetChanges` (`finances.ts`) each schedule
 * `notifyBudgetSubmitter` right after their decision commits — the exact
 * same best-effort Resend contract `notifyBudgetApprovers` uses (never
 * blocks the mutation; no-ops without `RESEND_API_KEY`, so dev/CI never
 * send).
 *
 * KEPT IN ITS OWN FILE rather than added to `finances.ts`: PR #368 (open at
 * the time this was written) is splitting `finances.ts` into
 * `lib/financeInternals/*`. A new, self-contained file for this notification
 * stays out of that refactor's diff entirely — the only `finances.ts` changes
 * are the two `scheduler.runAfter` calls in `approveBudget`/
 * `requestBudgetChanges`, plus `export`ing `resolveBudgetRef`/`nameCache` (used
 * below for the exact same budget-name resolution `notifyBudgetApprovers`
 * already uses) — see the PR description for the rebase note once #368 lands.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";
import { sendEmail, emailShell } from "./ticketingEmails";
import { nameCache, resolveBudgetRef } from "./finances";

/**
 * Everything `notifyBudgetSubmitter` needs: the submitter's contact, the
 * budget's live display name (`resolveBudgetRef`, same resolver
 * `notifyBudgetApprovers` uses), which decision was made, the reviewer's
 * `reviewNote` (if any), and the deciding person's name for a "by so-and-so"
 * line. `null` when the budget doesn't exist, isn't at a decided status, has
 * no recorded submitter, or that submitter has no reachable email — every
 * case degrades to "send nothing," never a throw.
 */
export const getBudgetDecisionContext = internalQuery({
  args: { budgetId: v.id("budgets") },
  returns: v.union(
    v.object({
      budgetName: v.string(),
      submitterEmail: v.string(),
      submitterName: v.string(),
      decision: v.union(v.literal("approved"), v.literal("changes_requested")),
      reviewNote: v.union(v.string(), v.null()),
      decidedByName: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { budgetId }) => {
    const budget = await ctx.db.get(budgetId);
    if (!budget) return null;
    // Captured into a local (rather than narrowing `budget.approvalStatus`
    // inline) so the literal-union narrowing survives the `await`s below.
    const status = budget.approvalStatus;
    if (status !== "approved" && status !== "changes_requested") {
      return null;
    }
    if (!budget.submittedByPersonId) return null;
    const submitter = await ctx.db.get(budget.submittedByPersonId);
    const email = submitter?.email;
    if (!submitter || !email) return null;

    const { name: budgetName } = await resolveBudgetRef(
      budget,
      nameCache(ctx, "events"),
      nameCache(ctx, "projects"),
    );
    // `approvedByPersonId` doubles as "last reviewer" for BOTH decisions
    // (`requestBudgetChanges` stamps it too — see its own doc comment in
    // `finances.ts`), so this resolves the decider's name either way.
    const decider = budget.approvedByPersonId
      ? await ctx.db.get(budget.approvedByPersonId)
      : null;

    return {
      budgetName,
      submitterEmail: email,
      submitterName: submitter.name,
      decision: status,
      reviewNote: budget.reviewNote ?? null,
      decidedByName: decider?.name ?? null,
    };
  },
});

/**
 * Email the submitter that their budget was approved or sent back for
 * changes — best-effort Resend, mirrors `notifyBudgetApprovers`'s exact
 * degrade contract (logs + no-ops without `RESEND_API_KEY`). Scheduled
 * (never awaited inline) from `approveBudget`/`requestBudgetChanges`, since
 * a mutation can't perform the network call itself.
 */
export const notifyBudgetSubmitter = internalAction({
  args: { budgetId: v.id("budgets") },
  returns: v.null(),
  handler: async (ctx, { budgetId }) => {
    const decision = await ctx.runQuery(
      internal.budgetDecisionEmails.getBudgetDecisionContext,
      { budgetId },
    );
    if (!decision) return null;

    const approved = decision.decision === "approved";
    const subject = approved
      ? `Budget approved: ${decision.budgetName}`
      : `Changes requested: ${decision.budgetName}`;
    const heading = approved ? "Budget approved" : "Changes requested";
    const deciderBit = decision.decidedByName
      ? ` by ${escapeHtml(decision.decidedByName)}`
      : "";
    const lead = approved
      ? `Your budget "${escapeHtml(decision.budgetName)}" was approved${deciderBit}.`
      : `Your budget "${escapeHtml(decision.budgetName)}" was sent back for changes${deciderBit}.`;
    const noteBlock = decision.reviewNote
      ? `<div style="background:#fff;border:1px dashed #E4CFCB;border-radius:14px;padding:14px 18px;margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#210909"><b>${approved ? "Note" : "What to change"}:</b> ${escapeHtml(decision.reviewNote)}</div>`
      : "";
    // The finance dashboard — same link `notifyBudgetApprovers` uses (`null`
    // when APP_URL is unset).
    const link = appUrl("/finances");

    await sendEmail(
      decision.submitterEmail,
      subject,
      emailShell(`
        <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${heading}</h1>
        <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Hi ${escapeHtml(decision.submitterName)} — ${lead}</p>
        ${noteBlock}
        ${
          link
            ? `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600"><a href="${link}" style="color:#fff;background:#D23B3A;text-decoration:none;border:1px solid #D23B3A;border-radius:999px;padding:6px 12px;display:inline-block">Open the finance dashboard →</a></div>`
            : ""
        }`),
    );
    return null;
  },
});
