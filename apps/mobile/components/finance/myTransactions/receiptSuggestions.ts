/**
 * SUGGESTED RECEIPTS — "is this the one?", for a charge that has none.
 *
 * Receipts that arrive by email or text land in the person's library UNLINKED
 * rather than being auto-attached to a guessed transaction: a wrong guess is
 * worse than no guess, because nobody re-checks a charge that already looks
 * documented. So the machine proposes and the human disposes — one tap on
 * "this is the one" attaches it and satisfies the documentation half of a
 * coding (`submitCoding`'s `DOCUMENTATION_REQUIRED` gate).
 *
 * This is NOT the AI the coding flow forbids (owner decision, 2026-08-08). A
 * suggested receipt is a DOCUMENT the human confirms; nothing here drafts,
 * pre-fills or suggests a business purpose, an expense type, or any other word
 * of the substantiation record — those stay the author's own testimony.
 *
 * ONE ADAPTER, ON PURPOSE. `api.receipts.suggestedForTransaction` was built in
 * parallel with this screen, so everything that depends on its exact wire
 * shape is squeezed into `adaptReceiptSuggestions` below — the rest of the UI
 * reads only `SuggestedReceipt`, and re-pointing it at a different payload is
 * a change to one function.
 */
import { formatCents } from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { receiptAmountMismatch } from "./receiptAmountCheck";

/**
 * The suggestions query — the unlinked receipts in this person's library that
 * could document this charge, best first.
 *
 * Read it through `useQueries`, never `useQuery`: `useQueries` RETURNS a
 * failure instead of throwing it during render, so a caller the gate refuses
 * (`lib/receiptSuggestionAccess.ts`) or a deployment lagging this bundle
 * degrades to "no suggestions" rather than taking down the sheet a cardholder
 * was told to go finish their charges in. `adaptReceiptSuggestions` turns
 * anything that isn't a list of rows into an empty list for exactly that
 * reason.
 */
export const SUGGESTED_RECEIPTS_QUERY = api.receipts.suggestedForTransaction;

/**
 * What "yes, that's the one" calls — the member-safe confirm
 * (`receipts.confirmSuggestedReceipt`), gated by the same resolver as the
 * query, so the cardholder who was OFFERED a receipt can actually attach it.
 * Deliberately not `receipts.linkReceipt`, which is the bookkeeper's
 * pick-any-receipt path and would refuse the person this feature is for.
 */
export const CONFIRM_SUGGESTION_MUTATION = api.receipts.confirmSuggestedReceipt;

/** One inbound receipt offered for a charge — everything the row renders,
 *  and nothing else. Flattened from the query's nested `match` block so no
 *  component has to know that block exists. */
export interface SuggestedReceipt {
  receiptId: Id<"receipts">;
  /** Signed URL for the thumbnail; `null` when the file can't be served. */
  url: string | null;
  amountCents: number | null;
  receiptDate: number | null;
  merchant: string | null;
  /** The server's own amount comparison (`match.amountExact`) — trusted over
   *  any local arithmetic, since it sees the receipt row's total, which a
   *  cardholder cannot otherwise read (see `receiptAmountCheck.ts`). */
  amountMatches: boolean;
  filename: string | null;
  /** MIME type when known — the honest way to tell a PDF from a photo. */
  contentType: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * THE SHAPE BOUNDARY. Everything downstream of this function is ours; the
 * argument is whatever the query returned — including `undefined` (loading),
 * an `Error` (the caller may not read it, or this bundle is talking to a
 * deployment that predates the query), or a payload whose fields moved.
 *
 * Anything that isn't an array of objects carrying a `receiptId` yields an
 * empty list, which renders as nothing at all — the sheet's other paths
 * (upload, "there is no receipt for this") are untouched by suggestions being
 * unavailable, and that is exactly how it should degrade.
 */
export function adaptReceiptSuggestions(raw: unknown): SuggestedReceipt[] {
  if (!Array.isArray(raw)) return [];
  const out: SuggestedReceipt[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item == null) continue;
    const row = item as Record<string, unknown>;
    const receiptId = str(row.receiptId) ?? str(row._id);
    if (!receiptId) continue;
    const match =
      typeof row.match === "object" && row.match != null
        ? (row.match as Record<string, unknown>)
        : {};
    out.push({
      receiptId: receiptId as Id<"receipts">,
      url: str(row.url),
      // CANONICAL over OCR: the row's `amountCents`/`receiptDate`/`merchant`
      // are what the record claims (a human may have corrected them); the
      // `ocr*` siblings are provenance, not the claim.
      amountCents: num(row.amountCents),
      receiptDate: num(row.receiptDate),
      merchant: str(row.merchant),
      // Absent → assume it does NOT match, so the human is asked to look
      // rather than reassured by a field nobody sent.
      amountMatches: match.amountExact === true || row.amountMatches === true,
      filename: str(row.filename),
      contentType: str(row.contentType),
    });
  }
  return out;
}

/** What to call the thing in the list: the merchant if one was read, else the
 *  file it arrived as, else something honest rather than blank. */
export function suggestionTitle(s: SuggestedReceipt): string {
  return s.merchant ?? s.filename ?? "Emailed receipt";
}

/** "$42.17 · Aug 3" — the two facts that let somebody recognise their own
 *  receipt without opening it. Says so out loud when the amount is unknown,
 *  because a silent gap reads as a match. */
export function suggestionMeta(s: SuggestedReceipt): string {
  const parts = [
    s.amountCents != null ? formatCents(Math.abs(s.amountCents)) : "No total read",
    s.receiptDate != null
      ? new Date(s.receiptDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "America/New_York",
        })
      : null,
  ].filter(Boolean) as string[];
  return parts.join(" · ");
}

/**
 * The caution to show beside a suggestion whose total doesn't match the
 * charge — the same sentence the attach-time check uses, because it is the
 * same mistake ("receipt must show exact amount" is the most common
 * send-back). `null` when the amounts agree: silence is the reward for a
 * clean match.
 */
export function suggestionWarning(
  s: SuggestedReceipt,
  chargeCents: number,
): string | null {
  if (s.amountMatches) return null;
  if (s.amountCents == null) {
    return "No total was read off this one — open it and check it covers the whole charge before you confirm.";
  }
  return receiptAmountMismatch(s.amountCents, chargeCents);
}

// `looksLikeDocument` lived here — a THIRD private copy of "is this an image?".
// It is now `receiptFileKind`/`receiptRendersAsImage` in `@events-os/shared`,
// which every surface shares. Its own bug, for the record: with no content
// type it fell back to `.pdf` ANYWHERE in `filename + url`, so "my.pdf.jpg"
// read as a document and a genuine PDF with neither signal read as an image.
