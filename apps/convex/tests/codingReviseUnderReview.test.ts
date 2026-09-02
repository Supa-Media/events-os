/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { CENTRAL, DEFAULT_CODING_REQUIRED_SINCE_MS, DAY_MS } from "@events-os/shared";
import {
  newT,
  run,
  seedApprovedBudget,
  setupChapter,
  storeBlob,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * FIX IT HERE, DON'T SEND IT BACK — `transactionCodings.reviseUnderReview`,
 * and the budget gate on `approve` that makes it necessary.
 *
 * Founder, 2026-09-02, looking at a merch invoice sitting in the review queue
 * reading "Not attributed to a budget": *"got to make sure the
 * treasurer/financial manager can edit details like the budget category for
 * example, we shouldn't be letting things go through without a budget, also
 * allow them to edit any other details they want instead of sending back and
 * forth."*
 *
 * Two halves that only work together, which is why they are one suite. The
 * gate alone would strand a reviewer on a row they can see is wrong and
 * cannot fix; the editor alone would leave the wrong answer approvable. Read
 * from the top:
 *
 *  1. THE GATE — what `approve` now refuses, and the rows it deliberately
 *     still lets through (a fee, a personal charge, an inflow: things with no
 *     budget to have).
 *  2. THE EDITOR — attribution, then the structured facts.
 *  3. WHAT IT MUST NEVER DO — rewrite the author's sentence, move authorship,
 *     lose the redaction, or slip past separation of duties.
 *  4. REACH — the central FM on a chapter's row, which is precisely the case
 *     `finances.categorizeTransaction` cannot serve.
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const PURPOSE = "Production and fulfillment of merch sold through the store";

async function asTreasurer(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Treasurer Tayo",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
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

/** The cardholder whose testimony is under review. Separation of duties means
 *  the reviewer can never be this person, which is also the realistic shape. */
async function addAuthor(
  s: ChapterSetup,
  opts: { email?: string; name?: string } = {},
): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
  personId: Id<"people">;
  userId: Id<"users">;
}> {
  const userId = await run(s.t, (ctx) =>
    ctx.db.insert("users", {
      email: opts.email ?? "cardholder@publicworship.life",
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name ?? "Cardholder Cass",
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
    userId,
  };
}

/** A post-policy, receipted outflow — and DELIBERATELY unbudgeted, because
 *  that is the state this whole suite is about. */
async function seedTxn(
  s: ChapterSetup,
  opts: {
    personId?: Id<"people">;
    book?: Id<"chapters"> | "central";
    flow?: "outflow" | "inflow";
    isPersonal?: boolean;
    feeOrigin?: "stripe_processing";
  } = {},
): Promise<Id<"transactions">> {
  const receiptStorageId = await storeBlob(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: opts.book ?? s.chapterId,
      source: "manual",
      flow: opts.flow ?? "outflow",
      amountCents: 1797,
      postedAt: POST_POLICY,
      merchantName: "TAPSTITCH INC.",
      status: "unreviewed",
      receiptStorageId,
      ...(opts.personId ? { personId: opts.personId } : {}),
      ...(opts.isPersonal ? { isPersonal: true } : {}),
      ...(opts.feeOrigin ? { feeOrigin: opts.feeOrigin } : {}),
      createdAt: Date.now(),
    }),
  );
}

/** A SUBMITTED coding authored by `authorPersonId`, written straight to the
 *  table so a test about REVISING never depends on who may author. */
async function seedSubmittedCoding(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
  book: Id<"chapters"> | "central",
  author: { personId: Id<"people">; userId: Id<"users"> },
  fields: Partial<Doc<"transactionCodings">> = {},
): Promise<Id<"transactionCodings">> {
  const now = Date.now();
  const id = await run(s.t, (ctx) =>
    ctx.db.insert("transactionCodings", {
      transactionId,
      chapterId: book,
      expenseType: "general",
      businessPurpose: PURPOSE,
      status: "submitted",
      codedByPersonId: author.personId,
      codedByUserId: author.userId,
      submittedAt: now,
      updatedAt: now,
      ...fields,
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.patch(transactionId, { codingState: "submitted" }),
  );
  return id;
}

function codingOf(s: ChapterSetup, transactionId: Id<"transactions">) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactionCodings")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .unique(),
  );
}

function auditRows(s: ChapterSetup, subjectId: Id<"transactions">) {
  return run(s.t, async (ctx) =>
    (await ctx.db.query("financeAuditLog").collect()).filter(
      (r) => r.subjectId === subjectId,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE GATE
// ─────────────────────────────────────────────────────────────────────────────

describe("nothing goes through without a budget", () => {
  test("approve refuses spend with no budget, and takes it once one is set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    await expect(
      s.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "BUDGET_REQUIRED" }),
      }) as unknown as Error,
    );
    // Refused, not half-applied — the coding is still awaiting review.
    expect((await codingOf(s, txnId))?.status).toBe("submitted");

    // The reviewer sets it themselves, on the same row, and approves. This is
    // the whole point of the pair: the gate always names a fix the person
    // reading it can perform.
    const budgetId = await seedApprovedBudget(s.t, s.chapterId);
    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      budgetId,
    });
    await s.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect((await codingOf(s, txnId))?.status).toBe("approved");
  });

  test("rows with no budget to have are untouched by the gate", async () => {
    // `needsBudget` is the population, not "budgetId == null" — a fee was
    // charged rather than chosen, a personal charge is the spender's own
    // money, and an inflow is not spend at all. Approving a voluntary coding
    // on any of them must not be blocked over a budget they never owed.
    for (const shape of [
      { feeOrigin: "stripe_processing" as const },
      { isPersonal: true },
      { flow: "inflow" as const },
    ]) {
      const t = newT();
      const s = await setupChapter(t);
      await asTreasurer(s);
      const author = await addAuthor(s);
      const txnId = await seedTxn(s, { personId: author.personId, ...shape });
      await seedSubmittedCoding(s, txnId, s.chapterId, author);

      await s.as.mutation(api.transactionCodings.approve, {
        transactionId: txnId,
      });
      expect((await codingOf(s, txnId))?.status).toBe("approved");
    }
  });

  test("the queue and the record both say so before the tap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const record = await s.as.query(api.transactionCodings.reviewRecord, {
      transactionId: txnId,
    });
    expect(record.charge.budgetRequired).toBe(true);
    expect(record.charge.budgetId).toBeNull();
    expect(record.canRevise).toBe(true);

    const queue = await s.as.query(api.transactionCodings.reviewQueue, {});
    expect(queue.rows.find((r) => r.transactionId === txnId)?.budgetRequired).toBe(
      true,
    );

    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      budgetId: await seedApprovedBudget(s.t, s.chapterId),
    });
    expect(
      (
        await s.as.query(api.transactionCodings.reviewRecord, {
          transactionId: txnId,
        })
      ).charge.budgetRequired,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE EDITOR
// ─────────────────────────────────────────────────────────────────────────────

describe("attribution a reviewer sets from the record", () => {
  test("budget and category land on the transaction, audited as `recode`", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author);
    const budgetId = await seedApprovedBudget(s.t, s.chapterId, {
      label: "Merch",
    });
    const categoryId = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        name: "Merchandise",
        kind: "category",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      budgetId,
      categoryId,
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBe(budgetId);
    expect(txn?.categoryId).toBe(categoryId);

    // The SAME two rows the Reconcile "For" picker writes — a budget set from
    // the review record and one set from the grid are the same assertion and
    // have to read identically in the trail.
    const recodes = (await auditRows(s, txnId)).filter(
      (r) => r.action === "recode",
    );
    expect(recodes.map((r) => r.field).sort()).toEqual(["budget", "category"]);
    expect(recodes.find((r) => r.field === "budget")?.after).toBe("Merch");
    expect(recodes.find((r) => r.field === "budget")?.before).toBe("None");
  });

  test("a reviewer may CLEAR an attribution the cardholder could only set", async () => {
    // "This budget is the wrong one and I don't yet know the right one" is a
    // real state, and leaving a wrong answer on the record is worse. Clearing
    // does not make the row approvable — the gate reads the same column.
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author);
    const budgetId = await seedApprovedBudget(s.t, s.chapterId);
    await run(s.t, (ctx) => ctx.db.patch(txnId, { budgetId }));

    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      budgetId: null,
    });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId).toBeUndefined();
    await expect(
      s.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "BUDGET_REQUIRED" }),
      }) as unknown as Error,
    );
  });

  test("an unapproved budget is refused here exactly as it is in Reconcile", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author);
    const draftBudget = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100_000,
        label: "Not approved yet",
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        approvalStatus: "draft",
        createdAt: Date.now(),
      }),
    );

    await expect(
      s.as.mutation(api.transactionCodings.reviseUnderReview, {
        transactionId: txnId,
        budgetId: draftBudget,
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "BUDGET_NOT_APPROVED" }),
      }) as unknown as Error,
    );
  });
});

describe("the structured facts a reviewer may correct", () => {
  test("retyping clears the stale type-specific fields and stamps the amendment", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const reviewerPersonId = await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author, {
      expenseType: "travel",
      travelFrom: "Boston",
      travelTo: "New York",
    });

    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      coding: { expenseType: "general" },
    });

    const coding = await codingOf(s, txnId);
    expect(coding?.expenseType).toBe("general");
    // The same guarantee `submitCoding`'s `replace` gives: a charge retyped
    // out of travel must not keep a route nobody is asserting any more.
    expect(coding?.travelFrom).toBeUndefined();
    expect(coding?.travelTo).toBeUndefined();
    // AMENDED, not re-authored — see below for the half that matters most.
    expect(coding?.revisedByPersonId).toBe(reviewerPersonId);
    expect(coding?.revisedAt).toEqual(expect.any(Number));

    const amendments = (await auditRows(s, txnId)).filter(
      (r) => r.action === "coding_amend",
    );
    expect(amendments.map((r) => r.field).sort()).toEqual([
      "expenseType",
      "route",
    ]);
    expect(amendments.find((r) => r.field === "expenseType")?.before).toBe(
      "Travel",
    );
    expect(amendments.find((r) => r.field === "expenseType")?.after).toBe(
      "General",
    );
  });

  test("setting only the budget does not claim the coding was amended", async () => {
    // The common shape: the panel posts the whole field set back even when
    // the reviewer only touched the budget picker. "Amended during review by
    // …" renders off the stamp, and putting it on most rows would be a claim
    // nobody made.
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author, {
      expenseType: "travel",
      travelFrom: "Boston",
      travelTo: "New York",
    });

    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      budgetId: await seedApprovedBudget(s.t, s.chapterId),
      // Verbatim what the record already holds — the panel round-trips it.
      coding: {
        expenseType: "travel",
        travelFrom: "Boston",
        travelTo: "New York",
      },
    });

    const coding = await codingOf(s, txnId);
    expect(coding?.revisedAt).toBeUndefined();
    expect(coding?.revisedByPersonId).toBeUndefined();
    expect(
      (await auditRows(s, txnId)).filter((r) => r.action === "coding_amend"),
    ).toHaveLength(0);
    // The budget half still landed — the two halves are independent.
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId).toEqual(
      expect.any(String),
    );
  });

  test("a correction is held to the same completeness rule the author was", async () => {
    // `normalizeCodingFields` is shared, deliberately: a reviewer must not be
    // able to leave a record the author could not have submitted.
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    await expect(
      s.as.mutation(api.transactionCodings.reviseUnderReview, {
        transactionId: txnId,
        coding: { expenseType: "travel" },
      }),
    ).rejects.toThrow(ConvexError);
    // Nothing partially applied.
    expect((await codingOf(s, txnId))?.expenseType).toBe("general");
  });

  test("the audit trail never carries an attendee's NAME", async () => {
    // The trail is read on surfaces whose readers may not hold names-view,
    // and it has no redaction pass — a name copied into `before`/`after`
    // would escape that gate permanently.
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author, {
      expenseType: "meal",
      headcount: 2,
      attendees: [
        { name: "Michaela Lawson", affiliation: "team" },
        { name: "Ade Bello", affiliation: "volunteer" },
      ],
    });

    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      coding: {
        expenseType: "meal",
        headcount: 3,
        attendees: [
          { name: "Michaela Lawson", affiliation: "team" },
          { name: "Ade Bello", affiliation: "volunteer" },
          { name: "Sam Okoye", affiliation: "community_member" },
        ],
      },
    });

    const trail = JSON.stringify(await auditRows(s, txnId));
    for (const name of ["Michaela", "Lawson", "Ade Bello", "Okoye"]) {
      expect(trail).not.toContain(name);
    }
    const attendeeRow = (await auditRows(s, txnId)).find(
      (r) => r.action === "coding_amend" && r.field === "attendees",
    );
    expect(attendeeRow?.after).toContain("3 named");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT IT MUST NEVER DO
// ─────────────────────────────────────────────────────────────────────────────

describe("the author's testimony survives the correction", () => {
  test("the sentence, the authorship and the redaction all come through untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author, {
      expenseType: "travel",
      travelFrom: "Boston",
      travelTo: "New York",
      publicPurpose: "Travel to the Eden shoot",
      publicPurposeAt: Date.now(),
    });

    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      coding: { expenseType: "travel", travelFrom: "Boston", travelTo: "Queens" },
    });

    const coding = await codingOf(s, txnId);
    // THE ONE THAT MATTERS: what actually happened has to survive whoever
    // reads it afterwards. `reviseUnderReview` has no `businessPurpose`
    // argument at all, and this is the assertion behind that.
    expect(coding?.businessPurpose).toBe(PURPOSE);
    // Authorship does not move. Beyond honesty, this is what keeps the
    // corrector's own later approval legal under separation of duties.
    expect(coding?.codedByPersonId).toBe(author.personId);
    expect(coding?.codedByUserId).toBe(author.userId);
    // `submitCoding`'s `db.replace` would have dropped this; the revise path
    // patches, so the approver's redaction is still standing.
    expect(coding?.publicPurpose).toBe("Travel to the Eden shoot");
    expect(coding?.status).toBe("submitted");

    // And the corrector can still approve it afterwards — the round trip the
    // whole feature exists to remove.
    await s.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      budgetId: await seedApprovedBudget(s.t, s.chapterId),
    });
    await s.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect((await codingOf(s, txnId))?.status).toBe("approved");
  });

  test("separation of duties: nobody corrects their OWN coding", async () => {
    // Otherwise "I can't approve my own, but I can rewrite what mine says
    // before somebody else does" would be a way around it.
    const t = newT();
    const s = await setupChapter(t);
    const reviewerPersonId = await asTreasurer(s);
    const txnId = await seedTxn(s, { personId: reviewerPersonId });
    await seedSubmittedCoding(s, txnId, s.chapterId, {
      personId: reviewerPersonId,
      userId: s.userId,
    });

    await expect(
      s.as.mutation(api.transactionCodings.reviseUnderReview, {
        transactionId: txnId,
        coding: { expenseType: "general" },
      }),
    ).rejects.toThrow(ConvexError);
    expect(
      (
        await s.as.query(api.transactionCodings.reviewRecord, {
          transactionId: txnId,
        })
      ).canRevise,
    ).toBe(false);
  });

  test("an APPROVED coding is not correctable — reopening it is its own decision", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asTreasurer(s);
    const author = await addAuthor(s);
    const txnId = await seedTxn(s, { personId: author.personId });
    const budgetId = await seedApprovedBudget(s.t, s.chapterId);
    await run(s.t, (ctx) => ctx.db.patch(txnId, { budgetId }));
    await seedSubmittedCoding(s, txnId, s.chapterId, author);
    await s.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });

    await expect(
      s.as.mutation(api.transactionCodings.reviseUnderReview, {
        transactionId: txnId,
        coding: { expenseType: "general" },
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "NOT_SUBMITTED" }),
      }) as unknown as Error,
    );
  });

  test("a bookkeeper can code but cannot correct — this is the DECIDING power", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const author = await addAuthor(s);
    const bookkeeperPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Bookkeeper Bee",
        userId: s.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: bookkeeperPersonId,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const txnId = await seedTxn(s, { personId: author.personId });
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    await expect(
      s.as.mutation(api.transactionCodings.reviseUnderReview, {
        transactionId: txnId,
        budgetId: await seedApprovedBudget(s.t, s.chapterId),
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "FORBIDDEN" }),
      }) as unknown as Error,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. REACH
// ─────────────────────────────────────────────────────────────────────────────

describe("the reviewer's reach, not the bookkeeper's", () => {
  test("a central Financial Manager corrects ANOTHER chapter's row", async () => {
    // The case `finances.categorizeTransaction` cannot serve: its gate
    // resolves the caller's OWN chapter and returns NOT_FOUND for anything
    // else, so the person the founder named — a central FM deciding a
    // chapter's coding — could approve a row and not fix it.
    const t = newT();
    const central = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Central Desk",
    });
    const fmPersonId = await run(central.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: central.chapterId,
        name: "FM Fola",
        userId: central.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await run(central.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: CENTRAL,
        personId: fmPersonId,
        role: "manager",
        scope: "central",
        createdAt: Date.now(),
      }),
    );
    const otherChapterId = await run(central.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "New York",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const nyAuthorUserId = await run(central.t, (ctx) =>
      ctx.db.insert("users", { email: "ny@publicworship.life" }),
    );
    const nyAuthorPersonId = await run(central.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: otherChapterId,
        name: "NY Cardholder",
        userId: nyAuthorUserId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    const txnId = await seedTxn(central, {
      book: otherChapterId,
      personId: nyAuthorPersonId,
    });
    await seedSubmittedCoding(central, txnId, otherChapterId, {
      personId: nyAuthorPersonId,
      userId: nyAuthorUserId,
    });

    const nyBudget = await seedApprovedBudget(central.t, otherChapterId, {
      label: "NY Operating",
    });
    // The picker offers the ROW's book, not the caller's — the FM's own
    // chapter has no budgets, and offering them would have listed answers the
    // write gate then refuses while hiding the only correct ones.
    const options = await central.as.query(
      api.transactionCodings.budgetOptions,
      { transactionId: txnId },
    );
    expect(options.recurring.map((r) => r.budgetId)).toContain(nyBudget);

    await central.as.mutation(api.transactionCodings.reviseUnderReview, {
      transactionId: txnId,
      budgetId: nyBudget,
    });
    expect((await run(central.t, (ctx) => ctx.db.get(txnId)))?.budgetId).toBe(
      nyBudget,
    );
    await central.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect((await codingOf(central, txnId))?.status).toBe("approved");
  });
});
