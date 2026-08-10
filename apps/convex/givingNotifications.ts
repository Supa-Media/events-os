/**
 * Giving notification rules — the desk's CRUD, and the IMMEDIATE send path.
 *
 * The digest half lives in `givingNotificationDigests.ts`; the pure matching
 * and clock arithmetic in `lib/givingNotificationRules.ts`; the templates in
 * `lib/givingNotificationEmails.ts`.
 *
 * ── THE IMMEDIATE SEND MUST NOT BE ABLE TO COST A GIFT ─────────────────────
 * `lib/givingDonors.ts#recordGiftForDonor` — the single write path for gifts —
 * ends with `ctx.scheduler.runAfter(0, …, notifyGiftRecorded)`. Scheduling is
 * a database write inside the same transaction; the ACTION runs afterwards, in
 * its own context, once the gift has committed. So a Resend outage, a rate
 * limit, a malformed address, or an unhandled throw in here fails the
 * notification and nothing else. The gift is already banked. There is no
 * arrangement where an email can roll back money.
 *
 * The converse is also true and deliberate: if the gift transaction rolls back
 * for its own reasons, the scheduled job rolls back with it, so nobody is told
 * about a gift that doesn't exist.
 *
 * ── ELIGIBILITY IS TOTAL ───────────────────────────────────────────────────
 * Every gift `recordGiftForDonor` writes is a candidate — including a gift
 * bundled into a ticket purchase (which settles `donations` → gift) and an
 * in-kind gift. Nothing is filtered out by KIND; a rule narrows by book and by
 * amount and by nothing else. `giftProvenance` labels how each one arrived so
 * an in-kind gift can't be mistaken for cash in the bank.
 *
 * ── SOFT DEACTIVATE, NEVER DELETE ──────────────────────────────────────────
 * A rule that mailed a team for six months is a record of who was told what.
 * `setRuleActive` turns it off. There is no delete mutation, matching the rest
 * of the giving desk (`sponsorPackages.active`).
 */
import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireUserId } from "./lib/context";
import {
  canManageGivingScope,
  canViewGivingScope,
  requireGivingManage,
  resolveGivingAccess,
  type GivingScope,
} from "./lib/givingAccess";
import { givingNotificationScope } from "./schema/givingNotifications";
import {
  MAX_RULE_RECIPIENTS,
  MAX_RULES,
  normalizeRecipients,
  ruleMatchesGift,
  type RuleScope,
} from "./lib/givingNotificationRules";
import {
  buildNotificationGift,
  ruleScopeLabel,
} from "./lib/givingNotificationContext";
import { renderImmediateGiftEmail } from "./lib/givingNotificationEmails";
import { sendEmail } from "./ticketingEmails";

/**
 * The scope a rule is GATED on. `"all"` reaches every book, so managing one
 * needs the same central reach `"central"` does — a chapter treasurer must not
 * be able to point an org-wide firehose at their own inbox.
 */
export function ruleGateScope(scope: RuleScope): GivingScope {
  return scope === "all" ? "central" : scope;
}

const cadenceValidator = v.union(
  v.literal("immediate"),
  v.literal("daily"),
  v.literal("weekly"),
);

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every rule the caller can see, newest first, each with its book's display
 * name. Includes INACTIVE rules — the desk has to be able to see and
 * reactivate what it turned off.
 */
export const listRules = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveGivingAccess(ctx);
    const rows = await ctx.db.query("givingNotificationRules").take(MAX_RULES);
    const visible = rows.filter((r) =>
      canViewGivingScope(access, ruleGateScope(r.scope)),
    );
    visible.sort((a, b) => b.createdAt - a.createdAt);
    return await Promise.all(
      visible.map(async (r) => ({
        _id: r._id,
        name: r.name,
        recipients: r.recipients,
        cadence: r.cadence,
        minAmountCents: r.minAmountCents,
        scope: r.scope,
        scopeLabel: await ruleScopeLabel(ctx, r.scope),
        isActive: r.isActive,
        sendHourLocal: r.sendHourLocal,
        sendWeekday: r.sendWeekday,
        lastSentAt: r.lastSentAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        canManage: canManageGivingScope(access, ruleGateScope(r.scope)),
      })),
    );
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

function assertHour(hour: number | undefined): void {
  if (hour === undefined) return;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ConvexError({
      code: "INVALID_SEND_HOUR",
      message: "The send hour must be a whole number from 0 to 23.",
    });
  }
}

function assertWeekday(weekday: number | undefined): void {
  if (weekday === undefined) return;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new ConvexError({
      code: "INVALID_SEND_WEEKDAY",
      message: "The send weekday must be 0 (Sunday) through 6 (Saturday).",
    });
  }
}

function assertFloor(minAmountCents: number | undefined): void {
  if (minAmountCents === undefined) return;
  if (!Number.isInteger(minAmountCents) || minAmountCents < 0) {
    throw new ConvexError({
      code: "INVALID_MIN_AMOUNT",
      message: "The minimum amount must be a whole number of cents, at least 0.",
    });
  }
}

/**
 * Create or edit a rule — the `savePackage` shape: an OPTIONAL id, absent for
 * a create. Gated on the rule's OWN scope, and on a scope CHANGE the caller
 * needs manage rights on both the old and the new one, or moving a chapter
 * rule to `"all"` would be a privilege escalation with extra steps.
 */
export const saveRule = mutation({
  args: {
    ruleId: v.optional(v.id("givingNotificationRules")),
    name: v.string(),
    recipients: v.array(v.string()),
    cadence: cadenceValidator,
    minAmountCents: v.optional(v.number()),
    scope: givingNotificationScope,
    sendHourLocal: v.optional(v.number()),
    sendWeekday: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
  },
  returns: v.id("givingNotificationRules"),
  handler: async (ctx, args): Promise<Id<"givingNotificationRules">> => {
    await requireGivingManage(ctx, ruleGateScope(args.scope));
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const name = args.name.trim();
    if (!name) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A rule needs a name.",
      });
    }

    const { recipients, invalid } = normalizeRecipients(args.recipients);
    if (invalid.length > 0) {
      throw new ConvexError({
        code: "INVALID_RECIPIENT",
        message: `That doesn't look like an email address: ${invalid.join(", ")}`,
      });
    }
    if (recipients.length === 0) {
      throw new ConvexError({
        code: "NO_RECIPIENTS",
        message: "A rule needs at least one email address to send to.",
      });
    }
    if (recipients.length > MAX_RULE_RECIPIENTS) {
      throw new ConvexError({
        code: "TOO_MANY_RECIPIENTS",
        message: `A rule may send to at most ${MAX_RULE_RECIPIENTS} addresses.`,
      });
    }

    assertFloor(args.minAmountCents);
    assertHour(args.sendHourLocal);
    assertWeekday(args.sendWeekday);

    if (args.scope !== "all" && args.scope !== "central") {
      const chapter = await ctx.db.get(args.scope);
      if (!chapter) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That chapter doesn't exist.",
        });
      }
    }

    const now = Date.now();
    const fields = {
      name,
      recipients,
      cadence: args.cadence,
      minAmountCents: args.minAmountCents,
      scope: args.scope,
      sendHourLocal: args.sendHourLocal,
      sendWeekday: args.sendWeekday,
      updatedAt: now,
    };

    if (args.ruleId) {
      const existing = await ctx.db.get(args.ruleId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That rule doesn't exist.",
        });
      }
      // A move needs rights on where it's LEAVING too — otherwise a chapter
      // manager could re-point someone else's central rule at their own book.
      if (existing.scope !== args.scope) {
        await requireGivingManage(ctx, ruleGateScope(existing.scope));
      }
      await ctx.db.patch(args.ruleId, {
        ...fields,
        isActive: args.isActive ?? existing.isActive,
      });
      return args.ruleId;
    }

    return await ctx.db.insert("givingNotificationRules", {
      ...fields,
      isActive: args.isActive ?? true,
      createdBy: userId,
      createdAt: now,
    });
  },
});

/** Turn a rule on or off. The only "delete" this table has — see the module
 *  doc. Idempotent. */
export const setRuleActive = mutation({
  args: {
    ruleId: v.id("givingNotificationRules"),
    isActive: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { ruleId, isActive }) => {
    const rule = await ctx.db.get(ruleId);
    if (!rule) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That rule doesn't exist.",
      });
    }
    await requireGivingManage(ctx, ruleGateScope(rule.scope));
    await ctx.db.patch(ruleId, { isActive, updatedAt: Date.now() });
    return null;
  },
});

// ── The immediate path ───────────────────────────────────────────────────────

/** Every ACTIVE immediate rule this gift satisfies, plus the gift's own facts.
 *  `null` when the gift or its donor is gone (a delete or a merge raced us). */
export const immediateTargets = internalQuery({
  args: { giftId: v.id("gifts") },
  handler: async (ctx, { giftId }) => {
    const gift = await ctx.db.get(giftId);
    if (!gift) return null;

    const rules: Doc<"givingNotificationRules">[] = await ctx.db
      .query("givingNotificationRules")
      .withIndex("by_cadence", (q) => q.eq("cadence", "immediate"))
      .take(MAX_RULES);
    const matched = rules.filter((r) => ruleMatchesGift(r, gift));
    if (matched.length === 0) return null;

    const payload = await buildNotificationGift(ctx, gift);
    if (!payload) return null;

    return {
      gift: payload,
      rules: matched.map((r) => ({ name: r.name, recipients: r.recipients })),
    };
  },
});

/**
 * Mail every immediate rule that cares about one gift. Scheduled from
 * `recordGiftForDonor`; see the module doc for why it can never block a gift.
 *
 * Best effort PER RECIPIENT: one bad address must not cost the other three
 * people their notification, the same posture `cards.ts#sendCodingReviewReminders`
 * takes. A missing Resend key degrades to a logged no-op inside `sendEmail`.
 */
export const notifyGiftRecorded = internalAction({
  args: { giftId: v.id("gifts") },
  returns: v.object({ emailsSent: v.number() }),
  handler: async (ctx, { giftId }): Promise<{ emailsSent: number }> => {
    const targets = await ctx.runQuery(
      internal.givingNotifications.immediateTargets,
      { giftId },
    );
    if (!targets) return { emailsSent: 0 };

    let emailsSent = 0;
    for (const rule of targets.rules) {
      const { subject, html } = renderImmediateGiftEmail({
        ruleName: rule.name,
        gift: targets.gift,
      });
      for (const to of rule.recipients) {
        try {
          await sendEmail(ctx, { to, subject, html });
          emailsSent++;
        } catch (err) {
          console.error(
            `[givingNotifications] immediate send failed for ${to}`,
            err,
          );
        }
      }
    }
    return { emailsSent };
  },
});
