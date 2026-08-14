/**
 * THE RECONCILE VIEW'S ARGUMENT SURFACE — the filter-key validator, in one
 * place.
 *
 * It lived inside `finances.ts` until the CODING CHASE (`cards.sendCodingChase`)
 * needed the identical surface: the chase is scoped to the view the manager is
 * looking at, so its public action takes the same `filters` the grid sends, and
 * a second hand-typed union across that boundary is the drift this codebase has
 * repaired three times already. `cards.ts` cannot import from `finances.ts` —
 * the import edge runs the other way — so the shared piece comes here, where
 * both can reach it.
 */
import { v } from "convex/values";

// The reconcile filter pills (server-side, correct across ALL rows).
// `spend` (no-dead-numbers): the exact predicate the "Spent" KPI tile sums
// (`isSpend` — outflow, not excluded, not personal) — the drill-down target
// for that tile, distinct from `all` (which keeps inflow/transfer/personal
// rows too, so it would NOT sum to the same figure).
// `personal_unpaid`: an unpaid personal expense — exactly the worklist a
// treasurer needs (founder ask: surface it "in the reconcile flow"). Reuses
// the SAME `isPersonal` + linked-repayment-status pair `repaymentStatus`
// already resolves per row (see `personalExpenseState` in
// `@events-os/shared`) — a row qualifies iff `isPersonal === true` AND its
// repayment isn't `"paid"` (a `"failed"` attempt still counts — the debt is
// still outstanding).
//
// NAMING (founder report — "it says review 80 but 80 is nowhere in Reconcile"):
// two of these keys used to lie about their own predicate, which is how a
// dashboard number could point at a grid that never showed it.
//   - `to_review` was `uncategorized`, but its predicate is and always was
//     `status === "unreviewed"` — nothing to do with whether a CATEGORY is
//     set. That word already means something else in this codebase
//     (`dashboardCharts.budgetTransactions`' `"uncategorized"` sentinel =
//     "no `categoryId`", the honest use), so the same term named two
//     different things one file apart. It's now spelled the same as the
//     dashboards' own "To review" tile — the tile and the pill it drills into
//     finally share one word for one predicate.
//   - `reconciled` was `ready`, which reads as "ready TO reconcile" — the
//     actionable backlog. It's the opposite: rows already CLEARED
//     (`status === "reconciled"`), the complement of the header's "N to
//     clear" (`all - reconciled`).
export const reconcileFilterValidator = v.union(
  v.literal("all"),
  v.literal("spend"),
  v.literal("needs_budget"),
  v.literal("missing_receipt"),
  // The CHASE union — `needsDocumentation || chargeOutstanding != null`, the
  // population `receiptChase` lists and `chaseCount` counts. Deliberately not
  // the `missing_receipt` pill: see `RECONCILE_FILTER_LABELS.needs_chasing`.
  v.literal("needs_chasing"),
  v.literal("uncoded"),
  // The PUBLISHING population — `needsExplaining`, no policy date. `uncoded`
  // beside it is the POLICY question and grandfathers pre-policy history, so
  // it can never reach the ~400 reconstructed 2024–25 rows this key exists
  // for. See `RECONCILE_FILTER_LABELS.needs_explaining`.
  v.literal("needs_explaining"),
  // The COMPLEMENT of the key above inside the same population — what has
  // already been explained, and the only way to re-read a published sentence
  // from this grid (an approved coding is immutable, so re-reading it is the
  // whole review). See `RECONCILE_FILTER_LABELS.explained`.
  v.literal("explained"),
  v.literal("coding_review"),
  v.literal("to_review"),
  v.literal("reconciled"),
  v.literal("undocumented"),
  v.literal("personal_unpaid"),
  v.literal("transfers"),
  v.literal("payouts"),
  // The roll-ups. Complements over the OPEN set, so
  // `needs_attention + ready_to_close === toClearCount` by construction — see
  // `flagsFor`. The grid's header chips that used to render them are gone (the
  // State dropdown says the same thing); the counts still feed the Dashboard
  // and both keys are still selectable filters.
  v.literal("needs_attention"),
  v.literal("ready_to_close"),
);
