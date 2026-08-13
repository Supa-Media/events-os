/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { runStampCashbackSourceCategory } from "../migrations/0066_stamp_cashback_source_category";

/**
 * `0066_stamp_cashback_source_category` — the one-time stamp that gives
 * pre-field Increase cashback rows the `sourceCategory` marker
 * `autoExplainedKind` keys on. Pins the three things a re-run must never get
 * wrong: description-prefix-and-source-only (a manual row or an ordinary ACH
 * inflow is never touched), additive-only (an already-set `sourceCategory`
 * is never overwritten), and idempotence.
 */

async function insertRow(
  s: ChapterSetup,
  opts: {
    source?: "manual" | "increase_ach";
    externalId?: string;
    description?: string;
    sourceCategory?: string;
  } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: opts.source ?? "increase_ach",
      flow: "inflow",
      amountCents: 71,
      postedAt: Date.UTC(2026, 6, 31, 16),
      status: "unreviewed",
      description: opts.description,
      externalId: opts.externalId,
      sourceCategory: opts.sourceCategory,
      createdAt: Date.now(),
    }),
  );
}

describe("0066_stamp_cashback_source_category", () => {
  test("stamps exactly the pre-field Increase cashback rows — nothing else", async () => {
    const s = await setupChapter(newT());
    const cashback = await insertRow(s, {
      externalId: "transaction_abc123",
      description: "Cashback payment for 2026-07 for Jess",
    });
    // An ordinary inbound ACH — same source, same id shape, not cashback.
    const ordinary = await insertRow(s, {
      externalId: "transaction_def456",
      description: "PAYPAL TRANSFER",
    });
    // A row that already carries the provider category (post-field
    // ingestion) — additive-only, never overwritten.
    const alreadySet = await insertRow(s, {
      externalId: "transaction_ghi789",
      description: "Cashback payment for 2026-08 for Sam",
      sourceCategory: "cashback_payment",
    });
    // A non-Increase row whose description happens to match — out of scope
    // by externalId range AND by source.
    const manual = await insertRow(s, {
      source: "manual",
      description: "Cashback payment scribbled by hand",
    });

    const result = await run(s.t, (ctx) => runStampCashbackSourceCategory(ctx));
    expect(result.stamped).toBe(1);
    expect(result.truncated).toBe(false);

    const get = (id: Id<"transactions">) => run(s.t, (ctx) => ctx.db.get(id));
    expect((await get(cashback))?.sourceCategory).toBe("cashback_payment");
    expect((await get(ordinary))?.sourceCategory).toBeUndefined();
    expect((await get(alreadySet))?.sourceCategory).toBe("cashback_payment");
    expect((await get(manual))?.sourceCategory).toBeUndefined();
  });

  test("idempotent — a second run stamps nothing", async () => {
    const s = await setupChapter(newT());
    await insertRow(s, {
      externalId: "transaction_abc123",
      description: "Cashback payment for 2026-07 for Jess",
    });
    await run(s.t, (ctx) => runStampCashbackSourceCategory(ctx));
    const second = await run(s.t, (ctx) => runStampCashbackSourceCategory(ctx));
    expect(second.stamped).toBe(0);
  });
});
