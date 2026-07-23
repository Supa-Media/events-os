import { afterEach, describe, expect, test, vi } from "vitest";
import {
  chatCompletion,
  listModels,
  testConnection,
  resolveEngineModel,
  type AiEngineConfig,
} from "../lib/aiEngine";

/**
 * Switchable AI engine (`lib/aiEngine.ts`) — the thin OpenAI-compatible client
 * both OpenRouter and Ollama speak. All fetch is mocked (the dev environment is
 * proxy-blocked from the real providers):
 *  - provider switch changes the target URL + auth headers (OpenRouter's
 *    referer/title + `usage:{include}` vs. Ollama's bare bearer),
 *  - a keyless call DEGRADES to a typed error (never a throw) per provider,
 *  - `listModels`/`testConnection` parse the documented `{data:[{id}]}` shape,
 *  - `resolveEngineModel` precedence: per-call override > stored model > default.
 *
 * NO REAL KEY ever appears — "test-key" is a placeholder secret.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function orConfig(over: Partial<AiEngineConfig> = {}): AiEngineConfig {
  return {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api",
    apiKey: "test-key",
    model: null,
    ...over,
  };
}
function olConfig(over: Partial<AiEngineConfig> = {}): AiEngineConfig {
  return {
    provider: "ollama",
    baseUrl: "https://ollama.com",
    apiKey: "test-key",
    model: null,
    ...over,
  };
}

/** Capture the last fetch call's url + init, returning a canned Response. */
function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json ?? {},
      text: async () => response.text ?? JSON.stringify(response.json ?? {}),
    };
  }) as unknown as typeof fetch;
  return calls;
}

describe("chatCompletion — provider routing", () => {
  test("OpenRouter targets /v1/chat/completions with referer + bearer + usage flag", async () => {
    const calls = mockFetch({
      json: { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.01 } },
    });
    const res = await chatCompletion(orConfig(), {
      model: "some/model",
      messages: [{ role: "user", content: "yo" }],
    });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe("Bearer test-key");
    expect(calls[0].init.headers["HTTP-Referer"]).toBe("https://events-os.app");
    const body = JSON.parse(calls[0].init.body);
    expect(body.usage).toEqual({ include: true }); // OpenRouter-only extra
    expect(body.model).toBe("some/model");
  });

  test("Ollama targets ollama.com/v1/chat/completions with bare bearer (no referer, no usage flag)", async () => {
    const calls = mockFetch({ json: { choices: [{ message: { content: "hi" } }] } });
    const res = await chatCompletion(olConfig(), {
      model: "glm-ocr",
      messages: [{ role: "user", content: "yo" }],
    });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://ollama.com/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe("Bearer test-key");
    expect(calls[0].init.headers["HTTP-Referer"]).toBeUndefined();
    const body = JSON.parse(calls[0].init.body);
    expect(body.usage).toBeUndefined();
    expect(body.model).toBe("glm-ocr");
  });

  test("a self-hosted Ollama base URL is honored (trailing slash trimmed)", async () => {
    const calls = mockFetch({ json: { choices: [{ message: { content: "" } }] } });
    await chatCompletion(olConfig({ baseUrl: "http://localhost:11434/" }), {
      model: "gemma4",
      messages: [],
    });
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
  });
});

describe("chatCompletion — keyless degrade returns a typed error (no throw, no fetch)", () => {
  test("OpenRouter with no key", async () => {
    const calls = mockFetch({ json: {} });
    const res = await chatCompletion(orConfig({ apiKey: null }), {
      model: "m",
      messages: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("no_key");
      expect(res.retryable).toBe(false);
      expect(res.message).toContain("OpenRouter");
    }
    expect(calls.length).toBe(0); // never fetched
  });

  test("Ollama with no key", async () => {
    const calls = mockFetch({ json: {} });
    const res = await chatCompletion(olConfig({ apiKey: null }), {
      model: "m",
      messages: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("no_key");
      expect(res.message).toContain("Ollama");
    }
    expect(calls.length).toBe(0);
  });
});

describe("chatCompletion — normalized success + typed HTTP error", () => {
  test("parses content, reasoning, tool calls, and usage", async () => {
    mockFetch({
      json: {
        choices: [
          {
            message: {
              content: "the answer",
              reasoning: "thinking...",
              tool_calls: [{ id: "t1", function: { name: "do", arguments: "{}" } }],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.02, prompt_tokens_details: { cached_tokens: 4 } },
      },
    });
    const res = await chatCompletion(orConfig(), { model: "m", messages: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toBe("the answer");
      expect(res.reasoning).toBe("thinking...");
      expect(res.toolCalls?.[0].function?.name).toBe("do");
      expect(res.usage).toMatchObject({
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.02,
        cachedTokens: 4,
      });
    }
  });

  test("an HTTP error becomes a typed retryable/non-retryable error with a body snippet naming the model", async () => {
    mockFetch({ ok: false, status: 404, text: "model not found: glm-ocr" });
    const res = await chatCompletion(olConfig(), { model: "glm-ocr", messages: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("http");
      expect(res.status).toBe(404);
      expect(res.retryable).toBe(false); // 404 is a hard error
      expect(res.message).toContain("glm-ocr");
      expect(res.bodySnippet).toContain("model not found");
    }
  });

  test("a 429 is marked retryable", async () => {
    mockFetch({ ok: false, status: 429, text: "rate limited" });
    const res = await chatCompletion(orConfig(), { model: "m", messages: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.retryable).toBe(true);
  });
});

describe("listModels / testConnection parse the documented {data:[{id}]} shape", () => {
  test("listModels returns the raw ids in order, unfiltered", async () => {
    const calls = mockFetch({
      json: { data: [{ id: "gemma4" }, { id: "qwen3.5" }, { id: "glm-ocr" }, { notAnId: true }] },
    });
    const res = await listModels(olConfig());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.models).toEqual(["gemma4", "qwen3.5", "glm-ocr"]);
    expect(calls[0].url).toBe("https://ollama.com/v1/models");
  });

  test("listModels degrades to a typed error when Ollama has no key", async () => {
    const calls = mockFetch({ json: {} });
    const res = await listModels(olConfig({ apiKey: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("no_key");
    expect(calls.length).toBe(0);
  });

  test("testConnection reports ok + modelCount on success", async () => {
    mockFetch({ json: { data: [{ id: "a" }, { id: "b" }] } });
    const res = await testConnection(orConfig());
    expect(res).toEqual({ ok: true, modelCount: 2 });
  });

  test("testConnection reports the error string on failure", async () => {
    mockFetch({ ok: false, status: 401, text: "unauthorized" });
    const res = await testConnection(olConfig());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("401");
  });
});

describe("resolveEngineModel — precedence", () => {
  test("per-call override wins over everything", () => {
    expect(
      resolveEngineModel(
        { provider: "ollama", model: "stored" },
        { override: "override", openrouterDefault: "or", ollamaDefault: "ol" },
      ),
    ).toBe("override");
  });

  test("stored global model wins over the per-provider default", () => {
    expect(
      resolveEngineModel(
        { provider: "ollama", model: "stored" },
        { openrouterDefault: "or", ollamaDefault: "ol" },
      ),
    ).toBe("stored");
  });

  test("falls to the OpenRouter default for openrouter when nothing is set", () => {
    expect(
      resolveEngineModel(
        { provider: "openrouter", model: null },
        { openrouterDefault: "or-default", ollamaDefault: "ol-default" },
      ),
    ).toBe("or-default");
  });

  test("falls to the Ollama soft default for ollama when nothing is set", () => {
    expect(
      resolveEngineModel(
        { provider: "ollama", model: null },
        { openrouterDefault: "or-default", ollamaDefault: "ol-default" },
      ),
    ).toBe("ol-default");
  });

  test("blank/whitespace override and stored model are ignored", () => {
    expect(
      resolveEngineModel(
        { provider: "openrouter", model: "   " },
        { override: "  ", openrouterDefault: "or-default", ollamaDefault: "ol" },
      ),
    ).toBe("or-default");
  });
});
