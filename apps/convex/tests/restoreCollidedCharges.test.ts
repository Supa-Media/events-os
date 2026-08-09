/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import { NEW_YORK_CHAPTER_SLUG } from "../lib/seed/historical/mapping";
import { GENESIS_BANK_ROWS } from "../lib/seed/historical/genesisBank";
import {
  EXPECTED_RESTORE_CENTS,
  GENESIS_RESTORE_ROWS,
} from "../lib/seed/historical/genesisRestore2026";
import { genesisBankFields, parseGenesisDate } from "../financeGenesisBackfill";

/**
 * The 2026-08-09 restore of six charges deleted in error.
 *
 * What this suite holds still is the ARITHMETIC and the REFUSALS, in that
 * order. The arithmetic, because the only proof these six are the right six is
 * that they come to exactly $55.00 — the figure the owner's hand-typed Relay
 * balance independently predicts. The refusals, because this correction exists
 * to undo a pass that reasoned its way into deleting real money, and the way
 * that ends badly a third time is a re-run quietly inserting a second copy of
 * everything.
 *
 * Every assertion is in cents and exact. There is nothing here to tolerance.
 */

// ── The data module, no database needed ──────────────────────────────────────

describe("genesisRestore2026 — the six rows are the six rows", () => {
  test("every target still points at the charge it claims to", () => {
    for (const target of GENESIS_RESTORE_ROWS) {
      const source = GENESIS_BANK_ROWS[target.bankIndex];
      expect(source).toBeDefined();
      expect(source.date).toBe(target.expect.date);
      expect(source.description).toBe(target.expect.description);
      expect(source.amountCents).toBe(target.expect.amountCents);
    }
  });

  test("each has an identical same-day twin that survived — that is the collision", () => {
    // The whole premise: the bank history holds TWO of each of these, which is
    // why the importer's four-column key could not tell them apart. A target
    // whose twin didn't match would be a different bug than the one being fixed.
    for (const target of GENESIS_RESTORE_ROWS) {
      const row = GENESIS_BANK_ROWS[target.bankIndex];
      const twin = GENESIS_BANK_ROWS[target.twinBankIndex];
      expect(twin.date).toBe(row.date);
      expect(twin.description).toBe(row.description);
      expect(twin.amountCents).toBe(row.amountCents);
      expect(target.twinBankIndex).not.toBe(target.bankIndex);
    }
  });

  test("they sum to exactly −$55.00", () => {
    const total = GENESIS_RESTORE_ROWS.reduce(
      (a, t) => a + t.expect.amountCents,
      0,
    );
    expect(total).toBe(-5500);
    expect(total).toBe(EXPECTED_RESTORE_CENTS);
  });

  test("all six are outflows, and all six keys are distinct", () => {
    expect(GENESIS_RESTORE_ROWS.every((t) => t.expect.amountCents < 0)).toBe(true);
    const ids = GENESIS_RESTORE_ROWS.map(
      (t) => genesisBankFields(GENESIS_BANK_ROWS[t.bankIndex], t.bankIndex)?.externalId,
    );
    expect(new Set(ids).size).toBe(GENESIS_RESTORE_ROWS.length);
    expect(ids).toEqual([
      "genesis-bank:4",
      "genesis-bank:5",
      "genesis-bank:108",
      "genesis-bank:117",
      "genesis-bank:139",
      "genesis-bank:161",
    ]);
  });
});

// ── The runner, against a ledger ─────────────────────────────────────────────

/** Rename the fixture chapter to the one the genesis money lives on. */
async function asNewYork(s: ChapterSetup): Promise<void> {
  await run(s.t, (ctx) => ctx.db.patch(s.chapterId, { slug: NEW_YORK_CHAPTER_SLUG }));
}

/**
 * Seed the ledger AS PRODUCTION HAS IT: for each of the six, the ONE surviving
 * Relay-import row that both identical charges were folded onto, under the exact
 * `externalId` the data module names. This is the state the correction was
 * written against, so it is the state the tests run against.
 */
async function seedSurvivingTwins(s: ChapterSetup): Promise<void> {
  for (const target of GENESIS_RESTORE_ROWS) {
    const source = GENESIS_BANK_ROWS[target.bankIndex];
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "relay_csv",
        flow: "outflow",
        amountCents: Math.abs(source.amountCents),
        currency: "usd",
        postedAt: parseGenesisDate(source.date),
        merchantName: source.description,
        status: "unreviewed",
        externalId: target.collidedExternalId,
        createdAt: Date.now(),
      }),
    );
  }
}

async function ledger(s: ChapterSetup) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  );
}

describe("runRestoreCollidedCharges", () => {
  test("a dry run reports all six and writes nothing", async () => {
    const s = await setupChapter(newT());
    await asNewYork(s);
    await seedSurvivingTwins(s);

    const res = await s.t.mutation(
      internal.restoreCollidedCharges.runRestoreCollidedCharges,
      {},
    );
    expect(res.dryRun).toBe(true);
    expect(res.proceeded).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.rows.length).toBe(6);
    expect(res.bookValueDeltaCents).toBe(-5500);
    expect(res.expectedDeltaCents).toBe(EXPECTED_RESTORE_CENTS);
    expect(res.rows.some((r) => r.restored)).toBe(false);
    // Every row paired with the twin the data module named, and with only it.
    expect(res.rows.every((r) => r.sameDayMatches === 1)).toBe(true);

    expect((await ledger(s)).length).toBe(6); // the twins, and nothing added
  });

  test("execute inserts the six with their ORIGINAL values, and moves the book −$55.00", async () => {
    const s = await setupChapter(newT());
    await asNewYork(s);
    await seedSurvivingTwins(s);

    const before = await ledger(s);
    const res = await s.t.mutation(
      internal.restoreCollidedCharges.runRestoreCollidedCharges,
      { execute: true },
    );
    expect(res.proceeded).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.bookValueDeltaCents).toBe(-5500);

    const after = await ledger(s);
    expect(after.length).toBe(before.length + 6);

    // NO OTHER ROW MOVED. The six twins are byte-identical to how they went in —
    // this runner only ever inserts, and that is asserted, not assumed.
    const byId = new Map(after.map((t) => [t._id, t]));
    for (const prior of before) {
      expect(byId.get(prior._id)).toEqual(prior);
    }

    // And the restored rows carry the values the genesis backfill would have
    // written: same flow, amount, date, description and category note.
    for (const target of GENESIS_RESTORE_ROWS) {
      const source = GENESIS_BANK_ROWS[target.bankIndex];
      const fields = genesisBankFields(source, target.bankIndex);
      expect(fields).not.toBeNull();
      const row = after.find((t) => t.externalId === fields!.externalId);
      expect(row).toBeDefined();
      expect(row!.source).toBe("relay_csv");
      expect(row!.flow).toBe("outflow");
      expect(row!.amountCents).toBe(Math.abs(source.amountCents));
      expect(row!.postedAt).toBe(fields!.postedAt);
      expect(row!.description).toBe(source.description);
      expect(row!.status).toBe("unreviewed");
      // The original note, kept whole, with the restoration sentence after it.
      expect(row!.note?.startsWith(fields!.note)).toBe(true);
      expect(row!.note).toContain("deleted in error");
    }

    // The book moved by exactly the six outflows and nothing else.
    const signed = (rows: typeof after) =>
      rows.reduce((a, t) => a + (t.flow === "inflow" ? t.amountCents : -t.amountCents), 0);
    expect(signed(after) - signed(before)).toBe(-5500);
  });

  test("REFUSES — and writes nothing — when one of the six is already present", async () => {
    const s = await setupChapter(newT());
    await asNewYork(s);
    await seedSurvivingTwins(s);

    // The exact double-restore hazard: run it, then run it again.
    await s.t.mutation(internal.restoreCollidedCharges.runRestoreCollidedCharges, {
      execute: true,
    });
    const afterFirst = await ledger(s);

    const res = await s.t.mutation(
      internal.restoreCollidedCharges.runRestoreCollidedCharges,
      { execute: true },
    );
    expect(res.proceeded).toBe(false);
    expect(res.bookValueDeltaCents).toBe(0);
    expect(res.problems.some((p) => p.includes("ALREADY PRESENT"))).toBe(true);

    const afterSecond = await ledger(s);
    expect(afterSecond.length).toBe(afterFirst.length);
    expect(new Set(afterSecond.map((t) => t._id))).toEqual(
      new Set(afterFirst.map((t) => t._id)),
    );
  });

  test("REFUSES ALL SIX when only one row's twin is missing — never half-applies", async () => {
    const s = await setupChapter(newT());
    await asNewYork(s);
    await seedSurvivingTwins(s);

    // Delete one twin: that row's pairing can no longer be verified. The other
    // five are still fine, and that is exactly why this matters — a partial
    // apply would leave the books off by an amount nobody predicted, and the
    // $55.00 that makes the whole change checkable would stop being the number
    // to look for.
    const gone = GENESIS_RESTORE_ROWS[2].collidedExternalId;
    const doomed = (await ledger(s)).find((t) => t.externalId === gone);
    await run(s.t, (ctx) => ctx.db.delete(doomed!._id));

    const res = await s.t.mutation(
      internal.restoreCollidedCharges.runRestoreCollidedCharges,
      { execute: true },
    );
    expect(res.proceeded).toBe(false);
    expect(res.bookValueDeltaCents).toBe(0);
    expect(res.problems.some((p) => p.includes("found 0"))).toBe(true);
    expect((await ledger(s)).length).toBe(5); // the five remaining twins only
  });

  test("REFUSES when the pair is already complete (two survivors on the day)", async () => {
    const s = await setupChapter(newT());
    await asNewYork(s);
    await seedSurvivingTwins(s);

    // Someone re-imported the statement with the fixed key and the second $3.00
    // fare landed on its own. Nothing is missing any more, and putting the
    // genesis copy back on top would make three.
    const target = GENESIS_RESTORE_ROWS[3];
    const source = GENESIS_BANK_ROWS[target.bankIndex];
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "relay_csv",
        flow: "outflow",
        amountCents: Math.abs(source.amountCents),
        currency: "usd",
        postedAt: parseGenesisDate(source.date),
        merchantName: source.description,
        status: "unreviewed",
        externalId: `${target.collidedExternalId}#1`,
        createdAt: Date.now(),
      }),
    );

    const res = await s.t.mutation(
      internal.restoreCollidedCharges.runRestoreCollidedCharges,
      { execute: true },
    );
    expect(res.proceeded).toBe(false);
    expect(res.problems.some((p) => p.includes("already complete"))).toBe(true);
    expect((await ledger(s)).length).toBe(7); // six twins + the re-imported one
  });
});
