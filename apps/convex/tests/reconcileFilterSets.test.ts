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
    /** The tell `markAsTransfer` writes — what makes a leg MARKED, not booked. */
    preMarkFlow: "inflow" | "outflow";
    /** The tell `markAsPayout` writes. */
    payoutProcessor: "givebutter" | "stripe" | "other";
    transferGroupId: string;
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
      preMarkFlow: fields.preMarkFlow,
      payoutProcessor: fields.payoutProcessor,
      transferGroupId: fields.transferGroupId,
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

/**
 * INTERNAL TRANSFERS ARE NOT QUEUE WORK.
 *
 * Reconcile asks three things of a row: code it, document it, close it. A leg
 * the app booked itself (`transfers.recordTransfer` and friends) owes none of
 * them — it's one half of a matched pair with a note explaining the
 * arithmetic, it takes no category or budget, and it owes no receipt. It was
 * therefore volume the treasurer could only skip past. It's hidden by default
 * and reachable under Kind → Transfers.
 *
 * The line is `isMarkedTransfer`, NOT `flow === "transfer"`: a leg a human
 * MARKED still owes a receipt on purpose (`needsDocumentation`), so hiding it
 * would silently end a live chase.
 */
describe("internal transfer legs are hidden from the default queue", () => {
  test("a booked leg is out of the rows, the total, and the backlog headline", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const spend = await txn(s, { flow: "outflow" });
    const leg = await txn(s, { flow: "transfer", transferGroupId: "grp_1" });

    const res = await s.as.query(api.finances.listReconcile, { filters: [] });
    expect(res.rows.map((r) => r.id)).toEqual([spend]);
    // The header's total has to be a number scrolling can reach.
    expect(res.counts.all).toBe(1);
    // Both rows are unreviewed, but only one of them is work.
    expect(res.toClearCount).toBe(1);
    expect(res.counts.to_review).toBe(1);
    // Suppressed, not lost — see the next test.
    expect(res.counts.transfers).toBe(1);
    expect(leg).toBeDefined();
  });

  test("Kind → Transfers is the way back, and its count says how many", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    await txn(s, { flow: "outflow" });
    const legOut = await txn(s, { flow: "transfer", transferGroupId: "grp_1" });
    const legIn = await txn(s, { flow: "transfer", transferGroupId: "grp_1" });

    // The facet count is computed over the hidden rows, so the dropdown can
    // advertise what selecting it would produce.
    const hidden = await s.as.query(api.finances.listReconcile, { filters: [] });
    expect(hidden.counts.transfers).toBe(2);

    const shown = await s.as.query(api.finances.listReconcile, {
      filters: ["transfers"],
    });
    expect(shown.rows.map((r) => r.id).sort()).toEqual([legOut, legIn].sort());
    expect(shown.rows).toHaveLength(hidden.counts.transfers);
  });

  test("a MARKED transfer stays — it still owes a receipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const marked = await txn(s, { flow: "transfer", preMarkFlow: "outflow" });
    await txn(s, { flow: "transfer", transferGroupId: "grp_1" });

    const res = await s.as.query(api.finances.listReconcile, { filters: [] });
    expect(res.rows.map((r) => r.id)).toEqual([marked]);
    expect(res.counts.missing_receipt).toBe(1);
    // Kind → Transfers covers BOTH classes — that's what makes it the single
    // way back to the hidden ones.
    expect(res.counts.transfers).toBe(2);
  });

  test("a payout deposit stays — outside money arriving earns one look", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // Deliberately still `flow:"inflow"` — `markAsPayout` never rewrites a
    // deposit to a transfer, because that would erase the org's revenue.
    const payout = await txn(s, { flow: "inflow", payoutProcessor: "givebutter" });
    await txn(s, { flow: "transfer", transferGroupId: "grp_1" });

    const res = await s.as.query(api.finances.listReconcile, { filters: [] });
    expect(res.rows.map((r) => r.id)).toEqual([payout]);
    expect(res.counts.payouts).toBe(1);
  });

  test("hidden legs never leak into another facet's count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    await txn(s, { flow: "transfer", status: "unreviewed", transferGroupId: "g1" });
    await txn(s, { flow: "transfer", status: "reconciled", transferGroupId: "g2" });

    // A count you can't get to is the defect this whole area exists to
    // prevent: "To review 1" beside a queue that will render zero rows.
    const res = await s.as.query(api.finances.listReconcile, { filters: [] });
    expect(res.rows).toHaveLength(0);
    expect(res.counts.to_review).toBe(0);
    expect(res.counts.reconciled).toBe(0);
    expect(res.counts.missing_receipt).toBe(0);
    expect(res.counts.all).toBe(0);
    expect(res.toClearCount).toBe(0);
    expect(res.counts.transfers).toBe(2);
  });

  test("another group's selection still narrows the transfers count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { flow: "transfer", transferGroupId: "g1" });

    // A transfer leg is never `needs_budget`, so asking for both is a real
    // empty set — and the count has to say so rather than promising a row.
    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_budget"],
    });
    expect(res.counts.transfers).toBe(0);
    const both = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_budget", "transfers"],
    });
    expect(both.rows).toHaveLength(0);
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
