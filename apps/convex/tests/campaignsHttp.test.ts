import { describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { verifyResendWebhookSignature } from "../lib/resend";
import type { Id } from "../_generated/dataModel";

/**
 * The HTTP surface for email campaigns: `/unsubscribe/<token>` (GET confirm +
 * POST write) and `/resend/webhook` (Svix-verified bounce/complaint/inbound
 * events).
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

// ── integrationSettings.setEmailCampaignSettings ─────────────────────────────

describe("setEmailCampaignSettings", () => {
  test("a non-superuser is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
        orgMailingAddress: "123 Main St",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("fields are independently settable; the webhook secret is never leaked, only its 'configured' bit", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
      resendWebhookSecret: "whsec_super_secret_value",
      resendInboundDomain: "reply.publicworship.life",
    });
    // Update orgMailingAddress alone — the other two fields must survive.
    await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
      orgMailingAddress: "123 Main St, City, ST",
    });

    const status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.campaigns).toMatchObject({
      resendWebhookConfigured: true,
      resendInboundDomain: "reply.publicworship.life",
      orgMailingAddress: "123 Main St, City, ST",
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("whsec_super_secret_value");

    const rawSecret = await run(s.t, (ctx) =>
      ctx.db.query("integrationSettings").first(),
    );
    expect(rawSecret?.resendWebhookSecret).toBe("whsec_super_secret_value");
  });

  test("null clears a field", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
      resendWebhookSecret: "whsec_x",
    });
    await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
      resendWebhookSecret: null,
    });
    const status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.campaigns.resendWebhookConfigured).toBe(false);
  });
});

// ── verifyResendWebhookSignature (unit) ──────────────────────────────────────

const RAW_KEY = Buffer.from("resend-webhook-test-key-000001!");
const SECRET = `whsec_${RAW_KEY.toString("base64")}`;

function signResendWebhook(id: string, timestamp: string, payload: string, secret: string): string {
  const withoutPrefix = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(withoutPrefix, "base64");
  const mac = createHmac("sha256", keyBytes).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return `v1,${mac}`;
}

describe("verifyResendWebhookSignature", () => {
  const ID = "msg_abc123";
  const TS = String(Math.floor(Date.now() / 1000));
  const PAYLOAD = JSON.stringify({ type: "email.bounced" });

  test("accepts a correctly signed request", async () => {
    const sig = signResendWebhook(ID, TS, PAYLOAD, SECRET);
    expect(
      await verifyResendWebhookSignature(PAYLOAD, { svixId: ID, svixTimestamp: TS, svixSignature: sig }, SECRET),
    ).toBe(true);
  });

  test("rejects a tampered payload", async () => {
    const sig = signResendWebhook(ID, TS, PAYLOAD, SECRET);
    expect(
      await verifyResendWebhookSignature(
        JSON.stringify({ type: "email.complained" }),
        { svixId: ID, svixTimestamp: TS, svixSignature: sig },
        SECRET,
      ),
    ).toBe(false);
  });

  test("rejects the wrong secret", async () => {
    const sig = signResendWebhook(ID, TS, PAYLOAD, SECRET);
    const wrongSecret = `whsec_${Buffer.from("a-completely-different-key-00001").toString("base64")}`;
    expect(
      await verifyResendWebhookSignature(PAYLOAD, { svixId: ID, svixTimestamp: TS, svixSignature: sig }, wrongSecret),
    ).toBe(false);
  });

  test("rejects a missing signature header", async () => {
    expect(
      await verifyResendWebhookSignature(PAYLOAD, { svixId: ID, svixTimestamp: TS, svixSignature: null }, SECRET),
    ).toBe(false);
  });

  test("rejects a stale timestamp (replay guard)", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 10_000);
    const sig = signResendWebhook(ID, staleTs, PAYLOAD, SECRET);
    expect(
      await verifyResendWebhookSignature(
        PAYLOAD,
        { svixId: ID, svixTimestamp: staleTs, svixSignature: sig },
        SECRET,
      ),
    ).toBe(false);
  });

  test("accepts one matching token among multiple space-separated signatures", async () => {
    const sig = signResendWebhook(ID, TS, PAYLOAD, SECRET);
    const multi = `v1,forged_sig_1== ${sig} v1,forged_sig_2==`;
    expect(
      await verifyResendWebhookSignature(PAYLOAD, { svixId: ID, svixTimestamp: TS, svixSignature: multi }, SECRET),
    ).toBe(true);
  });
});

// ── /unsubscribe/<token> ─────────────────────────────────────────────────────

async function seedCampaignRecipient(
  s: ChapterSetup,
): Promise<{ campaignId: Id<"campaigns">; token: string; email: string }> {
  return await run(s.t, async (ctx) => {
    const audienceId = await ctx.db.insert("audiences", {
      scope: "central",
      name: "A",
      source: "people",
      filters: {},
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const campaignId = await ctx.db.insert("campaigns", {
      scope: "central",
      name: "N",
      subject: "Hi",
      audienceId,
      doc: { blocks: [] },
      status: "sending",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const token = "unsub-test-token-1";
    await ctx.db.insert("campaignRecipients", {
      campaignId,
      email: "reader@example.com",
      name: "Reader",
      status: "sent",
      unsubscribeToken: token,
    });
    return { campaignId, token, email: "reader@example.com" };
  });
}

describe("/unsubscribe/<token>", () => {
  test("GET shows the confirm page for a valid token", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { token, email } = await seedCampaignRecipient(s);
    const res = await t.fetch(`/unsubscribe/${token}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(email);
  });

  test("GET 404s for an unknown token", async () => {
    const t = newT();
    const res = await t.fetch("/unsubscribe/does-not-exist", { method: "GET" });
    expect(res.status).toBe(404);
  });

  test("POST suppresses the address and marks the recipient row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { token, email } = await seedCampaignRecipient(s);
    const res = await t.fetch(`/unsubscribe/${token}`, { method: "POST" });
    expect(res.status).toBe(200);

    const suppressions = await run(s.t, (ctx) =>
      ctx.db.query("emailSuppressions").withIndex("by_email", (q) => q.eq("email", email)).collect(),
    );
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].reason).toBe("unsubscribe");

    const recipient = await run(s.t, (ctx) =>
      ctx.db.query("campaignRecipients").withIndex("by_token", (q) => q.eq("unsubscribeToken", token)).first(),
    );
    expect(recipient?.status).toBe("suppressed");
  });

  test("POST is idempotent — a repeat unsubscribe doesn't duplicate the suppression row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { token, email } = await seedCampaignRecipient(s);
    await t.fetch(`/unsubscribe/${token}`, { method: "POST" });
    await t.fetch(`/unsubscribe/${token}`, { method: "POST" });
    const suppressions = await run(s.t, (ctx) =>
      ctx.db.query("emailSuppressions").withIndex("by_email", (q) => q.eq("email", email)).collect(),
    );
    expect(suppressions).toHaveLength(1);
  });

  test("POST 404s for an unknown token", async () => {
    const t = newT();
    const res = await t.fetch("/unsubscribe/does-not-exist", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── /resend/webhook ───────────────────────────────────────────────────────────

async function postResendWebhook(
  t: ReturnType<typeof newT>,
  payload: unknown,
  opts: { id?: string; secret?: string; badSignature?: boolean } = {},
) {
  const body = JSON.stringify(payload);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = opts.badSignature
    ? "v1,forged=="
    : signResendWebhook(id, timestamp, body, opts.secret ?? SECRET);
  return t.fetch("/resend/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    body,
  });
}

async function configureWebhookSecret(s: ChapterSetup): Promise<void> {
  await s.as.mutation(api.integrationSettings.setEmailCampaignSettings, {
    resendWebhookSecret: SECRET,
    resendInboundDomain: "reply.publicworship.life",
  });
}

describe("/resend/webhook", () => {
  test("401s when no webhook secret is configured", async () => {
    const t = newT();
    const res = await postResendWebhook(t, { type: "email.bounced", data: { to: ["x@example.com"] } });
    expect(res.status).toBe(401);
  });

  test("401s on an invalid signature", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureWebhookSecret(s);
    const res = await postResendWebhook(t, { type: "email.bounced", data: { to: ["x@example.com"] } }, {
      badSignature: true,
    });
    expect(res.status).toBe(401);
  });

  test("email.bounced suppresses the address (reason: bounce)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureWebhookSecret(s);
    const res = await postResendWebhook(t, {
      type: "email.bounced",
      data: { to: ["bounced@example.com"] },
    });
    expect(res.status).toBe(200);
    const rows = await run(s.t, (ctx) =>
      ctx.db.query("emailSuppressions").withIndex("by_email", (q) => q.eq("email", "bounced@example.com")).collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("bounce");
  });

  test("email.complained suppresses the address (reason: complaint)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureWebhookSecret(s);
    await postResendWebhook(t, { type: "email.complained", data: { to: ["angry@example.com"] } });
    const rows = await run(s.t, (ctx) =>
      ctx.db.query("emailSuppressions").withIndex("by_email", (q) => q.eq("email", "angry@example.com")).collect(),
    );
    expect(rows[0].reason).toBe("complaint");
  });

  test("dedups on svix-id — a redelivered bounce doesn't double-suppress", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureWebhookSecret(s);
    const id = "msg_redelivered_1";
    await postResendWebhook(t, { type: "email.bounced", data: { to: ["dup@example.com"] } }, { id });
    await postResendWebhook(t, { type: "email.bounced", data: { to: ["dup@example.com"] } }, { id });
    const rows = await run(s.t, (ctx) =>
      ctx.db.query("emailSuppressions").withIndex("by_email", (q) => q.eq("email", "dup@example.com")).collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("an inbound reply matches the campaign via the campaign+<id>@ plus-address and bumps replyCount", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureWebhookSecret(s);
    const { campaignId } = await seedCampaignRecipient(s);

    const res = await postResendWebhook(t, {
      type: "email.received",
      data: {
        to: [`campaign+${campaignId}@reply.publicworship.life`],
        from: "Jane Doe <jane@example.com>",
        subject: "Re: Hi",
        text: "Thanks!",
      },
    });
    expect(res.status).toBe(200);

    const replies = await run(s.t, (ctx) =>
      ctx.db.query("emailReplies").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect(),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      fromEmail: "jane@example.com",
      fromName: "Jane Doe",
      subject: "Re: Hi",
      textBody: "Thanks!",
    });

    const campaign = await run(s.t, (ctx) => ctx.db.get(campaignId));
    expect(campaign?.replyCount).toBe(1);
  });

  test("an inbound reply with no matching plus-address still gets a row (campaignId unset)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureWebhookSecret(s);
    await postResendWebhook(t, {
      type: "email.received",
      data: { to: ["hello@publicworship.life"], from: "stray@example.com", subject: "Hi" },
    });
    const replies = await run(s.t, (ctx) =>
      ctx.db.query("emailReplies").withIndex("by_time").collect(),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].campaignId).toBeUndefined();
  });

  test("an unknown event type is a silent no-op", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await configureWebhookSecret(s);
    const res = await postResendWebhook(t, { type: "email.delivered", data: { to: ["ok@example.com"] } });
    expect(res.status).toBe(200);
    const suppressions = await run(s.t, (ctx) => ctx.db.query("emailSuppressions").collect());
    const replies = await run(s.t, (ctx) => ctx.db.query("emailReplies").collect());
    expect(suppressions).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});

