import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runBackfillWallFromGifts } from "../migrations/0076_backfill_wall_from_gifts";
import type { Id } from "../_generated/dataModel";

/**
 * Public activity wall (`/give` redesign, wave 2, F6; recomposed by
 * give-redesign-v3 C1/C2) tests:
 *  - `recordPendingActivity` records EVERY gift and pledge — consent gates
 *    attribution, never existence (D6) — and is idempotent on `refKey`;
 *  - `markActivityVisible` flips a pending row to visible, re-stamps the
 *    SETTLED amount, and is idempotent (a second flip is a no-op);
 *  - `getPublicWall` (C1): central gifts appear tagged `central` (D7), a
 *    non-consented gift appears anonymously, a consented one is named, a
 *    payment-reversed one stays off, `raisedCents` comes from the scope
 *    rollups (D8) and never from a `gifts` scan, and a territory with fewer
 *    than three lifetime gifts is not named;
 *  - `getTerritoryActivity` (the pre-v3 read the un-swapped city renderer
 *    still calls) is UNCHANGED: only visible, consented rows for the right
 *    territory, newest first, capped, PII-free;
 *  - the admin surfaces (`listActivityAdmin` / `hideActivity`) are gated to
 *    central `giving.view`/`giving.manage`;
 *  - CONSENT: attribution is withheld from any row that lacks BOTH an
 *    explicit `consent: true` and the `consentIndexable: true` that licenses
 *    a search-findable page — including every row written before either field
 *    existed (absent ⇒ NO).
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
  test("records a gift that carries neither a name nor a message — existence is not attribution (D6)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_blank",
      consent: true,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 5000,
    });
    // This used to insert NOTHING ("nothing to show"), which is how the wall
    // ended up a highlight reel of the givers who filled in an optional text
    // box. The gift is the thing worth showing; the name is a bonus.
    const row = await activityByRefKey(t, "give:cs_blank");
    expect(row?.status).toBe("pending");
    expect(row?.amountCents).toBe(5000);
    expect(row?.displayName).toBeUndefined();
  });

  test("records a CENTRAL gift — the scope the old wall could not hold (D7)", async () => {
    const t = newT();
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_central",
      consent: false,
      scope: "central",
      kind: "central",
      amountCents: 12345,
    });
    const row = await activityByRefKey(t, "give:cs_central");
    expect(row?.scope).toBe("central");
    expect(row?.kind).toBe("central");
    expect(row?.amountCents).toBe(12345);
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
  test("a refused giver still gets a row — and none of their attribution is stored", async () => {
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
    const row = await activityByRefKey(t, "give:cs_no_consent");
    // The gift counts (D6) …
    expect(row?.amountCents).toBe(5000);
    expect(row?.consent).toBe(false);
    // … and the name they typed before un-ticking the box is not kept at all.
    // Storing it would leave a public handle in a table whose purpose is to be
    // published, one read-path bug away from disclosure.
    expect(row?.displayName).toBeUndefined();
    expect(row?.message).toBeUndefined();
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

  test("markActivityVisible settles a row with no recorded consent — the gift is public, the giver isn't", async () => {
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
    // It used to stay `pending` for ever. Withholding settlement protected
    // nobody once the row itself became anonymous — it just deleted a real
    // gift from "every gift, in public" (D6). The name on this legacy row is
    // still never returned; that is the read path's job, asserted below.
    expect(row?.status).toBe("visible");
    expect(typeof row?.settledAt).toBe("number");
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

// ── The staff takedown path (/giving/wall) ────────────────────────────────────

/**
 * The desk-side takedown a donor's "please take me off the wall" email
 * depends on. Until this shipped the only takedown was a developer running
 * `hideActivity` by hand, so these cover the whole round trip a staff member
 * can now perform: see the entry, remove it, and put it back if they were
 * wrong — plus every case where putting it back would be wrong.
 */
describe("staff takedown + restore", () => {
  /** A settled, consented, publicly-visible wall entry. */
  async function visibleEntry(
    s: ChapterSetup,
    chapterId: Id<"chapters">,
    opts: { refKey: string; displayName: string; consent?: boolean },
  ): Promise<Id<"givingActivity">> {
    return run(s.t, (ctx) =>
      ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: opts.displayName,
        amountCents: 5000,
        status: "visible",
        refKey: opts.refKey,
        ...(opts.consent === false ? {} : { consent: true }),
        createdAt: Date.now(),
        settledAt: Date.now(),
      }),
    );
  }

  test("the desk list carries what a moderator needs: consent, why it came down, and which page it's on", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "listing-city");
    const id = await visibleEntry(s, chapterId, {
      refKey: "give:cs_listing",
      displayName: "Sam K.",
    });

    const row = (
      await s.as.query(api.givingActivity.listActivityAdmin, {})
    ).find((r) => r._id === id);
    expect(row).toBeDefined();
    expect(row!.consent).toBe(true);
    expect(row!.hiddenReason).toBeNull();
    expect(row!.territorySlug).toBe("listing-city");
    expect(row!.territoryName).toBe("listing-city");
    // Nothing taken down yet, so nothing attributed.
    expect(row!.hiddenByName).toBeNull();
    expect(row!.hiddenAt).toBeNull();
  });

  test("a takedown records WHO and WHEN, and the desk list shows them", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "attribution-city");
    const id = await visibleEntry(s, chapterId, {
      refKey: "give:cs_attribution",
      displayName: "Attributed",
    });

    const before = Date.now();
    await s.as.mutation(api.givingActivity.hideActivity, { id });

    const stored = await run(s.t, (ctx) => ctx.db.get(id));
    expect(stored?.hiddenBy).toBe(s.userId);
    expect(stored?.hiddenAt).toBeGreaterThanOrEqual(before);

    const listed = (
      await s.as.query(api.givingActivity.listActivityAdmin, {})
    ).find((r) => r._id === id);
    // Resolved to something a human can read, not a raw id — the user's name
    // when there is one, else their email (this fixture user has only an email).
    expect(listed!.hiddenByName).toBe("leader@publicworship.life");
    expect(listed!.hiddenAt).toBe(stored!.hiddenAt);

    // Putting it back clears the whole takedown stamp — a row that is back up
    // was not taken down by anyone.
    await s.as.mutation(api.givingActivity.restoreActivity, { id });
    const restored = await run(s.t, (ctx) => ctx.db.get(id));
    expect(restored?.hiddenBy).toBeUndefined();
    expect(restored?.hiddenAt).toBeUndefined();
    expect(restored?.hiddenReason).toBeUndefined();
  });

  test("a payment-reversed withdrawal is attributed to nobody — the system did it, not a person", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "system-actor-city");
    const id = await visibleEntry(s, chapterId, {
      refKey: "give:cs_system_actor",
      displayName: "Bounced",
    });

    await s.t.mutation(internal.givingActivity.withdrawActivity, {
      refKey: "give:cs_system_actor",
    });

    const stored = await run(s.t, (ctx) => ctx.db.get(id));
    expect(stored?.hiddenReason).toBe("payment_reversed");
    // Claiming a person did this would be a lie.
    expect(stored?.hiddenBy).toBeUndefined();
    expect(stored?.hiddenAt).toBeUndefined();

    const listed = (
      await s.as.query(api.givingActivity.listActivityAdmin, {})
    ).find((r) => r._id === id);
    expect(listed!.hiddenByName).toBeNull();
  });

  test("take down → gone from the public page and marked as a staff decision; put back → live again", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "takedown-city");
    const id = await visibleEntry(s, chapterId, {
      refKey: "give:cs_takedown",
      displayName: "Regretful Donor",
    });

    const onWall = async () =>
      (
        await s.t.query(api.givingActivity.getTerritoryActivity, {
          slug: "takedown-city",
        })
      ).some((r) => r.displayName === "Regretful Donor");

    expect(await onWall()).toBe(true);

    await s.as.mutation(api.givingActivity.hideActivity, { id });
    expect(await onWall()).toBe(false);
    // `"staff"` is what makes it restorable — a takedown nobody can undo is a
    // button staff are afraid to press.
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.hiddenReason).toBe(
      "staff",
    );

    await s.as.mutation(api.givingActivity.restoreActivity, { id });
    expect(await onWall()).toBe(true);
    const restored = await run(s.t, (ctx) => ctx.db.get(id));
    expect(restored?.status).toBe("visible");
    expect(restored?.hiddenReason).toBeUndefined();
  });

  test("a takedown of an ANONYMOUS row is still undoable — and it comes back anonymous", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "consentless-city");
    // A pre-consent row (the field is absent entirely), taken down by staff.
    const id = await visibleEntry(s, chapterId, {
      refKey: "give:cs_no_consent",
      displayName: "Never Asked",
      consent: false,
    });
    await s.as.mutation(api.givingActivity.hideActivity, { id });

    // Restore used to REFUSE this row, on the reasoning that restoring was a
    // publish path. Under D6 it isn't: attribution is decided on every read,
    // so a row goes back exactly as anonymous as it came down — and a staff
    // member who took one down by mistake isn't stuck with it.
    await s.as.mutation(api.givingActivity.restoreActivity, { id });
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.status).toBe("visible");

    // The read gate is what protects the name, and it still does: the legacy
    // per-city read drops the row entirely, and the v3 wall shows it with no
    // name on it.
    expect(
      await s.t.query(api.givingActivity.getTerritoryActivity, {
        slug: "consentless-city",
      }),
    ).toEqual([]);
    const wall = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "consentless-city",
    });
    expect(wall.rows).toHaveLength(1);
    expect(wall.rows[0]!.displayName).toBeNull();
  });

  test("an entry pulled because its payment reversed is NOT restorable", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "reversed-city");
    const id = await visibleEntry(s, chapterId, {
      refKey: "give:cs_reversed",
      displayName: "Bounced Debit",
    });

    await s.t.mutation(internal.givingActivity.withdrawActivity, {
      refKey: "give:cs_reversed",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.hiddenReason).toBe(
      "payment_reversed",
    );

    await expect(
      s.as.mutation(api.givingActivity.restoreActivity, { id }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.status).toBe("hidden");
  });

  test("restoring a never-settled entry returns it to pending, not to the public wall", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "pending-city");
    const id = await run(s.t, (ctx) =>
      ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        displayName: "Not Settled Yet",
        amountCents: 5000,
        status: "pending",
        refKey: "give:cs_pending",
        consent: true,
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.givingActivity.hideActivity, { id });
    await s.as.mutation(api.givingActivity.restoreActivity, { id });
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.status).toBe("pending");
    expect(
      await s.t.query(api.givingActivity.getTerritoryActivity, {
        slug: "pending-city",
      }),
    ).toEqual([]);
  });

  test("restoreActivity is central `giving.manage` only, and refuses an entry that isn't hidden", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "restore-gate-city");
    const id = await visibleEntry(s, chapterId, {
      refKey: "give:cs_restore_gate",
      displayName: "Live Entry",
    });

    // Not hidden — nothing to undo.
    await expect(
      s.as.mutation(api.givingActivity.restoreActivity, { id }),
    ).rejects.toBeInstanceOf(ConvexError);

    await s.as.mutation(api.givingActivity.hideActivity, { id });

    const t2 = newT();
    await run(t2, (ctx) => runSeedSeatDefs(ctx));
    const chapterOnly = await setupChapter(t2, { chapterName: "Elsewhere" });
    await seatCaller(chapterOnly, "chapter_director", chapterOnly.chapterId);
    await expect(
      chapterOnly.as.mutation(api.givingActivity.restoreActivity, { id }),
    ).rejects.toBeInstanceOf(ConvexError);
    // Still hidden — the rejected caller changed nothing.
    expect((await run(s.t, (ctx) => ctx.db.get(id)))?.status).toBe("hidden");
  });
});

// ── getPublicWall (give-redesign-v3 C1) ──────────────────────────────────────

/**
 * The v3 wall: the org-wide and per-city feed the `/give` pages render, plus
 * the live totals under them.
 *
 * The load-bearing claims, in the order the spec makes them:
 *  - D6 — every settled gift appears; consent decides only whether it carries
 *    a name.
 *  - D7 — a gift to central operations appears, tagged `central`. The old wall
 *    dropped these on the floor at the checkout, because `scope` could not
 *    hold `"central"`.
 *  - D8 — `raisedCents` is LIVE and comes from `givingScopeRollups`, so a
 *    giver can give and watch the number move. Never a `gifts` scan.
 *  - "Privacy posture" — attribution needs `consentIndexable` too, because
 *    these pages are indexable (D10) and a consent captured under the old,
 *    `noindex` promise was consent to something smaller.
 *  - C1 — a territory with fewer than three lifetime gifts is not named: one
 *    gift in a small prospect city identifies the giver.
 */
describe("getPublicWall", () => {
  /** Seed the denormalized per-scope rollup the totals read (D8). One row per
   *  scope is the table's own invariant — this is what a live deployment's
   *  gift writes maintain. */
  async function seedRollup(
    s: ChapterSetup,
    scope: Id<"chapters"> | "central",
    totals: { lifetimeCents: number; giftCount: number; donorCount: number },
  ): Promise<void> {
    await run(s.t, (ctx) =>
      ctx.db.insert("givingScopeRollups", {
        scope,
        lifetimeCents: totals.lifetimeCents,
        giftCount: totals.giftCount,
        donorCount: totals.donorCount,
        activeCount: 0,
        lapsedCount: 0,
        prospectCount: 0,
        updatedAt: Date.now(),
      }),
    );
  }

  /** A settled, publicly-visible wall row. `consent`/`consentIndexable` are
   *  omitted unless asked for, which is exactly what a backfilled or refused
   *  row looks like. */
  async function settledRow(
    s: ChapterSetup,
    row: {
      scope: Id<"chapters"> | "central";
      kind: "backer" | "gift" | "fundraiser" | "central";
      amountCents: number;
      refKey: string;
      settledAt: number;
      displayName?: string;
      message?: string;
      consent?: boolean;
      consentIndexable?: boolean;
      eventId?: Id<"events">;
    },
  ): Promise<Id<"givingActivity">> {
    return run(s.t, (ctx) =>
      ctx.db.insert("givingActivity", {
        scope: row.scope,
        kind: row.kind,
        amountCents: row.amountCents,
        status: "visible",
        refKey: row.refKey,
        createdAt: row.settledAt,
        settledAt: row.settledAt,
        ...(row.displayName ? { displayName: row.displayName } : {}),
        ...(row.message ? { message: row.message } : {}),
        ...(row.consent !== undefined ? { consent: row.consent } : {}),
        ...(row.consentIndexable !== undefined
          ? { consentIndexable: row.consentIndexable }
          : {}),
        ...(row.eventId ? { eventId: row.eventId } : {}),
      }),
    );
  }

  test("a central gift appears on the org-wide wall, tagged `central` and labelled for a reader (D7)", async () => {
    const s = await devDirectorSetup();
    const now = Date.now();
    await settledRow(s, {
      scope: "central",
      kind: "central",
      amountCents: 25000,
      refKey: "give:cs_central_wall",
      settledAt: now,
    });

    const wall = await s.t.query(api.givingActivity.getPublicWall, {});
    expect(wall.rows).toHaveLength(1);
    const row = wall.rows[0]!;
    expect(row.kind).toBe("central");
    expect(row.amountCents).toBe(25000);
    // Central is the org, not a place — it gets a name, and no city link.
    expect(row.scopeLabel).toBe("Central operations");
    expect(row.scopeSlug).toBeNull();
  });

  test("a gift with no consent appears anonymously — existence is not attribution (D6)", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "anon-city");
    await seedRollup(s, chapterId, {
      lifetimeCents: 30000,
      giftCount: 9,
      donorCount: 4,
    });
    await settledRow(s, {
      scope: chapterId,
      kind: "gift",
      amountCents: 5000,
      refKey: "gift:anon_1",
      settledAt: Date.now(),
    });

    const wall = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "anon-city",
    });
    expect(wall.rows).toHaveLength(1);
    const row = wall.rows[0]!;
    // It counts, it is placed, and it names nobody: "A gift to anon-city — $50".
    expect(row.amountCents).toBe(5000);
    expect(row.scopeLabel).toBe("anon-city");
    expect(row.displayName).toBeNull();
    expect(row.message).toBeNull();
  });

  test("a consented, indexable gift shows its name and message", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "named-city");
    await seedRollup(s, chapterId, {
      lifetimeCents: 30000,
      giftCount: 9,
      donorCount: 4,
    });
    await settledRow(s, {
      scope: chapterId,
      kind: "gift",
      amountCents: 500000,
      refKey: "give:cs_named",
      settledAt: Date.now(),
      displayName: "Sam K.",
      message: "Let's make this happen.",
      consent: true,
      consentIndexable: true,
    });

    const wall = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "named-city",
    });
    expect(wall.rows[0]!.displayName).toBe("Sam K.");
    expect(wall.rows[0]!.message).toBe("Let's make this happen.");
  });

  test("a consent given under the OLD, noindex promise stays anonymous on an indexable page", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "old-consent-city");
    await seedRollup(s, chapterId, {
      lifetimeCents: 30000,
      giftCount: 9,
      donorCount: 4,
    });
    // `consent: true`, `consentIndexable` absent — every row written before
    // the new copy existed. They agreed to be shown on a page that asked not
    // to be indexed; D10 takes that `noindex` off, and their old yes does not
    // stretch to cover it.
    await settledRow(s, {
      scope: chapterId,
      kind: "gift",
      amountCents: 5000,
      refKey: "give:cs_old_consent",
      settledAt: Date.now(),
      displayName: "Pre-v3 Giver",
      message: "Go get 'em.",
      consent: true,
    });

    const wall = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "old-consent-city",
    });
    // Still appears, still counts, still anonymous.
    expect(wall.rows).toHaveLength(1);
    expect(wall.rows[0]!.amountCents).toBe(5000);
    expect(wall.rows[0]!.displayName).toBeNull();
    expect(wall.rows[0]!.message).toBeNull();
  });

  test("a payment-reversed row stays off the wall — an entry means money that arrived", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "reversal-city");
    await seedRollup(s, chapterId, {
      lifetimeCents: 30000,
      giftCount: 9,
      donorCount: 4,
    });
    await settledRow(s, {
      scope: chapterId,
      kind: "gift",
      amountCents: 30000,
      refKey: "give:cs_bounced",
      settledAt: Date.now(),
      consent: true,
      consentIndexable: true,
      displayName: "Bounced Debit",
    });
    await settledRow(s, {
      scope: chapterId,
      kind: "gift",
      amountCents: 4000,
      refKey: "give:cs_good",
      settledAt: Date.now() + 1,
    });

    // The bank took it back (`givingComms.onAchFailed`).
    await s.t.mutation(internal.givingActivity.withdrawActivity, {
      refKey: "give:cs_bounced",
    });

    const wall = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "reversal-city",
    });
    expect(wall.rows.map((r) => r.amountCents)).toEqual([4000]);
    // And it is gone from the org-wide feed too, not just the city's.
    const orgWide = await s.t.query(api.givingActivity.getPublicWall, {});
    expect(orgWide.rows.map((r) => r.amountCents)).toEqual([4000]);
  });

  test("raisedCents/giftCount/giverCount come from the scope rollups, never from a gifts scan (D8)", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "totals-city");
    const otherChapterId = await makeTerritory(s, "other-city");
    await seedRollup(s, chapterId, {
      lifetimeCents: 250000,
      giftCount: 12,
      donorCount: 7,
    });
    await seedRollup(s, otherChapterId, {
      lifetimeCents: 100000,
      giftCount: 5,
      donorCount: 3,
    });
    await seedRollup(s, "central", {
      lifetimeCents: 50000,
      giftCount: 2,
      donorCount: 2,
    });

    // Org-wide: every book, summed.
    const orgWide = await s.t.query(api.givingActivity.getPublicWall, {});
    expect(orgWide.totals.raisedCents).toBe(400000);
    expect(orgWide.totals.giftCount).toBe(19);
    expect(orgWide.totals.giverCount).toBe(12);
    // Both territories are publicly visible, so both are taking backers.
    expect(orgWide.totals.cityCount).toBe(2);

    // Scoped: that city's book only.
    const scoped = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "totals-city",
    });
    expect(scoped.totals.raisedCents).toBe(250000);
    expect(scoped.totals.giftCount).toBe(12);
    expect(scoped.totals.giverCount).toBe(7);
    expect(scoped.totals.cityCount).toBe(1);

    // LIVE, by construction: bump the rollup the way a settling gift does and
    // the headline moves on the very next read — no snapshot, no publication
    // cycle (that language belongs to `/finances`).
    await run(s.t, async (ctx) => {
      const rollup = await ctx.db
        .query("givingScopeRollups")
        .withIndex("by_scope", (q) => q.eq("scope", chapterId))
        .unique();
      await ctx.db.patch(rollup!._id, {
        lifetimeCents: rollup!.lifetimeCents + 10000,
      });
    });
    const after = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "totals-city",
    });
    expect(after.totals.raisedCents).toBe(260000);
  });

  test("backerCount is the chapter's own derived counter, summed across public cities", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "backers-city");
    const otherChapterId = await makeTerritory(s, "backers-other-city");
    await run(s.t, async (ctx) => {
      await ctx.db.patch(chapterId, { backerCount: 8 });
      await ctx.db.patch(otherChapterId, { backerCount: 5 });
    });

    const orgWide = await s.t.query(api.givingActivity.getPublicWall, {});
    expect(orgWide.totals.backerCount).toBe(13);
    const scoped = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "backers-city",
    });
    expect(scoped.totals.backerCount).toBe(8);
  });

  test("a territory with fewer than three lifetime gifts is not named — one gift in a small city is a person (C1)", async () => {
    const s = await devDirectorSetup();
    const tinyChapterId = await makeTerritory(s, "tiny-city");
    const bigChapterId = await makeTerritory(s, "big-city");
    await seedRollup(s, tinyChapterId, {
      lifetimeCents: 50000,
      giftCount: 2, // one under the floor
      donorCount: 1,
    });
    await seedRollup(s, bigChapterId, {
      lifetimeCents: 50000,
      giftCount: 3, // exactly the floor — named
      donorCount: 3,
    });
    const now = Date.now();
    await settledRow(s, {
      scope: tinyChapterId,
      kind: "gift",
      amountCents: 50000,
      refKey: "gift:tiny_1",
      settledAt: now,
    });
    await settledRow(s, {
      scope: bigChapterId,
      kind: "gift",
      amountCents: 1000,
      refKey: "gift:big_1",
      settledAt: now + 1,
    });

    const wall = await s.t.query(api.givingActivity.getPublicWall, {});
    const tiny = wall.rows.find((r) => r.amountCents === 50000)!;
    const big = wall.rows.find((r) => r.amountCents === 1000)!;
    // The amount and the gift still show — only the place is withheld, and
    // the slug goes with the label (a link says the same thing the label does).
    expect(tiny.scopeLabel).toBeNull();
    expect(tiny.scopeSlug).toBeNull();
    expect(big.scopeLabel).toBe("big-city");
    expect(big.scopeSlug).toBe("big-city");
  });

  test("the feed is newest-settled first and honours the limit — default 12, hard cap 30", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "ordering-city");
    await seedRollup(s, chapterId, {
      lifetimeCents: 100000,
      giftCount: 40,
      donorCount: 20,
    });
    const base = Date.now();
    for (let i = 0; i < 40; i++) {
      await settledRow(s, {
        scope: chapterId,
        kind: "gift",
        amountCents: 100 + i,
        refKey: `gift:ordering_${i}`,
        settledAt: base + i,
      });
    }

    const orgDefault = await s.t.query(api.givingActivity.getPublicWall, {});
    expect(orgDefault.rows).toHaveLength(12);
    // Newest settle first — i = 39 is the most recent.
    expect(orgDefault.rows[0]!.amountCents).toBe(139);

    // A caller asking for more than the ceiling gets the ceiling, not what it
    // asked for: this is an unauthed public query.
    const capped = await s.t.query(api.givingActivity.getPublicWall, {
      limit: 1000,
    });
    expect(capped.rows).toHaveLength(30);

    // The per-city feed reads a different index and sorts by `settledAt`
    // itself — same answer.
    const scoped = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "ordering-city",
      limit: 5,
    });
    expect(scoped.rows.map((r) => r.amountCents)).toEqual([
      139, 138, 137, 136, 135,
    ]);
  });

  test("pending and hidden rows never surface, and an unknown or hidden slug reads empty rather than erroring", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "quiet-city");
    await run(s.t, async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        amountCents: 111,
        status: "pending",
        refKey: "give:cs_still_pending",
        createdAt: now,
      });
      await ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        amountCents: 222,
        status: "hidden",
        refKey: "give:cs_taken_down",
        createdAt: now,
        settledAt: now,
      });
    });

    expect(
      (await s.t.query(api.givingActivity.getPublicWall, { slug: "quiet-city" }))
        .rows,
    ).toEqual([]);
    expect((await s.t.query(api.givingActivity.getPublicWall, {})).rows).toEqual(
      [],
    );

    await s.as.mutation(api.territories.saveTerritory, {
      name: "Hidden",
      region: "NY",
      lat: 40.7,
      lng: -73.8,
      slug: "hidden-wall-city",
      publiclyVisible: false,
    });
    // A hidden territory is indistinguishable from one that never existed —
    // a public page must not leak whether a slug is real.
    const hidden = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "hidden-wall-city",
    });
    const unknown = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "no-such-city",
    });
    expect(hidden).toEqual(unknown);
    expect(hidden.rows).toEqual([]);
    expect(hidden.totals.raisedCents).toBe(0);
  });

  test("a wall row carries no PII and no payment identifiers", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "pii-city");
    await seedRollup(s, chapterId, {
      lifetimeCents: 10000,
      giftCount: 5,
      donorCount: 3,
    });
    await settledRow(s, {
      scope: chapterId,
      kind: "gift",
      amountCents: 5000,
      refKey: "give:cs_pii",
      settledAt: Date.now(),
    });

    const wall = await s.t.query(api.givingActivity.getPublicWall, {
      slug: "pii-city",
    });
    expect(Object.keys(wall.rows[0]!).sort()).toEqual(
      [
        "amountCents",
        "at",
        "displayName",
        "goal",
        "kind",
        "message",
        "scopeLabel",
        "scopeSlug",
      ].sort(),
    );
    // `refKey` is a Stripe session id — it identifies a payment, so it never
    // leaves the table.
    expect(wall.rows[0]!).not.toHaveProperty("refKey");
  });
});

// ── Migration 0074: the wall's history ───────────────────────────────────────

/**
 * The wall shipped as an opt-in echo, so on the day "Every gift, in public"
 * goes live the table holds almost nothing. 0074 writes one ANONYMOUS row per
 * recent settled gift so the page's headline is true when a reader first sees
 * it. It moves no money and touches no rollup — the totals come from
 * `givingScopeRollups` either way.
 */
describe("0074 wall backfill", () => {
  async function seedGift(
    s: ChapterSetup,
    gift: {
      scope: Id<"chapters"> | "central";
      amountCents: number;
      receivedAt: number;
      externalRef?: string;
    },
  ): Promise<void> {
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: gift.scope,
        kind: "individual",
        name: "Historical Donor",
        status: "active",
        lifetimeCents: gift.amountCents,
        giftCount: 1,
        createdAt: gift.receivedAt,
      });
      await ctx.db.insert("gifts", {
        donorId,
        scope: gift.scope,
        amountCents: gift.amountCents,
        currency: "usd",
        receivedAt: gift.receivedAt,
        method: "stripe",
        ...(gift.externalRef ? { externalRef: gift.externalRef } : {}),
        createdAt: gift.receivedAt,
      });
    });
  }

  test("echoes historical gifts anonymously, skips ones already on the wall, and is safe to re-run", async () => {
    const s = await devDirectorSetup();
    const chapterId = await makeTerritory(s, "history-city");
    const base = Date.now() - 10_000;

    await seedGift(s, { scope: chapterId, amountCents: 7500, receivedAt: base });
    await seedGift(s, {
      scope: "central",
      amountCents: 20000,
      receivedAt: base + 1,
    });
    // A gift that ALREADY produced a wall row at checkout time, carrying its
    // giver's consented name. The backfill must not shadow it with an
    // anonymous duplicate.
    await seedGift(s, {
      scope: chapterId,
      amountCents: 30000,
      receivedAt: base + 2,
      externalRef: "give:cs_already_walled",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("givingActivity", {
        scope: chapterId,
        kind: "gift",
        amountCents: 30000,
        status: "visible",
        refKey: "give:cs_already_walled",
        displayName: "Consented Giver",
        consent: true,
        consentIndexable: true,
        createdAt: base + 2,
        settledAt: base + 2,
      }),
    );

    const first = await run(s.t, (ctx) => runBackfillWallFromGifts(ctx));
    expect(first.inserted).toBe(2);
    expect(first.skippedExisting).toBe(1);

    // Re-running changes nothing — the ledger skips it in production, and the
    // `refKey` checks make it harmless even if it didn't.
    const second = await run(s.t, (ctx) => runBackfillWallFromGifts(ctx));
    expect(second.inserted).toBe(0);
    expect(second.skippedExisting).toBe(3);

    await run(s.t, (ctx) =>
      ctx.db.insert("givingScopeRollups", {
        scope: chapterId,
        lifetimeCents: 37500,
        giftCount: 5,
        donorCount: 3,
        activeCount: 0,
        lapsedCount: 0,
        prospectCount: 0,
        updatedAt: Date.now(),
      }),
    );

    const wall = await s.t.query(api.givingActivity.getPublicWall, {});
    // All three gifts are on the wall: two backfilled, one already there.
    expect(wall.rows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([
      7500, 20000, 30000,
    ]);
    // The central gift is tagged as such (D7) …
    expect(wall.rows.find((r) => r.amountCents === 20000)!.kind).toBe("central");
    // … the backfilled chapter gift names nobody — history never agreed to be
    // named, and its donor's CRM name must never reach this table …
    expect(wall.rows.find((r) => r.amountCents === 7500)!.displayName).toBeNull();
    // … and the pre-existing consented row keeps its name.
    expect(wall.rows.find((r) => r.amountCents === 30000)!.displayName).toBe(
      "Consented Giver",
    );
  });
});
