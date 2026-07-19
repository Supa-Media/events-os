import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { GENESIS_BANK_ROWS } from "../lib/seed/historical/genesisBank";
import { GENESIS_LTN_ROWS } from "../lib/seed/historical/genesisLtn";
import { GENESIS_INKIND_EXPENSE_ROWS } from "../lib/seed/historical/genesisInkindExpenses";
import { parseGenesisDate } from "../financeGenesisBackfill";

/**
 * Finance genesis backfill: the ops-only runner that loads the org's full
 * financial history — Kansi's 213-row Relay bank export, the 3 owner-paid Love
 * Thy Neighbor Zelle expenses, and the 37-row owner-paid in-kind expense mirror
 * — into `transactions` on the NY chapter, where the reconcile grid reads from.
 *
 * Covers: dataset integrity (row counts + signed-total sanity + sign/type
 * agreement) for all three datasets; dry run writes nothing but predicts the
 * counts; execute inserts and the rows are visible to `finances.listReconcile`;
 * the ±2d/amount dedup skips a planted live-feed row (bank dataset only); a
 * second execute run is fully idempotent; the LTN payments land as `manual`
 * outflows carrying the "paid personally" note; the in-kind rows land as
 * `manual` outflows carrying the "mirrors in-kind gift" note; and — because
 * bank+ltn already shipped to production in #306 — a re-dispatch of this
 * extended mutation against a chapter that already has bank+ltn inserts ONLY
 * the new 37 in-kind rows, leaving bank/ltn fully `alreadyPresent`.
 */

const NY_SLUG = "new-york";
const utc = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);

type NySetup = {
  t: TestConvex;
  chapterId: Id<"chapters">;
  userId: Id<"users">;
  as: ReturnType<TestConvex["withIdentity"]>;
};

/**
 * A NY chapter (slug the runner resolves by) + an authenticated caller who is a
 * `people` row with a finance VIEWER grant — enough to read
 * `finances.listReconcile`. The runner itself is internal (no auth), but the
 * reconcile-visibility assertion goes through the authed public query.
 */
async function setupNy(): Promise<NySetup> {
  const t = newT();
  const { chapterId, userId } = await run(t, async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "leader@publicworship.life",
    });
    const chapterId = await ctx.db.insert("chapters", {
      name: "New York",
      slug: NY_SLUG,
      isActive: true,
      createdAt: Date.now(),
    });
    await ctx.db.insert("userChapters", {
      userId,
      chapterId,
      role: "admin",
      isActive: true,
      joinedAt: Date.now(),
    });
    const personId = await ctx.db.insert("people", {
      chapterId,
      name: "Caller",
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    });
    await ctx.db.insert("financeRoles", {
      chapterId,
      personId,
      role: "viewer",
      scope: "chapter",
      createdAt: Date.now(),
    });
    return { chapterId, userId };
  });
  const as = t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { t, chapterId, userId, as };
}

function chapterTxns(s: NySetup) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  );
}

/**
 * Reproduces the chapter state AFTER #306 shipped to production: the 213 bank
 * rows + 3 LTN rows already landed as `transactions` (same shape the runner
 * itself would have written), but the 37-row in-kind dataset — new in this PR —
 * has never run. Used to prove a re-dispatch of the extended mutation inserts
 * ONLY the new in-kind rows and reports the prior two datasets as fully
 * `alreadyPresent`, never double-inserting.
 */
async function seedPriorBankAndLtn(s: NySetup): Promise<void> {
  await run(s.t, async (ctx) => {
    for (let i = 0; i < GENESIS_BANK_ROWS.length; i++) {
      const row = GENESIS_BANK_ROWS[i];
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "relay_csv",
        flow: row.amountCents > 0 ? "inflow" : "outflow",
        amountCents: Math.abs(row.amountCents),
        currency: "usd",
        postedAt: parseGenesisDate(row.date),
        description: row.description,
        note: "seeded: production state prior to the in-kind mirror",
        status: "unreviewed",
        externalId: `genesis-bank:${i}`,
        createdAt: Date.now(),
      });
    }
    for (const row of GENESIS_LTN_ROWS) {
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: row.amountCents,
        currency: "usd",
        postedAt: parseGenesisDate(row.date),
        description: row.description,
        note: "seeded: production state prior to the in-kind mirror",
        status: "unreviewed",
        externalId: `genesis-ltn:${row.conf}`,
        createdAt: Date.now(),
      });
    }
  });
}

describe("genesis dataset integrity", () => {
  test("row counts + signed-total sanity + sign/type agreement", () => {
    expect(GENESIS_BANK_ROWS.length).toBe(213);
    expect(GENESIS_LTN_ROWS.length).toBe(3);

    // Signed total of the bank export (deposits +, withdrawals −).
    const signedTotal = GENESIS_BANK_ROWS.reduce((s, r) => s + r.amountCents, 0);
    const deposits = GENESIS_BANK_ROWS.filter((r) => r.amountCents > 0);
    const withdrawals = GENESIS_BANK_ROWS.filter((r) => r.amountCents < 0);
    expect(deposits.length + withdrawals.length).toBe(213); // no zero rows
    expect(signedTotal).toBe(327214); // +$3,272.14 net across the year

    // The `type` label always agrees with the sign, and amounts are integers.
    for (const r of GENESIS_BANK_ROWS) {
      expect(Number.isInteger(r.amountCents)).toBe(true);
      expect(r.amountCents === 0).toBe(false);
      expect(r.type).toBe(r.amountCents > 0 ? "Deposit" : "Withdrawal");
      expect(() => parseGenesisDate(r.date)).not.toThrow();
    }

    // LTN rows are always positive-cent expenses with a unique conf code.
    const confs = new Set(GENESIS_LTN_ROWS.map((r) => r.conf));
    expect(confs.size).toBe(3);
    for (const r of GENESIS_LTN_ROWS) {
      expect(Number.isInteger(r.amountCents)).toBe(true);
      expect(r.amountCents).toBeGreaterThan(0);
      expect(() => parseGenesisDate(r.date)).not.toThrow();
    }
    const ltnTotal = GENESIS_LTN_ROWS.reduce((s, r) => s + r.amountCents, 0);
    expect(ltnTotal).toBe(350000); // $1,500 + $1,500 + $500

    // In-kind expense mirror: 37 rows, all negative (an outflow), unique
    // externalRefs, and a matching giving-side sourceGiftRef on every row.
    expect(GENESIS_INKIND_EXPENSE_ROWS.length).toBe(37);
    const inkindRefs = new Set(GENESIS_INKIND_EXPENSE_ROWS.map((r) => r.externalRef));
    expect(inkindRefs.size).toBe(37);
    for (const r of GENESIS_INKIND_EXPENSE_ROWS) {
      expect(Number.isInteger(r.amountCents)).toBe(true);
      expect(r.amountCents).toBeLessThan(0);
      expect(r.externalRef.startsWith("genesis-inkind-exp:")).toBe(true);
      expect(r.sourceGiftRef.startsWith("genesis:")).toBe(true);
      expect(["Oluseyi Olujide", "Layomi Kupoluyi"]).toContain(r.fundedBy);
      expect(Number.isInteger(r.dateMs)).toBe(true);
      expect(r.dateMs).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
    }
    const inkindTotal = GENESIS_INKIND_EXPENSE_ROWS.reduce((s, r) => s + r.amountCents, 0);
    expect(inkindTotal).toBe(-954794);
  });

  test("parseGenesisDate is deterministic UTC midnight", () => {
    expect(parseGenesisDate("Jun 9, 2025")).toBe(utc("2025-06-09"));
    expect(parseGenesisDate("Aug 24, 2025")).toBe(utc("2025-08-24"));
    expect(() => parseGenesisDate("garbage")).toThrow();
  });
});

describe("genesis backfill runner", () => {
  test("dry run predicts every insert but writes nothing", async () => {
    const s = await setupNy();
    const res = await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: false },
    );
    expect(res.dryRun).toBe(true);
    expect(res.bank.inserted).toBe(213);
    expect(res.bank.alreadyPresent).toBe(0);
    expect(res.bank.invalid).toBe(0);
    expect(res.bank.netCents).toBe(327214);
    expect(res.ltn.inserted).toBe(3);
    expect(res.ltn.netCents).toBe(-350000);
    expect(res.inkind.inserted).toBe(37);
    expect(res.inkind.alreadyPresent).toBe(0);
    expect(res.inkind.invalid).toBe(0);
    expect(res.inkind.netCents).toBe(-954794);
    expect(res.netCents).toBe(327214 - 350000 - 954794);

    // Nothing was written.
    const txns = await chapterTxns(s);
    expect(txns.length).toBe(0);
  });

  test("execute inserts every row and the rows are visible to the reconcile grid", async () => {
    const s = await setupNy();
    const res = await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: true },
    );
    expect(res.dryRun).toBe(false);
    expect(res.bank.inserted).toBe(213);
    expect(res.ltn.inserted).toBe(3);
    expect(res.inkind.inserted).toBe(37);

    const txns = await chapterTxns(s);
    expect(txns.length).toBe(253);
    // Bank rows carry the existing `relay_csv` import source; LTN + in-kind rows
    // are both `manual` (hand-entered, never touched the Relay feed).
    expect(txns.filter((t) => t.source === "relay_csv").length).toBe(213);
    expect(txns.filter((t) => t.source === "manual").length).toBe(40);
    // Non-negative stored amounts; direction on `flow`.
    expect(txns.every((t) => t.amountCents >= 0)).toBe(true);
    expect(txns.every((t) => t.status === "unreviewed")).toBe(true);
    // The hand-category is carried verbatim in the note.
    const givebutter = txns.find((t) =>
      t.note?.startsWith("Income: Donations (Givebutter)"),
    );
    expect(givebutter).toBeDefined();

    // The reconcile grid (what a bookkeeper actually sees) surfaces them all.
    const reconcile = await s.as.query(api.finances.listReconcile, {
      filter: "all",
    });
    expect(reconcile.counts.all).toBe(253);
    expect(reconcile.rows.length).toBe(253);
    // Every genesis row is unreviewed → the whole set shows under "uncategorized".
    expect(reconcile.counts.uncategorized).toBe(253);
  });

  test("LTN payments land as manual outflows carrying the paid-personally note", async () => {
    const s = await setupNy();
    await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: true },
    );
    const txns = await chapterTxns(s);
    const ltn = txns.filter((t) => t.externalId?.startsWith("genesis-ltn:"));
    expect(ltn.length).toBe(3);
    for (const t of ltn) {
      expect(t.source).toBe("manual");
      expect(t.flow).toBe("outflow");
      expect(t.note).toContain("Paid personally by owner via Zelle");
      expect(t.note).toContain("expense leg");
    }
    // The three unique Zelle confs became the externalIds.
    expect(new Set(ltn.map((t) => t.externalId))).toEqual(
      new Set([
        "genesis-ltn:tkplz76rz",
        "genesis-ltn:wekn4esl0",
        "genesis-ltn:ug3ml7wr4",
      ]),
    );
  });

  test("in-kind expenses land as manual outflows carrying the mirrors-in-kind-gift note", async () => {
    const s = await setupNy();
    await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: true },
    );
    const txns = await chapterTxns(s);
    const inkind = txns.filter((t) =>
      t.externalId?.startsWith("genesis-inkind-exp:"),
    );
    expect(inkind.length).toBe(37);
    for (const t of inkind) {
      expect(t.source).toBe("manual");
      expect(t.flow).toBe("outflow");
      expect(t.amountCents).toBeGreaterThan(0); // stored non-negative
      expect(t.note).toContain("paid personally by");
      expect(t.note).toContain("mirrors in-kind gift");
      expect(t.note).toContain("(genesis)");
    }
    // Every row's externalId is its own already-prefixed externalRef.
    expect(new Set(inkind.map((t) => t.externalId))).toEqual(
      new Set(GENESIS_INKIND_EXPENSE_ROWS.map((r) => r.externalRef)),
    );
    // Spot check one row's note carries both the funder and the source gift ref.
    const gear = inkind.find((t) => t.externalId === "genesis-inkind-exp:gear2024");
    expect(gear?.note).toContain("paid personally by Oluseyi Olujide");
    expect(gear?.note).toContain("mirrors in-kind gift genesis:gear2024");
  });

  test("date±2d / exact-amount dedup skips a row already in the live feed", async () => {
    const s = await setupNy();
    // Plant an existing NON-genesis txn matching the very first bank row
    // (Givebutter $105.00 inflow on Jun 9, 2025), one day off — inside ±2d.
    const first = GENESIS_BANK_ROWS[0];
    expect(first.amountCents).toBe(10500);
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "increase_ach",
        flow: "inflow",
        amountCents: 10500,
        currency: "usd",
        postedAt: utc("2025-06-10"), // 1 day after the genesis row's Jun 9
        status: "categorized",
        externalId: "increase_txn_planted",
        createdAt: Date.now(),
      }),
    );

    const dry = await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: false },
    );
    // Exactly one bank row is recognized as already present; the rest insert.
    expect(dry.bank.alreadyPresent).toBe(1);
    expect(dry.bank.inserted).toBe(212);

    // Execute honors the same skip: 212 bank + 3 LTN + 37 in-kind + the 1
    // planted row = 253.
    await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: true },
    );
    const txns = await chapterTxns(s);
    expect(txns.length).toBe(253);
    expect(txns.filter((t) => t.source === "relay_csv").length).toBe(212);
  });

  test("a second execute run is fully idempotent", async () => {
    const s = await setupNy();
    await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: true },
    );
    const rerun = await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: true },
    );
    expect(rerun.bank.inserted).toBe(0);
    expect(rerun.bank.alreadyPresent).toBe(213);
    expect(rerun.ltn.inserted).toBe(0);
    expect(rerun.ltn.alreadyPresent).toBe(3);
    expect(rerun.inkind.inserted).toBe(0);
    expect(rerun.inkind.alreadyPresent).toBe(37);
    // No net-new rows.
    const txns = await chapterTxns(s);
    expect(txns.length).toBe(253);
  });

  test("re-dispatch against a chapter that already has bank+ltn (#306's production state) inserts ONLY the new in-kind rows", async () => {
    const s = await setupNy();
    // #306 already shipped and ran in production: bank + ltn are already
    // present. In-kind is new in this PR and has never run.
    await seedPriorBankAndLtn(s);
    const preTxns = await chapterTxns(s);
    expect(preTxns.length).toBe(216);
    const preIds = new Set(preTxns.map((t) => t._id));

    const res = await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: true },
    );
    // Prior datasets are untouched: fully `alreadyPresent`, nothing inserted.
    expect(res.bank.inserted).toBe(0);
    expect(res.bank.alreadyPresent).toBe(213);
    expect(res.ltn.inserted).toBe(0);
    expect(res.ltn.alreadyPresent).toBe(3);
    // Only the 37 new in-kind rows land.
    expect(res.inkind.inserted).toBe(37);
    expect(res.inkind.alreadyPresent).toBe(0);

    const txns = await chapterTxns(s);
    expect(txns.length).toBe(253);
    // Every pre-existing bank/ltn row is exactly the same document — none were
    // duplicated, replaced, or otherwise touched.
    const survivingPreIds = txns.filter((t) => preIds.has(t._id));
    expect(survivingPreIds.length).toBe(216);
    // The 37 net-new rows are all in-kind.
    const newRows = txns.filter((t) => !preIds.has(t._id));
    expect(newRows.length).toBe(37);
    expect(newRows.every((t) => t.externalId?.startsWith("genesis-inkind-exp:"))).toBe(
      true,
    );
  });

  test("no NY chapter → typed NO_CHAPTER error", async () => {
    const t = newT();
    await expect(
      t.mutation(internal.financeGenesisBackfill.runFinanceGenesisBackfill, {
        execute: false,
      }),
    ).rejects.toMatchObject({ data: { code: "NO_CHAPTER" } });
  });
});
