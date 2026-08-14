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
 * ── A NEW BACKER IS THE SECOND THING A RULE ANNOUNCES ──────────────────────
 * Somebody starting a recurring monthly pledge fires an immediate email of its
 * own (`notifyBackerSignup`), scheduled once per pledge from
 * `givingPledges.claimBackerAnnouncement`. It is deliberately NOT modelled as a
 * gift: the first month's money already arrives as one, and a commitment and an
 * arrival are added up differently.
 *
 * The one place the two paths judge differently is the FLOOR, and it is the
 * point of the feature: a signup is tested at its ANNUAL value
 * (`ruleMatchesBackerSignup`), because a $50/month backer is a $600 decision
 * and every floor the desk actually sets would otherwise let the most important
 * event on the giving desk pass in silence. Everything else — scope, the
 * one-email-per-person fan-out, `lastDeliveredAt`, the failure posture — is the
 * same machinery, deliberately.
 *
 * ── SOFT DEACTIVATE, NEVER DELETE ──────────────────────────────────────────
 * A rule that mailed a team for six months is a record of who was told what.
 * `setRuleActive` turns it off. There is no delete mutation, matching the rest
 * of the giving desk (`sponsorPackages.active`).
 *
 * ── A RULE IS GATED ON GIVING *VIEW*, NOT GIVING MANAGE ────────────────────
 * Reads and writes alike — `listRules`, `saveRule`, `setRuleActive` — ask
 * `canManageRuleScope`, which is `giving.view` of the rule's own book. See that
 * function for the whole argument; the short version is that it was
 * `giving.manage`, no chapter seat carries `giving.manage`, and the effect was
 * that a chapter director watched their own book's mailer misfire with no way
 * to switch it off. The owner's call, 2026-08-10.
 */
import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireUserId } from "./lib/context";
import {
  canViewGivingScope,
  requireGivingView,
  resolveGivingAccess,
  type GivingAccess,
  type GivingScope,
} from "./lib/givingAccess";
import { givingNotificationScope } from "./schema/givingNotifications";
import {
  MAX_RULE_RECIPIENTS,
  MAX_RULES,
  firstRunDayKey,
  normalizeRecipients,
  ruleMatchesBackerSignup,
  ruleMatchesGift,
  type RuleScope,
} from "./lib/givingNotificationRules";
import {
  buildNotificationBacker,
  buildNotificationGift,
  ruleScopeLabel,
} from "./lib/givingNotificationContext";
import {
  diffRule,
  writeRuleAudit,
  type RuleSnapshot,
} from "./lib/givingNotificationAudit";
import {
  renderBackerSignupEmail,
  renderImmediateGiftEmail,
} from "./lib/givingNotificationEmails";
import { sendEmailReporting } from "./ticketingEmails";

/**
 * The giving scope a rule is GATED on. `"all"` reaches every book, so touching
 * one needs the same central reach `"central"` does — a chapter treasurer must
 * not be able to point an org-wide firehose at their own inbox.
 */
export function ruleGateScope(scope: RuleScope): GivingScope {
  return scope === "all" ? "central" : scope;
}

/**
 * Whether `access` may SEE, CREATE, EDIT or PAUSE a rule scoped to `scope`.
 * The one predicate every rule surface asks — the list, the three mutations,
 * and (transitively) the screen's book picker.
 *
 * ── IT IS THE *VIEW* GATE, DELIBERATELY. OWNER'S CALL, 2026-08-10 ──────────
 * The writes used to ask `requireGivingManage` — the same gate that guards
 * writing a gift or a donor. That reads well on paper and was wrong in
 * practice: NO seat on the chapter chart carries `giving.manage` (chapter
 * director is `giving.view` + `nav.giving` and nothing more), so against the
 * shipped seat chart the manage gate resolved to "central and superusers,
 * nobody else". A chapter director could watch their own book's rules sit in a
 * read-only list and could not touch one of them — including turning off a
 * mailer that was reaching the wrong people. The owner settled it plainly:
 * "You should allow anybody with access to giving to do the notifications.
 * That's fine."
 *
 * If you have arrived here to put `canManageGivingScope` back: please don't.
 * This is the decision, not an oversight it survived.
 *
 * ── WHO THIS ACTUALLY ENFRANCHISED ─────────────────────────────────────────
 * `chapter_director` is the seat the argument above is told through, but it is
 * not the biggest part of the population and reading only that story would
 * understate this. `canViewGivingScope` SHORT-CIRCUITS on central view, so a
 * central `giving.view` holder reaches every book — including `"all"`. Three
 * central seats hold `giving.view` without `giving.manage`
 * (`packages/shared/src/seats.ts`):
 *   - `partnership_associate` — multi-holder
 *   - `fundraising_associate`  — multi-holder
 *   - `expansion_director`     — single, and its `giving.view` is itself
 *     toggleable at runtime by the ED (`seats.ts#setSeatGivingPower`)
 * Each of them can now author a `scope: "all"`, `cadence: "immediate"` rule to
 * ANY address, including an external one. That is in-reach by design and it is
 * what the owner asked for — a rule can only forward gift summaries its author
 * could already read — but it is the honest size of the change, and the two
 * multi-holder seats mean it is not a fixed number of people.
 *
 * What makes the loosening safe is that it widened WHICH CAPABILITY opens a
 * book, never WHICH BOOKS a capability opens. Containment is untouched:
 *  - `ruleGateScope` still routes `"all"` through `"central"`, so org-wide
 *    reach still needs central reach.
 *  - `canViewGivingScope` still refuses `"central"` to a chapter holder, and
 *    still admits only the chapters they actually hold.
 *  - a scope CHANGE is still checked against the book it LEAVES as well as the
 *    one it joins (`saveRule`), so a rule can't be walked between books a step
 *    at a time.
 * And note the ceiling on what a rule can do, which is why view is the right
 * level: it emails a summary of gifts you can already read, to addresses you
 * name. It moves no money, edits no gift, and discloses no book you had no
 * reach into.
 *
 * One consequence worth stating out loud: because visibility and manageability
 * now ask the identical question, every row `listRules` returns comes back with
 * `canManage: true`. The field stays — it is what keeps the affordance a
 * property of the ROW rather than of the screen, so re-narrowing this gate one
 * day is a change to this function and nothing else.
 */
export function canManageRuleScope(
  access: GivingAccess,
  scope: RuleScope,
): boolean {
  return canViewGivingScope(access, ruleGateScope(scope));
}

/**
 * Assert the caller may create/edit/pause a rule at `scope`, else throw. The
 * `require` twin of `canManageRuleScope` — same question, one shape throws.
 *
 * ── WHY THIS PAIR ISN'T IN `lib/givingAccess.ts` ───────────────────────────
 * CLAUDE.md's convention is that a domain's `has`/`require` pair lives in
 * `lib/<domain>Access.ts`, and giving's does: `canViewGivingScope` /
 * `requireGivingView` over `GivingScope`. This pair is NOT a second opinion
 * about giving — it is a thin composition of that one, translating a
 * NOTIFICATION concept (`RuleScope`, the three-way union with `"all"`) into the
 * domain's two-way scope and asking the domain resolver. Moving it into
 * `givingAccess.ts` would put the notification scope union inside the donor-CRM
 * gate, which is the direction the dependency should not run — the giving desk
 * has no business knowing that a mailer exists. The rule that actually matters
 * is upheld: there is exactly one `require` form, every call site uses it, and
 * nothing here checks a seat inline.
 */
export async function requireRuleManage(
  ctx: QueryCtx,
  scope: RuleScope,
): Promise<GivingAccess> {
  return await requireGivingView(ctx, ruleGateScope(scope));
}

/** A rule's auditable state with its book resolved to a label, ready for
 *  `diffRule`. The one `ctx` touch the diff itself deliberately doesn't make. */
async function snapshotRule(
  ctx: QueryCtx,
  rule: {
    name: string;
    recipients: readonly string[];
    cadence: string;
    minAmountCents?: number;
    scope: RuleScope;
    sendHourLocal?: number;
    sendWeekday?: number;
  },
): Promise<RuleSnapshot> {
  return {
    name: rule.name,
    recipients: rule.recipients,
    cadence: rule.cadence,
    minAmountCents: rule.minAmountCents,
    scopeLabel: await ruleScopeLabel(ctx, rule.scope),
    sendHourLocal: rule.sendHourLocal,
    sendWeekday: rule.sendWeekday,
  };
}

const cadenceValidator = v.union(
  v.literal("immediate"),
  v.literal("daily"),
  v.literal("weekly"),
);

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Resolve a user id to something a human recognises — profile name, else the
 * account email, else "Someone". The same fallback chain
 * `givingPlatform.giftDetail` uses for its audit actors, and memoized across
 * the list so ten rules touched by one person cost one pair of reads.
 */
async function actorName(
  ctx: QueryCtx,
  cache: Map<string, string>,
  userId: Id<"users">,
): Promise<string> {
  const hit = cache.get(userId);
  if (hit !== undefined) return hit;
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  let name = profile?.name;
  if (!name) {
    const user = await ctx.db.get(userId);
    name = user?.email ?? "Someone";
  }
  cache.set(userId, name);
  return name;
}

/**
 * Every rule the caller can see, newest first, each with its book's display
 * name. Includes INACTIVE rules — the desk has to be able to see and
 * reactivate what it turned off.
 *
 * Each row also names WHO LAST TOUCHED IT. That is not decoration: a rule
 * quietly re-pointed at somebody's personal inbox goes on mailing donor names
 * and gift amounts under the original author's name until somebody notices, and
 * "who set this up" was the only question the desk could answer before. The
 * immutable trail is `givingNotificationRuleAudit`; this is the glance.
 */
export const listRules = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveGivingAccess(ctx);
    // NEWEST first, through the index. An unindexed `.take()` returned the
    // OLDEST rows and sorted them afterwards, so past the cap a freshly
    // created rule was invisible in the UI — and therefore impossible to
    // deactivate — while it carried on sending. Invisible-but-active is the
    // worst combination a mailer has. `saveRule` also refuses to create past
    // `MAX_RULES`, so the cap can't be reached at all.
    const rows = await ctx.db
      .query("givingNotificationRules")
      .withIndex("by_createdAt")
      .order("desc")
      .take(MAX_RULES);
    const visible = rows.filter((r) => canManageRuleScope(access, r.scope));
    const names = new Map<string, string>();
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
        // Both, and they are not interchangeable — the desk shows
        // `lastDeliveredAt` as "last sent" and `lastSentAt` only as the point
        // it is reporting FROM. See the schema doc for why one field couldn't
        // be both.
        lastDeliveredAt: r.lastDeliveredAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        // Who last CHANGED it, not who created it. `null` only for a rule
        // written before the field existed — every write path sets it now.
        updatedByName: r.updatedBy
          ? await actorName(ctx, names, r.updatedBy)
          : null,
        // True for every row here, because the filter above asks the same
        // question — see `canManageRuleScope` for why the field stays anyway.
        canManage: canManageRuleScope(access, r.scope),
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
 * a create. Gated on the rule's OWN scope (`canManageRuleScope` — giving VIEW
 * of that book), and on a scope CHANGE the caller needs rights on both the old
 * and the new one, or moving a chapter rule to `"all"` would be a privilege
 * escalation with extra steps.
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
    await requireRuleManage(ctx, args.scope);
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
      // holder could re-point someone else's central rule at their own book.
      if (existing.scope !== args.scope) {
        await requireRuleManage(ctx, existing.scope);
      }
      // A CADENCE CHANGE RESETS THE MARKS, for the same reason reactivation
      // does. `daily → immediate → daily` otherwise reached the dormant replay
      // by another door: the watermark sat where the last daily digest left it,
      // however many weeks of `immediate` ago that was, and the first digest
      // back mailed the lot. Scope and threshold changes deliberately do NOT
      // reset — they narrow the same stream, and the window is still honest.
      const cadenceChanged = existing.cadence !== args.cadence;
      // …AND SO DOES A RESUME THROUGH THIS DOOR. `isActive` is settable here,
      // not only through `setRuleActive`, so a rule could be switched off for
      // three months and switched back on by an edit — reaching the dormant
      // replay by a THIRD door, past the guard that was written for the other
      // two. Not reachable from the desk UI (which resumes via the switch), but
      // this is a public mutation and the UI is not the contract.
      const resuming = args.isActive === true && !existing.isActive;
      const freshBoundary = cadenceChanged || resuming;
      await ctx.db.patch(args.ruleId, {
        ...fields,
        // WHO TOUCHED IT LAST. `createdBy` is not that, and saying so was a
        // misattribution the moment anyone but the author could edit — a rule
        // re-pointed at a personal inbox still named the development director.
        updatedBy: userId,
        isActive: args.isActive ?? existing.isActive,
        ...(freshBoundary
          ? {
              lastSentAt: now,
              lastRunDayKey: firstRunDayKey(fields, now),
              // `now` is a SYNTHETIC boundary — nothing was reported at this
              // instant — so the flag comes off and the first window back gets
              // its full trailing-period floor. Leaving a run's `true` on it
              // would pin that window to this instant and mail an empty sliver.
              watermarkFromRun: undefined,
            }
          : {}),
      });
      // The breadcrumb, stamped with the scope it was LEAVING, so a move reads
      // "this was New York's, and here it is becoming central's". Same
      // transaction as the patch, so a row exists iff the edit committed.
      await writeRuleAudit(ctx, {
        ruleId: args.ruleId,
        scope: existing.scope,
        actorUserId: userId,
        action: "edited",
        changes: diffRule(
          await snapshotRule(ctx, existing),
          await snapshotRule(ctx, { ...existing, ...fields }),
        ),
        at: now,
      });
      return args.ruleId;
    }

    // Every read of this table is bounded at `MAX_RULES`, so a rule written
    // past the cap would be one nothing lists, nothing matches, and nobody can
    // turn off. Refuse at the door instead.
    const existingCount = (
      await ctx.db.query("givingNotificationRules").take(MAX_RULES)
    ).length;
    if (existingCount >= MAX_RULES) {
      throw new ConvexError({
        code: "TOO_MANY_RULES",
        message: `There are already ${MAX_RULES} notification rules. Deactivate or reuse one instead of adding another.`,
      });
    }

    const ruleId = await ctx.db.insert("givingNotificationRules", {
      ...fields,
      isActive: args.isActive ?? true,
      // A rule written AFTER its send moment today would otherwise be due
      // immediately, against a window that opens at its own birth — an empty
      // one. On a weekly rule that reads as a confident "No giving this week"
      // about a week nobody was watching. See `firstRunDayKey`.
      lastRunDayKey: firstRunDayKey(fields, now),
      createdBy: userId,
      // Equal to `createdBy` at birth, and set anyway so the field is never
      // absent on a rule this deployment wrote — an absent `updatedBy` then
      // means exactly one thing: "written before the field existed".
      updatedBy: userId,
      createdAt: now,
    });
    await writeRuleAudit(ctx, {
      ruleId,
      scope: args.scope,
      actorUserId: userId,
      action: "created",
      at: now,
    });
    return ruleId;
  },
});

/**
 * Turn a rule on or off. The only "delete" this table has — see the module
 * doc. Idempotent.
 *
 * REACTIVATION MOVES THE WATERMARK TO NOW, AND MARKS IT SYNTHETIC. A digest
 * rule turned off for three months would otherwise come back and mail one
 * digest covering three months of donor records, because `lastSentAt` still
 * pointed at the last send before it was switched off. Turning something back
 * on means "tell me what happens from here", not "catch me up on everything I
 * chose not to be told".
 *
 * `watermarkFromRun` is cleared alongside, and the pair is what makes the
 * resumed rule's first digest a REAL one. The stamp bounds how far back it may
 * look (one period, never the dormant stretch); clearing the flag says nothing
 * was actually reported at this instant, so `digestWindowStart` is free to
 * reach that full period back rather than opening the window at this very
 * moment and mailing an empty sliver. Neither half works without the other.
 *
 * Clearing `lastSentAt` instead of stamping it is a third option and the wrong
 * one: it would land in `digestWindowStart`'s never-reported case, which is
 * also bounded at one period — the same answer, but reached by claiming the
 * rule has never reported anything, which stops being true the moment somebody
 * reads the field.
 */
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
    await requireRuleManage(ctx, rule.scope);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    const reactivating = isActive && !rule.isActive;
    const flipped = rule.isActive !== isActive;
    await ctx.db.patch(ruleId, {
      isActive,
      // Pausing and resuming a mailer is a change to who hears about money, so
      // it names its actor like every other edit does.
      updatedBy: userId,
      updatedAt: now,
      ...(reactivating
        ? {
            lastSentAt: now,
            // NOT cleared. Moving the watermark to `now` and clearing the run
            // mark meant a rule reactivated after its send hour was due at
            // once, against a window that opens at that same instant — so its
            // one possible outcome was a false "No giving this week". Which is
            // reachable straight from the practice of switching rules off
            // around an import.
            lastRunDayKey: firstRunDayKey(rule, now),
            // The other half of the stamp — see the doc above. Synthetic
            // boundary, so the first digest back covers its trailing period,
            // and because the watermark is `now` it covers no more than that.
            watermarkFromRun: undefined,
          }
        : {}),
    });
    // Only a real flip earns a breadcrumb. This mutation is idempotent by
    // design (the switch fires on every render of a row), and a trail padded
    // with no-op rows is a trail nobody reads.
    if (flipped) {
      await writeRuleAudit(ctx, {
        ruleId,
        scope: rule.scope,
        actorUserId: userId,
        action: isActive ? "activated" : "deactivated",
        at: now,
      });
    }
    return null;
  },
});

/**
 * Stamp "an email from this rule reached somebody, at this instant".
 *
 * The ONLY writer of `lastDeliveredAt`, called from both send paths (the
 * immediate action here, and the digest sweep) once `sendEmailReporting` has
 * returned true for at least one recipient. Deliberately separate from every
 * mark `claimDigest` moves: those are decided BEFORE the mail is attempted and
 * a released digest puts them back, whereas this can only ever be written
 * after the fact, and is never rolled back.
 *
 * Does NOT touch `updatedAt` — nobody edited the rule, it just did its job, and
 * moving `updatedAt` would make every send look like a configuration change.
 */
export const markRulesDelivered = internalMutation({
  args: {
    ruleIds: v.array(v.id("givingNotificationRules")),
    at: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { ruleIds, at }) => {
    for (const ruleId of ruleIds) {
      // A rule deleted (or, today, merely absent) between the send and this
      // stamp is not worth failing a delivery that already happened over.
      const rule = await ctx.db.get(ruleId);
      if (!rule) continue;
      await ctx.db.patch(ruleId, { lastDeliveredAt: at });
    }
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

    return { gift: payload, sends: sendsByRecipient(matched) };
  },
});

/**
 * ONE EMAIL PER PERSON, not one per rule.
 *
 * The two patterns the owner described — "every gift, to the dev team" and
 * "gifts over $500, to Shay and AJ" — overlap on purpose, and anyone on both
 * would have got the same gift twice. "We're getting double emails" is the
 * complaint that gets a notification feature switched off, so the send is keyed
 * on the RECIPIENT and the footer names every rule that reached them.
 *
 * Shared by both immediate paths (a gift, and a new backer) so the two can
 * never disagree about how a person on three rules is treated.
 */
function sendsByRecipient(
  matched: readonly Doc<"givingNotificationRules">[],
): {
  to: string;
  ruleNames: string[];
  ruleIds: Id<"givingNotificationRules">[];
}[] {
  const byRecipient = new Map<
    string,
    { ruleNames: string[]; ruleIds: Id<"givingNotificationRules">[] }
  >();
  for (const rule of matched) {
    for (const to of rule.recipients) {
      const entry = byRecipient.get(to) ?? { ruleNames: [], ruleIds: [] };
      // Names are de-duplicated for the FOOTER — two rules that happen to
      // share a name shouldn't print it twice. Ids are collected separately
      // and de-duplicated on their own, because two rules that share a name
      // are still two rules and both of them just delivered.
      if (!entry.ruleNames.includes(rule.name)) entry.ruleNames.push(rule.name);
      if (!entry.ruleIds.includes(rule._id)) entry.ruleIds.push(rule._id);
      byRecipient.set(to, entry);
    }
  }
  return [...byRecipient.entries()].map(([to, entry]) => ({
    to,
    ruleNames: entry.ruleNames,
    ruleIds: entry.ruleIds,
  }));
}

/**
 * Every ACTIVE immediate rule that cares about one NEW BACKER, plus the
 * signup's own facts. `null` when the pledge or its donor is gone.
 *
 * The floor is tested against the pledge's ANNUAL value, not its monthly one —
 * see `ruleMatchesBackerSignup`. That is the whole of the owner's ask ("a backer
 * should count as a big gift — in a year a backer is $600"), and it lives in one
 * pure predicate so the pre-filter that decides whether to schedule this at all
 * can ask exactly the same question.
 */
export const backerSignupTargets = internalQuery({
  args: { pledgeId: v.id("pledges") },
  handler: async (ctx, { pledgeId }) => {
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) return null;

    const rules: Doc<"givingNotificationRules">[] = await ctx.db
      .query("givingNotificationRules")
      .withIndex("by_cadence", (q) => q.eq("cadence", "immediate"))
      .take(MAX_RULES);
    const matched = rules.filter((r) => ruleMatchesBackerSignup(r, pledge));
    if (matched.length === 0) return null;

    const payload = await buildNotificationBacker(ctx, pledge);
    if (!payload) return null;

    return { backer: payload, sends: sendsByRecipient(matched) };
  },
});

/**
 * Mail every immediate rule that cares about one new backer. Scheduled from
 * `givingPledges.claimBackerAnnouncement`, in the same transaction that stamps
 * the pledge's one-time `announcedAt` — so it runs exactly once per backer, and
 * (like every send path here) it cannot fail the money that caused it.
 *
 * Best effort PER RECIPIENT, same posture as `notifyGiftRecorded`: one bad
 * address must not cost the rest of the team their notification.
 */
export const notifyBackerSignup = internalAction({
  args: { pledgeId: v.id("pledges") },
  returns: v.object({ emailsSent: v.number() }),
  handler: async (ctx, { pledgeId }): Promise<{ emailsSent: number }> => {
    const targets = await ctx.runQuery(
      internal.givingNotifications.backerSignupTargets,
      { pledgeId },
    );
    if (!targets) return { emailsSent: 0 };

    let emailsSent = 0;
    const delivered = new Set<Id<"givingNotificationRules">>();
    for (const send of targets.sends) {
      // The RENDER is inside the try for the same reason it is in
      // `notifyGiftRecorded`: a throw while building one recipient's email must
      // not cost every later recipient theirs.
      try {
        const { subject, html } = renderBackerSignupEmail({
          ruleName: send.ruleNames.join(", "),
          backer: targets.backer,
        });
        if (await sendEmailReporting(ctx, { to: send.to, subject, html })) {
          emailsSent++;
          for (const ruleId of send.ruleIds) delivered.add(ruleId);
        }
      } catch (err) {
        console.error(
          `[givingNotifications] backer signup send failed for ${send.to}`,
          err,
        );
      }
    }

    if (delivered.size > 0) {
      try {
        await ctx.runMutation(internal.givingNotifications.markRulesDelivered, {
          ruleIds: [...delivered],
          at: Date.now(),
        });
      } catch (err) {
        console.error(
          "[givingNotifications] backer signup delivered, but couldn't stamp lastDeliveredAt",
          err,
        );
      }
    }
    return { emailsSent };
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
    // Rules whose mail actually reached somebody. Union across recipients: a
    // rule mailing four people has done its job if ONE of them was reached, and
    // a rule whose only recipient bounced has not, even when a co-matching rule
    // sharing that gift got through to a different address.
    const delivered = new Set<Id<"givingNotificationRules">>();
    for (const send of targets.sends) {
      // The RENDER is inside the try too. It used to sit outside, one level up
      // in a per-rule loop, so a throw while building recipient #1's email
      // cost every later recipient their notification entirely.
      try {
        const { subject, html } = renderImmediateGiftEmail({
          ruleName: send.ruleNames.join(", "),
          gift: targets.gift,
        });
        // `sendEmailReporting`, not `sendEmail`: the count has to mean
        // DELIVERED, so a deployment with no Resend key reports 0 rather
        // than looking like it mailed everyone.
        if (await sendEmailReporting(ctx, { to: send.to, subject, html })) {
          emailsSent++;
          for (const ruleId of send.ruleIds) delivered.add(ruleId);
        }
      } catch (err) {
        console.error(
          `[givingNotifications] immediate send failed for ${send.to}`,
          err,
        );
      }
    }

    // AFTER the loop, in one mutation, and only for rules that reached
    // somebody. A throw here would be a rule that mailed and doesn't say so —
    // annoying, but the email is already out and a gift must never be able to
    // pay for a bookkeeping failure (see the module doc).
    if (delivered.size > 0) {
      try {
        await ctx.runMutation(internal.givingNotifications.markRulesDelivered, {
          ruleIds: [...delivered],
          at: Date.now(),
        });
      } catch (err) {
        console.error(
          "[givingNotifications] delivered, but couldn't stamp lastDeliveredAt",
          err,
        );
      }
    }
    return { emailsSent };
  },
});
