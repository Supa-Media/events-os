/**
 * Shared merchant-string tokenization + similarity primitives.
 *
 * Extracted from `reconcileSuggest.ts` (the "For" picker's tier-1/2 evidence
 * ranker) back when a second consumer — the AI auto-coding evidence builder —
 * needed the SAME normalization/tokenization/overlap rules. That consumer is
 * gone; the file stays split out because these are pure primitives with their
 * own unit tests (`tests/merchantSimilarity.test.ts`) and `reconcileSuggest.ts`
 * is a query module, not a home for string algebra.
 *
 * Pure functions, no Convex imports — trivially unit-testable and safe to
 * import from either the Node (action) or default (query/mutation) runtime.
 */

/** Noise words filtered from MERCHANT similarity so "SQ *HOME DEPOT INC"
 *  fuzzy-matches "Home Depot Supply Co" without every merchant string
 *  spuriously overlapping on "inc"/"co"/"the". NOT applied to label search
 *  (a literal word in an event/project name still has to be matchable — see
 *  `reconcileSuggest.labelTokens`). */
export const MERCHANT_STOPWORDS = new Set([
  "inc",
  "llc",
  "corp",
  "co",
  "the",
  "sq",
  "pos",
  "payment",
  "purchase",
  "store",
  "of",
  "and",
  "a",
  "an",
]);

/** Trim + lowercase a merchant/description string for EXACT comparison. */
export function normalizeMerchantText(text: string | null | undefined): string {
  return (text ?? "").trim().toLowerCase();
}

/** Shared base tokenizer — lowercase, strip to alnum + space, split on
 *  whitespace. Deliberately applies NO stopword/length filtering: that's a
 *  policy decision each CALLER makes on top (merchant-similarity filters noise
 *  words; label search must not). */
export function baseTokens(text: string | null | undefined): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Merchant/description similarity token set — noise words and 1-char tokens
 *  filtered (see `MERCHANT_STOPWORDS`). */
export function merchantTokens(
  ...texts: (string | null | undefined)[]
): Set<string> {
  const combined = texts.filter(Boolean).join(" ");
  return new Set(
    baseTokens(combined).filter(
      (t) => t.length > 1 && !MERCHANT_STOPWORDS.has(t),
    ),
  );
}

/** A minimal merchant-bearing record — the fields both the picker ranker and
 *  the evidence builder compare on. */
export interface MerchantLike {
  merchantName?: string | null;
  description?: string | null;
}

/**
 * How a candidate transaction resembles the subject charge's merchant:
 *  - `"exact"` — normalized merchant OR description string is identical,
 *  - `"fuzzy"` — at least one shared merchant token (noise words removed),
 *  - `null` — no resemblance.
 * This is the single definition both `reconcileSuggest`'s tier-2 evidence and
 * the LLM evidence builder use, so "similar merchant" means one thing.
 */
export function merchantMatch(
  subject: MerchantLike,
  candidate: MerchantLike,
): "exact" | "fuzzy" | null {
  const subjMerchant = normalizeMerchantText(subject.merchantName);
  const subjDesc = normalizeMerchantText(subject.description);
  const candMerchant = normalizeMerchantText(candidate.merchantName);
  const candDesc = normalizeMerchantText(candidate.description);
  const exact =
    (!!subjMerchant && subjMerchant === candMerchant) ||
    (!!subjDesc && subjDesc === candDesc);
  if (exact) return "exact";
  const subjTokens = merchantTokens(subject.merchantName, subject.description);
  if (subjTokens.size === 0) return null;
  const candTokens = merchantTokens(candidate.merchantName, candidate.description);
  const shared = [...subjTokens].some((tok) => candTokens.has(tok));
  return shared ? "fuzzy" : null;
}
