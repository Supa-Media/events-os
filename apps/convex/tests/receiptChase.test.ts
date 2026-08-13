/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  disarmCodingPolicy,
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api, internal } from "../_generated/api";
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
 *    transfer rows never appear. This is the SAME predicate as the reconcile
 *    grid's `missing_receipt` pill (kept in lockstep on purpose — see
 *    `listReconcile`'s doc comment).
 *  - `scope`/`chapterId` args mirror `listReconcile`'s (central / central
 *    drill-down / caller's own chapter) — same authz.
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
    categoryId?: Id<"budgetCategories">;
    feeOrigin?: Doc<"transactions">["feeOrigin"];
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
      categoryId: opts.categoryId,
      feeOrigin: opts.feeOrigin,
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
    // `receiptChase` returns the UNION of "owes a document" and "owes a
    // coding". This test is about the first predicate only — that's what its
    // fixtures are built to distinguish — so the coding half is disarmed here.
    // Without it the receipted-but-uncoded row below joins the list on the
    // coding side and this stops testing what it names. The coding half has
    // its own coverage in `codingReminders.test.ts`.
    await disarmCodingPolicy(t);
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

// ── scope/chapterId — mirrors `listReconcile`'s central drill-down exactly ──
// (see `listReconcileChapterDrilldown.test.ts`) so the Reconcile screen's
// "Chase receipts" button can carry the grid's current scope through and
// always land on the SAME bucket the missing_receipt pill just counted.
describe("finances.receiptChase: scope/chapterId (mirrors listReconcile's drill-down)", () => {
  async function asCentralManager(s: ChapterSetup): Promise<Id<"people">> {
    const personId = await seedPerson(s, { name: "Central FM", userId: s.userId });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "manager",
        scope: "central",
        createdAt: Date.now(),
      }),
    );
    return personId;
  }

  async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
    );
  }

  async function seedOwingTxn(
    s: ChapterSetup,
    chapterId: Id<"chapters"> | "central",
    merchantName: string,
  ): Promise<Id<"transactions">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 1500,
        postedAt: Date.now(),
        merchantName,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );
  }

  test("a central manager CAN chase a different chapter's receipts via chapterId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    await seedOwingTxn(s, boston, "Boston charge");

    const res = await s.as.query(api.finances.receiptChase, { chapterId: boston });
    expect(res.count).toBe(1);
    expect(res.groups[0].transactions[0].merchantName).toBe("Boston charge");
  });

  test("a chapter-scoped manager CANNOT chase a different chapter's receipts", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Chapter FM", userId: s.userId });
    await grantRole(s, me, "manager");
    const boston = await makeChapter(s, "Boston");
    await seedOwingTxn(s, boston, "Boston charge");

    await expect(
      s.as.query(api.finances.receiptChase, { chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("scope:\"central\" chases the CENTRAL-owned bucket", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    await seedOwingTxn(s, s.chapterId, "Home charge");
    await seedOwingTxn(s, "central", "Central charge");

    const res = await s.as.query(api.finances.receiptChase, { scope: "central" });
    expect(res.count).toBe(1);
    expect(res.groups[0].transactions[0].merchantName).toBe("Central charge");
  });

  test("omitting scope/chapterId still resolves the caller's own chapter (unchanged)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Chapter FM", userId: s.userId });
    await grantRole(s, me, "manager");
    await seedOwingTxn(s, s.chapterId, "Home charge");

    const res = await s.as.query(api.finances.receiptChase, {});
    expect(res.count).toBe(1);
    expect(res.groups[0].transactions[0].merchantName).toBe("Home charge");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * A PROCESSOR FEE CAN NEVER HAVE A RECEIPT — so it must not be chased for one.
 *
 * The bug: `finances.needsDocumentation` and `finances.requiresCoding` both
 * exempt `feeOrigin` rows, but `lib/codingReminders.ts#chaseEligible` did not,
 * and `chargeOutstanding` read only the POLICY-DATE half of `requiresCoding`.
 * `receiptChase`, the reconcile `chaseCount` and the nudge targets are all the
 * UNION of those two predicates, so a Stripe/Givebutter fee row — written
 * `flow:"outflow"`, `status:"categorized"`, receipt-less by nature
 * (`processorFees.ts`) — came back as "needs coding and a receipt" from one
 * half while the other half said it owed nothing. Cardholders got nudged for
 * Stripe's cut.
 *
 * THE CONTRAST IS THE TEST. The exemption is by ORIGIN (`feeOrigin`), never by
 * category — a Givebutter paid subscription the org CHOSE to buy sits in the
 * same "Bank & Fees" category and is still chased for all three. A fix that
 * exempted the category instead would silence a real chase, and only the
 * second half of each assertion below would catch it.
 */
describe("finances.receiptChase: a non-discretionary fee is never chased", () => {
  async function seedFeeAndSubscription(s: ChapterSetup): Promise<{
    alice: Id<"people">;
    fee: Id<"transactions">;
    subscription: Id<"transactions">;
  }> {
    const alice = await seedPerson(s, { name: "Alice" });
    // ONE category, shared by both rows: "Bank & Fees" is where the fee sweep
    // codes its rows AND where a platform subscription lands.
    const fundId = await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const categoryId = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId,
        name: "Bank & Fees",
        kind: "lineItem",
        createdAt: Date.now(),
      }),
    );
    // Exactly what `processorFees.ts` writes, down to the status — and
    // deliberately ATTRIBUTED to Alice, so this passes because of the fee
    // marker and not because nobody could be nudged for it.
    const fee = await seedTxn(s, {
      personId: alice,
      amountCents: 289,
      status: "categorized",
      categoryId,
      feeOrigin: "stripe_processing",
      merchantName: "Stripe processing fees",
    });
    const subscription = await seedTxn(s, {
      personId: alice,
      amountCents: 4200,
      status: "categorized",
      categoryId,
      merchantName: "Givebutter Plus",
    });
    return { alice, fee, subscription };
  }

  test("it is absent from the chase list and its count; the subscription beside it is present", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "FM", userId: s.userId });
    await grantRole(s, me, "manager");
    const { subscription } = await seedFeeAndSubscription(s);

    const chase = await s.as.query(api.finances.receiptChase, {});
    // One row, not two: the $42 subscription. The $2.89 fee is gone.
    expect(chase.count).toBe(1);
    expect(chase.totalCents).toBe(4200);
    expect(chase.groups.flatMap((g) => g.transactions.map((tr) => tr.id))).toEqual([
      subscription,
    ]);
  });

  test("it does not count in the reconcile grid's chaseCount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "FM", userId: s.userId });
    await grantRole(s, me, "manager");
    await seedFeeAndSubscription(s);

    // `chaseCount` is what gates the "Chase receipts" button, and it is
    // `receiptChase`'s population expression-for-expression — so it moves with
    // it or the button lies about the page it opens.
    const grid = await s.as.query(api.finances.listReconcile, {});
    expect(grid.chaseCount).toBe(1);
    // The documentation pill agreed all along (`needsDocumentation` always
    // exempted fees). Asserted here because the two disagreeing is the actual
    // defect: a row the pill said owed nothing that the chase still counted.
    expect(grid.counts.missing_receipt).toBe(1);
  });

  test("it generates no reminder — the subscription in the same category still does", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "FM", userId: s.userId });
    await grantRole(s, me, "manager");
    const { alice } = await seedFeeAndSubscription(s);

    // The one query behind every nudge email/SMS the FM sends from the Chase
    // page (`cards.sendReceiptNudge` is its only caller).
    const targets = await s.as.query(internal.cards.getManualNudgeTargets, {});
    expect(targets).toHaveLength(1);
    expect(targets[0].personId).toBe(alice);
    // ONE charge in the bundle, and it is not the fee: Alice is asked about
    // the subscription she chose to buy, and nothing about Stripe's cut.
    expect(targets[0].charges.map((c) => c.merchantName)).toEqual([
      "Givebutter Plus",
    ]);
    expect(targets[0].charges[0].outstanding).toBe("needs coding and a receipt");
  });
});
