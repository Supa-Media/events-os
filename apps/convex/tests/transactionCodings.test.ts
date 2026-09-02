/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { CENTRAL, DEFAULT_CODING_REQUIRED_SINCE_MS, DAY_MS } from "@events-os/shared";
import {
  newT,
  run,
  seedApprovedBudget,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
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
 * Point a coding's authorship at SOMEBODY ELSE, so the caller can decide on
 * it. Both decisions — approve and send-back — enforce separation of duties,
 * so any fixture where one identity authors and then decides is testing SoD
 * rather than whatever it meant to test. (The alternative, standing up a
 * second authenticated member per test, buys nothing here: these tests are
 * about the decision's effect, not about who made it.)
 */
async function reattributeAuthor(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
): Promise<void> {
  const other = await seedOtherPerson(s, "Someone Else");
  const coding = await run(s.t, async (ctx) =>
    (await ctx.db.query("transactionCodings").collect()).find(
      (c) => c.transactionId === transactionId,
    )!,
  );
  await run(s.t, (ctx) =>
    ctx.db.patch(coding._id, { codedByPersonId: other }),
  );
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
    /** Pass `false` for a row deliberately left unattributed — the state
     *  `approve`'s budget gate exists for, and the state the "carries the
     *  budget Reconcile already set" test needs a control for. */
    budgeted?: boolean;
  } = {},
): Promise<Id<"transactions">> {
  const receiptStorageId =
    opts.receiptStorageId ??
    (opts.documented === false ? undefined : await storeBlob(s.t));
  // BUDGETED by default: `transactionCodings.approve` refuses spend that owes
  // a budget and hasn't got one (`finances.needsBudget`, founder 2026-09-02).
  // That gate has its own suite (`codingReviseUnderReview.test.ts`); here it is a
  // precondition of reaching what these tests are about, exactly like the
  // receipt above.
  const budgetId =
    opts.budgeted === false
      ? undefined
      : await seedApprovedBudget(s.t, s.chapterId);
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
      budgetId,
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

  test("getForTransaction surfaces the charge's OWN category + its hint, so Reconcile's editor can follow it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const fundId = await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const categoryId = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId,
        name: "Transportation",
        kind: "category",
        sortOrder: 0,
        expenseType: "travel",
        createdAt: Date.now(),
      }),
    );
    const categorized = await seedTxn(s);
    await run(s.t, (ctx) => ctx.db.patch(categorized, { categoryId }));
    const uncategorized = await seedTxn(s);

    const withCategory = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: categorized,
    });
    expect(withCategory.categoryName).toBe("Transportation");
    expect(withCategory.categoryExpenseTypeHint).toBe("travel");

    const without = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: uncategorized,
    });
    expect(without.categoryName).toBeNull();
    expect(without.categoryExpenseTypeHint).toBeUndefined();
  });

  test("getForTransaction carries the budget Reconcile already set, so the form's picker doesn't re-ask", async () => {
    // Founder report, 2026-08-12: "I already put most transactions into
    // budgets in reconcile but it still asks me" — `transactions.budgetId`
    // is the one column both Reconcile's "For" picker and the coding form's
    // budget picker write, but the form never read it back.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100_000,
        label: "Operating",
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        approvalStatus: "approved",
        approvedCents: 100_000,
        createdAt: Date.now(),
      }),
    );
    const attributed = await seedTxn(s);
    await run(s.t, (ctx) => ctx.db.patch(attributed, { budgetId }));
    const unattributed = await seedTxn(s, { budgeted: false });

    expect(
      (
        await s.as.query(api.transactionCodings.getForTransaction, {
          transactionId: attributed,
        })
      ).currentBudgetId,
    ).toBe(budgetId);
    expect(
      (
        await s.as.query(api.transactionCodings.getForTransaction, {
          transactionId: unattributed,
        })
      ).currentBudgetId,
    ).toBeNull();
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
    // Reattribute authorship before deciding — send-back is a DECISION and
    // now carries the same separation-of-duties rule as approve, so a
    // fixture where one identity does both would fail on SoD instead of on
    // the empty note this test is actually about.
    await reattributeAuthor(s, txnId);
    await expect(
      s.as.mutation(api.transactionCodings.requestChanges, {
        transactionId: txnId,
        reviewNote: "   ",
      }),
    ).rejects.toMatchObject({ data: { code: "REASON_REQUIRED" } });
  });

  /**
   * REOPENING AN APPROVED CODING — the any-time, any-reviewer path.
   *
   * `requestChanges` is the audited amendment route: it works on an APPROVED
   * coding by design, and it is what a reviewer reaches for when something
   * turns out to be wrong after the fact. It lands in `changes_requested`
   * (meaning the AUTHOR must act) and it emails them — both right here, and
   * both exactly why it is NOT what the panel's Undo toast calls. That is
   * `transactionCodings.undoApproval`, covered in
   * `codingUndoApproval.test.ts`.
   *
   * What this pins is that the reopen is REAL: the denorm follows and the
   * coding becomes editable again. An approved coding is immutable, so any
   * reopen has to be a state change rather than a cosmetic one.
   */
  test("requestChanges reopens an approved coding for real", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    await reattributeAuthor(s, txnId);
    await s.as.mutation(api.transactionCodings.approve, { transactionId: txnId });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.codingState).toBe(
      "approved",
    );
    // While it stands approved it is IMMUTABLE — the state undo exists to
    // escape.
    await expect(
      s.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "general",
        businessPurpose: GOOD_PURPOSE + " — corrected",
      }),
    ).rejects.toMatchObject({ data: { code: "CODING_APPROVED" } });

    // THE REOPEN, with the note the author will be sent.
    await s.as.mutation(api.transactionCodings.requestChanges, {
      transactionId: txnId,
      reviewNote: "The receipt has to show the exact amount — please reattach.",
    });

    const coding = await run(s.t, async (ctx) =>
      (await ctx.db.query("transactionCodings").collect())[0],
    );
    expect(coding.status).toBe("changes_requested");
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.codingState).toBe(
      "changes_requested",
    );
    // …and it really is editable again.
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE + " — corrected after the undo",
    });
    const reopened = await run(s.t, (ctx) => ctx.db.get(coding._id));
    expect(reopened?.status).toBe("submitted");
    expect(reopened?.businessPurpose).toContain("corrected after the undo");

    // The whole round trip is audited — approve, then the send-back carrying
    // the reviewer's own words. A reopen is a decision, not an erasure.
    const decisions = (
      await run(s.t, (ctx) => ctx.db.query("financeAuditLog").collect())
    ).filter((a) => a.action === "coding_decide");
    expect(decisions.map((a) => a.after)).toEqual([
      "Approved",
      "Changes requested",
    ]);
    expect(decisions[1].reason).toContain("show the exact amount");
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
    await reattributeAuthor(s, txnId);
    await s.as.mutation(api.transactionCodings.requestChanges, {
      transactionId: txnId,
      reviewNote: "Say which event this served",
    });
    const counts = (await s.as.query(api.finances.listReconcile, { filter: "all" })).counts;
    expect(counts.uncoded).toBe(1);
    expect(counts.coding_review).toBe(0);
  });
});

/**
 * `priorCoding` — "You've coded this vendor before" (founder, 2026-08-12):
 * the newest APPROVED coding at the same merchant, in the same chapter's
 * book, offered as an analogy for a coder to copy from (never prefill — see
 * `PriorCodingBlock`'s own module doc).
 */

/** A transaction inserted directly, skipping the ingestion path — these
 *  fixtures are about the recurring-vendor query, not about how a charge
 *  lands on the books. */
async function seedVendorTxn(
  s: ChapterSetup,
  opts: {
    merchantName?: string;
    amountCents?: number;
    postedAt?: number;
    chapterId?: Id<"chapters">;
    personId?: Id<"people">;
  } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: opts.chapterId ?? s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 999,
      postedAt: opts.postedAt ?? POST_POLICY,
      merchantName: opts.merchantName ?? "Spotify",
      status: "unreviewed",
      ...(opts.personId ? { personId: opts.personId } : {}),
      createdAt: Date.now(),
    }),
  );
}

/** A coding row inserted directly at a given status — these fixtures are
 *  about what `getForTransaction` does with an EXISTING record on a
 *  DIFFERENT charge, not about the submit/approve flow (see `review loop`
 *  above for that). */
async function seedCodingRow(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
  opts: {
    status?: "submitted" | "approved";
    businessPurpose?: string;
    headcount?: number;
    attendees?: { name: string; affiliation: string }[];
    /** Group-description mode (>15 heads): a headcount with NO attendees
     *  array at all — `attendees` reads `null` on the wire for a reason that
     *  has nothing to do with the viewer's permissions. */
    groupDescription?: string;
  } = {},
): Promise<void> {
  const authorUserId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: `coder-${transactionId}@test.local` }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("transactionCodings", {
      transactionId,
      chapterId: s.chapterId,
      expenseType: opts.attendees || opts.groupDescription ? "meal" : "general",
      businessPurpose: opts.businessPurpose ?? GOOD_PURPOSE,
      ...(opts.headcount != null ? { headcount: opts.headcount } : {}),
      ...(opts.attendees ? { attendees: opts.attendees as never } : {}),
      ...(opts.groupDescription ? { groupDescription: opts.groupDescription } : {}),
      status: opts.status ?? "approved",
      codedByUserId: authorUserId,
      submittedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("priorCoding — a vendor's own approved coding history, offered as an analogy", () => {
  test("an approved prior coding at the same vendor+chapter is offered, with amountMatches correct", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const priorTxnId = await seedVendorTxn(s, {
      merchantName: "Spotify",
      amountCents: 999,
      postedAt: POST_POLICY - 30 * DAY_MS,
    });
    await seedCodingRow(s, priorTxnId, {
      businessPurpose: "Monthly team Spotify subscription for event playlists",
    });
    const sameAmountTxnId = await seedVendorTxn(s, {
      merchantName: "Spotify",
      amountCents: 999,
      postedAt: POST_POLICY,
    });

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: sameAmountTxnId,
    });
    expect(data.priorCoding?.transactionId).toBe(priorTxnId);
    expect(data.priorCoding?.businessPurpose).toBe(
      "Monthly team Spotify subscription for event playlists",
    );
    expect(data.priorCoding?.merchantName).toBe("Spotify");
    expect(data.priorCoding?.amountMatches).toBe(true);

    // A charge at the same vendor for a DIFFERENT amount still gets offered
    // the prior coding — it's still the same analogy — but the badge doesn't
    // claim they match.
    const differentAmountTxnId = await seedVendorTxn(s, {
      merchantName: "Spotify",
      amountCents: 1499,
      postedAt: POST_POLICY,
    });
    const data2 = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: differentAmountTxnId,
    });
    expect(data2.priorCoding?.amountMatches).toBe(false);
  });

  test("a SUBMITTED (not yet approved) prior coding is never offered", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const priorTxnId = await seedVendorTxn(s, {
      merchantName: "Adobe",
      amountCents: 5499,
      postedAt: POST_POLICY - 30 * DAY_MS,
    });
    await seedCodingRow(s, priorTxnId, { status: "submitted" });
    const currentTxnId = await seedVendorTxn(s, {
      merchantName: "Adobe",
      amountCents: 5499,
      postedAt: POST_POLICY,
    });

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: currentTxnId,
    });
    expect(data.priorCoding).toBeNull();
  });

  test("a different merchant, or a different chapter's book, is never offered", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    // Different merchant, same chapter — an approved coding, but not this
    // vendor's history.
    const otherMerchantTxnId = await seedVendorTxn(s, {
      merchantName: "Not Spotify",
      amountCents: 999,
      postedAt: POST_POLICY - 30 * DAY_MS,
    });
    await seedCodingRow(s, otherMerchantTxnId);

    // Same merchant, a DIFFERENT chapter's book entirely.
    const otherChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Elsewhere",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const otherChapterTxnId = await seedVendorTxn(s, {
      merchantName: "Spotify",
      amountCents: 999,
      postedAt: POST_POLICY - 15 * DAY_MS,
      chapterId: otherChapterId,
    });
    await seedCodingRow(s, otherChapterTxnId);

    const currentTxnId = await seedVendorTxn(s, {
      merchantName: "Spotify",
      amountCents: 999,
      postedAt: POST_POLICY,
    });

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: currentTxnId,
    });
    expect(data.priorCoding).toBeNull();
  });

  // Mirrors `codingRedaction.test.ts`'s seeding of a plain member with no
  // finance role who may only view a charge because it is their own.
  test("attendeesRedacted is true only when names were actually hidden — a group-mode prior coding never claims it, even for a full-names-view caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // SCENARIO 1: a GROUP-MODE prior coding (>15 heads, no structured
    // attendees at all) read by a caller who holds FULL names-view (the
    // manager). `attendees` is null because there was never a names list —
    // NOT because anything was hidden — so `attendeesRedacted` must be
    // false. (Review finding, 2026-08-13: the old
    // `attendees === null && headcount != null` inference couldn't tell
    // these apart and rendered a false "names not shown to you" notice.)
    const groupPriorTxnId = await seedVendorTxn(s, {
      merchantName: "Costco",
      amountCents: 42000,
      postedAt: POST_POLICY - 10 * DAY_MS,
    });
    await seedCodingRow(s, groupPriorTxnId, {
      headcount: 40,
      groupDescription: "The whole chapter, open invite",
    });
    const groupCurrentTxnId = await seedVendorTxn(s, {
      merchantName: "Costco",
      amountCents: 42000,
      postedAt: POST_POLICY,
    });
    const groupData = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: groupCurrentTxnId,
    });
    expect(groupData.priorCoding).not.toBeNull();
    expect(groupData.priorCoding?.attendees).toBeNull();
    expect(groupData.priorCoding?.attendeesRedacted).toBe(false);
    expect(groupData.priorCoding?.headcount).toBe(40);

    // SCENARIO 2: a NAMES-MODE prior coding read by a caller who lacks
    // names-view on the PRIOR transaction — names really were hidden, so
    // `attendeesRedacted` must be true.
    const cardholderUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "cardholder@publicworship.life" }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId: cardholderUserId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    const cardholderPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Cardholder Cass",
        userId: cardholderUserId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    const cardholderAs = t.withIdentity({
      subject: `${cardholderUserId}|session`,
      issuer: "test",
    });

    // The PRIOR transaction belongs to somebody else entirely — coded and
    // approved by people who are not this cardholder, and this cardholder
    // holds no finance role that would open a chapter-wide names-view.
    const otherPersonId = await seedOtherPerson(s, "Other Person");
    const priorTxnId = await seedVendorTxn(s, {
      merchantName: "Panera",
      amountCents: 8600,
      postedAt: POST_POLICY - 10 * DAY_MS,
      personId: otherPersonId,
    });
    await seedCodingRow(s, priorTxnId, {
      headcount: 4,
      attendees: [
        { name: "Real Name One", affiliation: "team" },
        { name: "Real Name Two", affiliation: "volunteer" },
      ],
    });

    // THIS transaction is the cardholder's own — they may view it with no
    // finance role at all (same as `codingRedaction.test.ts`'s "THE AUTHOR
    // SEES IT").
    const currentTxnId = await seedVendorTxn(s, {
      merchantName: "Panera",
      amountCents: 8600,
      postedAt: POST_POLICY,
      personId: cardholderPersonId,
    });

    const data = await cardholderAs.query(
      api.transactionCodings.getForTransaction,
      { transactionId: currentTxnId },
    );
    expect(data.priorCoding).not.toBeNull();
    expect(data.priorCoding?.attendees).toBeNull();
    expect(data.priorCoding?.attendeesRedacted).toBe(true);
    // Headcount is not a name — it stays visible even when names are
    // redacted, exactly like `codingRow.headcount` does.
    expect(data.priorCoding?.headcount).toBe(4);
  });

  // Review finding (2026-08-13): the candidate scan used to stop at the 20
  // newest same-merchant transactions, so a vendor with 20+ newer charges
  // that hadn't reached `approved` yet hid an older approved coding entirely
  // — `priorCoding` came back `null`, indistinguishable from "never coded
  // this vendor at all". Widened to 100, with the loop still returning on
  // the FIRST approved hit it finds.
  test("an older approved coding is still found behind 21 newer unapproved same-merchant charges", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const oldestTxnId = await seedVendorTxn(s, {
      merchantName: "Widget Co",
      amountCents: 4200,
      postedAt: POST_POLICY - 100 * DAY_MS,
    });
    await seedCodingRow(s, oldestTxnId, {
      businessPurpose: "The one approved coding, buried under newer noise",
    });

    // 21 newer same-merchant charges, none of them approved — some with no
    // coding at all, some submitted-but-pending. Strictly newer than the
    // approved one, so a `.take(20)` window would exhaust itself on these
    // alone and never reach the approved row.
    for (let i = 0; i < 21; i++) {
      const noisyTxnId = await seedVendorTxn(s, {
        merchantName: "Widget Co",
        amountCents: 4200,
        postedAt: POST_POLICY - (99 - i) * DAY_MS,
      });
      if (i % 2 === 0) {
        await seedCodingRow(s, noisyTxnId, { status: "submitted" });
      }
    }

    const currentTxnId = await seedVendorTxn(s, {
      merchantName: "Widget Co",
      amountCents: 4200,
      postedAt: POST_POLICY,
    });

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: currentTxnId,
    });
    expect(data.priorCoding?.transactionId).toBe(oldestTxnId);
    expect(data.priorCoding?.businessPurpose).toBe(
      "The one approved coding, buried under newer noise",
    );
  });
});

describe("attendeeSuggestions — the roster bulk entry autofills/suggests from", () => {
  test("returns team members on the transaction's own chapter, sorted by name, excluding non-roster rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedTxn(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Zara Volunteer",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Amir Team",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    // Not eligible: not a team member at all.
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Not On Team",
        createdAt: Date.now(),
      }),
    );
    // Not eligible: a team member, but contact-only (auto-created from a
    // gift/RSVP, never actually showed up).
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Contact Only",
        isTeamMember: true,
        isContactOnly: true,
        createdAt: Date.now(),
      }),
    );
    // Not eligible: a placeholder crew slot, never a real attendee.
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Placeholder Slot",
        isTeamMember: true,
        isPlaceholder: true,
        createdAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.transactionCodings.attendeeSuggestions, {
      transactionId: txnId,
    });
    // `asManager` itself seeds a team-member row ("Manager Mo") — sorted in
    // with the others rather than special-cased out.
    expect(result).toEqual([
      { name: "Amir Team", isTeamMember: true },
      { name: "Manager Mo", isTeamMember: true },
      { name: "Zara Volunteer", isTeamMember: true },
    ]);
  });

  test("refuses a caller with no reach into the transaction's book — same bar as authoring it", async () => {
    const t = newT();
    const chapterA = await setupChapter(t, { email: "a@publicworship.life" });
    await asManager(chapterA);
    const txnId = await seedTxn(chapterA);

    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Other Chapter",
    });

    await expect(
      chapterB.as.query(api.transactionCodings.attendeeSuggestions, {
        transactionId: txnId,
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("a central-book transaction falls back to the caller's own home-chapter team", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerId = await asManager(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: CENTRAL,
        personId: managerId,
        role: "bookkeeper",
        scope: "central",
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Home Chapter Teammate",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    const centralTxnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "manual",
        flow: "outflow",
        amountCents: 5000,
        postedAt: POST_POLICY,
        merchantName: "Central Vendor",
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.transactionCodings.attendeeSuggestions, {
      transactionId: centralTxnId,
    });
    // `asManager` itself seeds a team-member row ("Manager Mo") on the same
    // home chapter — sorted in with the others.
    expect(result).toEqual([
      { name: "Home Chapter Teammate", isTeamMember: true },
      { name: "Manager Mo", isTeamMember: true },
    ]);
  });
});
