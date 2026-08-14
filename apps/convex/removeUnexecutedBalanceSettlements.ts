/**
 * One-time, human-run entry point: delete the historical backlog of
 * never-executed morning-engine BALANCE SETTLEMENT pairs.
 *
 * The full specification — what went wrong, why deletion (not exclude, not
 * offset) is the founder-authorized remedy, every precondition a pair must
 * pass, and why the safety argument is an enforced check rather than a
 * comment — lives on `runRemoveUnexecutedBalanceSettlements` in
 * `lib/removeUnexecutedBalanceSettlements.ts`. Read that file first; this one
 * is just the gated entry point.
 *
 * ── WHY A SEPARATE AUTOMATIC ENTRY POINT EXISTS ─────────────────────────────
 * `migrations/0071_remove_unexecuted_balance_settlements.ts` calls the exact
 * same shared core (`runRemoveUnexecutedBalanceSettlements`) from the
 * deploy-time migration runner (`migrations:runPending`, wired into
 * `.github/workflows/deploy-convex.yml`) — no signed-in identity, deploy-admin
 * privileges, `execute: true`, unscoped. THIS mutation stays as the
 * human-facing inspection/dry-run surface: an ED/FM can call it with
 * `execute` omitted to see exactly what the automatic run found (or will
 * find), or scoped by `chapterId`/`fromDateMs`/`toDateMs` to review a slice
 * by hand. Both entry points share ONE implementation of every precondition
 * — this file adds authorization and nothing else.
 *
 * A REFUSAL RETURNS HERE; IT THROWS ON THE MIGRATION. This handler passes the
 * shared core's result straight through — a refusal comes back as
 * `{ refused: true, problems: [...] }` for a human to read, exactly like any
 * other result, because a person is on the other end of this call. The
 * migration entry point cannot afford that: `migrations.ts#runPending`
 * ledgers whatever `run` returns UNCONDITIONALLY, so a migration that merely
 * RETURNED a refusal would be permanently (and silently) recorded as
 * "applied" and never retried. See
 * `migrations/0071_remove_unexecuted_balance_settlements.ts`'s doc for why it
 * throws instead — that asymmetry is deliberate, lives only at the two entry
 * points, and the shared core itself has no opinion about it.
 *
 * ── GATED — the strongest finance authority in this codebase ───────────────
 * `requireReconciliationAudit` (`lib/reconciliationAccess.ts`) — the same
 * Executive-Director/Financial-Manager gate every OTHER control on the
 * reconciliation audit surface uses (`reconciliation.ts`'s
 * `setRealMovementEnabled`, `setReconciliationPaused`,
 * `setReconciliationStart`, ...). Per CLAUDE.md's "Gate It Behind a Power"
 * rule this is an EXISTING `require*` resolver, not an inline seat check and
 * not a new capability.
 *
 * This is a public `mutation`, unlike `reverseExcludedSettlementLoop.ts`'s
 * `internalMutation`s — deliberately. An `internalMutation` can only be
 * invoked by another Convex function, or by the CLI/dashboard running as a
 * deploy admin with no signed-in user — meaning no `ctx.auth` identity for
 * `requireReconciliationAudit` to check, which would make a real
 * finance-authority gate either unreachable or permanently FORBIDDEN. A
 * public `mutation` gated exactly like `setRealMovementEnabled` lets the
 * actual ED/FM run this from their OWN authenticated session (the Convex
 * dashboard's function runner with an identity override, or the app's own
 * client while signed in) — the gate is real, not decorative.
 *
 * ── RUNBOOK (manual inspection; the migration already does the real run) ───
 *   1. DRY RUN, as the ED or FM: call with `execute` omitted (or `false`),
 *      optionally scoped with `chapterId`/`fromDateMs`/`toDateMs`. Read
 *      `candidates` and confirm the group ids / dates / amounts look right.
 *      Confirm `problems` is `[]` and `totalSignedBookCents` is `0`.
 *   2. The next `main` deploy runs `migrations:runPending`, which applies
 *      `0071_remove_unexecuted_balance_settlements` automatically — no manual
 *      `execute: true` call is required. This mutation's `execute: true` path
 *      still works, for a scoped/manual cleanup of anything the migration's
 *      unscoped run declined to touch because it refused (e.g. an anomaly
 *      that needs a human to look at one slice at a time).
 *   3. RECORD what was deleted OUTSIDE the app — the migration's ledger row
 *      (`schemaMigrations.result`, see `migrations.ts#runPending`) already
 *      records group ids / chapter / posted date / amount / leg count for
 *      whatever it deleted; this file (and the PR that shipped it) is the
 *      human-readable record for a manual run, per `transfers-ops-notes.md`'s
 *      raw-deletion path.
 *
 * Delete this module once the migration has run in production and any
 * manual follow-up is complete.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  runRemoveUnexecutedBalanceSettlements,
  type RemoveUnexecutedBalanceSettlementsResult,
} from "./lib/removeUnexecutedBalanceSettlements";
import { requireReconciliationAudit } from "./lib/reconciliationAccess";

export const removeUnexecutedBalanceSettlements = mutation({
  args: {
    /** Defaults to `false` — a dry run that writes nothing. */
    execute: v.optional(v.boolean()),
    /** Narrow to one chapter's pairs. Default: every chapter. */
    chapterId: v.optional(v.id("chapters")),
    /** Inclusive lower bound on each pair's `postedAt`. Default: unbounded. */
    fromDateMs: v.optional(v.number()),
    /** Inclusive upper bound on each pair's `postedAt`. Default: unbounded. */
    toDateMs: v.optional(v.number()),
  },
  returns: v.object({
    /** `true` iff this call did NOT delete anything — either because
     *  `execute` was omitted/false, or because the run refused. */
    dryRun: v.boolean(),
    /** Every pair that passed all preconditions — what WAS (or would be)
     *  deleted. Empty on a clean re-run after a successful execute. */
    candidates: v.array(
      v.object({
        transferGroupId: v.string(),
        chapterId: v.id("chapters"),
        postedAt: v.number(),
        amountCents: v.number(),
        legCount: v.number(),
      }),
    ),
    /** Sum of `signedBookCents` across every leg in `candidates`. MUST be 0
     *  for `execute: true` to actually delete anything. */
    totalSignedBookCents: v.number(),
    /** Rows actually deleted by THIS call. 0 on a dry run or a refused run. */
    deletedLegs: v.number(),
    /** Every precondition failure found, across every candidate group. Any
     *  entry here blocks `execute` for the WHOLE run. */
    problems: v.array(v.string()),
    /** `true` iff `problems` is non-empty OR the book-value guard tripped —
     *  i.e. `execute: true` was requested but refused. */
    refused: v.boolean(),
  }),
  handler: async (ctx, { execute, chapterId, fromDateMs, toDateMs }) => {
    await requireReconciliationAudit(ctx);
    const result: RemoveUnexecutedBalanceSettlementsResult =
      await runRemoveUnexecutedBalanceSettlements(ctx, {
        execute,
        chapterId,
        fromDateMs,
        toDateMs,
      });
    return result;
  },
});
