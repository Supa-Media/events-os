import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runLabelFeeCoverageRows } from "../migrations/0075_label_fee_coverage_rows";
import { FEE_COVERAGE_LABEL } from "../cards";

/**
 * MIGRATION 0075 — naming the coverage rows that shipped nameless.
 *
 * Unlike its neighbours in this wave, it moves no money, so the interesting
 * question is not "does it hit the right row" but "does it leave a human's work
 * alone". A label is the cheapest thing in the ledger to overwrite and one of
 * the more annoying to lose.
 */

/** A fund + category pair, the shape every category in this schema needs. */
async function seedFund(s: ChapterSetup) {
  return run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(s: ChapterSetup, name: string) {
  const fundId = await seedFund(s);
  return run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name,
      kind: "lineItem",
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedCoverageRow(
  s: ChapterSetup,
  opts: { merchantName?: string; withCategory?: boolean } = {},
) {
  let categoryId: string | undefined;
  if (opts.withCategory) {
    categoryId = String(await seedCategory(s, "Something A Human Chose"));
  }
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "repayment",
      flow: "inflow",
      amountCents: 49,
      currency: "usd",
      postedAt: Date.now(),
      feeCoverageOrigin: "repayment",
      externalId: "stripe_repayment_fee_coverage:cs_x",
      status: "reconciled",
      ...(opts.merchantName ? { merchantName: opts.merchantName } : {}),
      ...(categoryId ? { categoryId: categoryId as never } : {}),
      createdAt: Date.now(),
    }),
  );
}

/** The category the fee sweep books to, which coverage joins. */
async function seedFeeCategory(s: ChapterSetup) {
  return seedCategory(s, "Bank & Fees");
}

describe("it fills the absence", () => {
  test("a nameless coverage row gets the label and the fee category", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const feeCategory = await seedFeeCategory(s);
    const id = await seedCoverageRow(s);

    const result = await run(s.t, (ctx) => runLabelFeeCoverageRows(ctx));

    expect(result.labelled).toBe(1);
    expect(result.categorised).toBe(1);
    const row = await run(s.t, (ctx) => ctx.db.get(id));
    expect(row?.merchantName).toBe(FEE_COVERAGE_LABEL);
    expect(row?.categoryId).toBe(feeCategory);
  });

  test("a book with no 'Bank & Fees' category still gets its label", async () => {
    // A missing category must not cost the row its name.
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedCoverageRow(s);

    const result = await run(s.t, (ctx) => runLabelFeeCoverageRows(ctx));

    expect(result.labelled).toBe(1);
    expect(result.categorised).toBe(0);
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.merchantName).toBe(
      FEE_COVERAGE_LABEL,
    );
  });

  test("running it twice changes nothing the second time", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedFeeCategory(s);
    const id = await seedCoverageRow(s);

    await run(s.t, (ctx) => runLabelFeeCoverageRows(ctx));
    const second = await run(s.t, (ctx) => runLabelFeeCoverageRows(ctx));

    expect(second.labelled).toBe(0);
    expect(second.categorised).toBe(0);
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.merchantName).toBe(
      FEE_COVERAGE_LABEL,
    );
  });
});

describe("it never overwrites a decision", () => {
  test("a merchant name somebody typed survives", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedFeeCategory(s);
    const id = await seedCoverageRow(s, { merchantName: "Seyi's fee, Aug" });

    const result = await run(s.t, (ctx) => runLabelFeeCoverageRows(ctx));

    expect(result.labelled).toBe(0);
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.merchantName).toBe(
      "Seyi's fee, Aug",
    );
  });

  test("a category a bookkeeper chose survives", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedFeeCategory(s);
    const id = await seedCoverageRow(s, { withCategory: true });

    const result = await run(s.t, (ctx) => runLabelFeeCoverageRows(ctx));

    expect(result.categorised).toBe(0);
    const row = await run(s.t, (ctx) => ctx.db.get(id));
    const chosen = await run(s.t, (ctx) => ctx.db.get(row!.categoryId!));
    expect(chosen?.name).toBe("Something A Human Chose");
    // …and it still gets its name, because those are separate absences.
    expect(row?.merchantName).toBe(FEE_COVERAGE_LABEL);
  });

  test("rows that are not fee coverage are untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 5_000,
        currency: "usd",
        postedAt: Date.now(),
        status: "categorized",
        createdAt: Date.now(),
      }),
    );

    const result = await run(s.t, (ctx) => runLabelFeeCoverageRows(ctx));

    expect(result.labelled).toBe(0);
    expect(result.categorised).toBe(0);
  });
});
