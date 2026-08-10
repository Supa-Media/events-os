/**
 * The daily / weekly giving digests.
 *
 * ── HOW A RUN WORKS ────────────────────────────────────────────────────────
 * The cron fires HOURLY, on the hour (`crons.ts`), because a rule names the
 * hour it wants in the org's timezone and a single fixed UTC cron can't serve
 * both an 08:00 and an 18:00 subscriber. Each run:
 *
 *   1. `dueDigestRuleIds` (a QUERY) — which rules' moment has arrived. Reads
 *      only the rules table; touches no gifts.
 *   2. `claimDigest` (a MUTATION, ONE PER RULE) — reads that rule's window,
 *      decides whether it sends, moves the marks, and returns the finished
 *      payload.
 *   3. `sendGivingDigests` (the ACTION) — renders and mails, per rule and then
 *      per recipient.
 *
 * ── ONE TRANSACTION PER RULE, AND ONE TRY PER RULE ─────────────────────────
 * Both of those are load-bearing, and both were wrong in the first cut.
 *
 * Claiming every due rule in ONE mutation put every rule's window read in one
 * transaction. The default send hour is 8, so in practice that is *every*
 * daily and weekly rule at once, and Convex caps a transaction at 16,384
 * documents read — nine rules against a full window and the mutation throws,
 * taking down every digest for an hour that will not come round again until
 * tomorrow. Per-rule transactions have no such cliff.
 *
 * Isolating only the `sendEmailReporting` call was the same mistake one level
 * down. A throw in `claimDigest`, or in `renderDigestEmail`, aborted the whole
 * action — and the rules already claimed had moved their watermark and were
 * never mailed. Convex does not retry a failed scheduled action, so that is
 * permanent, silent data loss for every rule after the first failure. Each
 * rule now gets its own `try`, so one bad rule costs exactly itself.
 *
 * ── A PERIOD IS THE MONEY THAT ARRIVED IN IT ───────────────────────────────
 * The window ranges on `gifts.receivedAt`, not on `createdAt`. It used to be
 * the other way round, and that is how a weekly digest came to tell a
 * development team `$9,224.03 from 44 gifts this week` about a week in which
 * $261.00 arrived — 35 of those gifts had been received between Nov 2025 and
 * Mar 2026 and merely written to the ledger that Friday by a historical import.
 *
 * The trade this makes is real and is stated where the code makes it: a gift
 * backdated into a period whose digest has already gone out is in no digest at
 * all. See `collectWindowGifts` for what that does to the cut/resume machinery
 * (short version: still never twice, and rows can now fall out of the chain),
 * and `lib/givingNotificationRules.ts` for why the ledger, not the digest, is
 * where giving history is read.
 *
 * ── THE WINDOW IS FILTERED BEFORE IT IS CAPPED ─────────────────────────────
 * `collectWindowGifts` streams the `by_received` range and applies
 * `ruleMatchesGift` as it goes, so the cap bounds MATCHED gifts, not scanned
 * rows. Capping first was a money bug and a wedge at once: a 5,000-row import
 * made a digest mail a total 60% short, stamp the watermark, and lose the
 * remainder forever — and a chapter-scoped rule whose prefix was all other
 * books matched zero, skipped, declined to stamp, and re-read the same prefix
 * every day thereafter, silently, forever.
 *
 * A cut window is handled honestly rather than hidden: the watermark advances
 * only to the last gift actually read (so the remainder is the NEXT window,
 * not lost), the cut lands on a whole-millisecond boundary (so no gift sharing
 * that instant is skipped or double-counted), the digest SENDS regardless of
 * what it matched (breaking the wedge), and the email says its total is a
 * floor.
 *
 * ── A WEEKLY DIGEST COVERS A WEEK ──────────────────────────────────────────
 * A rule that has never reported anything opens its window at `now − period`
 * exactly, so the first digest off a rule created this morning still covers the
 * trailing seven days — and a rule that has sat watermark-less for six months
 * (an empty daily never stamps one) still covers seven days and not six months.
 * A rule that HAS reported resumes from its watermark exactly, so nothing is
 * mailed twice. `watermarkFromRun` is what distinguishes the two — full
 * reasoning on `digestWindowStart` and in the schema.
 *
 * ── THE ASYMMETRY ──────────────────────────────────────────────────────────
 * An empty DAILY digest is skipped and leaves the WATERMARK alone (it still
 * marks itself run for the day). An empty WEEKLY digest is SENT — "nothing
 * came in this week" is real signal to a fundraising team, and it doubles as
 * proof the pipeline is alive. Reasoning in full in
 * `lib/givingNotificationRules.ts`.
 */
import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { GIFT_TYPE_LABELS, giftMethodLabel, giftType } from "./lib/giftLabels";
import {
  DIGEST_LAG_MS,
  MAX_DIGEST_GIFT_ROWS,
  MAX_RULES,
  cadencePeriodMs,
  digestWindowStart,
  isDigestDue,
  ruleMatchesGift,
  runDayKey,
  shouldSendDigest,
} from "./lib/givingNotificationRules";
import {
  buildNotificationGift,
  ruleScopeLabel,
  scopeLabel,
} from "./lib/givingNotificationContext";
import {
  renderDigestEmail,
  type DigestBreakdownRow,
  type NotificationGift,
} from "./lib/givingNotificationEmails";
import { sendEmailReporting } from "./ticketingEmails";
import { resolveResendSettings } from "./lib/resend";
import { requireRuleManage } from "./givingNotifications";

/**
 * How many MATCHING gifts one digest window will collect before it cuts the
 * window short. Generous against any real period (the whole ledger is in the
 * hundreds) and far below Convex's 16,384-document transaction read limit even
 * with a scan that matches nothing.
 */
export const MAX_DIGEST_MATCHES = 750;

/** Hard bound on rows READ per window, so a rule that matches almost nothing
 *  still can't walk an unbounded range inside one transaction. */
export const MAX_DIGEST_SCAN = 4000;

/** Injectable bounds, so the cut-window machinery — the most intricate code
 *  here — can be tested at its real boundaries without writing thousands of
 *  fixture rows. Production always uses the defaults. */
export type WindowCaps = { maxMatches: number; maxScan: number };
const DEFAULT_CAPS: WindowCaps = {
  maxMatches: MAX_DIGEST_MATCHES,
  maxScan: MAX_DIGEST_SCAN,
};

/** How many rules one hourly sweep will claim. A second sweep an hour later
 *  picks up any remainder — no rule is dropped, the work is just spread. */
const MAX_CLAIMS_PER_RUN = 50;

const DIGEST_CADENCES = ["daily", "weekly"] as const;

type WindowResult = {
  /** Gifts in the window that this rule matches, oldest first. */
  gifts: Doc<"gifts">[];
  /** The read stopped early — totals are a FLOOR and the window was cut. */
  truncated: boolean;
  /** Where the window actually closed. Equals the requested `until` on a
   *  complete read; the last-read gift's `receivedAt` on a cut one. */
  until: number;
};

/**
 * The gifts in `(since, until]` that `rule` matches, on `receivedAt` — when the
 * MONEY ARRIVED. That is what a period means; see the module doc for the
 * $9,224.03-for-a-$261.00-week this replaced.
 *
 * ── THE CUT, ON A KEY THAT IS NOT MONOTONIC ────────────────────────────────
 * The cut/resume design was written when the window ranged on `createdAt`, a
 * key that only ever grows, and moving it to a backdatable one is the riskiest
 * part of that change. What survives and what doesn't, precisely:
 *
 *  • STILL EXACT WITHIN A READ. The index is totally ordered on `receivedAt`,
 *    so a cut at instant B followed by a window opening strictly after B covers
 *    the range once and only once. Draining the whole millisecond still does
 *    the work it always did — several gifts can share a `receivedAt` (an import
 *    of a batch dated one day, a Stripe payout minute), and cutting mid-instant
 *    would skip the stragglers.
 *  • STILL NEVER TWICE. Windows partition the `receivedAt` axis: each opens
 *    where the last closed. No gift can be reported by two digests, cut or not,
 *    which is the property that made the watermark worth keeping.
 *  • WHAT IS LOST: a row can now be INSERTED BEHIND the watermark. Under
 *    `createdAt` that was impossible — new rows only ever appeared ahead of it.
 *    Under `receivedAt` any backdated write (an import, Sunday's cash keyed on
 *    Monday) lands in a stretch already reported, and no window reaches back.
 *    Such a gift is in NO digest. That is the accepted product decision — the
 *    digest is this week's money, the ledger is the history — and it is a
 *    property of the field, not a defect in the cut: no ordering of the read
 *    can report a row that did not exist when the read happened.
 *
 * MID-DRAIN, the same asymmetry has a sharper edge worth knowing: while a large
 * week drains hourly, the watermark sits INSIDE the period, so a late entry
 * dated earlier in that same period is skipped even though the period's digest
 * has not finished. Nothing is double-reported and nothing is wedged; the drain
 * still terminates. It is the same accepted loss, arriving sooner.
 *
 * FILTERS AS IT STREAMS, so both caps bound something meaningful: matches, and
 * rows read.
 */
export async function collectWindowGifts(
  ctx: Pick<MutationCtx, "db">,
  rule: Pick<Doc<"givingNotificationRules">, "isActive" | "scope" | "minAmountCents">,
  since: number,
  until: number,
  caps: WindowCaps = DEFAULT_CAPS,
): Promise<WindowResult> {
  // A SCOPED rule reads only its own book. On the global index a quiet
  // chapter's rule walked every other book's gifts and tripped its scan cap on
  // them, mailing a "cut short" that was true about the read and false about
  // that chapter's giving.
  const stream =
    rule.scope === "all"
      ? ctx.db
          .query("gifts")
          .withIndex("by_received", (q) =>
            q.gt("receivedAt", since).lte("receivedAt", until),
          )
      : ctx.db
          .query("gifts")
          .withIndex("by_scope_and_received", (q) =>
            q
              .eq("scope", rule.scope as Doc<"gifts">["scope"])
              .gt("receivedAt", since)
              .lte("receivedAt", until),
          );

  const gifts: Doc<"gifts">[] = [];
  let scanned = 0;
  let capped = false;
  let boundaryTs = until;
  // TRUNCATION IS "WE STOPPED EARLY", NOT "WE HIT THE CAP". Hitting the cap on
  // the very last row of the range means the window was read in full — calling
  // that truncated mailed a false "cut short" and needlessly held the watermark
  // back.
  let stoppedEarly = false;

  for await (const gift of stream) {
    // Past a cap: keep taking rows that share the boundary instant, then stop.
    // Several gifts can share a `receivedAt` — a batch imported under one date,
    // a payout minute — and the next window opens strictly AFTER the watermark,
    // so cutting mid-instant would skip them and nudging the watermark back
    // would re-report them.
    if (capped && gift.receivedAt !== boundaryTs) {
      stoppedEarly = true;
      break;
    }

    scanned++;
    if (ruleMatchesGift(rule, gift)) gifts.push(gift);

    if (!capped && (gifts.length >= caps.maxMatches || scanned >= caps.maxScan)) {
      capped = true;
      boundaryTs = gift.receivedAt;
    }
  }

  return {
    gifts,
    truncated: stoppedEarly,
    until: stoppedEarly ? boundaryTs : until,
  };
}

/** Which rules' moment has arrived. Rules only — no gift reads, so this can
 *  never approach a transaction limit however many rules exist. */
export const dueDigestRuleIds = internalQuery({
  args: { now: v.optional(v.number()) },
  returns: v.array(v.id("givingNotificationRules")),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const due: Id<"givingNotificationRules">[] = [];
    for (const cadence of DIGEST_CADENCES) {
      const rules = await ctx.db
        .query("givingNotificationRules")
        .withIndex("by_cadence", (q) => q.eq("cadence", cadence))
        .take(MAX_RULES);
      for (const rule of rules) {
        if (isDigestDue(rule, now)) due.push(rule._id);
      }
    }
    return due.slice(0, MAX_CLAIMS_PER_RUN);
  },
});

function addTo(
  rows: Map<string, DigestBreakdownRow>,
  label: string,
  cents: number,
): void {
  const row = rows.get(label) ?? { label, cents: 0, count: 0 };
  row.cents += cents;
  row.count += 1;
  rows.set(label, row);
}

function sortedRows(rows: Map<string, DigestBreakdownRow>): DigestBreakdownRow[] {
  return [...rows.values()].sort((a, b) => b.cents - a.cents);
}

/** A digest that is ready to be rendered and mailed — the window it read, and
 *  the payload built from it. `null` from `buildDigestPayload` means the
 *  window said not to send at all (`shouldSendDigest`). */
type BuiltDigest = {
  /** Where the window ACTUALLY closed — what a claim stamps as the watermark. */
  until: number;
  /** The read stopped early; totals are a floor. */
  truncated: boolean;
  recipients: readonly string[];
  payload: Parameters<typeof renderDigestEmail>[0];
};

/**
 * The exclusive lower bound of the window a MANUAL send covers: exactly the
 * trailing period, ignoring `lastSentAt` and its provenance entirely.
 *
 * ── WHY "SEND NOW" DOESN'T ASK `digestWindowStart` ─────────────────────────
 * The two windows answer two different questions, and only one of them is
 * about a watermark.
 *
 * A SCHEDULED run asks "what has arrived since the last one?" — it is one link
 * in a chain that must not skip a gift or report one twice, so it resumes from
 * the watermark exactly (see `digestWindowStart`, whose three cases exist for
 * precisely that). A MANUAL send asks a different question: "what does a
 * weekly digest look like?" Nobody presses this button wanting a three-hour
 * slice.
 *
 * Which is exactly what the watermark window would give them, in the case the
 * button was built for. The owner's rule ran at 09:00, leaving a
 * report-provenance watermark; he pressed Send now at noon to see his weekly
 * digest and — on the watermark window — would have got a confident, empty
 * three-hour report. That is worse than having no button at all, because it
 * looks like the feature is broken while it is working as specified.
 *
 * ── THIS IS ONLY SAFE BECAUSE THE PREVIEW CONSUMES NOTHING ────────────────
 * Reaching past a watermark would be a serious bug in any path that then moved
 * it — it is the "dormant replay" `digestWindowStart` case 1 is bounded to
 * prevent. It is harmless here for one reason and it is worth naming: a
 * preview neither reads the scheduling state nor writes it, so it cannot
 * desync it. `prepareDigestNow` leaves all three marks exactly as found, and
 * the scheduled run afterwards resumes from its watermark as though this never
 * happened. The two decisions hold each other up — change either one and check
 * the other still stands.
 *
 * The accepted cost, stated plainly: a manual send re-reports gifts the last
 * scheduled digest already mailed. That is the point. It is a preview of the
 * PERIOD, not a claim about what is new.
 */
export function sendNowWindowStart(
  rule: Pick<Doc<"givingNotificationRules">, "cadence">,
  now: number,
): number {
  return now - cadencePeriodMs(rule.cadence);
}

/**
 * Read one rule's window and build its email payload. NO WRITES — every mark
 * belongs to the caller, which is the whole reason this is a function rather
 * than part of `claimDigest`.
 *
 * TWO CALLERS, ONE PATH. `claimDigest` (the hourly sweep) moves the marks
 * afterwards; `prepareDigestNow` (the desk's "Send now") deliberately doesn't.
 * Everything that decides WHAT a digest says — the scope filter, the amount
 * floor, the minute-early close, the cut/truncation machinery, the breakdowns,
 * the `MAX_DIGEST_GIFT_ROWS` list cap, the empty-daily asymmetry — happens
 * here exactly once, so the manual send can never drift from the scheduled one
 * it exists to preview.
 *
 * `since` IS THE ONE THING THE TWO CALLERS DISAGREE ABOUT, which is why it is
 * a parameter rather than computed here: the sweep passes
 * `digestWindowStart` (resume from the watermark — a chain that must not skip
 * or duplicate), the manual send passes `sendNowWindowStart` (the trailing
 * period — the honest answer to "what does a weekly digest look like?"). Both
 * are documented at their own definitions.
 *
 * Returns `null` when this window shouldn't send (today: an empty daily).
 */
async function buildDigestPayload(
  ctx: MutationCtx,
  rule: Doc<"givingNotificationRules">,
  now: number,
  since: number,
): Promise<BuiltDigest | null> {
  // An `immediate` rule has no window and no digest template. Both callers
  // already refuse one before they get here; this is the narrowing that makes
  // that a type-level fact rather than a convention.
  if (rule.cadence !== "daily" && rule.cadence !== "weekly") return null;

  // The window closes a minute behind `now`, so a gift whose transaction
  // started before this run but commits after it lands in the NEXT window
  // rather than behind the watermark. See `DIGEST_LAG_MS`.
  const requestedUntil = Math.max(since, now - DIGEST_LAG_MS);
  const window = await collectWindowGifts(ctx, rule, since, requestedUntil);

  if (!shouldSendDigest(rule.cadence, window.gifts.length, window.truncated)) {
    return null;
  }

  // Newest first, by WHEN THE MONEY ARRIVED — the same date the window selects
  // on and the same one each row prints, so the list can't be read in one order
  // and dated in another. A digest is read top-down and the freshest gift is
  // the one most likely to still be worth a phone call today. Ties break on
  // `createdAt`, which keeps a batch dated to one day in a stable order.
  const gifts = [...window.gifts].sort(
    (a, b) => b.receivedAt - a.receivedAt || b.createdAt - a.createdAt,
  );

  const chapterNames = new Map<string, string>();
  const byScope = new Map<string, DigestBreakdownRow>();
  const byMethod = new Map<string, DigestBreakdownRow>();
  const byType = new Map<string, DigestBreakdownRow>();
  let totalCents = 0;
  let largestRow: Doc<"gifts"> | null = null;

  for (const gift of gifts) {
    totalCents += gift.amountCents;
    addTo(byMethod, giftMethodLabel(gift.method), gift.amountCents);
    // EVERY gift, matched or listed or not — `giftType` returns exactly one
    // bucket per gift (see `lib/giftLabels.ts`), which is what makes this cut
    // add up to `totalCents` rather than approximately to it.
    addTo(byType, GIFT_TYPE_LABELS[giftType(gift)], gift.amountCents);
    if (!largestRow || gift.amountCents > largestRow.amountCents) {
      largestRow = gift;
    }
  }

  const listed: NotificationGift[] = [];
  for (const gift of gifts.slice(0, MAX_DIGEST_GIFT_ROWS)) {
    const built = await buildNotificationGift(ctx, gift, chapterNames, now);
    if (built) listed.push(built);
  }
  // The scope breakdown needs a label for EVERY gift, listed or not, so what
  // it shows adds up to the total above.
  for (const gift of gifts) {
    const key = gift.scope as string;
    let label = chapterNames.get(key);
    if (label === undefined) {
      label = await scopeLabel(ctx, gift.scope);
      chapterNames.set(key, label);
    }
    addTo(byScope, label, gift.amountCents);
  }

  const largest = largestRow
    ? await buildNotificationGift(ctx, largestRow, chapterNames, now)
    : null;

  return {
    until: window.until,
    truncated: window.truncated,
    recipients: rule.recipients,
    payload: {
      ruleName: rule.name,
      cadence: rule.cadence,
      scopeLabel: await ruleScopeLabel(ctx, rule.scope),
      periodStart: since,
      periodEnd: window.until,
      totalCents,
      giftCount: gifts.length,
      largest,
      byScope: sortedRows(byScope),
      byMethod: sortedRows(byMethod),
      byType: sortedRows(byType),
      gifts: listed,
      omittedCount: Math.max(0, gifts.length - listed.length),
      countTruncated: window.truncated,
    },
  };
}

/**
 * Claim ONE rule's digest: read its window, decide, move its marks, and build
 * the payload — all in a single transaction, so what is mailed is exactly what
 * was claimed and a crash before the mail costs at most this one rule's digest
 * rather than repeating it every hour.
 *
 * Returns `null` when the rule is no longer due, or when it's an empty daily
 * (which still marks itself RUN for the day, but deliberately does not move
 * the watermark — the window carries forward).
 */
export const claimDigest = internalMutation({
  args: {
    ruleId: v.id("givingNotificationRules"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return null;
    if (!isDigestDue(rule, now)) return null;
    if (rule.cadence !== "daily" && rule.cadence !== "weekly") return null;

    // Marked as RUN for the day whatever happens below — including the empty
    // daily that sends nothing. Without this, `>=`-hour matching would re-read
    // the window on every remaining hour of the day.
    const dayKey = runDayKey(now);

    // The SCHEDULED window: resume from the watermark, exactly. See
    // `digestWindowStart` — unchanged, and deliberately untouched by the
    // manual path below.
    const built = await buildDigestPayload(
      ctx,
      rule,
      now,
      digestWindowStart(rule, now),
    );
    if (!built) {
      // THE FOURTH MARK-WRITER, and the one that deliberately writes least.
      // An empty daily moves ONLY the scheduling mark: no watermark, because
      // nothing was reported, so the window carries forward; and no
      // `watermarkFromRun`, because a mark's provenance can't change while the
      // mark itself doesn't. Both omissions are load-bearing rather than
      // oversights — a rule can sit here for months (a quiet chapter, a high
      // amount floor), which is exactly why `digestWindowStart` bounds the
      // never-reported case at one period instead of trusting `createdAt`.
      await ctx.db.patch(rule._id, { lastRunDayKey: dayKey });
      return null;
    }

    // The watermark moves to where the window ACTUALLY closed. On a cut window
    // that is the last gift read, so the remainder is the next window's
    // problem rather than nobody's.
    //
    // A CUT WINDOW CLEARS the run mark instead of stamping it, so the drain
    // continues on the next hourly tick rather than waiting for tomorrow. A
    // 5,000-gift import otherwise took a week of cut-short digests to report,
    // with every later gift queued behind it. Hourly ticks catch up the same
    // day, and the drain stops on its own the moment a run completes the window
    // (which stamps the mark normally).
    //
    // `watermarkFromRun` rides along, and is set on BOTH branches: cut or
    // complete, this watermark is a REPORT of gifts that have now been mailed,
    // so the next window must resume from it exactly rather than reaching a
    // period back and re-reporting them. See the schema doc.
    await ctx.db.patch(rule._id, {
      lastSentAt: built.until,
      lastRunDayKey: built.truncated ? undefined : dayKey,
      watermarkFromRun: true,
      updatedAt: now,
    });

    return {
      // What this claim CHANGED, so the action can put it back if not one
      // recipient could be reached — see `releaseDigest`.
      previousMarks: {
        lastSentAt: rule.lastSentAt,
        lastRunDayKey: rule.lastRunDayKey,
        watermarkFromRun: rule.watermarkFromRun,
      },
      claimedUntil: built.until,
      recipients: built.recipients,
      payload: built.payload,
    };
  },
});

/**
 * Put a claim's marks back, because not one recipient could be reached.
 *
 * A WINDOW MAY ONLY BE CONSUMED BY A DIGEST THAT ACTUALLY GOT OUT. Delivery
 * failure is caught per recipient so one bad address can't cost a team their
 * digest — but when EVERY recipient fails, the whole point of moving the
 * watermark has gone, and leaving it moved means those gifts are never reported
 * by any digest, ever. Convex does not retry a failed scheduled action, so
 * there is no second chance to lean on.
 *
 * Guarded against clobbering: it only restores while `lastSentAt` is still
 * exactly what this claim set, so a later run (or a human edit) that has
 * already moved on is never rolled backwards.
 */
export const releaseDigest = internalMutation({
  args: {
    ruleId: v.id("givingNotificationRules"),
    claimedUntil: v.number(),
    previousLastSentAt: v.optional(v.number()),
    previousLastRunDayKey: v.optional(v.string()),
    previousWatermarkFromRun: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return false;
    if (rule.lastSentAt !== args.claimedUntil) return false;
    await ctx.db.patch(args.ruleId, {
      lastSentAt: args.previousLastSentAt,
      lastRunDayKey: args.previousLastRunDayKey,
      // ALL THREE marks, or none — a watermark and the claim about where it
      // came from only mean anything together. Putting a synthetic boundary
      // back while leaving `watermarkFromRun` true would cost that rule its
      // trailing-period floor for good.
      watermarkFromRun: args.previousWatermarkFromRun,
    });
    return true;
  },
});

/**
 * The hourly sweep. Claims, renders, sends — with a `try` around EACH rule, so
 * a rule that throws while being claimed or rendered costs itself and nothing
 * else, and a `try` around each recipient inside that, so one bad address
 * can't cost the rest of a fundraising team their digest.
 *
 * ── NOTHING IS CLAIMED THAT CANNOT BE MAILED ───────────────────────────────
 * Two ways the sweep used to eat a window and deliver nothing, both silent:
 *
 *  1. NO RESEND KEY. `sendEmailReporting` returns `false` rather than throwing
 *     when no key resolves, so a deployment that had never configured one
 *     advanced every watermark daily and mailed nothing — and the day someone
 *     configured the key, every gift behind those watermarks was permanently
 *     un-digested. Resolved up front now, and the sweep returns BEFORE claiming
 *     anything. Nothing is CONSUMED, so no window is ever eaten unmailed.
 *
 *     What that does NOT promise is an unbounded backlog, and it used to say so.
 *     A sweep that claims nothing leaves the rule with no watermark at all, and
 *     `digestWindowStart`'s never-reported case deliberately gives such a rule
 *     exactly ONE trailing period — so a key configured three months late gets
 *     the last week, not the last quarter. That is the same bound protecting
 *     every other watermark-less rule (a quiet daily never stamps one either),
 *     and it is the point: a first digest has to be readable. The distinction
 *     that matters is that nothing was silently consumed and re-reported as
 *     empty; the older gifts are still in the ledger, just not in an email.
 *  2. A RESEND OUTAGE. Every recipient throws, each is caught per-recipient,
 *     and the window was consumed anyway. Now a claim where NOT ONE recipient
 *     was reached is released (`releaseDigest`) and counted in `failedRules`,
 *     so the next tick re-reads the same window.
 */
export const sendGivingDigests = internalAction({
  args: {},
  returns: v.object({
    digestsSent: v.number(),
    emailsSent: v.number(),
    failedRules: v.number(),
    skippedNoMailer: v.boolean(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    digestsSent: number;
    emailsSent: number;
    failedRules: number;
    skippedNoMailer: boolean;
  }> => {
    // BEFORE anything is claimed. See the module doc — this ordering is the
    // whole fix, and it has no duplicate-email trade-off because no window has
    // been consumed yet.
    const mailer = await resolveResendSettings(ctx);
    if (!mailer) {
      console.log(
        "[givingNotifications] digest sweep skipped: no Resend key configured. " +
          "No watermark advanced, so nothing is lost — the backlog will be sent " +
          "once a key is set.",
      );
      return {
        digestsSent: 0,
        emailsSent: 0,
        failedRules: 0,
        skippedNoMailer: true,
      };
    }

    const ruleIds = await ctx.runQuery(
      internal.givingNotificationDigests.dueDigestRuleIds,
      {},
    );
    let digestsSent = 0;
    let emailsSent = 0;
    let failedRules = 0;

    for (const ruleId of ruleIds) {
      try {
        const built = await ctx.runMutation(
          internal.givingNotificationDigests.claimDigest,
          { ruleId },
        );
        if (!built) continue;
        const { subject, html } = renderDigestEmail(built.payload);

        let delivered = 0;
        for (const to of built.recipients) {
          try {
            // Counts DELIVERIES, not attempts — see `notifyGiftRecorded`.
            if (await sendEmailReporting(ctx, { to, subject, html })) {
              delivered++;
            }
          } catch (err) {
            console.error(
              `[givingNotifications] digest send failed for ${to}`,
              err,
            );
          }
        }

        if (delivered === 0) {
          // Not one recipient reached — give the window back.
          failedRules++;
          console.error(
            `[givingNotifications] digest for rule ${ruleId} reached nobody; ` +
              "releasing its window so the next run re-reads it",
          );
          await ctx.runMutation(
            internal.givingNotificationDigests.releaseDigest,
            {
              ruleId,
              claimedUntil: built.claimedUntil,
              previousLastSentAt: built.previousMarks.lastSentAt,
              previousLastRunDayKey: built.previousMarks.lastRunDayKey,
              previousWatermarkFromRun: built.previousMarks.watermarkFromRun,
            },
          );
          continue;
        }

        digestsSent++;
        emailsSent += delivered;
        // Only now, and only because somebody was actually reached. The marks
        // `claimDigest` moved are decided before the mail is attempted and are
        // put back by `releaseDigest` when it fails; this one can only be
        // written after the fact, and is never rolled back. Wrapped, because a
        // digest that went out and failed to record that it went out is a
        // cosmetic problem and must not be counted as a failed rule.
        try {
          await ctx.runMutation(
            internal.givingNotifications.markRulesDelivered,
            { ruleIds: [ruleId], at: Date.now() },
          );
        } catch (err) {
          console.error(
            `[givingNotifications] digest for rule ${ruleId} was delivered, ` +
              "but couldn't stamp lastDeliveredAt",
            err,
          );
        }
      } catch (err) {
        // LOUD, and names the rule — a lost digest that nothing in the logs
        // ties back to a rule is the failure mode this catch exists to avoid.
        failedRules++;
        console.error(
          `[givingNotifications] digest failed for rule ${ruleId}`,
          err,
        );
      }
    }
    return { digestsSent, emailsSent, failedRules, skippedNoMailer: false };
  },
});

// ── "Send now": the desk's on-demand digest ─────────────────────────────────

/**
 * How many manual sends one rule will accept in a rolling hour, and over what
 * window.
 *
 * THREE PER HOUR, PER RULE. This button puts a real email in real inboxes on a
 * press, so it is capped — but it is a TESTING affordance and the honest use is
 * "send it, read it, fix the amount floor, send it again", which needs more
 * than one. Three covers that and makes a mistake cost the recipients three
 * emails rather than thirty.
 *
 * KEYED ON THE RULE, not the caller. The cost falls on the rule's recipients,
 * and since the gate became giving VIEW several people can reach the same rule
 * — keying on the presser would let two of them take turns and double the rate
 * the team actually experiences. A caller who wants to mail themselves more
 * often can make their own rule, which is fine: it reaches their own inbox.
 */
export const SEND_NOW_WINDOW_MS = 60 * 60 * 1000;
export const SEND_NOW_MAX_PER_RULE = 3;

/** What one press of "Send now" ended up doing. The UI says one sentence per
 *  case, so each one has to be distinguishable from the others. */
const sendNowStatus = v.union(
  v.literal("sent"),
  v.literal("empty_window"),
  v.literal("nobody_reached"),
  v.literal("no_mailer"),
);

/**
 * Authorize, rate-limit, and build ONE rule's digest on demand — WITHOUT
 * moving any of its marks.
 *
 * ── AN ON-DEMAND SEND IS A PREVIEW, AND A PREVIEW MUST NOT CONSUME ─────────
 * `lastSentAt`, `watermarkFromRun` and `lastRunDayKey` are all left exactly as
 * found. That is the decision this whole affordance rests on, so it is worth
 * stating why rather than leaving it to be inferred from the absence of a
 * patch:
 *
 *  • The button exists to ANSWER "does my Monday 12pm digest work?". If it
 *    consumed the window, the act of checking would guarantee that Monday's
 *    real digest arrived empty — the button would break the one thing it is
 *    for. That is exactly the shape of the bug that prompted it: the owner set
 *    a noon send, the 09:00 run had already stamped the day, and the noon tick
 *    correctly did nothing.
 *  • Consuming would also make it a weapon shaped like a convenience. Anyone
 *    with giving VIEW of a book could silence that book's next scheduled
 *    digest by pressing a button, with the rule row showing nothing but a
 *    moved watermark to explain it.
 *  • The cost of NOT consuming is that the same gifts are reported twice —
 *    once now, once at the scheduled hour. That is visible, harmless, and was
 *    asked for by whoever pressed the button. A silently skipped period is
 *    none of those things. Given the choice between a duplicate the reader can
 *    see and a gap they cannot, take the duplicate.
 *
 * `lastDeliveredAt` IS stamped, by the action, once somebody was actually
 * reached — see `markRulesDelivered`. It is not a window mark and nothing
 * schedules off it; it means literally "an email from this rule reached
 * somebody at this instant", which just became true, and it is what the desk
 * shows as "last sent". Suppressing it would make the button's own success
 * invisible on the row that offers it.
 *
 * ── TWO THINGS DIFFER FROM A SCHEDULED RUN, AND ONLY TWO ──────────────────
 *  1. The DUE check (`isDigestDue` / `lastRunDayKey`) is bypassed. That is the
 *     point of the button.
 *  2. The window is the TRAILING PERIOD rather than the watermark window — see
 *     `sendNowWindowStart`. Not an oversight and not a shortcut: a manual send
 *     asks "what does a weekly digest look like?", and on the watermark window
 *     a press an hour after the scheduled run answers that with an empty
 *     three-hour report. This is safe ONLY because of the marks decision
 *     above; the two hold each other up.
 *
 * EVERYTHING ELSE STILL APPLIES, through `buildDigestPayload`, unchanged and
 * unforked: the scope filter, the amount floor, the `DIGEST_LAG_MS` window
 * close, the cut/truncation machinery, the breakdowns, the
 * `MAX_DIGEST_GIFT_ROWS` list cap and the empty-daily/empty-weekly asymmetry.
 */
export const prepareDigestNow = internalMutation({
  args: {
    ruleId: v.id("givingNotificationRules"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That rule doesn't exist.",
      });
    }
    // The SAME gate that lets a caller edit or pause this rule — giving VIEW of
    // its own book (see `givingNotifications.ts#canManageRuleScope`). Nothing
    // here checks a seat inline, and superusers pass as they do everywhere.
    await requireRuleManage(ctx, rule.scope);

    if (rule.cadence !== "daily" && rule.cadence !== "weekly") {
      throw new ConvexError({
        code: "NOT_A_DIGEST",
        message:
          "This rule sends as each gift arrives, so there's no digest to send.",
      });
    }
    // A PAUSED RULE REFUSES, rather than mailing an empty digest. `isActive` is
    // half of `ruleMatchesGift`, so a paused rule's window matches nothing —
    // sending anyway would put a confident "No giving this week" in front of a
    // team whose rule is simply switched off. Say so instead.
    if (!rule.isActive) {
      throw new ConvexError({
        code: "RULE_PAUSED",
        message: "This rule is paused. Turn it back on to send its digest.",
      });
    }

    // Checked and recorded in the same transaction as the build, so two
    // simultaneous presses can't both pass the check. One row per ACCEPTED
    // press — a refusal costs the budget nothing.
    const key = `rule:${args.ruleId}`;
    const recent = await ctx.db
      .query("givingDigestSendNowAttempts")
      .withIndex("by_key_and_time", (q) =>
        q.eq("key", key).gte("createdAt", now - SEND_NOW_WINDOW_MS),
      )
      .take(SEND_NOW_MAX_PER_RULE);
    if (recent.length >= SEND_NOW_MAX_PER_RULE) {
      throw new ConvexError({
        code: "RATE_LIMITED",
        message: `This rule has already been sent ${SEND_NOW_MAX_PER_RULE} times in the last hour. Give it a little while.`,
      });
    }
    await ctx.db.insert("givingDigestSendNowAttempts", { key, createdAt: now });

    // THE TRAILING PERIOD, not the watermark window — see
    // `sendNowWindowStart` for why the manual send asks a different question
    // from the cron, and why ignoring the watermark is safe only because
    // nothing below touches it.
    const built = await buildDigestPayload(
      ctx,
      rule,
      now,
      sendNowWindowStart(rule, now),
    );
    if (!built) return null;
    return { recipients: built.recipients, payload: built.payload };
  },
});

/**
 * Send ONE rule's digest right now — the desk's "Send now" button.
 *
 * A digest rule otherwise cannot be tested without waiting for its next slot,
 * which is a week for a weekly rule. This is the whole of the fix: the trailing
 * period, the same render, the same send, the same recipients, no marks moved.
 * See `prepareDigestNow` for the authorization, the rate limit and the marks,
 * and `sendNowWindowStart` for why the window is the period rather than
 * whatever is left of the watermark's.
 *
 * Every refusal throws a `ConvexError` the screen can read out; every
 * NON-refusal comes back as a status, because "it sent nothing" has four
 * different honest explanations and a button that says only "done" for all of
 * them is worse than no button.
 *
 * The mailer is resolved AFTER the gate, not before it — unlike the hourly
 * sweep, which checks first because it must never CLAIM a window it can't mail.
 * Nothing is consumed here, so there is no window to protect, and doing it in
 * this order means an unauthorized caller is refused rather than told what this
 * deployment has configured.
 */
export const sendDigestNow = action({
  args: { ruleId: v.id("givingNotificationRules") },
  returns: v.object({ status: sendNowStatus, emailsSent: v.number() }),
  handler: async (
    ctx,
    { ruleId },
  ): Promise<{
    status: "sent" | "empty_window" | "nobody_reached" | "no_mailer";
    emailsSent: number;
  }> => {
    const built = await ctx.runMutation(
      internal.givingNotificationDigests.prepareDigestNow,
      { ruleId },
    );
    // An empty DAILY window — and because the manual window is the trailing
    // PERIOD, this now means "no gifts at all in the last 24 hours", which is
    // a real and rare answer rather than "nothing since the 08:00 run".
    // `shouldSendDigest` says a "nothing came in today" email is one people
    // learn to delete, and the manual path has no business disagreeing with
    // the scheduled one about that. (An empty WEEKLY does send — that absence
    // is the signal.)
    if (!built) return { status: "empty_window", emailsSent: 0 };

    // Explicitly, so "no Resend key on this deployment" reads as itself rather
    // than as the bounce that `sendEmailReporting`'s `false` would look like.
    const mailer = await resolveResendSettings(ctx);
    if (!mailer) return { status: "no_mailer", emailsSent: 0 };

    const { subject, html } = renderDigestEmail(built.payload);
    let delivered = 0;
    for (const to of built.recipients) {
      // Per recipient, like every other send path here: one bad address must
      // not cost the rest of the team their copy.
      try {
        if (await sendEmailReporting(ctx, { to, subject, html })) delivered++;
      } catch (err) {
        console.error(
          `[givingNotifications] manual digest send failed for ${to}`,
          err,
        );
      }
    }
    // No `releaseDigest` counterpart, and none needed: nothing was claimed, so
    // there is nothing to give back. The window is still exactly where the
    // scheduled run will find it.
    if (delivered === 0) return { status: "nobody_reached", emailsSent: 0 };

    try {
      await ctx.runMutation(internal.givingNotifications.markRulesDelivered, {
        ruleIds: [ruleId],
        at: Date.now(),
      });
    } catch (err) {
      console.error(
        `[givingNotifications] manual digest for rule ${ruleId} was delivered, ` +
          "but couldn't stamp lastDeliveredAt",
        err,
      );
    }
    return { status: "sent", emailsSent: delivered };
  },
});
