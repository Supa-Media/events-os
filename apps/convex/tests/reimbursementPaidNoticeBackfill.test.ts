/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The one-shot catch-up mailing for reimbursements PAID before the paid notice
 * existed (`reimbursementPaidNoticeBackfill.ts`) — the twin of
 * `reimbursementApprovedNoticeBackfill.test.ts`, defending the same four things
 * in the same order, because the two sweeps share a mechanism and must not
 * drift:
 *  1. IT CANNOT MAIL ANYONE TWICE. A second `execute` run, an overlapping run,
 *     and a row the live settle path already claimed all send nothing — every
 *     send is gated on `markPaidNoticeSent` returning `true`.
 *  2. A DRY RUN IS ACTUALLY DRY. No email, no stamp, and a truthful backlog
 *     count — the mode the founder runs first.
 *  3. IT DOESN'T LIE ABOUT THE MONEY. It quotes what the PAYOUT moved (not the
 *     submitted total), it names the rail it actually knows about, and it only
 *     ever writes to somebody who is paid right now.
 *  4. IT FINISHES. More rows than a page drains via self-reschedule, and a row
 *     with no address is claimed rather than left to be re-examined forever.
 *
 * Requests and payouts are inserted directly rather than driven through the
 * real payout flow: this module reads rows, and the settle path itself is
 * covered in `increase.test.ts`.
 */

const ORIGINAL_FETCH = globalThis.fetch;
const PREV_RESEND_KEY = process.env.RESEND_API_KEY;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (PREV_RESEND_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = PREV_RESEND_KEY;
});

/** Record every Resend send (nothing else should be fetched here). */
function mockResend(): Array<{ to: string; subject: string; html: string }> {
  const calls: Array<{ to: string; subject: string; html: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("api.resend.com/emails")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ to: body.to, subject: body.subject, html: body.html ?? "" });
      return new Response(JSON.stringify({ id: "email_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as unknown as typeof fetch;
  return calls;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Insert one reimbursement row in whatever state a test needs, plus — unless
 *  `payout` is explicitly `null` — the `payouts` row that settled it, which is
 *  where the notice reads the amount and the rail from. */
async function seedRequest(
  s: ChapterSetup,
  opts: {
    status: string;
    payeeEmail?: string | null;
    payeeName?: string;
    totalCents?: number;
    approvedCents?: number;
    paidAt?: number;
    paidNoticeSentAt?: number;
    bankAccountLast4?: string;
    identityVerified?: boolean;
    /** `null` = a legacy paid row with no payout document at all. */
    payout?: { provider: "manual" | "increase"; amountCents?: number } | null;
  },
): Promise<Id<"reimbursementRequests">> {
  const now = Date.now();
  const reimbursementId = await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: `tok-${Math.random().toString(36).slice(2)}`,
      status: opts.status as never,
      payeeName: opts.payeeName ?? "Vera Volunteer",
      payeeEmail:
        opts.payeeEmail === null
          ? undefined
          : (opts.payeeEmail ?? "vera@example.com"),
      identityVerified: opts.identityVerified,
      purpose: "Event supplies",
      totalCents: opts.totalCents ?? 2000,
      approvedCents: opts.approvedCents,
      approvedAt: now - 40 * DAY_MS,
      paidAt: opts.paidAt,
      paidNoticeSentAt: opts.paidNoticeSentAt,
      bankAccountLast4: opts.bankAccountLast4,
      submittedAt: now - 45 * DAY_MS,
      createdAt: now - 45 * DAY_MS,
      updatedAt: now - 45 * DAY_MS,
    }),
  );
  if (opts.payout !== null) {
    const spec = opts.payout ?? { provider: "manual" as const };
    const payoutId = await run(s.t, (ctx) =>
      ctx.db.insert("payouts", {
        chapterId: s.chapterId,
        reimbursementId,
        amountCents:
          spec.amountCents ?? opts.approvedCents ?? opts.totalCents ?? 2000,
        provider: spec.provider,
        status: "paid",
        bankAccountLast4: opts.bankAccountLast4,
        createdAt: now - 40 * DAY_MS,
        updatedAt: now - 40 * DAY_MS,
      }),
    );
    await run(s.t, (ctx) => ctx.db.patch(reimbursementId, { payoutId }));
  }
  return reimbursementId;
}

/** Give the chapter a slug so the accountless CTA link can be built. */
async function setSlug(s: ChapterSetup): Promise<void> {
  await run(s.t, (ctx) => ctx.db.patch(s.chapterId, { slug: "nyc" }));
}

/** Run the sweep and drain every page it schedules for itself. */
async function sweep(
  s: ChapterSetup,
  args: { execute?: boolean } = {},
): Promise<void> {
  await s.t.action(
    internal.reimbursementPaidNoticeBackfill.backfillPaidNotices,
    args,
  );
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("paid-notice backfill", () => {
  test("DRY RUN sends nothing, stamps nothing, and reports the real backlog", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      const a = await seedRequest(s, {
        status: "paid",
        approvedCents: 2000,
        paidAt: Date.now() - 38 * DAY_MS,
      });
      const b = await seedRequest(s, {
        status: "paid",
        payeeEmail: "second@example.com",
        approvedCents: 1500,
        totalCents: 1500,
        paidAt: Date.now() - 12 * DAY_MS,
      });
      // Approved but never paid — the APPROVAL sweep's business, not this one.
      await seedRequest(s, { status: "approved", approvedCents: 2000 });
      // Never got anywhere near a payout.
      await seedRequest(s, { status: "submitted", payout: null });

      const result = await s.t.action(
        internal.reimbursementPaidNoticeBackfill.backfillPaidNotices,
        {},
      );
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(sends.length).toBe(0);
      expect(result.scanned).toBe(4);
      expect(result.eligible).toBe(2);
      expect(result.claimed).toBe(0);
      expect(result.isDone).toBe(true);
      for (const id of [a, b]) {
        const row = await run(s.t, (ctx) => ctx.db.get(id));
        expect(row?.paidNoticeSentAt).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("EXECUTE mails each paid claimant at the address on their request, once", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      const a = await seedRequest(s, {
        status: "paid",
        payeeEmail: "typed-a@example.com",
        approvedCents: 2000,
        paidAt: Date.now() - 20 * DAY_MS,
      });
      const b = await seedRequest(s, {
        status: "paid",
        payeeEmail: "typed-b@example.com",
        approvedCents: 1500,
        totalCents: 1500,
        paidAt: Date.now() - 10 * DAY_MS,
      });

      await sweep(s, { execute: true });

      expect(sends.map((c) => c.to).sort()).toEqual([
        "typed-a@example.com",
        "typed-b@example.com",
      ]);
      // The founder's framing on the approval catch-up, applied here: own the
      // miss, don't be defensive about it.
      expect(sends[0].subject).toContain("was paid — a notice we owe you");
      expect(sends[0].html).toContain("we owe you this notice");
      expect(sends[0].html).toContain(
        "we weren't sending payment emails back then",
      );
      // …and the line that is the entire point of writing at all.
      expect(sends[0].html).toContain("If that money never actually reached you");
      for (const id of [a, b]) {
        const row = await run(s.t, (ctx) => ctx.db.get(id));
        expect(typeof row?.paidNoticeSentAt).toBe("number");
      }

      // IDEMPOTENT: the whole point. A second execute run claims nothing.
      sends.length = 0;
      const second = await s.t.action(
        internal.reimbursementPaidNoticeBackfill.backfillPaidNotices,
        { execute: true },
      );
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(sends.length).toBe(0);
      expect(second.eligible).toBe(0);
      expect(second.claimed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a row the LIVE settle path already claimed is skipped entirely", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      const already = await seedRequest(s, {
        status: "paid",
        payeeEmail: "already@example.com",
        approvedCents: 2000,
        paidAt: Date.now() - 2 * DAY_MS,
        paidNoticeSentAt: Date.now() - 2 * DAY_MS,
      });
      await seedRequest(s, {
        status: "paid",
        payeeEmail: "backlog@example.com",
        approvedCents: 2000,
        paidAt: Date.now() - 50 * DAY_MS,
      });

      await sweep(s, { execute: true });

      expect(sends.map((c) => c.to)).toEqual(["backlog@example.com"]);
      const untouched = await run(s.t, (ctx) => ctx.db.get(already));
      // Its original stamp is preserved — nothing re-stamped it.
      expect(untouched?.paidNoticeSentAt).toBeLessThan(Date.now() - DAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the amount is what the PAYOUT moved, and a partial approval says so", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      // $20 submitted, $12 approved, $12 paid. Quoting the submitted total
      // would read as a short payment with more to come; there is no such
      // thing as a second instalment on one reimbursement.
      await seedRequest(s, {
        status: "paid",
        payeeEmail: "partial@example.com",
        totalCents: 2000,
        approvedCents: 1200,
        paidAt: Date.UTC(2026, 2, 14, 17, 0),
        bankAccountLast4: "0111",
        payout: { provider: "increase", amountCents: 1200 },
      });
      // Paid in full, by hand, and with no payout row at all (a legacy
      // migrated claim) — the copy must claim nothing about the rail.
      await seedRequest(s, {
        status: "paid",
        payeeEmail: "legacy@example.com",
        totalCents: 900,
        approvedCents: 900,
        paidAt: Date.UTC(2026, 2, 2, 17, 0),
        payout: null,
      });

      await sweep(s, { execute: true });

      const partial = sends.find((c) => c.to === "partial@example.com")!;
      expect(partial.html).toContain(
        "$12.00 was paid — that's the amount a reviewer approved, out of the $20.00 you submitted",
      );
      expect(partial.html).toContain("isn't coming separately");
      expect(partial.html).toContain(
        "It went out by bank transfer on March 14, 2026",
      );
      expect(partial.html).toContain("ending in 0111");

      const legacy = sends.find((c) => c.to === "legacy@example.com")!;
      expect(legacy.html).toContain("$9.00 was paid — the full amount");
      expect(legacy.html).toContain("It was marked paid on March 2, 2026");
      expect(legacy.html).not.toContain("bank transfer");
      expect(legacy.html).not.toContain("Your treasurer sent this one");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a legacy row with no email on it is CLAIMED anyway, so it can't be re-examined forever", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      const contactless = await seedRequest(s, {
        status: "paid",
        payeeEmail: null,
        approvedCents: 2000,
        paidAt: Date.now() - 90 * DAY_MS,
      });

      await sweep(s, { execute: true });

      expect(sends.length).toBe(0);
      const row = await run(s.t, (ctx) => ctx.db.get(contactless));
      expect(typeof row?.paidNoticeSentAt).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });

  test("drains past a single page — 55 rows all get exactly one notice", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      const COUNT = 55; // PAGE_SIZE is 50 — this must self-reschedule
      for (let i = 0; i < COUNT; i++) {
        await seedRequest(s, {
          status: "paid",
          payeeEmail: `claimant${i}@example.com`,
          approvedCents: 2000,
          paidAt: Date.now() - (i + 1) * DAY_MS,
        });
      }

      await sweep(s, { execute: true });

      expect(sends.length).toBe(COUNT);
      expect(new Set(sends.map((c) => c.to)).size).toBe(COUNT);

      // And re-running it still sends nothing, across the page boundary too.
      sends.length = 0;
      await sweep(s, { execute: true });
      expect(sends.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("no RESEND_API_KEY: the sweep still claims every row and never throws", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      delete process.env.RESEND_API_KEY;

      const id = await seedRequest(s, {
        status: "paid",
        approvedCents: 2000,
        paidAt: Date.now() - 5 * DAY_MS,
      });

      await expect(sweep(s, { execute: true })).resolves.toBeUndefined();
      const row = await run(s.t, (ctx) => ctx.db.get(id));
      expect(typeof row?.paidNoticeSentAt).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });
});
