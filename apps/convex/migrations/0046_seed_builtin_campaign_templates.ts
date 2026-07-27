/**
 * Seed the built-in campaign templates (today: the Public Worship monthly
 * newsletter) into the central scope.
 *
 * `campaignTemplates.ts#ensureBuiltInTemplates` was written as an
 * `internalMutation` with no production caller, which meant the shipped
 * newsletter template existed in tests and nowhere else — a designer opening
 * "start from a template" in prod would have seen an empty list, which is the
 * exact problem templates were added to solve.
 *
 * Registered here rather than called from a seed hook because `runPending`
 * already runs on every deploy and the underlying helper is idempotent by
 * construction: it keys on `isBuiltIn && name` per scope, refreshes a row in
 * place ONLY when the shipped content actually differs, and deliberately skips
 * a row someone archived (a deleted template stays deleted rather than
 * resurrecting itself on the next deploy). Re-running is therefore both safe
 * and how new built-ins ship later.
 *
 * CENTRAL SCOPE ONLY. Campaigns are a central-only surface
 * (`lib/campaignsAccess.ts`) — a chapter admin has no campaigns tab — so
 * seeding per-chapter rows would create library entries nobody can reach.
 *
 * `createdBy` is a real `users` row because the column requires one: the
 * earliest superuser if the deployment has one, otherwise the earliest user.
 * On a deployment with NO users at all the seed is a no-op and re-runs on the
 * next deploy (the ledger only records a completed run), so an empty
 * deployment doesn't permanently lose its templates.
 */

import type { MutationCtx } from "../_generated/server";
import { seedBuiltInTemplates } from "../campaignTemplates";
import { SUPERUSER_EMAILS } from "../lib/superuser";
import type { Migration } from "./index";

/** Bound on the user scan — we only need ONE row for attribution, and this
 *  never becomes a full-table read on a large deployment. */
const USER_SCAN_LIMIT = 200;

export async function runSeedBuiltInCampaignTemplates(ctx: MutationCtx) {
  const users = await ctx.db.query("users").take(USER_SCAN_LIMIT);
  if (users.length === 0) return { seeded: 0, skipped: "no users" as const };

  const owner =
    users.find(
      (u) => !!u.email && SUPERUSER_EMAILS.includes(u.email.trim().toLowerCase()),
    ) ?? users[0];

  const ids = await seedBuiltInTemplates(ctx, "central", owner._id);
  return { seeded: ids.length, skipped: null };
}

export const seedBuiltInCampaignTemplates: Migration = {
  name: "0046_seed_builtin_campaign_templates",
  run: runSeedBuiltInCampaignTemplates,
};
