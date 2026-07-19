/**
 * Gifts ledger AUDIT primitives (owner request #4b) — the "breadcrumb trail"
 * of every HUMAN change to a gift. A tiny, single-purpose companion to
 * `lib/givingDonors.ts`: those helpers keep the money rollups exact, these ONLY
 * narrate who changed what and when. An audit row is written by the giving-desk
 * mutations AFTER the money write succeeds (so a row exists iff the change
 * committed), and is never patched or deleted.
 *
 * The `changes` diff is pre-formatted for display (money as "$50.00", scopes as
 * "New York"/"central", dates as locale strings) so the read path is a dumb
 * render — no id resolution on the client. Reads are bounded (`GIFT_AUDIT_READ_CAP`)
 * newest-first via the `by_gift` index.
 */
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import type { GivingScope } from "./givingAccess";
import type { GIFT_AUDIT_ACTIONS } from "../schema/givingPlatform";

/** How many audit breadcrumbs the gift detail renders (newest-first). A single
 *  gift accrues few human edits; this cap only guards a runaway trail. */
export const GIFT_AUDIT_READ_CAP = 100;

/** Derived from the schema union so a new action literal can't drift out of
 *  sync (created / edited / reassignedDonor / movedScope / deleted / split /
 *  createdBySplit). */
export type GiftAuditAction = (typeof GIFT_AUDIT_ACTIONS)[number];

/** One display-ready field change ("Amount" $50.00 → $80.00). `from`/`to` are
 *  already stringified — the render never formats. */
export interface GiftFieldChange {
  field: string;
  from?: string;
  to?: string;
}

/** Format integer cents as a plain USD string for an audit line ("$1,000.00").
 *  Kept local (mirrors `@events-os/shared`'s `formatCents`) so the convex side
 *  has no cross-package import for a one-off audit label. */
export function auditCents(amountCents: number): string {
  return `$${(amountCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Append one immutable audit breadcrumb for a gift. Drops empty `changes` and a
 * blank `note` so a bare "created" row stays minimal. Never throws for an
 * absent gift — the caller has already validated the gift exists and written
 * the money change; this is the trailing narration.
 */
export async function writeGiftAudit(
  ctx: MutationCtx,
  args: {
    giftId: Id<"gifts">;
    scope: GivingScope;
    actorUserId: Id<"users">;
    action: GiftAuditAction;
    changes?: GiftFieldChange[];
    note?: string;
  },
): Promise<void> {
  const changes = (args.changes ?? []).filter(
    (c) => c.from !== undefined || c.to !== undefined,
  );
  const note = args.note?.trim() || undefined;
  await ctx.db.insert("giftAudit", {
    giftId: args.giftId,
    scope: args.scope,
    actorUserId: args.actorUserId,
    at: Date.now(),
    action: args.action,
    ...(changes.length > 0 ? { changes } : {}),
    ...(note ? { note } : {}),
  });
}
