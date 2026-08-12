/**
 * THE DERIVATION/OVERRIDE RULE — pure, framework-free, and the one place it
 * lives. Every host that shows the compact expense-type chips (the reconcile
 * modal, the inline "What it was for" flow, and anywhere else that grows one)
 * drives its chips through these two functions so the rule can never drift
 * between hosts.
 *
 * DERIVES A QUESTION-SET, NEVER AN ANSWER (owner distinction, 2026-08-08): a
 * category's `expenseTypeHint` only decides WHICH §274(d) proof questions the
 * form asks (a route for travel, who ate for a meal) — it never writes into
 * `businessPurpose`/`attendees`/`headcount`, which stay the spender's own
 * words, always. These functions only ever move `expenseType` around; nothing
 * here touches testimony.
 *
 * THE RULE: the chips follow the category's hint automatically, right up
 * until the person taps a chip themselves — a manual pick STICKS, and a later
 * category change (even to a category with a different hint, or none at all)
 * must not silently overwrite it. `overridden` is the flag that remembers
 * which regime the chips are in.
 */
import type { ExpenseType } from "@events-os/shared";

export interface ExpenseTypeChipState {
  expenseType: ExpenseType | null;
  /** Once true, `deriveExpenseTypeFromCategory` is a no-op forever (until a
   *  fresh state is constructed, e.g. opening the editor on a different
   *  charge) — the person's own tap outranks any category the picker lands
   *  on afterward. */
  overridden: boolean;
}

/** The starting state for a fresh (or freshly-opened) coding: an existing
 *  coding's own expense type is treated as an already-considered choice
 *  (sticky, `overridden: true`) so revising it never gets silently reset by
 *  whatever the category happens to hint today; a brand-new coding starts
 *  following the category, exactly like every other unset chip row. */
export function initialExpenseTypeChipState(args: {
  existingExpenseType?: ExpenseType | null;
  categoryHint?: ExpenseType | null;
}): ExpenseTypeChipState {
  if (args.existingExpenseType != null) {
    return { expenseType: args.existingExpenseType, overridden: true };
  }
  return { expenseType: args.categoryHint ?? null, overridden: false };
}

/**
 * EVENT: the category (or its hint) changed — a fresh pick in the category
 * Select, or a different transaction/line whose category differs. Re-derives
 * the chip ONLY when the person hasn't overridden it; an overridden state
 * passes through completely unchanged (same object identity), so a re-render
 * driven by an unrelated category change never disturbs a manual pick.
 */
export function deriveExpenseTypeFromCategory(
  state: ExpenseTypeChipState,
  categoryHint: ExpenseType | null,
): ExpenseTypeChipState {
  if (state.overridden) return state;
  if (state.expenseType === categoryHint) return state;
  return { expenseType: categoryHint, overridden: false };
}

/**
 * EVENT: the person tapped a chip themselves. Sticky from here on, even when
 * the tap happens to land on the same value the category already hinted —
 * intent is what makes it stick, not whether the value changed.
 */
export function overrideExpenseType(
  _state: ExpenseTypeChipState,
  picked: ExpenseType,
): ExpenseTypeChipState {
  return { expenseType: picked, overridden: true };
}
