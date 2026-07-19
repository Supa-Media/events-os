import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { GENESIS_BANK_ROWS } from "../lib/seed/historical/genesisBank";
import { GENESIS_LTN_ROWS } from "../lib/seed/historical/genesisLtn";
import { parseGenesisDate } from "../financeGenesisBackfill";

/**
 * Finance genesis backfill: the ops-only runner that loads the org's full
 * financial history — Kansi's 213-row Relay bank export + the 3 owner-paid Love
 * Thy Neighbor Zelle expenses — into `transactions` on the NY chapter, where the
 * reconcile grid reads from.
 *
 * Covers: dataset integrity (row counts + signed-total sanity + sign/type
 * agreement); dry run writes nothing but predicts the counts; execute inserts
 * and the rows are visible to `finances.listReconcile`; the ±2d/amount dedup
 * skips a planted live-feed row; a second execute run is fully idempotent; and
 * the LTN payments land as `manual` outflows carrying the "paid personally"
 * note.
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
    expect(res.netCents).toBe(327214 - 350000);

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

    const txns = await chapterTxns(s);
    expect(txns.length).toBe(216);
    // Bank rows carry the existing `relay_csv` import source; LTN rows `manual`.
    expect(txns.filter((t) => t.source === "relay_csv").length).toBe(213);
    expect(txns.filter((t) => t.source === "manual").length).toBe(3);
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
    expect(reconcile.counts.all).toBe(216);
    expect(reconcile.rows.length).toBe(216);
    // Every genesis row is unreviewed → the whole set shows under "uncategorized".
    expect(reconcile.counts.uncategorized).toBe(216);
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

    // Execute honors the same skip: 212 bank + 3 LTN + the 1 planted row = 216.
    await s.t.mutation(
      internal.financeGenesisBackfill.runFinanceGenesisBackfill,
      { execute: true },
    );
    const txns = await chapterTxns(s);
    expect(txns.length).toBe(216);
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
    // No net-new rows.
    const txns = await chapterTxns(s);
    expect(txns.length).toBe(216);
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
