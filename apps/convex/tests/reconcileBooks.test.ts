/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * THE CENTRAL/CHAPTER SPLIT IN RECONCILE — books, and the dashboard numbers
 * that route into them.
 *
 * Founder report (2026-08): "it will say to review 80 or 84, but when you click
 * it, it takes you to reconcile and 80 or 84 is nowhere to be found." Three
 * independent causes, each of which this file pins down so it can't come back:
 *
 *  1. WRONG PREDICATE. The dashboards' "To review" tile counts
 *     `status === "unreviewed"`. Reconcile HAD that pill — under the name
 *     "Uncategorized" (a word that in this codebase already means "no
 *     `categoryId`", `dashboardCharts.budgetTransactions`' own sentinel) — but
 *     the tile linked to `needs_budget`, an unrelated bucket. Renamed to
 *     `to_review`, and the parity tests below assert tile === pill.
 *
 *  2. WRONG BOOKS. The org tile sums EVERY book (each chapter + central); the
 *     old link opened `scope: "central"`, a strict subset that could never add
 *     up to it. `scope: "all"` — the merged queue — is the view whose rows
 *     actually sum to that number, and `toReviewByBook` gives each part of the
 *     total its own destination.
 *
 *  3. SANDBOX DRIFT. `listReconcile` filters rows through `txnMatchesMode`;
 *     none of the four "unreviewed" scans behind the tiles did. In a
 *     deployment holding both sandbox and production rows the tile over-counted
 *     by exactly the off-mode rows — a figure that is real, and genuinely
 *     absent from the grid, with no misrouting involved at all.
 *
 * Also covers the write boundary the merged queue introduces: `book.canEdit`
 * must mirror `requireReconcileTxn` exactly, or the grid offers inline edits
 * the server rejects.
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Kansi",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

/**
 * The founder's actual configuration: one human holding BOTH the central
 * Financial Manager grant and the chapter Treasurer grant. Every "which books"
 * question in this file is only interesting because these are the same person.
 */
async function asDualHatManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await grantRole(s, personId, "manager", "chapter");
  await grantRole(s, personId, "manager", "central");
  return personId;
}

/** A chapter-only Treasurer — no central reach at all. */
async function asChapterOnlyManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await grantRole(s, personId, "manager", "chapter");
  return personId;
}

/** Insert a transaction into a specific BOOK (a chapter id, or `"central"`). */
async function insertTxnInBook(
  s: ChapterSetup,
  book: Id<"chapters"> | "central",
  fields: Partial<{
    status: "unreviewed" | "categorized" | "reconciled" | "excluded";
    amountCents: number;
    // `txnMatchesMode` only gates Increase-sourced rows (`increase_card` /
    // `increase_ach`) — a `manual` row is environment-NEUTRAL and always kept.
    // So an environment fixture has to be a real card row, not a manual one.
    source: "manual" | "increase_card";
    externalId: string;
  }> = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: book,
      source: fields.source ?? "manual",
      flow: "outflow",
      amountCents: fields.amountCents ?? 100,
      postedAt: Date.now(),
      status: fields.status ?? "unreviewed",
      externalId: fields.externalId,
      createdAt: Date.now(),
    }),
  );
}

/** A second real chapter, for the "another Treasurer owns those rows" cases. */
async function insertOtherChapter(s: ChapterSetup): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", {
      name: "Chicago",
      slug: "chicago",
      createdAt: Date.now(),
    }),
  );
}

describe("reconcile books — the central/chapter split", () => {
  test("scope 'all' merges every book, and each row says which book it's in", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);

    const chapterTxn = await insertTxnInBook(s, s.chapterId);
    const centralTxn = await insertTxnInBook(s, "central");

    const merged = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "all",
    });

    expect(merged.rows.map((r) => r.id).sort()).toEqual([chapterTxn, centralTxn].sort());
    const bookOf = (id: Id<"transactions">) =>
      merged.rows.find((r) => r.id === id)?.book;
    expect(bookOf(centralTxn)).toMatchObject({ id: "central", name: "Central" });
    expect(bookOf(chapterTxn)).toMatchObject({ id: s.chapterId, canEdit: true });
  });

  test("a single-book scope still labels its rows (a screenshot is unambiguous alone)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    await insertTxnInBook(s, "central");

    const central = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "central",
    });
    expect(central.rows).toHaveLength(1);
    expect(central.rows[0].book.name).toBe("Central");
  });

  test("scope 'all' needs central reach — a chapter-only Treasurer is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterOnlyManager(s);
    await insertTxnInBook(s, s.chapterId);

    // Their OWN book still reads fine — only the merged queue is gated.
    const own = await s.as.query(api.finances.listReconcile, { filter: "all" });
    expect(own.rows).toHaveLength(1);

    await expect(
      s.as.query(api.finances.listReconcile, { filter: "all", scope: "all" }),
    ).rejects.toThrow(ConvexError);
  });

  test("canEdit mirrors requireReconcileTxn: own chapter + central yes, another chapter no", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const otherChapterId = await insertOtherChapter(s);

    const mine = await insertTxnInBook(s, s.chapterId);
    const central = await insertTxnInBook(s, "central");
    const theirs = await insertTxnInBook(s, otherChapterId);

    const merged = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "all",
    });
    const canEdit = (id: Id<"transactions">) =>
      merged.rows.find((r) => r.id === id)?.book.canEdit;

    expect(canEdit(mine)).toBe(true);
    expect(canEdit(central)).toBe(true);
    // Visible for audit, not editable — Chicago's Treasurer owns that row.
    expect(canEdit(theirs)).toBe(false);

    // …and `canEdit: false` is not a UI opinion: the write really is refused,
    // which is the whole reason the grid renders those rows read-only.
    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: theirs,
        status: "reconciled",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("merged counts equal the sum of the per-book counts", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);

    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, s.chapterId, { status: "reconciled" });
    await insertTxnInBook(s, "central", { status: "unreviewed" });

    const chapter = await s.as.query(api.finances.listReconcile, { filter: "all" });
    const central = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "central",
    });
    const merged = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "all",
    });

    expect(merged.counts.all).toBe(chapter.counts.all + central.counts.all);
    expect(merged.counts.to_review).toBe(
      chapter.counts.to_review + central.counts.to_review,
    );
    expect(merged.counts.to_review).toBe(3);
    expect(merged.counts.reconciled).toBe(1);
  });
});

describe("no-dead-numbers — every 'to review' figure lands on its own rows", () => {
  test("the chapter dashboard's tile equals Reconcile's to_review pill, exactly", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);

    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    // Neither of these is "to review": one is coded, one is closed.
    await insertTxnInBook(s, s.chapterId, { status: "categorized" });
    await insertTxnInBook(s, s.chapterId, { status: "reconciled" });
    // Central's own rows must NOT leak into a CHAPTER tile — separate books.
    await insertTxnInBook(s, "central", { status: "unreviewed" });

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const tile = dash.tiles.find((x) => x.label === "To review");
    expect(tile).toBeDefined();

    const grid = await s.as.query(api.finances.listReconcile, { filter: "to_review" });

    // The regression in one line: the tile's number, the pill's count, and the
    // rows actually returned are all the same thing.
    expect(tile?.value).toBe("2");
    expect(grid.counts.to_review).toBe(2);
    expect(grid.rows).toHaveLength(2);
    expect(String(grid.counts.to_review)).toBe(tile?.value);
  });

  test("the org tile equals its per-book breakdown, and the breakdown equals the merged queue", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);

    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, "central", { status: "unreviewed" });

    const central = await s.as.query(api.finances.dashboardCentral, {});
    const tile = central.tiles.find((x) => x.label === "To review · org");
    expect(tile?.value).toBe("3");

    // Σ breakdown === headline. Both are accumulated from the same per-book
    // scans in one pass, so this can only break deliberately.
    const sum = central.toReviewByBook.reduce((n, b) => n + b.count, 0);
    expect(String(sum)).toBe(tile?.value);

    // Central leads the breakdown (matching the fleet table's row order).
    expect(central.toReviewByBook[0]).toMatchObject({ id: "central", count: 1 });
    expect(central.toReviewByBook).toContainEqual(
      expect.objectContaining({ id: s.chapterId, count: 2 }),
    );

    // And the headline's own destination — the merged queue — really does hold
    // exactly that many rows. This is the assertion the founder's tap failed.
    const merged = await s.as.query(api.finances.listReconcile, {
      filter: "to_review",
      scope: "all",
    });
    expect(merged.rows).toHaveLength(3);
    expect(String(merged.counts.to_review)).toBe(tile?.value);
  });

  test("each breakdown chip's count equals that book's own queue", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);

    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, "central", { status: "unreviewed" });

    const central = await s.as.query(api.finances.dashboardCentral, {});
    for (const book of central.toReviewByBook) {
      const queue =
        book.id === "central"
          ? await s.as.query(api.finances.listReconcile, {
              filter: "to_review",
              scope: "central",
            })
          : await s.as.query(api.finances.listReconcile, {
              filter: "to_review",
              chapterId: book.id as Id<"chapters">,
            });
      expect(queue.counts.to_review).toBe(book.count);
    }
  });

  test("the fleet table's per-chapter Review chip matches the same books", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);

    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, "central", { status: "unreviewed" });

    const fleet = await s.as.query(api.dashboardCharts.chapterHealth, {});
    const central = await s.as.query(api.finances.dashboardCentral, {});

    // Three surfaces, one population: the fleet row, the dashboard breakdown,
    // and the Reconcile queue behind them.
    for (const book of central.toReviewByBook) {
      const fleetRow = fleet.find((r) => r.chapterId === book.id);
      expect(fleetRow?.toReviewCount).toBe(book.count);
    }
  });
});

describe("sandbox parity — a tile never counts rows the grid won't show", () => {
  test("an off-mode transaction is excluded from the tile, the fleet row, and the grid alike", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);

    // Production mode is the default (no `financeSettings` sandbox flag set).
    // A production card charge — kept.
    await insertTxnInBook(s, s.chapterId, {
      status: "unreviewed",
      source: "increase_card",
      externalId: "transaction_prod123",
    });
    // The same shape from the SANDBOX environment — `txnMatchesMode` reads the
    // environment off the `sandbox_` id prefix, exactly as every other finance
    // surface does. This is the row the tiles used to count and the grid never
    // showed.
    await insertTxnInBook(s, s.chapterId, {
      status: "unreviewed",
      source: "increase_card",
      externalId: "sandbox_transaction_abc123",
    });

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const tile = dash.tiles.find((x) => x.label === "To review");
    const grid = await s.as.query(api.finances.listReconcile, { filter: "to_review" });
    const fleet = await s.as.query(api.dashboardCharts.chapterHealth, {});
    const fleetRow = fleet.find((r) => r.chapterId === s.chapterId);

    // Before the fix the tile said 2 and the grid showed 1 — a number that was
    // real, and genuinely nowhere to be found on the screen it opened.
    expect(tile?.value).toBe("1");
    expect(grid.counts.to_review).toBe(1);
    expect(grid.rows).toHaveLength(1);
    expect(fleetRow?.toReviewCount).toBe(1);
  });
});

describe("filter vocabulary", () => {
  test("to_review is a status bucket, not a category one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterOnlyManager(s);

    // The old name ("Uncategorized") implied this row would be excluded once it
    // had a category. It isn't — the bucket is about STATUS, and this row has
    // no category either way. Pinning the real predicate so the name can't
    // drift back toward describing something it never did.
    const unreviewed = await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, s.chapterId, { status: "categorized" });

    const grid = await s.as.query(api.finances.listReconcile, { filter: "to_review" });
    expect(grid.rows.map((r) => r.id)).toEqual([unreviewed]);
  });

  test("reconciled counts CLEARED rows — the complement of the header's 'N to clear'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterOnlyManager(s);

    await insertTxnInBook(s, s.chapterId, { status: "unreviewed" });
    await insertTxnInBook(s, s.chapterId, { status: "categorized" });
    const done = await insertTxnInBook(s, s.chapterId, { status: "reconciled" });

    const grid = await s.as.query(api.finances.listReconcile, { filter: "reconciled" });
    expect(grid.rows.map((r) => r.id)).toEqual([done]);
    // The header renders `all - reconciled`; the two unfinished rows are it.
    expect(grid.counts.all - grid.counts.reconciled).toBe(2);
  });
});
