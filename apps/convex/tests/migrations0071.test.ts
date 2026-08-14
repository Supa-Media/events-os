/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { anyApi } from "convex/server";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import { CENTRAL } from "@events-os/shared";
import { runRemoveUnexecutedBalanceSettlementsMigration } from "../migrations/0071_remove_unexecuted_balance_settlements";
import { MIGRATIONS } from "../migrations/index";

const MIGRATION_NAME = "0071_remove_unexecuted_balance_settlements";

/**
 * `anyApi` (not the generated `api` from `_generated/api`), deliberately —
 * same reasoning as `removeUnexecutedBalanceSettlements.test.ts`: this
 * sandbox has no live deployment to regenerate `_generated/api.d.ts` against.
 */
const removeUnexecutedBalanceSettlements = anyApi.removeUnexecutedBalanceSettlements
  .removeUnexecutedBalanceSettlements;

/**
 * Migration 0071 — the automatic entry point for the balance-settlement
 * backlog cleanup (see `lib/removeUnexecutedBalanceSettlements.ts`'s module
 * doc for the full specification). This suite proves two things the human
 * -run mutation's own suite (`removeUnexecutedBalanceSettlements.test.ts`)
 * doesn't need to: that the MIGRATION path (no auth, `execute: true`,
 * unscoped) deletes/refuses exactly like the mutation, and that the two
 * entry points are provably backed by ONE shared implementation rather than
 * two that happen to agree today.
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** Central ED — passes `isCentralEdOrFm`/`requireReconciliationAudit`, the
 *  gate the MUTATION entry point uses (the migration needs no such gate). */
async function asCentralEd(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, async (ctx) => {
    await ctx.db.insert("specializedRoles", {
      personId,
      title: "executive_director",
      roleKind: "leadership",
      scope: "central",
      createdAt: Date.now(),
    });
  });
  return personId;
}

/** A clean `balsettle-…` pair, in the exact shape
 *  `lib/transferPair.ts#recordTransferPair` writes for `settleChapterBalances`. */
async function seedBalanceSettlementPair(
  s: ChapterSetup,
  args: {
    date: string;
    amountCents: number;
    postedAt?: number;
    externalIdOnChapterLeg?: string;
    externalIdOnCentralLeg?: string;
    amountOverrideOnChapterLeg?: number;
  },
): Promise<{ groupId: string; legIds: Id<"transactions">[] }> {
  const groupId = `balsettle-${s.chapterId}-${args.date}`;
  const postedAt = args.postedAt ?? Date.now();
  const legIds = await run(s.t, async (ctx) => {
    const ids: Id<"transactions">[] = [];
    for (const scope of [CENTRAL, s.chapterId] as const) {
      const isChapterLeg = scope === s.chapterId;
      ids.push(
        await ctx.db.insert("transactions", {
          chapterId: scope,
          source: "transfer",
          flow: "transfer",
          amountCents:
            isChapterLeg && args.amountOverrideOnChapterLeg != null
              ? args.amountOverrideOnChapterLeg
              : args.amountCents,
          currency: "usd",
          postedAt,
          status: "reconciled",
          transferGroupId: groupId,
          transferDirection: "central_to_chapter",
          transferOrigin: "balance_settlement",
          externalId: isChapterLeg
            ? args.externalIdOnChapterLeg
            : args.externalIdOnCentralLeg,
          createdAt: Date.now(),
        }),
      );
    }
    return ids;
  });
  return { groupId, legIds };
}

async function getRows(
  s: ChapterSetup,
  ids: Id<"transactions">[],
): Promise<(Doc<"transactions"> | null)[]> {
  return run(s.t, async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
}

describe("0071_remove_unexecuted_balance_settlements — migration path", () => {
  test("deletes a qualifying pair, unattended (no auth needed) — and ledgers the delete", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { groupId, legIds } = await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
    });

    const result = await run(s.t, (ctx) =>
      runRemoveUnexecutedBalanceSettlementsMigration(ctx),
    );

    expect(result.dryRun).toBe(false);
    expect(result.refused).toBe(false);
    expect(result.problems).toEqual([]);
    expect(result.deletedLegs).toBe(2);
    expect(result.candidates).toEqual([
      {
        transferGroupId: groupId,
        chapterId: s.chapterId,
        postedAt: expect.any(Number),
        amountCents: 461_690,
        legCount: 2,
      },
    ]);

    const rows = await getRows(s, legIds);
    expect(rows.every((r) => r == null)).toBe(true);
  });

  test("throws — deletes NOTHING, not even the clean pair — when one candidate carries an externalId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const clean = await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 100_000,
    });
    const tainted = await seedBalanceSettlementPair(s, {
      date: "2026-08-11",
      amountCents: 200_000,
      externalIdOnChapterLeg: "increase_txn_real_cash",
    });

    // Unlike the mutation, the migration entry point THROWS on a refusal
    // (see the migration's module doc: `runPending` ledgers whatever `run`
    // returns unconditionally, so returning a refusal would be recorded as
    // permanently applied). The thrown message carries the `problems`
    // verbatim, not a generic failure.
    await expect(
      run(s.t, (ctx) => runRemoveUnexecutedBalanceSettlementsMigration(ctx)),
    ).rejects.toThrow(/externalId/i);

    // The WHOLE run refused — the otherwise-clean pair is untouched too.
    const cleanRows = await getRows(s, clean.legIds);
    expect(cleanRows.every((r) => r != null)).toBe(true);
    const taintedRows = await getRows(s, tainted.legIds);
    expect(taintedRows.every((r) => r != null)).toBe(true);
  });

  test("throws and deletes nothing on an anomalous leg count (3 legs on one group)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { groupId, legIds } = await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
    });
    const strayId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "transfer",
        flow: "transfer",
        amountCents: 461_690,
        postedAt: Date.now(),
        status: "reconciled",
        transferGroupId: groupId,
        transferOrigin: "balance_settlement",
        createdAt: Date.now(),
      }),
    );

    await expect(
      run(s.t, (ctx) => runRemoveUnexecutedBalanceSettlementsMigration(ctx)),
    ).rejects.toThrow(/expected exactly 2/);

    const rows = await getRows(s, [...legIds, strayId]);
    expect(rows.every((r) => r != null)).toBe(true);
  });

  test("a re-run is a clean no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
    });

    const first = await run(s.t, (ctx) =>
      runRemoveUnexecutedBalanceSettlementsMigration(ctx),
    );
    expect(first.deletedLegs).toBe(2);

    const second = await run(s.t, (ctx) =>
      runRemoveUnexecutedBalanceSettlementsMigration(ctx),
    );
    expect(second.candidates).toEqual([]);
    expect(second.deletedLegs).toBe(0);
    expect(second.problems).toEqual([]);
    expect(second.refused).toBe(false);
  });
});

describe("0071 — the shared core is genuinely shared, not two implementations that happen to agree", () => {
  /**
   * The two entry points now deliberately DIFFER at the refusal edge — the
   * mutation returns `{ refused: true, problems }`, the migration throws
   * (see both files' module docs for why). That is a difference in HOW each
   * reports a refusal, not in WHAT they consider unsafe: this proves the
   * WHAT still agrees, by running the mutation first (it refuses and writes
   * nothing), then running the migration against the SAME unmutated data and
   * asserting its thrown message contains every problem the mutation found,
   * verbatim. Any drift in a precondition's wording, ordering, or threshold
   * between the two entry points would break this.
   */
  test("mutation (execute:true) and migration agree on exactly which problems block a refusal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
      externalIdOnChapterLeg: "increase_txn_shared_core",
    });

    const viaMutation = await s.as.mutation(removeUnexecutedBalanceSettlements, {
      execute: true,
    });
    expect(viaMutation.refused).toBe(true);
    expect(viaMutation.deletedLegs).toBe(0);
    expect(viaMutation.problems.length).toBeGreaterThan(0);

    let thrown: Error | undefined;
    try {
      await run(s.t, (ctx) => runRemoveUnexecutedBalanceSettlementsMigration(ctx));
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    for (const problem of viaMutation.problems) {
      expect(thrown!.message).toContain(problem);
    }
  });

  test("mutation's dry run predicts exactly what the migration actually deletes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const { groupId } = await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
    });

    const dryRun = await s.as.mutation(removeUnexecutedBalanceSettlements, {});
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.candidates).toEqual([
      {
        transferGroupId: groupId,
        chapterId: s.chapterId,
        postedAt: expect.any(Number),
        amountCents: 461_690,
        legCount: 2,
      },
    ]);

    const migrationRun = await run(s.t, (ctx) =>
      runRemoveUnexecutedBalanceSettlementsMigration(ctx),
    );
    expect(migrationRun.candidates).toEqual(dryRun.candidates);
    expect(migrationRun.totalSignedBookCents).toBe(dryRun.totalSignedBookCents);
    expect(migrationRun.deletedLegs).toBe(2);
    expect(migrationRun.dryRun).toBe(false);
  });

  test("amount-mismatch refusal agrees across both entry points too", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
      amountOverrideOnChapterLeg: 461_691,
    });

    const viaMutation = await s.as.mutation(removeUnexecutedBalanceSettlements, {
      execute: true,
    });
    expect(viaMutation.refused).toBe(true);

    let thrown: Error | undefined;
    try {
      await run(s.t, (ctx) => runRemoveUnexecutedBalanceSettlementsMigration(ctx));
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    for (const problem of viaMutation.problems) {
      expect(thrown!.message).toContain(problem);
    }
  });
});

describe("0071 — a refusal must NOT be ledgered (retryable on the next deploy)", () => {
  /**
   * Pre-seeds the ledger with every OTHER registered migration (simulating a
   * deployment that has already applied everything through the one before
   * 0071 in prior deploys — the realistic production shape), then seeds data
   * that makes 0071 refuse and calls the REAL `runPending` entry point (not
   * the bare `run` function) so this exercises the actual transaction
   * boundary `migrations.ts#runPending` runs inside.
   */
  async function preLedgerEverythingExcept0071(t: TestConvex): Promise<void> {
    const before = MIGRATIONS.filter((m) => m.name !== MIGRATION_NAME);
    await run(t, async (ctx) => {
      for (const m of before) {
        await ctx.db.insert("schemaMigrations", { name: m.name, ranAt: Date.now() });
      }
    });
  }

  async function ledgerNames(t: TestConvex): Promise<string[]> {
    return run(t, async (ctx) =>
      (await ctx.db.query("schemaMigrations").collect()).map((r) => r.name),
    );
  }

  test("runPending rejects and writes NO ledger row for 0071 when it refuses", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await preLedgerEverythingExcept0071(t);
    await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
      externalIdOnChapterLeg: "increase_txn_ledger_safety",
    });

    await expect(t.mutation(internal.migrations.runPending, {})).rejects.toThrow(
      /externalId/i,
    );

    const names = await ledgerNames(t);
    expect(names).not.toContain(MIGRATION_NAME);

    // Everything pre-ledgered before this call is UNTOUCHED — `runPending`
    // skipped every one of them (already-ledgered) before ever reaching
    // 0071, so this run's throw had nothing of theirs to roll back.
    const before = MIGRATIONS.filter((m) => m.name !== MIGRATION_NAME).map(
      (m) => m.name,
    );
    for (const name of before) {
      expect(names).toContain(name);
    }
    expect(names).toHaveLength(before.length);
  });

  test("genuinely retryable: fixing the data and calling runPending again applies 0071 cleanly", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await preLedgerEverythingExcept0071(t);
    const { legIds } = await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
      externalIdOnChapterLeg: "increase_txn_will_be_cleared",
    });

    await expect(t.mutation(internal.migrations.runPending, {})).rejects.toThrow();
    expect(await ledgerNames(t)).not.toContain(MIGRATION_NAME);

    // A human resolves the refusal the way the runbook says to — here,
    // simulated by clearing the externalId a human would have investigated
    // and confirmed was a data-entry mistake (not real cash movement).
    await run(t, async (ctx) => {
      for (const id of legIds) {
        await ctx.db.patch(id, { externalId: undefined });
      }
    });

    const res = await t.mutation(internal.migrations.runPending, {});
    expect(res.applied).toEqual([MIGRATION_NAME]);
    expect(await ledgerNames(t)).toContain(MIGRATION_NAME);

    const rows = await getRows(s, legIds);
    expect(rows.every((r) => r == null)).toBe(true);
  });
});
