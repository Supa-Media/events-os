/**
 * RECONCILE FILTERS — the grouping, and the set semantics that go with it.
 *
 * Lives in `@events-os/shared` because both halves have to agree exactly:
 * `finances.listReconcile` narrows the rows and counts them, and the grid's
 * filter bar decides what's selectable and what each control shows. A grouping
 * that drifted between the two would produce a count that doesn't match the
 * rows — the failure this whole area has been fixing.
 *
 * ## Why groups, and why multi-select
 *
 * The nine filters were one flat, mutually-exclusive list. That was wrong twice
 * over. They aren't peers — they answer two different questions — and they
 * aren't exclusive: a charge is routinely unreviewed AND missing a receipt AND
 * unbudgeted at the same time, which the old model could only show one at a
 * time. A treasurer working a backlog wants "everything with anything wrong
 * with it", and couldn't ask for it.
 *
 *   KIND  — what sort of row is this? Spend, an internal transfer, a processor
 *           payout. Roughly exclusive per row, but selectable together to widen.
 *   STATE — where is it in the pipeline? Needs review, needs a budget, needs a
 *           receipt, undocumented, owed back personally, or already cleared. A
 *           row can be in several of these at once.
 *
 * `missing_receipt` and `undocumented` look like duplicates and aren't. The
 * first is the CHASE worklist and stops counting a row once it's reconciled —
 * someone made a call, there's nobody left to nudge. The second ignores status
 * entirely: it's every row with neither a receipt nor an approved receipt
 * exception, including ones already closed. That's the PUBLISHING backlog, and
 * it's deliberately the harder number to please, because a public ledger can't
 * tell a quietly-closed row from a documented one. See
 * `docs/plans/receipt-exceptions.md`.
 *
 * ## Set semantics: OR within a group, AND across groups
 *
 * `["spend", "missing_receipt"]` means "spend rows that are missing a receipt",
 * not "spend rows plus receiptless rows" — the two words come from different
 * groups, so they narrow. `["missing_receipt", "needs_budget"]` means "rows
 * missing a receipt OR a budget" — same group, so they widen.
 *
 * That's the standard faceted-filter contract, and it's the one that makes both
 * of the sentences a treasurer actually says expressible: "show me the spend
 * that's missing receipts" and "show me anything that still needs something".
 *
 * An EMPTY selection means no constraint from that group. Empty everywhere =
 * every row, which is what the retired `all` filter meant. `all` survives only
 * as a COUNT (the scope's total, which the header's "N to clear" subtracts
 * from) — never as a selection, because "all" and "nothing selected" are the
 * same state and having both would let the UI contradict itself.
 */

/** Every filter key that can be SELECTED (see the `all` note above). */
export const RECONCILE_FILTER_KEYS = [
  "spend",
  "transfers",
  "payouts",
  "to_review",
  "needs_budget",
  "missing_receipt",
  "uncoded",
  "coding_review",
  "undocumented",
  "personal_unpaid",
  "reconciled",
] as const;
export type ReconcileFilterKey = (typeof RECONCILE_FILTER_KEYS)[number];

export type ReconcileFilterGroupId = "kind" | "state";

export const RECONCILE_FILTER_GROUPS: readonly {
  id: ReconcileFilterGroupId;
  /** The control's label ("Kind", "State"). */
  title: string;
  /** Shown on the trigger when nothing in this group is selected. */
  anyLabel: string;
  keys: readonly ReconcileFilterKey[];
}[] = [
  {
    id: "kind",
    title: "Kind",
    anyLabel: "Any kind",
    keys: ["spend", "transfers", "payouts"],
  },
  {
    id: "state",
    title: "State",
    anyLabel: "Any state",
    keys: [
      "to_review",
      "needs_budget",
      "missing_receipt",
      "uncoded",
      "coding_review",
      "undocumented",
      "personal_unpaid",
      "reconciled",
    ],
  },
] as const;

/** Human labels — one source, so the menu, the trigger and any summary agree. */
export const RECONCILE_FILTER_LABELS: Record<ReconcileFilterKey, string> = {
  spend: "Spend",
  transfers: "Transfers",
  payouts: "Payouts",
  to_review: "To review",
  needs_budget: "Needs budget",
  // "Needs documentation", not "Missing receipt": a row with an approved
  // exception is documented, and calling it "missing a receipt" would be
  // literally true and practically wrong — it reads as an outstanding task
  // when the org has already acknowledged it and moved on. Naming the goal
  // (documentation) rather than one way of reaching it (a receipt) is what
  // keeps the backlog honest AND small (owner ask, 2026-08-05).
  missing_receipt: "Needs documentation",
  // The substantiation chase (transaction coding — see
  // `docs/plans/transaction-coding.md`). `uncoded` is a row the POLICY says
  // owes a coding (spend posted at/after `codingRequiredSinceMs`) that has
  // none approved-or-awaiting; `coding_review` is a submitted coding waiting
  // on a reviewer — the treasurer's inbox, not the cardholder's.
  uncoded: "Needs coding",
  coding_review: "Coding review",
  undocumented: "Undocumented",
  personal_unpaid: "Personal (unpaid)",
  reconciled: "Reconciled",
};

/** Which group a key belongs to. */
export function reconcileFilterGroupOf(
  key: ReconcileFilterKey,
): ReconcileFilterGroupId {
  const group = RECONCILE_FILTER_GROUPS.find((g) => g.keys.includes(key));
  // Unreachable while the assert in `reconcileFilters.test.ts` holds (every
  // key is placed exactly once); typed as non-optional so callers don't carry
  // a null branch that can't happen.
  return (group ?? RECONCILE_FILTER_GROUPS[0]).id;
}

/**
 * Does a row match `selected`?
 *
 * `flags` is the row's predicate results — computed once per row by the caller
 * (the server has the transaction; the pure logic lives here so it's testable
 * without one). A group with nothing selected imposes no constraint; a group
 * with selections requires at least one of them to hold.
 */
export function matchesReconcileFilters(
  flags: Record<ReconcileFilterKey, boolean>,
  selected: readonly ReconcileFilterKey[],
): boolean {
  if (selected.length === 0) return true;
  for (const group of RECONCILE_FILTER_GROUPS) {
    const active = group.keys.filter((k) => selected.includes(k));
    if (active.length === 0) continue; // unconstrained
    if (!active.some((k) => flags[k])) return false;
  }
  return true;
}

/**
 * The count to show against `key` given the CURRENT selection — a facet count.
 *
 * Deliberately NOT the global count of rows matching `key`. Once two filters
 * can be active at once, a global count is a number you cannot get to: pick
 * "Spend", and a "Missing receipt 153" sitting next to it promises 153 rows
 * that selecting it would never produce. That's the exact defect this area
 * started with, reintroduced by multi-select, so the counts move with the
 * selection instead.
 *
 * The rule is the standard one: a key's count ignores its OWN group's
 * selections and honours every other group's. So the numbers inside one
 * dropdown stay comparable with each other ("of the spend rows, 40 need a
 * receipt and 12 need a budget") while still reflecting what you've narrowed
 * to elsewhere. With nothing selected anywhere, every facet count equals the
 * plain global count, which is what it was before multi-select.
 */
export function countsTowardFacet(
  flags: Record<ReconcileFilterKey, boolean>,
  selected: readonly ReconcileFilterKey[],
  key: ReconcileFilterKey,
): boolean {
  if (!flags[key]) return false;
  const ownGroup = reconcileFilterGroupOf(key);
  for (const group of RECONCILE_FILTER_GROUPS) {
    if (group.id === ownGroup) continue;
    const active = group.keys.filter((k) => selected.includes(k));
    if (active.length === 0) continue;
    if (!active.some((k) => flags[k])) return false;
  }
  return true;
}

/**
 * Parse a `?filters=a,b` URL param (and the legacy singular `?filter=a`) into
 * a clean key list. Unknown values are dropped rather than throwing — a stale
 * bookmark should land on a usable screen, not an error. The retired `all`
 * spelling, and the pre-rename `uncategorized`/`ready`, map to what they meant.
 */
export function parseReconcileFilters(raw: string | undefined | null): ReconcileFilterKey[] {
  if (!raw) return [];
  const legacy: Record<string, ReconcileFilterKey> = {
    uncategorized: "to_review",
    ready: "reconciled",
  };
  const out: ReconcileFilterKey[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token || token === "all") continue;
    const key = (legacy[token] ?? token) as ReconcileFilterKey;
    if (RECONCILE_FILTER_KEYS.includes(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Serialize back to a `?filters=` value. Empty selection → `undefined`. */
export function serializeReconcileFilters(
  selected: readonly ReconcileFilterKey[],
): string | undefined {
  return selected.length > 0 ? selected.join(",") : undefined;
}
