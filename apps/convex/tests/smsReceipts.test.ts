import { describe, expect, test, vi } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { verifyTwilioSignature } from "../lib/twilio";
import { resolveTwilioReceiptsWebhookUrl } from "../smsReceipts";

/**
 * Inbound-SMS/MMS → OCR → reconcile pipeline (`smsReceipts.ts`), the Twilio
 * channel that feeds the SAME `receipts`/`receiptLinks` layer as
 * `receiptInbox.ts` (email). No network in this test env (no Twilio/OpenRouter
 * keys), so — mirroring `tests/receiptInbox.test.ts` — this exercises the
 * parts that decide MONEY-ADJACENT behavior directly:
 *  - `verifyTwilioSignature` — the webhook auth gate (valid/tampered/missing),
 *  - `resolveTwilioReceiptsWebhookUrl` — the URL-signing subtlety,
 *  - `recordSmsReceipt` — the MessageSid dedup,
 *  - `resolvePersonByPhone`/`classifySmsSender` — phone resolution + the
 *    team/roster/external automation axis, formatting-variant matching,
 *  - `processSmsReceipt` — the end-to-end pipeline (roster body-text
 *    auto-attach + reconcile; an external sender is processed + stored but
 *    never auto-attached; a media-less flow),
 *  - the `/twilio/receipts` HTTP route itself (signature-gated, end-to-end),
 *    via `t.fetch` (`convex-test` supports POST + custom headers cleanly, so
 *    this is a real route-level test, not just the internal functions).
 */

const TEST_AUTH_TOKEN = "sk_test_auth_token_1234567890";

/** Compute a valid Twilio `X-Twilio-Signature` for (url, params, authToken) —
 *  a reference implementation independent of `verifyTwilioSignature`, so the
 *  test actually pins the algorithm rather than tautologically round-tripping
 *  the same code. */
async function signTwilio(
  url: string,
  params: Record<string, string>,
  authToken: string,
): Promise<string> {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function setTwilioSettings(s: ChapterSetup, authToken = TEST_AUTH_TOKEN): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("integrationSettings", {
      twilioAccountSid: "ACtest",
      twilioAuthToken: authToken,
      twilioMessagingServiceSid: "MGtest",
      updatedBy: s.userId,
      updatedAt: Date.now(),
    }),
  );
}

// ── verifyTwilioSignature (the webhook auth gate) ────────────────────────────
describe("verifyTwilioSignature", () => {
  const url = "https://some.convex.site/twilio/receipts";
  const params = { MessageSid: "SM123", From: "+19175550000", Body: "Total: $42.10" };

  test("accepts a correctly signed request", async () => {
    const sig = await signTwilio(url, params, TEST_AUTH_TOKEN);
    expect(await verifyTwilioSignature(url, params, TEST_AUTH_TOKEN, sig)).toBe(true);
  });

  test("rejects a tampered param (changing Body invalidates the signature)", async () => {
    const sig = await signTwilio(url, params, TEST_AUTH_TOKEN);
    expect(
      await verifyTwilioSignature(url, { ...params, Body: "Total: $999.99" }, TEST_AUTH_TOKEN, sig),
    ).toBe(false);
  });

  test("rejects a signature made against a different URL", async () => {
    const sig = await signTwilio(url, params, TEST_AUTH_TOKEN);
    expect(
      await verifyTwilioSignature("https://some.convex.site/other", params, TEST_AUTH_TOKEN, sig),
    ).toBe(false);
  });

  test("rejects the wrong auth token", async () => {
    const sig = await signTwilio(url, params, TEST_AUTH_TOKEN);
    expect(await verifyTwilioSignature(url, params, "wrong-token", sig)).toBe(false);
  });

  test("rejects a missing signature", async () => {
    expect(await verifyTwilioSignature(url, params, TEST_AUTH_TOKEN, null)).toBe(false);
  });
});

// ── resolveTwilioReceiptsWebhookUrl (the URL-signing subtlety) ───────────────
describe("resolveTwilioReceiptsWebhookUrl", () => {
  test("defaults to the request's own URL", () => {
    const req = new Request("https://some.convex.site/twilio/receipts", { method: "POST" });
    expect(resolveTwilioReceiptsWebhookUrl(req)).toBe("https://some.convex.site/twilio/receipts");
  });

  test("TWILIO_RECEIPTS_WEBHOOK_URL overrides it (the proxied-request case)", () => {
    const prev = process.env.TWILIO_RECEIPTS_WEBHOOK_URL;
    try {
      process.env.TWILIO_RECEIPTS_WEBHOOK_URL = "https://publicworship.life/twilio/receipts";
      const req = new Request("https://vivid-rhinoceros-688.convex.site/twilio/receipts", { method: "POST" });
      expect(resolveTwilioReceiptsWebhookUrl(req)).toBe("https://publicworship.life/twilio/receipts");
    } finally {
      if (prev === undefined) delete process.env.TWILIO_RECEIPTS_WEBHOOK_URL;
      else process.env.TWILIO_RECEIPTS_WEBHOOK_URL = prev;
    }
  });
});

// ── Seed helpers ─────────────────────────────────────────────────────────────
async function seedPerson(
  s: ChapterSetup,
  opts: { phone?: string; isTeamMember?: boolean; isContactOnly?: boolean } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Cardholder",
      phone: opts.phone,
      isTeamMember: opts.isTeamMember,
      isContactOnly: opts.isContactOnly,
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  opts: { amountCents?: number; status?: "unreviewed" | "categorized" | "reconciled" } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 4210,
      postedAt: Date.now(),
      merchantName: "Office Depot",
      status: opts.status ?? "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

// ── recordSmsReceipt (MessageSid dedup) ──────────────────────────────────────
describe("recordSmsReceipt", () => {
  test("dedupes on MessageSid", async () => {
    const t = newT();
    const envelope = { messageSid: "SM_dup_1", fromPhone: "+19175550000", body: "hi" };
    const first = await t.mutation(internal.smsReceipts.recordSmsReceipt, { envelope });
    expect(first.isNew).toBe(true);
    const second = await t.mutation(internal.smsReceipts.recordSmsReceipt, { envelope });
    expect(second.isNew).toBe(false);
    expect(second.receiptId).toBe(first.receiptId);

    const row = await run(t, (ctx) => ctx.db.get(first.receiptId));
    expect(row?.channel).toBe("sms");
    expect(row?.smsMessageSid).toBe("SM_dup_1");
    expect(row?.fromPhone).toBe("+19175550000");
    // Legacy required field also carries the phone (documented reuse).
    expect(row?.fromEmail).toBe("+19175550000");
  });
});

// ── resolvePersonByPhone / classifySmsSender (phone resolution) ─────────────
describe("resolvePersonByPhone", () => {
  test("matches across formatting variants (E.164, punctuated, bare 10-digit)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const p = await seedPerson(s, { phone: "+1 (555) 123-4567" });

    const hit1 = await t.query(internal.smsReceipts.resolvePersonByPhone, {
      phone: "5551234567",
    });
    expect(hit1?.personId).toBe(p);
    const hit2 = await t.query(internal.smsReceipts.resolvePersonByPhone, {
      phone: "+15551234567",
    });
    expect(hit2?.personId).toBe(p);
    const hit3 = await t.query(internal.smsReceipts.resolvePersonByPhone, {
      phone: "(555) 123-4567",
    });
    expect(hit3?.personId).toBe(p);

    const miss = await t.query(internal.smsReceipts.resolvePersonByPhone, {
      phone: "+19995550000",
    });
    expect(miss).toBeNull();
  });
});

describe("classifySmsSender", () => {
  test("a core-team person → team", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { phone: "9175550001", isTeamMember: true });
    const c = await t.query(internal.smsReceipts.classifySmsSender, { phone: "+19175550001" });
    expect(c.senderClass).toBe("team");
    expect(c.personId).not.toBeNull();
  });

  test("a non-team roster person → roster", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { phone: "9175550002" });
    const c = await t.query(internal.smsReceipts.classifySmsSender, { phone: "9175550002" });
    expect(c.senderClass).toBe("roster");
  });

  test("an unresolved number → external (never 'internal' — no org-domain equivalent)", async () => {
    const t = newT();
    await setupChapter(t);
    const c = await t.query(internal.smsReceipts.classifySmsSender, { phone: "+19995551234" });
    expect(c.senderClass).toBe("external");
    expect(c.personId).toBeNull();
    expect(c.chapterId).toBeNull();
  });

  test("a contact-only match (guest/donor, never a cardholder) → external, not auto-attached", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { phone: "9175550003", isContactOnly: true });
    const c = await t.query(internal.smsReceipts.classifySmsSender, { phone: "9175550003" });
    expect(c.senderClass).toBe("external");
    expect(c.personId).toBeNull();
    expect(c.chapterId).toBeNull();
  });
});

// ── processSmsReceipt (end-to-end, keyless) ──────────────────────────────────
describe("processSmsReceipt", () => {
  test("a roster body-only text auto-attaches, reconciles, and writes a receipt + link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { phone: "9175550010" });
    const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

    const { receiptId } = await t.mutation(internal.smsReceipts.recordSmsReceipt, {
      envelope: {
        messageSid: "SM_body_1",
        fromPhone: "+19175550010",
        body: "Home Depot receipt — Total: $42.10",
      },
    });
    await t.action(internal.smsReceipts.processSmsReceipt, {
      receiptId,
      body: "Home Depot receipt — Total: $42.10",
      media: [],
    });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.status).toBe("matched");
    expect(row?.matchedTransactionId).toBe(txn);
    expect(row?.sourceKind).toBe("body");
    expect(row?.senderClass).toBe("roster");
    expect(row?.channel).toBe("sms");
    expect(row?.receiptStorageId).toBeDefined();

    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.status).toBe("reconciled");
    expect(txnRow?.receiptStorageId).toBe(row?.receiptStorageId);

    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts.length).toBe(1);
    expect(receipts[0].source).toBe("sms");
    expect(receipts[0].senderClass).toBe("roster");
    expect(receipts[0].linkCount).toBe(1);
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links.length).toBe(1);
    expect(links[0].source).toBe("auto_sms");
    expect(links[0].transactionId).toBe(txn);
  });

  test("an EXTERNAL sender is processed + stored but NEVER auto-attached, even on a unique exact match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

    const { receiptId } = await t.mutation(internal.smsReceipts.recordSmsReceipt, {
      envelope: {
        messageSid: "SM_external_1",
        fromPhone: "+19995551234",
        body: "Receipt — Total: $42.10",
      },
    });
    await t.action(internal.smsReceipts.processSmsReceipt, {
      receiptId,
      body: "Receipt — Total: $42.10",
      media: [],
    });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.senderClass).toBe("external");
    expect(row?.sourceKind).toBe("body");
    expect(row?.ocrAmountCents).toBe(4210);
    expect(row?.status).toBe("needs_review");
    expect(row?.chapterId).toBeUndefined();
    expect(row?.matchedTransactionId).toBeUndefined();

    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBeUndefined();
    expect(txnRow?.status).toBe("categorized");

    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links.length).toBe(0);
    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts.length).toBe(1);
    expect(receipts[0].linkCount).toBe(0);
    expect(receipts[0].chapterId).toBeUndefined();
    expect(receipts[0].senderClass).toBe("external");
  });

  test("no media and no body text → ignored, no receipt document invented", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { phone: "9175550020" });

    const { receiptId } = await t.mutation(internal.smsReceipts.recordSmsReceipt, {
      envelope: { messageSid: "SM_empty_1", fromPhone: "+19175550020", body: "" },
    });
    await t.action(internal.smsReceipts.processSmsReceipt, {
      receiptId,
      body: "",
      media: [],
    });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.status).toBe("ignored");
    expect(row?.senderClass).toBe("roster");
    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts.length).toBe(0);
  });

  test("MMS media Twilio can't fetch (no credentials) degrades to the body text, not silence", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { phone: "9175550030" });
    const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

    const { receiptId } = await t.mutation(internal.smsReceipts.recordSmsReceipt, {
      envelope: {
        messageSid: "SM_media_1",
        fromPhone: "+19175550030",
        body: "Total: $42.10",
      },
    });
    // No Twilio credentials configured anywhere in this test env — the media
    // fetch degrades (logged, not thrown), and the pipeline falls back to the
    // Body text exactly like a media-less message.
    await t.action(internal.smsReceipts.processSmsReceipt, {
      receiptId,
      body: "Total: $42.10",
      media: [{ url: "https://api.twilio.com/media/ME123", contentType: "image/jpeg" }],
    });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.sourceKind).toBe("body");
    expect(row?.status).toBe("matched");
    expect(row?.matchedTransactionId).toBe(txn);
  });
});

// ── /twilio/receipts HTTP route (signature-gated, end-to-end) ───────────────
describe("/twilio/receipts route", () => {
  const path = "/twilio/receipts";
  const url = "https://some.convex.site" + path; // matches convex-test's t.fetch base

  function formBody(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  test("500s when Twilio isn't configured", async () => {
    const t = newT();
    const res = await t.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ MessageSid: "SM1", From: "+19175550000", Body: "hi" }),
    });
    expect(res.status).toBe(500);
  });

  test("rejects a missing signature and a tampered one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setTwilioSettings(s);
    const params = { MessageSid: "SM_sig_1", From: "+19175550000", Body: "Total: $10.00" };

    const noSig = await t.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(params),
    });
    expect(noSig.status).toBe(403);

    const validSig = await signTwilio(url, params, TEST_AUTH_TOKEN);
    const tampered = await t.fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": validSig,
      },
      // Body differs from what was signed → signature no longer matches.
      body: formBody({ ...params, Body: "Total: $999.99" }),
    });
    expect(tampered.status).toBe(403);
  });

  test("a validly signed request records + schedules the pipeline and acks empty TwiML", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await setTwilioSettings(s);
      await seedPerson(s, { phone: "9175550040" });
      const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

      const params = {
        MessageSid: "SM_route_1",
        From: "+19175550040",
        Body: "Total: $42.10",
        NumMedia: "0",
      };
      const sig = await signTwilio(url, params, TEST_AUTH_TOKEN);

      const res = await t.fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": sig,
        },
        body: formBody(params),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/xml/);
      expect(await res.text()).toBe("<Response/>");

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await run(t, (ctx) => ctx.db.query("inboundReceipts").collect());
      expect(rows.length).toBe(1);
      expect(rows[0].smsMessageSid).toBe("SM_route_1");
      expect(rows[0].status).toBe("matched");
      expect(rows[0].matchedTransactionId).toBe(txn);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a redelivered MessageSid is not re-processed a second time", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await setTwilioSettings(s);
      await seedPerson(s, { phone: "9175550050" });
      await seedTxn(s, { amountCents: 4210, status: "categorized" });

      const params = {
        MessageSid: "SM_redeliver_1",
        From: "+19175550050",
        Body: "Total: $42.10",
        NumMedia: "0",
      };
      const sig = await signTwilio(url, params, TEST_AUTH_TOKEN);
      const send = () =>
        t.fetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Twilio-Signature": sig,
          },
          body: formBody(params),
        });

      await send();
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await send();
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await run(t, (ctx) => ctx.db.query("inboundReceipts").collect());
      expect(rows.length).toBe(1);
      const receipts = await run(t, (ctx) => ctx.db.query("receipts").collect());
      expect(receipts.length).toBe(1); // not doubled
    } finally {
      vi.useRealTimers();
    }
  });
});

// Confirm the receipt-source enum accepted `api`/`internal` wiring end to end
// (a lightweight guard that `RECEIPT_SOURCES`'s "sms" addition round-trips
// through `listReceipts`'s validators without a schema mismatch).
describe("receipts.listReceipts surfaces sms-sourced receipts", () => {
  test("an sms-channel receipt appears with source 'sms'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A bookkeeper (finance role, not just chapter "admin") is required to
    // call `listReceipts` — mirrors `receiptInbox.test.ts`'s `grantRole`.
    const self = await seedPerson(s, {});
    await run(s.t, (ctx) => ctx.db.patch(self, { userId: s.userId }));
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: self,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    await seedPerson(s, { phone: "9175550060" });
    await seedTxn(s, { amountCents: 4210, status: "categorized" });

    const { receiptId } = await t.mutation(internal.smsReceipts.recordSmsReceipt, {
      envelope: { messageSid: "SM_list_1", fromPhone: "+19175550060", body: "Total: $42.10" },
    });
    await t.action(internal.smsReceipts.processSmsReceipt, {
      receiptId,
      body: "Total: $42.10",
      media: [],
    });

    const rows = await s.as.query(api.receipts.listReceipts, {});
    expect(rows.some((r) => r.source === "sms")).toBe(true);
  });
});
