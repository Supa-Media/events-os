/**
 * Client-side quiz answer shuffling — a pure, deterministic helper.
 *
 * The quiz UI shuffles the DISPLAY ORDER of a question's options so retakes
 * don't reward memorizing "the third one". Everything else — selection
 * tracking, the submit payload, and correct/wrong highlighting — keeps using
 * each option's ORIGINAL index, so the server (which grades against original
 * indices) is untouched. This helper only decides display order.
 *
 * Determinism matters for two reasons:
 *  - a render must not reshuffle (that would fight the user mid-attempt and, on
 *    web, cause hydration mismatches), so the order is derived from a stable
 *    seed rather than `Math.random()` at render time; and
 *  - it's trivially unit-testable (same seed → same permutation).
 *
 * The caller picks a fresh seed once per attempt (in a `useState` initializer
 * or a reset effect — an event/mount boundary, never render), so "reshuffle on
 * retake" is just "pick a new seed".
 */

/**
 * splitmix32 — a tiny, dependency-free seeded PRNG. Given a 32-bit seed it
 * yields a deterministic stream of floats in [0, 1). Good enough to shuffle a
 * handful of quiz options; not cryptographic.
 */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

/**
 * The ORIGINAL option indices `[0..optionCount)` in a deterministic shuffled
 * display order, derived from `seed` via a seeded Fisher-Yates shuffle. The
 * same `(optionCount, seed)` always returns the same permutation; different
 * seeds usually differ. The result is always a valid permutation of
 * `[0..optionCount)`.
 */
export function shuffledOptionOrder(
  optionCount: number,
  seed: number,
): number[] {
  const order = Array.from({ length: Math.max(0, optionCount) }, (_, i) => i);
  const rand = splitmix32(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}
