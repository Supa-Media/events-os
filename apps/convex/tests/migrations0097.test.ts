import { describe, expect, test } from "vitest";
import { newT, run } from "./setup.helpers";
import { runLedgerPublishToTreasurers } from "../migrations/0097_ledger_publish_to_treasurers";
import { runRestoreLedgerPublishEdCd } from "../migrations/0098_restore_ledger_publish_ed_cd";

/**
 * 0097 — `finance.ledger.publish` onto chapter Treasurers.
 * 0098 — the same power back onto the Executive Director and Chapter
 * Director rows that the first version of 0097 removed it from in production.
 */
const now = Date.now();

async function seedSeat(
  t: ReturnType<typeof newT>,
  slug: string,
  capabilities: string[],
) {
  return await run(t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug,
      title: slug,
      chart: "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    } as never),
  );
}

async function capsOf(t: ReturnType<typeof newT>, id: unknown) {
  const row = (await run(t, (ctx) => ctx.db.get(id as never))) as {
    capabilities: string[];
  };
  return row.capabilities;
}

describe("0097_ledger_publish_to_treasurers", () => {
  test("grants Treasurers and touches no other seat", async () => {
    const t = newT();
    const treasurer = await seedSeat(t, "treasurer", ["finance.edit", "giving.view"]);
    const ed = await seedSeat(t, "executive_director", ["finance.ledger.publish", "org.chart.edit"]);

    const res = await run(t, (ctx) => runLedgerPublishToTreasurers(ctx));

    expect(res).toEqual({ granted: 1, skipped: 0 });
    expect(await capsOf(t, treasurer)).toEqual([
      "finance.edit",
      "giving.view",
      "finance.ledger.publish",
    ]);
    expect(await capsOf(t, ed)).toEqual(["finance.ledger.publish", "org.chart.edit"]);
  });

  test("is idempotent", async () => {
    const t = newT();
    await seedSeat(t, "treasurer", ["finance.edit"]);
    await run(t, (ctx) => runLedgerPublishToTreasurers(ctx));
    const again = await run(t, (ctx) => runLedgerPublishToTreasurers(ctx));
    expect(again).toEqual({ granted: 0, skipped: 1 });
  });
});

describe("0098_restore_ledger_publish_ed_cd", () => {
  test("puts the power back on ED and CD rows that lost it, and leaves the rest alone", async () => {
    const t = newT();
    const ed = await seedSeat(t, "executive_director", ["finance.accounts.view", "org.chart.edit"]);
    const cd = await seedSeat(t, "chapter_director", ["finance.view", "finance.ledger.publish"]);
    const fm = await seedSeat(t, "financial_manager", ["finance.edit"]);

    const res = await run(t, (ctx) => runRestoreLedgerPublishEdCd(ctx));

    expect(res).toEqual({ patched: 1, skipped: 1 });
    expect(await capsOf(t, ed)).toEqual([
      "finance.accounts.view",
      "org.chart.edit",
      "finance.ledger.publish",
    ]);
    expect(await capsOf(t, cd)).toEqual(["finance.view", "finance.ledger.publish"]);
    expect(await capsOf(t, fm)).toEqual(["finance.edit"]);
  });
});
