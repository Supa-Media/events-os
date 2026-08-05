/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * MULTI-SELECT RECONCILE FILTERS, end to end.
 *
 * `reconcileFilters.test.ts` (in `@events-os/shared`) pins the pure set logic;
 * this pins the wiring — that `listReconcile` actually applies it to real rows,
 * and that the counts it returns are the FACET counts, not the old global ones.
 *
 * The behaviour being protected: a charge is routinely unreviewed AND missing a
 * receipt AND unbudgeted at once. One mutually-exclusive bucket could only ever
 * show one of those at a time, so "show me anything that still needs
 * something" — the actual question a treasurer working a backlog asks — was
 * inexpressible.
 */

async function asManager(s: ChapterSetup): Promise<void> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Kansi",
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
}

async function txn(
  s: ChapterSetup,
  fields: Partial<{
    flow: "inflow" | "outflow" | "transfer";
    status: "unreviewed" | "categorized" | "reconciled";
    receiptStorageId: Id<"_storage">;
    amountCents: number;
  }> = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: fields.flow ?? "outflow",
      amountCents: fields.amountCents ?? 100,
      postedAt: Date.now(),
      status: fields.status ?? "unreviewed",
      receiptStorageId: fields.receiptStorageId,
      createdAt: Date.now(),
    }),
  );
}

describe("filter sets — OR within a group, AND across groups", () => {
  test("same-group filters WIDEN: 'anything that still needs something'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // Unreviewed spend (so: to_review AND missing_receipt AND needs_budget).
    const messy = await txn(s, { status: "unreviewed" });
    // Cleared, receipt attached, budget-less is irrelevant once reconciled.
    const receiptId = await run(s.t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["r"], { type: "text/plain" }),
      ),
    );
    const done = await txn(s, { status: "reconciled", receiptStorageId: receiptId });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["to_review", "missing_receipt"],
    });
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(messy);
    expect(ids).not.toContain(done);
  });

  test("cross-group filters NARROW: 'the spend that's missing receipts'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const spendNoReceipt = await txn(s, { flow: "outflow" });
    // An inflow is not spend, so it must drop out even though it also has no
    // receipt — this is the AND that a single-bucket filter couldn't express.
    const inflowNoReceipt = await txn(s, { flow: "inflow" });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["spend", "missing_receipt"],
    });
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(spendNoReceipt);
    expect(ids).not.toContain(inflowNoReceipt);
  });

  test("an empty set means no constraint", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s);
    await txn(s, { flow: "inflow" });

    const res = await s.as.query(api.finances.listReconcile, { filters: [] });
    expect(res.rows).toHaveLength(2);
  });

  test("the legacy singular `filter` still works — dashboard drill-throughs carry it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const unreviewed = await txn(s, { status: "unreviewed" });
    await txn(s, { status: "categorized" });

    const res = await s.as.query(api.finances.listReconcile, { filter: "to_review" });
    expect(res.rows.map((r) => r.id)).toEqual([unreviewed]);
  });
});

describe("facet counts — the number shown is a number you can get to", () => {
  test("another group's selection narrows a count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    await txn(s, { flow: "outflow" }); // spend, no receipt
    // A MARKED internal transfer: not spend, but it does owe a receipt
    // (`needsDocumentation` covers spend, marked transfers, and payouts — a
    // plain inflow owes nothing, which is why this fixture isn't one).
    // `preMarkFlow` is the tell `markAsTransfer` writes and `isMarkedTransfer`
    // reads.
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "transfer",
        preMarkFlow: "outflow",
        amountCents: 100,
        postedAt: Date.now(),
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    // Unfiltered, both receiptless rows count.
    const wide = await s.as.query(api.finances.listReconcile, { filters: [] });
    expect(wide.counts.missing_receipt).toBe(2);

    // With Kind=Spend active, the transfer can never be surfaced by picking
    // "Missing receipt" — so it must stop being counted under it. A global
    // count here would promise 2 rows and deliver 1.
    const narrowed = await s.as.query(api.finances.listReconcile, {
      filters: ["spend"],
    });
    expect(narrowed.counts.missing_receipt).toBe(1);
    const both = await s.as.query(api.finances.listReconcile, {
      filters: ["spend", "missing_receipt"],
    });
    expect(both.rows).toHaveLength(narrowed.counts.missing_receipt);
  });

  test("a key's OWN group's selection doesn't change its siblings' counts", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { status: "unreviewed" });
    await txn(s, { status: "categorized" });

    // Both rows are budget-less. Selecting "To review" (same group) must not
    // shrink "Needs budget", or the numbers inside one dropdown would stop
    // being comparable with each other.
    const base = await s.as.query(api.finances.listReconcile, { filters: [] });
    const withSibling = await s.as.query(api.finances.listReconcile, {
      filters: ["to_review"],
    });
    expect(withSibling.counts.needs_budget).toBe(base.counts.needs_budget);
  });

  test("`all` stays the scope total, unmoved by the selection", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s);
    await txn(s, { flow: "inflow" });

    const res = await s.as.query(api.finances.listReconcile, { filters: ["spend"] });
    expect(res.counts.all).toBe(2);
    expect(res.rows).toHaveLength(1);
  });
});

describe("toClearCount — a stable backlog headline", () => {
  test("doesn't move when filters change", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const receiptId = await run(s.t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["r"], { type: "text/plain" }),
      ),
    );
    await txn(s, { status: "unreviewed" });
    await txn(s, { status: "categorized" });
    await txn(s, { status: "reconciled", receiptStorageId: receiptId });

    // Two of three are unreconciled. That's the page's headline number, and it
    // has to hold whatever the treasurer filters to — it used to be derived as
    // `counts.all - counts.reconciled`, which now mixes a scope total with a
    // facet count and would drift.
    for (const filters of [[], ["spend"], ["to_review"], ["spend", "needs_budget"]] as const) {
      const res = await s.as.query(api.finances.listReconcile, {
        filters: [...filters],
      });
      expect(res.toClearCount).toBe(2);
    }
  });
});
