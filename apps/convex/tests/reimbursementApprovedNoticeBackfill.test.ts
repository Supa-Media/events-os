/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The one-shot catch-up mailing for reimbursements approved BEFORE the approval
 * notice existed (`reimbursementApprovedNoticeBackfill.ts`).
 *
 * What these tests are really defending, in order of how much it would cost to
 * get wrong:
 *  1. IT CANNOT MAIL ANYONE TWICE. A second `execute` run, an overlapping run,
 *     and a row the live `approve` path already claimed all send nothing —
 *     because every send is gated on `markApprovedNoticeSent` returning `true`,
 *     which it does at most once per row, ever.
 *  2. A DRY RUN IS ACTUALLY DRY. No email, no stamp, and a truthful backlog
 *     count — this is the mode the founder runs first.
 *  3. IT DOESN'T LIE ABOUT THE MONEY. A settled claim is told it was PAID, and
 *     on what date; an unpaid one is not told the money is on its way.
 *  4. IT FINISHES. More rows than a page drains via self-reschedule, and a row
 *     with no address is claimed rather than left to be re-examined forever.
 *
 * Requests are inserted directly rather than submitted through the real form:
 * this module reads rows, and the submit path's Increase/bank plumbing is
 * covered exhaustively in `reimbursements.test.ts`.
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

/** Insert one reimbursement row in whatever state a test needs. */
async function seedRequest(
  s: ChapterSetup,
  opts: {
    status: string;
    payeeEmail?: string | null;
    payeeName?: string;
    totalCents?: number;
    approvedCents?: number;
    approvedAt?: number;
    paidAt?: number;
    approvedNoticeSentAt?: number;
    bankAccountLast4?: string;
    identityVerified?: boolean;
  },
): Promise<Id<"reimbursementRequests">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: `tok-${Math.random().toString(36).slice(2)}`,
      status: opts.status as never,
      payeeName: opts.payeeName ?? "Vera Volunteer",
      payeeEmail: opts.payeeEmail === null ? undefined : (opts.payeeEmail ?? "vera@example.com"),
      identityVerified: opts.identityVerified,
      purpose: "Event supplies",
      totalCents: opts.totalCents ?? 2000,
      approvedCents: opts.approvedCents,
      approvedAt: opts.approvedAt,
      paidAt: opts.paidAt,
      approvedNoticeSentAt: opts.approvedNoticeSentAt,
      bankAccountLast4: opts.bankAccountLast4,
      submittedAt: now - 30 * DAY_MS,
      createdAt: now - 30 * DAY_MS,
      updatedAt: now - 30 * DAY_MS,
    }),
  );
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
    internal.reimbursementApprovedNoticeBackfill.backfillApprovedNotices,
    args,
  );
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("approved-notice backfill", () => {
  test("DRY RUN sends nothing, stamps nothing, and reports the real backlog", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      const approved = await seedRequest(s, {
        status: "approved",
        approvedAt: Date.now() - 20 * DAY_MS,
        approvedCents: 2000,
      });
      const paid = await seedRequest(s, {
        status: "paid",
        payeeEmail: "paid@example.com",
        approvedAt: Date.now() - 40 * DAY_MS,
        approvedCents: 2000,
        paidAt: Date.now() - 38 * DAY_MS,
      });
      // Never approved — not this sweep's business.
      await seedRequest(s, { status: "submitted" });

      const result = await s.t.action(
        internal.reimbursementApprovedNoticeBackfill.backfillApprovedNotices,
        {},
      );
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(sends.length).toBe(0);
      expect(result.scanned).toBe(3);
      expect(result.eligible).toBe(2);
      expect(result.claimed).toBe(0);
      expect(result.isDone).toBe(true);
      for (const id of [approved, paid]) {
        const row = await run(s.t, (ctx) => ctx.db.get(id));
        expect(row?.approvedNoticeSentAt).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("EXECUTE mails each approved claimant at the address on their request, once", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      const a = await seedRequest(s, {
        status: "approved",
        payeeEmail: "typed-a@example.com",
        approvedAt: Date.now() - 20 * DAY_MS,
        approvedCents: 2000,
      });
      const b = await seedRequest(s, {
        status: "approved",
        payeeEmail: "typed-b@example.com",
        approvedAt: Date.now() - 10 * DAY_MS,
        approvedCents: 1500,
        totalCents: 1500,
      });

      await sweep(s, { execute: true });

      expect(sends.map((c) => c.to).sort()).toEqual([
        "typed-a@example.com",
        "typed-b@example.com",
      ]);
      // The founder's framing: own the miss, don't be defensive about it.
      expect(sends[0].subject).toContain("was approved — a notice we owe you");
      expect(sends[0].html).toContain("we owe you this notice");
      expect(sends[0].html).toContain("we weren't sending approval emails back then");
      for (const id of [a, b]) {
        const row = await run(s.t, (ctx) => ctx.db.get(id));
        expect(typeof row?.approvedNoticeSentAt).toBe("number");
      }

      // IDEMPOTENT: the whole point. A second execute run claims nothing.
      sends.length = 0;
      const second = await s.t.action(
        internal.reimbursementApprovedNoticeBackfill.backfillApprovedNotices,
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

  test("a row the LIVE approve path already claimed is skipped entirely", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      const already = await seedRequest(s, {
        status: "approved",
        payeeEmail: "already@example.com",
        approvedAt: Date.now() - 2 * DAY_MS,
        approvedCents: 2000,
        approvedNoticeSentAt: Date.now() - 2 * DAY_MS,
      });
      await seedRequest(s, {
        status: "approved",
        payeeEmail: "backlog@example.com",
        approvedAt: Date.now() - 50 * DAY_MS,
        approvedCents: 2000,
      });

      await sweep(s, { execute: true });

      expect(sends.map((c) => c.to)).toEqual(["backlog@example.com"]);
      const untouched = await run(s.t, (ctx) => ctx.db.get(already));
      // Its original stamp is preserved — nothing re-stamped it.
      expect(untouched?.approvedNoticeSentAt).toBeLessThan(Date.now() - DAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a SETTLED claim is told it was paid, and when — never that money is coming", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupChapter(newT());
      await setSlug(s);
      process.env.RESEND_API_KEY = "test_key";
      const sends = mockResend();

      await seedRequest(s, {
        status: "paid",
        payeeEmail: "settled@example.com",
        approvedAt: Date.UTC(2026, 2, 10, 17, 0),
        approvedCents: 2000,
        paidAt: Date.UTC(2026, 2, 14, 17, 0),
        bankAccountLast4: "0111",
      });
      await seedRequest(s, {
        status: "approved",
        payeeEmail: "unpaid@example.com",
        approvedAt: Date.UTC(2026, 2, 10, 17, 0),
        approvedCents: 2000,
      });

      await sweep(s, { execute: true });

      const settled = sends.find((c) => c.to === "settled@example.com")!;
      expect(settled.html).toContain("It was paid on March 14, 2026");
      expect(settled.html).toContain("bank account ending in 0111");
      expect(settled.html).not.toContain("Approved isn't paid yet");

      const unpaid = sends.find((c) => c.to === "unpaid@example.com")!;
      expect(unpaid.html).toContain("was approved on March 10, 2026");
      expect(unpaid.html).toContain("hasn't been marked paid yet");
      expect(unpaid.html).toContain("contact your treasurer");
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
        status: "approved",
        payeeEmail: null,
        approvedAt: Date.now() - 90 * DAY_MS,
        approvedCents: 2000,
      });

      await sweep(s, { execute: true });

      expect(sends.length).toBe(0);
      const row = await run(s.t, (ctx) => ctx.db.get(contactless));
      expect(typeof row?.approvedNoticeSentAt).toBe("number");
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
          status: "approved",
          payeeEmail: `claimant${i}@example.com`,
          approvedAt: Date.now() - (i + 1) * DAY_MS,
          approvedCents: 2000,
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
        status: "approved",
        approvedAt: Date.now() - 5 * DAY_MS,
        approvedCents: 2000,
      });

      await expect(sweep(s, { execute: true })).resolves.toBeUndefined();
      const row = await run(s.t, (ctx) => ctx.db.get(id));
      expect(typeof row?.approvedNoticeSentAt).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });
});
