import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Comms send flow (`commsSend.ts`) — the mutation → scheduled action →
 * finalize-mutation send that posts a comms row's SAVED copy to a Google Chat
 * channel. Covers the guardrails (non-comms item, empty message,
 * unknown/archived channel, cross-chapter access) and the happy/failure
 * delivery outcomes, mirroring `blasts.test.ts`'s fake-timers +
 * `finishAllScheduledFunctions` pattern for draining a scheduled action, and
 * `itemUnschedule.test.ts`'s hand-seeded `eventTypes`/`events`/`eventItems`
 * fixture shape.
 */

const VALID_WEBHOOK =
  "https://chat.googleapis.com/v1/spaces/AAA/messages?key=x&token=y";

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Eden",
      slug: "eden",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Eden",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedItem(
  s: ChapterSetup,
  eventId: Id<"events">,
  opts: { module: string; title?: string; notes?: string; status?: string },
): Promise<Id<"eventItems">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventItems", {
      eventId,
      chapterId: s.chapterId,
      module: opts.module,
      title: opts.title ?? "T-3 reminder",
      order: 0,
      status: opts.status,
      fields: opts.notes !== undefined ? { notes: opts.notes } : undefined,
    }),
  );
}

async function seedChannel(s: ChapterSetup, opts: { name?: string; archived?: boolean } = {}) {
  return await run(s.t, (ctx) => {
    const now = Date.now();
    return ctx.db.insert("googleChatChannels", {
      name: opts.name ?? "Leaders",
      webhookUrl: VALID_WEBHOOK,
      archived: opts.archived,
      createdBy: s.userId,
      updatedBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("sendCommsToGoogleChat guardrails", () => {
  test("rejects a non-comms item; nothing scheduled, item untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      notes: "Confirm venue",
    });
    const channelId = await seedChannel(s);

    await expect(
      s.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId,
        message: "Confirm venue",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.status).toBeUndefined();
  });

  test("rejects a whitespace-only message; nothing scheduled", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, {
      module: "comms",
      notes: "Hey team",
    });
    const channelId = await seedChannel(s);

    await expect(
      s.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId,
        message: "   ",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an unknown channel id", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, { module: "comms", notes: "Hey team" });
    const otherChapter = await setupChapter(t, { email: "other2@publicworship.life" });
    const bogusChannelId = await seedChannel(otherChapter);
    // Delete it so the id is genuinely unknown.
    await run(t, (ctx) => ctx.db.delete(bogusChannelId));

    await expect(
      s.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId: bogusChannelId,
        message: "Hey team",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an archived channel", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, { module: "comms", notes: "Hey team" });
    const channelId = await seedChannel(s, { archived: true });

    await expect(
      s.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId,
        message: "Hey team",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a caller from a different chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, { module: "comms", notes: "Hey team" });
    const channelId = await seedChannel(s);

    const other = await setupChapter(t, { email: "other@publicworship.life" });
    await expect(
      other.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId,
        message: "Hey team",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("sendCommsToGoogleChat delivery", () => {
  test("happy path: flips status to sent and records the outcome", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEvent(s);
      const itemId = await seedItem(s, eventId, {
        module: "comms",
        title: "T-3 reminder",
        notes: "Hey team, be on time.",
        status: "draft",
      });
      const channelId = await seedChannel(s, { name: "Leaders" });

      globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;

      await s.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId,
        message: "Hey team, be on time.",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const item = await run(t, (ctx) => ctx.db.get(itemId));
      expect(item?.status).toBe("sent");
      expect(item?.fields?.lastGoogleChatSend).toMatchObject({
        channelId: String(channelId),
        channelName: "Leaders",
        status: "sent",
      });
      expect(item?.fields?.lastGoogleChatSend.error).toBeUndefined();
      expect(typeof item?.fields?.lastGoogleChatSend.sentAt).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });

  test("includeTitle: false posts the copy verbatim; default keeps the heading", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEvent(s);
      const itemId = await seedItem(s, eventId, {
        module: "comms",
        title: "T-3 reminder",
        notes: "Hey team, be on time.",
        status: "draft",
      });
      const channelId = await seedChannel(s, { name: "Leaders" });

      const bodies: string[] = [];
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)).text);
        return { ok: true };
      }) as unknown as typeof fetch;

      await s.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId,
        message: "Hey team, be on time.",
        includeTitle: false,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      await s.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId,
        message: "Hey team, be on time.",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(bodies).toEqual([
        "Hey team, be on time.",
        "*T-3 reminder* — Eden\n\nHey team, be on time.",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("failure path: status untouched, records a failed outcome without the webhook URL", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEvent(s);
      const itemId = await seedItem(s, eventId, {
        module: "comms",
        title: "T-3 reminder",
        notes: "Hey team, be on time.",
        status: "draft",
      });
      const channelId = await seedChannel(s, { name: "Leaders" });

      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        text: async () => "oops",
      })) as unknown as typeof fetch;

      await s.as.mutation(api.commsSend.sendCommsToGoogleChat, {
        itemId,
        channelId,
        message: "Hey team, be on time.",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const item = await run(t, (ctx) => ctx.db.get(itemId));
      expect(item?.status).toBe("draft");
      const outcome = item?.fields?.lastGoogleChatSend;
      expect(outcome.status).toBe("failed");
      expect(typeof outcome.error).toBe("string");
      expect(outcome.error.length).toBeGreaterThan(0);
      expect(outcome.error.includes(VALID_WEBHOOK)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
