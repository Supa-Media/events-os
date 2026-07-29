/**
 * Upgrade the built-in "Monthly newsletter" template to the TIPTAP document
 * (`@events-os/shared`'s `PUBLIC_WORSHIP_NEWSLETTER_TIPTAP` — the WS4
 * "acceptance artefact" of the maily overhaul) — migration slot 0056.
 *
 * ── Why a NEW registered migration, when 0049 already seeds this row ───────
 * `lib/builtInTemplates.ts#seedBuiltInTemplates` shipped its BODY changed in
 * this same release (it now seeds the tiptap doc + `docFormat: "tiptap"`
 * instead of the legacy blocks doc), but `runPending`'s ledger is keyed by
 * NAME, not by body content — an already-ledgered `"0049_seed_builtin_
 * campaign_templates"` row is skipped forever, regardless of what its `run`
 * function does now. Every deployment whose `0049` already ran (i.e. every
 * deployment that had a user at some point before this release) would
 * therefore sit on the STALE blocks-format built-in indefinitely unless
 * something new runs the seeder again.
 *
 * ── The two mechanisms that ALSO converge a deployment onto tiptap ─────────
 * Neither is a guaranteed deploy-time fix, which is exactly why this
 * migration exists:
 *  - `campaigns.ts#createCampaign` (apps/convex/campaigns.ts:422) calls
 *    `seedBuiltInTemplates` opportunistically on every campaign creation — the
 *    very next campaign anyone creates on a deployment upgrades the row. But
 *    a quiet deployment (nobody opens the composer between deploy and the
 *    next time someone reads the template picker) sits stale for as long as
 *    that takes.
 *  - `migrations/0052_import_newsletter_images.ts`'s hourly cron
 *    (`ensureNewsletterImagesImported`) re-seeds via
 *    `internal.campaignTemplates.ensureBuiltInTemplates` at the end of every
 *    COMMITTING run — but it self-disables the moment all eleven artwork
 *    `sourceKey`s are already on file (`already_complete`, checked BEFORE it
 *    would call the seeder), so a deployment that finished the artwork import
 *    before this release stops calling the seeder at all and would never pick
 *    up the format flip through this path.
 *
 * This migration is the actual deploy-time guarantee: it runs once,
 * automatically, in the same `runPending` sweep CI already invokes
 * post-deploy (see `apps/convex/migrations.ts#runPending`'s doc), so the
 * upgrade happens on every existing deployment without depending on either
 * of the above ever firing.
 *
 * CENTRAL SCOPE ONLY, same as 0049 — campaigns is a central-only surface
 * (`lib/campaignsAccess.ts`).
 *
 * ── Idempotent, and safe against every edge case 0049 already documented ───
 * Shares `runSeedBuiltInCampaignTemplates`'s body outright (see
 * `0049_seed_builtin_campaign_templates.ts`), so it inherits that function's
 * own guarantees unchanged:
 *  - a deployment with NO users is a safe no-op (ledgered anyway; the
 *    opportunistic `createCampaign` call remains the backstop for that case,
 *    exactly as it already is for 0049 — see that migration's own doc);
 *  - an ARCHIVED built-in row stays archived, never resurrected, and never
 *    upgraded to tiptap either (an org that deleted the newsletter template
 *    does not get it back in a new format);
 *  - re-running (this migration is ledgered, but `seedBuiltInTemplates`
 *    itself is independently idempotent) is a canonical-JSON no-op once the
 *    row is already tiptap — see `lib/builtInTemplates.ts`'s `formatChanged`
 *    branch for how the flip is guaranteed to fire exactly once.
 */

import type { MutationCtx } from "../_generated/server";
import { runSeedBuiltInCampaignTemplates } from "./0049_seed_builtin_campaign_templates";
import type { Migration } from "./index";

export async function runUpgradeBuiltInNewsletterTiptap(ctx: MutationCtx) {
  return await runSeedBuiltInCampaignTemplates(ctx);
}

export const upgradeBuiltInNewsletterTiptap: Migration = {
  name: "0056_upgrade_builtin_newsletter_tiptap",
  run: runUpgradeBuiltInNewsletterTiptap,
};
