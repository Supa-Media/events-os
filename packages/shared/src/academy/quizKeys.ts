/**
 * Stable per-question keys — how a quiz submission survives a content change.
 *
 * The Academy curriculum ships in TWO independently-deployed places: the
 * Convex backend (deployed the moment a PR merges) and the mobile app bundle
 * (whatever build/OTA the learner happens to be running). So the reader's quiz
 * and the grader's quiz are the same source file but not always the same
 * VERSION — add a question and every already-installed app is one question
 * behind until an OTA lands.
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
