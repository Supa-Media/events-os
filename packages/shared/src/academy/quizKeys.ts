/**
 * Stable per-question keys — how a quiz submission survives a content change.
 *
 * The Academy curriculum ships in TWO places that go live independently: the
 * Convex backend (deployed the moment a PR merges) and the JS bundle actually
 * EXECUTING on the learner's device. Those are not the same thing as the two
 * deploy workflows, which run within minutes of each other — publishing an OTA
 * is not the same as running one. expo-updates downloads in the background and
 * applies on a later launch, so a device keeps executing the bundle it already
 * had until it cold-starts again; a phone that just sits in someone's pocket,
 * or a web tab left open, can be days behind a green deploy. So the reader's
 * quiz and the grader's quiz are the same source file but routinely not the
 * same VERSION.
 *
 * A submission that identifies its questions only by position can't survive
 * that: the grader has no way to tell "answer #3 of the old five" from
 * "answer #3 of the new six". So the client sends a key per question and the
 * server grades each answer against the question it was actually shown for,
 * ignoring questions the client never saw.
 *
 * The key is derived from the prompt text rather than authored by hand, which
 * means content authors get this for free — no id to remember, no id to
 * collide. Rewording a prompt intentionally mints a new key: a reworded
 * question IS a different question, and grading a stale answer against it
 * would be the exact bug this file exists to prevent.
 */

/**
 * A short, stable key for a quiz question, derived from its prompt via FNV-1a
 * (32-bit, hex). Not cryptographic and not collision-proof in general — it
 * only has to separate a handful of prompts inside ONE section, where the
 * authoring rules already forbid duplicate prompts.
 */
export function quizQuestionKey(prompt: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < prompt.length; i++) {
    hash ^= prompt.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
