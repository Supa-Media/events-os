/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { MAX_PLANNING_DOC_CHARS } from "../aiActions";

/**
 * `aiActions.autofillEventPage` — the RSVP-page "Fill from planning doc"
 * action. Characterizes:
 *   - the input gates (empty / over-length paste) fire BEFORE any OpenRouter
 *     call is made,
 *   - the missing-key gate (`NO_OPENROUTER_KEY`),
 *   - a successful reply returns ONLY the fields the model supplied, trimmed,
 *     and does NOT write the page (the client's local buffers + "Save page"
 *     are the commit path),
 *   - a non-JSON reply is a no-op (`{ ok: false, fields: {} }`), not a crash,
 *     and the run still finishes "done" with itemsTouched 0.
 *
 * OpenRouter is stubbed at the fetch seam, mirroring `aiUsage.test.ts`.
 */

function stubOpenRouterOk(content: string, usage?: Record<string, unknown>) {
  const fetchStub = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage }),
  }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

/** Seed a chapter + event + its public page (via the real creation path). */
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
    return await ctx.db.insert("events", {
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
  });
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  return { eventId, pageId };
}

const DOC = "We're hosting a rooftop worship night with live music and prayer.";

describe("aiActions.autofillEventPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  test("no OPENROUTER_API_KEY → throws NO_OPENROUTER_KEY", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);

    await expect(
      s.as.action(api.aiActions.autofillEventPage, {
        eventId,
        pageId,
        planningDocText: DOC,
      }),
    ).rejects.toMatchObject({
      data: { code: "NO_OPENROUTER_KEY" },
    });
  });

  test("empty/whitespace-only paste → throws EMPTY_INPUT, no OpenRouter call", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    const fetchStub = stubOpenRouterOk("{}");

    await expect(
      s.as.action(api.aiActions.autofillEventPage, {
        eventId,
        pageId,
        planningDocText: "   \n\t ",
      }),
    ).rejects.toMatchObject({ data: { code: "EMPTY_INPUT" } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("over-length paste → throws TEXT_TOO_LONG, no OpenRouter call", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    const fetchStub = stubOpenRouterOk("{}");

    await expect(
      s.as.action(api.aiActions.autofillEventPage, {
        eventId,
        pageId,
        planningDocText: "x".repeat(MAX_PLANNING_DOC_CHARS + 1),
      }),
    ).rejects.toMatchObject({ data: { code: "TEXT_TOO_LONG" } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("cross-chapter eventId → throws NOT_FOUND before any OpenRouter call", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const a = await setupChapter(t, { email: "a@publicworship.life" });
    const b = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Other Chapter",
    });
    const { eventId, pageId } = await seedEventWithPage(a);
    const fetchStub = stubOpenRouterOk("{}");

    // Caller is chapter B, page belongs to chapter A.
    await expect(
      b.as.action(api.aiActions.autofillEventPage, {
        eventId,
        pageId,
        planningDocText: DOC,
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("successful reply → returns only the supplied fields, trimmed; page row untouched", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    stubOpenRouterOk(
      JSON.stringify({
        tagline: "  A rooftop night of worship ",
        description: "Join us for live music and prayer under the stars.",
      }),
      { prompt_tokens: 100, completion_tokens: 30 },
    );

    const result = await s.as.action(api.aiActions.autofillEventPage, {
      eventId,
      pageId,
      planningDocText: DOC,
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        tagline: "A rooftop night of worship",
        description: "Join us for live music and prayer under the stars.",
      },
    });
    // No givingPrompt key — the model didn't return one.
    expect("givingPrompt" in result.fields).toBe(false);

    // The action RETURNS the draft; it never patches the page itself — the
    // client's edit buffers + "Save page" are the review/commit gate.
    const page = await run(t, (ctx) => ctx.db.get(pageId));
    expect(page!.tagline).toBeUndefined();
    expect(page!.description).toBeUndefined();

    // The run is audited as done, touching the two suggested fields.
    const runs = await run(t, (ctx) => ctx.db.query("aiRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0].feature).toBe("autofill_event_page");
    expect(runs[0].status).toBe("done");
    expect(runs[0].itemsTouched).toBe(2);
  });

  test("non-JSON reply → { ok: false, fields: {} }, run finishes done with itemsTouched 0", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    stubOpenRouterOk("Sure, here's some copy you could use: A great night!");

    const result = await s.as.action(api.aiActions.autofillEventPage, {
      eventId,
      pageId,
      planningDocText: DOC,
    });

    expect(result).toEqual({ ok: false, fields: {} });
    const runs = await run(t, (ctx) => ctx.db.query("aiRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(runs[0].itemsTouched).toBe(0);
  });
});
