import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  parseReceiptFromText,
  isReceiptInboxAddress,
  extractEmailAddress,
} from "../receiptInbox";
import { verifyStandardWebhookSignature } from "../lib/standardWebhook";

/**
 * Inbound-email → OCR → reconcile pipeline (`receiptInbox.ts`). The network
 * side never runs here (no Resend/OpenRouter keys in the test env), so we
 * exercise the parts that decide MONEY-ADJACENT behavior directly:
 *  - `parseReceiptFromText` — the zero-LLM body-receipt total extractor,
 *  - `verifyStandardWebhookSignature` — the webhook auth gate,
 *  - `recordInboundReceipt` — the emailId dedup,
 *  - `resolvePersonByEmail` — sender resolution (case-insensitive, pwEmail),
 *  - `classifySender` — the team/roster/internal/external AUTOMATION axis,
 *  - `findReceiptMatches` — the exact-cent + date-window matcher (unique /
 *    ambiguous / none / excludes receipted+non-spend / date bounds),
 *  - `processInboundReceipt` — the end-to-end pipeline (roster auto-attach +
 *    reconcile; an untrusted external sender is processed + stored but never
 *    auto-attached),
 *  - `manualMatchInboundReceipt` — the bookkeeper resolution + its gate.
 *
 * The attach/link denorm behavior itself (create receipt → link → repoint) is
 * covered directly in `tests/receiptLinks.test.ts`.
 */

const DAY = 24 * 60 * 60 * 1000;

// ── Seed helpers ─────────────────────────────────────────────────────────────
async function seedPerson(
  s: ChapterSetup,
  opts: {
    email?: string;
    pwEmail?: string;
    linkUser?: boolean;
    isTeamMember?: boolean;
  } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Cardholder",
      email: opts.email,
      pwEmail: opts.pwEmail,
      isTeamMember: opts.isTeamMember,
      userId: opts.linkUser ? s.userId : undefined,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  opts: {
    amountCents?: number;
    postedAt?: number;
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
    flow?: "outflow" | "inflow" | "transfer";
    hasReceipt?: boolean;
    isPersonal?: boolean;
    personId?: Id<"people">;
    merchantName?: string;
  } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, async (ctx) => {
    const storageId = opts.hasReceipt
      ? await (ctx.storage as unknown as {
          store: (b: Blob) => Promise<Id<"_storage">>;
        }).store(new Blob(["r"], { type: "image/png" }))
      : undefined;
    return await ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents ?? 4210,
      postedAt: opts.postedAt ?? Date.now(),
      merchantName: opts.merchantName ?? "Office Depot",
      status: opts.status ?? "unreviewed",
      isPersonal: opts.isPersonal,
      personId: opts.personId,
      receiptStorageId: storageId,
      createdAt: Date.now(),
    });
  });
}

async function storeReceipt(s: ChapterSetup): Promise<Id<"_storage">> {
  return await run(s.t, (ctx) =>
    (ctx.storage as unknown as {
      store: (b: Blob) => Promise<Id<"_storage">>;
    }).store(new Blob(["receipt"], { type: "image/png" })),
  );
}

// ── parseReceiptFromText ─────────────────────────────────────────────────────
describe("parseReceiptFromText", () => {
  test("picks the labelled total, not a larger unrelated figure", () => {
    const r = parseReceiptFromText(
      "Order #55123456\nSubtotal: $18.00\nTax: $1.62\nTotal: $19.62\n",
    );
    expect(r.amountCents).toBe(1962);
  });

  test("falls back to the largest currency figure when no total label", () => {
    const r = parseReceiptFromText("Coffee $4.50\nBagel $3.25\nThanks!");
    expect(r.amountCents).toBe(450);
  });

  test("handles thousands separators", () => {
    const r = parseReceiptFromText("Grand Total: $1,234.56");
    expect(r.amountCents).toBe(123456);
  });

  test("returns null amount when there is no currency figure", () => {
    const r = parseReceiptFromText("Thanks for your order — see you soon!");
    expect(r.amountCents).toBeNull();
  });

  test("extracts a date when present", () => {
    const r = parseReceiptFromText("Total: $10.00\nDate: 2026-03-14");
    expect(r.date).not.toBeNull();
    expect(new Date(r.date!).getUTCFullYear()).toBe(2026);
  });
});

// ── verifyStandardWebhookSignature ───────────────────────────────────────────
describe("verifyStandardWebhookSignature", () => {
  async function sign(secretB64: string, id: string, ts: string, body: string) {
    const keyBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${id}.${ts}.${body}`),
      ),
    );
    let bin = "";
    for (const b of mac) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  test("accepts a valid signature and rejects a tampered body", async () => {
    const secretB64 = btoa("supersecretkey-1234567890");
    const secret = `whsec_${secretB64}`;
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"email.received"}';
    const sig = `v1,${await sign(secretB64, id, ts, body)}`;

    expect(
      await verifyStandardWebhookSignature(body, { id, timestamp: ts, signature: sig }, secret),
    ).toBe(true);
    expect(
      await verifyStandardWebhookSignature('{"type":"tampered"}', { id, timestamp: ts, signature: sig }, secret),
    ).toBe(false);
  });

  test("rejects an out-of-tolerance timestamp (replay guard)", async () => {
    const secretB64 = btoa("supersecretkey-1234567890");
    const secret = `whsec_${secretB64}`;
    const id = "msg_2";
    const oldTs = String(Math.floor(Date.now() / 1000) - 10_000);
    const body = "{}";
    const sig = `v1,${await sign(secretB64, id, oldTs, body)}`;
    expect(
      await verifyStandardWebhookSignature(body, { id, timestamp: oldTs, signature: sig }, secret),
    ).toBe(false);
  });

  test("rejects when a header is missing", async () => {
    expect(
      await verifyStandardWebhookSignature("{}", { id: null, timestamp: "1", signature: "v1,x" }, "whsec_aaaa"),
    ).toBe(false);
  });
});

// ── isReceiptInboxAddress (the addressing filter) ────────────────────────────
describe("isReceiptInboxAddress", () => {
  test("accepts only the receipts inbox, To or Cc, case-insensitively", () => {
    expect(isReceiptInboxAddress(["receipts@reply.publicworship.life"])).toBe(true);
    expect(isReceiptInboxAddress(["RECEIPTS@Reply.PublicWorship.Life"])).toBe(true);
    // Cc position counts too (second recipient).
    expect(
      isReceiptInboxAddress(["someone@else.com", "receipts@reply.publicworship.life"]),
    ).toBe(true);
    // Other addresses on the same inbound domain are NOT receipts.
    expect(isReceiptInboxAddress(["hello@reply.publicworship.life"])).toBe(false);
    expect(isReceiptInboxAddress([])).toBe(false);
    expect(isReceiptInboxAddress([null, undefined])).toBe(false);
  });

  test("handles display-name recipient forms", () => {
    expect(
      isReceiptInboxAddress(['"PW Receipts" <receipts@reply.publicworship.life>']),
    ).toBe(true);
  });

  test("honors the RECEIPT_INBOUND_ADDRESSES override (comma-separated)", () => {
    const prev = process.env.RECEIPT_INBOUND_ADDRESSES;
    try {
      process.env.RECEIPT_INBOUND_ADDRESSES =
        "backfill@reply.publicworship.life, receipts@reply.publicworship.life";
      expect(isReceiptInboxAddress(["backfill@reply.publicworship.life"])).toBe(true);
      expect(isReceiptInboxAddress(["receipts@reply.publicworship.life"])).toBe(true);
      process.env.RECEIPT_INBOUND_ADDRESSES = "only@reply.publicworship.life";
      expect(isReceiptInboxAddress(["receipts@reply.publicworship.life"])).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.RECEIPT_INBOUND_ADDRESSES;
      else process.env.RECEIPT_INBOUND_ADDRESSES = prev;
    }
  });
});

describe("extractEmailAddress", () => {
  test("strips display names and normalizes; passes bare addresses through", () => {
    expect(extractEmailAddress("Jane Doe <Jane@Example.com>")).toBe("jane@example.com");
    expect(extractEmailAddress("  BARE@X.COM ")).toBe("bare@x.com");
    expect(extractEmailAddress("")).toBeNull();
    expect(extractEmailAddress(null)).toBeNull();
  });
});

// ── recordInboundReceipt (dedup) ─────────────────────────────────────────────
describe("recordInboundReceipt", () => {
  test("dedupes on emailId", async () => {
    const t = newT();
    const envelope = { emailId: "email_abc", fromEmail: "a@x.com", subject: "r" };
    const first = await t.mutation(internal.receiptInbox.recordInboundReceipt, { envelope });
    expect(first.isNew).toBe(true);
    const second = await t.mutation(internal.receiptInbox.recordInboundReceipt, { envelope });
    expect(second.isNew).toBe(false);
    expect(second.receiptId).toBe(first.receiptId);
  });
});

// ── resolvePersonByEmail (auth gate) ─────────────────────────────────────────
describe("resolvePersonByEmail", () => {
  test("matches case-insensitively on email and on pwEmail; unknown → null", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const p1 = await seedPerson(s, { email: "Jane.Doe@Example.com" });
    const p2 = await seedPerson(s, { pwEmail: "pastor@publicworship.life" });

    const hit1 = await t.query(internal.receiptInbox.resolvePersonByEmail, {
      email: "jane.doe@example.com",
    });
    expect(hit1?.personId).toBe(p1);
    const hit2 = await t.query(internal.receiptInbox.resolvePersonByEmail, {
      email: "  PASTOR@publicworship.life ",
    });
    expect(hit2?.personId).toBe(p2);
    const miss = await t.query(internal.receiptInbox.resolvePersonByEmail, {
      email: "stranger@nowhere.com",
    });
    expect(miss).toBeNull();
  });

  test("resolves a display-name From value", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const p = await seedPerson(s, { email: "jane@example.com" });
    const hit = await t.query(internal.receiptInbox.resolvePersonByEmail, {
      email: "Jane Doe <Jane@Example.com>",
    });
    expect(hit?.personId).toBe(p);
  });
});

// ── findReceiptMatches (the matcher) ─────────────────────────────────────────
describe("findReceiptMatches", () => {
  test("returns exactly one on a unique exact-cent, in-window match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const txn = await seedTxn(s, { amountCents: 4210, postedAt: now });
    // Noise that must NOT match: wrong amount, and right amount but receipted.
    await seedTxn(s, { amountCents: 999, postedAt: now });
    await seedTxn(s, { amountCents: 4210, postedAt: now, hasReceipt: true });

    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 4210,
      receiptDate: now,
    });
    expect(matches.map((m) => m.transactionId)).toEqual([txn]);
  });

  test("returns multiple when several charges share the amount (ambiguous)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const a = await seedTxn(s, { amountCents: 4210, postedAt: now });
    const b = await seedTxn(s, { amountCents: 4210, postedAt: now - DAY });
    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 4210,
      receiptDate: now,
    });
    expect(matches.length).toBe(2);
    expect(matches.map((m) => m.transactionId).sort()).toEqual([a, b].sort());
  });

  test("excludes charges outside the ±14 day window and non-spend/excluded", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    await seedTxn(s, { amountCents: 4210, postedAt: now - 20 * DAY }); // too old
    await seedTxn(s, { amountCents: 4210, postedAt: now, flow: "inflow" }); // not spend
    await seedTxn(s, { amountCents: 4210, postedAt: now, status: "excluded" });
    await seedTxn(s, { amountCents: 4210, postedAt: now, isPersonal: true });
    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 4210,
      receiptDate: now,
    });
    expect(matches).toEqual([]);
  });

  test("ranks the sender's own charge and a merchant-overlap first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const me = await seedPerson(s, { email: "me@x.com" });
    const plain = await seedTxn(s, { amountCents: 4210, postedAt: now, merchantName: "Costco" });
    const mine = await seedTxn(s, {
      amountCents: 4210,
      postedAt: now - DAY,
      personId: me,
      merchantName: "Home Depot",
    });
    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 4210,
      receiptDate: now,
      ocrMerchant: "HOME DEPOT #234",
      senderPersonId: me,
    });
    // `mine` is both own-charge and merchant-overlap → ranked first.
    expect(matches[0].transactionId).toBe(mine);
    expect(matches.map((m) => m.transactionId)).toContain(plain);
  });
});

// ── classifySender (the team/roster/internal/external automation axis) ───────
describe("classifySender", () => {
  test("a core-team person → team", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "boss@publicworship.life", isTeamMember: true });
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "boss@publicworship.life",
    });
    expect(c.senderClass).toBe("team");
    expect(c.personId).not.toBeNull();
    expect(c.chapterId).not.toBeNull();
  });

  test("a non-team roster person → roster", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "helper@example.com" });
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "helper@example.com",
    });
    expect(c.senderClass).toBe("roster");
  });

  test("no person match but the org domain → internal", async () => {
    const t = newT();
    await setupChapter(t);
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "nobody@publicworship.life",
    });
    expect(c.senderClass).toBe("internal");
    expect(c.personId).toBeNull();
    expect(c.chapterId).toBeNull();
  });

  test("an unknown outside address → external", async () => {
    const t = newT();
    await setupChapter(t);
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "stranger@nowhere.com",
    });
    expect(c.senderClass).toBe("external");
    expect(c.personId).toBeNull();
    expect(c.chapterId).toBeNull();
  });
});

// ── processInboundReceipt (end-to-end, keyless) ──────────────────────────────
// With no RESEND/OPENROUTER keys in the test env, the attachment + body
// fetches degrade and the SUBJECT becomes the body text — so this exercises
// the real pipeline: sender gate → body stored as the receipt file → parse →
// unique match → auto-attach + reconcile.
describe("processInboundReceipt", () => {
  test("a roster body-only email auto-attaches, reconciles, and writes a receipt + link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "jane@example.com" });
    const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

    const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: {
        emailId: "email_body_1",
        fromEmail: "Jane Doe <jane@example.com>",
        subject: "Home Depot receipt — Total: $42.10",
      },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.status).toBe("matched");
    expect(row?.matchedTransactionId).toBe(txn);
    expect(row?.sourceKind).toBe("body");
    expect(row?.senderClass).toBe("roster");
    expect(row?.receiptStorageId).toBeDefined();
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.status).toBe("reconciled");
    expect(txnRow?.receiptStorageId).toBe(row?.receiptStorageId);

    // A first-class receipt document + a link were written (source auto_email).
    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts.length).toBe(1);
    expect(receipts[0].source).toBe("email");
    expect(receipts[0].senderClass).toBe("roster");
    expect(receipts[0].linkCount).toBe(1);
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links.length).toBe(1);
    expect(links[0].source).toBe("auto_email");
    expect(links[0].transactionId).toBe(txn);
  });

  test("an EXTERNAL sender is processed + stored but NEVER auto-attached, even on a unique exact match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A perfect, unique candidate exists — a trusted sender would auto-attach.
    const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

    const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: {
        emailId: "email_external_1",
        fromEmail: "stranger@nowhere.com",
        subject: "Receipt — Total: $42.10",
      },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    // Processed end-to-end: the body was stored and OCR'd.
    expect(row?.senderClass).toBe("external");
    expect(row?.sourceKind).toBe("body");
    expect(row?.receiptStorageId).toBeDefined();
    expect(row?.ocrAmountCents).toBe(4210);
    // But an untrusted From: never moves money → review, no chapter inferred.
    expect(row?.status).toBe("needs_review");
    expect(row?.chapterId).toBeUndefined();
    expect(row?.matchedTransactionId).toBeUndefined();

    // The transaction is untouched — no receipt attached, no reconcile.
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBeUndefined();
    expect(txnRow?.status).toBe("categorized");

    // A receipt DOCUMENT was still created (unlinked) — the CRM view surfaces it.
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links.length).toBe(0);
    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts.length).toBe(1);
    expect(receipts[0].linkCount).toBe(0);
    expect(receipts[0].chapterId).toBeUndefined();
    expect(receipts[0].senderClass).toBe("external");
  });
});

// ── manualMatchInboundReceipt (bookkeeper resolution) ────────────────────────
describe("manualMatchInboundReceipt", () => {
  async function seedInboundRow(
    s: ChapterSetup,
    storageId: Id<"_storage"> | undefined,
  ): Promise<Id<"inboundReceipts">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("inboundReceipts", {
        emailId: `e_${Math.random()}`,
        status: "needs_review",
        fromEmail: "sender@x.com",
        chapterId: s.chapterId,
        receiptStorageId: storageId,
        receivedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test("a bookkeeper attaches the inbound receipt to a chosen txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const self = await seedPerson(s, { linkUser: true });
    await grantRole(s, self, "bookkeeper");
    const storageId = await storeReceipt(s);
    const rowId = await seedInboundRow(s, storageId);
    const txn = await seedTxn(s, { status: "categorized" });

    const res = await s.as.mutation(api.receiptInbox.manualMatchInboundReceipt, {
      receiptId: rowId,
      transactionId: txn,
    });
    expect(res.reconciled).toBe(true);
    const row = await run(t, (ctx) => ctx.db.get(rowId));
    expect(row?.status).toBe("matched");
    expect(row?.matchedTransactionId).toBe(txn);
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(storageId);
  });

  test("a viewer (below bookkeeper) is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const self = await seedPerson(s, { linkUser: true });
    await grantRole(s, self, "viewer");
    const storageId = await storeReceipt(s);
    const rowId = await seedInboundRow(s, storageId);
    const txn = await seedTxn(s, { status: "categorized" });
    await expect(
      s.as.mutation(api.receiptInbox.manualMatchInboundReceipt, {
        receiptId: rowId,
        transactionId: txn,
      }),
    ).rejects.toThrow(ConvexError);
  });
});
