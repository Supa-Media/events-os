/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * D3 (member view strip-down) backend fixes:
 *
 *  - `personTransactions` must let a caller with NO finance seat read their OWN
 *    transactions (the "My transactions" member tab) — previously this threw
 *    for anyone without at least the viewer finance role, which blanked the
 *    dashboard's member view for every real no-seat member. Looking up a
 *    DIFFERENT person's transactions still requires a finance-role grant.
 *  - `attachReceipt` must let a caller with NO finance seat attach a receipt to
 *    their OWN transaction (previously bookkeeper-only); attaching to someone
 *    ELSE's transaction still requires bookkeeper-or-above.
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
  opts: { personId?: Id<"people">; amountCents?: number },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 1000,
      postedAt: Date.now(),
      personId: opts.personId,
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

describe("personTransactions — no-seat member reads their own", () => {
  test("a caller with NO finance seat reads their OWN transactions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    const mine = await seedTxn(s, { personId: me, amountCents: 4200 });
    // A stranger's txn must never leak in.
    const other = await seedPerson(s, { name: "Someone else" });
    await seedTxn(s, { personId: other, amountCents: 999 });

    const rows = await s.as.query(api.finances.personTransactions, {});
    expect(rows.map((r) => r.id)).toEqual([mine]);
    expect(rows[0].amountCents).toBe(4200);
  });

  test("a no-seat caller CANNOT read a different person's transactions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Caller", userId: s.userId });
    const other = await seedPerson(s, { name: "Someone else" });
    await seedTxn(s, { personId: other });

    let caught: unknown;
    try {
      await s.as.query(api.finances.personTransactions, { personId: other });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "FORBIDDEN",
    );
  });

  test("a viewer (or above) CAN read a different person's transactions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    await grantRole(s, me, "viewer");
    const other = await seedPerson(s, { name: "Someone else" });
    const otherTxn = await seedTxn(s, { personId: other, amountCents: 555 });

    const rows = await s.as.query(api.finances.personTransactions, {
      personId: other,
    });
    expect(rows.map((r) => r.id)).toEqual([otherTxn]);
  });

  test("never includes the bookkeeper's internal note, even when set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    const mine = await seedTxn(s, { personId: me, amountCents: 4200 });
    await run(s.t, (ctx) => ctx.db.patch(mine, { note: "Reimbursed via Venmo" }));

    const rows = await s.as.query(api.finances.personTransactions, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("note");
  });

  test("no roster row at all → empty (no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const rows = await s.as.query(api.finances.personTransactions, {});
    expect(rows).toEqual([]);
  });
});

describe("attachReceipt — own-txn allowance for no-seat members", () => {
  test("a caller with NO finance seat attaches a receipt to their OWN transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    const txnId = await seedTxn(s, { personId: me });
    const storageId = await storeBlob(t);

    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txnId,
      storageId,
    });

    const doc = await run(t, (ctx) => ctx.db.get(txnId));
    expect(doc?.receiptStorageId).toBe(storageId);
  });

  test("a no-seat caller CANNOT attach a receipt to another person's transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Caller", userId: s.userId });
    const other = await seedPerson(s, { name: "Someone else" });
    const txnId = await seedTxn(s, { personId: other });
    const storageId = await storeBlob(t);

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.attachReceipt, {
        transactionId: txnId,
        storageId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "FORBIDDEN",
    );
  });

  test("a bookkeeper attaches a receipt to ANY chapter transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Bookkeeper", userId: s.userId });
    await grantRole(s, me, "bookkeeper");
    const other = await seedPerson(s, { name: "Someone else" });
    const txnId = await seedTxn(s, { personId: other });
    const storageId = await storeBlob(t);

    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txnId,
      storageId,
    });

    const doc = await run(t, (ctx) => ctx.db.get(txnId));
    expect(doc?.receiptStorageId).toBe(storageId);
  });
});
