/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * SERVER-SIDE SEARCH AND PAGING for the reconcile grid.
 *
 * ## What was wrong
 *
 * Search used to be `filterReconcileRows` on the client, applied to the rows
 * `listReconcile` had ALREADY narrowed. That made "find me this transaction" a
 * function of the active State filter: with the page's default selection the
 * box searched 14 of 346 production rows, so typing a vendor that happened to
 * be budgeted returned a confident, silent nothing. Nothing on screen said the
 * filter was the reason.
 *
 * The first test below is the whole point of the change, and it is the one a
 * green suite could not previously have caught — the old behavior was in a
 * different package from the query.
 *
 * ## And paging
 *
 * `listReconcile` also returned EVERY matching row, each paying a documentation
 * resolution, a cardholder resolution and a budget-owner resolution. Fine
 * behind a filter that left 14 rows; 346 rows of dependent round-trips the
 * moment the filter came off. `limit` bounds what is enriched and shipped —
 * while the scan, and therefore every facet count, still covers the whole
 * scope. That last part is the invariant these tests defend: a facet count must
 * never quietly become "count of the current page".
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
    merchantName: string;
    merchantNameOverride: string;
    description: string;
    cardLast4: string;
    preMarkFlow: "inflow" | "outflow";
    payoutProcessor: "givebutter" | "stripe" | "other";
    receiptStorageId: Id<"_storage">;
  }> = {},
): Promise<Id<"transactions">> {
  // Descending `postedAt` is the grid's order, so a strictly decreasing clock
  // makes insertion order equal page order and the paging assertions readable.
  clock -= 1000;
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: fields.flow ?? "outflow",
      amountCents: fields.amountCents ?? 100,
      postedAt: clock,
      status: fields.status ?? "unreviewed",
      merchantName: fields.merchantName,
      merchantNameOverride: fields.merchantNameOverride,
      description: fields.description,
      cardLast4: fields.cardLast4,
      preMarkFlow: fields.preMarkFlow,
      payoutProcessor: fields.payoutProcessor,
      receiptStorageId: fields.receiptStorageId,
      createdAt: Date.now(),
    }),
  );
}

describe("search reaches rows the active State filter excludes", () => {
  test("THE BUG: a State filter no longer decides what search can find", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // A row the active filter excludes: closed, documented, done with. In
    // production this is the shape that made "type Olive Garden, get nothing"
    // — the default `needs_budget` selection left 14 of 346 rows searchable and
    // Olive Garden was not one of them. `to_review` is used here because
    // `needsBudget` is deliberately status-blind (it feeds the dashboards'
    // unbudgeted-spend tiles), so even a reconciled row can sit inside it.
    const receiptId = await run(s.t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["r"], { type: "text/plain" }),
      ),
    );
    const closed = await txn(s, {
      merchantName: "OLIVE GARDEN 4412",
      status: "reconciled",
      receiptStorageId: receiptId,
    });
    // An unrelated row that IS in the filter, to prove search still NARROWS
    // rather than simply abandoning every constraint.
    await txn(s, { merchantName: "MTA*NYCT PAYGO", status: "unreviewed" });

    // Filtered to a state the target row is not in…
    const filteredOnly = await s.as.query(api.finances.listReconcile, {
      filters: ["to_review"],
    });
    expect(filteredOnly.rows.map((r) => r.id)).not.toContain(closed);

    // …searching finds it anyway.
    const searched = await s.as.query(api.finances.listReconcile, {
      filters: ["to_review"],
      search: "olive garden",
    });
    expect(searched.rows.map((r) => r.id)).toEqual([closed]);
    expect(searched.matchedCount).toBe(1);
    // And the response SAYS the State filter stood down, so the grid can too.
    expect(searched.searchIgnoredState).toBe(true);
  });

  test("a search un-hides the hidden transfer legs", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // An unmarked internal transfer leg: hidden from the default queue because
    // it owes no coding, no receipt and no close. That is an argument about
    // browsing, not a reason to make a $1,000 movement unfindable by name.
    const leg = await txn(s, { flow: "transfer", merchantName: "PUBLIC WORSHIP TRANSFER" });

    const browsing = await s.as.query(api.finances.listReconcile, {});
    expect(browsing.rows.map((r) => r.id)).not.toContain(leg);

    const searched = await s.as.query(api.finances.listReconcile, {
      search: "public worship",
    });
    expect(searched.rows.map((r) => r.id)).toEqual([leg]);
  });

  test("Kind is still honoured while searching — only State stands down", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const payout = await txn(s, {
      flow: "inflow",
      payoutProcessor: "givebutter",
      merchantName: "GIVEBUTTER PAYOUT",
    });
    await txn(s, { flow: "outflow", merchantName: "GIVEBUTTER FEE" });

    // "Givebutter, among the payouts" is a coherent sentence and stays honoured.
    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["payouts"],
      search: "givebutter",
    });
    expect(res.rows.map((r) => r.id)).toEqual([payout]);
    // No State filter was active, so nothing was stood down.
    expect(res.searchIgnoredState).toBe(false);
  });

  test("searchIgnoredState is false when there is no search", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { merchantName: "MTA" });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_budget"],
    });
    expect(res.searchIgnoredState).toBe(false);
  });

  test("search matches the cardholder's name, resolved server-side", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const holder = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Adeola Bankole",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    clock -= 1000;
    const hers = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 2500,
        postedAt: clock,
        status: "unreviewed",
        merchantName: "CORNER DELI",
        personId: holder,
        createdAt: Date.now(),
      }),
    );
    await txn(s, { merchantName: "CORNER DELI" });

    const res = await s.as.query(api.finances.listReconcile, { search: "adeola" });
    expect(res.rows.map((r) => r.id)).toEqual([hers]);
  });
});

describe("paging bounds the payload without touching the counts", () => {
  test("limit caps the rows; matchedCount and hasMore describe the whole scope", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    for (let i = 0; i < 12; i++) await txn(s, { merchantName: `VENDOR ${i}` });

    const firstPage = await s.as.query(api.finances.listReconcile, { limit: 5 });
    expect(firstPage.rows).toHaveLength(5);
    expect(firstPage.matchedCount).toBe(12);
    expect(firstPage.hasMore).toBe(true);

    // "Load more" grows the limit rather than stitching snapshots together.
    const grown = await s.as.query(api.finances.listReconcile, { limit: 10 });
    expect(grown.rows).toHaveLength(10);
    // The page is a PREFIX of the same ordering, so nothing shifts underneath.
    expect(grown.rows.slice(0, 5).map((r) => r.id)).toEqual(
      firstPage.rows.map((r) => r.id),
    );

    const all = await s.as.query(api.finances.listReconcile, { limit: 50 });
    expect(all.rows).toHaveLength(12);
    expect(all.hasMore).toBe(false);
    expect(all.matchedCount).toBe(12);
  });

  test("FACET COUNTS ARE NOT PAGE COUNTS — they still cover the whole scope", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    for (let i = 0; i < 12; i++) await txn(s, { merchantName: `VENDOR ${i}` });

    const paged = await s.as.query(api.finances.listReconcile, { limit: 3 });
    const unpaged = await s.as.query(api.finances.listReconcile, { limit: 100 });

    expect(paged.rows).toHaveLength(3);
    // Every count is identical across a tiny page and a whole one. If paging
    // ever leaks into the counting loop, this is what breaks.
    expect(paged.counts).toEqual(unpaged.counts);
    expect(paged.toClearCount).toBe(unpaged.toClearCount);
    expect(paged.chaseCount).toBe(unpaged.chaseCount);
    expect(paged.counts.all).toBe(12);
  });

  test("a search does not narrow the facet counts — they describe the book", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { merchantName: "OLIVE GARDEN" });
    for (let i = 0; i < 5; i++) await txn(s, { merchantName: `VENDOR ${i}` });

    const browsing = await s.as.query(api.finances.listReconcile, {});
    const searched = await s.as.query(api.finances.listReconcile, {
      search: "olive",
    });

    expect(searched.rows).toHaveLength(1);
    expect(searched.matchedCount).toBe(1);
    // The dropdown still describes the whole book, not the one matched row.
    expect(searched.counts).toEqual(browsing.counts);
    expect(searched.toClearCount).toBe(browsing.toClearCount);
  });

  test("limit is clamped, so a caller can't ask for the old unbounded behavior", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    for (let i = 0; i < 4; i++) await txn(s, { merchantName: `VENDOR ${i}` });

    // Absurd values are coerced into range rather than throwing — a stale
    // client should land on a usable screen.
    const huge = await s.as.query(api.finances.listReconcile, { limit: 10_000 });
    expect(huge.rows).toHaveLength(4);

    const zero = await s.as.query(api.finances.listReconcile, { limit: 0 });
    expect(zero.rows).toHaveLength(1);
    expect(zero.matchedCount).toBe(4);
    expect(zero.hasMore).toBe(true);
  });

  test("omitting limit keeps a sane default page", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    for (let i = 0; i < 4; i++) await txn(s, { merchantName: `VENDOR ${i}` });

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.rows).toHaveLength(4);
    expect(res.hasMore).toBe(false);
  });
});
