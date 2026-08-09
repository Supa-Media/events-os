/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import { isSpend } from "../finances";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * The 2026-08-09 repair of the three markings the Stripe FC sweep un-did.
 *
 * This module writes directly to production financial rows and cannot be
 * rehearsed anywhere else, so what is held still here is the REFUSALS as much
 * as the repair: every precondition must be able to stop the run, and a second
 * run must change nothing. The module identifies its rows by document-id
 * prefix, which a test can't reproduce — the `idPrefixes` arg exists for
 * exactly that and is fed the seeded rows' full ids here.
 */

async function seedActor(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Owner",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  opts: {
    amountCents: number;
    flow: Doc<"transactions">["flow"];
    preMarkFlow?: "inflow" | "outflow";
    transferGroupId?: string;
    merchantName: string;
    source?: Doc<"transactions">["source"];
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: opts.source ?? "stripe_fc",
      flow: opts.flow,
      amountCents: opts.amountCents,
      currency: "usd",
      postedAt: 1_700_000_000_000,
      merchantName: opts.merchantName,
      status: "unreviewed",
      preMarkFlow: opts.preMarkFlow,
      transferGroupId: opts.transferGroupId,
      createdAt: Date.now(),
    }),
  );
}

interface Scene {
  s: ChapterSetup;
  actor: Id<"people">;
  transferLeg: Id<"transactions">;
  transferPartner: Id<"transactions">;
  charge: Id<"transactions">;
  credit: Id<"transactions">;
}

/** Production's state on the morning of 2026-08-09, reproduced. */
async function seedResidue(overrides: { transferLegCents?: number } = {}): Promise<Scene> {
  const s = await setupChapter(newT());
  const actor = await seedActor(s);

  // The $1,000 movement: one leg reverted, one leg survived.
  const transferLeg = await seedTxn(s, {
    amountCents: overrides.transferLegCents ?? 100_000,
    flow: "outflow",
    preMarkFlow: "outflow",
    transferGroupId: "marked-grp-1000",
    merchantName: "PUBLIC WORSHIP | Transfer",
  });
  const transferPartner = await seedTxn(s, {
    amountCents: 100_000,
    flow: "transfer",
    preMarkFlow: "inflow",
    transferGroupId: "marked-grp-1000",
    merchantName: "PUBLIC WORSHIP",
    source: "increase_ach",
  });

  // The AMAZON purchase + return: both legs reverted.
  const charge = await seedTxn(s, {
    amountCents: 2_612,
    flow: "outflow",
    preMarkFlow: "outflow",
    transferGroupId: "marked-grp-amzn",
    merchantName: "Purchase from AMAZON",
  });
  const credit = await seedTxn(s, {
    amountCents: 2_612,
    flow: "inflow",
    preMarkFlow: "inflow",
    transferGroupId: "marked-grp-amzn",
    merchantName: "Return from AMAZON",
  });

  return { s, actor, transferLeg, transferPartner, charge, credit };
}

function argsFor(scene: Scene, execute?: boolean) {
  return {
    actorPersonId: scene.actor,
    actorUserId: scene.s.userId,
    ...(execute ? { execute: true } : {}),
    // Full ids used as prefixes — `startsWith` on a whole id is exact match.
    idPrefixes: {
      transferLeg: scene.transferLeg,
      transferPartner: scene.transferPartner,
      charge: scene.charge,
      credit: scene.credit,
    },
  };
}

const txn = (scene: Scene, id: Id<"transactions">) =>
  run(scene.s.t, (ctx) => ctx.db.get(id)) as Promise<Doc<"transactions">>;

describe("repairSyncClearedTransferMarks", () => {
  test("a dry run reports the whole repair and writes nothing", async () => {
    const scene = await seedResidue();
    const res = await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene),
    );
    expect(res).toEqual({
      dryRun: true,
      transferRestored: 1,
      refundPaired: 2,
      alreadyFixed: 0,
      problems: [],
    });
    expect((await txn(scene, scene.transferLeg)).flow).toBe("outflow");
    expect((await txn(scene, scene.charge)).refundedByTransactionId).toBeUndefined();
    const audit = await run(scene.s.t, (ctx) => ctx.db.query("financeAuditLog").collect());
    expect(audit).toHaveLength(0);
  });

  test("executing restores the $1,000 marking without disturbing the pair linkage", async () => {
    const scene = await seedResidue();
    // Before: the reverted leg is spend again — the $1,000 in the tile.
    expect(isSpend(await txn(scene, scene.transferLeg))).toBe(true);

    await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene, true),
    );

    const leg = await txn(scene, scene.transferLeg);
    expect(leg.flow).toBe("transfer");
    expect(isSpend(leg)).toBe(false);
    // Untouched, because the sweep never touched them either.
    expect(leg.preMarkFlow).toBe("outflow");
    expect(leg.transferGroupId).toBe("marked-grp-1000");
    // The surviving partner is not rewritten.
    const partner = await txn(scene, scene.transferPartner);
    expect(partner.flow).toBe("transfer");
    expect(partner.preMarkFlow).toBe("inflow");
  });

  test("executing re-pairs the AMAZON legs as a refund, not a transfer", async () => {
    const scene = await seedResidue();
    // Before: the charge counts as spend AND the credit reads as revenue, with
    // nothing linking them — the double count.
    expect(isSpend(await txn(scene, scene.charge))).toBe(true);

    await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene, true),
    );

    const charge = await txn(scene, scene.charge);
    const credit = await txn(scene, scene.credit);
    // The flows the sweep left are the ones a refund needs — nothing rewrites them.
    expect(charge.flow).toBe("outflow");
    expect(credit.flow).toBe("inflow");
    expect(charge.refundedByTransactionId).toBe(credit._id);
    expect(credit.refundsTransactionId).toBe(charge._id);
    // The stale transfer marking is gone, so neither row reads as an internal
    // movement any more.
    for (const row of [charge, credit]) {
      expect(row.preMarkFlow).toBeUndefined();
      expect(row.transferGroupId).toBeUndefined();
      expect(row.transferDirection).toBeUndefined();
    }
    // The charge stops consuming its budget, which is the point.
    expect(isSpend(charge)).toBe(false);
  });

  test("every write is on the record", async () => {
    const scene = await seedResidue();
    await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene, true),
    );
    const audit = await run(scene.s.t, (ctx) => ctx.db.query("financeAuditLog").collect());
    // One entry for the restored leg; two per AMAZON leg (transfer off, refund on).
    expect(audit).toHaveLength(5);
    expect(audit.every((a) => a.actorPersonId === scene.actor)).toBe(true);
    expect(audit.every((a) => (a.reason ?? "").length > 0)).toBe(true);
    expect(audit.filter((a) => a.action === "refund_mark")).toHaveLength(2);
  });

  test("a second run changes nothing", async () => {
    const scene = await seedResidue();
    await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene, true),
    );
    const again = await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene, true),
    );
    expect(again).toEqual({
      dryRun: false,
      transferRestored: 0,
      refundPaired: 0,
      alreadyFixed: 3,
      problems: [],
    });
    const audit = await run(scene.s.t, (ctx) => ctx.db.query("financeAuditLog").collect());
    expect(audit).toHaveLength(5);
  });

  test("an amount that isn't the one described stops that repair", async () => {
    const scene = await seedResidue({ transferLegCents: 99_900 });
    const res = await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene, true),
    );
    expect(res.transferRestored).toBe(0);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toContain("SKIPPED");
    expect((await txn(scene, scene.transferLeg)).flow).toBe("outflow");
    // The AMAZON pair is independent and still repaired.
    expect(res.refundPaired).toBe(2);
  });

  test("a stranded leg it was never told about is reported, never guessed at", async () => {
    const scene = await seedResidue();
    await seedTxn(scene.s, {
      amountCents: 4_200,
      flow: "outflow",
      preMarkFlow: "outflow",
      transferGroupId: "marked-grp-other",
      merchantName: "SOMETHING ELSE",
    });
    const res = await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene, true),
    );
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toContain("LEFT ALONE");
    // The three it WAS told about still get fixed.
    expect(res.transferRestored).toBe(1);
    expect(res.refundPaired).toBe(2);
  });

  test("a partner that also reverted is not repaired on one side", async () => {
    const scene = await seedResidue();
    await run(scene.s.t, (ctx) =>
      ctx.db.patch(scene.transferPartner, { flow: "inflow" }),
    );
    const res = await scene.s.t.mutation(
      internal.repairSyncClearedTransferMarks.repairSyncClearedTransferMarks,
      argsFor(scene, true),
    );
    expect(res.transferRestored).toBe(0);
    // Two problems: the partner is itself stranded (unexpected), and the pair
    // no longer matches what this module was told to repair.
    expect(res.problems.join(" ")).toContain("not transfer");
    expect((await txn(scene, scene.transferLeg)).flow).toBe("outflow");
  });
});
