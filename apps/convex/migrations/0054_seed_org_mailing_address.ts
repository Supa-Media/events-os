import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { SUPERUSER_EMAILS } from "../lib/superuser";

/**
 * Public Worship's CAN-SPAM postal address (2026-07-28).
 *
 * ── Why a migration and not "someone will set it" ──────────────────────────
 * The same change that added this migration made `orgMailingAddress` a HARD
 * REQUIREMENT for every bulk send: `submitForApproval`, `send`,
 * `deliverCampaignBatch` and `sendBlast` all refuse without it. The field has
 * never been set in production (it had no UI until now), and only a superuser
 * can set one — so merging without this migration takes newsletter sending
 * AND event announcements down for everyone until a superuser happens to open
 * Profile → Integrations. An event organiser cannot unblock themselves.
 *
 * Seeding it here makes the deploy self-healing: the address is in place
 * before the first send is attempted, because `runPending` executes on the
 * post-deploy step of `.github/workflows/deploy-convex.yml`.
 *
 * ── Never overwrites ───────────────────────────────────────────────────────
 * If a human has already set an address — including a different one — this
 * leaves it exactly as-is. A migration that clobbered a hand-entered legal
 * address with a hardcoded constant would be worse than one that never ran,
 * and re-running must be a no-op. Blank-after-trim counts as unset, matching
 * `readOrgMailingAddress`'s own rule that whitespace satisfies no legal
 * requirement.
 *
 * ── Creating the row ───────────────────────────────────────────────────────
 * `integrationSettings` is a singleton that may not exist yet on a young
 * deployment. Inserting a row carrying ONLY this field is safe: every other
 * column is optional, and `setEmailCampaignSettings`/`setResendSettings`
 * patch the same row later rather than replacing it.
 *
 * ── The value ──────────────────────────────────────────────────────────────
 * Supplied by the product owner verbatim. Deliberately NOT "corrected" or
 * completed here — inventing a postal code for someone's registered address
 * is exactly the kind of helpful guess that ends up printed at the bottom of
 * a few thousand emails. If it needs a ZIP, a human edits it in the UI and
 * this migration will never touch it again.
 */
const ORG_MAILING_ADDRESS = "9355 Alloway Drive, Hagerstown, MD";

/** Bound on the user scan — same shape and limit as `0049`'s, so a large
 *  deployment never turns this into a full-table read. */
const USER_SCAN_LIMIT = 200;

export async function runSeedOrgMailingAddress(ctx: MutationCtx) {
  const existing = await ctx.db.query("integrationSettings").first();

  // Checked BEFORE the user scan: the overwhelmingly common re-run path is
  // "already set", and it shouldn't pay for a query it can't use.
  if (existing && (existing.orgMailingAddress ?? "").trim().length > 0) {
    return { action: "already set" as const };
  }

  // `integrationSettings.updatedBy` requires a real `users` row — the column
  // records who last changed a settings value, and a migration has no caller.
  // Attribute to a superuser where one exists (the only people who can set
  // this field by hand, so the row reads as "set by someone who could have"),
  // else the first user. A deployment with no users has nobody to send mail
  // either, so skipping is correct rather than a deferred problem — and the
  // migration is idempotent, so a later re-run would still seed it.
  const users = await ctx.db.query("users").take(USER_SCAN_LIMIT);
  if (users.length === 0) return { action: "no users" as const };
  const actor =
    users.find(
      (u) => !!u.email && SUPERUSER_EMAILS.includes(u.email.trim().toLowerCase()),
    ) ?? users[0];

  if (!existing) {
    await ctx.db.insert("integrationSettings", {
      orgMailingAddress: ORG_MAILING_ADDRESS,
      updatedAt: Date.now(),
      updatedBy: actor._id,
    });
    return { action: "inserted" as const };
  }

  await ctx.db.patch(existing._id, {
    orgMailingAddress: ORG_MAILING_ADDRESS,
    updatedAt: Date.now(),
    updatedBy: actor._id,
  });
  return { action: "seeded" as const };
}

export const seedOrgMailingAddress: Migration = {
  name: "0054_seed_org_mailing_address",
  run: runSeedOrgMailingAddress,
};
