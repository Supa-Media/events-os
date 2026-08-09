/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import { isUndocumented, needsBudget } from "../finances";
import type { Id } from "../_generated/dataModel";

/**
 * THE RECONCILE STATES — the facet gates, and the two header roll-ups.
 *
 * Everything here is a QUEUE-POPULATION change. The predicates
 * (`needsBudget`, `needsDocumentation`, `isUndocumented`) are untouched and are
 * asserted below to still mean what they always meant, because they feed the
 * dashboards' dollar tiles, the receipt chase and the publishing gate — and
 * because `needsDocumentation` encodes a founder rule (a marked transfer and a
 * marked payout still owe a receipt, so marking a row can never be a way to
 * stop being chased) that must survive any tidy-up of the menu above it.
 *
 * What moved:
 *   - `needs_budget`'s FACET counts open rows only. 4 of the 14 rows the old
 *     facet showed in production were already `reconciled`, and a closed row is
 *     not queue work.
 *   - `undocumented`'s FACET is the CLOSED tail — "Closed without
 *     documentation". It used to ignore status, making it a strict superset of
 *     `missing_receipt` (production: overlap 42, only-undocumented 3,
 *     only-missing-receipt 0): two menu entries with near-identical names and
 *     near-identical numbers.
 *   - `needs_attention` / `ready_to_close` are new roll-ups over the OPEN set,
 *     defined as complements so they always sum to `toClearCount`.
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

let clock = 1_700_000_000_000;

async function txn(
  s: ChapterSetup,
  fields: Partial<{
    flow: "inflow" | "outflow" | "transfer";
    status: "unreviewed" | "categorized" | "reconciled";
    amountCents: number;
    budgetId: Id<"budgets">;
    receiptStorageId: Id<"_storage">;
    externalId: string;
  }> = {},
): Promise<Id<"transactions">> {
  clock -= 1000;
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: fields.flow ?? "outflow",
      amountCents: fields.amountCents ?? 100,
      postedAt: clock,
      status: fields.status ?? "unreviewed",
      budgetId: fields.budgetId,
      receiptStorageId: fields.receiptStorageId,
      externalId: fields.externalId,
      createdAt: Date.now(),
    }),
  );
}

async function storeReceipt(s: ChapterSetup): Promise<Id<"_storage">> {
  return await run(s.t, (ctx) =>
    (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
      new Blob(["r"], { type: "text/plain" }),
    ),
  );
}

describe("needs_budget facet — open rows only", () => {
  test("a reconciled, budget-less spend row leaves the facet but stays in the predicate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const open = await txn(s, { status: "unreviewed" });
    const closed = await txn(s, { status: "reconciled" });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_budget"],
    });
    expect(res.counts.needs_budget).toBe(1);
    expect(res.rows.map((r) => r.id)).toEqual([open]);

    // THE PREDICATE IS UNCHANGED — the dashboards' unbudgeted-spend dollar
    // tiles still see the closed row, because unattributed money is
    // unattributed whether or not somebody closed the row. Only the QUEUE
    // stopped listing it.
    const closedDoc = await run(s.t, (ctx) => ctx.db.get(closed));
    expect(needsBudget(closedDoc!)).toBe(true);
  });
});

describe("undocumented facet — the closed tail, disjoint from the chase", () => {
  test("an OPEN receiptless row is Needs documentation, and only that", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { status: "unreviewed" });

    const res = await s.as.query(api.finances.listReconcile, { filter: "all" });
    expect(res.counts.missing_receipt).toBe(1);
    expect(res.counts.undocumented).toBe(0);
  });

  test("a CLOSED receiptless row is Closed without documentation, and only that", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const closed = await txn(s, { status: "reconciled" });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["undocumented"],
    });
    // The chase has nobody to nudge here — a treasurer already made the call.
    expect(res.counts.missing_receipt).toBe(0);
    expect(res.counts.undocumented).toBe(1);
    expect(res.rows.map((r) => r.id)).toEqual([closed]);

    // THE PREDICATE IS UNCHANGED: `isUndocumented` is the publishing gate and
    // still ignores status.
    const doc = await run(s.t, (ctx) => ctx.db.get(closed));
    expect(isUndocumented(doc!)).toBe(true);
  });

  test("THE POINT: the two facets never count the same row twice", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { status: "unreviewed" }); // open, bare
    await txn(s, { status: "reconciled" }); // closed, bare
    await txn(s, { status: "reconciled", receiptStorageId: await storeReceipt(s) });

    const res = await s.as.query(api.finances.listReconcile, { filter: "all" });
    // One each — where the old superset would have read 1 and 2, showing the
    // same row under both names.
    expect(res.counts.missing_receipt).toBe(1);
    expect(res.counts.undocumented).toBe(1);
    // And selecting BOTH gives the publishing backlog, which is what the union
    // always meant. Same group, so the selection widens.
    const both = await s.as.query(api.finances.listReconcile, {
      filters: ["missing_receipt", "undocumented"],
    });
    expect(both.rows).toHaveLength(2);
  });
});

describe("the header roll-ups", () => {
  test("needs_attention + ready_to_close === toClearCount, always", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const receipt = await storeReceipt(s);
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100_000,
        label: "Ops",
        type: "recurring",
        cadence: "yearly",
        year: new Date(clock).getUTCFullYear(),
        approvalStatus: "approved",
        createdAt: Date.now(),
      }),
    );

    // Open with something outstanding (unreviewed, no budget, no receipt).
    await txn(s, { status: "unreviewed" });
    // Open with NOTHING outstanding — categorised, budgeted, documented, just
    // never closed. This is the pile that was 76 rows in production and that no
    // filter could find.
    const readyRow = await txn(s, {
      status: "categorized",
      budgetId,
      receiptStorageId: receipt,
    });
    // Closed.
    await txn(s, { status: "reconciled", budgetId, receiptStorageId: receipt });

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.counts.needs_attention).toBe(1);
    expect(res.counts.ready_to_close).toBe(1);
    expect(res.toClearCount).toBe(2);
    expect(res.counts.needs_attention + res.counts.ready_to_close).toBe(
      res.toClearCount,
    );

    // And the chip is a real filter — the number is one you can get to.
    const ready = await s.as.query(api.finances.listReconcile, {
      filters: ["ready_to_close"],
    });
    expect(ready.rows.map((r) => r.id)).toEqual([readyRow]);
  });

  test("a reconciled row is in neither roll-up", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { status: "reconciled", receiptStorageId: await storeReceipt(s) });

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.counts.needs_attention).toBe(0);
    expect(res.counts.ready_to_close).toBe(0);
    expect(res.toClearCount).toBe(0);
    expect(res.counts.reconciled).toBe(1);
  });
});

describe("the fee-budget banner", () => {
  test("renders nothing when no draft fee budget is waiting", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { status: "unreviewed" });

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.feeBudgetPrompt).toBeNull();
  });

  test("names the one approval the fee rows are blocked on", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = new Date(clock).getUTCFullYear();
    await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100_000,
        label: `Processor fees ${year}`,
        type: "recurring",
        cadence: "yearly",
        year,
        approvalStatus: "draft",
        createdAt: Date.now(),
      }),
    );
    await txn(s, { externalId: "stripe-fees:2026-01", amountCents: 15_000 });
    await txn(s, { externalId: "stripe-fees:2026-02", amountCents: 16_869 });
    // An ordinary unbudgeted row is NOT part of the prompt — the banner is
    // about the machine-generated rows one click clears, not the queue at large.
    await txn(s, { amountCents: 8_560 });

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.feeBudgetPrompt).not.toBeNull();
    expect(res.feeBudgetPrompt?.label).toBe(`Processor fees ${year}`);
    expect(res.feeBudgetPrompt?.blockedRows).toBe(2);
    expect(res.feeBudgetPrompt?.blockedCents).toBe(31_869);
  });

  test("stays silent once the budget is approved", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = new Date(clock).getUTCFullYear();
    await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100_000,
        label: `Processor fees ${year}`,
        type: "recurring",
        cadence: "yearly",
        year,
        approvalStatus: "approved",
        createdAt: Date.now(),
      }),
    );
    await txn(s, { externalId: "stripe-fees:2026-03", amountCents: 15_000 });

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.feeBudgetPrompt).toBeNull();
  });
});
