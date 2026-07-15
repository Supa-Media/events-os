/**
 * Legacy (Relay) card linking for Chapter OS.
 *
 * A LEGACY card is an external card (e.g. a Relay card) the chapter already uses
 * outside Increase. Its charges arrive via the Stripe FC sync as `stripe_fc`
 * transactions whose card last-4 is parsed into `transactions.cardLast4`. LINKING
 * a legacy card records a `cards` row (`source:"legacy"`, no `increaseCardId`)
 * that binds a last-4 to a person, then ATTRIBUTES that last-4's transactions to
 * them — so an external card's spend becomes someone's responsibility without an
 * Increase object.
 *
 * INVARIANTS:
 *  - Cards are restricted to Public Worship staff: a legacy card can only be
 *    linked to a person with an `@publicworship.life` email (`isCardEligible`),
 *    else `ConvexError NOT_CARD_ELIGIBLE`.
 *  - One legacy card per (chapter, last-4) — linking is idempotent (re-link
 *    re-points the same row instead of duplicating).
 *  - Attribution never clobbers a human's categorization: a transaction already
 *    carrying a `cardId`/`personId` is left as-is (except re-pointing this card's
 *    own rows to a re-linked cardholder).
 *  - Money is integer cents; every id is verified in the caller's chapter.
 *  - All failures throw `ConvexError` (never a plain `Error`).
 *
 * Gating (finance-role ladder viewer < bookkeeper < manager):
 *  - listRelayCardCandidates                       → viewer
 *  - linkRelayCard / unlinkRelayCard               → manager
 */
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { isCardEligible } from "@events-os/shared";
import { requireChapterId, getChapterIdOrNull, requireInChapter } from "./lib/context";
import { requireFinanceRole, requireFinanceManager } from "./lib/finance";

/** Keep the per-chapter transaction scans bounded. */
const TXN_SCAN_LIMIT = 5000;
/** Keep the per-chapter transaction candidate scan bounded. */
const CANDIDATE_SCAN_LIMIT = 5000;

/** The linked-card projection shown against a Relay candidate last-4. */
const linkedCardValidator = v.object({
  cardId: v.id("cards"),
  personId: v.id("people"),
  personName: v.union(v.string(), v.null()),
});

const relayCandidateValidator = v.object({
  last4: v.string(),
  txnCount: v.number(),
  spentCents: v.number(),
  linkedCard: v.union(linkedCardValidator, v.null()),
});

/** Find the LEGACY card in a chapter that owns a last-4, or null. */
async function legacyCardForLast4(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  last4: string,
): Promise<Doc<"cards"> | null> {
  const matches = await ctx.db
    .query("cards")
    .withIndex("by_chapter_and_last4", (q) =>
      q.eq("chapterId", chapterId).eq("last4", last4),
    )
    .collect();
  return matches.find((c) => c.source === "legacy") ?? null;
}

/**
 * The distinct card last-4s seen on ANY of this chapter's spend transactions
 * that carry a parsed last-4 — both the ~90-day FC-synced (`stripe_fc`) window
 * AND the full CSV-imported (`relay_csv`) history (plus any other source that
 * stamps a `cardLast4`). This is the "Relay cards to link" list. Aggregating
 * across sources is what surfaces cards used only BEFORE the FC window, which
 * live solely on `relay_csv` rows. Each entry carries how many charges it has,
 * total spend (outflow cents), and the linked legacy card when one exists.
 * Viewer+.
 */
export const listRelayCardCandidates = query({
  args: {},
  returns: v.array(relayCandidateValidator),
  handler: async (ctx) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");

    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CANDIDATE_SCAN_LIMIT);

    // Aggregate every row that carries a parsed last-4, regardless of source
    // (`stripe_fc`, `relay_csv`, …) — so a card seen only in CSV-imported
    // history (before the FC window) is still surfaced as a candidate.
    const byLast4 = new Map<string, { txnCount: number; spentCents: number }>();
    for (const r of rows) {
      if (!r.cardLast4) continue;
      const agg = byLast4.get(r.cardLast4) ?? { txnCount: 0, spentCents: 0 };
      agg.txnCount++;
      // Spend = outflow cents (inflows/refunds don't count as card spend).
      if (r.flow === "outflow") agg.spentCents += r.amountCents;
      byLast4.set(r.cardLast4, agg);
    }

    const out = [];
    for (const [last4, agg] of byLast4) {
      const card = await legacyCardForLast4(ctx, chapterId, last4);
      let linkedCard: typeof linkedCardValidator.type | null = null;
      if (card) {
        const holder = await ctx.db.get(card.cardholderPersonId);
        linkedCard = {
          cardId: card._id,
          personId: card.cardholderPersonId,
          personName: holder?.name ?? null,
        };
      }
      out.push({
        last4,
        txnCount: agg.txnCount,
        spentCents: agg.spentCents,
        linkedCard,
      });
    }
    // Stable order: most-charged first, then by last-4.
    out.sort((a, b) => b.txnCount - a.txnCount || a.last4.localeCompare(b.last4));
    return out;
  },
});

/**
 * Link a legacy (Relay) card last-4 to a person and attribute its existing
 * transactions to them. Manager-only. The person must be card-eligible
 * (`@publicworship.life`) or this throws `NOT_CARD_ELIGIBLE`. Idempotent: one
 * legacy card per (chapter, last-4) — re-linking re-points the same row to the
 * new cardholder (and re-points its already-attributed transactions). New
 * attribution only sets `cardId`/`personId` where BOTH are unset, never
 * clobbering a human's categorization.
 */
export const linkRelayCard = mutation({
  args: { last4: v.string(), personId: v.id("people") },
  returns: v.object({ cardId: v.id("cards"), attributed: v.number() }),
  handler: async (ctx, args): Promise<{ cardId: Id<"cards">; attributed: number }> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const last4 = args.last4.trim();
    if (!/^\d{4}$/.test(last4)) {
      throw new ConvexError({
        code: "INVALID_LAST4",
        message: "A card last-4 must be exactly four digits.",
      });
    }

    const person = await ctx.db.get(args.personId);
    await requireInChapter(ctx, chapterId, person, "Person");
    if (!isCardEligible(person!.pwEmail)) {
      throw new ConvexError({
        code: "NOT_CARD_ELIGIBLE",
        message:
          "A card can only be linked to a person with a @publicworship.life email.",
      });
    }

    // Upsert the one legacy card for this (chapter, last-4).
    const existing = await legacyCardForLast4(ctx, chapterId, last4);
    let cardId: Id<"cards">;
    if (existing) {
      if (existing.cardholderPersonId !== args.personId) {
        await ctx.db.patch(existing._id, { cardholderPersonId: args.personId });
      }
      cardId = existing._id;
    } else {
      cardId = await ctx.db.insert("cards", {
        chapterId,
        cardholderPersonId: args.personId,
        type: "physical",
        source: "legacy",
        last4,
        status: "active",
        createdAt: Date.now(),
      });
    }

    // Attribute this last-4's transactions to the card + cardholder.
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_last4", (q) =>
        q.eq("chapterId", chapterId).eq("cardLast4", last4),
      )
      .take(TXN_SCAN_LIMIT);
    let attributed = 0;
    for (const t of txns) {
      if (t.cardId == null && t.personId == null) {
        // Unattributed → attribute (never clobber a human's categorization).
        await ctx.db.patch(t._id, { cardId, personId: args.personId });
        attributed++;
      } else if (t.cardId === cardId && t.personId !== args.personId) {
        // A re-link: keep THIS card's own rows pointing at the new cardholder.
        await ctx.db.patch(t._id, { personId: args.personId });
      }
    }

    return { cardId, attributed };
  },
});

/**
 * Unlink a legacy (Relay) card: delete the `cards` row and clear the
 * `cardId`/`personId` it set on its attributed transactions (bounded to that
 * card's own rows via `by_card`). Manager-only. Rejects a non-legacy card.
 */
export const unlinkRelayCard = mutation({
  args: { cardId: v.id("cards") },
  returns: v.object({ cleared: v.number() }),
  handler: async (ctx, args): Promise<{ cleared: number }> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const card = await ctx.db.get(args.cardId);
    await requireInChapter(ctx, chapterId, card, "Card");
    if (card!.source !== "legacy") {
      throw new ConvexError({
        code: "NOT_A_LEGACY_CARD",
        message: "Only a legacy (Relay) card can be unlinked.",
      });
    }

    // Clear attribution on exactly the transactions this card set (its own rows).
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_card", (q) => q.eq("cardId", args.cardId))
      .take(TXN_SCAN_LIMIT);
    let cleared = 0;
    for (const t of txns) {
      await ctx.db.patch(t._id, { cardId: undefined, personId: undefined });
      cleared++;
    }

    await ctx.db.delete(args.cardId);
    return { cleared };
  },
});
