import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import {
  runRemoveUnexecutedBalanceSettlements,
  type RemoveUnexecutedBalanceSettlementsResult,
} from "../lib/removeUnexecutedBalanceSettlements";

/**
 * Automatic backlog cleanup for the never-executed morning-engine BALANCE
 * SETTLEMENT pairs (see `lib/removeUnexecutedBalanceSettlements.ts` for the
 * full specification — what went wrong, why deletion is the founder-
 * authorized remedy, and every precondition a pair must pass).
 *
 * WHY A MIGRATION, NOT JUST THE MUTATION THAT ALREADY SHIPPED. The founder's
 * own question was "can't you run a migration to delete the rows" — and she
 * was right: `removeUnexecutedBalanceSettlements.ts`'s public mutation needs
 * a human in an authenticated ED/FM session to invoke it, but this repo runs
 * migrations AUTOMATICALLY post-deploy (`migrations:runPending`, wired into
 * `.github/workflows/deploy-convex.yml`), with admin privileges and no signed
 * -in identity required. This migration is that automatic path — the exact
 * same guarded core, `runRemoveUnexecutedBalanceSettlements`, called with
 * `execute: true` and no scope, so the backlog clears itself on the next
 * deploy to `main` instead of waiting on a human to remember to click
 * "execute" in the Convex dashboard.
 *
 * ONE IMPLEMENTATION, TWO ENTRY POINTS. This file adds NO precondition logic
 * of its own — every guard (the `balsettle-` prefix, `transferOrigin`, the
 * `externalId` refusal, the exactly-two-legs check, the amount-match check,
 * the summed-`signedBookCents`-is-zero check) lives ONLY in
 * `lib/removeUnexecutedBalanceSettlements.ts`, shared verbatim with the
 * human-run mutation. If this migration and that mutation could ever
 * disagree about what is safe to delete, the shared core is the bug.
 *
 * REFUSES RATHER THAN GUESSES. Exactly like the mutation: if ANY candidate
 * fails ANY precondition — anywhere in the whole backlog, across every
 * chapter — the shared core's `problems` comes back non-empty and `execute:
 * true` is downgraded to a no-op read: NOTHING is deleted, and the refusal
 * reasons are returned (and therefore ledgered — see below) so a human can
 * see exactly why. This migration never does a partial "delete what looks
 * safe, skip the rest" run.
 *
 * LEAVES A RECORD. Raw deletion has no audit trail
 * (`docs/plans/transfers-ops-notes.md` calls this out as the reason deletion
 * is the last-resort remedy). `migrations.ts#runPending` JSON-stringifies
 * this migration's return value into the `schemaMigrations` ledger row's
 * `result` field the moment it runs — so `candidates` (group id, chapter,
 * posted date, amount, leg count for every pair actually deleted),
 * `deletedLegs`, `totalSignedBookCents`, and `problems` are all captured in
 * the deployment's own migration ledger, queryable forever after. That ledger
 * row, plus this file and the PR that shipped it, is the external record
 * `transfers-ops-notes.md` requires for a raw deletion.
 *
 * BOUNDED, IDEMPOTENT. The shared core reads chapters and each chapter's
 * transactions through an index with an explicit `ROLLUP_SCAN_LIMIT` bound —
 * see that file's module doc for why one transaction covers this
 * deployment's realistic volume (a low double-digit chapter count, each with
 * a transaction history far under the cap) and why a scan that DOES hit the
 * cap makes the whole run refuse rather than delete an unverifiable partial
 * set, rather than reaching for scheduler-continuation paging. A deleted
 * pair's rows are gone, so a re-run (this migration only ever runs once per
 * deployment via the ledger, but the underlying function is safe to invoke
 * again by hand too) finds no candidates and changes nothing.
 */
export async function runRemoveUnexecutedBalanceSettlementsMigration(
  ctx: MutationCtx,
): Promise<RemoveUnexecutedBalanceSettlementsResult> {
  return await runRemoveUnexecutedBalanceSettlements(ctx, { execute: true });
}

export const removeUnexecutedBalanceSettlementsMigration: Migration = {
  name: "0071_remove_unexecuted_balance_settlements",
  run: runRemoveUnexecutedBalanceSettlementsMigration,
};
