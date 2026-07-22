/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { resolveAiProvider } from "../aiActions";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * The dual-provider AI gateway: `resolveAiProvider` (env-driven selection
 * between OpenRouter and the official Anthropic SDK) and the Anthropic call
 * path behind `autofillEventPage`. Characterizes:
 *   - explicit AI_PROVIDER pinning (and its clear missing-key errors),
 *   - auto-detect precedence (OpenRouter wins when both keys are set),
 *   - the no-key error keeps the NO_OPENROUTER_KEY code the UI knows,
 *   - the Anthropic happy path — the SDK request hits api.anthropic.com with
 *     the model + serialized plan, fields come back, aiRuns records the
 *     Anthropic model as done,
 *   - a malformed Anthropic reply degrades to { ok: false, fields: {} }
 *     exactly like the OpenRouter path.
 *
 * The Anthropic SDK uses global fetch in this runtime, so it's stubbed at the
 * same seam as the OpenRouter tests (vi.stubGlobal with a real Response).
 */

const ENV_KEYS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function expectNoKeyError(fn: () => unknown) {
  try {
    fn();
    expect.unreachable("expected resolveAiProvider to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<{ code: string }>).data.code).toBe(
      "NO_OPENROUTER_KEY",
    );
  }
}

describe("resolveAiProvider", () => {
  test("AI_PROVIDER=anthropic with key → anthropic", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    // OpenRouter key present too — the pin must win over auto-detect.
    process.env.OPENROUTER_API_KEY = "or-test";
    expect(resolveAiProvider()).toBe("anthropic");
  });

  test("AI_PROVIDER=anthropic without its key → NO_OPENROUTER_KEY", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.OPENROUTER_API_KEY = "or-test";
    expectNoKeyError(() => resolveAiProvider());
  });

  test("AI_PROVIDER=openrouter with key → openrouter", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "or-test";
    expect(resolveAiProvider()).toBe("openrouter");
  });

  test("AI_PROVIDER=openrouter without its key → NO_OPENROUTER_KEY", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expectNoKeyError(() => resolveAiProvider());
  });

  test("unknown AI_PROVIDER value → clear error, not silent auto-detect", () => {
    process.env.AI_PROVIDER = "openai";
    process.env.OPENROUTER_API_KEY = "or-test";
    expectNoKeyError(() => resolveAiProvider());
  });

  test("auto-detect: both keys set → openrouter wins (existing behavior)", () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(resolveAiProvider()).toBe("openrouter");
  });

  test("auto-detect: only ANTHROPIC_API_KEY → anthropic", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(resolveAiProvider()).toBe("anthropic");
  });

  test("no keys at all → NO_OPENROUTER_KEY", () => {
    expectNoKeyError(() => resolveAiProvider());
  });
});

// ── Anthropic call path through autofillEventPage ────────────────────────────

/** Stub global fetch with an Anthropic-shaped Messages response. */
function stubAnthropicOk(replyText: string) {
  const fetchStub = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: replyText }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 40 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

/** The (url, JSON body) of the first stubbed request, SDK-shape agnostic. */
async function sentRequest(fetchStub: ReturnType<typeof vi.fn>) {
  const [urlArg, init] = fetchStub.mock.calls[0] as [
    string | URL | Request,
    { body?: unknown } | undefined,
  ];
  const url =
    typeof urlArg === "string"
      ? urlArg
      : urlArg instanceof URL
        ? urlArg.toString()
        : urlArg.url;
  const bodyText = init?.body
    ? String(init.body)
    : await (urlArg as Request).clone().text();
  return { url, body: JSON.parse(bodyText) };
}

/** Seed a chapter + event (+ one plan row) + its public page. */
async function seedEventWithPage(s: ChapterSetup) {
  const eventId = await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: "worship-night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Rooftop Worship Night",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("eventItems", {
      eventId,
      chapterId: s.chapterId,
      module: "planning_doc",
      title: "Plan lawn games",
      order: 0,
      fields: { details: "cornhole and giant Jenga" },
    });
    return eventId;
  });
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  return { eventId, pageId };
}

describe("autofillEventPage on the anthropic provider", () => {
  test("happy path: SDK request hits api.anthropic.com with model + plan; fields returned; run done", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    const fetchStub = stubAnthropicOk(
      JSON.stringify({
        tagline: "A rooftop night of worship",
        description: "Join us for live music under the stars.",
      }),
    );

    const result = await s.as.action(api.aiActions.autofillEventPage, {
      eventId,
      pageId,
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        tagline: "A rooftop night of worship",
        description: "Join us for live music under the stars.",
      },
    });

    // The request went to the Anthropic API with the pinned default model and
    // the serialized event plan in the prompt.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const { url, body } = await sentRequest(fetchStub);
    expect(url).toContain("api.anthropic.com");
    expect(url).toContain("/v1/messages");
    expect(body.model).toBe("claude-opus-4-8");
    // No sampling or thinking config on the wire (rejected on Opus 4.8).
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    const promptText = JSON.stringify(body.messages) + String(body.system ?? "");
    expect(promptText).toContain("Rooftop Worship Night");
    expect(promptText).toContain("Plan lawn games");

    // Returns only — the page row is never written by the action.
    const page = await run(t, (ctx) => ctx.db.get(pageId));
    expect(page!.tagline).toBeUndefined();

    // Audited against the Anthropic model, with a real (non-zero) cost.
    const runs = await run(t, (ctx) => ctx.db.query("aiRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(runs[0].model).toBe("claude-opus-4-8");
    expect(runs[0].itemsTouched).toBe(2);
    expect(runs[0].costUsd).toBeGreaterThan(0);
  });

  test("malformed Anthropic reply → { ok: false, fields: {} }, run still done", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    stubAnthropicOk("Sure! Here's a tagline you could use: A great night!");

    const result = await s.as.action(api.aiActions.autofillEventPage, {
      eventId,
      pageId,
    });

    expect(result).toEqual({ ok: false, fields: {} });
    const runs = await run(t, (ctx) => ctx.db.query("aiRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(runs[0].itemsTouched).toBe(0);
  });
});
