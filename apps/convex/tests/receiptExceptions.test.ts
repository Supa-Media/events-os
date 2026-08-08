/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { disarmCodingPolicy, newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MAX_EXCEPTION_EVIDENCE } from "@events-os/shared";

/**
 * Receipt exceptions — the documentation of record when no receipt can be
 * produced. See `docs/plans/receipt-exceptions.md`.
 *
 * The invariants worth pinning are the ones that make the feature honest
 * rather than a loophole:
 *  - the denormalized `transactions.approvedReceiptExceptionId` pointer is set
 *    IFF an approved exception exists (the single-writer contract every pure
 *    predicate depends on);
 *  - separation of duties at/above the threshold, waived below it;
 *  - an approved exception closes the chase AND stops the auto-convert clock,
 *    but a PENDING one does neither;
 *  - `reconciled` is refused on an undocumented row;
 *  - `undocumented` counts a reconciled-but-bare row that `missing_receipt`
 *    deliberately stops chasing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

async function seedOtherPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
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
  opts: { amountCents?: number; ageDays?: number; status?: "unreviewed" | "categorized" } = {},
): Promise<Id<"transactions">> {
  const now = Date.now();
  // This suite reconciles `Date.now()`-posted rows and is not about coding —
  // keep it independent of the 2026-09-01 policy date.
  await disarmCodingPolicy(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 4200,
      postedAt: now - (opts.ageDays ?? 0) * DAY_MS,
      merchantName: "Street parking",
      status: opts.status ?? "unreviewed",
      createdAt: now,
    }),
  );
}

/** A manager who can both file and decide. Most tests need exactly this. */
async function asManager(s: ChapterSetup, name = "Manager Mo"): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s, name);
  await grantRole(s, personId, "manager");
  return personId;
}

const GOOD_NOTE = "Cash tip for the sound engineer at the Aug 2 outdoor service";

describe("attesting", () => {
  test("a filed exception starts pending and does NOT set the transaction pointer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: GOOD_NOTE,
    });

    const row = await run(s.t, (ctx) => ctx.db.get(exceptionId));
    expect(row?.status).toBe("pending");
    expect(row?.amountCents).toBe(4200);
    // Asking to be let off is not being let off.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.approvedReceiptExceptionId).toBeUndefined();
  });

  test("a blank or too-short note is refused — the note IS the substitute document", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "lost",
        note: "   n/a  ",
      }),
    ).rejects.toMatchObject({ data: { code: "NOTE_REQUIRED" } });
  });

  test("a transaction that already has a receipt can't be excepted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    const storageId = await storeBlob(s.t);
    await run(s.t, (ctx) => ctx.db.patch(txnId, { receiptStorageId: storageId }));

    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "lost",
        note: GOOD_NOTE,
      }),
    ).rejects.toMatchObject({ data: { code: "HAS_RECEIPT" } });
  });

  test("only ONE pending exception at a time — a second is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });

    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "vendor_unreachable",
        note: "A different story about the same charge entirely",
      }),
    ).rejects.toMatchObject({ data: { code: "ALREADY_PENDING" } });
  });

  test("a caller with no finance role and no claim on the row can't file", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s); // no finance grant at all
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "lost",
        note: GOOD_NOTE,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("evidence — proof of the purchase", () => {
  // Owner framing: "we bought flowers for an event, we didn't get the receipt
  // but have pictures of the flowers at the event." Several photos, not one.
  test("a filed exception carries its evidence files, and the read path resolves urls", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 400 });
    const photos = [await storeBlob(s.t), await storeBlob(s.t), await storeBlob(s.t)];

    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: "Flowers for the Aug 2 outdoor service — photos are from the event",
      evidenceStorageIds: photos,
    });

    expect((await run(s.t, (ctx) => ctx.db.get(exceptionId)))?.evidenceStorageIds).toEqual(
      photos,
    );
    const [row] = await s.as.query(api.receiptExceptions.listForTransaction, {
      transactionId: txnId,
    });
    expect(row.evidenceUrls).toHaveLength(3);
  });

  test("evidence is NEVER counted as a receipt — the row still owes documentation", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 400 });
    await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: "Flowers for the Aug 2 outdoor service — photos are from the event",
      evidenceStorageIds: [await storeBlob(s.t)],
    });

    // Photos prove the flowers existed; they don't prove what was paid, and
    // they must never touch the documentation denorm cache.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.receiptStorageId).toBeUndefined();
    // Still pending, so still chased and still undocumented.
    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.missing_receipt).toBe(1);
    expect(counts.undocumented).toBe(1);
    // And nothing was written to the shared receipts library.
    expect((await run(s.t, (ctx) => ctx.db.query("receipts").collect())).length).toBe(0);
  });

  test("evidence is capped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 400 });
    const tooMany = [];
    for (let i = 0; i < MAX_EXCEPTION_EVIDENCE + 1; i++) {
      tooMany.push(await storeBlob(s.t));
    }

    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "lost",
        note: "Flowers for the Aug 2 outdoor service — photos are from the event",
        evidenceStorageIds: tooMany,
      }),
    ).rejects.toMatchObject({ data: { code: "TOO_MUCH_EVIDENCE" } });
  });
});

describe("deciding — separation of duties", () => {
  test("approving sets the pointer, and a receipt is no longer owed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    // Under the $75 default threshold, so the filer may approve their own.
    const txnId = await seedTxn(s, { amountCents: 400 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: GOOD_NOTE,
    });

    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.approvedReceiptExceptionId).toBe(exceptionId);
    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.missing_receipt).toBe(0);
    expect(counts.undocumented).toBe(0);
  });

  test("at or above the threshold the filer CANNOT approve their own attestation", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    // $80 — over the $75 default.
    const txnId = await seedTxn(s, { amountCents: 8000 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });

    await expect(
      s.as.mutation(api.receiptExceptions.approve, { exceptionId }),
    ).rejects.toMatchObject({ data: { code: "SOD_VIOLATION" } });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.approvedReceiptExceptionId).toBeUndefined();
  });

  test("a DIFFERENT approver clears the same over-threshold exception", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const filer = await seedOtherPerson(s, "Filer Fi");
    await grantRole(s, filer, "bookkeeper");
    await asManager(s, "Approver Ada");
    const txnId = await seedTxn(s, { amountCents: 8000 });

    // File it AS the other person by writing the row's attestation directly —
    // the caller here is the approver, and what's under test is the approval
    // rule, not the filing path (covered above).
    const exceptionId = await run(s.t, (ctx) =>
      ctx.db.insert("receiptExceptions", {
        transactionId: txnId,
        chapterId: s.chapterId,
        amountCents: 8000,
        reason: "lost",
        note: GOOD_NOTE,
        status: "pending",
        attestedByPersonId: filer,
        attestedByUserId: s.userId,
        attestedAt: Date.now(),
      }),
    );

    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.approvedReceiptExceptionId).toBe(exceptionId);
  });

  test("the threshold is configurable — raising it waives the second approver", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        receiptExceptionApprovalThresholdCents: 50_000,
        updatedAt: Date.now(),
      }),
    );
    const txnId = await seedTxn(s, { amountCents: 8000 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });

    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.approvedReceiptExceptionId).toBe(exceptionId);
  });

  test("rejecting requires a reason, and leaves the row still owing a receipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 400 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });

    await expect(
      s.as.mutation(api.receiptExceptions.reject, { exceptionId, decisionNote: "  " }),
    ).rejects.toMatchObject({ data: { code: "REASON_REQUIRED" } });

    await s.as.mutation(api.receiptExceptions.reject, {
      exceptionId,
      decisionNote: "Square emails these — check your inbox for Aug 2",
    });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.approvedReceiptExceptionId).toBeUndefined();
    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.missing_receipt).toBe(1);
  });

  test("a decided exception can't be re-decided", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 400 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });
    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });

    await expect(
      s.as.mutation(api.receiptExceptions.reject, {
        exceptionId,
        decisionNote: "changed my mind",
      }),
    ).rejects.toMatchObject({ data: { code: "ALREADY_DECIDED" } });
  });

  test("a bookkeeper (below manager) cannot decide", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s, { amountCents: 400 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });

    await expect(
      s.as.mutation(api.receiptExceptions.approve, { exceptionId }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});

describe("withdrawal + supersession — the pointer never goes stale", () => {
  test("withdrawing an approved exception clears the pointer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 400 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });
    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });

    await s.as.mutation(api.receiptExceptions.withdraw, { exceptionId });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.approvedReceiptExceptionId).toBeUndefined();
    expect((await run(s.t, (ctx) => ctx.db.get(exceptionId)))?.status).toBe("withdrawn");
  });

  test("attaching a receipt supersedes an approved exception — a document outranks an attestation", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 400 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });
    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });

    const storageId = await storeBlob(s.t);
    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.receiptStorageId).toBeDefined();
    expect(txn?.approvedReceiptExceptionId).toBeUndefined();
    expect((await run(s.t, (ctx) => ctx.db.get(exceptionId)))?.status).toBe("withdrawn");
  });
});

describe("reconciled means documented", () => {
  test("reconciling an undocumented row is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "RECEIPT_REQUIRED" } });
  });

  test("an approved exception unblocks reconciling", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { amountCents: 400 });
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: GOOD_NOTE,
    });
    await s.as.mutation(api.receiptExceptions.approve, { exceptionId });

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.status).toBe("reconciled");
  });

  test("a PENDING exception does not unblock reconciling", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
    });

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "RECEIPT_REQUIRED" } });
  });

  test("excluding is still allowed on an undocumented row (with its reason)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "excluded",
      reason: "Duplicate of the Aug 2 charge",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.status).toBe("excluded");
  });
});

describe("the undocumented pill — the publishing backlog", () => {
  test("a legacy reconciled-but-bare row is invisible to the chase and visible here", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    // A row from before the guard existed: reconciled with nothing attached.
    // Written directly, because the mutation now refuses exactly this.
    const legacy = await seedTxn(s);
    await run(s.t, (ctx) => ctx.db.patch(legacy, { status: "reconciled" }));

    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    // The chase stops on a reconciled row — a treasurer made a call.
    expect(counts.missing_receipt).toBe(0);
    // But a published ledger can't tell that row from a documented one.
    expect(counts.undocumented).toBe(1);

    const rows = await s.as.query(api.finances.listReconcile, { filter: "undocumented" });
    expect(rows.rows.map((r) => r.id)).toEqual([legacy]);
  });

  test("an excluded row is never counted as an undocumented gap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "excluded",
      reason: "Duplicate",
    });

    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.undocumented).toBe(0);
  });
});

describe("bulk backfill", () => {
  test("files one exception PER ROW and skips the ones that can't take it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const a = await seedTxn(s, { amountCents: 400 });
    const b = await seedTxn(s, { amountCents: 900 });
    // Already receipted → skipped, not failed.
    const c = await seedTxn(s, { amountCents: 1200 });
    const storageId = await storeBlob(s.t);
    await run(s.t, (ctx) => ctx.db.patch(c, { receiptStorageId: storageId }));

    const result = await s.as.mutation(api.receiptExceptions.attestBulk, {
      transactionIds: [a, b, c],
      reason: "predates_policy",
      note: "Pre-2025 history — reconstructed from the Relay statement export",
    });
    // Both under the $75 threshold and the caller is a manager, so they're
    // acknowledged outright rather than parked in an approval queue.
    expect(result).toEqual({
      filed: 2,
      approved: 2,
      pendingApproval: 0,
      skipped: 1,
    });

    // Per-row, not blanket: each filed row carries its OWN amount.
    const rows = await run(s.t, (ctx) => ctx.db.query("receiptExceptions").collect());
    expect(rows.map((r) => r.amountCents).sort((x, y) => x - y)).toEqual([400, 900]);
  });

  test("under the threshold a manager's bulk acknowledge lands APPROVED, not queued", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const a = await seedTxn(s, { amountCents: 290 });
    const b = await seedTxn(s, { amountCents: 290 });

    const res = await s.as.mutation(api.receiptExceptions.attestBulk, {
      transactionIds: [a, b],
      reason: "no_receipt_issued",
      note: "Subway fares between outreach sites — OMNY taps, no receipt issued",
    });
    expect(res.approved).toBe(2);
    expect(res.pendingApproval).toBe(0);

    // Approved means DOCUMENTED: the pointer is set and the rows leave both
    // the chase and the publishing backlog. This is the whole point of the
    // flow — acknowledging has to actually clear the queue, or people go back
    // to marking things Reconciled bare.
    for (const id of [a, b]) {
      expect(
        (await run(s.t, (ctx) => ctx.db.get(id)))?.approvedReceiptExceptionId,
      ).toBeTruthy();
    }
    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.missing_receipt).toBe(0);
    expect(counts.undocumented).toBe(0);
  });

  test("at or above the threshold bulk still parks rows for a second approver", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const big = await seedTxn(s, { amountCents: 9000 });
    const small = await seedTxn(s, { amountCents: 500 });

    const res = await s.as.mutation(api.receiptExceptions.attestBulk, {
      transactionIds: [big, small],
      reason: "lost",
      note: "Receipts lost in the move — reconstructed from the statement",
    });
    expect(res.filed).toBe(2);
    // The $90 one can't be self-approved; the $5 one can.
    expect(res.approved).toBe(1);
    expect(res.pendingApproval).toBe(1);
    expect(
      (await run(s.t, (ctx) => ctx.db.get(big)))?.approvedReceiptExceptionId,
    ).toBeUndefined();
    expect(
      (await run(s.t, (ctx) => ctx.db.get(small)))?.approvedReceiptExceptionId,
    ).toBeTruthy();
  });

  test("a bookkeeper's bulk acknowledge files but never self-approves", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const a = await seedTxn(s, { amountCents: 290 });

    const res = await s.as.mutation(api.receiptExceptions.attestBulk, {
      transactionIds: [a],
      reason: "no_receipt_issued",
      note: "Subway fare between outreach sites — no receipt issued",
    });
    expect(res.filed).toBe(1);
    expect(res.approved).toBe(0);
    expect(res.pendingApproval).toBe(1);
  });

  test("a bad note fails the whole batch rather than reporting every row skipped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const a = await seedTxn(s);

    await expect(
      s.as.mutation(api.receiptExceptions.attestBulk, {
        transactionIds: [a],
        reason: "predates_policy",
        note: "n/a",
      }),
    ).rejects.toMatchObject({ data: { code: "NOTE_REQUIRED" } });
  });
});
