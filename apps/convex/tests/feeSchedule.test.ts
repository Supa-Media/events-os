import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";

/**
 * The STORED half of the fee schedule.
 *
 * The arithmetic is unit-tested in `packages/shared/src/processorFees.test.ts`;
 * what this file pins is the resolution rule, which is where a config table
 * usually goes wrong:
 *
 *  - an EMPTY table is the normal, correct state — the shipped rates apply and
 *    nothing has to be seeded;
 *  - a stored row overrides an existing rail and nothing else;
 *  - a stored row can never invent a rail the code has no support for;
 *  - a nonsense stored row degrades to the published rate rather than taking
 *    the public giving page down with it.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

describe("listFeeSchedule", () => {
  test("with an empty table, every rail reads at its published rate", async () => {
    const t = newT();
    const rails = await t.query(api.feeSchedule.listFeeSchedule, {});

    expect(rails).toHaveLength(3);
    expect(rails.every((r) => r.isDefault)).toBe(true);

    const card = rails.find((r) => r.processor === "stripe" && r.method === "card");
    expect(card).toMatchObject({
      percentBps: 290,
      fixedCents: 30,
      capCents: null,
      description: "2.9% + $0.30",
      processorLabel: "Stripe",
      methodLabel: "Card",
    });

    const ach = rails.find((r) => r.method === "ach_debit");
    expect(ach).toMatchObject({
      percentBps: 80,
      fixedCents: 0,
      capCents: 500,
      description: "0.8%, capped at $5.00",
    });
  });

  test("it is readable WITHOUT signing in — the giving page quotes prices to strangers", async () => {
    const t = newT();
    await expect(t.query(api.feeSchedule.listFeeSchedule, {})).resolves.toHaveLength(3);
  });

  test("a stored row overrides that rail, and only that rail", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.feeSchedule.setFeeRate, {
      processor: "stripe",
      method: "card",
      percentBps: 250,
      fixedCents: 25,
      note: "Negotiated nonprofit card pricing, effective August.",
    });

    const rails = await t.query(api.feeSchedule.listFeeSchedule, {});
    const card = rails.find((r) => r.method === "card")!;
    expect(card.percentBps).toBe(250);
    expect(card.fixedCents).toBe(25);
    expect(card.isDefault).toBe(false);

    // Untouched rails still read published.
    expect(rails.find((r) => r.method === "ach_debit")!.percentBps).toBe(80);
    expect(rails.find((r) => r.method === "wallet")!.isDefault).toBe(true);
  });

  test("a stored row for a rail the code doesn't have is IGNORED, never honoured", async () => {
    const t = newT();
    // Written around the mutation, as a bad migration or a dashboard edit would.
    await run(t, (ctx) =>
      ctx.db.insert("processorFeeSchedule", {
        processor: "venmo",
        method: "card",
        percentBps: 9_000,
        fixedCents: 0,
        updatedAt: Date.now(),
      }),
    );

    const rails = await t.query(api.feeSchedule.listFeeSchedule, {});
    expect(rails).toHaveLength(3);
    expect(rails.some((r) => String(r.processor) === "venmo")).toBe(false);
  });

  test("a nonsense stored rate falls back to the published one instead of breaking giving", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("processorFeeSchedule", {
        processor: "stripe",
        method: "card",
        percentBps: 12_000, // 120% — no gross-up has an answer at this rate
        fixedCents: 30,
        updatedAt: Date.now(),
      }),
    );

    const rails = await t.query(api.feeSchedule.listFeeSchedule, {});
    const card = rails.find((r) => r.method === "card")!;
    expect(card.percentBps).toBe(290);
    expect(card.isDefault).toBe(true);
  });
});

describe("setFeeRate", () => {
  test("a signed-out caller cannot re-price a rail", async () => {
    const t = newT();
    await expect(
      t.mutation(api.feeSchedule.setFeeRate, {
        processor: "stripe",
        method: "card",
        percentBps: 100,
        fixedCents: 0,
        note: "Trying it on from the internet.",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("an ordinary member cannot either", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.feeSchedule.setFeeRate, {
        processor: "stripe",
        method: "card",
        percentBps: 100,
        fixedCents: 0,
        note: "A perfectly reasonable-looking change.",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await run(t, (ctx) => ctx.db.query("processorFeeSchedule").collect())).toHaveLength(0);
  });

  test("a rail that doesn't exist can't be priced", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.feeSchedule.setFeeRate, {
        processor: "venmo",
        method: "card",
        percentBps: 190,
        fixedCents: 10,
        note: "Venmo pricing, for a rail we cannot charge.",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a rate that would break the gross-up is refused before a donor meets it", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.feeSchedule.setFeeRate, {
        processor: "stripe",
        method: "card",
        percentBps: 10_000,
        fixedCents: 30,
        note: "One hundred percent, entered by accident.",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a rate change has to say why", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.feeSchedule.setFeeRate, {
        processor: "stripe",
        method: "card",
        percentBps: 250,
        fixedCents: 25,
        note: "  ",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a second change updates the same row rather than stacking a second one", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    const first = await s.as.mutation(api.feeSchedule.setFeeRate, {
      processor: "stripe",
      method: "ach_debit",
      percentBps: 80,
      fixedCents: 0,
      capCents: 700,
      note: "Stripe raised the ACH cap to $7.00.",
    });
    expect(first.created).toBe(true);

    const second = await s.as.mutation(api.feeSchedule.setFeeRate, {
      processor: "stripe",
      method: "ach_debit",
      percentBps: 80,
      fixedCents: 0,
      capCents: 600,
      note: "Corrected — the new cap is $6.00.",
    });
    expect(second.created).toBe(false);

    const rows = await run(t, (ctx) => ctx.db.query("processorFeeSchedule").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].capCents).toBe(600);
    expect(rows[0].updatedBy).toBeTruthy();
  });

  test("clearing an override returns the rail to its published rate", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.feeSchedule.setFeeRate, {
      processor: "cash_app",
      method: "wallet",
      percentBps: 275,
      fixedCents: 0,
      note: "Cash App moved to the headline 2.75% with no fixed fee.",
    });
    expect(
      (await t.query(api.feeSchedule.listFeeSchedule, {})).find((r) => r.method === "wallet")!
        .percentBps,
    ).toBe(275);

    const cleared = await s.as.mutation(api.feeSchedule.clearFeeRateOverride, {
      processor: "cash_app",
      method: "wallet",
    });
    expect(cleared.cleared).toBe(true);

    const wallet = (await t.query(api.feeSchedule.listFeeSchedule, {})).find(
      (r) => r.method === "wallet",
    )!;
    expect(wallet.percentBps).toBe(260);
    expect(wallet.isDefault).toBe(true);
  });
});
