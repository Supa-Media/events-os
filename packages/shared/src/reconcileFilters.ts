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
 *           `transfers` is also the ONE key that widens the queue's population
 *           rather than narrowing it: an unmarked internal transfer leg is
 *           hidden from the default queue (it owes no coding, no receipt and no
 *           close — see `finances.listReconcile`), and picking Transfers is how
 *           you get it back. Its count is computed over the hidden rows too, so
 *           the number in the dropdown is still one you can get to.
 *   STATE — where is it in the pipeline? Needs review, needs a budget, needs a
 *           receipt, needs explaining, undocumented, owed back personally, or
 *           already cleared. A row can be in several of these at once.
 *
 * `missing_receipt` and `undocumented` are two halves of one backlog, and they
 * are DISJOINT. The first is the CHASE worklist: still open, still owes a
 * receipt, there is someone to nudge. The second — "Closed without
 * documentation" — is the tail nobody will ever send a receipt for, because a
 * treasurer already marked it Closed with nothing behind it. The PUBLISHING
 * backlog is the union of the two, which, being one group, is exactly what
 * selecting both gives you. See `docs/plans/receipt-exceptions.md`.
 *
 * They used to OVERLAP, and that was the defect: `undocumented`'s facet ignored
 * status, making it a strict superset (in production: overlap 42,
 * only-undocumented 3, only-missing-receipt 0). Two menu entries with
 * near-identical names and near-identical numbers, where picking the bigger one
 * showed you the rows you had just looked at plus three you hadn't. The
 * PREDICATES `needsDocumentation` and `isUndocumented` still mean what they
 * always meant — only the facet's population and label moved.
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
  "needs_chasing",
  "uncoded",
  "needs_explaining",
  "explained",
  "coding_review",
  "undocumented",
  "personal_unpaid",
  "reconciled",
  "needs_attention",
  "ready_to_close",
] as const;
export type ReconcileFilterKey = (typeof RECONCILE_FILTER_KEYS)[number];

export type ReconcileFilterGroupId = "kind" | "state" | "rollup";

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
      "needs_chasing",
      "uncoded",
      "needs_explaining",
      "explained",
      "coding_review",
      "undocumented",
      "personal_unpaid",
      "reconciled",
    ],
  },
  {
    id: "rollup",
    title: "Work",
    anyLabel: "Any work",
    keys: ["needs_attention", "ready_to_close"],
  },
] as const;

/**
 * The groups that get a DROPDOWN. `rollup` deliberately doesn't: its two keys
 * are roll-ups OVER the State list, so sitting them in that same menu would put
 * a 51 next to a 7 and a 42 that are subsets of it — the "which number is the
 * real one" problem this area exists to end. They have no control of their own
 * on the grid either, since the header chips that used to carry them were the
 * clutter the founder asked to be rid of (see below); they are reachable by
 * URL (`?filters=needs_attention`) and are what the Dashboard's own tiles
 * drill through on.
 *
 * They are still a real GROUP for set-semantics purposes, which is what makes
 * "needs attention" AND "Spend" narrow correctly rather than being ignored.
 */
export const RECONCILE_DROPDOWN_GROUPS = RECONCILE_FILTER_GROUPS.filter(
  (g) => g.id !== "rollup",
);

/**
 * THE ROLL-UPS ARE PREDICATES, NOT A CHIP ROW.
 *
 * There used to be a `RECONCILE_HEADER_CHIPS` list here, rendered under the
 * grid's title as "45 needs attention · 90 ready to close · 222 reconciled".
 * Founder, using the deployed build: "What are these pills underneath — 45
 * need attention, 90 ready to close, 222 reconciled? I don't even know what
 * reconciled is." And: "You already have the State right here on the side, so
 * I can see everything in every state. That's all you need."
 *
 * He is right, and the reason is the one this file already argues for the
 * `rollup` group: three chips restating what the State dropdown directly
 * above them already offers is a second way to say one thing, in a row of
 * pills sitting under a bar of pills. So the CHIP ROW is gone.
 *
 * The KEYS and their predicates are not. `needs_attention` / `ready_to_close`
 * are still selectable filters, still facet-counted by `listReconcile`, and
 * the Dashboard still reads their counts — they simply no longer have a
 * dedicated row of their own on the grid.
 */

/**
 * The states that make an OPEN row "need attention" — the definition
 * `needs_attention` is the union of and `ready_to_close` is the complement of.
 *
 * Exported so the server computes the roll-ups from this list rather than
 * re-typing it: `needs_attention + ready_to_close === toClearCount` has to hold
 * by construction, or the header can drift from the grid all over again.
 */
export const RECONCILE_ATTENTION_KEYS = [
  "to_review",
  "needs_budget",
  "missing_receipt",
  "personal_unpaid",
] as const satisfies readonly ReconcileFilterKey[];

/** Human labels — one source, so the menu, the trigger and any summary agree. */
export const RECONCILE_FILTER_LABELS: Record<ReconcileFilterKey, string> = {
  spend: "Spend",
  // Every internal transfer leg, not just the ones a bookkeeper MARKED as one
  // (`finances.ts#isMarkedTransfer`). The marked/unmarked distinction still
  // decides what a row OWES and whether Un-mark is offered; it deliberately
  // doesn't decide what "Transfers" finds, because the unmarked legs are the
  // ones the default queue hides and this is their only way back.
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
  // ── THE CHASE, AND WHY IT IS NOT THE PILL ABOVE IT ────────────────────────
  // "Owes somebody something" — every row a cardholder or a treasurer can still
  // be chased about. Its predicate is a UNION and neither half can be dropped:
  //
  //   needsDocumentation(tr) || chargeOutstanding(tr, codingSinceMs) != null
  //
  // `missing_receipt` is only the first half. The chase absorbed CODING when
  // the coding policy landed, so a charge whose receipt is attached and whose
  // coding is not is owed by somebody and is invisible to the documentation
  // pill — the FM would see "3 charges" and email a fourth person about a row
  // the screen never showed.
  //
  // And the second half cannot simply REPLACE the first: `chargeOutstanding` is
  // cardholder-shaped (outflow spend only), while `needsDocumentation` also
  // covers MARKED internal transfers — rows with no cardholder at all, chased
  // with a statement rather than a person, which are exactly what the chase
  // list's "Unattributed" bundle holds. (A MARKED PROCESSOR PAYOUT was in that
  // second class until 2026-08-14 and owes nothing now — founder: "Payouts
  // shouldn't need documentation." See `finances.ts#owesDocumentation`.)
  //
  // Server-side this is ONE expression shared with `finances.receiptChase` and
  // the grid's own `chaseCount`, never a fourth hand-copy — copying it is how
  // `requiresCoding` drifted, and how the fee carve-out went missing from
  // `chaseEligible` for a release.
  //
  // SELECTING IT ALSO UN-HIDES THE TRANSFER LEGS the default queue drops (see
  // `isHiddenTransferLeg`). A marked transfer owes its receipt and must never
  // stop being chased just because the queue stopped listing it — the founder
  // rule `needsDocumentation` is built around.
  needs_chasing: "Owes a receipt or coding",
  // The substantiation chase (transaction coding — see
  // `docs/plans/transaction-coding.md`). `uncoded` is a row the POLICY says
  // owes a coding (spend posted at/after `codingRequiredSinceMs`) that has
  // none approved-or-awaiting; `coding_review` is a submitted coding waiting
  // on a reviewer — the treasurer's inbox, not the cardholder's.
  uncoded: "Needs coding",
  // WHAT WILL PUBLISH BLANK — the same question `finances.monthCodingWorklist`
  // asks, asked from the grid.
  //
  // `uncoded` above is the POLICY question ("does this row owe a coding yet"),
  // and it grandfathers everything posted before `codingRequiredSinceMs`. That
  // is correct about obligation and useless for the job the founder actually
  // has: ~400 reconstructed 2024–25 rows are exempt by calendar, so the facet
  // is empty and the grid cannot reach a single one of them. The only surface
  // that could was the month-at-a-time Explain screen, which is why that
  // screen existed.
  //
  // This key is the PUBLISHING population instead: a row that can carry an
  // explanation (`isSpend`, via `finances.ts#canCarryExplanation`), isn't
  // auto-explained (`autoExplainedKind` — fees, personal charges, cashback,
  // refund pairs, interest), isn't excluded, and has no approved coding.
  // Policy dates never enter into it. Server-side it is ONE function,
  // `finances.ts#needsExplaining`, called by this facet AND by
  // `monthCodingWorklist` — never a second copy, which is the failure mode
  // this area already has a scar from (the `requiresCoding` mirrors in
  // `transactionCodings.ts`).
  needs_explaining: "Needs explaining",
  // ── THE OTHER HALF OF THE SAME POPULATION, AND WHY IT IS A FACET ──────────
  // `explanationPopulation(tr) && codingState === "approved"` — exactly the
  // complement of `needs_explaining` inside the same denominator, so
  // `needs_explaining + explained === explanationPopulation` holds by
  // construction and neither number can quietly become a different question.
  //
  // It exists because approving is PUBLISHING. The moment a coding is
  // approved the row leaves `needs_explaining`, which is the whole point of
  // that facet — and the consequence, for someone writing four hundred
  // sentences that go on a public page, was that the sentence they had just
  // published became unreachable. There was no filter for "what I already
  // explained": you could only find it by clearing every filter and scrolling
  // the whole book past the rows you hadn't done yet. An approved coding is
  // also IMMUTABLE (`submitCoding` throws `CODING_APPROVED`), so re-reading it
  // is the ONLY check available before the month publishes — and it was the
  // one thing the grid couldn't do.
  //
  // Named for the state, not the act ("Explained", not "Approved by me"): the
  // facet is a fact about the ROW, and a per-viewer facet would report a
  // different number to each person looking at the same book.
  explained: "Explained",
  coding_review: "Coding review",
  // "Closed without documentation", not "Undocumented" — and the FACET is now
  // the difference rather than the superset (see `listReconcile`'s `flagsFor`).
  //
  // In production the two populations were: overlap 42, only-undocumented 3,
  // only-missing-receipt 0. `missing_receipt` was a STRICT SUBSET of
  // `undocumented`, so the menu offered "Needs documentation 42" beside
  // "Undocumented 45" — near-identical labels, near-identical numbers — and
  // picking the bigger one showed you the 42 rows you had just looked at plus 3
  // you hadn't. A real distinction that cost a paragraph of doc comment and
  // bought three rows, while reading as a duplicate.
  //
  // Making the facet the difference leaves two DISJOINT options whose labels are
  // both literally true, and the publishing backlog is their OR — which, being
  // one group, is exactly what multi-select already gives you.
  undocumented: "Closed without documentation",
  personal_unpaid: "Personal (unpaid)",
  // Label only — the key stays `reconciled` (stored status, URL param, Convex
  // arg). "Closed" is what the status is called to a user now, and it lands
  // where "Ready to close" below points.
  reconciled: "Closed",
  // The header roll-ups. Phrased as the job rather than the state, because
  // that's the distinction they exist to draw: one pile needs a decision, the
  // other needs a keystroke.
  needs_attention: "Needs attention",
  ready_to_close: "Ready to close",
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
