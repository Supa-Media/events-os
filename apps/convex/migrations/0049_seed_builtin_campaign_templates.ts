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
 *
 * ── On a deployment with NO users ──────────────────────────────────────────
 * This returns a no-op, and `runPending` LEDGERS IT ANYWAY — it records the
 * row unconditionally once `run` returns, so a "completed" no-op is
 * indistinguishable from real work and the migration never runs again. An
 * earlier version of this comment claimed the opposite ("re-runs on the next
 * deploy"); that was simply wrong, and it mattered: on any deployment whose
 * first `runPending` precedes its first user — i.e. every freshly scaffolded
 * app — the built-in newsletter would have been permanently absent, which is
 * the exact "empty template picker in prod" failure this migration exists to
 * prevent.
 *
 * The no-op is therefore NOT the safety net. `campaigns.createCampaign` calls
 * `seedBuiltInTemplates` opportunistically (it always has a real user), so the
 * built-ins appear the first time anyone actually touches the campaigns desk,
 * on any deployment, whether or not this migration did anything. This
 * migration remains the fast path for deployments that already have users.
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
  name: "0049_seed_builtin_campaign_templates",
  run: runSeedBuiltInCampaignTemplates,
};
