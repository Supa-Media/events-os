/**
 * Back-link card charges that ingested BEFORE their card was known
 * (migration slot 0078 — see `migrations/index.ts`'s module doc for the
 * numbering scheme).
 *
 * `increaseLedger.ts` attributes a charge by looking its `increaseCardId` up in
 * `cards`. A card made in the Increase dashboard had no such row until
 * `increaseCardSync.ts` shipped, so its charges landed with null `cardId` /
 * `personId` / `cardLast4` — recorded, but belonging to nobody, and invisible
 * to the person who actually spent the money. Syncing the cards fixes every
 * FUTURE charge; this fixes the ones already on the books.
 *
 * The link is provider-stated, not inferred. Increase groups a charge under a
 * Card Payment, the transaction row already stores that `cardPaymentId`, and
 * `GET /card_payments/{id}` names the `card_id` — so this reads the answer off
 * the vendor rather than matching on amount and date. (See
 * `lib/seed/historical/genesisDedupe2026.ts`'s header for why amount+date
 * matching is not evidence.)
 *
 * NOT wired into the `migrations/index.ts` auto-registry — same reasoning as
 * the sibling `0037` / `0048`, plus one of its own: `runPending`'s
 * `Migration.run(ctx)` is a `MutationCtx`, and a mutation cannot `fetch`. This
 * needs the network, so it is an action a human runs.
 *
 * DRY-RUN FIRST, ALWAYS. `dryRun: true` is the default and writes nothing:
 *
 *   npx convex run migrations/0078_link_orphan_increase_card_charges:linkOrphanIncreaseCardCharges '{}' --prod
 *
 * Read the plan it prints, then commit by re-running with the count you just
 * saw, which it will refuse to proceed without matching:
 *
 *   npx convex run migrations/0078_link_orphan_increase_card_charges:linkOrphanIncreaseCardCharges \
 *     '{"dryRun": false, "expectLinks": 1}' --prod
 *
 * `expectLinks` is the money-path guard: the plan is built in full and checked
 * against it BEFORE the first write, so a run that would touch more (or fewer)
 * rows than a human just reviewed aborts having changed nothing rather than
 * half-applying. At the time of writing that number is 1 — the $14.27 Amazon
 * charge on Kansi's card — but re-derive it from the dry run rather than
 * trusting this comment.
 *
 * IDEMPOTENT: only ever considers charges with no `cardId`, so a second run
 * finds nothing left to do.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { increaseEnvForMode, increaseGet } from "../lib/increaseApi";

/** Per-scope cap on the orphan scan. Well above any plausible backlog (one
 *  orphan exists in production today) and far below Convex's read cap. */
const SCAN_LIMIT = 4096;

/** One unlinked charge, as the planner sees it. */
interface OrphanCharge {
  transactionId: Id<"transactions">;
  cardPaymentId?: string;
  amountCents: number;
  merchantName?: string;
  postedAt: number;
  scope: string;
}

/** What a run reports back. */
interface LinkRunResult {
  dryRun: boolean;
  orphansFound: number;
  linkable: number;
  linked: number;
  plan: string[];
  skipped: string[];
}

/** Every `increase_card` charge still missing its card link, across all scopes. */
export const listOrphanCardCharges = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      transactionId: v.id("transactions"),
      cardPaymentId: v.optional(v.string()),
      amountCents: v.number(),
      merchantName: v.optional(v.string()),
      postedAt: v.number(),
      scope: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const chapters = await ctx.db.query("chapters").collect();
    const scopes: Array<Id<"chapters"> | "central"> = [
      ...chapters.map((c) => c._id),
      "central" as const,
    ];
    // BOUNDED, per the file-local convention (`ROLLUP_SCAN_LIMIT` /
    // `CARD_TXN_LIMIT` elsewhere): an unbounded `.collect()` over every scope
    // would grow into Convex's per-execution read cap and throw before the
    // plan was even built. Newest-first, because an unlinked charge is by
    // definition recent — the condition this repairs only arises after a card
    // is made in the dashboard.
    const perScope = await Promise.all(
      scopes.map((scope) =>
        ctx.db
          .query("transactions")
          .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
          .order("desc")
          .take(SCAN_LIMIT),
      ),
    );
    return perScope
      .flat()
      .filter((t) => t.source === "increase_card" && t.cardId === undefined)
      .map((t) => ({
        transactionId: t._id,
        ...(t.cardPaymentId ? { cardPaymentId: t.cardPaymentId } : {}),
        amountCents: t.amountCents,
        ...(t.merchantName ? { merchantName: t.merchantName } : {}),
        postedAt: t.postedAt,
        scope: t.chapterId,
      }));
  },
});

/**
 * Attach one charge to the card that made it. Re-checks everything the planner
 * checked — the row is still unlinked, the card is known, and the card's scope
 * matches the charge's — because the plan was built before any write and the
 * world may have moved underneath it.
 */
export const applyCardLink = internalMutation({
  args: {
    transactionId: v.id("transactions"),
    increaseCardId: v.string(),
  },
  returns: v.object({
    linked: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, { transactionId, increaseCardId }) => {
    const txn = await ctx.db.get(transactionId);
    if (!txn) return { linked: false, reason: "transaction vanished" };
    if (txn.cardId !== undefined) {
      return { linked: false, reason: "already linked" };
    }
    const card = await ctx.db
      .query("cards")
      .withIndex("by_increase_card", (q) =>
        q.eq("increaseCardId", increaseCardId),
      )
      .first();
    if (!card) {
      return { linked: false, reason: `no cards row for ${increaseCardId}` };
    }
    // Same guard `increaseLedger` applies at ingest: a charge is only ever
    // attributed to a card drawn on the account that paid it.
    if (card.chapterId !== txn.chapterId) {
      return {
        linked: false,
        reason: `card scope ${card.chapterId} != charge scope ${txn.chapterId}`,
      };
    }
    await ctx.db.patch(transactionId, {
      cardId: card._id,
      personId: card.cardholderPersonId,
      ...(card.last4 ? { cardLast4: card.last4 } : {}),
    });
    return { linked: true };
  },
});

export const linkOrphanIncreaseCardCharges = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    expectLinks: v.optional(v.number()),
    sandbox: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    orphansFound: v.number(),
    linkable: v.number(),
    linked: v.number(),
    plan: v.array(v.string()),
    skipped: v.array(v.string()),
  }),
  handler: async (
    ctx,
    { dryRun, expectLinks, sandbox },
  ): Promise<LinkRunResult> => {
    const isDryRun = dryRun !== false;
    const { key, base } = increaseEnvForMode(sandbox === true);
    if (!key) {
      throw new Error(
        `Increase API key for the ${sandbox === true ? "sandbox" : "production"} environment is not configured.`,
      );
    }

    const orphans: OrphanCharge[] = await ctx.runQuery(
      internal.migrations[
        "0078_link_orphan_increase_card_charges"
      ].listOrphanCardCharges,
      {},
    );

    // ── Plan (no writes) ─────────────────────────────────────────────────────
    const cardIdCache = new Map<string, string | null>();
    const plan: Array<{ transactionId: Id<"transactions">; increaseCardId: string; label: string }> = [];
    const skipped: string[] = [];

    for (const o of orphans) {
      const label = `$${(o.amountCents / 100).toFixed(2)} ${o.merchantName ?? "(no merchant)"} [${o.scope}]`;
      if (!o.cardPaymentId) {
        skipped.push(`${label}: no cardPaymentId — nothing to resolve against`);
        continue;
      }
      let increaseCardId = cardIdCache.get(o.cardPaymentId) ?? null;
      if (!cardIdCache.has(o.cardPaymentId)) {
        try {
          const payment = await increaseGet(
            key,
            base,
            `/card_payments/${encodeURIComponent(o.cardPaymentId)}`,
          );
          increaseCardId =
            typeof payment.card_id === "string" ? payment.card_id : null;
        } catch (err) {
          increaseCardId = null;
          console.error(
            `[0078] failed to fetch card_payment ${o.cardPaymentId}`,
            err,
          );
        }
        cardIdCache.set(o.cardPaymentId, increaseCardId);
      }
      if (!increaseCardId) {
        skipped.push(
          `${label}: card_payment ${o.cardPaymentId} named no card_id`,
        );
        continue;
      }
      plan.push({
        transactionId: o.transactionId,
        increaseCardId,
        label: `${label} → ${increaseCardId}`,
      });
    }

    // ── The guard: refuse rather than half-apply ─────────────────────────────
    if (!isDryRun) {
      if (expectLinks === undefined) {
        throw new Error(
          `Refusing to run: pass \`expectLinks\` with the count the dry run reported ` +
            `(it plans ${plan.length} link(s) right now). Committing without it would ` +
            `apply a plan no human has reviewed.`,
        );
      }
      if (plan.length !== expectLinks) {
        throw new Error(
          `Refusing to run: expected ${expectLinks} link(s), planned ${plan.length}. ` +
            `Re-run the dry run, review the plan, and pass the number it reports.`,
        );
      }
    }

    if (isDryRun) {
      return {
        dryRun: true,
        orphansFound: orphans.length,
        linkable: plan.length,
        linked: 0,
        plan: plan.map((p) => p.label),
        skipped,
      };
    }

    let linked = 0;
    for (const p of plan) {
      const { linked: ok, reason }: { linked: boolean; reason?: string } =
        await ctx.runMutation(
          internal.migrations[
            "0078_link_orphan_increase_card_charges"
          ].applyCardLink,
          { transactionId: p.transactionId, increaseCardId: p.increaseCardId },
        );
      if (ok) linked++;
      else skipped.push(`${p.label}: ${reason ?? "not linked"}`);
    }

    console.log(
      `[0078] linked ${linked}/${plan.length} orphan card charges`,
      skipped.length ? { skipped } : {},
    );
    return {
      dryRun: false,
      orphansFound: orphans.length,
      linkable: plan.length,
      linked,
      plan: plan.map((p) => p.label),
      skipped,
    };
  },
});
