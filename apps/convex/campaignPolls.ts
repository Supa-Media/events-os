/**
 * Campaign polls — the read/write half of the public
 * `/poll/<campaignId>/<token>/<blockId>/<optionId>` route (`http.ts`,
 * rendering in `lib/pollPage.ts`), plus the in-app results query.
 *
 * ── Why a poll vote is not a simple link ───────────────────────────────────
 * A `poll` block renders each option as an ordinary `<a href>` in the email
 * (`emailRender.ts#renderPollBlock`). Apple Mail Privacy Protection, Outlook
 * Safe Links, and every corporate link scanner FETCH EVERY HREF in a message
 * before a human ever sees it — so recording a vote on GET would give every
 * option in every poll a phantom vote at delivery time, and the tally would be
 * garbage before the first real reader opened the email. GET therefore renders
 * a CONFIRM page and writes nothing; the vote is recorded only by the POST
 * that page's button issues. This is the exact same split
 * `/unsubscribe/<token>` uses, for the exact same reason (see
 * `lib/unsubscribePage.ts`'s module doc).
 *
 * ── Identity ───────────────────────────────────────────────────────────────
 * The voter is identified by their `campaignRecipients.unsubscribeToken` — the
 * per-recipient random already minted for every send (`insertRecipientBatch`),
 * reused rather than adding a second secret to every URL. Possession of the
 * token IS the credential, exactly as it is for unsubscribe; there is no
 * account and no login on this surface.
 *
 * ── Forgery ────────────────────────────────────────────────────────────────
 * `resolvePollContext` verifies the token resolves to a recipient, that the
 * recipient belongs to the campaign named in the URL, that `blockId` names a
 * real `poll` block in that campaign's stored document, AND that `optionId` is
 * one of that block's options. A hand-edited URL therefore 404s instead of
 * creating a tally row for an option nobody can see — otherwise anyone holding
 * one valid token could invent unlimited fake options and poison the results.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCampaignsAccess } from "./lib/campaignsAccess";
import { AUDIENCE_RESOLVE_LIMIT } from "./lib/audienceResolve";

/**
 * How many vote rows one poll block's tally will read.
 *
 * The guidelines forbid `.collect().length` for counting, and offer two ways
 * out: a denormalized counter, or a bounded read. This takes the BOUNDED READ,
 * because the bound here is a real structural invariant rather than a hopeful
 * cap: `campaignPollVotes` holds at most ONE row per (recipient, block) — a
 * re-vote patches, never inserts (see `recordPollVote`) — and a campaign's
 * recipient list is itself hard-capped at `AUDIENCE_RESOLVE_LIMIT` when it is
 * materialized (`lib/audienceResolve.ts`). So a block's votes can never exceed
 * that number, and `.take()` at one above it reads the whole set every time
 * while still being a bounded query.
 *
 * A counter document was the alternative and is deliberately NOT used: it
 * would add a second write to the hottest path in the feature, and a re-vote
 * (the one operation this table is designed around) would have to DECREMENT
 * the old option and INCREMENT the new one atomically — two counters that can
 * drift, to save a read that is already bounded at 5,000 rows. `truncated`
 * below is the honesty valve: if `AUDIENCE_RESOLVE_LIMIT` is ever raised past
 * this cap, the results surface says so instead of quietly under-reporting.
 */
const POLL_TALLY_CAP = AUDIENCE_RESOLVE_LIMIT + 1;

/** Bound on how many poll blocks one campaign's results query walks. A single
 *  email with more than this many polls is not a real document. */
const POLL_BLOCKS_PER_CAMPAIGN = 25;

/**
 * Total vote rows `getPollResults` may read across ALL of a campaign's poll
 * blocks in one query.
 *
 * The per-block cap alone was not enough: `POLL_BLOCKS_PER_CAMPAIGN` (25) x
 * `POLL_TALLY_CAP` (5001) is ~125,000 documents, far past Convex's
 * per-transaction read limit, and `validateEmailDocument` caps neither the
 * block count nor the number of poll blocks — so four polls on a large
 * campaign already reach it. The failure mode was a hard-throwing campaign
 * detail screen, which is worse than an approximate tally.
 *
 * The budget is spent block-by-block, in document order, and any block that
 * hits it reports `truncated: true` rather than silently under-reporting.
 */
const POLL_RESULTS_READ_BUDGET = 8000;

type PollOption = { id: string; label: string };
type PollBlock = { id: string; kind: "poll"; question: string; options: PollOption[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `poll` block in a stored `EmailDocument`, read DEFENSIVELY: `doc` is
 *  `v.any()` in the schema, and a row could predate any given block kind, so
 *  anything that isn't shaped like a poll is skipped rather than trusted. */
function pollBlocksOf(doc: unknown): PollBlock[] {
  if (!isPlainObject(doc) || !Array.isArray(doc.blocks)) return [];
  const out: PollBlock[] = [];
  for (const block of doc.blocks) {
    if (!isPlainObject(block)) continue;
    if (block.kind !== "poll") continue;
    if (typeof block.id !== "string" || typeof block.question !== "string") continue;
    if (!Array.isArray(block.options)) continue;
    const options: PollOption[] = [];
    for (const opt of block.options) {
      if (!isPlainObject(opt)) continue;
      if (typeof opt.id !== "string" || typeof opt.label !== "string") continue;
      options.push({ id: opt.id, label: opt.label });
    }
    out.push({ id: block.id, kind: "poll", question: block.question, options });
  }
  return out;
}

type PollContext = {
  campaign: Doc<"campaigns">;
  recipient: Doc<"campaignRecipients">;
  block: PollBlock;
  option: PollOption;
};

/**
 * Resolve a `/poll/` URL's four segments into the rows they name, or `null`
 * when ANY of them fails to line up — an unknown/expired token, a token from a
 * DIFFERENT campaign than the URL claims, a `blockId` that isn't a poll in
 * this campaign's document, or an `optionId` that block never offered.
 *
 * `null` is deliberately undifferentiated: the route turns every one of those
 * into the same 404 page, so a probe can't learn which part of a guessed URL
 * was the wrong part.
 */
async function resolvePollContext(
  ctx: QueryCtx,
  args: { campaignId: Id<"campaigns">; token: string; blockId: string; optionId: string },
): Promise<PollContext | null> {
  const recipient = await ctx.db
    .query("campaignRecipients")
    .withIndex("by_token", (q) => q.eq("unsubscribeToken", args.token))
    .first();
  if (!recipient) return null;
  if (recipient.campaignId !== args.campaignId) return null;

  const campaign = await ctx.db.get(args.campaignId);
  if (!campaign) return null;

  const block = pollBlocksOf(campaign.doc).find((b) => b.id === args.blockId);
  if (!block) return null;
  const option = block.options.find((o) => o.id === args.optionId);
  if (!option) return null;

  return { campaign, recipient, block, option };
}

/** Count this block's votes per option, bounded by `POLL_TALLY_CAP` — see its
 *  doc for why a bounded read (and not a denormalized counter) is the right
 *  shape here. Options are returned in the DOCUMENT's order, including any
 *  with zero votes, so the tally reads like the email did. */
async function tallyBlock(
  ctx: QueryCtx,
  campaignId: Id<"campaigns">,
  block: PollBlock,
  /** Max rows this call may read. The caller decrements a shared budget so a
   *  many-poll campaign can't blow the transaction read limit — see
   *  `POLL_RESULTS_READ_BUDGET`. */
  readBudget: number = POLL_TALLY_CAP,
): Promise<{
  blockId: string;
  question: string;
  totalVotes: number;
  truncated: boolean;
  options: { optionId: string; label: string; count: number }[];
}> {
  const votes = await ctx.db
    .query("campaignPollVotes")
    .withIndex("by_campaign_and_block", (q) =>
      q.eq("campaignId", campaignId).eq("blockId", block.id),
    )
    .take(Math.max(1, Math.min(POLL_TALLY_CAP, readBudget)));

  const counts = new Map<string, number>();
  for (const vote of votes) {
    counts.set(vote.optionId, (counts.get(vote.optionId) ?? 0) + 1);
  }
  return {
    blockId: block.id,
    question: block.question,
    totalVotes: votes.length,
    truncated: votes.length >= Math.min(POLL_TALLY_CAP, readBudget),
    options: block.options.map((o) => ({
      optionId: o.id,
      label: o.label,
      count: counts.get(o.id) ?? 0,
    })),
  };
}

const tallyValidator = v.object({
  blockId: v.string(),
  question: v.string(),
  totalVotes: v.number(),
  truncated: v.boolean(),
  options: v.array(
    v.object({ optionId: v.string(), label: v.string(), count: v.number() }),
  ),
});

/** What both `/poll/` handlers need to render a themed page: the question, the
 *  option that was tapped, and the campaign's OWN theme (raw, straight off the
 *  stored document — `lib/pollPage.ts` runs it through `normalizeEmailTheme`,
 *  the permissive read edge, exactly like the renderer does). */
const pollViewValidator = v.object({
  question: v.string(),
  optionLabel: v.string(),
  /** The document's inline `EmailTheme`, or null when it has none. */
  theme: v.any(),
});

/**
 * READ-ONLY lookup for the GET confirm page. Records NOTHING — that is the
 * whole point of this function existing separately from `recordPollVote` (see
 * the module doc on link prefetching).
 */
export const getPollContext = internalQuery({
  args: {
    campaignId: v.id("campaigns"),
    token: v.string(),
    blockId: v.string(),
    optionId: v.string(),
  },
  returns: v.union(pollViewValidator, v.null()),
  handler: async (ctx, args) => {
    const context = await resolvePollContext(ctx, args);
    if (!context) return null;
    return {
      question: context.block.question,
      optionLabel: context.option.label,
      // `doc` is v.any(); guard rather than optional-chaining so a non-object
      // stored doc can't surface a garbage theme. Matches recordPollVote.
      theme: isPlainObject(context.campaign.doc)
        ? (context.campaign.doc.theme ?? null)
        : null,
    };
  },
});

/**
 * Record the vote (POST only) and return the resulting tally.
 *
 * UPSERT, never insert: `by_recipient_and_block` finds this recipient's
 * existing answer to this block and PATCHES it. That index is what makes
 * one-vote-per-person-per-poll true — a recipient who taps "Sunday", changes
 * their mind, and taps "Wednesday" ends with one row reading "Wednesday", not
 * two rows splitting their single opinion across both options. It also makes
 * the endpoint idempotent under the retries a flaky mobile connection
 * produces: re-POSTing the same option is a no-op patch, not a second vote.
 *
 * Re-resolves the whole context itself rather than trusting anything the GET
 * page computed — the POST is a separate, independently forgeable request.
 */
/**
 * The tally for one block, read OUTSIDE the vote transaction.
 *
 * `recordPollVote` used to compute this itself, which meant every POST both
 * READ the entire `by_campaign_and_block` range and WROTE into it. Under a
 * real blast that makes each voter's read set overlap every other voter's
 * write — guaranteed OCC contention on the hottest path in the feature,
 * retried until Convex gives up. Splitting the read into its own transaction
 * removes the overlap entirely; the thanks page just fetches it after the
 * vote lands. A slightly stale count on a confirmation page is worth far more
 * than a contended write.
 */
export const getPollTally = internalQuery({
  args: { campaignId: v.id("campaigns"), blockId: v.string() },
  returns: v.union(tallyValidator, v.null()),
  handler: async (ctx, { campaignId, blockId }) => {
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) return null;
    const block = pollBlocksOf(campaign.doc).find((b) => b.id === blockId);
    if (!block) return null;
    return await tallyBlock(ctx, campaignId, block);
  },
});

export const recordPollVote = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    token: v.string(),
    blockId: v.string(),
    optionId: v.string(),
  },
  returns: v.union(
    v.object({
      question: v.string(),
      optionLabel: v.string(),
      theme: v.any(),
    }),
    v.null(),
  ),
  handler: async (ctx: MutationCtx, args) => {
    const context = await resolvePollContext(ctx, args);
    if (!context) return null;

    const existing = await ctx.db
      .query("campaignPollVotes")
      .withIndex("by_recipient_and_block", (q) =>
        q.eq("recipientId", context.recipient._id).eq("blockId", args.blockId),
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { optionId: args.optionId, votedAt: now });
    } else {
      await ctx.db.insert("campaignPollVotes", {
        campaignId: args.campaignId,
        recipientId: context.recipient._id,
        blockId: args.blockId,
        optionId: args.optionId,
        votedAt: now,
      });
    }

    return {
      question: context.block.question,
      optionLabel: context.option.label,
      theme: isPlainObject(context.campaign.doc)
        ? (context.campaign.doc.theme ?? null)
        : null,
    };
  },
});

/** Per-block, per-option vote counts for the campaign detail screen. Returns
 *  `[]` for a campaign whose document has no poll blocks (the common case), so
 *  the UI can hide the section without a second query. Counting strategy and
 *  its bound: see `POLL_TALLY_CAP`. */
export const getPollResults = query({
  args: { campaignId: v.id("campaigns") },
  returns: v.array(tallyValidator),
  handler: async (ctx, { campaignId }) => {
    await requireCampaignsAccess(ctx);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found." });
    }
    const blocks = pollBlocksOf(campaign.doc).slice(0, POLL_BLOCKS_PER_CAMPAIGN);
    const results = [];
    let budget = POLL_RESULTS_READ_BUDGET;
    for (const block of blocks) {
      const tally = await tallyBlock(ctx, campaignId, block, budget);
      budget -= tally.totalVotes;
      results.push(tally);
      // Every remaining block would read zero rows and report a false 0 —
      // stop instead, so the surface shows fewer blocks rather than wrong ones.
      if (budget <= 0) break;
    }
    return results;
  },
});
