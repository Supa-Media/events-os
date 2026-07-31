import { afterEach, describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Receipt-inbox RECOVERY (`receiptInboxBackfill.ts`) — the catch-up for mail
 * that was emailed to the `receipts@publicworship.life` Google Group before the
 * relay was handled. Both passes are DRY-RUN BY DEFAULT and idempotent, which
 * is exactly what these tests pin down:
 *  - pass 1 lists Resend's received mail, keeps only receipt-inbox mail, skips
 *    what we already hold, and (dry run) writes nothing,
 *  - pass 2 re-attributes an already-recorded row from the list to the person
 *    named in `X-Original-Sender`, without touching money.
 */

const realFetch = globalThis.fetch;
const realKey = process.env.RESEND_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = realKey;
});

/** Two group-relayed receipts and one unrelated email on the same domain. */
const LISTED = [
  {
    id: "email_missed_1",
    from: '"Charisma S." <charisma@example.com>',
    // The GROUP address — what a relayed post keeps in `To:`.
    to: ["receipts@publicworship.life"],
    subject: "Fwd: Your Uber Eats order",
    created_at: "2026-07-30T23:35:42.000Z",
  },
  {
    id: "email_missed_2",
    from: "jane@example.com",
    to: ["receipts@reply.publicworship.life"],
    subject: "receipt",
    created_at: "2026-07-29T10:00:00.000Z",
  },
  {
    id: "email_other_1",
    from: "someone@example.com",
    to: ["hello@reply.publicworship.life"],
    subject: "not a receipt",
    created_at: "2026-07-28T10:00:00.000Z",
  },
];

/** Serve the received-email LIST (one page, `has_more: false`) and, for the
 *  per-email retrieve, a body + whatever headers the caller asked for. */
function mockResend(headersById: Record<string, Record<string, string>> = {}): void {
  process.env.RESEND_API_KEY = "test-key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/emails/receiving?")) {
      return {
        ok: true,
        json: async () => ({ object: "list", has_more: false, data: LISTED }),
      };
    }
    if (url.includes("/attachments")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    const retrieve = url.match(/\/emails\/receiving\/([^/?]+)$/);
    if (retrieve) {
      return {
        ok: true,
        json: async () => ({
          text: "Total: $42.10",
          headers: headersById[retrieve[1]] ?? null,
        }),
      };
    }
    return { ok: false, status: 500, text: async () => "no" };
  }) as unknown as typeof fetch;
}

async function seedPerson(s: ChapterSetup, email: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Cardholder",
      email,
      createdAt: Date.now(),
    }),
  );
}

describe("backfillMissedReceiptEmails", () => {
  test("dry run counts what it WOULD ingest and writes nothing", async () => {
    const t = newT();
    await setupChapter(t);
    mockResend();

    const res = await t.action(
      internal.receiptInboxBackfill.backfillMissedReceiptEmails,
      {},
    );

    expect(res.executed).toBe(false);
    expect(res.scanned).toBe(3);
    // The group address AND the raw inbound address both count; the third
    // email is addressed elsewhere on the domain.
    expect(res.ingested).toBe(2);
    expect(res.notReceiptMail).toBe(1);
    expect(res.alreadyIngested).toBe(0);
    expect(res.error).toBeNull();

    const rows = await run(t, (ctx) => ctx.db.query("inboundReceipts").take(5));
    expect(rows).toHaveLength(0);
  });

  test("execute records the missed mail, and a re-run is a no-op", async () => {
    const t = newT();
    await setupChapter(t);
    mockResend();

    const first = await t.action(
      internal.receiptInboxBackfill.backfillMissedReceiptEmails,
      { execute: true },
    );
    expect(first.executed).toBe(true);
    expect(first.ingested).toBe(2);

    const rows = await run(t, (ctx) => ctx.db.query("inboundReceipts").take(5));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.emailId).sort()).toEqual([
      "email_missed_1",
      "email_missed_2",
    ]);

    // Idempotent: the `emailId` dedup means a second sweep finds nothing new.
    const second = await t.action(
      internal.receiptInboxBackfill.backfillMissedReceiptEmails,
      { execute: true },
    );
    expect(second.ingested).toBe(0);
    expect(second.alreadyIngested).toBe(2);
    const after = await run(t, (ctx) => ctx.db.query("inboundReceipts").take(5));
    expect(after).toHaveLength(2);
  });

  test("sinceMs skips mail older than the window", async () => {
    const t = newT();
    await setupChapter(t);
    mockResend();

    const res = await t.action(
      internal.receiptInboxBackfill.backfillMissedReceiptEmails,
      { sinceMs: Date.parse("2026-07-30T00:00:00.000Z") },
    );
    expect(res.ingested).toBe(1);
  });

  test("without an API key it reports the reason instead of silently doing nothing", async () => {
    const t = newT();
    await setupChapter(t);
    delete process.env.RESEND_API_KEY;

    const res = await t.action(
      internal.receiptInboxBackfill.backfillMissedReceiptEmails,
      {},
    );
    expect(res.scanned).toBe(0);
    expect(res.error).toContain("RESEND_API_KEY");
  });
});

describe("reattributeRelayedReceipts", () => {
  /** A row recorded with the LIST as its sender — the DMARC-rewrite shape. */
  async function seedRelayedRow(t: ReturnType<typeof newT>): Promise<Id<"inboundReceipts">> {
    const { receiptId } = await t.mutation(
      internal.receiptInbox.recordInboundReceipt,
      {
        envelope: {
          emailId: "email_relayed_1",
          fromEmail: '"Charisma S. via receipts" <receipts@publicworship.life>',
          subject: "Fwd: Your Uber Eats order",
        },
      },
    );
    return receiptId;
  }

  test("dry run reports the recovery without writing it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, "charisma@example.com");
    const receiptId = await seedRelayedRow(t);
    mockResend({
      email_relayed_1: {
        "List-Id": "<receipts.publicworship.life>",
        "X-Original-Sender": "charisma@example.com",
      },
    });

    const res = await t.action(
      internal.receiptInboxBackfill.reattributeRelayedReceipts,
      {},
    );
    expect(res.executed).toBe(false);
    expect(res.reattributed).toBe(1);

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.originalSenderEmail).toBeUndefined();
    expect(row?.personId).toBeUndefined();
  });

  test("execute attributes the row to the poster and their chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, "charisma@example.com");
    const receiptId = await seedRelayedRow(t);
    mockResend({
      email_relayed_1: {
        "List-Id": "<receipts.publicworship.life>",
        "X-Original-Sender": "charisma@example.com",
      },
    });

    const res = await t.action(
      internal.receiptInboxBackfill.reattributeRelayedReceipts,
      { execute: true },
    );
    expect(res.reattributed).toBe(1);

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.originalSenderEmail).toBe("charisma@example.com");
    expect(row?.personId).toBe(personId);
    expect(row?.chapterId).toBe(s.chapterId);
    expect(row?.senderClass).toBe("roster");
    // Metadata only — nothing was attached to a charge.
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links).toHaveLength(0);
  });

  test("a row with no recoverable sender is left exactly as it was", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, "charisma@example.com");
    const receiptId = await seedRelayedRow(t);
    // List mail, but the group didn't stamp an original sender.
    mockResend({
      email_relayed_1: { "List-Id": "<receipts.publicworship.life>" },
    });

    const res = await t.action(
      internal.receiptInboxBackfill.reattributeRelayedReceipts,
      { execute: true },
    );
    expect(res.reattributed).toBe(0);
    expect(res.unchanged).toBe(1);
    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.originalSenderEmail).toBeUndefined();
  });
});
