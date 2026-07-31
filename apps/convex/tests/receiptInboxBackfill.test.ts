import { afterEach, describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Receipt-inbox RECOVERY (`receiptInboxBackfill.ts`) — the catch-up for mail
 * that was emailed to the `receipts@publicworship.life` Google Group before the
 * relay was handled. All three passes are DRY-RUN BY DEFAULT and idempotent,
 * which is exactly what these tests pin down:
 *  - pass 1 lists Resend's received mail, keeps only receipt-inbox mail, skips
 *    what we already hold, and (dry run) writes nothing,
 *  - pass 2 re-attributes an already-recorded row from the list to the person
 *    named in `X-Original-Sender`, without touching money,
 *  - pass 3 re-stores a body document written before the HTML/charset rule,
 *    repointing the denormalized `transactions.receiptStorageId` cache with it
 *    and leaving every amount, merchant, and link alone.
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

// ── Pass 3: repairing documents stored before the HTML/charset rule ──────────
describe("restoreEmailBodyDocuments", () => {
  /** Seed a receipt whose stored document is the OLD shape: the message's
   *  plain-text alternative, stored with no charset — exactly what rendered as
   *  a wall of run-together text with mojibake. */
  async function seedLegacyBodyReceipt(
    t: ReturnType<typeof newT>,
    s: ChapterSetup,
  ): Promise<{ receiptId: Id<"receipts">; oldStorageId: Id<"_storage"> }> {
    const { receiptId: inboundId } = await t.mutation(
      internal.receiptInbox.recordInboundReceipt,
      { envelope: { emailId: "email_legacy_doc", fromEmail: "jane@example.com", subject: "receipt" } },
    );
    return await run(t, async (ctx) => {
      const oldStorageId = await (
        ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }
      ).store(new Blob(["Uber Eats\nTotal $298.52"], { type: "text/plain" }));
      const receiptId = await ctx.db.insert("receipts", {
        chapterId: s.chapterId,
        storageId: oldStorageId,
        source: "email",
        inboundReceiptId: inboundId,
        filename: "email body",
        amountCents: 29852,
        merchant: "Uber Receipts",
        linkCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
      return { receiptId, oldStorageId };
    });
  }

  function mockMessage(html: string | null, text: string | null): void {
    process.env.RESEND_API_KEY = "test-key";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/emails/receiving/")) {
        return { ok: true, json: async () => ({ html, text, headers: null }) };
      }
      return { ok: false, status: 500, text: async () => "no" };
    }) as unknown as typeof fetch;
  }

  test("dry run reports the repair without writing it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { receiptId, oldStorageId } = await seedLegacyBodyReceipt(t, s);
    mockMessage("<div><h1>Uber Eats</h1><p>Total $298.52</p></div>", "Total $298.52");

    const res = await t.action(
      internal.receiptInboxBackfill.restoreEmailBodyDocuments,
      {},
    );
    expect(res.executed).toBe(false);
    expect(res.restored).toBe(1);

    const receipt = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(receipt?.storageId).toBe(oldStorageId);
  });

  test("execute re-stores the HTML with a charset, and a re-run is a no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { receiptId, oldStorageId } = await seedLegacyBodyReceipt(t, s);
    mockMessage("<div><h1>Uber Eats</h1><p>Total $298.52</p></div>", "Total $298.52");

    const res = await t.action(
      internal.receiptInboxBackfill.restoreEmailBodyDocuments,
      { execute: true },
    );
    expect(res.restored).toBe(1);

    const receipt = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(receipt?.storageId).not.toBe(oldStorageId);
    const file = await run(t, async (ctx) => {
      const blob = await (
        ctx.storage as unknown as { get: (id: Id<"_storage">) => Promise<Blob | null> }
      ).get(receipt!.storageId);
      return blob ? { type: blob.type, text: await blob.text() } : null;
    });
    expect(file?.type).toBe("text/html;charset=utf-8");
    expect(file?.text).toContain("<h1>Uber Eats</h1>");

    // The money-side fields are untouched — this swaps the FILE and nothing else.
    expect(receipt?.amountCents).toBe(29852);
    expect(receipt?.merchant).toBe("Uber Receipts");

    // The charset is the idempotency marker: a second sweep finds nothing.
    const again = await t.action(
      internal.receiptInboxBackfill.restoreEmailBodyDocuments,
      { execute: true },
    );
    expect(again.scanned).toBe(0);
    expect(again.restored).toBe(0);
  });

  test("repoints a linked transaction's denormalized receiptStorageId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { receiptId, oldStorageId } = await seedLegacyBodyReceipt(t, s);
    // A charge already showing this receipt — its cached pointer must follow
    // the swap, or the reconcile grid would show a deleted file.
    const txnId = await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        amountCents: 29852,
        postedAt: Date.now(),
        status: "reconciled",
        flow: "outflow",
        source: "manual",
        receiptStorageId: oldStorageId,
        createdAt: Date.now(),
      } as never),
    );
    await run(t, (ctx) =>
      ctx.db.insert("receiptLinks", {
        receiptId,
        transactionId: txnId,
        chapterId: s.chapterId,
        source: "manual",
        createdAt: Date.now(),
      } as never),
    );
    mockMessage("<div>Uber Eats</div>", "Total $298.52");

    const res = await t.action(
      internal.receiptInboxBackfill.restoreEmailBodyDocuments,
      { execute: true },
    );
    expect(res.repointedTransactions).toBe(1);

    const receipt = await run(t, (ctx) => ctx.db.get(receiptId));
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.receiptStorageId).toBe(receipt?.storageId);
    expect(txn?.receiptStorageId).not.toBe(oldStorageId);
  });

  test("a message Resend no longer has leaves the existing document alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { receiptId, oldStorageId } = await seedLegacyBodyReceipt(t, s);
    process.env.RESEND_API_KEY = "test-key";
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      text: async () => "gone",
    })) as unknown as typeof fetch;

    const res = await t.action(
      internal.receiptInboxBackfill.restoreEmailBodyDocuments,
      { execute: true },
    );
    expect(res.restored).toBe(0);
    expect(res.skipped).toBe(1);
    const receipt = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(receipt?.storageId).toBe(oldStorageId);
  });
});
