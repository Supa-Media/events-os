import { describe, expect, test } from "vitest";
import { newT, run } from "./setup.helpers";
import { runLedgerPublishToTreasurers } from "../migrations/0097_ledger_publish_to_treasurers";

/**
 * 0097 — `finance.ledger.publish` moves onto chapter Treasurers and off the
 * Executive Director and Chapter Director. The Financial Manager keeps it.
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
  test("grants Treasurers, revokes the ED and CD, leaves the FM and other powers alone", async () => {
    const t = newT();
    const treasurer = await seedSeat(t, "treasurer", ["finance.edit", "giving.view"]);
    const ed = await seedSeat(t, "executive_director", [
      "finance.accounts.view",
      "finance.ledger.publish",
      "org.chart.edit",
    ]);
    const cd = await seedSeat(t, "chapter_director", ["finance.view", "finance.ledger.publish"]);
    const fm = await seedSeat(t, "financial_manager", ["finance.edit", "finance.ledger.publish"]);

    const res = await run(t, (ctx) => runLedgerPublishToTreasurers(ctx));

    expect(res).toEqual({ granted: 1, revoked: 2 });
    expect(await capsOf(t, treasurer)).toEqual([
      "finance.edit",
      "giving.view",
      "finance.ledger.publish",
    ]);
    expect(await capsOf(t, ed)).toEqual(["finance.accounts.view", "org.chart.edit"]);
    expect(await capsOf(t, cd)).toEqual(["finance.view"]);
    expect(await capsOf(t, fm)).toEqual(["finance.edit", "finance.ledger.publish"]);
  });

  test("is idempotent", async () => {
    const t = newT();
    await seedSeat(t, "treasurer", ["finance.edit"]);
    await seedSeat(t, "executive_director", ["finance.ledger.publish"]);

    await run(t, (ctx) => runLedgerPublishToTreasurers(ctx));
    const again = await run(t, (ctx) => runLedgerPublishToTreasurers(ctx));

    expect(again).toEqual({ granted: 0, revoked: 0 });
  });
});
