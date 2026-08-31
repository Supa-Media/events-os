/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * EVERY QUERY `/code` MOUNTS, AGAINST A CHARGE THAT HAS LIVED A LITTLE.
 *
 * A Convex query that throws does not fail like a failed read. It throws
 * during RENDER, which React treats as a failed component: it unwinds to the
 * root `ErrorBoundary` and replaces the whole page. On `/code` — whose entire
 * audience is volunteers with no finance seat — that turns one over-tight
 * gate into "Something went wrong" over the only screen they have.
 *
 * That has now happened twice, and the second one is the reason this file
 * exists rather than another one-off test:
 *
 *   - `receipts.listForTransaction` (bookkeeper-gated) behind the "Attached"
 *     chip. Caught by a test with an unpopulated fixture, because the chip
 *     only renders once a receipt exists.
 *   - `finances.financeAuditTrail`, which answers `[]` for an EMPTY log
 *     before it ever reaches its gate, and throws once there is anything to
 *     show. Every fixture took the first path. A real charge — one whose
 *     receipt had been attached, which is itself an audit row — took the
 *     second, and the coding sheet died the moment it opened. That one stays
 *     a refusal on purpose (see below); the fix was on the client.
 *
 * The shared lesson is not about either query. It is that a fresh fixture is
 * the one state these surfaces are never in when a person reaches them: the
 * cardholder arrives at a charge that has a receipt, a category, a history.
 * So this seeds that charge and asserts the whole member surface RESOLVES —
 * the assertion is "does not throw", because throwing is the failure mode
 * that costs the page.
 */

async function seedFullyLivedCharge(s: ChapterSetup): Promise<{
  me: Id<"people">;
  txnId: Id<"transactions">;
  categoryId: Id<"budgetCategories">;
}> {
  const me = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Michaela",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  const cardId = await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId: me,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
  const txnId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "increase_card",
      flow: "outflow",
      amountCents: 1797,
      postedAt: Date.UTC(2026, 7, 30),
      merchantName: "TAPSTITCH INC.",
      cardId,
      personId: me,
      cardLast4: "7303",
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
  const categoryId = await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      name: "Supplies",
      kind: "lineItem",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );

  // THE PART THAT MATTERS: do the things a cardholder does, through the real
  // mutations, so the charge carries the rows they actually write — a receipt
  // link and, with it, `financeAuditLog` history. Seeding the transaction
  // alone reproduces a charge nobody has touched, which is the one state that
  // hid both crashes.
  const storageId = await storeBlob(s.t);
  await s.as.mutation(api.finances.attachReceipt, {
    transactionId: txnId,
    storageId,
  });
  await s.as.mutation(api.finances.submitOwnCharge, {
    transactionId: txnId,
    categoryId,
    note: "Thread and fabric for the banner build day",
  });

  return { me, txnId, categoryId };
}

describe("the /code member surface, on a charge with a history", () => {
  test("every query the page and its sheet mount resolves for a cardholder with no finance role", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "michaela@publicworship.life" });
    const { txnId } = await seedFullyLivedCharge(s);

    // The history is real — otherwise this test would be re-testing the empty
    // early return that hid the bug in the first place.
    const auditRows = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .withIndex("by_subject", (q) =>
          q.eq("subjectType", "transaction").eq("subjectId", txnId as string),
        )
        .collect(),
    );
    expect(auditRows.length).toBeGreaterThan(0);

    // Mounted by the page itself.
    await expect(s.as.query(api.profiles.me, {})).resolves.toBeTruthy();
    await expect(
      s.as.query(api.finances.personTransactions, {}),
    ).resolves.toHaveLength(1);
    await expect(s.as.query(api.finances.myChargeCategories, {})).resolves.toBeTruthy();
    await expect(s.as.query(api.transactionCodings.policy, {})).resolves.toBeTruthy();

    // Mounted by the coding sheet the moment it opens.
    await expect(
      s.as.query(api.transactionCodings.getForTransaction, { transactionId: txnId }),
    ).resolves.toBeTruthy();
    await expect(
      s.as.query(api.transactionCodings.budgetOptions, {}),
    ).resolves.toBeTruthy();
    await expect(
      s.as.query(api.transactionCodings.attendeeSuggestions, { transactionId: txnId }),
    ).resolves.toBeTruthy();
    // THE HISTORY STRIP — THE ONE THAT CRASHED, and the one query here that
    // still refuses her, deliberately: "rejected (FORBIDDEN), not shown an
    // empty list" is a decision `tests/financeAuditLog.test.ts` pins on
    // purpose, and reversing an authorization rule to fix a rendering bug
    // would be the wrong trade entirely.
    //
    // So it is pinned as a REFUSAL here, and the protection lives where the
    // mistake was: `TransactionHistoryCompact` reads it through `useQueries`,
    // which returns the failure instead of throwing it during render. That is
    // what the component always claimed to do — it just used `useQuery`, and
    // the handler's empty-log early return meant no fixture ever caught it.
    // `__tests__/memberSurfaceQueries.test.js` is the guardrail that keeps it
    // that way.
    await expect(
      s.as.query(api.finances.financeAuditTrail, {
        subjectType: "transaction",
        subjectId: txnId,
      }),
    ).rejects.toThrow(ConvexError);
    // Behind the "Attached ✓" chip, on a charge that now has one.
    await expect(
      s.as.query(api.receipts.listForTransaction, { transactionId: txnId }),
    ).resolves.toHaveLength(1);
    // The receipt-exception history, read when a charge has no receipt.
    await expect(
      s.as.query(api.receiptExceptions.listForTransaction, { transactionId: txnId }),
    ).resolves.toEqual([]);
    await expect(
      s.as.query(api.receiptExceptions.approvalThreshold, {}),
    ).resolves.toBeTruthy();
    // Offered receipts (read through `useQueries` on the client, but it should
    // not be refusing the owner in the first place).
    await expect(
      s.as.query(api.receipts.suggestedForTransaction, { transactionId: txnId }),
    ).resolves.toBeTruthy();
  });

  test("and she can still finish the charge — the point of the page", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "michaela@publicworship.life" });
    const { txnId } = await seedFullyLivedCharge(s);

    const codingId = await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: "Thread and fabric for the chapter banner build day",
    });
    expect(codingId).toBeTruthy();

    // And the sheet still opens on the charge afterwards, now that a coding
    // and one more pile of audit rows exist.
    await expect(
      s.as.query(api.transactionCodings.getForTransaction, { transactionId: txnId }),
    ).resolves.toBeTruthy();
  });
});
