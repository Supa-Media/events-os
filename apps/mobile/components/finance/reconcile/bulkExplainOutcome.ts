/**
 * READING BACK A BULK EXPLANATION — turning `transactionCodings.submitBulk`'s
 * per-row outcomes into something a person can act on.
 *
 * The server deliberately reports EVERY selected row, with its own refusal
 * code, rather than a count of "skipped": a bulk action that silently drops
 * twelve rows is worse than no bulk action, because the twelve look done. That
 * only pays off if the client says which twelve and why, so this is the piece
 * that does it — pure, so the phrasing and the grouping are testable without a
 * server or a render.
 *
 * TWO JOBS, deliberately separate:
 *  - the LINE ("28 explained · 12 need a receipt first"), which is the whole
 *    outcome in one sentence and is what the toast shows;
 *  - the GROUPS, one per refusal code, each carrying the server's own message
 *    once and the list of charges it happened to — which is what the results
 *    panel lists, so nobody has to read the same sentence twelve times to find
 *    the twelve names.
 *
 * The server's message is passed through verbatim rather than restated here.
 * It is the sentence that explains what to DO ("attach the receipt before
 * submitting this coding — or, if no receipt exists, say why in the same
 * sheet"), it is already written once in `lib/transactionCoding.ts`, and a
 * second copy in the client is how the two drift.
 */

/** One row's fate, exactly as `transactionCodings.submitBulk` returns it. */
export interface BulkExplainRowOutcome {
  transactionId: string;
  outcome: "submitted" | "resubmitted" | "failed";
  code: string | null;
  message: string | null;
}

export interface BulkExplainFailureGroup {
  code: string;
  /** The short phrase used in the summary line — "need a receipt first". */
  headline: string;
  /** The server's own full message, shown once for the group. */
  message: string;
  /** Charge ids in this group, in the order they were submitted. */
  transactionIds: string[];
  /** Those charges as the person sees them in the grid ("MTA*NYCT · Mar 3 ·
   *  $2.90"), so the failures are recognisable rather than a list of ids. */
  labels: string[];
}

export interface BulkExplainSummary {
  applied: number;
  failed: number;
  /** The one-sentence outcome. Never empty. */
  line: string;
  /** One entry per distinct refusal code, biggest first. */
  groups: BulkExplainFailureGroup[];
}

/**
 * The short phrase each refusal gets in the summary line.
 *
 * Deliberately phrased as WHAT IS STILL TRUE OF THE ROW, not as an error:
 * "need a receipt first" is a next step, "failed" is a dead end, and every one
 * of these rows is a row the person still has to finish. Unknown codes fall
 * back to a neutral phrase rather than leaking a machine constant into a
 * sentence someone reads — the group's own message still carries the detail.
 */
const FAILURE_HEADLINES: Record<string, string> = {
  DOCUMENTATION_REQUIRED: "need a receipt first",
  CODING_APPROVED: "already approved",
  LODGING_RECEIPT_REQUIRED: "need an itemised folio",
  NOT_FOUND: "aren't yours to code",
  FORBIDDEN: "aren't yours to code",
};

const UNKNOWN_HEADLINE = "wouldn't take it";

export function bulkExplainFailureHeadline(code: string | null): string {
  return (code && FAILURE_HEADLINES[code]) || UNKNOWN_HEADLINE;
}

/**
 * Summarize a bulk apply.
 *
 * `labelFor` resolves a charge id to whatever the grid is calling that row —
 * the caller already has those rows on screen (it selected them), so nothing
 * about the transaction is re-fetched or re-derived here. A row the caller can
 * no longer name falls back to a short id rather than being dropped: a failure
 * with a poor label is still a failure someone must see.
 */
export function summarizeBulkExplain(
  rows: readonly BulkExplainRowOutcome[],
  labelFor: (transactionId: string) => string | null,
): BulkExplainSummary {
  const applied = rows.filter((r) => r.outcome !== "failed").length;
  const failures = rows.filter((r) => r.outcome === "failed");

  const byCode = new Map<string, BulkExplainFailureGroup>();
  for (const row of failures) {
    const code = row.code ?? "UNKNOWN";
    let group = byCode.get(code);
    if (!group) {
      group = {
        code,
        headline: bulkExplainFailureHeadline(row.code),
        message: row.message ?? "This charge wouldn't take the explanation.",
        transactionIds: [],
        labels: [],
      };
      byCode.set(code, group);
    }
    group.transactionIds.push(row.transactionId);
    group.labels.push(labelFor(row.transactionId) ?? shortId(row.transactionId));
  }

  // Biggest pile first — that's the one worth acting on — with the code as a
  // tie-break so the order is stable across renders of the same result.
  const groups = [...byCode.values()].sort(
    (a, b) =>
      b.transactionIds.length - a.transactionIds.length ||
      a.code.localeCompare(b.code),
  );

  const parts: string[] = [];
  if (applied > 0) parts.push(`${applied} explained`);
  for (const g of groups) {
    parts.push(`${g.transactionIds.length} ${g.headline}`);
  }
  return {
    applied,
    failed: failures.length,
    line: parts.length > 0 ? parts.join(" · ") : "Nothing to explain.",
    groups,
  };
}

/** Last six characters of an id — enough to tell two unnamed rows apart
 *  without pretending to be a name. */
function shortId(id: string): string {
  return `charge …${id.slice(-6)}`;
}
