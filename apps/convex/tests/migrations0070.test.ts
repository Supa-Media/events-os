/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runLinkWireGiftsToTheirDeposit } from "../migrations/0070_link_wire_gifts_to_their_deposit";
import type { Id } from "../_generated/dataModel";

/**
 * Migration 0070 — match already-recorded WIRE gifts to the bank credit that
 * delivered them. See the migration's module doc for the double count behind
 * it; the headline case is the founder's $7,000 wire recorded as $5,000 for
 * central and $2,000 for the chapter.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** 2026-03-26, the day the founder's wire was recorded. */
const WIRE_DAY = Date.UTC(2026, 2, 26, 14);

async function seedGift(
  s: ChapterSetup,
  fields: {
    amountCents: number;
    scope?: Id<"chapters"> | "central";
    receivedAt?: number;
    method?: "wire" | "zelle" | "cash" | "stripe";
    transactionId?: Id<"transactions">;
  },
): Promise<Id<"gifts">> {
  const scope = fields.scope ?? s.chapterId;
  return run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope,
      kind: "individual",
      name: "Oluseyi Olujide",
      status: "active",
      lifetimeCents: fields.amountCents,
      giftCount: 1,
      createdAt: Date.now(),
    });
    return ctx.db.insert("gifts", {
      donorId,
      scope,
      amountCents: fields.amountCents,
      currency: "usd",
      receivedAt: fields.receivedAt ?? WIRE_DAY,
      method: fields.method ?? "wire",
      transactionId: fields.transactionId,
      createdAt: Date.now(),
    });
  });
}

async function seedCredit(
  s: ChapterSetup,
  fields: {
    amountCents: number;
    postedAt?: number;
    flow?: "inflow" | "outflow";
    merchantName?: string;
    cardId?: Id<"cards">;
  },
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "relay_csv",
      flow: fields.flow ?? "inflow",
      amountCents: fields.amountCents,
      postedAt: fields.postedAt ?? WIRE_DAY,
      status: "unreviewed",
      merchantName: fields.merchantName,
      cardId: fields.cardId,
      createdAt: Date.now(),
    }),
  );
}

async function giftLinks(s: ChapterSetup): Promise<(string | undefined)[]> {
  const gifts = await run(s.t, (ctx) => ctx.db.query("gifts").collect());
  return gifts
    .sort((a, b) => b.amountCents - a.amountCents)
    .map((g) => g.transactionId as string | undefined);
}

describe("0070_link_wire_gifts_to_their_deposit", () => {
  test("the founder's split: two wire gifts on one day claim one deposit", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const wire = await seedCredit(s, {
      amountCents: 700_000,
      merchantName: "OLUSEYI OLUJIDE",
    });
    await seedGift(s, { amountCents: 500_000, scope: "central" });
    await seedGift(s, { amountCents: 200_000 });

    const res = await run(s.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx));
    expect(res).toEqual({
      wireGifts: 2,
      groups: 1,
      linkedGroups: 1,
      linkedGifts: 2,
      skippedGroups: 0,
    });
    // BOTH gifts point at the one deposit, across two different books.
    expect(await giftLinks(s)).toEqual([wire, wire]);
  });

  test("is idempotent — a second run links nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCredit(s, { amountCents: 700_000 });
    await seedGift(s, { amountCents: 500_000, scope: "central" });
    await seedGift(s, { amountCents: 200_000 });

    await run(s.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx));
    const second = await run(s.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx));
    expect(second.wireGifts).toBe(0);
    expect(second.linkedGifts).toBe(0);
  });

  test("two deposits that both fit is an ambiguity it refuses to resolve", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCredit(s, { amountCents: 700_000 });
    await seedCredit(s, { amountCents: 700_000, postedAt: WIRE_DAY + DAY_MS });
    await seedGift(s, { amountCents: 700_000 });

    const res = await run(s.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx));
    expect(res.linkedGifts).toBe(0);
    expect(res.skippedGroups).toBe(1);
    expect(await giftLinks(s)).toEqual([undefined]);
  });

  test("leaves a deposit alone when the total doesn't match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCredit(s, { amountCents: 700_000 });
    await seedGift(s, { amountCents: 500_000 });

    const res = await run(s.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx));
    expect(res.linkedGifts).toBe(0);
    expect(res.skippedGroups).toBe(1);
  });

  test("never claims a card refund or a processor payout as a wire", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const cardId = await run(s.t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Cardholder",
        createdAt: Date.now(),
      });
      return ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: personId,
        type: "physical",
        status: "active",
        createdAt: Date.now(),
      });
    });
    await seedCredit(s, { amountCents: 500_000, cardId });
    await seedGift(s, { amountCents: 500_000 });

    expect(
      (await run(s.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx))).linkedGifts,
    ).toBe(0);

    // Same shape, but the credit's descriptor names a processor.
    const t2 = newT();
    const s2 = await setupChapter(t2);
    await seedCredit(s2, { amountCents: 500_000, merchantName: "STRIPE PAYOUT" });
    await seedGift(s2, { amountCents: 500_000 });
    expect(
      (await run(s2.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx))).linkedGifts,
    ).toBe(0);
  });

  test("only WIRE gifts, and only ones nobody has matched yet", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCredit(s, { amountCents: 500_000 });
    // A cash gift never arrived as its own bank row, so it is out of scope …
    await seedGift(s, { amountCents: 500_000, method: "cash" });
    // … and a wire already matched by hand is left exactly as it is.
    const other = await seedCredit(s, {
      amountCents: 300_000,
      postedAt: WIRE_DAY - 40 * DAY_MS,
    });
    await seedGift(s, {
      amountCents: 300_000,
      receivedAt: WIRE_DAY - 40 * DAY_MS,
      transactionId: other,
    });

    const res = await run(s.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx));
    expect(res.wireGifts).toBe(0);
    expect(res.linkedGifts).toBe(0);
  });

  test("a deposit another gift already covers is not claimed twice", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const wire = await seedCredit(s, { amountCents: 500_000 });
    await seedGift(s, {
      amountCents: 500_000,
      receivedAt: WIRE_DAY,
      transactionId: wire,
    });
    // A second, unlinked wire gift of the same size on the same day.
    await seedGift(s, { amountCents: 500_000 });

    const res = await run(s.t, (ctx) => runLinkWireGiftsToTheirDeposit(ctx));
    expect(res.linkedGifts).toBe(0);
    expect(res.skippedGroups).toBe(1);
  });
});
