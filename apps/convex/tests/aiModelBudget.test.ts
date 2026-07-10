import { describe, expect, test } from "vitest";
import {
  AI_MODELS,
  DEFAULT_AI_MODEL,
  FREE_MODEL_FALLBACKS,
  ASSISTANT_REASONING_EFFORT,
  isFreeModelSlug,
  isOverChatBudget,
  costFromPricing,
  aiCostUsd,
} from "@events-os/shared";

/**
 * The pure helpers behind the per-chat model + budget feature:
 *   - free vs paid model detection (gates paid models behind superuser),
 *   - the per-chat spend cap rule (the guardrail on a paid chat),
 *   - cost-from-pricing (so paid spend is accounted from real per-token prices),
 * plus a few invariants the action + fallback logic rely on.
 */

describe("isFreeModelSlug", () => {
  test("`:free` slugs are free by suffix alone", () => {
    expect(isFreeModelSlug("deepseek/deepseek-r1:free")).toBe(true);
    expect(isFreeModelSlug("some/unknown-model:free")).toBe(true);
  });

  test("a known paid model is not free", () => {
    expect(isFreeModelSlug("anthropic/claude-sonnet-5")).toBe(false);
  });

  test("pricing decides for unknown (catalog) slugs: zero price → free", () => {
    expect(
      isFreeModelSlug("vendor/mystery", { inputPerMTok: 0, outputPerMTok: 0 }),
    ).toBe(true);
    expect(
      isFreeModelSlug("vendor/mystery", { inputPerMTok: 3, outputPerMTok: 15 }),
    ).toBe(false);
  });

  test("unknown slug with no pricing is treated as not-free (fail safe)", () => {
    // Fail-safe: an unknown model with no price info must NOT be assumed free,
    // or a paid model could slip past the superuser gate.
    expect(isFreeModelSlug("vendor/mystery")).toBe(false);
  });
});

describe("isOverChatBudget", () => {
  test("no limit set → never over", () => {
    expect(isOverChatBudget(999, null)).toBe(false);
    expect(isOverChatBudget(999, undefined)).toBe(false);
  });

  test("at or above the cap is over; below is not", () => {
    expect(isOverChatBudget(4.99, 5)).toBe(false);
    expect(isOverChatBudget(5, 5)).toBe(true);
    expect(isOverChatBudget(5.01, 5)).toBe(true);
  });

  test("a zero cap freezes the chat immediately", () => {
    expect(isOverChatBudget(0, 0)).toBe(true);
  });
});

describe("costFromPricing / aiCostUsd", () => {
  test("free model estimates to $0", () => {
    expect(aiCostUsd(DEFAULT_AI_MODEL, { inputTokens: 10_000, outputTokens: 5_000 })).toBe(0);
  });

  test("paid model bills input + output per million tokens", () => {
    // 1M input @ $3 + 1M output @ $15 = $18.
    const cost = costFromPricing(
      { inputPerMTok: 3, outputPerMTok: 15 },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(18, 6);
  });

  test("cached input reads are discounted", () => {
    const full = costFromPricing(
      { inputPerMTok: 10, outputPerMTok: 0 },
      { inputTokens: 1_000_000, outputTokens: 0 },
    );
    const cached = costFromPricing(
      { inputPerMTok: 10, outputPerMTok: 0 },
      { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 },
    );
    expect(cached).toBeLessThan(full);
  });

  test("unknown slug estimates to $0 (gateway cost is used for real paid spend)", () => {
    expect(aiCostUsd("vendor/not-in-table", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
  });
});

describe("model registry invariants", () => {
  test("the default model exists and is free", () => {
    expect(AI_MODELS[DEFAULT_AI_MODEL]).toBeDefined();
    expect(AI_MODELS[DEFAULT_AI_MODEL].free).toBe(true);
  });

  test("every fallback is a real, free model", () => {
    for (const slug of FREE_MODEL_FALLBACKS) {
      expect(isFreeModelSlug(slug)).toBe(true);
    }
  });

  test("assistant reasoning effort is high", () => {
    expect(ASSISTANT_REASONING_EFFORT).toBe("high");
  });
});
