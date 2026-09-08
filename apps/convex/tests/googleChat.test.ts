import { afterEach, describe, expect, test } from "vitest";
import { buildGoogleChatMessage, postGoogleChatMessage } from "../lib/googleChat";
import {
  adaptForEventEnvelope,
  buildOgPreviewResponse,
  extractMatchedUrl,
  parseChapterOsTarget,
} from "../lib/googleChatLinkPreview";
import {
  assertPublicDestination,
  parseOgMetadata,
  requireSafeUrl,
} from "../googleChatLinkPreviewFetch";
import { newT } from "./setup.helpers";

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

describe("Google Chat link preview helpers", () => {
  test("extracts the matched URL from a MESSAGE event", () => {
    expect(
      extractMatchedUrl({
        message: { matchedUrl: { url: "https://open.spotify.com/track/1" } },
      }),
    ).toBe("https://open.spotify.com/track/1");
    expect(extractMatchedUrl({ message: {} })).toBeNull();
  });

  test("extracts the matched URL from a Workspace add-on Chat event", () => {
    const event = {
      chat: {
        messagePayload: {
          message: {
            matchedUrl: { url: "https://publicworship.life/os/project/abc" },
          },
        },
      },
    };
    expect(extractMatchedUrl(event)).toBe(
      "https://publicworship.life/os/project/abc",
    );
    expect(
      adaptForEventEnvelope(
        buildOgPreviewResponse({
          title: "Title",
          description: "",
          image: "",
          url: "https://example.com",
          siteName: "Example",
        }),
        event,
      ),
    ).toEqual({
      hostAppDataAction: {
        chatDataAction: {
          updateInlinePreviewAction: {
            cardsV2: expect.any(Array),
          },
        },
      },
    });
  });

  test("parses real Chapter OS routes without inventing tag routes", () => {
    const appBase = "https://publicworship.life/os";
    expect(
      parseChapterOsTarget(
        "https://publicworship.life/os/project/j57abc",
        appBase,
      ),
    ).toEqual({ kind: "project", id: "j57abc" });
    expect(
      parseChapterOsTarget(
        "https://publicworship.life/os/academy/course/owning-an-event",
        appBase,
      ),
    ).toEqual({ kind: "academyCourse", slug: "owning-an-event" });
    expect(
      parseChapterOsTarget(
        "https://publicworship.life/os/academy/being-an-owner",
        appBase,
      ),
    ).toEqual({ kind: "academyModule", slug: "being-an-owner" });
    expect(
      parseChapterOsTarget("https://publicworship.life/os/team/k97abc", appBase),
    ).toEqual({ kind: "person", id: "k97abc" });
    expect(
      parseChapterOsTarget("https://publicworship.life/os/tag/foo", appBase),
    ).toBeNull();
  });

  test("renders a cardsV2 link-preview response", () => {
    const response = buildOgPreviewResponse({
      title: "Track title",
      description: "A song description",
      image: "https://i.scdn.co/image/abc",
      url: "https://open.spotify.com/track/1",
      siteName: "Spotify",
    });
    expect(response.actionResponse.type).toBe("UPDATE_USER_MESSAGE_CARDS");
    expect(response.cardsV2[0].card.header).toEqual({
      title: "Track title",
      subtitle: "Spotify",
    });
    expect(response.cardsV2[0].card.sections[0].widgets).toEqual(
      expect.arrayContaining([
        {
          image: {
            imageUrl: "https://i.scdn.co/image/abc",
            altText: "Track title",
          },
        },
        { textParagraph: { text: "A song description" } },
        {
          buttonList: {
            buttons: [
              {
                text: "Open link",
                onClick: { openLink: { url: "https://open.spotify.com/track/1" } },
              },
            ],
          },
        },
      ]),
    );
  });

  test("parses Open Graph metadata with HTML fallbacks", () => {
    const metadata = parseOgMetadata(
      `
        <html><head>
          <title>Fallback title</title>
          <meta name="description" content="Fallback description">
          <meta property="og:title" content="OG &amp; title">
          <meta property="og:image" content="/cover.jpg">
        </head></html>
      `,
      "https://example.com/path",
    );
    expect(metadata).toEqual({
      title: "OG & title",
      description: "Fallback description",
      image: "https://example.com/cover.jpg",
      url: "https://example.com/path",
      siteName: "example.com",
    });
  });

  test("rejects non-http URL schemes before fetching", () => {
    expect(() => requireSafeUrl("file:///etc/passwd")).toThrow(
      "Only http and https URLs can be previewed",
    );
    expect(() => requireSafeUrl("https://user:pass@example.com")).toThrow(
      "Credentialed URLs cannot be previewed",
    );
  });

  test("rejects literal local and private destinations", async () => {
    await expect(
      assertPublicDestination(new URL("https://127.0.0.1")),
    ).rejects.toThrow("Private IPs cannot be previewed");
    await expect(
      assertPublicDestination(new URL("https://169.254.169.254")),
    ).rejects.toThrow("Private IPs cannot be previewed");
    await expect(
      assertPublicDestination(new URL("https://[::1]")),
    ).rejects.toThrow("Private IPs cannot be previewed");
  });
});

describe("/google-chat", () => {
  test("rejects requests without Google's bearer token", async () => {
    const t = newT();
    const res = await t.fetch("/google-chat", {
      method: "POST",
      body: JSON.stringify({
        message: { matchedUrl: { url: "https://open.spotify.com/track/1" } },
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
