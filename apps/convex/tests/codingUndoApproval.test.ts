/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  DEFAULT_CODING_REQUIRED_SINCE_MS,
  DAY_MS,
  UNDO_APPROVAL_WINDOW_MS,
} from "@events-os/shared";
import {
  newT,
  run,
  seedApprovedBudget,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * UNDO AN APPROVAL — `transactionCodings.undoApproval`.
 *
 * The panel's ~10s Undo used to call `requestChanges`, which was wrong twice:
 * it landed the coding in `changes_requested` (meaning "the AUTHOR must act",
 * when in fact the APPROVER mis-tapped and nobody found anything wrong), and
 * it emailed the author about a send-back for an approval they never saw.
 *
 * This suite pins the replacement — and, just as importantly, pins that
 * `requestChanges` STILL notifies on the ordinary path, because the fix must
 * not have been "turn the email off".
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const GOOD_PURPOSE = "Travel to NY to film the Eden event with the team";

async function seedPerson(
  s: ChapterSetup,
  name: string,
  opts: { self?: boolean } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      ...(opts.self ? { userId: s.userId } : {}),
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedPerson(s, "Manager Mo", { self: true });
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

async function seedTxn(s: ChapterSetup): Promise<Id<"transactions">> {
  const receiptStorageId = await storeBlob(s.t);
  // BUDGETED by default: `transactionCodings.approve` refuses spend that owes
  // a budget and hasn't got one (`finances.needsBudget`, founder 2026-09-02).
  // That gate has its own suite (`codingReviseUnderReview.test.ts`); here it is a
  // precondition of reaching what these tests are about, exactly like the
  // receipt above.
  const budgetId = await seedApprovedBudget(s.t, s.chapterId);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 5800,
      postedAt: POST_POLICY,
      merchantName: "Peter Pan Bus Lines",
      status: "unreviewed",
      receiptStorageId,
      budgetId,
      createdAt: Date.now(),
    }),
  );
}

async function codingRow(
  s: ChapterSetup,
  txnId: Id<"transactions">,
): Promise<Doc<"transactionCodings">> {
  return (await run(s.t, (ctx) =>
    ctx.db
      .query("transactionCodings")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
      .unique(),
  ))!;
}

/** Everything the app has scheduled, by function-name fragment — how a test
 *  proves an email WAS or WAS NOT queued. */
async function scheduled(s: ChapterSetup, fragment: string) {
  const rows = await run(s.t, (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return rows.filter((r) => r.name.includes(fragment));
}

/** A submitted coding authored by SOMEBODY ELSE, so the caller approving it is
 *  a second name — separation of duties is not what these tests are about. */
async function approvedByCaller(s: ChapterSetup): Promise<{
  txnId: Id<"transactions">;
  author: Id<"people">;
}> {
  const author = await seedPerson(s, "Cardholder Cass");
  const txnId = await seedTxn(s);
  await s.as.mutation(api.transactionCodings.submit, {
    transactionId: txnId,
    expenseType: "general",
    businessPurpose: GOOD_PURPOSE,
  });
  const coding = await codingRow(s, txnId);
  await run(s.t, (ctx) => ctx.db.patch(coding._id, { codedByPersonId: author }));
  await s.as.mutation(api.transactionCodings.approve, { transactionId: txnId });
  return { txnId, author };
}

describe("undo restores the state the approval left, and nothing else", () => {
  test("the coding goes back to SUBMITTED — the reviewer's queue, not the author's", async () => {
    // The defect this mutation exists to fix: `changes_requested` means "the
    // author must act", and an undo means the approver mis-tapped. The coding
    // was fine, it was awaiting review, and it should be awaiting review
    // again.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const { txnId } = await approvedByCaller(s);
    expect((await codingRow(s, txnId)).status).toBe("approved");

    await s.as.mutation(api.transactionCodings.undoApproval, {
      transactionId: txnId,
    });

    const after = await codingRow(s, txnId);
    expect(after.status).toBe("submitted");
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.codingState).toBe(
      "submitted",
    );
    // Never `changes_requested`, and no note invented to justify the reopen.
    expect(after.status).not.toBe("changes_requested");
    expect(after.reviewNote).toBeUndefined();
  });

  test("everything the approval stamped is cleared", async () => {
    // A row reading "approved by X, single-party" while sitting in `submitted`
    // would be a decision record for a decision that no longer stands — and
    // `approvalParty` is the durable trace of the solo-operator bypass, which
    // must describe a LIVE approval or nothing at all.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const { txnId } = await approvedByCaller(s);
    const approved = await codingRow(s, txnId);
    expect(approved.decidedByUserId).toBeDefined();
    expect(approved.decidedAt).toBeDefined();
    expect(approved.approvalParty).toBe("two_party");

    await s.as.mutation(api.transactionCodings.undoApproval, {
      transactionId: txnId,
    });

    const after = await codingRow(s, txnId);
    expect(after.decidedByUserId).toBeUndefined();
    expect(after.decidedByPersonId).toBeUndefined();
    expect(after.decidedAt).toBeUndefined();
    expect(after.approvalParty).toBeUndefined();
    // The author's own testimony is untouched throughout.
    expect(after.businessPurpose).toBe(GOOD_PURPOSE);
  });

  test("the coding is approvable again — the undo really put it back in the queue", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const { txnId } = await approvedByCaller(s);
    await s.as.mutation(api.transactionCodings.undoApproval, {
      transactionId: txnId,
    });

    await s.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect((await codingRow(s, txnId)).status).toBe("approved");
  });
});

describe("nobody is told, because from the author's side nothing happened", () => {
  test("undo schedules NO notification", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const { txnId } = await approvedByCaller(s);

    await s.as.mutation(api.transactionCodings.undoApproval, {
      transactionId: txnId,
    });

    expect(await scheduled(s, "notifyCodingSentBack")).toHaveLength(0);
  });

  test("…but requestChanges STILL notifies on the ordinary path", async () => {
    // The fix must not have been "turn the email off". A send-back nobody
    // hears about is a note in a row nobody reopens — that reasoning is why
    // `undoApproval` is a separate mutation rather than a `silent` flag here.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const { txnId } = await approvedByCaller(s);

    await s.as.mutation(api.transactionCodings.requestChanges, {
      transactionId: txnId,
      reviewNote: "The receipt has to show the exact amount.",
    });

    const sends = await scheduled(s, "notifyCodingSentBack");
    expect(sends).toHaveLength(1);
    expect(sends[0].args[0]).toMatchObject({ transactionId: txnId });
    expect((await codingRow(s, txnId)).status).toBe("changes_requested");
  });
});

describe("only the approver, only while it is fresh", () => {
  test("a different reviewer is refused, and pointed at the send-back", async () => {
    // Somebody else's approval is not yours to quietly roll back — that is
    // what `requestChanges` is for, with its note and its email.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const { txnId } = await approvedByCaller(s);
    // Re-stamp the approval as a DIFFERENT user's, leaving everything else —
    // including the freshness — exactly as it was.
    const otherUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "someone.else@publicworship.life" }),
    );
    const coding = await codingRow(s, txnId);
    await run(s.t, (ctx) =>
      ctx.db.patch(coding._id, { decidedByUserId: otherUserId }),
    );

    await expect(
      s.as.mutation(api.transactionCodings.undoApproval, {
        transactionId: txnId,
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_YOUR_APPROVAL" } });
    expect((await codingRow(s, txnId)).status).toBe("approved");
  });

  test("past the window it is refused, and the message names the honest path", async () => {
    // SERVER-ENFORCED, read off the row's own `decidedAt` — a paused tab or a
    // client with a stopped clock must not be able to widen it.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const { txnId } = await approvedByCaller(s);
    const coding = await codingRow(s, txnId);
    await run(s.t, (ctx) =>
      ctx.db.patch(coding._id, {
        decidedAt: Date.now() - UNDO_APPROVAL_WINDOW_MS - 1000,
      }),
    );

    await expect(
      s.as.mutation(api.transactionCodings.undoApproval, {
        transactionId: txnId,
      }),
    ).rejects.toMatchObject({
      data: {
        code: "UNDO_WINDOW_CLOSED",
        message: expect.stringContaining("Send the coding back with a note"),
      },
    });
    expect((await codingRow(s, txnId)).status).toBe("approved");
  });

  test("the window is real time, not a client claim — just inside it still works", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const { txnId } = await approvedByCaller(s);
    const coding = await codingRow(s, txnId);
    await run(s.t, (ctx) =>
      ctx.db.patch(coding._id, {
        decidedAt: Date.now() - UNDO_APPROVAL_WINDOW_MS + 5000,
      }),
    );

    await s.as.mutation(api.transactionCodings.undoApproval, {
      transactionId: txnId,
    });
    expect((await codingRow(s, txnId)).status).toBe("submitted");
  });

  test("a coding that isn't approved has no approval to undo", async () => {
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
      s.as.mutation(api.transactionCodings.undoApproval, {
        transactionId: txnId,
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_APPROVED" } });
  });
});

describe("the audit trail reads approve-then-undo", () => {
  test("an auditor never finds a send-back that never happened", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const { txnId } = await approvedByCaller(s);

    await s.as.mutation(api.transactionCodings.undoApproval, {
      transactionId: txnId,
    });

    const decisions = (
      await run(s.t, (ctx) => ctx.db.query("financeAuditLog").collect())
    ).filter((a) => a.action === "coding_decide");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ after: "Approved" });
    // The state it RETURNED TO — never "Changes requested".
    expect(decisions[1]).toMatchObject({
      before: "Approved",
      after: "Awaiting review",
      actorPersonId: personId,
      amountCents: 5800,
    });
    expect(decisions[1].after).not.toBe("Changes requested");
    expect(decisions[1].reason).toContain("Approval undone by the approver");
  });
});

describe("the solo operator — where the undo matters most", () => {
  test("a superuser can undo their own single-party approval", async () => {
    // The founder grinding 400 rows is both author and approver. If the undo
    // didn't cover the solo-operator path it would be dead exactly where it
    // was designed to be used.
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    await seedPerson(s, "Owner", { self: true });
    const txnId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    await s.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect((await codingRow(s, txnId)).approvalParty).toBe("single");

    await s.as.mutation(api.transactionCodings.undoApproval, {
      transactionId: txnId,
    });
    const after = await codingRow(s, txnId);
    expect(after.status).toBe("submitted");
    // The single-party trace goes with the approval it described.
    expect(after.approvalParty).toBeUndefined();
    expect(await scheduled(s, "notifyCodingSentBack")).toHaveLength(0);
  });
});
