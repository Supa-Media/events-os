/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * `finances.receiptChase` — the FM's missing-receipt chase list:
 *
 *  - Charges still owed a receipt, grouped by CARDHOLDER (the txn's
 *    `personId`, else the owner of its `cardId` — the same resolution the
 *    reconcile Cardholder column uses), with a null-person "Unattributed"
 *    group for charges resolving to nobody.
 *  - Within a group charges sort by amount DESC; groups sort by their total
 *    DESC, with Unattributed pinned LAST regardless of size.
 *  - "Needs a receipt" = a SPEND charge with no receipt and not yet
 *    `reconciled` — receipted / reconciled / excluded / personal / inflow /
 *    transfer rows never appear (deliberately narrower than the reconcile
 *    grid's `missing_receipt` pill, which keeps reconciled rows).
 *  - Viewer+ gated, same floor as `listReconcile`.
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
    personId?: Id<"people">;
    cardId?: Id<"cards">;
    flow?: Doc<"transactions">["flow"];
    status?: Doc<"transactions">["status"];
    isPersonal?: boolean;
    receiptStorageId?: Id<"_storage">;
    merchantName?: string;
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents,
      postedAt: Date.now(),
      merchantName: opts.merchantName,
      personId: opts.personId,
      cardId: opts.cardId,
      isPersonal: opts.isPersonal,
      receiptStorageId: opts.receiptStorageId,
      status: opts.status ?? "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

describe("finances.receiptChase", () => {
  test("groups by cardholder, amounts desc within, group totals desc, Unattributed last", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "FM", userId: s.userId });
    await grantRole(s, me, "manager");

    const alice = await seedPerson(s, { name: "Alice" });
    const bob = await seedPerson(s, { name: "Bob" });

    // Alice owes two ($30 + $10 = $40); Bob owes one ($25); one charge has no
    // person/card at all ($99 — bigger than everyone, but still pinned last).
    const aliceSmall = await seedTxn(s, { personId: alice, amountCents: 1000 });
    const aliceBig = await seedTxn(s, { personId: alice, amountCents: 3000 });
    const bobTxn = await seedTxn(s, { personId: bob, amountCents: 2500 });
    const orphan = await seedTxn(s, { amountCents: 9900 });

    const chase = await s.as.query(api.finances.receiptChase, {});
    expect(chase.count).toBe(4);
    expect(chase.totalCents).toBe(1000 + 3000 + 2500 + 9900);

    expect(chase.groups.map((g) => g.name)).toEqual([
      "Alice",
      "Bob",
      "Unattributed",
    ]);
    expect(chase.groups[0].personId).toBe(alice);
    expect(chase.groups[0].totalCents).toBe(4000);
    // Biggest charge first within the group.
    expect(chase.groups[0].transactions.map((tr) => tr.id)).toEqual([
      aliceBig,
      aliceSmall,
    ]);
    expect(chase.groups[1].transactions.map((tr) => tr.id)).toEqual([bobTxn]);
    expect(chase.groups[2].personId).toBeNull();
    expect(chase.groups[2].transactions.map((tr) => tr.id)).toEqual([orphan]);
  });

  test("resolves the cardholder through the card when the txn has no personId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "FM", userId: s.userId });
    await grantRole(s, me, "manager");

    const holder = await seedPerson(s, { name: "Cardholder Cara" });
    const cardId = await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: holder,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    await seedTxn(s, { cardId, amountCents: 1500 });

    const chase = await s.as.query(api.finances.receiptChase, {});
    expect(chase.groups).toHaveLength(1);
    expect(chase.groups[0].personId).toBe(holder);
    expect(chase.groups[0].name).toBe("Cardholder Cara");
  });

  test("only genuinely receipt-owing SPEND charges appear", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "FM", userId: s.userId });
    await grantRole(s, me, "manager");
    const alice = await seedPerson(s, { name: "Alice" });

    const owing = await seedTxn(s, { personId: alice, amountCents: 700 });
    // None of these belong in the chase list:
    await seedTxn(s, {
      personId: alice,
      amountCents: 800,
      receiptStorageId: await storeBlob(t), // receipt already attached
    });
    await seedTxn(s, { personId: alice, amountCents: 900, status: "reconciled" }); // treasurer closed it
    await seedTxn(s, { personId: alice, amountCents: 1000, status: "excluded" }); // intentionally excluded
    await seedTxn(s, { personId: alice, amountCents: 1100, isPersonal: true }); // personal (repayment flow)
    await seedTxn(s, { personId: alice, amountCents: 1200, flow: "inflow" }); // not spend
    await seedTxn(s, { personId: alice, amountCents: 1300, flow: "transfer" }); // not spend

    const chase = await s.as.query(api.finances.receiptChase, {});
    expect(chase.count).toBe(1);
    expect(chase.groups).toHaveLength(1);
    expect(chase.groups[0].transactions.map((tr) => tr.id)).toEqual([owing]);
    expect(chase.totalCents).toBe(700);
  });

  test("a caller with NO finance seat is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "No-seat member", userId: s.userId });

    let caught: unknown;
    try {
      await s.as.query(api.finances.receiptChase, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });
});
