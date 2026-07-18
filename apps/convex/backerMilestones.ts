/**
 * Backer milestone ladder (`docs/plans/giving-platform.md` §3) — config
 * behind the affordability header's tier label. Read by any signed-in org
 * member (the ladder isn't sensitive — it's the same "N backers unlocks X"
 * promise the public `/give/<slug>` page will show, per §5); written only by
 * central finance-manager rank (or a superuser).
 *
 * Replace-all semantics: `saveMilestones` takes the WHOLE ladder each save
 * (never a single-row patch) — a ladder is small (≤ `MAX_MILESTONES` rows)
 * and always edited as one ordered list in the UI, so replace-all avoids a
 * whole add/remove/reorder mutation surface for a config this size.
 *
 * `chapterAffordability` (`finances.ts`) reads this table and falls back to
 * the `AFFORDABILITY_TIERS` constant when it's empty — see that query's own
 * doc comment. `seedMilestonesIfEmpty` below is the one-time (idempotent)
 * seed from that same constant, for deployments that want the config table
 * populated rather than relying purely on the in-code fallback.
 */
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { AFFORDABILITY_TIERS } from "@events-os/shared";
import { query, mutation, internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireAccess, requireChapterId, requireUserId } from "./lib/context";
import { requireCentralFinanceRole } from "./lib/finance";

/** A ladder tops out at 10 rungs — plenty for the playbook's 3-tier model
 *  with headroom, and small enough that replace-all + `.take()` scans stay
 *  trivially bounded. */
export const MAX_MILESTONES = 10;

const milestoneValidator = v.object({
  _id: v.id("backerMilestones"),
  minBackers: v.number(),
  label: v.string(),
  commitment: v.string(),
  description: v.optional(v.string()),
  sortOrder: v.number(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.id("users")),
});

/**
 * The configured ladder, ordered by `minBackers` ascending. Readable by any
 * authenticated + allowed org member (`requireAccess` — the house-wide
 * domain/allowlist gate, not a finance role): this is public-facing config
 * (the future `/give/<slug>` page shows the same promises to donors), so it
 * gates looser than `requireFinanceRole(ctx, chapterId, "viewer")`, which is
 * chapter-scoped and this table isn't. Mirrors `financeSettings.getFinanceSettings`'s
 * "read is the loose gate, write is the tight one" shape.
 */
export const listMilestones = query({
  args: {},
  returns: v.array(milestoneValidator),
  handler: async (ctx) => {
    await requireAccess(ctx);
    const rows = await ctx.db
      .query("backerMilestones")
      .withIndex("by_minBackers")
      .order("asc")
      .take(MAX_MILESTONES + 1);
    // Strip system fields (`_creationTime`) down to the declared shape —
    // `milestoneValidator` is also what `saveMilestones` returns, and that
    // one is hand-built (freshly inserted rows, never re-read), so the two
    // return shapes must match exactly.
    return rows.map((row) => ({
      _id: row._id,
      minBackers: row.minBackers,
      label: row.label,
      commitment: row.commitment,
      description: row.description,
      sortOrder: row.sortOrder,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    }));
  },
});

/**
 * Replace the whole ladder. Central finance-manager rank only (or a
 * superuser, which `requireCentralFinanceRole` already short-circuits to
 * central-manager — see `lib/finance.ts#getFinanceRole`).
 *
 * TODO(giving.manage): this gate widens to the giving capability once P1's
 * `lib/givingAccess.ts` merges (`docs/plans/giving-platform.md` §6) — the
 * development director owns this ladder per the PRD, but the giving
 * capability doesn't exist yet, so this PR reuses the closest existing
 * write gate (central finance-manager rank) instead of inventing one.
 *
 * Validation (all-or-nothing — a bad row rejects the WHOLE save, nothing is
 * partially written):
 *  - at most `MAX_MILESTONES` rungs;
 *  - each `minBackers` is a positive integer;
 *  - `minBackers` is STRICTLY increasing across the array (also enforces
 *    uniqueness — equal values fail the strict `>` check);
 *  - `label` and `commitment` are non-empty after trimming.
 */
export const saveMilestones = mutation({
  args: {
    rows: v.array(
      v.object({
        minBackers: v.number(),
        label: v.string(),
        commitment: v.string(),
        description: v.optional(v.string()),
      }),
    ),
  },
  returns: v.array(milestoneValidator),
  handler: async (ctx, { rows }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, chapterId, "manager");

    if (rows.length > MAX_MILESTONES) {
      throw new ConvexError({
        code: "TOO_MANY_MILESTONES",
        message: `A milestone ladder may have at most ${MAX_MILESTONES} rungs.`,
      });
    }

    let lastMinBackers = -Infinity;
    for (const row of rows) {
      if (!Number.isInteger(row.minBackers) || row.minBackers <= 0) {
        throw new ConvexError({
          code: "INVALID_MIN_BACKERS",
          message: "Each rung's backer threshold must be a positive whole number.",
        });
      }
      if (row.minBackers <= lastMinBackers) {
        throw new ConvexError({
          code: "NOT_INCREASING",
          message: "Backer thresholds must be strictly increasing, with no duplicates.",
        });
      }
      lastMinBackers = row.minBackers;
      if (row.label.trim().length === 0) {
        throw new ConvexError({
          code: "EMPTY_LABEL",
          message: "Every rung needs a label.",
        });
      }
      if (row.commitment.trim().length === 0) {
        throw new ConvexError({
          code: "EMPTY_COMMITMENT",
          message: "Every rung needs a commitment.",
        });
      }
    }

    const updatedBy = (await requireUserId(ctx)) as Id<"users">;
    const updatedAt = Date.now();

    // Replace-all: the ladder is capped at `MAX_MILESTONES`, so this scan +
    // delete is always small and bounded.
    const existing = await ctx.db
      .query("backerMilestones")
      .take(MAX_MILESTONES + 1);
    for (const doc of existing) {
      await ctx.db.delete(doc._id);
    }

    const saved: Array<{
      _id: Id<"backerMilestones">;
      minBackers: number;
      label: string;
      commitment: string;
      description?: string;
      sortOrder: number;
      updatedAt: number;
      updatedBy: Id<"users">;
    }> = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const label = row.label.trim();
      const commitment = row.commitment.trim();
      const description = row.description?.trim() || undefined;
      const _id = await ctx.db.insert("backerMilestones", {
        minBackers: row.minBackers,
        label,
        commitment,
        description,
        sortOrder: i,
        updatedAt,
        updatedBy,
      });
      saved.push({
        _id,
        minBackers: row.minBackers,
        label,
        commitment,
        description,
        sortOrder: i,
        updatedAt,
        updatedBy,
      });
    }
    return saved;
  },
});

/** Commitment copy for each seeded rung — the labels come from
 *  `AFFORDABILITY_TIERS` itself (never re-typed here) so the seed can never
 *  drift from the constant's tier names; only the longer-form commitment
 *  sentence is looked up by threshold. Owner decision #1 (2026-07-16):
 *  20 → WWS, 30 → +Eden, 50 → +LTN. */
const SEED_COMMITMENTS: Record<number, string> = {
  20: "Worship With Strangers, monthly",
  30: "Eden",
  50: "Love Thy Neighbor",
};

/**
 * Seed the ladder from `AFFORDABILITY_TIERS` — idempotent (a no-op once any
 * row exists). Internal: there's no human actor behind a seed run, so seeded
 * rows carry no `updatedBy` (see the schema doc comment). Not invoked
 * automatically anywhere in this PR — `chapterAffordability` already falls
 * back to the constant when the table is empty, so seeding is an optional
 * "populate the editable config" step (dashboard function runner / a future
 * migration), not a correctness requirement.
 */
export const seedMilestonesIfEmpty = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const existing = await ctx.db.query("backerMilestones").first();
    if (existing) return null;

    const sorted = [...AFFORDABILITY_TIERS].sort(
      (a, b) => a.minBackers - b.minBackers,
    );
    const updatedAt = Date.now();
    for (let i = 0; i < sorted.length; i++) {
      const tier = sorted[i];
      await ctx.db.insert("backerMilestones", {
        minBackers: tier.minBackers,
        label: tier.label,
        commitment: SEED_COMMITMENTS[tier.minBackers] ?? tier.label,
        sortOrder: i,
        updatedAt,
      });
    }
    return null;
  },
});
