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
 * REFUSES RATHER THAN GUESSES — BY THROWING, NOT BY RETURNING. Exactly like
 * the mutation: if ANY candidate fails ANY precondition — anywhere in the
 * whole backlog, across every chapter — the shared core's `problems` comes
 * back non-empty and `execute: true` is downgraded to a no-op read: NOTHING
 * is deleted. But THIS entry point cannot just return that refusal the way
 * the mutation does, because of how `migrations.ts#runPending` records a
 * result:
 *
 *     const result = await migration.run(ctx);
 *     await ctx.db.insert("schemaMigrations", { name, ranAt, result: ... });
 *
 * That insert happens UNCONDITIONALLY after a normal return — so a `run` that
 * RETURNS `{ refused: true, ... }` gets ledgered as APPLIED, and the ledger
 * skip (`if (existing) { skipped.push(...); continue; }`) means this
 * migration would then NEVER be attempted again. A refusal would become a
 * silent, permanent no-op that still reports deploy-level success — strictly
 * worse than not running at all, because nothing about a green deploy would
 * hint that the backlog is still sitting there. So this function THROWS on
 * refusal instead. A thrown error propagates out of `runPending`'s
 * `internalMutation`, which is transactional: the `ctx.db.insert` above never
 * runs, so no `schemaMigrations` row for this migration's name is written
 * (proven in `tests/migrations0071.test.ts`'s "refusal is NOT ledgered"
 * test), and `npx convex run migrations:runPending` — the exact command
 * `.github/workflows/deploy-convex.yml` runs post-deploy — exits non-zero,
 * failing the deploy step LOUDLY. The next deploy attempt (after a human
 * fixes whatever the `problems` describe) retries this migration from
 * scratch, because the ledger never recorded it as done. Loud and retryable
 * beats silent and permanent.
 *
 * The thrown message includes every entry in `problems` verbatim — not a
 * generic "migration failed" — because whoever reads the failed deploy log
 * needs the SAME "why" a human running the mutation's dry run would see.
 *
 * The shared core itself (`lib/removeUnexecutedBalanceSettlements.ts`) still
 * only ever RETURNS a refusal — it has no opinion about which caller should
 * throw. That is deliberate: the mutation is the human inspection/dry-run
 * surface and a returned `{ refused: true, problems }` is exactly what it
 * should hand back for a person to read; only THIS unattended, no-human-in-
 * the-loop entry point needs "loud failure" semantics, so the throw lives
 * here and nowhere else.
 *
 * LEAVES A RECORD ON SUCCESS. Raw deletion has no audit trail
 * (`docs/plans/transfers-ops-notes.md` calls this out as the reason deletion
 * is the last-resort remedy). When this run is NOT refused,
 * `migrations.ts#runPending` JSON-stringifies the returned result into the
 * `schemaMigrations` ledger row's `result` field the moment it runs — so
 * `candidates` (group id, chapter, posted date, amount, leg count for every
 * pair actually deleted), `deletedLegs`, and `totalSignedBookCents` are all
 * captured in the deployment's own migration ledger, queryable forever
 * after. That ledger row, plus this file and the PR that shipped it, is the
 * external record `transfers-ops-notes.md` requires for a raw deletion. On a
 * refusal there is deliberately NO ledger row — the failed deploy log is the
 * record until a human resolves it and a later deploy succeeds.
 *
 * BOUNDED, IDEMPOTENT. The shared core reads chapters and each chapter's
 * transactions (newest-first) through an index with an explicit
 * `ROLLUP_SCAN_LIMIT` bound — see that file's module doc for why one
 * transaction covers this deployment's realistic volume (a low double-digit
 * chapter count, each with a transaction history far under the cap) and why
 * a scan that DOES hit the cap makes the whole run refuse (and therefore,
 * here, throw) rather than delete an unverifiable partial set, rather than
 * reaching for scheduler-continuation paging. A deleted pair's rows are
 * gone, so a re-run (this migration only ever runs once per deployment via
 * the ledger, but the underlying function is safe to invoke again by hand
 * too) finds no candidates and changes nothing.
 */
export async function runRemoveUnexecutedBalanceSettlementsMigration(
  ctx: MutationCtx,
): Promise<RemoveUnexecutedBalanceSettlementsResult> {
  const result = await runRemoveUnexecutedBalanceSettlements(ctx, {
    execute: true,
  });
  if (result.refused) {
    throw new Error(
      "0071_remove_unexecuted_balance_settlements refused to delete " +
        "anything, so it must NOT be recorded as applied (a silent " +
        "permanent no-op is worse than a failed, retryable deploy step). " +
        "Problems found:\n" +
        result.problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
  return result;
}

export const removeUnexecutedBalanceSettlementsMigration: Migration = {
  name: "0071_remove_unexecuted_balance_settlements",
  run: runRemoveUnexecutedBalanceSettlementsMigration,
};
