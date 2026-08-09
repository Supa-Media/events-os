import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Public activity wall (`/give` redesign, wave 2, F6) tests:
 *  - `recordPendingActivity` skips silently when neither a name nor a
 *    message is present, and is idempotent on `refKey`;
 *  - `markActivityVisible` flips a pending row to visible, re-stamps the
 *    SETTLED amount, and is idempotent (a second flip is a no-op);
 *  - `getTerritoryActivity` returns only visible rows for the right
 *    territory, newest first, capped, and carries no PII (no email/donor
 *    name field — only the self-provided public fields);
 *  - the admin surfaces (`listActivityAdmin` / `hideActivity`) are gated to
 *    central `giving.view`/`giving.manage`;
 *  - CONSENT: no row without an explicit `consent: true`, no publish without
 *    it, and no public read of a row that lacks it — including the rows
 *    written before consent was recorded at all (`consent` absent ⇒ NO).
 */

/** Link a `people` row to the caller's user + seat them (requires seeded
 *  seatDefs) — copied from `territories.test.ts` per that file's convention. */
async function seatCaller(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!def) throw new Error(`${slug} not seeded`);
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    });
  });
}

/** A chapter with the caller seated as development director at central (full
 *  `giving.manage`/`giving.view` over central — and, per `givingAccess.ts`,
 *  every chapter too). */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

/** Create a publicly-visible territory (+ its shadow chapter) via the real
 *  `saveTerritory` mutation, returning its chapter id. */
async function makeTerritory(
  s: ChapterSetup,
  slug: string,
): Promise<Id<"chapters">> {
  const territoryId = await s.as.mutation(api.territories.saveTerritory, {
    name: slug,
    region: "NY",
    lat: 40.7,
    lng: -73.8,
    slug,
    publiclyVisible: true,
  });
  const territory = await run(s.t, (ctx) => ctx.db.get(territoryId));
  return territory!.chapterId;
}

async function activityByRefKey(t: ReturnType<typeof newT>, refKey: string) {
  return run(t, (ctx) =>
    ctx.db
      .query("givingActivity")
      .withIndex("by_refKey", (q) => q.eq("refKey", refKey))
      .unique(),
  );
}

// ── recordPendingActivity ────────────────────────────────────────────────────

describe("recordPendingActivity", () => {
  test("skips entirely when neither displayName nor message is present", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_blank",
      consent: true,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 5000,
    });
    expect(await activityByRefKey(t, "give:cs_blank")).toBeNull();
  });

  test("inserts a pending row, trimmed + capped, when a name or message is present", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const longMessage = "x".repeat(400);
    const longName = "y".repeat(100);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_1",
      consent: true,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 5000,
      displayName: `  ${longName}  `,
      message: `  ${longMessage}  `,
    });
    const row = await activityByRefKey(t, "give:cs_1");
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.scope).toBe(s.chapterId);
    expect(row?.kind).toBe("gift");
    expect(row?.displayName?.length).toBe(60);
    expect(row?.message?.length).toBe(280);
    expect(row?.displayName?.startsWith("y")).toBe(true);
  });

  test("is idempotent on refKey — a second call doesn't insert a duplicate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_dup",
      consent: true,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 5000,
      displayName: "First Name",
    });
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_dup",
      consent: true,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 9999,
      displayName: "Second Name",
    });
    const row = await activityByRefKey(t, "give:cs_dup");
    // Still the FIRST insert — no dup, no overwrite.
    expect(row?.displayName).toBe("First Name");
    expect(row?.amountCents).toBe(5000);
    const all = await run(t, (ctx) =>
      ctx.db
        .query("givingActivity")
        .withIndex("by_refKey", (q) => q.eq("refKey", "give:cs_dup"))
        .collect(),
    );
    expect(all).toHaveLength(1);
  });
});

// ── Consent: the wall is opt-in, and "not asked" means no ────────────────────

describe("wall consent", () => {
  test("recordPendingActivity writes nothing when consent is false", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_no_consent",
      consent: false,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 5000,
      displayName: "Sam K.",
      message: "Let's make this happen.",
    });
    expect(await activityByRefKey(t, "give:cs_no_consent")).toBeNull();
  });

  test("a stored row records the consent that created it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_consented",
      consent: true,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 5000,
      displayName: "Sam K.",
    });
    expect((await activityByRefKey(t, "give:cs_consented"))?.consent).toBe(true);
  });

  test("markActivityVisible refuses to publish a row with no recorded consent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A row as it existed BEFORE consent was recorded — `consent` absent
    // entirely. This is every pre-existing wall entry.
    await run(t, (ctx) =>
      ctx.db.insert("givingActivity", {
        scope: s.chapterId,
        kind: "gift",
        displayName: "Legacy Giver",
        amountCents: 5000,
        status: "pending",
        refKey: "give:cs_legacy",
        createdAt: Date.now(),
      }),
    );

    await t.mutation(internal.givingActivity.markActivityVisible, {
      refKey: "give:cs_legacy",
      amountCents: 5000,
    });

    const row = await activityByRefKey(t, "give:cs_legacy");
    // Still pending, never settled — it can never reach the wall.
    expect(row?.status).toBe("pending");
    expect(row?.settledAt).toBeUndefined();
  });

  test("getTerritoryActivity hides a visible row that carries no consent", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "legacy-city");
    await run(s.t, async (ctx) => {
      const now = Date.now();
      // A pre-consent row someone had already flipped visible.
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Legacy Giver",
        amountCents: 500000,
        status: "visible",
        refKey: "give:cs_legacy_visible",
        createdAt: now,
        settledAt: now,
      });
      // An explicitly-refused row, belt and braces.
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Refused Giver",
        amountCents: 100,
        status: "visible",
        refKey: "give:cs_refused_visible",
        createdAt: now + 1,
        settledAt: now + 1,
        consent: false,
      });
      // The one that actually agreed.
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Consenting Giver",
        amountCents: 2500,
        status: "visible",
        refKey: "give:cs_consented_visible",
        createdAt: now + 2,
        settledAt: now + 2,
        consent: true,
      });
    });

    const rows = await s.t.query(api.givingActivity.getTerritoryActivity, {
      slug: "legacy-city",
    });
    expect(rows.map((r) => r.displayName)).toEqual(["Consenting Giver"]);
  });
});

// ── markActivityVisible ───────────────────────────────────────────────────────

describe("markActivityVisible", () => {
  test("flips pending → visible, re-stamps the settled amount, stamps settledAt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "pledge_abc",
      consent: true,
      scope: s.chapterId,
      kind: "backer",
      amountCents: 5000, // the intended amount
      displayName: "Sam K.",
      message: "Let's make this happen.",
    });

    await t.mutation(internal.givingActivity.markActivityVisible, {
      refKey: "pledge_abc",
      amountCents: 7500, // the SETTLED amount — must win
    });
    const row = await activityByRefKey(t, "pledge_abc");
    expect(row?.status).toBe("visible");
    expect(row?.amountCents).toBe(7500);
    expect(typeof row?.settledAt).toBe("number");
  });

  test("is idempotent — a second flip (even with a different amount) is a no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "pledge_def",
      consent: true,
      scope: s.chapterId,
      kind: "backer",
      amountCents: 5000,
      displayName: "Sam K.",
    });
    await t.mutation(internal.givingActivity.markActivityVisible, {
      refKey: "pledge_def",
      amountCents: 7500,
    });
    const first = await activityByRefKey(t, "pledge_def");
    const firstSettledAt = first?.settledAt;

    await t.mutation(internal.givingActivity.markActivityVisible, {
      refKey: "pledge_def",
      amountCents: 999999, // a redelivered/duplicate flip with a bogus amount
    });
    const second = await activityByRefKey(t, "pledge_def");
    expect(second?.amountCents).toBe(7500); // unchanged
    expect(second?.settledAt).toBe(firstSettledAt); // unchanged
  });

  test("no-ops when no row exists for the refKey (the giver never opted into the wall)", async () => {
    const t = newT();
    await expect(
      t.mutation(internal.givingActivity.markActivityVisible, {
        refKey: "give:cs_never_opted_in",
        amountCents: 1000,
      }),
    ).resolves.not.toThrow();
    expect(await activityByRefKey(t, "give:cs_never_opted_in")).toBeNull();
  });
});

// ── getTerritoryActivity ──────────────────────────────────────────────────────

describe("getTerritoryActivity", () => {
  test("returns only visible rows for the resolved territory, newest first, PII-free", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "queens-ny");

    // A visible gift, a visible backer, a pending gift, and a hidden gift —
    // only the two visible rows should surface.
    await run(s.t, async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Sam K.",
        amountCents: 500000,
        message: "Let's make this happen.",
        status: "visible",
        refKey: "give:cs_visible_1",
        consent: true,
        createdAt: now,
        settledAt: now,
      });
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "backer",
        displayName: "Anon Backer",
        amountCents: 5000,
        status: "visible",
        refKey: "pledge_visible_2",
        consent: true,
        createdAt: now + 1,
        settledAt: now + 1,
      });
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Pending Person",
        amountCents: 1000,
        status: "pending",
        refKey: "give:cs_pending",
        consent: true,
        createdAt: now + 2,
      });
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Hidden Person",
        amountCents: 2000,
        status: "hidden",
        refKey: "give:cs_hidden",
        consent: true,
        createdAt: now + 3,
        settledAt: now + 3,
      });
    });

    const rows = await s.t.query(api.givingActivity.getTerritoryActivity, {
      slug: "queens-ny",
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.displayName).sort()).toEqual(
      ["Anon Backer", "Sam K."].sort(),
    );
    // PII-free: only the public-facing fields, never an email/donor name key.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["amountCents", "at", "displayName", "kind", "message"].sort(),
      );
      expect(row).not.toHaveProperty("email");
    }
    const giftRow = rows.find((r) => r.kind === "gift");
    expect(giftRow?.message).toBe("Let's make this happen.");
    const backerRow = rows.find((r) => r.kind === "backer");
    expect(backerRow?.message).toBeNull(); // absent message → null, not undefined
  });

  test("caps at 20 newest entries", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "capped-city");
    await run(s.t, async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("givingActivity", {
          scope: chapterId,
          kind: "gift",
          displayName: `Giver ${i}`,
          amountCents: 100 * i,
          status: "visible",
          refKey: `give:cs_${i}`,
          consent: true,
          createdAt: Date.now() + i,
          settledAt: Date.now() + i,
        });
      }
    });
    const rows = await s.t.query(api.givingActivity.getTerritoryActivity, {
      slug: "capped-city",
    });
    expect(rows).toHaveLength(20);
  });

  test("an unknown or hidden-territory slug returns an empty wall, not an error", async () => {
    const s = await devDirectorSetup();
    await s.as.mutation(api.territories.saveTerritory, {
      name: "Hidden",
      region: "NY",
      lat: 40.7,
      lng: -73.8,
      slug: "hidden-ny",
      publiclyVisible: false,
    });
    expect(
      await s.t.query(api.givingActivity.getTerritoryActivity, {
        slug: "hidden-ny",
      }),
    ).toEqual([]);
    expect(
      await s.t.query(api.givingActivity.getTerritoryActivity, {
        slug: "does-not-exist",
      }),
    ).toEqual([]);
  });
});

// ── Admin: listActivityAdmin / hideActivity ───────────────────────────────────

describe("admin moderation", () => {
  test("listActivityAdmin + hideActivity are gated to central giving; a chapter-only seat is rejected", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "moderated-city");
    const activityId = await run(s.t, (ctx) =>
      ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Spammy Person",
        amountCents: 100,
        message: "buy my thing",
        status: "visible",
        refKey: "give:cs_spam",
        consent: true,
        createdAt: Date.now(),
        settledAt: Date.now(),
      }),
    );

    const rows = await s.as.query(api.givingActivity.listActivityAdmin, {});
    expect(rows.some((r) => r._id === activityId)).toBe(true);

    await s.as.mutation(api.givingActivity.hideActivity, { id: activityId });
    const hidden = await run(s.t, (ctx) => ctx.db.get(activityId));
    expect(hidden?.status).toBe("hidden");

    // Idempotent — hiding an already-hidden row doesn't throw.
    await expect(
      s.as.mutation(api.givingActivity.hideActivity, { id: activityId }),
    ).resolves.toBeNull();

    // A hidden entry no longer surfaces on the public wall.
    expect(
      (
        await s.t.query(api.givingActivity.getTerritoryActivity, {
          slug: "moderated-city",
        })
      ).some((r) => r.displayName === "Spammy Person"),
    ).toBe(false);

    // A chapter-scope-only giving seat is NOT enough — this is a central surface.
    const t2 = newT();
    await run(t2, (ctx) => runSeedSeatDefs(ctx));
    const chapterOnly = await setupChapter(t2, { chapterName: "Somewhere" });
    await seatCaller(chapterOnly, "chapter_director", chapterOnly.chapterId);
    await expect(
      chapterOnly.as.query(api.givingActivity.listActivityAdmin, {}),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      chapterOnly.as.mutation(api.givingActivity.hideActivity, {
        id: activityId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("hideActivity throws NOT_FOUND for an unknown id", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "notfound-city");
    const activityId = await run(s.t, (ctx) =>
      ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Someone",
        amountCents: 100,
        status: "visible",
        refKey: "give:cs_delete_me",
        consent: true,
        createdAt: Date.now(),
        settledAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) => ctx.db.delete(activityId));
    await expect(
      s.as.mutation(api.givingActivity.hideActivity, { id: activityId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});
