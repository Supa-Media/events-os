/**
 * Owner decision (2026-07-17, verbatim): "they shouldn't be able to change
 * the budget bucket, but they should be able to do everything else like
 * write notes, add receipts, change the category etc" — a caller with EVENT
 * EDIT rights (owner/lead — `lib/org.ts#callerHasEventEditRights`) may
 * note/receipt/categorize a transaction attributed to THEIR OWN event's
 * budget, without needing any finance role. Finance ranks (bookkeeper+) keep
 * their EXISTING, unchanged power throughout (see `requireReconcileTxn`'s own
 * suite for that side — untouched here). Reattribution (`categorizeTransaction`'s
 * `budgetId`/`fundId`/`teamId`) and amount/status (`setTransactionStatus`)
 * are NEVER reachable through the new scoped gate — pinned explicitly below.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";

async function addMember(
  s: ChapterSetup,
  opts: { email: string; name: string; managerId?: Id<"people"> },
): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
  userId: Id<"users">;
  personId: Id<"people">;
}> {
  const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email: opts.email }));
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
      name: opts.name,
      userId,
      isTeamMember: true,
      managerId: opts.managerId,
      createdAt: Date.now(),
    }),
  );
  const as = s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId, personId };
}

async function seedEvent(
  s: ChapterSetup,
  opts: { name?: string; ownerPersonId?: Id<"people"> } = {},
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Service",
      slug: `service-${Date.now()}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "Sunday Gathering",
      eventDate: Date.now(),
      status: "planning",
      ownerPersonId: opts.ownerPersonId,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedProject(s: ChapterSetup, name: string): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name,
      status: "in_progress",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedEventBudget(
  s: ChapterSetup,
  eventId: Id<"events">,
  opts: { chapterId?: Id<"chapters"> | "central"; type?: "one_time" | "recurring" } = {},
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: opts.chapterId ?? s.chapterId,
      amountCents: 100000,
      type: opts.type ?? "one_time",
      refKind: "event",
      scopeRefId: eventId,
      cadence: "per_instance",
      year: 2026,
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function seedProjectBudget(
  s: ChapterSetup,
  projectId: Id<"projects">,
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 50000,
      type: "one_time",
      refKind: "project",
      scopeRefId: projectId,
      cadence: "per_instance",
      year: 2026,
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
  opts: {
    chapterId?: Id<"chapters"> | "central";
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
  } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: opts.chapterId ?? s.chapterId,
      budgetId,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
      status: opts.status ?? "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

describe("finance: event-lead scoped note/receipt/category access", () => {
  test("the event's OWNER (a plain member, no finance role) CAN note a transaction on their own event's budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId);

    await owner.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Sound tech deposit",
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.note).toBe("Sound tech deposit");
  });

  test("the event's OWNER can attachReceipt on their own event's budget's transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId);
    const storageId = await storeBlob(t);

    await owner.as.mutation(api.finances.attachReceipt, {
      transactionId: txnId,
      storageId,
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.receiptStorageId).toBe(storageId);
  });

  test("the event's OWNER can setTransactionCategory on their own event's budget's transaction, and it advances unreviewed -> categorized", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId, { status: "unreviewed" });
    const fundId = await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const categoryId = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId,
        name: "Production",
        kind: "lineItem",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    await owner.as.mutation(api.finances.setTransactionCategory, {
      transactionId: txnId,
      categoryId,
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.categoryId).toBe(categoryId);
    expect(txn?.status).toBe("categorized");
  });

  test("a manager UP the reporting chain from the event owner can also note the transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const boss = await addMember(s, {
      email: "boss@publicworship.life",
      name: "Boss",
    });
    // Repoint owner's managerId to boss (addMember inserted owner first without
    // a manager, so patch it here rather than threading a forward reference).
    await run(s.t, (ctx) => ctx.db.patch(owner.personId, { managerId: boss.personId }));
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId);

    await boss.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Boss annotating on behalf of their report's event",
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.note).toBe("Boss annotating on behalf of their report's event");
  });

  test("a chapter ADMIN can note any event's transaction, owner or not", async () => {
    const t = newT();
    const s = await setupChapter(t); // s.as is a chapter admin by default
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId);

    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Admin annotating",
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.note).toBe("Admin annotating");
  });

  test("a plain member who is NEITHER the owner NOR manages the owner is REJECTED", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const stranger = await addMember(s, {
      email: "stranger@publicworship.life",
      name: "Stranger",
    });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId);

    await expect(
      stranger.as.mutation(api.finances.setTransactionNote, {
        transactionId: txnId,
        note: "Should be blocked",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("the event owner CANNOT touch a transaction belonging to a DIFFERENT event", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const myEventId = await seedEvent(s, { ownerPersonId: owner.personId, name: "My Event" });
    const otherOwner = await addMember(s, {
      email: "other@publicworship.life",
      name: "Other Owner",
    });
    const otherEventId = await seedEvent(s, {
      ownerPersonId: otherOwner.personId,
      name: "Other Event",
    });
    const otherBudgetId = await seedEventBudget(s, otherEventId);
    const otherTxnId = await seedTxn(s, otherBudgetId);
    // myEventId exists but is unused here beyond establishing `owner` really
    // does own SOME event — the point is they still can't touch `otherTxnId`.
    void myEventId;

    await expect(
      owner.as.mutation(api.finances.setTransactionNote, {
        transactionId: otherTxnId,
        note: "Should be blocked — not my event",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("an event owner is REJECTED on a PROJECT-budget transaction (no event to scope the carve-out to)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    await seedEvent(s, { ownerPersonId: owner.personId }); // owns SOME event, irrelevant here
    const projectId = await seedProject(s, "Music Recording");
    const projectBudgetId = await seedProjectBudget(s, projectId);
    const txnId = await seedTxn(s, projectBudgetId);

    await expect(
      owner.as.mutation(api.finances.setTransactionNote, {
        transactionId: txnId,
        note: "Should be blocked",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("REATTRIBUTION stays bookkeeper+-only: the event owner CANNOT categorizeTransaction (budgetId) even on their own event's txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId);

    await expect(
      owner.as.mutation(api.finances.categorizeTransaction, {
        transactionId: txnId,
        budgetId: null, // even just clearing the attribution
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("STATUS stays bookkeeper+-only: the event owner CANNOT setTransactionStatus on their own event's txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId);

    await expect(
      owner.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a bookkeeper's EXISTING power is unchanged: they can note ANY event's transaction, owner or not", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const bookkeeper = await addMember(s, {
      email: "bookkeeper@publicworship.life",
      name: "Bookkeeper",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: bookkeeper.personId,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId);

    await bookkeeper.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Bookkeeper annotating — unrelated to event ownership",
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.note).toBe("Bookkeeper annotating — unrelated to event ownership");
  });

  test("the event owner can attachReceipt even once the budget has moved to CENTRAL (event's own chapter never changes)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId, { chapterId: "central" });
    const txnId = await seedTxn(s, budgetId, { chapterId: "central" });
    const storageId = await storeBlob(t);

    await owner.as.mutation(api.finances.attachReceipt, {
      transactionId: txnId,
      storageId,
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.receiptStorageId).toBe(storageId);
  });

  // ── Opus review follow-ups (PR #218) ──────────────────────────────────────

  test("defensive guard: eventForTxn returns null (no event-lead carve-out) for a budget whose refKind is 'event' but type ISN'T one_time", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    // Malformed on purpose (bypasses every real creation path's invariant) —
    // pins the new `type === "one_time"` belt-and-suspenders check.
    const budgetId = await seedEventBudget(s, eventId, { type: "recurring" });
    const txnId = await seedTxn(s, budgetId);

    await expect(
      owner.as.mutation(api.finances.setTransactionNote, {
        transactionId: txnId,
        note: "Should be blocked — budget isn't really one_time",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("RECONCILED LOCK: the event owner CANNOT re-categorize a reconciled transaction — clear error, ask the treasurer to reopen it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId, { status: "reconciled" });
    const categoryId = await run(s.t, async (ctx) => {
      const fundId = await ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        isActive: true,
        createdAt: Date.now(),
      });
      return ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId,
        name: "Production",
        kind: "lineItem",
        isActive: true,
        createdAt: Date.now(),
      });
    });

    let caught: unknown;
    try {
      await owner.as.mutation(api.finances.setTransactionCategory, {
        transactionId: txnId,
        categoryId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("RECONCILED_LOCKED");

    // Clearing the category (null) is locked too, not just setting a new one.
    await expect(
      owner.as.mutation(api.finances.setTransactionCategory, {
        transactionId: txnId,
        categoryId: null,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.categoryId).toBeUndefined(); // untouched by either rejected attempt
  });

  test("RECONCILED LOCK does not apply to a bookkeeper+ caller — their existing power to re-categorize a reconciled txn is unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const bookkeeper = await addMember(s, {
      email: "bookkeeper@publicworship.life",
      name: "Bookkeeper",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: bookkeeper.personId,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const owner = await addMember(s, { email: "owner@publicworship.life", name: "Owner" });
    const eventId = await seedEvent(s, { ownerPersonId: owner.personId });
    const budgetId = await seedEventBudget(s, eventId);
    const txnId = await seedTxn(s, budgetId, { status: "reconciled" });
    const categoryId = await run(s.t, async (ctx) => {
      const fundId = await ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        isActive: true,
        createdAt: Date.now(),
      });
      return ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId,
        name: "Production",
        kind: "lineItem",
        isActive: true,
        createdAt: Date.now(),
      });
    });

    await bookkeeper.as.mutation(api.finances.setTransactionCategory, {
      transactionId: txnId,
      categoryId,
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.categoryId).toBe(categoryId);
    expect(txn?.status).toBe("reconciled"); // untouched — only categoryId changed
  });
});
