/**
 * WHAT YOU CAN DO TO ONE ROW — the `⋯` menu's contents, as a pure function.
 *
 * Founder, on the deployed grid's last column: "the last column is very
 * cluttered… it could be much cleaner and have things broken down." It was
 * cluttered because THREE DIFFERENT KINDS of thing had accumulated in one
 * 112px cell over four changes: something that OPENS the record (the
 * speech-bubble), facts about the row's STATE (Transfer / Stripe / Personal /
 * Repaid badges), and ACTIONS on the row (a pencil, a flag, and up to two
 * `⊗` un-marks). Icons cannot say which kind they are, so the cell read as a
 * pile — and worse, it was a DIFFERENT pile on every row, because five of the
 * seven things in it were conditional.
 *
 * The split: the state went to its own column (`gridView#rowMarkings`), the
 * speech-bubble stayed exactly where it was, and every ACTION collapsed into
 * the one menu this module describes. Two elements per row, in the same two
 * places on every row, whatever the row is.
 *
 * WHY A LIST AND NOT JSX. The visibility rules here are the hard part and were
 * the part spread across five nested ternaries in the renderer: two of them
 * mirror a server-side OR-gate (`cards.flagPersonalCharge` allows the PAYER or
 * a MANAGER), one mirrors a server-side source check (`row.correctable`), and
 * one only exists before a repayment settles. A grid renderer is the worst
 * place to keep rules the server also keeps. Dependency-free like
 * `gridView.ts`, for the same reason: it runs directly under this package's
 * jest config, so the rules that can be wrong are the rules that are tested.
 *
 * SERVER AUTHZ IS STILL THE SOURCE OF TRUTH. Nothing here grants anything —
 * every mutation these route to re-checks its own gate. This decides what is
 * OFFERED, and its whole job is to never offer an act the backend would then
 * refuse, which is the "affordance that can't work" this screen keeps deleting.
 */

export type RowActionId =
  /** `finances.correctTransaction` — amount / date / merchant on a
   *  hand-entered row. */
  | "correct"
  /** `cards.flagPersonalCharge` on a row that already resolves a payee. */
  | "markPersonal"
  /** Same mutation, but a manager names who owes it first (`PersonPicker`)
   *  because the row resolves nobody. A separate id, not a flag on the one
   *  above, because it is a materially different promise to the reader: one
   *  opens a confirm, the other opens a person picker. */
  | "markPersonalNamingPayer"
  /** `cards.unflagPersonalCharge` — mis-flag correction, refused once the
   *  repayment settles. */
  | "unmarkPersonal"
  /** `finances.unmarkTransfer` — restores BOTH legs through
   *  `transferGroupId`. */
  | "unmarkTransfer"
  /** `finances.unmarkPayout` — a payout has no leg to pair with. */
  | "unmarkPayout";

export type RowAction = {
  id: RowActionId;
  /** What the menu row says. Full sentences rather than the icons these
   *  replaced: "Un-mark" beside a green chip was only legible because the chip
   *  was next to it, and in a menu there is no chip. */
  label: string;
};

/**
 * The row, in exactly the fields that decide this — the `listReconcile`
 * projection's own names, so a reader can check the rule against the payload
 * without a translation step.
 */
export type RowActionRow = {
  /** SERVER-resolved (`manual` sources only). Never re-derived here: a client
   *  guessing which sources are correctable would offer a button that throws
   *  the day a new source lands. */
  correctable: boolean;
  isMarkedTransfer: boolean;
  payoutProcessor: string | null;
  isPersonal: boolean;
  repaymentStatus: string | null;
  /** The row resolves a payer at all — a card's cardholder OR a directly
   *  attributed person. Mirrors `flagPersonalCharge`'s own payee resolution,
   *  so this never promises a flag the server answers with `PAYEE_REQUIRED`. */
  hasPayee: boolean;
};

export type RowActionViewer = {
  /** The grid's existing write-rank flag (bookkeeper+). */
  isManager: boolean;
  /** This is the viewer's OWN charge — the cardholder half of
   *  `flagPersonalCharge`'s server-side payer-or-manager OR-gate. A
   *  bookkeeper-rank payer may flag their own charge without being a manager. */
  isOwnCharge: boolean;
};

/**
 * ORDERED BY HOW OFTEN A BOOKKEEPER REACHES FOR IT, not by the order the old
 * icons happened to sit in.
 *
 * Personal first: it is the only one of these available on nearly every row,
 * it is the one the Academy teaches by name, and it is the reason the flag was
 * on every row of the grid in the first place. Un-marking a marking second —
 * rare, and always a correction. Correcting the row last: it exists on
 * hand-entered history only, and it is the most consequential of the three,
 * so it should not be the item under a landing cursor.
 *
 * An EMPTY list is a real answer, and the renderer draws no `⋯` for it. A
 * menu button that opens an empty menu is worse than the clutter it replaced.
 */
export function rowActions(
  row: RowActionRow,
  viewer: RowActionViewer,
): RowAction[] {
  const out: RowAction[] = [];
  const canFlag = viewer.isManager || viewer.isOwnCharge;

  if (row.isPersonal) {
    // Only while it is still owed. `unflagPersonalCharge` refuses a settled
    // one server-side, so offering it after repayment would be a button whose
    // only outcome is an error toast.
    if (row.repaymentStatus !== "paid" && canFlag) {
      out.push({ id: "unmarkPersonal", label: "Un-mark personal" });
    }
  } else if (row.hasPayee) {
    if (canFlag) out.push({ id: "markPersonal", label: "Mark personal" });
  } else if (viewer.isManager) {
    // Naming someone else as the person who owes the chapter money is a
    // manager's call and nobody else's — the server enforces the same split.
    out.push({
      id: "markPersonalNamingPayer",
      label: "Mark personal — pick who owes it",
    });
  }

  if (row.isMarkedTransfer) {
    if (viewer.isManager) {
      out.push({
        id: "unmarkTransfer",
        label: "Un-mark internal transfer (both legs)",
      });
    }
  } else if (row.payoutProcessor != null && viewer.isManager) {
    out.push({ id: "unmarkPayout", label: "Un-mark processor payout" });
  }

  if (row.correctable && viewer.isManager) {
    out.push({ id: "correct", label: "Correct amount, date or merchant" });
  }

  return out;
}
