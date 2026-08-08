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

async function seedTxn(
  s: ChapterSetup,
  opts: { postedAt?: number; receiptStorageId?: Id<"_storage"> } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 5800,
      postedAt: opts.postedAt ?? POST_POLICY,
      merchantName: "Peter Pan Bus Lines",
      status: "unreviewed",
      receiptStorageId: opts.receiptStorageId,
      createdAt: Date.now(),
    }),
  );
}

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
