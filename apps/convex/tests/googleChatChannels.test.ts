import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";

/**
 * Google Chat channels — superuser-only CRUD over the deployment-wide named-
 * space list behind the Comms Schedule "Send" button. Covers the same three
 * things `integrationSettings.test.ts` covers for its secrets: the superuser
 * gate (read AND write), the write-only projection (the webhook URL never
 * reaches a client, not even as last4-style truncation), and the
 * archive/restore visibility split (public list excludes archived; the
 * superuser status view still shows them, flagged).
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";
const VALID_WEBHOOK =
  "https://chat.googleapis.com/v1/spaces/AAA/messages?key=x&token=y";

describe("superuser gate", () => {
  test("a non-superuser is rejected adding a channel — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t); // default leader@ — NOT a superuser
    await expect(
      s.as.mutation(api.googleChatChannels.addGoogleChatChannel, {
        name: "Leaders",
        webhookUrl: VALID_WEBHOOK,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await run(t, (ctx) => ctx.db.query("googleChatChannels").collect())).toEqual(
      [],
    );
  });

  test("renameGoogleChatChannel / updateGoogleChatChannelWebhook by a non-superuser are rejected; row unchanged", async () => {
    const t = newT();
    const superuser = await setupChapter(t, { email: SUPERUSER_EMAIL });
    const channelId = await superuser.as.mutation(
      api.googleChatChannels.addGoogleChatChannel,
      { name: "Leaders", webhookUrl: VALID_WEBHOOK },
    );

    const other = await setupChapter(t, { email: "other@publicworship.life" });
    await expect(
      other.as.mutation(api.googleChatChannels.renameGoogleChatChannel, {
        channelId,
        name: "Hijacked",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      other.as.mutation(api.googleChatChannels.updateGoogleChatChannelWebhook, {
        channelId,
        webhookUrl: "https://chat.googleapis.com/v1/spaces/BBB/messages?key=x&token=y",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const row = await run(t, (ctx) => ctx.db.get(channelId));
    expect(row?.name).toBe("Leaders");
    expect(row?.webhookUrl).toBe(VALID_WEBHOOK);
  });
});

describe("write-only projection", () => {
  test("listGoogleChatChannels never carries webhookUrl", async () => {
    const t = newT();
    const superuser = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await superuser.as.mutation(api.googleChatChannels.addGoogleChatChannel, {
      name: "Leaders",
      webhookUrl: VALID_WEBHOOK,
    });

    const viewer = await setupChapter(t, { email: "member@publicworship.life" });
    const result = await viewer.as.query(api.googleChatChannels.listGoogleChatChannels, {});
    expect(result).toEqual([{ _id: expect.any(String), name: "Leaders" }]);
    expect("webhookUrl" in result[0]).toBe(false);
  });

  test("getGoogleChatChannelsStatus shows an urlSuffix, never the full URL or webhookUrl", async () => {
    const t = newT();
    const superuser = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await superuser.as.mutation(api.googleChatChannels.addGoogleChatChannel, {
      name: "Leaders",
      webhookUrl: VALID_WEBHOOK,
    });

    const status = await superuser.as.query(
      api.googleChatChannels.getGoogleChatChannelsStatus,
      {},
    );
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe("Leaders");
    expect(status[0].urlSuffix).toBe(VALID_WEBHOOK.slice(-6));
    expect("webhookUrl" in status[0]).toBe(false);
    expect(JSON.stringify(status)).not.toContain(VALID_WEBHOOK);
  });
});

describe("validation", () => {
  test("rejects a webhookUrl that doesn't start with the Google Chat origin — no row written", async () => {
    const t = newT();
    const superuser = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      superuser.as.mutation(api.googleChatChannels.addGoogleChatChannel, {
        name: "Leaders",
        webhookUrl: "https://evil.example.com/steal",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await run(t, (ctx) => ctx.db.query("googleChatChannels").collect())).toEqual(
      [],
    );
  });
});

describe("archive / restore", () => {
  test("archived channels drop out of the public list but stay visible (flagged) to a superuser", async () => {
    const t = newT();
    const superuser = await setupChapter(t, { email: SUPERUSER_EMAIL });
    const channelId = await superuser.as.mutation(
      api.googleChatChannels.addGoogleChatChannel,
      { name: "Leaders", webhookUrl: VALID_WEBHOOK },
    );

    await superuser.as.mutation(api.googleChatChannels.archiveGoogleChatChannel, {
      channelId,
      archived: true,
    });

    const publicList = await superuser.as.query(
      api.googleChatChannels.listGoogleChatChannels,
      {},
    );
    expect(publicList).toEqual([]);

    const status = await superuser.as.query(
      api.googleChatChannels.getGoogleChatChannelsStatus,
      {},
    );
    expect(status).toHaveLength(1);
    expect(status[0].archived).toBe(true);
  });
});
