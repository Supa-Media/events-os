/**
 * Client-side receipt search predicate for the attach-existing picker — the
 * `listReceipts` query has no text-search term, so the picker filters its
 * unlinked worklist in memory. Kept as a pure function (no RN/Convex imports)
 * so it's unit-testable, matching the repo's "logic lives in a .ts, not the
 * component" convention.
 *
 * Matches on merchant name OR amount, and the amount matches in every form a
 * bookkeeper might type: the "$16.36" display string AND the raw cents "1636",
 * so "16.36", "$16.36", and "1636" all find the same receipt. Empty query
 * matches everything (the picker shows the whole worklist).
 */
import { formatCents } from "@events-os/shared";

export function receiptMatchesSearch(
  receipt: { merchant?: string | null; amountCents?: number | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const merchant = (receipt.merchant ?? "").toLowerCase();
  const amount =
    receipt.amountCents != null
      ? `${formatCents(receipt.amountCents).toLowerCase()} ${receipt.amountCents}`
      : "";
  return merchant.includes(q) || amount.includes(q);
}
