/**
 * WHAT THE REVIEWER CHANGED — the running list behind "approved with
 * corrections".
 *
 * Dev2, 2026-11-08: "instead of sending back sometimes I may correct
 * categories budgets reasons etc, whenever I do email the person that it was
 * approved with corrections". `transactionCodings.reviseUnderReview` appends
 * here every time a reviewer saves a correction; `transactionCodings.approve`
 * reads the list and, when it is non-empty, schedules the author's email
 * (`codingCorrectionEmails.notifyCodingApprovedWithCorrections`).
 *
 * ONE ENTRY PER FIELD. A reviewer who fixes the budget, saves, then changes
 * their mind and picks another one has made one correction, from what the
 * author submitted to what was approved. So a later edit keeps the FIRST
 * `before` and takes the new `after`, and an edit that lands back on the
 * author's own answer drops the entry: nothing about that field differs from
 * what they submitted, and telling them it was corrected would be false.
 */
import type { Doc } from "../_generated/dataModel";

export type ReviewCorrection = NonNullable<
  Doc<"transactionCodings">["reviewCorrections"]
>[number];

export function mergeReviewCorrections(
  existing: readonly ReviewCorrection[] | undefined,
  incoming: readonly ReviewCorrection[],
): ReviewCorrection[] {
  const merged = [...(existing ?? [])];
  for (const next of incoming) {
    if (next.before === next.after) continue;
    const at = merged.findIndex((c) => c.field === next.field);
    if (at === -1) {
      merged.push(next);
      continue;
    }
    const first = merged[at];
    if (first.before === next.after) {
      merged.splice(at, 1);
    } else {
      merged[at] = { ...first, after: next.after };
    }
  }
  return merged;
}
