/**
 * The ONE predicate for "is this `campaigns` row a template, or a real
 * email" — the templates merge's whole point (2026-07-29, founder decision:
 * "templates should literally just be saved emails ... so in the backend I
 * don't think it should be a separate table" — see
 * `docs/plans/maily-editor-overhaul.md`'s §Data model and `schema/campaigns.ts`'s
 * `kind` doc).
 *
 * Before the merge, the TABLE a row lived in was doing authorization AND
 * routing work: `campaignTemplates` rows could never reach the send path
 * because they lived somewhere `send`/`submitForApproval`/etc. never looked,
 * and `campaigns.design` vs. `campaigns.compose` split cleanly on which
 * table a mutation wrote. Folding both into one table means that boundary has
 * to be re-drawn on ROW KIND instead — and it must be redrawn EVERYWHERE the
 * table boundary used to draw it for free, or a template silently becomes
 * sendable (or an email silently becomes template-writable by a design-only
 * holder). `isTemplateRow` is the one place that comparison lives; nothing
 * else in this codebase should write `campaign.kind === "template"` (or
 * `!== "template"`) directly — grep for `.kind ===` outside this file if you
 * find one, it's a bug waiting to drift from this file's definition.
 */
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";

/** True iff `campaign` is a template-kind row. `kind` absent means
 *  `"email"` (every row written before this field existed) — see
 *  `schema/campaigns.ts`'s doc on `kind` for why that default is safe. */
export function isTemplateRow(campaign: Pick<Doc<"campaigns">, "kind">): boolean {
  return campaign.kind === "template";
}

/**
 * The structural refusal every SEND-PATH function needs (`submitForApproval`,
 * `send`, `sendTest`, `deliverCampaignBatch`, `materializeRecipients`, poll
 * voting, and every other mutation/query in `campaigns.ts` that operates on
 * an EXISTING row by id) — a template-kind row is not a campaign these
 * functions know how to act on, and letting one through would mean a saved
 * starting document could be submitted, approved, or mailed to a live
 * audience it never had.
 *
 * Deliberately its OWN `IS_TEMPLATE` code rather than reusing `NOT_FOUND`:
 * the callers this guards (`send`, `submitForApproval`, ...) are reached from
 * explicit user actions on a screen that already loaded the row (so "not
 * found" would be a confusing lie), and the send-path instrumentation this
 * PR added tests for wants a distinguishable error, not an ambiguous 404.
 * Read-only lookups that are ABOUT locating one specific kind (`getCampaign`,
 * `campaignTemplates.getTemplate`) use plain `NOT_FOUND` instead — see each
 * of those functions' own call sites — because from their caller's point of
 * view a wrong-kind id simply doesn't resolve, exactly like the two-table
 * shape did before this merge.
 */
export function requireEmailKindRow(campaign: Doc<"campaigns">): void {
  if (isTemplateRow(campaign)) {
    throw new ConvexError({
      code: "IS_TEMPLATE",
      message: "This is a template, not an email — templates don't submit, approve, or send.",
    });
  }
}

/** The template-side twin of `requireEmailKindRow`. Currently UNCALLED —
 *  `campaignTemplates.ts` deliberately answers a wrong-kind id with NOT_FOUND
 *  via `loadTemplate` instead (mirroring the old two-table shape), so this
 *  louder gate exists only as the symmetric API for future call sites that
 *  want the explicit error. If you reach for it, say why NOT_FOUND is wrong
 *  for your surface. (Adversarial review 2026-07-29 flagged the stale claim
 *  that this was load-bearing; it never was.) */
export function requireTemplateKindRow(campaign: Doc<"campaigns">): void {
  if (!isTemplateRow(campaign)) {
    throw new ConvexError({
      code: "NOT_A_TEMPLATE",
      message: "That row isn't a template.",
    });
  }
}
