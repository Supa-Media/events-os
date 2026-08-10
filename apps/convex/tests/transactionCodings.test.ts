/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { DEFAULT_CODING_REQUIRED_SINCE_MS, DAY_MS } from "@events-os/shared";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Transaction codings (`docs/plans/transaction-coding.md`, phase 1): the
 * structured what/why/who substantiation record, its review loop, the
 * `transactions.codingState` denorm, the `CODING_REQUIRED` reconcile gate,
 * and the `uncoded`/`coding_review` Reconcile facets.
 *
 * Field validation (purpose floor, travel route, meal names ≤15 /
 * headcount+group >15) is pure and lives in
 * `packages/shared/src/transactionCoding.test.ts`; this suite covers the
 * server round-trips: that the shared problems are actually thrown, that the
 * denorm tracks status exactly, that separation of duties holds with no
 * dollar threshold, and that the gate bites only at/after the policy date.
 */

const PRE_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS - 30 * DAY_MS;
const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;

const GOOD_PURPOSE = "Travel to NY to film the Eden event with the team";

async function seedSelfPerson(s: ChapterSetup, name = "Manager Mo"): Promise<Id<"people">> {
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

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/**
 * A charge to code. RECEIPTED BY DEFAULT, because since the receipt-at-coding
 * change a coding can't be submitted on a charge that can't prove itself
 * (`submitCoding`'s `DOCUMENTATION_REQUIRED` gate) — an undocumented fixture
 * would make every unrelated test in this file a test of that one rule. Pass
 * `documented: false` to exercise the gate itself.
 */
async function seedTxn(
  s: ChapterSetup,
  opts: {
    postedAt?: number;
    receiptStorageId?: Id<"_storage">;
    documented?: boolean;
  } = {},
): Promise<Id<"transactions">> {
  const receiptStorageId =
    opts.receiptStorageId ??
    (opts.documented === false ? undefined : await storeBlob(s.t));
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 5800,
      postedAt: opts.postedAt ?? POST_POLICY,
      merchantName: "Peter Pan Bus Lines",
      status: "unreviewed",
      receiptStorageId,
      createdAt: Date.now(),
    }),
  );
}

describe("a coding carries its own documentation", () => {
  // Owner decision (2026-08-08): "they should just upload the receipt when
  // coding." What the money was for and how it can be proved are one record,
  // so submitting the first without the second is refused.
  test("refuses a coding on a charge that can't prove itself", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { documented: false });

    await expect(
      s.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "general",
        businessPurpose: GOOD_PURPOSE,
      }),
    ).rejects.toMatchObject({ data: { code: "DOCUMENTATION_REQUIRED" } });
  });

  test("a receipt satisfies it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s); // receipted by default
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.codingState).toBe(
      "submitted",
    );
  });

  test("a PENDING exception satisfies it — the author's part is done", async () => {
    // Deliberate: the gate asks whether the AUTHOR finished their half.
    // Waiting on someone else's approval would strand the charge in their
    // queue for something they can't do. `reconciled` still demands an
    // APPROVED exception, so nothing publishes on an unapproved claim.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { documented: false });
    await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: "Cash tip to the sound engineer at the Aug 2 outdoor service.",
    });

    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.codingState).toBe(
      "submitted",
    );
  });

  test("a VOLUNTARY coding is never blocked by it", async () => {
    // The gate is scoped to rows that owe a coding (post-policy outflow
    // spend). Unscoped it punished the only people doing more than they had
    // to: coding a pre-policy charge, an inflow, or an excluded duplicate
    // would have been refused for want of documentation those rows never
    // owed — and the only way through would have been filing a bogus receipt
    // exception for a manager to adjudicate.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const prePolicy = await seedTxn(s, {
      postedAt: PRE_POLICY,
      documented: false,
    });

    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: prePolicy,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    expect((await run(s.t, (ctx) => ctx.db.get(prePolicy)))?.codingState).toBe(
      "submitted",
    );
  });

  test("getForTransaction reports it, so the form can say so before you type", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const bare = await seedTxn(s, { documented: false });
    const receipted = await seedTxn(s);

    expect(
      (
        await s.as.query(api.transactionCodings.getForTransaction, {
          transactionId: bare,
        })
      ).hasDocumentation,
    ).toBe(false);
    expect(
      (
        await s.as.query(api.transactionCodings.getForTransaction, {
          transactionId: receipted,
        })
      ).hasDocumentation,
    ).toBe(true);
  });
});

describe("submitting", () => {
  test("a submitted coding lands on the row and the denorm tracks it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    const codingId = await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "travel",
      businessPurpose: GOOD_PURPOSE,
      travelFrom: "Boston",
      travelTo: "New York",
    });

    const row = await run(s.t, (ctx) => ctx.db.get(codingId));
    expect(row?.status).toBe("submitted");
    expect(row?.travelFrom).toBe("Boston");
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.codingState).toBe("submitted");
  });

  test("the shared field problems are thrown server-side, first one wins", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "general",
        businessPurpose: "bus to NY",
      }),
    ).rejects.toMatchObject({ data: { code: "PURPOSE_REQUIRED" } });

    await expect(
      s.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "travel",
        businessPurpose: GOOD_PURPOSE,
      }),
    ).rejects.toMatchObject({ data: { code: "TRAVEL_ROUTE_REQUIRED" } });

    // 4 people means 4 names (names required at/below the 15 threshold)…
    await expect(
      s.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "meal",
        businessPurpose: "Meal for volunteers writing and producing the album",
        headcount: 4,
      }),
    ).rejects.toMatchObject({ data: { code: "ATTENDEES_REQUIRED" } });

    // …and above it, an identifiable group instead.
    await expect(
      s.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "meal",
        businessPurpose: "Meal for volunteers writing and producing the album",
        headcount: 16,
      }),
    ).rejects.toMatchObject({ data: { code: "GROUP_DESCRIPTION_REQUIRED" } });
  });
});

// The UI used to gate Approve / Send back on a bookkeeper-or-better flag while
// the server required MANAGER plus separation of duties, so two kinds of caller
// were shown a working button that threw FORBIDDEN on every press. These pin
// the flag the client now reads, against the same conditions the mutation
// enforces — if `canReview` and `approve` ever disagree, that button comes back.
describe("canReview — the client is told what the server would allow", () => {
  test("false for the AUTHOR, even when they're a manager (SoD)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txnId,
    });
    expect(data.canReview).toBe(false);
    // …and the mutation agrees, which is the whole contract.
    await expect(
      s.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toMatchObject({ data: { code: "SOD_VIOLATION" } });
  });

  test("true for a manager who did NOT write it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const other = await seedOtherPerson(s, "Cardholder Cass");
    const txnId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    // Re-author to someone else so the manager is a genuine second name.
    await run(s.t, async (ctx) => {
      const row = await ctx.db
        .query("transactionCodings")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .first();
      await ctx.db.patch(row!._id, { codedByPersonId: other });
    });

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txnId,
    });
    expect(data.canReview).toBe(true);
  });

  test("false for a BOOKKEEPER — reviewing is a manager power", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedSelfPerson(s, "Book Keeper");
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: me,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const other = await seedOtherPerson(s, "Cardholder Cass");
    const txnId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    await run(s.t, async (ctx) => {
      const row = await ctx.db
        .query("transactionCodings")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .first();
      await ctx.db.patch(row!._id, { codedByPersonId: other });
    });

    // A bookkeeper may read and author here — that's why they get a payload at
    // all — but deciding is a rank above them.
    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txnId,
    });
    expect(data.coding).not.toBeNull();
    expect(data.canReview).toBe(false);
    await expect(
      s.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });

  test("false when there is no coding to decide on", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txnId,
    });
    expect(data.coding).toBeNull();
    expect(data.canReview).toBe(false);
  });
});

describe("review loop", () => {
  test("separation of duties: the author can never approve their own coding", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });

    await expect(
      s.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toMatchObject({ data: { code: "SOD_VIOLATION" } });
  });

  test("approve (by a different person) → denorm approved; send back → changes_requested with the note; resubmit clears it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const other = await seedOtherPerson(s, "Cardholder Cass");
    const txnId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    // Re-author the row to someone else so the manager is a second name —
    // the same direct-patch isolation trick `financesApi.test.ts` uses for
    // budget approval (tests the DECISION, not the authoring identity).
    const coding = await run(s.t, async (ctx) =>
      (await ctx.db.query("transactionCodings").collect())[0],
    );
    await run(s.t, (ctx) =>
      ctx.db.patch(coding._id, { codedByPersonId: other }),
    );

    await s.as.mutation(api.transactionCodings.approve, { transactionId: txnId });
    let txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.codingState).toBe("approved");

    // Reopen with a note (works on an approved row — the audited amendment path).
    await s.as.mutation(api.transactionCodings.requestChanges, {
      transactionId: txnId,
      reviewNote: "Receipt must show exact amount",
    });
    const reopened = await run(s.t, (ctx) => ctx.db.get(coding._id));
    expect(reopened?.status).toBe("changes_requested");
    expect(reopened?.reviewNote).toBe("Receipt must show exact amount");
    txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.codingState).toBe("changes_requested");

    // Resubmission answers the send-back: same row, note cleared, back in review.
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE + " — receipt reattached with exact amount",
    });
    const resubmitted = await run(s.t, (ctx) => ctx.db.get(coding._id));
    expect(resubmitted?.status).toBe("submitted");
    expect(resubmitted?.reviewNote).toBeUndefined();
  });

  test("sending back without a note is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    await expect(
      s.as.mutation(api.transactionCodings.requestChanges, {
        transactionId: txnId,
        reviewNote: "   ",
      }),
    ).rejects.toMatchObject({ data: { code: "REASON_REQUIRED" } });
  });
});

describe("the CODING_REQUIRED gate and the Reconcile facets", () => {
  test("post-policy spend can't reconcile uncoded; approved coding unlocks it; pre-policy spend never owed one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const other = await seedOtherPerson(s, "Cardholder Cass");
    const receiptId = await storeBlob(s.t);

    // Receipted either way, so the only thing between these rows and
    // `reconciled` is the coding gate itself.
    const gated = await seedTxn(s, { postedAt: POST_POLICY, receiptStorageId: receiptId });
    const legacy = await seedTxn(s, { postedAt: PRE_POLICY, receiptStorageId: receiptId });

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: gated,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "CODING_REQUIRED" } });

    // Pre-policy history is grandfathered — no coding owed.
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: legacy,
      status: "reconciled",
    });

    // Facets: the post-policy row is the author's backlog…
    let counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.uncoded).toBe(1);
    expect(counts.coding_review).toBe(0);

    // …until submitted, when it becomes the reviewer's…
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: gated,
      expenseType: "travel",
      businessPurpose: GOOD_PURPOSE,
      travelFrom: "Boston",
      travelTo: "New York",
    });
    counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.uncoded).toBe(0);
    expect(counts.coding_review).toBe(1);

    // …and once approved (by a second name), the gate opens.
    const coding = await run(s.t, async (ctx) =>
      (await ctx.db.query("transactionCodings").collect()).find(
        (c) => c.transactionId === gated,
      )!,
    );
    await run(s.t, (ctx) => ctx.db.patch(coding._id, { codedByPersonId: other }));
    await s.as.mutation(api.transactionCodings.approve, { transactionId: gated });
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: gated,
      status: "reconciled",
    });
    const txn = await run(s.t, (ctx) => ctx.db.get(gated));
    expect(txn?.status).toBe("reconciled");
    counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.uncoded).toBe(0);
    expect(counts.coding_review).toBe(0);
  });

  test("a send-back puts the row straight back in the author's backlog", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s, { postedAt: POST_POLICY });
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    await s.as.mutation(api.transactionCodings.requestChanges, {
      transactionId: txnId,
      reviewNote: "Say which event this served",
    });
    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.uncoded).toBe(1);
    expect(counts.coding_review).toBe(0);
  });
});
