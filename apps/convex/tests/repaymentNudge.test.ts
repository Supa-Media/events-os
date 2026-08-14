/// <reference types="vite/client" />
/**
 * CHASING A DEBT — the "you still owe this" reminder.
 *
 * Founder, 2026-08-14: "there are a bunch of people with personal charges. I
 * want to be able to send them to reimbursements, and then they see 'hey, you
 * owe this amount'."
 *
 * Until now the only email anyone got about a personal charge was the one sent
 * the instant it was flagged. After that the debt sat on a collections desk
 * nobody outside finance opens, and chasing meant a treasurer remembering to
 * raise it in person — which in a volunteer org means the awkward ones never
 * get raised.
 *
 * A collections tool is easy to build and easy to make cruel, so the tests
 * here are mostly about restraint:
 *
 *  · ONE EMAIL PER PERSON listing everything they owe — not one per charge.
 *  · NEVER CHASE MONEY ALREADY MOVING. A bank debit that is clearing is not a
 *    debt anyone should be asked about again.
 *  · IT REMEMBERS. Pressing the button twice sends one email.
 *  · A FAILED SEND DOESN'T SILENCE TOMORROW. `lastNudgedAt` is stamped only
 *    for a message that actually went.
 */
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { REPAYMENT_NUDGE_COOLDOWN_MS } from "@events-os/shared";

type Sent = { to: string; subject: string; html: string };

/** Capture Resend calls. Returns the array the fake `fetch` fills. */
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

async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manny Manager",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function seedDebtor(
  s: ChapterSetup,
  name: string,
  email: string | null,
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      ...(email ? { pwEmail: email } : {}),
      createdAt: Date.now(),
    }),
  );
}

async function seedRepayment(
  s: ChapterSetup,
  payerPersonId: Id<"people">,
  amountCents: number,
  opts: { merchantName?: string; status?: "pending" | "processing" | "paid" } = {},
): Promise<Id<"personalRepayments">> {
  const now = Date.now();
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      currency: "usd",
      postedAt: now,
      personId: payerPersonId,
      merchantName: opts.merchantName ?? "Corner Store",
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
      amountCents,
      method: "card",
      status: opts.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await run(s.t, (ctx) => ctx.db.patch(transactionId, { repaymentId }));
  return repaymentId;
}

describe("repayment reminders", () => {
  test("ONE email per person, listing every charge and one total", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      const bob = await seedDebtor(s, "Bob", "bob@publicworship.life");
      await seedRepayment(s, alice, 1_400, { merchantName: "Blue Bottle" });
      await seedRepayment(s, alice, 2_600, { merchantName: "Home Depot" });
      await seedRepayment(s, bob, 900, { merchantName: "Shell" });

      const sent = captureEmails();
      const result = await s.as.action(api.cards.nudgeOutstandingRepayments, {});

      expect(result.notified).toBe(2);
      expect(sent).toHaveLength(2); // NOT three — Alice gets one email, not two
      const toAlice = sent.find((m) => m.to === "alice@publicworship.life")!;
      expect(toAlice.subject).toContain("$40.00"); // her two charges, summed
      expect(toAlice.html).toContain("Blue Bottle");
      expect(toAlice.html).toContain("Home Depot");
      expect(toAlice.html).toContain("/finances/repayments");
    });
  });

  test("never chases a bank transfer that is already clearing", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 5_000, { status: "processing" });

      const sent = captureEmails();
      const result = await s.as.action(api.cards.nudgeOutstandingRepayments, {});

      // She paid three days ago and the bank is still moving it. Asking again
      // is the single most corrosive thing a collections tool can do.
      expect(result.notified).toBe(0);
      expect(sent).toHaveLength(0);
    });
  });

  test("a settled charge is never chased", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 5_000, { status: "paid" });

      const sent = captureEmails();
      const result = await s.as.action(api.cards.nudgeOutstandingRepayments, {});
      expect(result.notified).toBe(0);
      expect(sent).toHaveLength(0);
    });
  });

  test("pressing the button twice sends one email", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 1_400);

      const sent = captureEmails();
      const first = await s.as.action(api.cards.nudgeOutstandingRepayments, {});
      const second = await s.as.action(api.cards.nudgeOutstandingRepayments, {});

      expect(first.notified).toBe(1);
      // The likeliest misuse: a manager pressing it again because nothing
      // visibly happened. It reports the skip rather than silently doing less.
      expect(second.notified).toBe(0);
      expect(second.cooledDown).toBe(1);
      expect(sent).toHaveLength(1);
    });
  });

  test("the cooldown expires and the reminder can go again", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      const repaymentId = await seedRepayment(s, alice, 1_400);

      const sent = captureEmails();
      await s.as.action(api.cards.nudgeOutstandingRepayments, {});
      // Age the stamp past the cooldown rather than waiting three days.
      await run(s.t, (ctx) =>
        ctx.db.patch(repaymentId, {
          lastNudgedAt: Date.now() - REPAYMENT_NUDGE_COOLDOWN_MS - 1_000,
        }),
      );
      const again = await s.as.action(api.cards.nudgeOutstandingRepayments, {});

      expect(again.notified).toBe(1);
      expect(sent).toHaveLength(2);
    });
  });

  test("one recent reminder silences the whole person, not just that charge", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 1_400);
      captureEmails();
      await s.as.action(api.cards.nudgeOutstandingRepayments, {});

      // A NEW charge is flagged the next day. She was emailed yesterday, so
      // she is not emailed again today — the message was "here is what you
      // owe" and already named her.
      await seedRepayment(s, alice, 800);
      const result = await s.as.action(api.cards.nudgeOutstandingRepayments, {});
      expect(result.notified).toBe(0);
      expect(result.cooledDown).toBe(1);
    });
  });

  test("somebody with no email is reported, not silently dropped", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const ghost = await seedDebtor(s, "No Address", null);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, ghost, 1_000);
      await seedRepayment(s, alice, 1_000);

      const sent = captureEmails();
      const result = await s.as.action(api.cards.nudgeOutstandingRepayments, {});

      // The roster gap is somebody else's to fix; it is not a reason the other
      // person doesn't get reminded.
      expect(result.notified).toBe(1);
      expect(result.unreachable).toBe(1);
      expect(sent).toHaveLength(1);
    });
  });

  test("a failed send leaves them eligible tomorrow", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      const repaymentId = await seedRepayment(s, alice, 1_400);

      globalThis.fetch = (async () => {
        throw new Error("resend is down");
      }) as unknown as typeof fetch;
      const result = await s.as.action(api.cards.nudgeOutstandingRepayments, {});
      expect(result.failed).toBe(1);
      expect(result.notified).toBe(0);

      // The cooldown must NOT have started — nothing reached her.
      const row = await run(s.t, (ctx) => ctx.db.get(repaymentId));
      expect(row?.lastNudgedAt).toBeUndefined();
    });
  });

  test("only one person can be chased when that's what was asked", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      const bob = await seedDebtor(s, "Bob", "bob@publicworship.life");
      await seedRepayment(s, alice, 1_400);
      await seedRepayment(s, bob, 900);

      const sent = captureEmails();
      const result = await s.as.action(api.cards.nudgeOutstandingRepayments, {
        payerPersonId: bob,
      });
      expect(result.notified).toBe(1);
      expect(sent[0].to).toBe("bob@publicworship.life");
    });
  });

  test("a viewer cannot chase anybody — collecting is a rung above reading", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      const me = await run(s.t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Bookkeeper",
          userId: s.userId,
          isTeamMember: true,
          createdAt: Date.now(),
        }),
      );
      await run(s.t, (ctx) =>
        ctx.db.insert("financeRoles", {
          chapterId: s.chapterId,
          personId: me,
          role: "viewer",
          scope: "chapter",
          createdAt: Date.now(),
        }),
      );
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 1_400);

      const sent = captureEmails();
      await expect(
        s.as.action(api.cards.nudgeOutstandingRepayments, {}),
      ).rejects.toBeInstanceOf(ConvexError);
      expect(sent).toHaveLength(0);
    });
  });

  test("with no public URL configured it refuses rather than sending a dead-end email", async () => {
    const prevApp = process.env.APP_URL;
    const prevResend = process.env.RESEND_API_KEY;
    const realFetch = globalThis.fetch;
    delete process.env.APP_URL;
    process.env.RESEND_API_KEY = "resend_test_key";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedDebtor(s, "Alice", "alice@publicworship.life");
      await seedRepayment(s, alice, 1_400);

      const sent = captureEmails();
      // "You owe $14.00" with nowhere to pay it is worse than no email at all.
      await expect(
        s.as.action(api.cards.nudgeOutstandingRepayments, {}),
      ).rejects.toBeInstanceOf(ConvexError);
      expect(sent).toHaveLength(0);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      globalThis.fetch = realFetch;
      if (prevApp === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevApp;
      if (prevResend === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResend;
    }
  });
});
