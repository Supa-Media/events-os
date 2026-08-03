import { afterEach, describe, expect, test } from "vitest";
import { buildGoogleChatMessage, postGoogleChatMessage } from "../lib/googleChat";

/**
 * `lib/googleChat.ts` unit tests — the message formatter + the webhook POST
 * helper. No Convex context needed (pure + fetch-only), so these run without
 * `convex-test`.
 */

describe("buildGoogleChatMessage", () => {
  test("formats a bold heading + copy, with a title", () => {
    expect(
      buildGoogleChatMessage({
        eventName: "Eden",
        itemTitle: "T-3 reminder",
        copy: "Hey team, be on time.",
      }),
    ).toBe("*T-3 reminder* — Eden\n\nHey team, be on time.");
  });

  test("drops the dangling '* — ' when the item is untitled", () => {
    expect(
      buildGoogleChatMessage({
        eventName: "Eden",
        itemTitle: "",
        copy: "Hey team, be on time.",
      }),
    ).toBe("Eden\n\nHey team, be on time.");
  });

  test("includeTitle: false sends the copy verbatim — no heading line at all", () => {
    expect(
      buildGoogleChatMessage({
        eventName: "Eden",
        itemTitle: "T-3 reminder",
        copy: "Hey team, be on time.",
        includeTitle: false,
      }),
    ).toBe("Hey team, be on time.");
  });

  test("includeTitle: true matches the default behavior", () => {
    expect(
      buildGoogleChatMessage({
        eventName: "Eden",
        itemTitle: "T-3 reminder",
        copy: "Hey team, be on time.",
        includeTitle: true,
      }),
    ).toBe("*T-3 reminder* — Eden\n\nHey team, be on time.");
  });
});

describe("postGoogleChatMessage", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs the exact url, header, and JSON body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const url = "https://chat.googleapis.com/v1/spaces/AAA/messages?key=x&token=y";
    await postGoogleChatMessage(url, "hello");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(url);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      "Content-Type": "application/json; charset=UTF-8",
    });
    expect(calls[0].init.body).toBe(JSON.stringify({ text: "hello" }));
  });

  test("throws a status+body error that never contains the webhook URL", async () => {
    const url = "https://chat.googleapis.com/v1/spaces/AAA/messages?key=x&token=SECRET";
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    })) as unknown as typeof fetch;

    await expect(postGoogleChatMessage(url, "hello")).rejects.toThrow();
    try {
      await postGoogleChatMessage(url, "hello");
      throw new Error("expected postGoogleChatMessage to throw");
    } catch (err) {
      const message = String(err);
      expect(message).toContain("400");
      expect(message).toContain("Bad Request");
      expect(message.includes(url)).toBe(false);
    }
  });
});
