/**
 * Notification-rule AUDIT primitives — `lib/giftAudit.ts`'s shape applied to
 * the row that decides who reads donor names and gift amounts in their inbox.
 *
 * A rule is the one thing on the giving desk that goes on ACTING after the
 * person who wrote it is gone: the send paths bound each email by the RULE's
 * scope and never re-check any caller's access, because a cron has no caller.
 * So the record of who aimed a mailer where has to be kept at write time or not
 * at all. `givingNotificationRules.updatedBy` answers "who touched this last";
 * these rows answer "and what did they do", and survive the next edit —
 * a single field is overwritten by exactly the person you would want to catch.
 *
 * The diff is pre-formatted for display ("$500.00", "New York", a joined
 * recipient list) so the read path is a dumb render, exactly like `giftAudit`.
 */
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import type { GIVING_NOTIFICATION_RULE_AUDIT_ACTIONS } from "../schema/givingNotifications";
import type { RuleScope } from "./givingNotificationRules";
import { auditCents } from "./giftAudit";

/** Derived from the schema union so a new literal can't drift out of sync. */
export type RuleAuditAction =
  (typeof GIVING_NOTIFICATION_RULE_AUDIT_ACTIONS)[number];

/** One display-ready field change. `from`/`to` are already stringified. */
export interface RuleFieldChange {
  field: string;
  from?: string;
  to?: string;
}

/**
 * A rule's auditable state, with the scope already resolved to its label.
 *
 * The label is passed in rather than looked up here so the diff stays PURE and
 * testable — `ruleScopeLabel` needs a `ctx`, and the caller has one.
 */
export interface RuleSnapshot {
  name: string;
  recipients: readonly string[];
  cadence: string;
  minAmountCents?: number;
  scopeLabel: string;
  sendHourLocal?: number;
  sendWeekday?: number;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "Every gift" reads better than "$0.00" and is what the desk itself says. */
function floorLabel(minAmountCents: number | undefined): string {
  return minAmountCents === undefined || minAmountCents === 0
    ? "Every gift"
    : `${auditCents(minAmountCents)}+`;
}

function hourLabel(hour: number | undefined): string {
  if (hour === undefined) return "—";
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:00 ${suffix} ET`;
}

function weekdayLabel(weekday: number | undefined): string {
  if (weekday === undefined) return "—";
  return WEEKDAYS[weekday] ?? String(weekday);
}

/**
 * What changed between two states of a rule, display-ready.
 *
 * RECIPIENTS are diffed in full, not summarized as "recipients changed" —
 * "who did this start mailing" is the entire question this trail exists to
 * answer, and a count would hide a swap. The schedule fields are folded into
 * one `Schedule` line because they are meaningless apart from the cadence and
 * a reader thinks of them as one setting.
 */
export function diffRule(
  before: RuleSnapshot,
  after: RuleSnapshot,
): RuleFieldChange[] {
  const changes: RuleFieldChange[] = [];
  const add = (field: string, from: string, to: string) => {
    if (from !== to) changes.push({ field, from, to });
  };

  add("Name", before.name, after.name);
  add("Recipients", before.recipients.join(", "), after.recipients.join(", "));
  add("Cadence", before.cadence, after.cadence);
  add("Minimum", floorLabel(before.minAmountCents), floorLabel(after.minAmountCents));
  // The one that matters most for containment: a rule moving between books
  // changes which gifts it can ever see.
  add("Book", before.scopeLabel, after.scopeLabel);
  add(
    "Schedule",
    `${weekdayLabel(before.sendWeekday)} ${hourLabel(before.sendHourLocal)}`,
    `${weekdayLabel(after.sendWeekday)} ${hourLabel(after.sendHourLocal)}`,
  );

  return changes;
}

/**
 * Append one immutable breadcrumb. Drops an empty `changes` so a bare
 * `created` / `activated` row stays minimal. Called AFTER the rule write
 * succeeds, inside the same mutation — Convex mutations are transactional, so
 * a row exists iff the change committed.
 */
export async function writeRuleAudit(
  ctx: MutationCtx,
  args: {
    ruleId: Id<"givingNotificationRules">;
    /** The rule's scope at the time of the change — for an edit that MOVES a
     *  rule, the book it was leaving. */
    scope: RuleScope;
    actorUserId: Id<"users">;
    action: RuleAuditAction;
    changes?: RuleFieldChange[];
    at: number;
  },
): Promise<void> {
  const changes = (args.changes ?? []).filter(
    (c) => c.from !== undefined || c.to !== undefined,
  );
  await ctx.db.insert("givingNotificationRuleAudit", {
    ruleId: args.ruleId,
    scope: args.scope,
    actorUserId: args.actorUserId,
    at: args.at,
    action: args.action,
    ...(changes.length > 0 ? { changes } : {}),
  });
}
