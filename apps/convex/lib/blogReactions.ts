/**
 * Blog reactions — the pure validation/shaping half of the emoji bar under
 * every post on the marketing site (apps/landing/src/components/blog/).
 *
 * Kept free of `ctx` so the rules can be unit-tested directly (see
 * tests/blogReactions.test.ts) and so `blog.ts` reads as data flow rather
 * than validation.
 *
 * The reader is ANONYMOUS here — there is no login on publicworship.life, so
 * a reaction is keyed by `actorKey`, a random id the browser mints once and
 * keeps in localStorage. That is deliberately not an identity: it stops the
 * same reader double-counting a post by accident and lets them un-react, and
 * nothing more. Somebody determined to inflate a count can clear storage and
 * react again. We accept that — these numbers are a warmth signal for the
 * writers, never a metric anything depends on.
 */
import { ConvexError } from "convex/values";

/**
 * The emoji a reader may leave, in display order.
 *
 * THIS LIST IS THE SERVER'S AUTHORITY. The landing site paints its bar from
 * the same set (apps/landing/src/components/blog/Reactions.astro) so the row
 * renders before the counts arrive — hand-synced, and deliberately so: the
 * landing app has no dependency on this workspace, and adding one would mean
 * a lockfile change for five strings. If the two drift, the client shows an
 * emoji this rejects with UNKNOWN_EMOJI; nothing else breaks.
 */
// 🤔 is deliberate: a bar with only positive taps can't tell the writers a
// post DIDN'T land, and inviting disagreement is part of the philosophy the
// first post argues for.
export const BLOG_REACTION_EMOJIS = ["🙏", "🙌", "❤️", "🔥", "💡", "🤔"] as const;

export type BlogReactionEmoji = (typeof BLOG_REACTION_EMOJIS)[number];

/**
 * Counts for one post: an ORDERED ARRAY, not an emoji-keyed object.
 *
 * That is a hard Convex constraint, not a style choice — object field names
 * must be non-control ASCII, so `{"🙏": 3}` is rejected at the serialization
 * boundary before it ever reaches the client. The array carries the display
 * order for free, which the client would otherwise have to reconstruct.
 */
export type BlogReactionCounts = Array<{ emoji: string; count: number }>;

const MAX_SLUG_LENGTH = 128;
const MAX_ACTOR_KEY_LENGTH = 64;
const MIN_ACTOR_KEY_LENGTH = 8;

/**
 * A post slug as it appears in the landing site's content collection —
 * lowercase, hyphenated, optionally nested one level (`series/part-one`).
 *
 * Validated rather than trusted because the slug is a free-string key: an
 * unbounded one would let anyone write rows this backend can never surface.
 */
export function normalizeSlug(input: unknown): string {
  const slug = String(input ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (!slug) {
    throw new ConvexError({ code: "BAD_SLUG", message: "Missing post." });
  }
  if (slug.length > MAX_SLUG_LENGTH || !/^[a-z0-9][a-z0-9\-/]*$/.test(slug)) {
    throw new ConvexError({ code: "BAD_SLUG", message: "Unknown post." });
  }
  return slug;
}

/**
 * The reader's browser-local id. Length-bounded and charset-bounded so the
 * table can't be used as free storage; never logged, never shown.
 */
export function normalizeActorKey(input: unknown): string {
  const key = String(input ?? "").trim();
  if (
    key.length < MIN_ACTOR_KEY_LENGTH ||
    key.length > MAX_ACTOR_KEY_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(key)
  ) {
    throw new ConvexError({
      code: "BAD_ACTOR",
      message: "Couldn't record that reaction. Try reloading the page.",
    });
  }
  return key;
}

/** An emoji off the allowlist, or a refusal. Nothing else is ever stored. */
export function normalizeEmoji(input: unknown): BlogReactionEmoji {
  const emoji = String(input ?? "").trim();
  const match = BLOG_REACTION_EMOJIS.find((e) => e === emoji);
  if (!match) {
    throw new ConvexError({
      code: "UNKNOWN_EMOJI",
      message: "That reaction isn't available.",
    });
  }
  return match;
}

/** Zero-filled counts — so the bar renders every emoji, not just used ones. */
export function emptyCounts(): BlogReactionCounts {
  return BLOG_REACTION_EMOJIS.map((emoji) => ({ emoji, count: 0 }));
}

/** Tally stored rows into zero-filled, display-ordered counts. */
export function tally(
  rows: ReadonlyArray<{ emoji: string }>,
): BlogReactionCounts {
  const counts = new Map<string, number>(
    BLOG_REACTION_EMOJIS.map((emoji) => [emoji, 0]),
  );
  for (const row of rows) {
    // Defensive: an emoji dropped from the allowlist after rows were written
    // stays in the table but is not surfaced, so retiring one is safe.
    const current = counts.get(row.emoji);
    if (current !== undefined) counts.set(row.emoji, current + 1);
  }
  return BLOG_REACTION_EMOJIS.map((emoji) => ({
    emoji,
    count: counts.get(emoji) ?? 0,
  }));
}

/** The count for one emoji — a small read-side convenience for callers/tests. */
export function countOf(counts: BlogReactionCounts, emoji: string): number {
  return counts.find((c) => c.emoji === emoji)?.count ?? 0;
}
