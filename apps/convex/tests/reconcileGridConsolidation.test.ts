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
    expect(whole.explainedProgress).toEqual({
      explainableCount: 3,
      explainableCents: 7_000,
      explainedCount: 1,
      explainedCents: 1_000,
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
