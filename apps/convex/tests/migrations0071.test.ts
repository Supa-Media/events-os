/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { anyApi } from "convex/server";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import { CENTRAL } from "@events-os/shared";
import { runRemoveUnexecutedBalanceSettlementsMigration } from "../migrations/0071_remove_unexecuted_balance_settlements";

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

  test("deletes NOTHING — not even the clean pair — when one candidate carries an externalId", async () => {
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

    const result = await run(s.t, (ctx) =>
      runRemoveUnexecutedBalanceSettlementsMigration(ctx),
    );

    expect(result.refused).toBe(true);
    expect(result.deletedLegs).toBe(0);
    // The clean pair still shows up as a passing candidate (it's the tainted
    // one that failed a precondition) — but `refused` blocks the WRITE for
    // the whole run, so `deletedLegs` stays 0 and both pairs' rows survive.
    expect(result.candidates).toEqual([
      {
        transferGroupId: clean.groupId,
        chapterId: s.chapterId,
        postedAt: expect.any(Number),
        amountCents: 100_000,
        legCount: 2,
      },
    ]);
    expect(result.problems.some((p) => /externalId/i.test(p))).toBe(true);

    // The WHOLE run refused — the otherwise-clean pair is untouched too.
    const cleanRows = await getRows(s, clean.legIds);
    expect(cleanRows.every((r) => r != null)).toBe(true);
    const taintedRows = await getRows(s, tainted.legIds);
    expect(taintedRows.every((r) => r != null)).toBe(true);
  });

  test("deletes nothing on an anomalous leg count (3 legs on one group)", async () => {
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

    const result = await run(s.t, (ctx) =>
      runRemoveUnexecutedBalanceSettlementsMigration(ctx),
    );

    expect(result.refused).toBe(true);
    expect(result.deletedLegs).toBe(0);
    expect(result.problems.some((p) => p.includes("expected exactly 2"))).toBe(
      true,
    );

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
  test("mutation (execute:true) and migration agree byte-for-byte on a refusal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await seedBalanceSettlementPair(s, {
      date: "2026-08-10",
      amountCents: 461_690,
      externalIdOnChapterLeg: "increase_txn_shared_core",
    });

    // The mutation refuses and writes nothing, so the migration afterward
    // sees IDENTICAL data — any drift between the two entry points'
    // precondition logic (wording, ordering, thresholds) would show up as a
    // mismatch here.
    const viaMutation = await s.as.mutation(removeUnexecutedBalanceSettlements, {
      execute: true,
    });
    expect(viaMutation.refused).toBe(true);
    expect(viaMutation.deletedLegs).toBe(0);

    const viaMigration = await run(s.t, (ctx) =>
      runRemoveUnexecutedBalanceSettlementsMigration(ctx),
    );

    expect(viaMigration).toEqual(viaMutation);
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
    const viaMigration = await run(s.t, (ctx) =>
      runRemoveUnexecutedBalanceSettlementsMigration(ctx),
    );

    expect(viaMigration.refused).toBe(true);
    expect(viaMigration).toEqual(viaMutation);
  });
});
