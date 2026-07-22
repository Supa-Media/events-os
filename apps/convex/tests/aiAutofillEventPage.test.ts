/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * `aiActions.autofillEventPage` — the RSVP-page "Fill page with AI" action.
 * Nothing is typed or pasted: the event's OWN plan (overview + module rows)
 * is gathered server-side and serialized into the prompt. Characterizes:
 *   - the missing-key gate (`NO_OPENROUTER_KEY`),
 *   - the tenant gate (cross-chapter → NOT_FOUND, zero OpenRouter calls),
 *   - the outgoing prompt actually carries the event's plan (name + item
 *     detail text from multiple modules),
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

/** The user message the stubbed OpenRouter call was sent (the plan document). */
function sentUserContent(fetchStub: ReturnType<typeof vi.fn>): string {
  const [, init] = fetchStub.mock.calls[0] as [string, { body: string }];
  const body = JSON.parse(init.body);
  const userMsg = body.messages.find((m: any) => m.role === "user");
  return String(userMsg?.content ?? "");
}

/**
 * Seed a chapter + event + its public page (via the real creation path) +
 * plan rows across two modules — a Tasks (planning_doc) row whose details
 * carry the games list, and a Comms Schedule row. The event's own plan is
 * what the action serializes into the prompt.
 */
async function seedEventWithPlan(s: ChapterSetup) {
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
      status: "in_progress",
      fields: {
        details: "Games list: cornhole, giant Jenga, and spikeball",
        notes: "Borrow sets from the youth group",
      },
    });
    await ctx.db.insert("eventItems", {
      eventId,
      chapterId: s.chapterId,
      module: "comms",
      title: "IG announcement post",
      order: 0,
      status: "drafting",
      fields: { notes: "Lead with the rooftop sunset angle" },
    });
    return eventId;
  });
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  return { eventId, pageId };
}

describe("aiActions.autofillEventPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  test("no OPENROUTER_API_KEY → throws NO_OPENROUTER_KEY", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPlan(s);

    await expect(
      s.as.action(api.aiActions.autofillEventPage, { eventId, pageId }),
    ).rejects.toMatchObject({
      data: { code: "NO_OPENROUTER_KEY" },
    });
  });

  test("cross-chapter eventId → throws NOT_FOUND before any OpenRouter call", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const a = await setupChapter(t, { email: "a@publicworship.life" });
    const b = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Other Chapter",
    });
    const { eventId, pageId } = await seedEventWithPlan(a);
    const fetchStub = stubOpenRouterOk("{}");

    // Caller is chapter B, page belongs to chapter A.
    await expect(
      b.as.action(api.aiActions.autofillEventPage, { eventId, pageId }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("prompt carries the event's own plan: name + module rows' detail text", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPlan(s);
    const fetchStub = stubOpenRouterOk(JSON.stringify({ tagline: "Up top" }));

    await s.as.action(api.aiActions.autofillEventPage, { eventId, pageId });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const content = sentUserContent(fetchStub);
    // Overview grounding.
    expect(content).toContain("Rooftop Worship Night");
    // Tasks row: title + the details text (the games list).
    expect(content).toContain("Plan lawn games");
    expect(content).toContain("cornhole, giant Jenga, and spikeball");
    // Comms row from a second module, under its module heading.
    expect(content).toContain("Comms Schedule");
    expect(content).toContain("IG announcement post");
  });

  test("successful reply → returns only the supplied fields, trimmed; page row untouched", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPlan(s);
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
    const { eventId, pageId } = await seedEventWithPlan(s);
    stubOpenRouterOk("Sure, here's some copy you could use: A great night!");

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
