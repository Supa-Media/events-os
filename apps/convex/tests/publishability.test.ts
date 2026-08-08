/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * THE PUBLISHABILITY REPORT — the close-gate artifact
 * (`docs/plans/transaction-coding.md` phase 4).
 *
 * Public Worship is about to publish every transaction. This suite pins the
 * three things that decide whether the ED trusts the number:
 *
 *  1. THE AXES DON'T DOUBLE-COUNT. One charge missing a receipt, a coding AND
 *     a review is ONE blocked row, not three problems. `blocked` is the union
 *     and `overlap` is what makes the union reconcile with the per-axis
 *     counts on screen.
 *  2. PRE-POLICY SPEND OWES NO CODING. `codingRequiredSinceMs` grandfathers
 *     history (owner decision: 2026-09-01). A report that counted August's
 *     charges as an uncoded backlog would show a 100% gap the first time
 *     anyone opened it, and the report would never be opened again. So this
 *     file deliberately does NOT call `disarmCodingPolicy` — it pins an
 *     explicit policy date and seeds fixtures on BOTH sides of it.
 *  3. RECONSTRUCTED HISTORY IS NAMED, NOT MERGED. Rows rebuilt from a
 *     spreadsheet (`historicalImportBatch`, or a `genesis-` external id) can
 *     be green on all three axes and still not be the same claim as a
 *     live-captured row — they get their own line.
 *
 * Plus the publishing-vs-chase predicate divergences that are the whole reason
 * this isn't a rollup of the Reconcile grid's facet counts: a `reconciled` row
 * with no receipt is still a documentation gap (`isUndocumented` is
 * status-blind), and a coding sitting in review is not an approved coding.
 */

// The policy date this suite pins: 2026-09-01, the owner-decided default.
const POLICY_SINCE_MS = Date.UTC(2026, 8, 1);
// One charge comfortably inside October 2026 (post-policy) and one inside
// August 2026 (pre-policy). Mid-month so the Eastern-offset padding in the
// period scan can't drift either into a neighbouring month.
const OCT_2026 = Date.UTC(2026, 9, 15, 16);
const AUG_2026 = Date.UTC(2026, 7, 15, 16);

async function pinPolicy(s: ChapterSetup): Promise<void> {
  await run(s.t, async (ctx) => {
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { codingRequiredSinceMs: POLICY_SINCE_MS });
      return;
    }
    await ctx.db.insert("financeSettings", {
      sandboxMode: false,
      updatedAt: Date.now(),
      codingRequiredSinceMs: POLICY_SINCE_MS,
    });
  });
}

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

type TxnFixture = Partial<{
  book: Id<"chapters"> | "central";
  postedAt: number;
  amountCents: number;
  flow: "outflow" | "inflow" | "transfer";
  status: "unreviewed" | "categorized" | "reconciled" | "excluded";
  receipt: boolean;
  codingState: "uncoded" | "submitted" | "changes_requested" | "approved";
  historicalImportBatch: string;
  externalId: string;
  isPersonal: boolean;
}>;

/** Insert one transaction. A `receipt: true` row gets a real stored blob id,
 *  because `isUndocumented` reads `receiptStorageId` and nothing else. */
async function insertTxn(s: ChapterSetup, f: TxnFixture = {}): Promise<Id<"transactions">> {
  const storageId = f.receipt
    ? await run(s.t, (ctx) =>
        (
          ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }
        ).store(new Blob(["x"], { type: "image/png" })),
      )
    : undefined;
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: f.book ?? s.chapterId,
      source: "manual",
      flow: f.flow ?? "outflow",
      amountCents: f.amountCents ?? 1000,
      postedAt: f.postedAt ?? OCT_2026,
      status: f.status ?? "unreviewed",
      receiptStorageId: storageId,
      codingState: f.codingState,
      historicalImportBatch: f.historicalImportBatch,
      externalId: f.externalId,
      isPersonal: f.isPersonal,
      createdAt: Date.now(),
    }),
  );
}

/** A chapter treasurer who can read their own book's report. */
async function asChapterViewer(s: ChapterSetup): Promise<void> {
  const personId = await seedSelfPerson(s);
  await grantRole(s, personId, "viewer", "chapter");
}

/** A central Financial Manager — the only desk that may merge every book. */
async function asCentralManager(s: ChapterSetup): Promise<void> {
  const personId = await seedSelfPerson(s);
  await grantRole(s, personId, "manager", "central");
}

const octoberOf = (s: ChapterSetup) =>
  s.as.query(api.publishability.report, { year: 2026, month: 10 });

describe("publishability.report — the three axes", () => {
  test("a row open on all three axes is ONE blocked row, counted once per axis", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    // Post-policy spend: no receipt, no coding, not reconciled.
    await insertTxn(s, { amountCents: 5830 });

    const r = await octoberOf(s);
    expect(r).not.toBeNull();
    expect(r!.totals.inScope).toEqual({ count: 1, cents: 5830 });
    expect(r!.totals.blocked).toEqual({ count: 1, cents: 5830 });
    expect(r!.totals.publishable).toEqual({ count: 0, cents: 0 });
    expect(r!.totals.axes.documentation).toEqual({ count: 1, cents: 5830 });
    expect(r!.totals.axes.coding).toEqual({ count: 1, cents: 5830 });
    expect(r!.totals.axes.review).toEqual({ count: 1, cents: 5830 });
    // The overlap line is what keeps "1 blocked" from reading as a
    // contradiction next to three axis counts of 1.
    expect(r!.totals.overlap.threeAxes).toEqual({ count: 1, cents: 5830 });
    expect(r!.totals.overlap.twoAxes.count).toBe(0);
    expect(r!.totals.overlap.oneAxis.count).toBe(0);
  });

  test("all three green → publishable, and nothing lands on an axis", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, {
      amountCents: 2500,
      receipt: true,
      codingState: "approved",
      status: "reconciled",
    });

    const r = await octoberOf(s);
    expect(r!.totals.inScope).toEqual({ count: 1, cents: 2500 });
    expect(r!.totals.publishable).toEqual({ count: 1, cents: 2500 });
    expect(r!.totals.blocked).toEqual({ count: 0, cents: 0 });
    expect(r!.totals.axes.documentation.count).toBe(0);
    expect(r!.totals.axes.coding.count).toBe(0);
    expect(r!.totals.axes.review.count).toBe(0);
  });

  test("blocked is the UNION: axis counts sum higher, overlap reconciles them", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    // (a) review only — receipted + approved coding, still unreviewed.
    await insertTxn(s, { amountCents: 100, receipt: true, codingState: "approved" });
    // (b) documentation + coding — reconciled, but bare.
    await insertTxn(s, { amountCents: 200, status: "reconciled" });
    // (c) all three.
    await insertTxn(s, { amountCents: 400 });

    const r = await octoberOf(s);
    const t = r!.totals;
    expect(t.inScope).toEqual({ count: 3, cents: 700 });
    expect(t.blocked).toEqual({ count: 3, cents: 700 });
    const axisSum =
      t.axes.documentation.count + t.axes.coding.count + t.axes.review.count;
    expect(axisSum).toBe(6); // 1 + 2 + 2 + ... deliberately > blocked.count
    expect(t.overlap.oneAxis.count).toBe(1);
    expect(t.overlap.twoAxes.count).toBe(1);
    expect(t.overlap.threeAxes.count).toBe(1);
    // The identity that makes the two views reconcile on screen.
    expect(
      t.overlap.oneAxis.count + 2 * t.overlap.twoAxes.count + 3 * t.overlap.threeAxes.count,
    ).toBe(axisSum);
    expect(
      t.overlap.oneAxis.count + t.overlap.twoAxes.count + t.overlap.threeAxes.count,
    ).toBe(t.blocked.count);
    expect(t.inScope.count).toBe(t.blocked.count + t.publishable.count);
  });
});

describe("publishability.report — publishing predicates, not chase predicates", () => {
  test("a reconciled row with no receipt is STILL a documentation gap", async () => {
    // `needsDocumentation` (the Reconcile pill) stops chasing a closed row;
    // `isUndocumented` — the publishing predicate — does not. A treasurer who
    // quietly closed a document-less charge made a call that the public
    // ledger still has to answer for.
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, {
      amountCents: 900,
      status: "reconciled",
      codingState: "approved",
    });

    const r = await octoberOf(s);
    expect(r!.totals.axes.documentation).toEqual({ count: 1, cents: 900 });
    expect(r!.totals.axes.review.count).toBe(0);
    expect(r!.totals.blocked).toEqual({ count: 1, cents: 900 });
  });

  test("a coding sitting in review is not an approved coding", async () => {
    // `isUncoded` treats `submitted` as "waiting on the treasurer", so the
    // chase drops it. Publishability can't: only `approved` is green.
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, { amountCents: 700, receipt: true, codingState: "submitted" });
    await insertTxn(s, {
      amountCents: 300,
      receipt: true,
      codingState: "changes_requested",
    });

    const r = await octoberOf(s);
    expect(r!.totals.axes.coding).toEqual({ count: 2, cents: 1000 });
  });

  test("excluded rows are not part of the ledger being published", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, { amountCents: 4200, status: "excluded" });

    const r = await octoberOf(s);
    expect(r!.totals.inScope).toEqual({ count: 0, cents: 0 });
    expect(r!.totals.blocked.count).toBe(0);
  });
});

describe("publishability.report — the coding policy date", () => {
  test("pre-policy spend owes NO coding and never inflates the coding gap", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    // August 2026 — before the 2026-09-01 policy date. Bare: no receipt, no
    // coding, unreviewed.
    await insertTxn(s, { postedAt: AUG_2026, amountCents: 15000 });

    const august = await s.as.query(api.publishability.report, {
      year: 2026,
      month: 8,
    });
    expect(august!.totals.inScope).toEqual({ count: 1, cents: 15000 });
    // The whole point: documentation and review still bite, coding does not.
    expect(august!.totals.axes.documentation.count).toBe(1);
    expect(august!.totals.axes.review.count).toBe(1);
    expect(august!.totals.axes.coding).toEqual({ count: 0, cents: 0 });
    // ...and the exemption is stated rather than silent.
    expect(august!.totals.codingExempt).toEqual({ count: 1, cents: 15000 });
    expect(august!.codingPolicySinceMs).toBe(POLICY_SINCE_MS);
    // Two open axes, not three — an uncoded pre-policy row is not a
    // three-axis failure.
    expect(august!.totals.overlap.twoAxes.count).toBe(1);
    expect(august!.totals.overlap.threeAxes.count).toBe(0);
  });

  test("an otherwise-perfect pre-policy row is publishable without a coding", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, {
      postedAt: AUG_2026,
      amountCents: 6000,
      receipt: true,
      status: "reconciled",
    });

    const r = await s.as.query(api.publishability.report, { year: 2026, month: 8 });
    expect(r!.totals.publishable).toEqual({ count: 1, cents: 6000 });
    expect(r!.totals.codingExempt).toEqual({ count: 1, cents: 6000 });
  });

  test("non-spend rows are exempt from coding but not invented into codingExempt", async () => {
    // An inflow owes no coding (`requiresCoding` gates on `isSpend`) and is
    // not grandfathered SPEND either — `codingExempt` is about the policy
    // date, so counting a donation there would be a lie about the period.
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, { flow: "inflow", amountCents: 50000, status: "reconciled" });

    const r = await octoberOf(s);
    expect(r!.totals.inScope).toEqual({ count: 1, cents: 50000 });
    expect(r!.totals.axes.coding.count).toBe(0);
    expect(r!.totals.axes.documentation.count).toBe(0);
    expect(r!.totals.codingExempt).toEqual({ count: 0, cents: 0 });
    expect(r!.totals.publishable.count).toBe(1);
  });
});

describe("publishability.report — reconstructed history", () => {
  test("rebuilt rows get their own line instead of quietly boosting the green count", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    // A live-captured, fully green row.
    await insertTxn(s, {
      amountCents: 1000,
      receipt: true,
      codingState: "approved",
      status: "reconciled",
    });
    // A spreadsheet reconstruction that is ALSO green on all three axes.
    await insertTxn(s, {
      amountCents: 2000,
      receipt: true,
      codingState: "approved",
      status: "reconciled",
      historicalImportBatch: "genesis-2026-08",
    });
    // A reconstruction that is still blocked.
    await insertTxn(s, { amountCents: 3000, historicalImportBatch: "genesis-2026-08" });

    const r = await octoberOf(s);
    expect(r!.totals.publishable).toEqual({ count: 2, cents: 3000 });
    expect(r!.totals.reconstructed.inScope).toEqual({ count: 2, cents: 5000 });
    expect(r!.totals.reconstructed.publishable).toEqual({ count: 1, cents: 2000 });
    expect(r!.totals.reconstructed.blocked).toEqual({ count: 1, cents: 3000 });
  });

  test("the original genesis backfill is recognized by its externalId prefix", async () => {
    // Prod rows from the first backfill carry no `historicalImportBatch` —
    // `isReconstructedHistory` reads the `genesis-` external id so nothing had
    // to be migrated to be labelled honestly.
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, { amountCents: 1234, externalId: "genesis-0042" });

    const r = await octoberOf(s);
    expect(r!.totals.reconstructed.inScope).toEqual({ count: 1, cents: 1234 });
  });
});

describe("publishability.report — period scope", () => {
  test("a month reports only that month; the year reports all of it", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, { postedAt: AUG_2026, amountCents: 100 });
    await insertTxn(s, { postedAt: OCT_2026, amountCents: 200 });
    // A neighbouring year must never leak in through the padded UTC window.
    await insertTxn(s, { postedAt: Date.UTC(2025, 11, 31, 20), amountCents: 999 });

    const oct = await octoberOf(s);
    expect(oct!.totals.inScope).toEqual({ count: 1, cents: 200 });
    expect(oct!.period.label).toBe("October 2026");

    const year = await s.as.query(api.publishability.report, { year: 2026 });
    expect(year!.totals.inScope).toEqual({ count: 2, cents: 300 });
    expect(year!.period).toEqual({ year: 2026, month: null, label: "2026" });
  });
});

describe("publishability.report — access", () => {
  test("a finance viewer reads their own book", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await insertTxn(s, { amountCents: 100 });

    const r = await octoberOf(s);
    expect(r!.byBook).toHaveLength(1);
    expect(r!.byBook[0].id).toBe(s.chapterId);
  });

  test("no finance grant at all is refused", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await seedSelfPerson(s); // roster row, but no `financeRoles` grant
    await expect(octoberOf(s)).rejects.toThrow(ConvexError);
  });

  test("a chapter-only treasurer may not merge every book", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asChapterViewer(s);
    await expect(
      s.as.query(api.publishability.report, { year: 2026, month: 10, scope: "all" }),
    ).rejects.toThrow(ConvexError);
    // ...nor read central-owned money.
    await expect(
      s.as.query(api.publishability.report, {
        year: 2026,
        month: 10,
        scope: "central",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("scope:'all' merges central + every active chapter, and keeps them apart in byBook", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asCentralManager(s);
    const other = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Chicago", isActive: true, createdAt: Date.now() }),
    );
    // A shadow/pre-launch territory — `listActiveChapters` must keep it out.
    await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Shadow", isActive: false, createdAt: Date.now() }),
    );
    await insertTxn(s, { amountCents: 100 });
    await insertTxn(s, { book: "central", amountCents: 200 });
    await insertTxn(s, { book: other, amountCents: 400 });

    const r = await s.as.query(api.publishability.report, {
      year: 2026,
      month: 10,
      scope: "all",
    });
    expect(r!.totals.inScope).toEqual({ count: 3, cents: 700 });
    expect(r!.byBook).toHaveLength(3);
    const byId = new Map(r!.byBook.map((b) => [b.id, b]));
    expect(byId.get("central")!.totals.inScope).toEqual({ count: 1, cents: 200 });
    expect(byId.get(s.chapterId)!.totals.inScope).toEqual({ count: 1, cents: 100 });
    expect(byId.get(other)!.totals.inScope).toEqual({ count: 1, cents: 400 });
    expect(byId.get("central")!.name).toBe("Central");
    expect(byId.get(other)!.name).toBe("Chicago");
    // Every per-book line must sum back to the merged one, or the drill-down
    // contradicts the headline.
    const summed = r!.byBook.reduce((n, b) => n + b.totals.inScope.cents, 0);
    expect(summed).toBe(r!.totals.inScope.cents);
  });

  test("a central viewer can drill into one specific chapter's book", async () => {
    const s = await setupChapter(newT());
    await pinPolicy(s);
    await asCentralManager(s);
    const other = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Chicago", isActive: true, createdAt: Date.now() }),
    );
    await insertTxn(s, { amountCents: 100 });
    await insertTxn(s, { book: other, amountCents: 400 });

    const r = await s.as.query(api.publishability.report, {
      year: 2026,
      month: 10,
      chapterId: other,
    });
    expect(r!.totals.inScope).toEqual({ count: 1, cents: 400 });
    expect(r!.byBook[0].name).toBe("Chicago");
  });
});
