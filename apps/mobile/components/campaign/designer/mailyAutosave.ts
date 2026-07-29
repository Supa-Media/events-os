/**
 * MAILY AUTOSAVE — the debounce + in-flight-re-save DECISIONS, as pure data.
 *
 * `BlocksDocumentComposer`'s autosave (the same discipline, unmodified) gets
 * to key its "did anything actually change" check off `history.present`'s
 * object IDENTITY, because `pushHistory` only ever hands out a fresh
 * reference on a real edit and undo/redo lands back on an EARLIER exact
 * reference. Tiptap's `editor.getJSON()` has no such guarantee — it builds a
 * brand-new object on every call, edit or not — so the maily host compares
 * SERIALIZED content instead (`docsEqual`) and this module is what stays
 * pure and testable while that comparison lives here rather than duplicated
 * inline in `MailyDocumentHost.web.tsx`'s effects.
 *
 * Two decisions, both mirrored 1:1 from `DocumentComposer.tsx`'s existing
 * autosave effect and `saveDoc` completion handler — see that file's comments
 * for the full "why" on each:
 *
 *  - `decideAutosave` — whether an autosave should fire at all right now
 *    (nothing to save, save already scheduled/in flight, or genuinely
 *    locked), and the one case where a STUCK error indicator should clear
 *    itself even though no new save is needed (the "typed half a doc, undid
 *    it, now agrees with the server" case).
 *  - `shouldResaveAfterCompletion` — whether a save that just landed is
 *    already stale because a newer edit arrived while it was in flight, so
 *    the newer content gets pushed immediately instead of waiting out
 *    another full debounce window.
 */

/** Debounce between the last edit and the autosave call — same value
 *  `DocumentComposer.tsx` uses, so the two composers feel identical. */
export const MAILY_AUTOSAVE_DEBOUNCE_MS = 600;

export type AutosaveDecision =
  /** Nothing to do — locked, or content already matches what's saved. */
  | { action: "skip" }
  /** Content matches what's saved, but a STALE error indicator (from a save
   *  that has since been undone by hand) should be cleared to "saved". */
  | { action: "clear-error" }
  /** Schedule a debounced save. */
  | { action: "schedule"; delayMs: number };

/**
 * `editable` false means read-only — see `MailyDocumentHost`'s doc for why
 * that must never schedule a save regardless of what else changed (the
 * "verify no mutation on mount/while locked" guarantee this function makes
 * checkable without mounting a component).
 */
export function decideAutosave(params: {
  editable: boolean;
  /** Serialized current doc !== serialized last-saved doc. */
  changed: boolean;
  /** The indicator is currently showing a save failure. */
  showingError: boolean;
}): AutosaveDecision {
  if (!params.editable) return { action: "skip" };
  if (!params.changed) {
    return params.showingError ? { action: "clear-error" } : { action: "skip" };
  }
  return { action: "schedule", delayMs: MAILY_AUTOSAVE_DEBOUNCE_MS };
}

/**
 * A save for `justSaved` just resolved. `latest` is whatever the editor holds
 * RIGHT NOW (read through a ref at completion time, not captured in the save
 * call's own closure) — if it has moved on, the save that just finished is
 * already stale and the new content must go out immediately rather than
 * waiting for another 600ms of stillness that may never come (the user could
 * easily have stopped typing exactly because they believe the last change
 * already saved).
 */
export function shouldResaveAfterCompletion(justSaved: string, latest: string): boolean {
  return justSaved !== latest;
}
