/**
 * Access gate for the Mailchimp audience sync (`mailchimpSync.ts`).
 *
 * Written as a named resolver on day one per CLAUDE.md's "gate it behind a
 * power, even when it's open today" rule: the answer today is "whoever can
 * already compose bulk email", which is a real answer and not a placeholder,
 * but it is written HERE so the day it needs its own capability the change is
 * this file's body rather than every call site.
 *
 * ── Today's answer ──────────────────────────────────────────────────────────
 *  - READ (`requireMailchimpView`) — the desk's own visibility gate,
 *    `requireCampaignsAccess`. Seeing when the list last synced and how many
 *    people are on it is exactly as sensitive as seeing the email desk.
 *  - WRITE (`requireMailchimpSync`) — `requireCampaignCompose`. Pressing
 *    "Sync now" pushes real people onto a real mailing list; that is the same
 *    weight as sending, not the same weight as looking. A design-only holder
 *    (Graphic Designer, Social Media Manager) is deliberately excluded.
 *
 * Configuring the CREDENTIALS is a third, stronger thing again and does not
 * live here: `integrationSettings.setMailchimpSettings` is superuser-gated,
 * like every other secret on that screen.
 *
 * ── Graduating this ─────────────────────────────────────────────────────────
 * The `lib/campaignsAccess.ts` three-step, no call-site churn:
 *   1. Add `"email.mailchimp.sync"` to `SEAT_CAPABILITIES`
 *      (`packages/shared/src/seats.ts`).
 *   2. List it on whichever `SEAT_DEFS` entries should carry it.
 *   3. Change ONLY the bodies below. Do NOT add the capability string until
 *      that decision is actually made.
 */
import type { QueryCtx } from "../_generated/server";
import {
  hasCampaignCompose,
  hasCampaignsAccess,
  requireCampaignCompose,
  requireCampaignsAccess,
} from "./campaignsAccess";

/** True iff the caller may SEE the Mailchimp sync status. */
export async function hasMailchimpView(ctx: QueryCtx): Promise<boolean> {
  return await hasCampaignsAccess(ctx);
}

/** Assert `hasMailchimpView`, else throw. */
export async function requireMailchimpView(ctx: QueryCtx): Promise<void> {
  await requireCampaignsAccess(ctx);
}

/** True iff the caller may TRIGGER a sync — soft form, for a passively
 *  rendered button the screen shows or hides. */
export async function hasMailchimpSync(ctx: QueryCtx): Promise<boolean> {
  return await hasCampaignCompose(ctx);
}

/** Assert `hasMailchimpSync`, else throw. The gate on
 *  `mailchimpSync.requestMailchimpSync`. */
export async function requireMailchimpSync(ctx: QueryCtx): Promise<void> {
  await requireCampaignCompose(ctx);
}
