/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Removable, multiple receipts on a charge (founder, 2026-10-24: "I need to be
 * able to remove this attachment (I uploaded it by mistake)… We also need to
 * be able to attach more than one receipt at a time").
 *
 *  - a charge takes several receipts through `attachReceipt`, one call each;
 *  - whoever may attach may remove (`transactionReceipts.removeReceipt`) —
 *    until the coding is approved, after which only bookkeeper+ may;
 *  - removing the cached first receipt repoints the cache at the next one,
 *    and removing the last clears it.
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

async function grantBookkeeper(s: ChapterSetup, personId: Id<"people">) {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "bookkeeper",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  personId: Id<"people">,
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 2526,
      postedAt: Date.now(),
      personId,
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

async function linkedReceipts(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
): Promise<Array<{ receiptId: Id<"receipts">; storageId: Id<"_storage"> }>> {
  return await run(s.t, async (ctx) => {
    const links = await ctx.db
      .query("receiptLinks")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .collect();
    const out = [];
    for (const l of links) {
      const r = await ctx.db.get(l.receiptId);
      if (r) out.push({ receiptId: r._id, storageId: r.storageId });
    }
    return out;
  });
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConvexError);
    return (err as ConvexError<{ code: string }>).data.code;
  }
  return undefined;
}

describe("multiple receipts + removeReceipt", () => {
  test("a member attaches two receipts to their own charge, then removes the wrong one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    const txnId = await seedTxn(s, me);
    const wrong = await storeBlob(t);
    const right = await storeBlob(t);

    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId: wrong });
    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId: right });
    const both = await linkedReceipts(s, txnId);
    expect(both).toHaveLength(2);

    const perms = await s.as.query(api.transactionReceipts.permissions, { transactionId: txnId });
    expect(perms).toEqual({ canAttach: true, canRemove: true, removeLockedByApproval: false });

    const wrongReceipt = both.find((r) => r.storageId === wrong)!;
    await s.as.mutation(api.transactionReceipts.removeReceipt, {
      transactionId: txnId,
      receiptId: wrongReceipt.receiptId,
    });

    const left = await linkedReceipts(s, txnId);
    expect(left.map((r) => r.storageId)).toEqual([right]);
    // The cache pointed at the first (wrong) file; it now points at the other.
    const doc = await run(t, (ctx) => ctx.db.get(txnId));
    expect(doc?.receiptStorageId).toBe(right);
    // The receipt document survives — only the link came off.
    const kept = await run(t, (ctx) => ctx.db.get(wrongReceipt.receiptId));
    expect(kept?.linkCount).toBe(0);
  });

  test("removing the last receipt clears the cache and logs receipt_detach", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    const txnId = await seedTxn(s, me);
    const storageId = await storeBlob(t);
    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId });
    const [only] = await linkedReceipts(s, txnId);

    await s.as.mutation(api.transactionReceipts.removeReceipt, {
      transactionId: txnId,
      receiptId: only.receiptId,
    });

    const doc = await run(t, (ctx) => ctx.db.get(txnId));
    expect(doc?.receiptStorageId).toBeUndefined();
    const audit = await run(t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .filter((q) => q.eq(q.field("action"), "receipt_detach"))
        .collect(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].afterKey).toBe("none");
  });

  test("a receipt not attached to the charge is NOT_FOUND", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    const a = await seedTxn(s, me);
    const b = await seedTxn(s, me);
    await s.as.mutation(api.finances.attachReceipt, { transactionId: a, storageId: await storeBlob(t) });
    const [onA] = await linkedReceipts(s, a);

    expect(
      await codeOf(
        s.as.mutation(api.transactionReceipts.removeReceipt, {
          transactionId: b,
          receiptId: onA.receiptId,
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a no-seat caller cannot remove a receipt from someone else's charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    await grantBookkeeper(s, me);
    const other = await seedPerson(s, { name: "Someone else" });
    const txnId = await seedTxn(s, other);
    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId: await storeBlob(t) });
    const [r] = await linkedReceipts(s, txnId);
    // Drop the grant: now a no-seat member looking at someone else's charge.
    await run(t, async (ctx) => {
      for (const g of await ctx.db.query("financeRoles").collect()) await ctx.db.delete(g._id);
    });

    const perms = await s.as.query(api.transactionReceipts.permissions, { transactionId: txnId });
    expect(perms.canRemove).toBe(false);
    expect(
      await codeOf(
        s.as.mutation(api.transactionReceipts.removeReceipt, {
          transactionId: txnId,
          receiptId: r.receiptId,
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  test("once the coding is approved, the member can't remove — a bookkeeper still can", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Caller", userId: s.userId });
    const txnId = await seedTxn(s, me);
    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId: await storeBlob(t) });
    const [r] = await linkedReceipts(s, txnId);
    await run(t, (ctx) => ctx.db.patch(txnId, { codingState: "approved" }));

    const perms = await s.as.query(api.transactionReceipts.permissions, { transactionId: txnId });
    expect(perms).toEqual({ canAttach: true, canRemove: false, removeLockedByApproval: true });
    expect(
      await codeOf(
        s.as.mutation(api.transactionReceipts.removeReceipt, {
          transactionId: txnId,
          receiptId: r.receiptId,
        }),
      ),
    ).toBe("CODING_APPROVED");

    await grantBookkeeper(s, me);
    await s.as.mutation(api.transactionReceipts.removeReceipt, {
      transactionId: txnId,
      receiptId: r.receiptId,
    });
    expect(await linkedReceipts(s, txnId)).toHaveLength(0);
  });
});
