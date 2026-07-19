/**
 * Giving integrity AUDIT primitives (owner feedback #4/#5) — the donor-record,
 * person-record, and pledge-lifecycle counterparts to `lib/giftAudit.ts`. Same
 * house rule: these helpers ONLY narrate who changed what and when; they never
 * touch a money rollup or a backer count. A row is written by the desk mutation
 * (or a system/billing transition) AFTER the real write commits, and is never
 * patched or deleted.
 *
 * `changes` is pre-formatted for display (money via `auditCents`, dates as
 * locale strings, labels resolved) so every read path is a dumb render.
 */
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import type { GivingScope } from "./givingAccess";
import type { GiftFieldChange } from "./giftAudit";
import type { DONOR_AUDIT_ACTIONS, PLEDGE_EVENT_KINDS } from "../schema/givingPlatform";

/** One display-ready field change ("Email" a@x → b@x). Re-exported shape shared
 *  with the gift audit so a merged donor↔person pair reads consistently. */
export type FieldChange = GiftFieldChange;

export type DonorAuditAction = (typeof DONOR_AUDIT_ACTIONS)[number];
export type PledgeEventKind = (typeof PLEDGE_EVENT_KINDS)[number];

/** How many audit breadcrumbs a detail view renders (newest-first). A single
 *  donor/person/pledge accrues few human edits; this only guards a runaway trail. */
export const GIVING_AUDIT_READ_CAP = 100;

/**
 * Diff a fixed set of contact-ish fields (name/email/phone…) into display
 * changes. `before`/`after` map a field key → its current string value (already
 * normalized by the caller); `labels` maps the key → the human column name.
 * Only fields whose value actually changed produce a `{field, from, to}` entry;
 * a blank value renders as "—".
 */
export function diffFields(
  labels: Record<string, string>,
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const key of Object.keys(labels)) {
    const from = before[key];
    const to = after[key];
    if ((from ?? "") === (to ?? "")) continue;
    out.push({
      field: labels[key],
      from: from && from.length > 0 ? from : "—",
      to: to && to.length > 0 ? to : "—",
    });
  }
  return out;
}

/**
 * Append one immutable donor-audit breadcrumb. Drops an empty `changes`/blank
 * `note` so a bare row stays minimal. Never throws for an absent donor — the
 * caller has already validated + written the change; this is trailing narration.
 */
export async function writeDonorAudit(
  ctx: MutationCtx,
  args: {
    donorId: Id<"donors">;
    scope: GivingScope;
    actorUserId: Id<"users">;
    action: DonorAuditAction;
    changes?: FieldChange[];
    note?: string;
  },
): Promise<void> {
  const changes = (args.changes ?? []).filter(
    (c) => c.from !== undefined || c.to !== undefined,
  );
  const note = args.note?.trim() || undefined;
  await ctx.db.insert("donorAudit", {
    donorId: args.donorId,
    scope: args.scope,
    actorUserId: args.actorUserId,
    at: Date.now(),
    action: args.action,
    ...(changes.length > 0 ? { changes } : {}),
    ...(note ? { note } : {}),
  });
}

/** Append one immutable person-audit breadcrumb (contact-field edits only).
 *  Skips a write when nothing actually changed. */
export async function writePersonAudit(
  ctx: MutationCtx,
  args: {
    personId: Id<"people">;
    chapterId: Id<"chapters">;
    actorUserId: Id<"users">;
    changes: FieldChange[];
    note?: string;
  },
): Promise<void> {
  const changes = args.changes.filter(
    (c) => c.from !== undefined || c.to !== undefined,
  );
  if (changes.length === 0) return; // nothing to narrate
  const note = args.note?.trim() || undefined;
  await ctx.db.insert("personAudit", {
    personId: args.personId,
    chapterId: args.chapterId,
    actorUserId: args.actorUserId,
    at: Date.now(),
    changes,
    ...(note ? { note } : {}),
  });
}

/**
 * Append one immutable pledge-lifecycle event. `actorUserId` ABSENT means a
 * SYSTEM/billing transition (Stripe webhook, invoice cycle) — the read renders
 * "System". Written on EVERY status transition (manual + system) and per manual
 * field edit, so the backer timeline is complete.
 */
export async function writePledgeEvent(
  ctx: MutationCtx,
  args: {
    pledgeId: Id<"pledges">;
    scope: GivingScope;
    kind: PledgeEventKind;
    from?: string;
    to?: string;
    actorUserId?: Id<"users">;
    note?: string;
  },
): Promise<void> {
  const note = args.note?.trim() || undefined;
  await ctx.db.insert("pledgeEvents", {
    pledgeId: args.pledgeId,
    scope: args.scope,
    at: Date.now(),
    kind: args.kind,
    ...(args.from !== undefined ? { from: args.from } : {}),
    ...(args.to !== undefined ? { to: args.to } : {}),
    ...(args.actorUserId ? { actorUserId: args.actorUserId } : {}),
    ...(note ? { note } : {}),
  });
}
