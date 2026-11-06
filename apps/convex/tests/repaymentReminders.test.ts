/// <reference types="vite/client" />
/**
 * DAILY PAY-BACK REMINDERS (founder, 2026-11-06: "when someone's charge is
 * marked as personal, could you also send daily reminders until they pay the
 * money back"). See `repaymentReminders.ts`.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { RECENT_MESSAGE_MS } from "../repaymentReminders";

type Sent = { to: string; subject: string; html: string };

function captureEmails(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    sent.push({ to: body.to, subject: body.subject, html: body.html });
    return { ok: true, status: 200, text: async () => "{}" };
  }) as unknown as typeof fetch;
  return sent;
}

async function withEmailEnv(body: () => Promise<void>): Promise<void> {
  const prevApp = process.env.APP_URL;
  const prevResend = process.env.RESEND_API_KEY;
  const realFetch = globalThis.fetch;
  process.env.APP_URL = "https://app.publicworship.life";
  process.env.RESEND_API_KEY = "resend_test_key";
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    if (prevApp === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevApp;
    if (prevResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = prevResend;
  }
}

const DAY = 24 * 60 * 60 * 1000;

async function seedDebtor(s: ChapterSetup, name: string, email: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      pwEmail: email,
      createdAt: Date.now(),
    }),
  );
}

async function seedRepayment(
  s: ChapterSetup,
  payerPersonId: Id<"people">,
  amountCents: number,
  opts: {
    merchantName?: string;
    status?: "pending" | "processing" | "paid" | "failed";
    flaggedAgoMs?: number;
  } = {},
): Promise<Id<"personalRepayments">> {
  const now = Date.now();
  const createdAt = now - (opts.flaggedAgoMs ?? 2 * DAY);
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      currency: "usd",
      postedAt: createdAt,
      personId: payerPersonId,
      merchantName: opts.merchantName ?? "Corner Store",
      status: "reconciled",
      isPersonal: true,
      createdAt,
    }),
  );
  const repaymentId = await run(s.t, (ctx) =>
    ctx.db.insert("personalRepayments", {
      chapterId: s.chapterId,
      transactionId,
      payerPersonId,
      amountCents,
      method: "card",
      status: opts.status ?? "pending",
      createdAt,
      updatedAt: createdAt,
    }),
  );
  await run(s.t, (ctx) => ctx.db.patch(transactionId, { repaymentId }));
  return repaymentId;
}

/** Pretend a day has passed since the last reminder. */
async function ageReminders(s: ChapterSetup, ids: Id<"personalRepayments">[]) {
  for (const id of ids) {
    await run(s.t, (ctx) => ctx.db.patch(id, { lastNudgedAt: Date.now() - DAY }));
  }
}

describe("daily pay-back reminders", () => {
  test("one email per person a day, listing every charge, linking the portal", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 1_400, { merchantName: "Blue Bottle" });
      await seedRepayment(s, alice, 2_600, { merchantName: "Home Depot", status: "failed" });

      const sent = captureEmails();
      const result = await t.action(internal.repaymentReminders.sendDaily, {});

      expect(result.reminded).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toContain("$40.00");
      expect(sent[0].html).toContain("Blue Bottle");
      expect(sent[0].html).toContain("Home Depot");
      expect(sent[0].html).toContain("/finances/repayments");
      expect(sent[0].html.toLowerCase()).not.toContain("reply");

      // Same day again: nothing.
      await t.action(internal.repaymentReminders.sendDaily, {});
      expect(sent).toHaveLength(1);
    });
  });

  test("keeps going every day until it's paid, then stops", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      const rep = await seedRepayment(s, alice, 1_400);
      const sent = captureEmails();

      await t.action(internal.repaymentReminders.sendDaily, {});
      await ageReminders(s, [rep]);
      await t.action(internal.repaymentReminders.sendDaily, {});
      expect(sent).toHaveLength(2);

      // Bank debit clearing: money is on its way, never ask again.
      await run(s.t, (ctx) => ctx.db.patch(rep, { status: "processing" }));
      await ageReminders(s, [rep]);
      await t.action(internal.repaymentReminders.sendDaily, {});
      expect(sent).toHaveLength(2);

      await run(s.t, (ctx) => ctx.db.patch(rep, { status: "paid" }));
      await t.action(internal.repaymentReminders.sendDaily, {});
      expect(sent).toHaveLength(2);
    });
  });

  test("the day it was flagged, the flag email is the message", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 1_400, { flaggedAgoMs: RECENT_MESSAGE_MS - 60_000 });
      const sent = captureEmails();

      await t.action(internal.repaymentReminders.sendDaily, {});
      expect(sent).toHaveLength(0);
    });
  });

  test("uses the person's no-sign-in pay link when a manager minted one", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 1_400);
      await run(s.t, (ctx) =>
        ctx.db.insert("repaymentLinks", {
          chapterId: s.chapterId,
          payerPersonId: alice,
          token: "tok-123",
          createdAt: Date.now(),
        }),
      );
      const sent = captureEmails();

      await t.action(internal.repaymentReminders.sendDaily, {});
      expect(sent[0].html).toContain("/pay/tok-123");
    });
  });
});
