/**
 * The fee schedule as a surface — read it, and (rarely) change it.
 *
 * The rates and every piece of arithmetic live in
 * `@events-os/shared/processorFees`; the resolution rule lives in
 * `lib/feeSchedule.ts`. This file is only the Convex boundary: an unauthenticated
 * read (the public giving page needs to quote a price before anyone has logged
 * in) and a guarded write.
 */
import { internalQuery, mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import {
  ACH_NUDGE_THRESHOLD_CENTS,
  DEFAULT_FEE_SCHEDULE,
  FEE_METHOD_LABELS,
  FEE_PROCESSOR_LABELS,
  describeFeeRate,
  feeRateProblems,
  type FeeMethod,
  type FeeProcessor,
} from "@events-os/shared";
import { resolveFeeRate, resolveFeeSchedule } from "./lib/feeSchedule";
import { requireFeeScheduleManage } from "./lib/feeScheduleAccess";
import { requireUserId } from "./lib/context";
import type { Id } from "./_generated/dataModel";

const railValidator = v.object({
  processor: v.string(),
  method: v.string(),
  processorLabel: v.string(),
  methodLabel: v.string(),
  percentBps: v.number(),
  fixedCents: v.number(),
  capCents: v.union(v.number(), v.null()),
  /** `2.9% + $0.30`, `0.8%, capped at $5.00` — the rate as a person reads it. */
  description: v.string(),
  /** Is this the shipped rate, or has somebody overridden it? */
  isDefault: v.boolean(),
});

/**
 * Every rail and what it currently costs.
 *
 * PUBLIC, deliberately. The giving page runs unauthenticated and has to be able
 * to say "your $100 gift costs the ministry $3.20 on a card, $0.80 by bank
 * transfer" before anyone signs in. Nothing here is sensitive — these are the
 * processors' own published prices, and stating them plainly is the point of
 * the feature.
 */
export const listFeeSchedule = query({
  args: {},
  returns: v.array(railValidator),
  handler: async (ctx) => {
    const schedule = await resolveFeeSchedule(ctx);
    return schedule.map((rail) => {
      const published = DEFAULT_FEE_SCHEDULE.find(
        (d) => d.processor === rail.processor && d.method === rail.method,
      );
      const isDefault =
        published != null &&
        published.percentBps === rail.percentBps &&
        published.fixedCents === rail.fixedCents &&
        (published.capCents ?? null) === (rail.capCents ?? null);
      return {
        processor: rail.processor,
        method: rail.method,
        processorLabel: FEE_PROCESSOR_LABELS[rail.processor],
        methodLabel: FEE_METHOD_LABELS[rail.method],
        percentBps: rail.percentBps,
        fixedCents: rail.fixedCents,
        capCents: rail.capCents ?? null,
        description: describeFeeRate(rail),
        isDefault,
      };
    });
  },
});

/**
 * Override one rail's rate — the whole reason the table exists.
 *
 * REFUSES A RAIL THE CODE DOESN'T HAVE. A row for `venmo:card` would be dead
 * weight that reads as configuration, so it never gets written: the rail list
 * is the code's, and this can only re-price an entry on it.
 *
 * VALIDATES BEFORE WRITING, using the same `feeRateProblems` the reader falls
 * back on. A rate at or above 100% has no gross-up solution at all, so it is
 * rejected here rather than discovered by a donor.
 *
 * A `note` is required. A rate that changed for a reason nobody wrote down is
 * a rate the next treasurer has to take on faith, which is exactly the
 * complaint that produced `processorFeeEntries`.
 */
const bareRate = v.object({
  percentBps: v.number(),
  fixedCents: v.number(),
  capCents: v.optional(v.number()),
});

/**
 * The two rails the public giving page reasons about, plus the nudge threshold.
 *
 * ONE query with two consumers, deliberately, because they must agree:
 * `http.ts` stamps this into the page so the browser can show what covering
 * the fees costs, and `startGiveDonationCheckout` reads the SAME thing to
 * decide what to actually charge. Split them and the page could quote a rate
 * the checkout no longer uses.
 *
 * The action must not take the amount from the request — the page sends a
 * yes/no and the server decides the price, or a hand-crafted POST decides what
 * we charge.
 *
 * COVERAGE IS QUOTED AT THE CARD RATE, not at whatever rail they end up
 * picking: Stripe doesn't tell us the method until after the session exists.
 * Card is the commonest and the dearer of the two, so a donor who then pays by
 * bank has over-covered by a little in the org's favour rather than
 * under-covered in theirs. That is the right direction to be wrong in, and the
 * only one that can never leave a gift short of what was quoted.
 */
export const givePageRates = internalQuery({
  args: {},
  returns: v.object({
    card: v.union(bareRate, v.null()),
    ach: v.union(bareRate, v.null()),
    achThresholdCents: v.number(),
  }),
  handler: async (ctx) => ({
    card: await resolveFeeRate(ctx, "stripe", "card"),
    ach: await resolveFeeRate(ctx, "stripe", "ach_debit"),
    achThresholdCents: ACH_NUDGE_THRESHOLD_CENTS,
  }),
});

export const setFeeRate = mutation({
  args: {
    processor: v.string(),
    method: v.string(),
    percentBps: v.number(),
    fixedCents: v.number(),
    capCents: v.optional(v.union(v.number(), v.null())),
    note: v.string(),
  },
  returns: v.object({ created: v.boolean() }),
  handler: async (ctx, args) => {
    await requireFeeScheduleManage(ctx);
    // `requireUserId` is untyped (string) across this codebase; the row is
    // only ever written here, so the narrowing is safe and local.
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const known = DEFAULT_FEE_SCHEDULE.some(
      (r) => r.processor === args.processor && r.method === args.method,
    );
    if (!known) {
      throw new ConvexError({
        code: "UNKNOWN_RAIL",
        message: `There is no ${args.processor}/${args.method} payment rail to price.`,
      });
    }

    const rate = {
      percentBps: args.percentBps,
      fixedCents: args.fixedCents,
      ...(args.capCents != null ? { capCents: args.capCents } : {}),
    };
    const problems = feeRateProblems(rate);
    if (problems.length > 0) {
      throw new ConvexError({ code: "INVALID_RATE", message: problems.join("; ") });
    }
    const note = args.note.trim();
    if (note.length < 8) {
      throw new ConvexError({
        code: "NOTE_REQUIRED",
        message: "Say why the rate changed — a rate with no explanation is one nobody can check.",
      });
    }

    const existing = await ctx.db
      .query("processorFeeSchedule")
      .withIndex("by_rail", (q) =>
        q
          .eq("processor", args.processor as FeeProcessor)
          .eq("method", args.method as FeeMethod),
      )
      .unique();

    const fields = {
      processor: args.processor,
      method: args.method,
      percentBps: args.percentBps,
      fixedCents: args.fixedCents,
      // An explicit `null` CLEARS a cap; omitting the arg leaves it alone on an
      // update. A rail losing its cap is a real pricing change, not an oversight.
      ...(args.capCents === null ? {} : args.capCents != null ? { capCents: args.capCents } : {}),
      note,
      updatedBy: userId,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...fields,
        ...(args.capCents === null ? { capCents: undefined } : {}),
      });
      return { created: false };
    }
    await ctx.db.insert("processorFeeSchedule", fields);
    return { created: true };
  },
});

/** Drop an override, returning the rail to its published rate. */
export const clearFeeRateOverride = mutation({
  args: { processor: v.string(), method: v.string() },
  returns: v.object({ cleared: v.boolean() }),
  handler: async (ctx, args) => {
    await requireFeeScheduleManage(ctx);
    const existing = await ctx.db
      .query("processorFeeSchedule")
      .withIndex("by_rail", (q) =>
        q
          .eq("processor", args.processor as FeeProcessor)
          .eq("method", args.method as FeeMethod),
      )
      .unique();
    if (!existing) return { cleared: false };
    await ctx.db.delete(existing._id);
    return { cleared: true };
  },
});
