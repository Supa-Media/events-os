import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runStampInterestSourceCategory } from "../migrations/0078_stamp_interest_source_category";
import { INTEREST_SOURCE_CATEGORY, CASHBACK_SOURCE_CATEGORY } from "@events-os/shared";

/**
 * 0078 — the interest half of 0066. Historical Increase interest rows never
 * got `sourceCategory`, so `autoExplainedKind` could not recognize them and
 * the reconciliation panel offered bank interest as giving "recorded as
 * nothing".
 */
async function seedTxn(
  s: ChapterSetup,
  over: Record<string, unknown>,
): Promise<string> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "increase_ach",
      flow: "inflow",
      amountCents: 85,
      postedAt: Date.now(),
      status: "reconciled",
      createdAt: Date.now(),
      ...over,
    } as never),
  );
}

describe("0078_stamp_interest_source_category", () => {
  test("stamps an unmarked Increase interest row", async () => {
    const s = await setupChapter(newT());
    const id = await seedTxn(s, {
      externalId: "transaction_abc",
      description: "Interest payment for 2026-07",
    });

    const res = await run(s.t, (ctx) => runStampInterestSourceCategory(ctx));

    expect(res.stamped).toBe(1);
    expect(res.truncated).toBe(false);
    const row = await run(s.t, (ctx) => ctx.db.get(id as never));
    expect((row as { sourceCategory?: string }).sourceCategory).toBe(INTEREST_SOURCE_CATEGORY);
  });

  test("never touches a row that already carries a category", async () => {
    const s = await setupChapter(newT());
    const id = await seedTxn(s, {
      externalId: "transaction_def",
      description: "Interest payment for 2026-07",
      sourceCategory: CASHBACK_SOURCE_CATEGORY,
    });

    const res = await run(s.t, (ctx) => runStampInterestSourceCategory(ctx));

    expect(res.stamped).toBe(0);
    const row = await run(s.t, (ctx) => ctx.db.get(id as never));
    expect((row as { sourceCategory?: string }).sourceCategory).toBe(CASHBACK_SOURCE_CATEGORY);
  });

  test("leaves non-interest and non-Increase rows alone", async () => {
    const s = await setupChapter(newT());
    await seedTxn(s, { externalId: "transaction_ghi", description: "Cashback payment for 2026-07" });
    await seedTxn(s, { externalId: "transaction_jkl", description: "ACH credit from a donor" });
    // A CSV row whose text happens to match — outside the Increase id range,
    // so the index scope alone excludes it.
    await seedTxn(s, {
      externalId: "relay_csv:1:85:x",
      source: "relay_csv",
      description: "Interest payment for 2026-07",
    });

    const res = await run(s.t, (ctx) => runStampInterestSourceCategory(ctx));

    expect(res.stamped).toBe(0);
  });

  test("is idempotent", async () => {
    const s = await setupChapter(newT());
    await seedTxn(s, { externalId: "transaction_mno", description: "Interest payment for 2026-07" });

    await run(s.t, (ctx) => runStampInterestSourceCategory(ctx));
    const second = await run(s.t, (ctx) => runStampInterestSourceCategory(ctx));

    expect(second.stamped).toBe(0);
  });
});
