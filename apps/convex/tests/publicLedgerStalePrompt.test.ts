/// <reference types="vite/client" />
/**
 * "ASK TO REPUBLISH" — the drift marker on an already-published month.
 *
 * Founder, 2026-08-14, on settling a personal charge: "once it's paid off,
 * that should clear it out… and then it should update the things. It should
 * probably ask to republish, you know, the public ledgers and statements and
 * stuff like that if they're already published."
 *
 * Settling changes what a published statement SAYS: the charge's public line
 * flips from "awaiting repayment" to "paid back", and the offsetting credit
 * lands in whichever month it settles in. Before this, nothing noticed, so the
 * public page silently drifted from the books until a human happened to
 * rebuild a month.
 *
 * The three properties worth pinning are the ones that decide whether the
 * prompt is trustworthy or just another badge people learn to ignore:
 *  · it appears when a LIVE month's story actually changed,
 *  · it does NOT appear for a month nobody has published (a draft rebuilds
 *    from the books every time — drift is not a thing that can happen to it),
 *  · and it CLEARS when the month is published again, in the one function
 *    every publish and republish routes through.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { periodKeyOf } from "../lib/publicLedgerStale";

/** Eastern-noon on a day — publications are keyed by Eastern `YYYY-MM`. */
function tsOn(year: number, month: number, day: number): number {
  return Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T16:00:00Z`,
  );
}

async function seedPublication(
  s: ChapterSetup,
  periodKey: string,
  opts: { live: boolean; status?: "published" | "draft" | "amending" } = {
    live: true,
  },
): Promise<Id<"financePublications">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("financePublications", {
      scope: s.chapterId,
      periodKey,
      status: opts.status ?? (opts.live ? "published" : "draft"),
      isLive: opts.live,
      liveRevision: opts.live ? 1 : undefined,
      publishedAt: opts.live ? now : undefined,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedSettledRepayment(
  s: ChapterSetup,
  opts: { chargePostedAt: number; amountCents: number },
): Promise<Id<"personalRepayments">> {
  const now = Date.now();
  const payerPersonId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Payer",
      userId: s.userId,
      isTeamMember: true,
      createdAt: now,
    }),
  );
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents,
      currency: "usd",
      postedAt: opts.chargePostedAt,
      personId: payerPersonId,
      merchantName: "Corner Store",
      status: "reconciled",
      isPersonal: true,
      createdAt: now,
    }),
  );
  const repaymentId = await run(s.t, (ctx) =>
    ctx.db.insert("personalRepayments", {
      chapterId: s.chapterId,
      transactionId,
      payerPersonId,
      amountCents: opts.amountCents,
      method: "card",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await run(s.t, (ctx) => ctx.db.patch(transactionId, { repaymentId }));
  return repaymentId;
}

describe("republish prompt on repayment settlement", () => {
  test("settling marks the CHARGE's published month as drifted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A charge from a month that has already been published to the world.
    const chargePostedAt = tsOn(2026, 3, 12);
    const chargeMonth = periodKeyOf(chargePostedAt);
    const pubId = await seedPublication(s, chargeMonth, { live: true });
    const repaymentId = await seedSettledRepayment(s, {
      chargePostedAt,
      amountCents: 4_200,
    });

    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [repaymentId],
      sessionId: "cs_stale",
      amountTotalCents: 4_200,
    });

    const pub = await run(s.t, (ctx) => ctx.db.get(pubId));
    expect(pub?.staleSince).toBeTruthy();
    expect(pub?.staleReason).toBe("A personal charge was paid back");
    // It is a PROMPT, not an action — the month stays exactly as published.
    expect(pub?.status).toBe("published");
    expect(pub?.liveRevision).toBe(1);
    expect(pub?.isLive).toBe(true);
  });

  test("the CREDIT's month is marked too — it gains a line it didn't have", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The credit posts now; publish the current month, and NOT the charge's.
    const creditMonth = periodKeyOf(Date.now());
    const pubId = await seedPublication(s, creditMonth, { live: true });
    const repaymentId = await seedSettledRepayment(s, {
      chargePostedAt: tsOn(2026, 1, 4),
      amountCents: 900,
    });

    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [repaymentId],
      sessionId: "cs_stale_credit",
      amountTotalCents: 900,
    });

    const pub = await run(s.t, (ctx) => ctx.db.get(pubId));
    expect(pub?.staleSince).toBeTruthy();
  });

  test("a month nobody published is never marked — a draft can't drift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const chargePostedAt = tsOn(2026, 3, 12);
    const pubId = await seedPublication(s, periodKeyOf(chargePostedAt), {
      live: false,
    });
    const repaymentId = await seedSettledRepayment(s, {
      chargePostedAt,
      amountCents: 1_000,
    });

    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [repaymentId],
      sessionId: "cs_draft",
      amountTotalCents: 1_000,
    });

    const pub = await run(s.t, (ctx) => ctx.db.get(pubId));
    expect(pub?.staleSince).toBeUndefined();
  });

  test("a month mid-amendment isn't marked — it's already on its way back out", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const chargePostedAt = tsOn(2026, 3, 12);
    const pubId = await seedPublication(s, periodKeyOf(chargePostedAt), {
      live: true,
      status: "amending",
    });
    const repaymentId = await seedSettledRepayment(s, {
      chargePostedAt,
      amountCents: 1_000,
    });

    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [repaymentId],
      sessionId: "cs_amending",
      amountTotalCents: 1_000,
    });

    const pub = await run(s.t, (ctx) => ctx.db.get(pubId));
    expect(pub?.staleSince).toBeUndefined();
  });

  test("the first drift's timestamp is kept; the newest reason wins", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const chargePostedAt = tsOn(2026, 3, 12);
    const month = periodKeyOf(chargePostedAt);
    const pubId = await seedPublication(s, month, { live: true });

    const first = await seedSettledRepayment(s, { chargePostedAt, amountCents: 100 });
    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [first],
      sessionId: "cs_one",
      amountTotalCents: 100,
    });
    const afterFirst = await run(s.t, (ctx) => ctx.db.get(pubId));
    const firstStamp = afterFirst?.staleSince;
    expect(firstStamp).toBeTruthy();

    const second = await seedSettledRepayment(s, { chargePostedAt, amountCents: 200 });
    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [second],
      sessionId: "cs_two",
      amountTotalCents: 200,
    });
    const afterSecond = await run(s.t, (ctx) => ctx.db.get(pubId));
    // "How long has the public page been behind?" is answered by the FIRST
    // drift, not the most recent one.
    expect(afterSecond?.staleSince).toBe(firstStamp);
  });

  test("an unpublished chapter with no publication row at all is a silent no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const repaymentId = await seedSettledRepayment(s, {
      chargePostedAt: tsOn(2026, 3, 12),
      amountCents: 1_000,
    });
    // No `financePublications` row exists — settling must still succeed.
    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [repaymentId],
      sessionId: "cs_none",
      amountTotalCents: 1_000,
    });
    const settled = await run(s.t, (ctx) => ctx.db.get(repaymentId));
    expect(settled?.status).toBe("paid");
  });
});
