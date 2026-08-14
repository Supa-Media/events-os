/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * THE RECONCILE GRID AS ONE SURFACE — sort, "needs explaining", grouping, and
 * a progress figure that works over any filter.
 *
 * Three screens were doing three jobs the grid couldn't:
 *
 *  - `explain.tsx` existed because it could order a month BIGGEST FIRST and
 *    the grid was hard-coded newest-first. That ordering is the screen's whole
 *    justification — a month of history is a grind that will not always be
 *    finished, so the work done first should be the work that changes the
 *    published page most.
 *  - `monthCodingWorklist` existed because the grid's `uncoded` facet asks the
 *    POLICY question (`requiresCoding`, which grandfathers everything posted
 *    before `codingRequiredSinceMs`). Every reconstructed 2024–25 row is
 *    exempt by calendar, so that facet is empty and the founder cannot reach a
 *    single historical row from the grid.
 *  - `receiptChase` groups by cardholder with Unattributed pinned last.
 *
 * These tests pin the three capabilities that fold them in, plus the one thing
 * that must NOT move: with none of the new arguments, every existing caller
 * gets byte-for-byte what it always got.
 */

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
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
      // Central scope so `monthCodingWorklist`'s `requireLedgerConsole` gate
      // opens for the same caller the grid opens for — the anti-drift test
      // below has to ask BOTH surfaces the same question as one person.
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** Mid-June 2024, Eastern — comfortably inside the month in either zone, so
 *  the month bucket a test asserts is never an offset artefact. */
const JUNE_2024 = Date.UTC(2024, 5, 14, 16);
const JULY_2024 = Date.UTC(2024, 6, 14, 16);

type Fixture = Partial<{
  flow: "inflow" | "outflow" | "transfer";
  status: "unreviewed" | "categorized" | "reconciled" | "excluded";
  amountCents: number;
  postedAt: number;
  merchantName: string;
  personId: Id<"people">;
  isPersonal: boolean;
  feeOrigin: "stripe_processing" | "givebutter_processing";
  sourceCategory: string;
  codingState: "submitted" | "approved" | "changes_requested";
  historicalImportBatch: string;
  payoutProcessor: "stripe" | "givebutter" | "other";
  preMarkFlow: "inflow" | "outflow";
}>;

let clock = 1_700_000_000_000;

async function txn(s: ChapterSetup, f: Fixture = {}): Promise<Id<"transactions">> {
  clock -= 1000;
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: f.flow ?? "outflow",
      amountCents: f.amountCents ?? 100,
      postedAt: f.postedAt ?? clock,
      status: f.status ?? "unreviewed",
      merchantName: f.merchantName,
      personId: f.personId,
      isPersonal: f.isPersonal,
      feeOrigin: f.feeOrigin,
      sourceCategory: f.sourceCategory,
      codingState: f.codingState,
      historicalImportBatch: f.historicalImportBatch,
      payoutProcessor: f.payoutProcessor,
      preMarkFlow: f.preMarkFlow,
      createdAt: Date.now(),
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("sort — across the whole scope, not the loaded page", () => {
  test("THE POINT: amount/desc puts the biggest |cents| first even when it is on page 12", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // 30 small rows inserted NEWEST first, then the whale — so the biggest row
    // is both the OLDEST (last under the default date sort) and far outside
    // any first page. Sorting the page instead of the scope would leave it
    // invisible, which is exactly the failure this argument exists to prevent.
    for (let i = 0; i < 30; i++) {
      await txn(s, { amountCents: 100 + i, merchantName: `SMALL ${i}` });
    }
    const whale = await txn(s, { amountCents: 900_000, merchantName: "U-HAUL" });

    const byDate = await s.as.query(api.finances.listReconcile, { limit: 5 });
    expect(byDate.rows.map((r) => r.id)).not.toContain(whale);

    const biggest = await s.as.query(api.finances.listReconcile, {
      sort: "amount",
      dir: "desc",
      limit: 5,
    });
    expect(biggest.rows[0].id).toBe(whale);
    // The rest of the page is still ordered, and the scope is untouched: a
    // sort must never change WHICH rows matched, only their order.
    const amounts = biggest.rows.map((r) => r.amountCents);
    expect([...amounts]).toEqual([...amounts].sort((a, b) => b - a));
    expect(biggest.matchedCount).toBe(byDate.matchedCount);
  });

  test("'biggest' means ABSOLUTE cents — an inflow of the same size ranks with it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const bigIn = await txn(s, { flow: "inflow", amountCents: 700_000, merchantName: "WIRE" });
    const bigOut = await txn(s, { amountCents: 690_000, merchantName: "VENUE" });
    await txn(s, { amountCents: 500, merchantName: "COFFEE" });

    const res = await s.as.query(api.finances.listReconcile, { sort: "amount" });
    // A $7,000 arrival is as worth looking at as a $6,900 charge; direction is
    // not size, and the money-in row must not be sorted to the bottom.
    expect(res.rows.slice(0, 2).map((r) => r.id)).toEqual([bigIn, bigOut]);
  });

  test("dir flips both keys; date/desc is the default and matches no-args", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const oldest = await txn(s, { amountCents: 100, postedAt: JUNE_2024 });
    const newest = await txn(s, { amountCents: 900, postedAt: JULY_2024 });

    const plain = await s.as.query(api.finances.listReconcile, {});
    const explicit = await s.as.query(api.finances.listReconcile, {
      sort: "date",
      dir: "desc",
    });
    expect(explicit.rows.map((r) => r.id)).toEqual(plain.rows.map((r) => r.id));
    expect(plain.rows.map((r) => r.id)).toEqual([newest, oldest]);

    const asc = await s.as.query(api.finances.listReconcile, { dir: "asc" });
    expect(asc.rows.map((r) => r.id)).toEqual([oldest, newest]);

    const smallest = await s.as.query(api.finances.listReconcile, {
      sort: "amount",
      dir: "asc",
    });
    expect(smallest.rows.map((r) => r.id)).toEqual([oldest, newest]);
  });

  test("sorting reorders without touching the counts or the totals", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    for (let i = 0; i < 6; i++) await txn(s, { amountCents: (i + 1) * 1000 });

    const plain = await s.as.query(api.finances.listReconcile, {});
    const sorted = await s.as.query(api.finances.listReconcile, { sort: "amount" });
    expect(sorted.counts).toEqual(plain.counts);
    expect(sorted.selectionTotals).toEqual(plain.selectionTotals);
    expect(sorted.matchedCount).toBe(plain.matchedCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("needs_explaining — the rows `uncoded` grandfathers away", () => {
  test("THE GAP: a pre-policy historical row is invisible to `uncoded` and reachable here", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // A genesis-backfilled 2024 row: reconciled, receipted or not, no coding.
    // `requiresCoding` exempts it (posted before `codingRequiredSinceMs`), so
    // the `uncoded` facet is dark — and it will still publish with a blank
    // next to it, which is the only thing the founder cares about.
    const historical = await txn(s, {
      amountCents: 400_000,
      postedAt: JUNE_2024,
      status: "reconciled",
      historicalImportBatch: "genesis-2024",
      merchantName: "U-HAUL",
    });

    const uncoded = await s.as.query(api.finances.listReconcile, {
      filters: ["uncoded"],
    });
    expect(uncoded.rows).toHaveLength(0);
    expect(uncoded.counts.uncoded).toBe(0);

    const needs = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_explaining"],
    });
    expect(needs.rows.map((r) => r.id)).toEqual([historical]);
    expect(needs.counts.needs_explaining).toBe(1);
  });

  test("the auto-explained kinds never enter it — they publish carrying their own sentence", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await asManager(s);

    const real = await txn(s, { amountCents: 5_000, postedAt: JUNE_2024, merchantName: "COSTCO" });
    // Each of these publishes with an `autoExplanationLine` of its own, so
    // nobody is ever asked to write one.
    await txn(s, { amountCents: 300, postedAt: JUNE_2024, feeOrigin: "stripe_processing" });
    await txn(s, { amountCents: 2_000, postedAt: JUNE_2024, isPersonal: true, personId: holder });
    await txn(s, {
      flow: "inflow",
      amountCents: 1_200,
      postedAt: JUNE_2024,
      sourceCategory: "cashback_payment",
    });
    // An arriving gift is the giving layer's record, not an expense report.
    await txn(s, { flow: "inflow", amountCents: 700_000, postedAt: JUNE_2024 });
    // An excluded row never publishes at all (and the grid drops it anyway).
    await txn(s, { amountCents: 9_000, postedAt: JUNE_2024, status: "excluded" });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_explaining"],
    });
    expect(res.rows.map((r) => r.id)).toEqual([real]);
  });

  test("an APPROVED coding clears it; a submitted one does not", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    await txn(s, { amountCents: 1_000, postedAt: JUNE_2024, codingState: "approved" });
    const inReview = await txn(s, {
      amountCents: 2_000,
      postedAt: JUNE_2024,
      codingState: "submitted",
    });
    const sentBack = await txn(s, {
      amountCents: 3_000,
      postedAt: JUNE_2024,
      codingState: "changes_requested",
    });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_explaining"],
    });
    // Waiting on a reviewer is still a blank on the published page.
    expect(new Set(res.rows.map((r) => r.id))).toEqual(new Set([inReview, sentBack]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ANTI-DRIFT: one predicate, two callers", () => {
  test("the grid's needs_explaining set is exactly monthCodingWorklist's rows for that month", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await asManager(s);

    // A deliberately awkward month: every class the predicate has an opinion
    // about, plus a row in the NEXT month so the period narrowing is doing
    // real work on both sides.
    await txn(s, { amountCents: 400_000, postedAt: JUNE_2024, status: "reconciled", merchantName: "U-HAUL" });
    await txn(s, { amountCents: 12_500, postedAt: JUNE_2024, merchantName: "COSTCO" });
    await txn(s, { amountCents: 900, postedAt: JUNE_2024, codingState: "approved" });
    await txn(s, { amountCents: 700, postedAt: JUNE_2024, codingState: "submitted" });
    await txn(s, { amountCents: 250, postedAt: JUNE_2024, feeOrigin: "givebutter_processing" });
    await txn(s, { amountCents: 6_000, postedAt: JUNE_2024, isPersonal: true, personId: holder });
    await txn(s, { flow: "inflow", amountCents: 700_000, postedAt: JUNE_2024 });
    await txn(s, { flow: "transfer", amountCents: 50_000, postedAt: JUNE_2024 });
    await txn(s, { amountCents: 3_300, postedAt: JUNE_2024, status: "excluded" });
    await txn(s, { amountCents: 8_800, postedAt: JULY_2024, merchantName: "NEXT MONTH" });

    const worklist = (await s.as.query(api.finances.monthCodingWorklist, {
      periodKey: "2024-06",
      scope: s.chapterId,
    }))!;
    const grid = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_explaining"],
      year: 2024,
      month: 6,
      limit: 500,
    });

    // THE ASSERT THIS FILE EXISTS FOR. If someone ever copies the predicate
    // instead of calling it, this is what catches the copy the day it drifts.
    expect(new Set(grid.rows.map((r) => r.id))).toEqual(
      new Set(worklist.rows.map((r) => r.id)),
    );

    // …and the DENOMINATORS agree too, which is the other half of the same
    // claim: the grid's progress figure and the Explain screen's must never
    // describe different populations.
    //
    // Read WITHOUT the state filter, deliberately. `explainedProgress` covers
    // the MATCH SET, so selecting `needs_explaining` removes every explained
    // row from the denominator by construction and the meter correctly reads
    // "0 of N" (pinned in the next test). The worklist's `totalCount` is the
    // whole month's population, so the comparable request is the whole month.
    const month = await s.as.query(api.finances.listReconcile, {
      year: 2024,
      month: 6,
      limit: 500,
    });
    expect(month.explainedProgress.explainableCount).toBe(worklist.totalCount);
    expect(month.explainedProgress.explainedCount).toBe(worklist.explainedCount);
    expect(month.explainedProgress.explainableCents).toBe(worklist.totalCents);
    expect(month.explainedProgress.explainedCents).toBe(worklist.explainedCents);
    // The month genuinely contained explained rows — otherwise the four
    // asserts above would pass on a pair of zeroes and prove nothing.
    expect(worklist.explainedCount).toBeGreaterThan(0);
    expect(worklist.totalCount).toBeGreaterThan(worklist.explainedCount);
  });

  test("selecting needs_explaining makes the meter read 0 of N — the match set IS the denominator", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { amountCents: 1_000, codingState: "approved" });
    await txn(s, { amountCents: 2_000 });
    await txn(s, { amountCents: 4_000 });

    const whole = await s.as.query(api.finances.listReconcile, {});
    // Asserted whole rather than field by field, so the live/backlog split is
    // pinned alongside the combined figure. These rows are all LIVE (nothing
    // reconstructed), so `live* === total*` and `backlog*` is flat zero — which
    // is exactly what keeps the grid from rendering a "+ 0 of 0 reconstructed"
    // second line under an ordinary book.
    expect(whole.explainedProgress).toEqual({
      explainableCount: 3,
      explainableCents: 7_000,
      explainedCount: 1,
      explainedCents: 1_000,
      liveExplainableCount: 3,
      liveExplainableCents: 7_000,
      liveExplainedCount: 1,
      liveExplainedCents: 1_000,
      backlogExplainableCount: 0,
      backlogExplainableCents: 0,
      backlogExplainedCount: 0,
      backlogExplainedCents: 0,
    });

    // Filtered to the work itself, the meter describes the work: three rows
    // become two, none of them explained. This is not a bug to route around —
    // a progress figure over a selection has to describe THAT selection, and
    // the grid shows the unfiltered figure when it wants the month's story.
    const filtered = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_explaining"],
    });
    expect(filtered.explainedProgress).toEqual({
      explainableCount: 2,
      explainableCents: 6_000,
      explainedCount: 0,
      explainedCents: 0,
      liveExplainableCount: 2,
      liveExplainableCents: 6_000,
      liveExplainedCount: 0,
      liveExplainedCents: 0,
      backlogExplainableCount: 0,
      backlogExplainableCents: 0,
      backlogExplainedCount: 0,
      backlogExplainedCents: 0,
    });
  });

  test("explainedProgress works over ANY filter, not just a month", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    await txn(s, { amountCents: 10_000, merchantName: "OLIVE GARDEN", codingState: "approved" });
    await txn(s, { amountCents: 30_000, merchantName: "OLIVE GARDEN" });
    // Out of the search, so it must not move the meter.
    await txn(s, { amountCents: 99_000, merchantName: "MTA" });

    const res = await s.as.query(api.finances.listReconcile, { search: "olive" });
    expect(res.explainedProgress).toEqual({
      explainableCount: 2,
      explainableCents: 40_000,
      explainedCount: 1,
      explainedCents: 10_000,
      liveExplainableCount: 2,
      liveExplainableCents: 40_000,
      liveExplainedCount: 1,
      liveExplainedCents: 10_000,
      backlogExplainableCount: 0,
      backlogExplainableCents: 0,
      backlogExplainedCount: 0,
      backlogExplainedCents: 0,
    });
  });

  test("the progress figure covers the match set, not the loaded page", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    for (let i = 0; i < 8; i++) {
      await txn(s, { amountCents: 1_000, codingState: i < 3 ? "approved" : undefined });
    }

    const paged = await s.as.query(api.finances.listReconcile, { limit: 2 });
    const whole = await s.as.query(api.finances.listReconcile, { limit: 100 });
    expect(paged.rows).toHaveLength(2);
    expect(paged.explainedProgress).toEqual(whole.explainedProgress);
    expect(whole.explainedProgress.explainableCount).toBe(8);
    expect(whole.explainedProgress.explainedCount).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("grouping — contiguous rows, honest headers", () => {
  test("by month: groups are contiguous, newest first, counted over the whole match set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // Interleaved on purpose — the grouping has to REORDER, not merely
    // annotate whatever order the scan produced.
    await txn(s, { amountCents: 1_000, postedAt: JUNE_2024 });
    await txn(s, { amountCents: 2_000, postedAt: JULY_2024 });
    await txn(s, { amountCents: 4_000, postedAt: JUNE_2024 });
    await txn(s, { amountCents: 8_000, postedAt: JULY_2024 });
    await txn(s, { amountCents: 16_000, postedAt: JUNE_2024 });

    const res = await s.as.query(api.finances.listReconcile, { groupBy: "month" });
    expect(res.groups?.map((g) => g.key)).toEqual(["2024-07", "2024-06"]);
    expect(res.groups?.map((g) => g.label)).toEqual(["July 2024", "June 2024"]);
    expect(res.groups?.map((g) => g.count)).toEqual([2, 3]);
    // Outflows, so `signedBookCents` is negative — the same arithmetic
    // `selectionTotals` uses, which is what makes the next assert hold.
    expect(res.groups?.map((g) => g.totalCents)).toEqual([-10_000, -21_000]);
    expect(res.groups!.reduce((sum, g) => sum + g.totalCents, 0)).toBe(
      res.selectionTotals.netCents,
    );

    // CONTIGUOUS: every row of a group sits together, in the group's order.
    const keys = res.rows.map((r) => r.postedAt).map((ts) => (ts === JULY_2024 ? "07" : "06"));
    expect(keys).toEqual(["07", "07", "06", "06", "06"]);
  });

  test("by month with dir:asc walks forward instead", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { amountCents: 1_000, postedAt: JULY_2024 });
    await txn(s, { amountCents: 1_000, postedAt: JUNE_2024 });

    const res = await s.as.query(api.finances.listReconcile, {
      groupBy: "month",
      dir: "asc",
    });
    expect(res.groups?.map((g) => g.key)).toEqual(["2024-06", "2024-07"]);
  });

  test("by person: biggest first, UNATTRIBUTED PINNED LAST", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const adeola = await seedPerson(s, "Adeola Bankole");
    const bola = await seedPerson(s, "Bola Adeyemi");

    await txn(s, { amountCents: 5_000, personId: bola });
    // No cardholder at all — a genesis-imported row, the class `receiptChase`
    // sends to the bottom because there is nobody to chase.
    await txn(s, { amountCents: 90_000, merchantName: "BANK FEE-ISH" });
    await txn(s, { amountCents: 40_000, personId: adeola });
    await txn(s, { amountCents: 1_000, personId: adeola });

    const res = await s.as.query(api.finances.listReconcile, { groupBy: "person" });
    expect(res.groups?.map((g) => g.key)).toEqual([adeola, bola, "unattributed"]);
    expect(res.groups?.map((g) => g.label)).toEqual([
      "Adeola Bankole",
      "Bola Adeyemi",
      "Unattributed",
    ]);
    expect(res.groups?.map((g) => g.count)).toEqual([2, 1, 1]);
    // Unattributed is the LARGEST pile here and still sorts last — the pin is
    // a rule, not a side effect of the totals.
    expect(res.groups?.map((g) => g.totalCents)).toEqual([-41_000, -5_000, -90_000]);

    const holders = res.rows.map((r) => r.cardholder?.personId ?? "unattributed");
    expect(holders).toEqual([adeola, adeola, bola, "unattributed"]);
  });

  test("the active sort still orders rows WITHIN a group", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const small = await txn(s, { amountCents: 100, postedAt: JUNE_2024 });
    const big = await txn(s, { amountCents: 90_000, postedAt: JUNE_2024 });

    const res = await s.as.query(api.finances.listReconcile, {
      groupBy: "month",
      sort: "amount",
    });
    expect(res.rows.map((r) => r.id)).toEqual([big, small]);
  });

  test("group headers describe the match set even when the page cuts them off", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    for (let i = 0; i < 4; i++) await txn(s, { amountCents: 1_000, postedAt: JUNE_2024 });
    for (let i = 0; i < 3; i++) await txn(s, { amountCents: 1_000, postedAt: JULY_2024 });

    const res = await s.as.query(api.finances.listReconcile, {
      groupBy: "month",
      limit: 2,
    });
    expect(res.rows).toHaveLength(2);
    expect(res.hasMore).toBe(true);
    // Both months are still announced, with their real counts — a header that
    // read "2 rows" because only 2 fit on the page is the dead number this
    // area keeps fixing.
    expect(res.groups?.map((g) => [g.key, g.count])).toEqual([
      ["2024-07", 3],
      ["2024-06", 4],
    ]);
  });

  test("grouping composes with a filter — the groups describe the FILTERED set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { amountCents: 1_000, postedAt: JUNE_2024, codingState: "approved" });
    await txn(s, { amountCents: 2_000, postedAt: JUNE_2024 });
    await txn(s, { amountCents: 4_000, postedAt: JULY_2024, codingState: "approved" });

    const res = await s.as.query(api.finances.listReconcile, {
      groupBy: "month",
      filters: ["needs_explaining"],
    });
    expect(res.groups?.map((g) => [g.key, g.count])).toEqual([["2024-06", 1]]);
    expect(res.matchedCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("each group carries its OWN progress", () => {
  // This is what lets a month band stand in for the Explain screen's meter.
  // It has to be computed server-side: the denominator is
  // `explanationPopulation`, which reads fields `reconcileRow` deliberately
  // doesn't ship, so a client could not derive it even from a full page.
  test("a month's explained figures are its own, not the whole selection's", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // June: two explainable, one approved. July: one explainable, none.
    await txn(s, { amountCents: 1_000, postedAt: JUNE_2024, codingState: "approved" });
    await txn(s, { amountCents: 3_000, postedAt: JUNE_2024 });
    await txn(s, { amountCents: 5_000, postedAt: JULY_2024 });

    const res = await s.as.query(api.finances.listReconcile, { groupBy: "month" });
    const july = res.groups!.find((g) => g.key === "2024-07")!;
    const june = res.groups!.find((g) => g.key === "2024-06")!;

    expect(june.explainableCount).toBe(2);
    expect(june.explainedCount).toBe(1);
    expect(june.explainableCents).toBe(4_000);
    expect(june.explainedCents).toBe(1_000);

    expect(july.explainableCount).toBe(1);
    expect(july.explainedCount).toBe(0);

    // AND THE GROUPS RECONCILE TO THE WHOLE-SET FIGURE — if they didn't, one
    // of the two meters would be lying and there'd be no way to tell which.
    const sum = (f: "explainableCount" | "explainedCount") =>
      res.groups!.reduce((n, g) => n + g[f], 0);
    expect(sum("explainableCount")).toBe(res.explainedProgress.explainableCount);
    expect(sum("explainedCount")).toBe(res.explainedProgress.explainedCount);
  });

  test("a group of rows that owe nothing reports zero explainable, not zero explained", async () => {
    // A month of processor fees. The band must be able to tell "nothing to do
    // here" apart from "nothing done here" — the UI hides progress entirely on
    // the former, and showing "0 of 0" would read as failure.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { amountCents: 289, postedAt: JUNE_2024, feeOrigin: "stripe_processing" });
    await txn(s, { amountCents: 315, postedAt: JUNE_2024, feeOrigin: "stripe_processing" });

    const res = await s.as.query(api.finances.listReconcile, { groupBy: "month" });
    const june = res.groups!.find((g) => g.key === "2024-06")!;
    expect(june.count).toBe(2);
    expect(june.explainableCount).toBe(0);
    expect(june.explainedCount).toBe(0);
  });

  test("person groups carry it too", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const personId = await seedPerson(s, "Marcus");
    await txn(s, { amountCents: 1_000, personId, codingState: "approved" });
    await txn(s, { amountCents: 2_000, personId });

    const res = await s.as.query(api.finances.listReconcile, { groupBy: "person" });
    const mine = res.groups!.find((g) => g.key === personId)!;
    expect(mine.explainableCount).toBe(2);
    expect(mine.explainedCount).toBe(1);
  });
});

describe("absent args change nothing", () => {
  test("no sort, no groupBy: identical rows, order, counts and totals", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const holder = await seedPerson(s, "Adeola Bankole");
    // Distinct `postedAt`s: the order this pins is the newest-first one, and a
    // tie would be asserting the scan's incidental insertion order instead.
    await txn(s, { amountCents: 900, postedAt: JUNE_2024, personId: holder });
    await txn(s, { amountCents: 40_000, postedAt: JULY_2024, status: "reconciled" });
    await txn(s, { flow: "inflow", amountCents: 7_000, postedAt: JULY_2024 - 3_600_000 });
    await txn(s, { flow: "transfer", amountCents: 3_000, postedAt: JUNE_2024 });

    const res = await s.as.query(api.finances.listReconcile, {});
    // Newest-first, exactly as before — and the hidden transfer leg is still
    // hidden, so none of the new machinery widened the queue's population.
    expect(res.rows.map((r) => r.amountCents)).toEqual([40_000, 7_000, 900]);
    expect(res.counts.all).toBe(3);
    expect(res.matchedCount).toBe(3);
    expect(res.hasMore).toBe(false);
    // No `groupBy` → no `groups` key at all, rather than an empty array
    // standing in for "not grouping".
    expect(res.groups).toBeUndefined();
    expect(res.selectionTotals.netCents).toBe(7_000 - 40_900);
  });

  test("the legacy singular `filter` arg still works untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const open = await txn(s, { amountCents: 1_000 });
    await txn(s, { amountCents: 2_000, status: "reconciled" });

    const res = await s.as.query(api.finances.listReconcile, { filter: "to_review" });
    expect(res.rows.map((r) => r.id)).toEqual([open]);
  });
});

describe("the live/backlog split — the last thing the Explain screen could say and the grid couldn't", () => {
  /**
   * A month holding 450 rows reconstructed from the org's imported 2024-25
   * records and 3 rows of its own live spend reads as "3% explained" if the two
   * populations share one meter. `monthCodingWorklist` grew `live*`/`backlog*`
   * for exactly that reason; retiring that screen into this grid means the
   * grid's own strip and every month band have to carry the same distinction,
   * or the number regresses the day the screen is deleted.
   */
  test("a backlog row is counted apart from a live one, and the two sum to the whole", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // This month's own work: one done, one not.
    await txn(s, { amountCents: 1_000, postedAt: JUNE_2024, codingState: "approved" });
    await txn(s, { amountCents: 2_000, postedAt: JUNE_2024 });
    // Reconstructed from an import — same month, same population, different
    // meter.
    await txn(s, {
      amountCents: 400_000,
      postedAt: JUNE_2024,
      historicalImportBatch: "genesis-2024",
    });

    const res = await s.as.query(api.finances.listReconcile, {
      year: 2024,
      month: 6,
      limit: 500,
    });
    const p = res.explainedProgress;

    // The live half is the one "did I finish THIS month" is asking about: one
    // of two, not one of three — and not one of a denominator dominated by
    // $4,000 of imported history.
    expect(p.liveExplainableCount).toBe(2);
    expect(p.liveExplainedCount).toBe(1);
    expect(p.liveExplainableCents).toBe(3_000);
    expect(p.backlogExplainableCount).toBe(1);
    expect(p.backlogExplainedCount).toBe(0);
    expect(p.backlogExplainableCents).toBe(400_000);

    // THE INVARIANT. Every row in the population lands in exactly one bucket,
    // so the two halves reconstruct the combined figure. If they ever don't,
    // one of the three numbers on screen is lying and there'd otherwise be no
    // way to tell which.
    expect(p.liveExplainableCount + p.backlogExplainableCount).toBe(p.explainableCount);
    expect(p.liveExplainedCount + p.backlogExplainedCount).toBe(p.explainedCount);
    expect(p.liveExplainableCents + p.backlogExplainableCents).toBe(p.explainableCents);
    expect(p.liveExplainedCents + p.backlogExplainedCents).toBe(p.explainedCents);
  });

  test("an ordinary book puts everything in `live` and nothing in `backlog`", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { amountCents: 5_000, codingState: "approved" });
    await txn(s, { amountCents: 6_000 });

    const p = (await s.as.query(api.finances.listReconcile, {})).explainedProgress;
    // The client's `showsBacklogSplit` reads exactly this to decide whether the
    // split earns a second line — a nonzero backlog on a book that has no
    // imported history would put "+ 0 of 0 reconstructed" under every meter.
    expect(p.backlogExplainableCount).toBe(0);
    expect(p.liveExplainableCount).toBe(p.explainableCount);
  });

  test("a month BAND carries its own split, not the whole selection's", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // June: all reconstructed. July: all live. Grouped, neither band may
    // report the other's figures — the failure mode a single whole-set meter
    // has by construction.
    await txn(s, {
      amountCents: 100_000,
      postedAt: JUNE_2024,
      historicalImportBatch: "genesis-2024",
    });
    await txn(s, { amountCents: 7_000, postedAt: JULY_2024, codingState: "approved" });

    const res = await s.as.query(api.finances.listReconcile, {
      groupBy: "month",
      limit: 500,
    });
    const june = res.groups?.find((g) => g.key === "2024-06");
    const july = res.groups?.find((g) => g.key === "2024-07");

    expect(june?.backlogExplainableCount).toBe(1);
    expect(june?.liveExplainableCount).toBe(0);
    expect(july?.liveExplainableCount).toBe(1);
    expect(july?.liveExplainedCount).toBe(1);
    expect(july?.backlogExplainableCount).toBe(0);
  });

  test("the groups' splits sum to the whole selection's split", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { amountCents: 1_000, postedAt: JUNE_2024 });
    await txn(s, {
      amountCents: 2_000,
      postedAt: JUNE_2024,
      historicalImportBatch: "genesis-2024",
    });
    await txn(s, { amountCents: 4_000, postedAt: JULY_2024, codingState: "approved" });

    const res = await s.as.query(api.finances.listReconcile, {
      groupBy: "month",
      limit: 500,
    });
    const groups = res.groups ?? [];
    const sum = (pick: (g: (typeof groups)[number]) => number) =>
      groups.reduce((acc, g) => acc + pick(g), 0);

    // Same guarantee #705 pinned for the combined figure, extended to the two
    // halves: a band and the strip above it cannot disagree without a test
    // failing.
    expect(sum((g) => g.liveExplainableCount)).toBe(
      res.explainedProgress.liveExplainableCount,
    );
    expect(sum((g) => g.backlogExplainableCount)).toBe(
      res.explainedProgress.backlogExplainableCount,
    );
    expect(sum((g) => g.liveExplainedCents)).toBe(
      res.explainedProgress.liveExplainedCents,
    );
    expect(sum((g) => g.backlogExplainedCents)).toBe(
      res.explainedProgress.backlogExplainedCents,
    );
  });
});

describe("what else the Explain screen said that the grid now has to", () => {
  test("`truncated` is false on a book that fits in one read", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { amountCents: 1_000 });

    // The positive case needs ROLLUP_SCAN_LIMIT (5,000) rows to provoke and is
    // deliberately not seeded here — inserting 5,000 transactions to assert one
    // boolean would add minutes to every run of this suite. What matters for
    // the regression is that the field EXISTS and is honest on the ordinary
    // path: a `truncated: true` that nobody ever cleared would put a permanent
    // red warning on every grid.
    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.truncated).toBe(false);
  });

  test("`viewerCanRename` follows the rank `renameMerchant` enforces, not the rank that opened the grid", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "A viewer",
        userId: s.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    // A finance VIEWER: enough to read this grid, never enough to rename a
    // merchant. Before this field the Merchant cell offered them a live text
    // box every keystroke of which the server would refuse — the exact thing
    // `monthCodingWorklist.canRename` existed to prevent on the screen these
    // viewers are now being sent to.
    const roleId = await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    await txn(s, { amountCents: 1_000 });

    const asViewer = await s.as.query(api.finances.listReconcile, {});
    expect(asViewer.viewerCanRename).toBe(false);

    // Same caller, promoted to bookkeeper — the rank `renameMerchant` actually
    // gates on.
    await run(s.t, (ctx) => ctx.db.patch(roleId, { role: "bookkeeper" }));
    const asBookkeeper = await s.as.query(api.finances.listReconcile, {});
    expect(asBookkeeper.viewerCanRename).toBe(true);
  });
});

describe("the chase, in the grid — `needs_chasing` is the UNION, not the receipt pill", () => {
  /**
   * The chase page's predicate is `needsDocumentation || chargeOutstanding !=
   * null`. Building a by-person view on `missing_receipt` alone would produce a
   * plausible, wrong list — which is the whole risk of moving the chase into
   * the grid.
   */
  test("the facet is exactly `chaseCount`'s population, and both are `receiptChase`'s", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // Owes documentation and nothing else.
    await txn(s, { amountCents: 1_000 });
    // A MARKED internal transfer: `flow:"transfer"`, so the default queue hides
    // it — and it owes a receipt, so the chase must still find it.
    await txn(s, { amountCents: 2_000, flow: "transfer", preMarkFlow: "outflow" });
    // Closed with nothing behind it — nobody left to chase.
    await txn(s, { amountCents: 4_000, status: "reconciled" });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_chasing"],
      limit: 500,
    });
    const chase = await s.as.query(api.finances.receiptChase, {});

    // The number the "Chase receipts" entry point is gated on, the facet
    // count, and the chase list's own count are one population.
    expect(res.counts.needs_chasing).toBe(res.chaseCount);
    expect(res.chaseCount).toBe(chase.count);
    // And the rows the grid actually SHOWS are that population, not a subset
    // of it.
    expect(res.matchedCount).toBe(chase.count);
  });

  test("a MARKED TRANSFER is hidden from the default queue and still reachable through the chase", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const leg = await txn(s, {
      amountCents: 9_000,
      flow: "transfer",
      preMarkFlow: "outflow",
    });

    // Hidden by default — a transfer leg is not queue work.
    const plain = await s.as.query(api.finances.listReconcile, { limit: 500 });
    expect(plain.rows.map((r) => r.id)).not.toContain(leg);

    // THE FOUNDER RULE: marking a row must never be a way to make it stop
    // being chased. Selecting the chase has to un-hide the legs, or the
    // by-person view would silently omit exactly the rows a TREASURER (rather
    // than a cardholder) has to act on.
    const chasing = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_chasing"],
      limit: 500,
    });
    expect(chasing.rows.map((r) => r.id)).toContain(leg);
  });

  test("a charge whose receipt is on and whose coding is not is in the chase but not the receipt pill", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    // `changes_requested` — a coding a reviewer sent back. `chargeOutstanding`
    // says the cardholder owes an edit; `needsDocumentation` is the wrong half
    // to ask, which is why the union exists.
    await txn(s, { amountCents: 3_000, codingState: "changes_requested" });

    const res = await s.as.query(api.finances.listReconcile, { limit: 500 });
    expect(res.counts.needs_chasing).toBeGreaterThanOrEqual(
      res.counts.missing_receipt,
    );
    // The row carries the debt in the SAME words the cardholder's email uses,
    // so a person band can't say "1 charge" while the reminder names something
    // the grid never showed.
    expect(res.rows[0].outstanding).toBeTruthy();
  });

  test("a processor fee is chased by neither half", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await txn(s, { amountCents: 500, feeOrigin: "stripe_processing" });

    const res = await s.as.query(api.finances.listReconcile, { limit: 500 });
    // No receipt exists and none ever will — the processor's own ledger is the
    // record. Both halves of the union carve it out, and the row's own label
    // agrees rather than asking for a document that doesn't exist.
    expect(res.counts.needs_chasing).toBe(0);
    expect(res.rows[0].outstanding).toBeNull();
  });

  test("person bands carry the identity a nudge button needs", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const alice = await seedPerson(s, "Alice");
    await txn(s, { amountCents: 5_000, personId: alice });
    // No cardholder — a marked transfer, chased with a statement rather than a
    // person. Its band must be the `unattributed` sentinel so the UI knows
    // there is nobody to remind.
    await txn(s, { amountCents: 6_000, flow: "transfer", preMarkFlow: "outflow" });

    const res = await s.as.query(api.finances.listReconcile, {
      filters: ["needs_chasing"],
      groupBy: "person",
      limit: 500,
    });
    const groups = res.groups ?? [];
    // The band's KEY is the personId itself, which is what lets the button
    // nudge without a second lookup.
    expect(groups.find((g) => g.key === alice)?.label).toBe("Alice");
    expect(groups.some((g) => g.key === "unattributed")).toBe(true);
    // Unattributed pinned LAST — the chase list's rule, kept: those rows have
    // nobody attached, so a person-by-person read shouldn't open on them.
    expect(groups[groups.length - 1].key).toBe("unattributed");
    // The avatar field exists on every band (null where there's no image), so
    // the person header can look like the chase list it replaces.
    expect(groups.every((g) => "imageUrl" in g)).toBe(true);
  });
});
