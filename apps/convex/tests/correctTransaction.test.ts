/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { TransactionSource } from "@events-os/shared";

/**
 * `finances.correctTransaction` — fixing a manually-entered row's amount, date,
 * merchant or description.
 *
 * The invariants worth pinning are the two that make this safe to expose at
 * all: a row from a bank feed is NEVER correctable no matter who asks (it's a
 * data-integrity rule, not a permission), and every field change lands in
 * `financeAuditLog` with before → after, because these rows get published.
 */

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
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

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s, "Manager Mo");
  await grantRole(s, personId, "manager");
  return personId;
}

const MAR_1 = Date.parse("2025-03-01T12:00:00-05:00");
const APR_1 = Date.parse("2025-04-01T12:00:00-04:00");

async function seedTxn(
  s: ChapterSetup,
  opts: {
    source?: TransactionSource;
    amountCents?: number;
    externalId?: string;
    historicalImportBatch?: string;
  } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: opts.source ?? "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 44530,
      postedAt: MAR_1,
      merchantName: "Jing Li",
      description: "Food after event",
      status: "unreviewed",
      externalId: opts.externalId,
      historicalImportBatch: opts.historicalImportBatch,
      createdAt: Date.now(),
    }),
  );
}

async function trailFor(s: ChapterSetup, txnId: Id<"transactions">) {
  return await s.as.query(api.finances.financeAuditTrail, {
    subjectType: "transaction",
    subjectId: txnId,
  });
}

describe("what can be corrected", () => {
  test("a manual row's amount, date, merchant and description all change", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.correctTransaction, {
      transactionId: txnId,
      amountCents: 45530,
      postedAt: APR_1,
      merchantName: "Jing Li & Lagos",
      description: "Food after the Nov 2 event",
      reason: "Notion export had the wrong amount and date; invoice says $455.30",
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.amountCents).toBe(45530);
    expect(txn?.postedAt).toBe(APR_1);
    expect(txn?.merchantName).toBe("Jing Li & Lagos");
    expect(txn?.description).toBe("Food after the Nov 2 event");
  });

  // The whole safety story. A bank-feed row is a third party's claim about
  // money that moved; editing it means the ledger stops matching the statement.
  test.each([
    "increase_card",
    "increase_ach",
    "stripe_fc",
    "relay_csv",
  ] as const)("a %s row is refused — no role overrides it", async (source) => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { source });

    await expect(
      s.as.mutation(api.finances.correctTransaction, {
        transactionId: txnId,
        amountCents: 1,
        reason: "trying it on",
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_CORRECTABLE" } });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.amountCents).toBe(44530);
  });

  // Paired system legs: editing one in isolation desyncs it from its partner.
  test.each(["reimbursement", "repayment", "transfer"] as const)(
    "a %s leg is refused too",
    async (source) => {
      const t = newT();
      const s = await setupChapter(t);
      await asManager(s);
      const txnId = await seedTxn(s, { source });

      await expect(
        s.as.mutation(api.finances.correctTransaction, {
          transactionId: txnId,
          amountCents: 1,
          reason: "trying it on",
        }),
      ).rejects.toMatchObject({ data: { code: "NOT_CORRECTABLE" } });
    },
  );

  test("a bookkeeper (below manager) can't correct", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.finances.correctTransaction, {
        transactionId: txnId,
        amountCents: 100,
        reason: "nope",
      }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });

  test("a reason is required", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.finances.correctTransaction, {
        transactionId: txnId,
        amountCents: 100,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ data: { code: "REASON_REQUIRED" } });
  });

  test("a negative amount is refused — direction rides on flow, not a sign", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.finances.correctTransaction, {
        transactionId: txnId,
        amountCents: -500,
        reason: "it's an outflow so it should be negative, right?",
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_AMOUNT" } });
  });
});

describe("the audit trail — a correction is not a quiet edit", () => {
  test("one row per changed field, with before → after and the reason", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.correctTransaction, {
      transactionId: txnId,
      amountCents: 45530,
      postedAt: APR_1,
      reason: "Invoice says $455.30 on Apr 1",
    });

    const corrections = (await trailFor(s, txnId)).filter(
      (r) => r.action === "correction",
    );
    expect(corrections.map((r) => r.field).sort()).toEqual(["amount", "date"]);

    const amountRow = corrections.find((r) => r.field === "amount")!;
    // Human labels, never raw cents or timestamps — the trail is read by
    // people, and "44530 → 45530" is not an explanation.
    expect(amountRow.before).toBe("$445.30");
    expect(amountRow.after).toBe("$455.30");
    expect(amountRow.reason).toBe("Invoice says $455.30 on Apr 1");
    expect(amountRow.actorName).toBe("Manager Mo");

    const dateRow = corrections.find((r) => r.field === "date")!;
    expect(dateRow.before).toContain("Mar");
    expect(dateRow.after).toContain("Apr");
  });

  test("a no-op correction writes nothing at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.correctTransaction, {
      transactionId: txnId,
      amountCents: 44530, // unchanged
      merchantName: "Jing Li", // unchanged
      reason: "re-saving the same values",
    });

    expect(
      (await trailFor(s, txnId)).filter((r) => r.action === "correction"),
    ).toHaveLength(0);
  });
});

describe("correcting the amount invalidates an approved exception", () => {
  // THE BYPASS THIS CLOSES: an exception snapshots the amount it was filed
  // against, and separation of duties is evaluated against that snapshot. So a
  // manager could file a $5 exception, self-approve it legitimately (under the
  // threshold, where SOD doesn't apply), then correct the row to $5,000 —
  // leaving a large charge documented by a self-approved attestation that
  // should have needed a second person.
  test("the approved exception is retired and the row owes documentation again", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 500 });

    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: "Cash tip at the venue, no receipt is ever issued",
    });
    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txnId)))?.approvedReceiptExceptionId,
    ).toBeTruthy();

    await s.as.mutation(api.finances.correctTransaction, {
      transactionId: txnId,
      amountCents: 500_000,
      reason: "Wrong by three orders of magnitude in the import",
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.amountCents).toBe(500_000);
    // The attestation no longer describes this row, so it stops documenting it.
    expect(txn?.approvedReceiptExceptionId).toBeUndefined();
    expect((await run(s.t, (ctx) => ctx.db.get(exceptionId)))?.status).toBe(
      "withdrawn",
    );
    // And it's back in both worklists until someone re-files at the true
    // amount — which will now cross the threshold and need a second approver.
    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.missing_receipt).toBe(1);
    // NOT `undocumented`. That facet is now the CLOSED tail only ("Closed
    // without documentation") — the row here is still `unreviewed`, so it is
    // squarely the chase worklist's problem and appears there exactly once,
    // rather than in both lists at once as it used to. The two facets are
    // disjoint now; `isUndocumented` the predicate is unchanged.
    expect(counts.undocumented).toBe(0);
  });

  test("a correction that leaves the amount alone keeps the exception", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 500 });

    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: "Cash tip at the venue, no receipt is ever issued",
    });
    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });

    await s.as.mutation(api.finances.correctTransaction, {
      transactionId: txnId,
      merchantName: "The Sound Engineer",
      reason: "Merchant was blank in the import",
    });

    expect(
      (await run(s.t, (ctx) => ctx.db.get(txnId)))?.approvedReceiptExceptionId,
    ).toBe(exceptionId);
  });
});

describe("reconstructed-history labelling", () => {
  test("a genesis row is labelled by its externalId prefix — no migration needed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await seedTxn(s, { externalId: "genesis-inkind-exp:drum-set" });

    const [row] = (await s.as.query(api.finances.listReconcile, { filter: "all" })).rows;
    expect(row.isReconstructed).toBe(true);
    expect(row.correctable).toBe(true);
  });

  test("an explicit batch marker labels it too", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await seedTxn(s, { historicalImportBatch: "genesis" });

    const [row] = (await s.as.query(api.finances.listReconcile, { filter: "all" })).rows;
    expect(row.isReconstructed).toBe(true);
  });

  test("an ordinary hand-entered row is correctable but NOT reconstructed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await seedTxn(s);

    const [row] = (await s.as.query(api.finances.listReconcile, { filter: "all" })).rows;
    expect(row.correctable).toBe(true);
    expect(row.isReconstructed).toBe(false);
  });

  test("a synced row is neither — the grid never offers the affordance", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await seedTxn(s, { source: "relay_csv", externalId: "genesis-bank:12" });

    const [row] = (await s.as.query(api.finances.listReconcile, { filter: "all" })).rows;
    // Reconstructed, yes — it came from a CSV. Correctable, no: it's the bank's
    // own record of what moved, and the ledger has to keep matching it.
    expect(row.isReconstructed).toBe(true);
    expect(row.correctable).toBe(false);
  });
});
