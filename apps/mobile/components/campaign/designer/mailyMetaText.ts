/**
 * MAILY INLINE META — the pure copy/decision logic behind the Subject/Preview
 * text/From strip `MailyDocumentHost` shows above the document (the
 * founder's screenshot: "meta fields inline at the top"). Split out so it's
 * unit-testable the `targetingText.ts` way, and so the eager-save-on-blur
 * rules can't drift from `CampaignMetaCard.tsx`'s (the same mutations, the
 * same "empty resets rather than saves" guard).
 */

/** The read-only "From" line — sender settings, never editable here (the
 *  founder's spec: the maily host shows it, `CampaignMetaCard` on the record
 *  is still where it's changed). Mirrors the hint text
 *  `CampaignMetaCard.tsx` already shows next to the From fields. */
export function fromLineText(params: {
  fromName?: string | null;
  fromEmail?: string | null;
  orgFromAddress?: string | null;
}): string {
  const { fromName, fromEmail, orgFromAddress } = params;
  const address = fromEmail || orgFromAddress || "the org default";
  if (fromName) return `${fromName} <${address}>`;
  return address;
}

export type FieldSaveDecision =
  /** Nothing to send — unchanged, or a blank that should just reset. */
  | { action: "reset" }
  | { action: "skip" }
  | { action: "save"; value: string };

/**
 * Blur-save decision for the Subject field. Mirrors
 * `CampaignMetaCard.tsx#saveSubject`: a whitespace-only value resets to the
 * last-saved subject (the server throws `EMPTY` on a blank subject, and
 * without this guard the field would show text that LOOKS saved but isn't).
 */
export function subjectSaveDecision(draft: string, saved: string): FieldSaveDecision {
  const trimmed = draft.trim();
  if (!trimmed) return { action: "reset" };
  if (trimmed === saved) return { action: "skip" };
  return { action: "save", value: trimmed };
}

/**
 * Blur-save decision for Preview text. Unlike Subject, empty IS a valid,
 * saveable value (clearing the preview snippet) — mirrors
 * `CampaignMetaCard.tsx#savePreviewText`, which sends whatever's typed,
 * blank included.
 */
export function previewTextSaveDecision(draft: string, saved: string): FieldSaveDecision {
  if (draft === saved) return { action: "skip" };
  return { action: "save", value: draft };
}
