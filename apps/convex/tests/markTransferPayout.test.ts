/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * `finances.markAsTransfer` / `unmarkTransfer` / `markAsPayout` /
 * `unmarkPayout` — reclassifying an ALREADY-INGESTED bank row.
 *
 * The founder-reported bug this exists for: a row reading
 * "PUBLIC WORSHIP | Transfer" landed in "Needs budget" as ordinary spend,
 * because every ingest path sets `flow` from the sign of the amount alone and
 * nothing has ever recognised a transfer — and there was no way to fix it
 * after the fact.
 *
 * The two cases are asymmetric ON PURPOSE, and most of what's asserted here is
 * that asymmetry holding:
 *  - a TRANSFER becomes `flow:"transfer"` (out of spend), requires BOTH legs,
 *    and round-trips losslessly back to the original per-leg flow;
 *  - a PAYOUT stays `flow:"inflow"` (it's real revenue — donations live in
 *    `gifts` and never reach this table, so excluding it would erase income)
 *    and is single-sided.
 * Both keep owing a receipt, and both write `financeAuditLog`.
 */

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; userId?: Id<"users"> },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  opts: {
    amountCents: number;
    flow?: Doc<"transactions">["flow"];
    source?: Doc<"transactions">["source"];
    status?: Doc<"transactions">["status"];
    merchantName?: string;
    isPersonal?: boolean;
    note?: string;
    currency?: string;
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      // `stripe_fc` is the real-world path for the founder's row (the Relay
      // account synced via Stripe Financial Connections).
      source: opts.source ?? "stripe_fc",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents,
      currency: opts.currency,
      postedAt: Date.now(),
      merchantName: opts.merchantName ?? "PUBLIC WORSHIP | Transfer",
      note: opts.note,
      isPersonal: opts.isPersonal,
      status: opts.status ?? "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

/** A bookkeeper (the marking floor) who can act in this chapter. */
async function setupBookkeeper(s: ChapterSetup): Promise<Id<"people">> {
  const me = await seedPerson(s, { name: "Book Keeper", userId: s.userId });
  await grantRole(s, me, "bookkeeper");
  return me;
}

const txn = (s: ChapterSetup, id: Id<"transactions">) =>
  run(s.t, (ctx) => ctx.db.get(id));

const auditFor = (s: ChapterSetup, id: Id<"transactions">) =>
  run(s.t, async (ctx) =>
    (await ctx.db.query("financeAuditLog").collect()).filter(
      (e) => e.subjectId === (id as string),
    ),
  );

describe("finances.markAsTransfer", () => {
  test("marks both legs, drops them out of spend, and links them as one pair", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);

    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });

    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
      note: "moved to the operating account",
    });

    const outDoc = await txn(s, out);
    const innDoc = await txn(s, inn);
    expect(outDoc!.flow).toBe("transfer");
    expect(innDoc!.flow).toBe("transfer");
    // The original direction survives, so un-marking can restore it.
    expect(outDoc!.preMarkFlow).toBe("outflow");
    expect(innDoc!.preMarkFlow).toBe("inflow");
    // One shared group id ties the pair together.
    expect(outDoc!.transferGroupId).toBeTruthy();
    expect(outDoc!.transferGroupId).toBe(innDoc!.transferGroupId);
    // Same-scope marking invents no central<->chapter crossing.
    expect(outDoc!.transferDirection).toBeUndefined();
    // Provenance is not overwritten — the row really did come from the feed.
    expect(outDoc!.source).toBe("stripe_fc");
    expect(outDoc!.note).toBe("moved to the operating account");

    // The actual point: it leaves "Needs budget" / spend.
    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.spend).toBe(0);
    expect(counts.needs_budget).toBe(0);
    expect(counts.transfers).toBe(2);
  });

  test("both legs still owe a receipt after marking (founder constraint)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);

    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
    });

    // Before this feature the outflow leg would have vanished from the chase
    // the instant it stopped being spend, and the inflow leg was never in it.
    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.missing_receipt).toBe(2);
    const chase = await s.as.query(api.finances.receiptChase, {});
    expect(chase.count).toBe(2);
  });

  test("requires two DIFFERENT rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const only = await seedTxn(s, { amountCents: 500 });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: only,
        counterpartTransactionId: only,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("refuses two rows moving the same way", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const a = await seedTxn(s, { amountCents: 500, flow: "outflow" });
    const b = await seedTxn(s, { amountCents: 500, flow: "outflow" });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: a,
        counterpartTransactionId: b,
      }),
    ).rejects.toThrow(/one row leaving an account and one arriving/i);
  });

  test("refuses mismatched amounts", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 99_000, flow: "inflow" });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: out,
        counterpartTransactionId: inn,
      }),
    ).rejects.toThrow(/amounts don't match/i);
  });

  test("refuses a row already marked as a payout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 500, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 500, flow: "inflow" });
    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: inn,
      processor: "givebutter",
    });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: out,
        counterpartTransactionId: inn,
      }),
    ).rejects.toThrow(/processor payout/i);
  });

  test("refuses a row already marked WITH ANOTHER row, and says how to fix it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, {
      amountCents: 100_000,
      flow: "inflow",
      merchantName: "PUBLIC WORSHIP",
    });
    const otherOut = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
    });

    // A live pair is a genuine mis-pick: the message names the row and points
    // at the un-mark, instead of the old "one of those rows is already part of
    // a transfer" that left the founder hunting.
    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: otherOut,
        counterpartTransactionId: inn,
      }),
    ).rejects.toThrow(/PUBLIC WORSHIP is already marked as a transfer/i);
    expect((await txn(s, otherOut))!.flow).toBe("outflow");
  });

  test("re-selecting a pair that's already marked says so", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
    });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: out,
        counterpartTransactionId: inn,
      }),
    ).rejects.toThrow(/already marked as one transfer/i);
  });

  test("RE-PAIRS an orphaned marked leg instead of dead-ending on it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
    });
    // The partner disappears after the fact (a purged sandbox row, a scope
    // reassignment, a half-written group) — the founder-reported stuck state:
    // one row reads as marked, the other doesn't, and nothing can repair it.
    await run(s.t, (ctx) => ctx.db.delete(out));

    const replacement = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: replacement,
      counterpartTransactionId: inn,
    });

    const innDoc = await txn(s, inn);
    const replDoc = await txn(s, replacement);
    expect(innDoc!.flow).toBe("transfer");
    expect(replDoc!.flow).toBe("transfer");
    // The orphan keeps the direction the BANK gave it — a re-pair must never
    // overwrite `preMarkFlow` with the `"transfer"` the row currently reads,
    // or un-marking would dump an inflow back into spend as an outflow.
    expect(innDoc!.preMarkFlow).toBe("inflow");
    expect(replDoc!.preMarkFlow).toBe("outflow");
    expect(innDoc!.transferGroupId).toBe(replDoc!.transferGroupId);

    // And the round trip still works from the re-paired leg.
    await s.as.mutation(api.finances.unmarkTransfer, { transactionId: inn });
    expect((await txn(s, inn))!.flow).toBe("inflow");
    expect((await txn(s, replacement))!.flow).toBe("outflow");
  });

  test("refuses a transfer leg the app RECORDED, naming it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const inn = await seedTxn(s, { amountCents: 500, flow: "inflow" });
    // `source:"transfer"` + no `preMarkFlow` — a `transfers.recordTransfer`
    // leg. Marking it would book the same movement twice.
    const recorded = await seedTxn(s, {
      amountCents: 500,
      flow: "transfer",
      source: "transfer",
      merchantName: "Central grant",
    });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: inn,
        counterpartTransactionId: recorded,
      }),
    ).rejects.toThrow(/Central grant is already a transfer the app recorded/i);
    expect((await txn(s, inn))!.flow).toBe("inflow");
  });

  test("a viewer can't mark", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Nosy Viewer", userId: s.userId });
    await grantRole(s, me, "viewer");
    const out = await seedTxn(s, { amountCents: 500, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 500, flow: "inflow" });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: out,
        counterpartTransactionId: inn,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("writes an audit entry on BOTH legs", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });

    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
      note: "sweep to savings",
    });

    for (const [id, before] of [
      [out, "outflow"],
      [inn, "inflow"],
    ] as const) {
      const entries = await auditFor(s, id);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("transfer_mark");
      expect(entries[0].field).toBe("flow");
      expect(entries[0].before).toBe(before);
      expect(entries[0].after).toBe("transfer");
      expect(entries[0].reason).toBe("sweep to savings");
      expect(entries[0].actorUserId).toBeTruthy();
    }
  });
});

describe("finances.unmarkTransfer", () => {
  test("restores BOTH legs to their original flow and clears the pair", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
    });

    // Un-marking from EITHER leg undoes the whole pair.
    await s.as.mutation(api.finances.unmarkTransfer, { transactionId: inn });

    const outDoc = await txn(s, out);
    const innDoc = await txn(s, inn);
    expect(outDoc!.flow).toBe("outflow");
    expect(innDoc!.flow).toBe("inflow");
    expect(outDoc!.preMarkFlow).toBeUndefined();
    expect(innDoc!.preMarkFlow).toBeUndefined();
    expect(outDoc!.transferGroupId).toBeUndefined();
    expect(innDoc!.transferGroupId).toBeUndefined();

    // Back in spend exactly as before — a lossless round trip.
    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.spend).toBe(1);
    expect(counts.transfers).toBe(0);
  });

  test("refuses a transfer leg the app CREATED, not one a human marked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    // `source:"transfer"` + no `preMarkFlow` — a `transfers.recordTransfer` leg.
    const created = await seedTxn(s, {
      amountCents: 500,
      flow: "transfer",
      source: "transfer",
    });

    await expect(
      s.as.mutation(api.finances.unmarkTransfer, { transactionId: created }),
    ).rejects.toThrow(/recorded transfer/i);
  });

  test("leaves HISTORICAL transfer legs alone — not markable, not chased", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    // Retired kinds still sitting on prod rows. None carry `preMarkFlow`, so
    // none may be un-marked (which would rewrite a booked leg to `outflow`)
    // and none may be dragged into the receipt chase.
    for (const source of ["skim", "launch_grant", "settlement", "reimbursement"] as const) {
      const legacy = await seedTxn(s, {
        amountCents: 500,
        flow: "transfer",
        source,
      });
      await expect(
        s.as.mutation(api.finances.unmarkTransfer, { transactionId: legacy }),
      ).rejects.toThrow(ConvexError);
    }

    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.transfers).toBe(0);
    expect(counts.missing_receipt).toBe(0);
  });
});

describe("finances.markAsPayout", () => {
  test("labels the deposit but leaves it as INCOME", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, {
      amountCents: 250_000,
      flow: "inflow",
      merchantName: "GIVEBUTTER PAYOUT",
    });

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
    });

    const doc = await txn(s, deposit);
    expect(doc!.payoutProcessor).toBe("givebutter");
    // THE load-bearing assertion. Donations live in `gifts` and never reach
    // this table, so this row is the ledger's only record of that revenue —
    // flipping it to `flow:"transfer"` would erase the org's income.
    expect(doc!.flow).toBe("inflow");
    expect(doc!.preMarkFlow).toBeUndefined();
    expect(doc!.transferGroupId).toBeUndefined();

    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.payouts).toBe(1);
    expect(counts.transfers).toBe(0);
    // Now chase-able for its settlement report — an inflow never was before.
    expect(counts.missing_receipt).toBe(1);
  });

  test("refuses an outflow — a payout is money arriving", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const spend = await seedTxn(s, { amountCents: 500, flow: "outflow" });

    await expect(
      s.as.mutation(api.finances.markAsPayout, {
        transactionId: spend,
        processor: "stripe",
      }),
    ).rejects.toThrow(/only an inflow/i);
  });

  test("re-marking to a different processor logs the change; un-marking clears it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, { amountCents: 250_000, flow: "inflow" });

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
    });
    // A true no-op writes nothing.
    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
    });
    expect(await auditFor(s, deposit)).toHaveLength(1);

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "stripe",
    });
    await s.as.mutation(api.finances.unmarkPayout, { transactionId: deposit });

    const doc = await txn(s, deposit);
    expect(doc!.payoutProcessor).toBeUndefined();
    expect(doc!.flow).toBe("inflow"); // never moved, in either direction

    const entries = await auditFor(s, deposit);
    expect(entries.map((e) => e.action)).toEqual([
      "payout_mark",
      "payout_mark",
      "payout_mark",
    ]);
    expect(entries[1].before).toBe("Givebutter");
    expect(entries[1].after).toBe("Stripe");
    expect(entries[2].before).toBe("Stripe");
    expect(entries[2].after).toBeUndefined();
  });

  test("un-marking a row that was never marked is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, { amountCents: 500, flow: "inflow" });

    await expect(
      s.as.mutation(api.finances.unmarkPayout, { transactionId: deposit }),
    ).rejects.toThrow(/isn't marked/i);
  });
});
