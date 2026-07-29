import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { DEFAULT_EMAIL_THEME, WINTER_THEME } from "@events-os/shared";

/**
 * Campaign polls (`campaignPolls.ts` + the `/poll/` routes in `http.ts` +
 * `lib/pollPage.ts`):
 *  - GET renders a confirm page and records NOTHING (mail scanners prefetch
 *    every href — recording on GET would give every option a phantom vote at
 *    delivery). POST is what writes.
 *  - One vote per recipient per poll: re-voting UPDATES the row.
 *  - A forged block/option/campaign/token 404s instead of creating a junk row.
 *  - `getPollResults` counts per option and is access-gated.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";
const BLOCK_ID = "blk_poll1";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

/** A document with one poll block (plus a heading, so the walker has to find
 *  the poll rather than assume it's first). */
function pollDoc(theme?: unknown) {
  return {
    ...(theme ? { theme } : {}),
    blocks: [
      { id: "blk_head", kind: "heading", text: "Help us pick" },
      {
        id: BLOCK_ID,
        kind: "poll",
        question: "Which night works best?",
        options: [
          { id: "opt_sun", label: "Sunday" },
          { id: "opt_wed", label: "Wednesday" },
        ],
      },
    ],
  };
}

type PollFixture = {
  campaignId: Id<"campaigns">;
  tokens: string[];
  recipientIds: Id<"campaignRecipients">[];
};

/** Makes every seeded recipient's token globally unique, the way a real
 *  `newGuestToken()` is — two campaigns sharing a token string would make the
 *  cross-campaign tests pass for the wrong reason. */
let tokenSeq = 0;

/** A sent campaign carrying a poll, plus `recipients` materialized rows —
 *  written directly (the real send path needs Resend, which these tests don't
 *  exercise; what matters here is the token → recipient → campaign chain the
 *  `/poll/` route walks). */
async function seedPollCampaign(
  s: ChapterSetup,
  opts: { recipients?: number; theme?: unknown } = {},
): Promise<PollFixture> {
  const count = opts.recipients ?? 1;
  return run(s.t, async (ctx) => {
    const audienceId = await ctx.db.insert("audiences", {
      scope: "central",
      name: "Everyone",
      source: "people",
      filters: {},
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const campaignId = await ctx.db.insert("campaigns", {
      scope: "central",
      name: "October newsletter",
      subject: "Which night?",
      audienceId,
      doc: pollDoc(opts.theme),
      status: "sent",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const tokens: string[] = [];
    const recipientIds: Id<"campaignRecipients">[] = [];
    for (let i = 0; i < count; i++) {
      const token = `poll-token-${tokenSeq++}`;
      tokens.push(token);
      recipientIds.push(
        await ctx.db.insert("campaignRecipients", {
          campaignId,
          email: `reader${i}@example.com`,
          name: `Reader ${i}`,
          status: "sent",
          unsubscribeToken: token,
        }),
      );
    }
    return { campaignId, tokens, recipientIds };
  });
}

function pollPath(
  campaignId: Id<"campaigns">,
  token: string,
  blockId = BLOCK_ID,
  optionId = "opt_sun",
): string {
  return `/poll/${campaignId}/${token}/${blockId}/${optionId}`;
}

async function allVotes(t: TestConvex) {
  return run(t, (ctx) => ctx.db.query("campaignPollVotes").collect());
}

// ── GET: read-only ────────────────────────────────────────────────────────

describe("GET /poll/…", () => {
  test("renders the confirm page and records NOTHING", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s);

    const res = await t.fetch(pollPath(campaignId, tokens[0]), { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Which night works best?");
    expect(body).toContain("Sunday");
    // The confirm button posts back to the same path — that POST is the write.
    expect(body).toContain(`action="${pollPath(campaignId, tokens[0])}"`);
    expect(body).toContain('name="robots" content="noindex"');

    // The whole point: a prefetching link scanner has now "clicked" this and
    // no vote exists.
    expect(await allVotes(t)).toHaveLength(0);
  });

  test("wears the campaign's own theme", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s, { theme: WINTER_THEME });
    const res = await t.fetch(pollPath(campaignId, tokens[0]), { method: "GET" });
    const body = await res.text();
    expect(body).toContain(WINTER_THEME.accent);
    expect(body).toContain(WINTER_THEME.canvas);
  });

  test("404s for an unknown token, a foreign campaign id, a bad block, and a forged option", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s);
    const other = await seedPollCampaign(s);

    for (const path of [
      pollPath(campaignId, "not-a-real-token"),
      // A real token, but pointed at a DIFFERENT campaign's id.
      pollPath(other.campaignId, tokens[0]),
      pollPath(campaignId, tokens[0], "blk_does_not_exist"),
      // The heading block is real but isn't a poll.
      pollPath(campaignId, tokens[0], "blk_head"),
      // A FORGED option id on a real poll — this must never create a tally row.
      pollPath(campaignId, tokens[0], BLOCK_ID, "opt_write_in"),
    ]) {
      const res = await t.fetch(path, { method: "GET" });
      expect(res.status).toBe(404);
    }
    expect(await allVotes(t)).toHaveLength(0);
  });

  test("404s on a malformed path and on a garbage campaign id", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s);
    expect((await t.fetch(`/poll/${campaignId}/${tokens[0]}`, { method: "GET" })).status).toBe(404);
    expect(
      (await t.fetch(`/poll/not-an-id/${tokens[0]}/${BLOCK_ID}/opt_sun`, { method: "GET" }))
        .status,
    ).toBe(404);
  });
});

// ── POST: the write ───────────────────────────────────────────────────────

describe("POST /poll/…", () => {
  test("records the vote and shows the running tally", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens, recipientIds } = await seedPollCampaign(s);

    const res = await t.fetch(pollPath(campaignId, tokens[0]), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Your answer is in");
    expect(body).toContain("Sunday");
    expect(body).toContain("1 answer so far");

    const votes = await allVotes(t);
    expect(votes).toHaveLength(1);
    expect(votes[0]).toMatchObject({
      campaignId,
      recipientId: recipientIds[0],
      blockId: BLOCK_ID,
      optionId: "opt_sun",
    });
  });

  test("re-voting UPDATES the existing row — never a second vote", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s);

    await t.fetch(pollPath(campaignId, tokens[0], BLOCK_ID, "opt_sun"), { method: "POST" });
    await t.fetch(pollPath(campaignId, tokens[0], BLOCK_ID, "opt_wed"), { method: "POST" });

    const votes = await allVotes(t);
    expect(votes).toHaveLength(1);
    expect(votes[0].optionId).toBe("opt_wed");

    const results = await s.as.query(api.campaignPolls.getPollResults, { campaignId });
    expect(results[0].totalVotes).toBe(1);
    expect(results[0].options).toEqual([
      { optionId: "opt_sun", label: "Sunday", count: 0 },
      { optionId: "opt_wed", label: "Wednesday", count: 1 },
    ]);
  });

  test("re-POSTing the same option is idempotent (a retried request)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s);
    await t.fetch(pollPath(campaignId, tokens[0]), { method: "POST" });
    await t.fetch(pollPath(campaignId, tokens[0]), { method: "POST" });
    expect(await allVotes(t)).toHaveLength(1);
  });

  test("different recipients each get their own vote", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s, { recipients: 3 });

    await t.fetch(pollPath(campaignId, tokens[0], BLOCK_ID, "opt_sun"), { method: "POST" });
    await t.fetch(pollPath(campaignId, tokens[1], BLOCK_ID, "opt_sun"), { method: "POST" });
    await t.fetch(pollPath(campaignId, tokens[2], BLOCK_ID, "opt_wed"), { method: "POST" });

    expect(await allVotes(t)).toHaveLength(3);
    const results = await s.as.query(api.campaignPolls.getPollResults, { campaignId });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      blockId: BLOCK_ID,
      question: "Which night works best?",
      totalVotes: 3,
      truncated: false,
    });
    expect(results[0].options.map((o) => o.count)).toEqual([2, 1]);
  });

  test("a forged option id 404s and writes no tally row", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s);
    const res = await t.fetch(pollPath(campaignId, tokens[0], BLOCK_ID, "opt_forged"), {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(await allVotes(t)).toHaveLength(0);
  });

  test("a valid token from another campaign can't vote in this one", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const a = await seedPollCampaign(s);
    const b = await seedPollCampaign(s);
    const res = await t.fetch(pollPath(a.campaignId, b.tokens[0]), { method: "POST" });
    expect(res.status).toBe(404);
    expect(await allVotes(t)).toHaveLength(0);
  });
});

// ── Results ───────────────────────────────────────────────────────────────

describe("getPollResults", () => {
  test("returns zero counts for a poll nobody has answered", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId } = await seedPollCampaign(s);
    const results = await s.as.query(api.campaignPolls.getPollResults, { campaignId });
    expect(results).toHaveLength(1);
    expect(results[0].totalVotes).toBe(0);
    expect(results[0].options.map((o) => o.count)).toEqual([0, 0]);
  });

  test("returns [] for a campaign with no poll blocks", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const campaignId = await run(s.t, async (ctx) => {
      const audienceId = await ctx.db.insert("audiences", {
        scope: "central",
        name: "A",
        source: "people",
        filters: {},
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("campaigns", {
        scope: "central",
        name: "N",
        subject: "Hi",
        audienceId,
        doc: { blocks: [{ id: "b1", kind: "divider" }] },
        status: "draft",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect(await s.as.query(api.campaignPolls.getPollResults, { campaignId })).toEqual([]);
  });

  test("is access-gated", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId } = await seedPollCampaign(s);
    const outsider = await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(
      outsider.as.query(api.campaignPolls.getPollResults, { campaignId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

/**
 * A re-sent campaign must not let one person vote twice.
 *
 * `send` is legally re-runnable from `"failed"` (transport failure, or
 * `sweepStuckSends`), and `materializeRecipients` then DELETES every
 * `campaignRecipients` row and re-inserts with fresh `unsubscribeToken`s.
 * One-vote-per-person is enforced by `by_recipient_and_block` — keyed on a
 * `recipientId` that no longer exists after that wipe — so without cleanup
 * the same human votes again on the second copy of the email and BOTH count.
 */
describe("re-send does not enable ballot stuffing", () => {
  test("clearing recipients also clears their poll votes", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedPollCampaign(s);

    await t.fetch(pollPath(campaignId, tokens[0]), { method: "POST" });
    expect(await allVotes(t)).toHaveLength(1);

    // Simulate the re-send wipe exactly as materializeRecipients does it.
    for (;;) {
      const dropped = await t.mutation(internal.campaigns.clearRecipientsBatch, {
        campaignId,
      });
      if (dropped === 0) break;
    }
    for (;;) {
      const dropped = await t.mutation(internal.campaigns.clearPollVotesBatch, {
        campaignId,
      });
      if (dropped === 0) break;
    }

    // No orphans left pointing at deleted recipient rows.
    expect(await allVotes(t)).toHaveLength(0);

    // Same human, new token from the re-send, votes again: still ONE row.
    const newToken = "poll-token-resend-1";
    await run(s.t, (ctx) =>
      ctx.db.insert("campaignRecipients", {
        campaignId,
        email: "reader0@example.com",
        name: "Reader 0",
        status: "sent",
        unsubscribeToken: newToken,
      }),
    );
    await t.fetch(pollPath(campaignId, newToken, BLOCK_ID, "opt_wed"), {
      method: "POST",
    });

    const votes = await allVotes(t);
    expect(votes).toHaveLength(1);
    expect(votes[0].optionId).toBe("opt_wed");

    const results = await s.as.query(api.campaignPolls.getPollResults, { campaignId });
    expect(results[0].totalVotes).toBe(1);
  });
});

// ── Template-kind rows (the templates merge's kind boundary, 2026-07-29) ────

/**
 * A template-kind row can never legitimately reach `campaignRecipients` —
 * nothing on the send path ever materializes one for it (`campaigns.ts`'s
 * `submitForApproval`/`send`/`materializeRecipients` all refuse a
 * template-kind row structurally before that could happen — see
 * `lib/campaignKind.ts`'s doc). These tests forge the row BY HAND to prove
 * the `isTemplateRow` check inside `resolvePollContext` itself is what stops
 * a vote, not merely "no such token exists."
 */
describe("template-kind rows never resolve a poll (defense in depth)", () => {
  async function seedTemplateWithForgedRecipient(s: ChapterSetup): Promise<PollFixture> {
    return run(s.t, async (ctx) => {
      const campaignId = await ctx.db.insert("campaigns", {
        scope: "central",
        name: "Newsletter shell",
        subject: "",
        doc: pollDoc(),
        kind: "template",
        status: "draft",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const token = `poll-token-${tokenSeq++}`;
      const recipientId = await ctx.db.insert("campaignRecipients", {
        campaignId,
        email: "forged@example.com",
        status: "queued",
        unsubscribeToken: token,
      });
      return { campaignId, tokens: [token], recipientIds: [recipientId] };
    });
  }

  test("GET /poll/ 404s for a template-kind row even with a real recipient row", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedTemplateWithForgedRecipient(s);
    const res = await t.fetch(pollPath(campaignId, tokens[0]), { method: "GET" });
    expect(res.status).toBe(404);
  });

  test("POST /poll/ 404s and records no vote for a template-kind row", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedTemplateWithForgedRecipient(s);
    const res = await t.fetch(pollPath(campaignId, tokens[0]), { method: "POST" });
    expect(res.status).toBe(404);
    expect(await allVotes(t)).toHaveLength(0);
  });

  test("getPollResults refuses a template-kind row like a missing campaign", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId } = await seedTemplateWithForgedRecipient(s);
    await expect(
      s.as.query(api.campaignPolls.getPollResults, { campaignId }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});

// ── WS2b: the SAME contract, for a tiptap-format campaign's pwPoll node ─────
//
// `pollBlocksOf` (above) is now a thin wrapper over the shared, format-dual
// `findPollNodes` (`@events-os/shared`'s `tiptapEmail.ts`) — this proves the
// backend half of that claim end to end, through the REAL `/poll/` HTTP
// route, exactly like the blocks-format tests above. Mobile's
// `CampaignPollResults.tsx` uses the same shared helper (see that file), so
// there is only one "what counts as a poll" implementation left to test.

const TIPTAP_POLL_ID = "poll_tiptap1";

/** A tiptap doc with a heading (so the walker has to find the poll rather
 *  than assume it's the first node) and a two-option `pwPoll` node, nested
 *  one level inside a `section` — proving the walk isn't top-level-only the
 *  way the legacy blocks walk was. */
function tiptapPollDoc(theme?: unknown) {
  return {
    type: "doc",
    // A tiptap document carries no `theme` key at all (themes freeze) — this
    // param exists only so a caller CAN forge one onto a hand-built row, to
    // prove `normalizeEmailTheme`'s fallback is what actually decides what
    // renders, not "whatever key happens to be present here".
    ...(theme ? { theme } : {}),
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Help us pick" }],
      },
      {
        type: "section",
        content: [
          {
            type: "pwPoll",
            attrs: {
              id: TIPTAP_POLL_ID,
              question: "Which night works best?",
              options: [
                { id: "opt_sun", label: "Sunday" },
                { id: "opt_wed", label: "Wednesday" },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function seedTiptapPollCampaign(
  s: ChapterSetup,
  opts: { recipients?: number } = {},
): Promise<PollFixture> {
  const count = opts.recipients ?? 1;
  return run(s.t, async (ctx) => {
    const audienceId = await ctx.db.insert("audiences", {
      scope: "central",
      name: "Everyone",
      source: "people",
      filters: {},
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const campaignId = await ctx.db.insert("campaigns", {
      scope: "central",
      name: "October newsletter (tiptap)",
      subject: "Which night?",
      audienceId,
      doc: tiptapPollDoc(),
      docFormat: "tiptap",
      status: "sent",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const tokens: string[] = [];
    const recipientIds: Id<"campaignRecipients">[] = [];
    for (let i = 0; i < count; i++) {
      const token = `poll-token-${tokenSeq++}`;
      tokens.push(token);
      recipientIds.push(
        await ctx.db.insert("campaignRecipients", {
          campaignId,
          email: `tiptapreader${i}@example.com`,
          name: `Tiptap Reader ${i}`,
          status: "sent",
          unsubscribeToken: token,
        }),
      );
    }
    return { campaignId, tokens, recipientIds };
  });
}

describe("a tiptap-format campaign's pwPoll node — the same contract, end to end", () => {
  test("GET renders the confirm page (default theme — tiptap docs carry none) and records nothing", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedTiptapPollCampaign(s);

    const res = await t.fetch(
      pollPath(campaignId, tokens[0], TIPTAP_POLL_ID, "opt_sun"),
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Which night works best?");
    expect(body).toContain("Sunday");
    expect(await allVotes(t)).toHaveLength(0);
  });

  test("guest pages fall back to DEFAULT_EMAIL_THEME when the tiptap doc carries no theme key", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedTiptapPollCampaign(s);
    const res = await t.fetch(
      pollPath(campaignId, tokens[0], TIPTAP_POLL_ID, "opt_sun"),
      { method: "GET" },
    );
    const body = await res.text();
    expect(body).toContain(DEFAULT_EMAIL_THEME.accent);
    expect(body).toContain(DEFAULT_EMAIL_THEME.canvas);
  });

  test("POST records the vote and shows the running tally — a distinct recipient's own vote lands on their own row", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedTiptapPollCampaign(s, { recipients: 2 });

    const res = await t.fetch(
      pollPath(campaignId, tokens[0], TIPTAP_POLL_ID, "opt_sun"),
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Sunday");
    expect(body).toContain("1 answer");

    await t.fetch(pollPath(campaignId, tokens[1], TIPTAP_POLL_ID, "opt_wed"), { method: "POST" });

    const votes = await allVotes(t);
    expect(votes).toHaveLength(2);
    const results = await s.as.query(api.campaignPolls.getPollResults, { campaignId });
    expect(results).toHaveLength(1);
    expect(results[0].blockId).toBe(TIPTAP_POLL_ID);
    expect(results[0].totalVotes).toBe(2);
    expect(results[0].options.find((o) => o.optionId === "opt_sun")?.count).toBe(1);
    expect(results[0].options.find((o) => o.optionId === "opt_wed")?.count).toBe(1);
  });

  test("re-voting UPDATES the existing row — never a second vote — same as the blocks format", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedTiptapPollCampaign(s);

    await t.fetch(pollPath(campaignId, tokens[0], TIPTAP_POLL_ID, "opt_sun"), { method: "POST" });
    await t.fetch(pollPath(campaignId, tokens[0], TIPTAP_POLL_ID, "opt_wed"), { method: "POST" });

    const votes = await allVotes(t);
    expect(votes).toHaveLength(1);
    expect(votes[0].optionId).toBe("opt_wed");
  });

  test("a forged option id 404s and writes no tally row — nested-in-a-section pwPoll is still found and validated", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const { campaignId, tokens } = await seedTiptapPollCampaign(s);
    const res = await t.fetch(
      pollPath(campaignId, tokens[0], TIPTAP_POLL_ID, "opt_write_in"),
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(await allVotes(t)).toHaveLength(0);
  });
});
