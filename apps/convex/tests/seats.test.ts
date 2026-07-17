import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { SEAT_IDS, SEAT_DEFS, MULTI_HOLDER_CAP, titleKind } from "@events-os/shared";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/** Insert a bare `users` row and return a client authenticated as them
 *  (mirrors `guestAccess.test.ts`'s `signInAs`). */
async function signInAs(t: ReturnType<typeof newT>, email: string) {
  const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
  const as = t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId: userId as Id<"users"> };
}

/**
 * Org chart (seats) — schema seed + read queries.
 *
 *  - `runSeedSeatDefs` (migration 0022): idempotent, edit-preserving seed.
 *  - `seats.chart`: central / chapter / full-tree reads, all-vacant post-seed,
 *    per-scope holder resolution, derived `chapter_directors` rollup.
 *  - `seats.mySeatAssignments`: the caller's own assignments across their
 *    roster rows.
 */

const CENTRAL_COUNT = SEAT_IDS.filter((id) => SEAT_DEFS[id].chart === "central")
  .length;
const CHAPTER_COUNT = SEAT_IDS.filter((id) => SEAT_DEFS[id].chart === "chapter")
  .length;

// ── Write mutation test helpers ─────────────────────────────────────────────

/** A superuser-authenticated, seat-seeded chapter setup (seyi@ is on the
 *  superuser allowlist — mirrors `specializedRoles.test.ts`'s pattern). */
async function superuserSetup(opts?: { chapterName?: string }): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, { email: "seyi@publicworship.life", ...opts });
}

/** Insert a bare roster person and return its id. */
async function makePerson(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId, name, createdAt: Date.now() }),
  );
}

/** Insert a placeholder roster person and return its id. */
async function makePlaceholderPerson(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId,
      name,
      isPlaceholder: true,
      createdAt: Date.now(),
    }),
  );
}

/** Insert a second chapter and return its id. */
async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

/** The seatDef row seeded for a template `slug`. */
async function defBySlug(s: ChapterSetup, slug: string) {
  const def = await run(s.t, (ctx) =>
    ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

/** The person's `financeRoles` grant at a scope (chapter id or "central"), or null. */
async function financeGrant(
  s: ChapterSetup,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("financeRoles")
      .withIndex("by_chapter_and_person", (q) =>
        q.eq("chapterId", scope).eq("personId", personId),
      )
      .first(),
  );
}

/** The `specializedRoles` slot row at (scope, title), or null. */
async function specializedRoleRow(
  s: ChapterSetup,
  scope: Id<"chapters"> | "central",
  title: "executive_director" | "president" | "finance_manager",
) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("specializedRoles")
      .withIndex("by_scope_and_title", (q) => q.eq("scope", scope).eq("title", title))
      .first(),
  );
}

describe("0022_seed_seat_defs", () => {
  test("seeds every template seat exactly once", async () => {
    const t = newT();
    const res = await run(t, (ctx) => runSeedSeatDefs(ctx));
    expect(res.inserted).toBe(SEAT_IDS.length);
    expect(res.skipped).toBe(0);

    const rows = await run(t, (ctx) => ctx.db.query("seatDefs").collect());
    expect(rows).toHaveLength(SEAT_IDS.length);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(SEAT_IDS.length);
  });

  test("is idempotent: a second run inserts nothing", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const res2 = await run(t, (ctx) => runSeedSeatDefs(ctx));
    expect(res2.inserted).toBe(0);
    expect(res2.skipped).toBe(SEAT_IDS.length);

    const rows = await run(t, (ctx) => ctx.db.query("seatDefs").collect());
    expect(rows).toHaveLength(SEAT_IDS.length);
  });

  test("a re-run never overwrites a runtime edit to an existing row", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    const edited = await run(t, async (ctx) => {
      const row = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique();
      if (!row) throw new Error("treasurer not seeded");
      await ctx.db.patch(row._id, {
        title: "Chief Money Officer",
        duties: ["A custom runtime duty"],
        updatedAt: Date.now(),
      });
      return row._id;
    });

    await run(t, (ctx) => runSeedSeatDefs(ctx));

    const row = await run(t, (ctx) => ctx.db.get(edited));
    expect(row?.title).toBe("Chief Money Officer");
    expect(row?.duties).toEqual(["A custom runtime duty"]);
  });
});

describe("seats.chart", () => {
  test("central scope returns all 18 central defs, all vacant", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const result = await s.as.query(api.seats.chart, { scope: "central" });
    expect(result.kind).toBe("central");
    if (result.kind !== "central") throw new Error("expected central");
    expect(result.seats).toHaveLength(CENTRAL_COUNT);
    expect(CENTRAL_COUNT).toBe(18);
    expect(result.seats.every((n) => n.vacant)).toBe(true);
    expect(result.seats.every((n) => n.holders.length === 0)).toBe(true);
    // Sorted by declaration order.
    expect(result.seats[0]!.slug).toBe("executive_director");
  });

  test("a chapter scope returns all 9 chapter defs, all vacant", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const result = await s.as.query(api.seats.chart, { scope: s.chapterId });
    expect(result.kind).toBe("chapter");
    if (result.kind !== "chapter") throw new Error("expected chapter");
    expect(result.chapterName).toBe("New York"); // setupChapter's default name
    expect(result.seats).toHaveLength(CHAPTER_COUNT);
    expect(CHAPTER_COUNT).toBe(9);
    expect(result.seats.every((n) => n.vacant)).toBe(true);
  });

  test("no scope returns the full tree: central + every chapter's subtree", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { chapterName: "New York" });
    await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chicago",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.seats.chart, {});
    expect(result.kind).toBe("full");
    if (result.kind !== "full") throw new Error("expected full");
    expect(result.central).toHaveLength(CENTRAL_COUNT);
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters.map((c) => c.chapterName)).toEqual([
      "Chicago",
      "New York",
    ]);
    for (const c of result.chapters) {
      expect(c.seats).toHaveLength(CHAPTER_COUNT);
    }
  });

  test("resolves a directly-assigned holder at its own scope only", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    const otherChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chicago",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const { treasurerDefId, personId } = await run(t, async (ctx) => {
      const treasurerDef = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique();
      if (!treasurerDef) throw new Error("treasurer not seeded");
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Jordan Treasurer",
        userId: s.userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: treasurerDef._id,
        scope: s.chapterId,
        personId,
        createdAt: Date.now(),
      });
      return { treasurerDefId: treasurerDef._id, personId };
    });

    const home = await s.as.query(api.seats.chart, { scope: s.chapterId });
    if (home.kind !== "chapter") throw new Error("expected chapter");
    const treasurerNode = home.seats.find((n) => n.slug === "treasurer")!;
    expect(treasurerNode.vacant).toBe(false);
    expect(treasurerNode.holders).toHaveLength(1);
    expect(treasurerNode.holders[0]!.personId).toBe(personId);
    expect(treasurerNode.holders[0]!.name).toBe("Jordan Treasurer");

    // The SAME shared seat def, read at a DIFFERENT chapter's scope, is vacant.
    const other = await s.as.query(api.seats.chart, { scope: otherChapterId });
    if (other.kind !== "chapter") throw new Error("expected chapter");
    const otherTreasurer = other.seats.find((n) => n.slug === "treasurer")!;
    expect(otherTreasurer.defId).toBe(treasurerDefId);
    expect(otherTreasurer.vacant).toBe(true);

    // seatDetail agrees.
    const detail = await s.as.query(api.seats.seatDetail, {
      defId: treasurerDefId,
      scope: s.chapterId,
    });
    expect(detail?.holders).toHaveLength(1);
    expect(detail?.holders[0]!.personId).toBe(personId);
  });

  test("the derived chapter_directors seat aggregates across two chapters", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { chapterName: "New York" });
    const chicagoId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chicago",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    await run(t, async (ctx) => {
      const chapterDirectorDef = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "chapter_director"))
        .unique();
      if (!chapterDirectorDef) throw new Error("chapter_director not seeded");

      const nyPersonId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Nia NY",
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: chapterDirectorDef._id,
        scope: s.chapterId,
        personId: nyPersonId,
        createdAt: Date.now(),
      });

      const chiPersonId = await ctx.db.insert("people", {
        chapterId: chicagoId,
        name: "Cole Chicago",
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: chapterDirectorDef._id,
        scope: chicagoId,
        personId: chiPersonId,
        createdAt: Date.now(),
      });
    });

    const central = await s.as.query(api.seats.chart, { scope: "central" });
    if (central.kind !== "central") throw new Error("expected central");
    const derivedNode = central.seats.find((n) => n.slug === "chapter_directors")!;
    expect(derivedNode.derived).toBe(true);
    expect(derivedNode.vacant).toBe(false);
    expect(derivedNode.holders).toHaveLength(2);
    const names = derivedNode.holders.map((h) => h.name).sort();
    expect(names).toEqual(["Cole Chicago (Chicago)", "Nia NY (New York)"]);

    // seatDetail on the derived seat aggregates the same way regardless of
    // the (ignored) scope argument.
    const detail = await s.as.query(api.seats.seatDetail, {
      defId: derivedNode.defId,
      scope: "central",
    });
    expect(detail?.holders).toHaveLength(2);
  });

  test("a placeholder person never counts as a holder", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    await run(t, async (ctx) => {
      const def = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "event_lead"))
        .unique();
      if (!def) throw new Error("event_lead not seeded");
      const placeholderId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Placeholder Person",
        isPlaceholder: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: def._id,
        scope: s.chapterId,
        personId: placeholderId,
        createdAt: Date.now(),
      });
    });

    const result = await s.as.query(api.seats.chart, { scope: s.chapterId });
    if (result.kind !== "chapter") throw new Error("expected chapter");
    const node = result.seats.find((n) => n.slug === "event_lead")!;
    expect(node.vacant).toBe(true);
    expect(node.holders).toHaveLength(0);
  });
});

describe("seats.mySeatAssignments", () => {
  test("returns the caller's assignments across their roster rows", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const { musicLeadDefId, personId } = await run(t, async (ctx) => {
      const musicLeadDef = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "music_lead"))
        .unique();
      if (!musicLeadDef) throw new Error("music_lead not seeded");
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Sam Self",
        userId: s.userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: musicLeadDef._id,
        scope: s.chapterId,
        personId,
        createdAt: Date.now(),
      });
      return { musicLeadDefId: musicLeadDef._id, personId };
    });

    const mine = await s.as.query(api.seats.mySeatAssignments, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]!.seatDefId).toBe(musicLeadDefId);
    expect(mine[0]!.slug).toBe("music_lead");
    expect(mine[0]!.scope).toBe(s.chapterId);
    expect(mine[0]!.scopeName).toBe("New York");
    void personId;
  });

  test("returns nothing for a caller with no roster row", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const mine = await s.as.query(api.seats.mySeatAssignments, {});
    expect(mine).toEqual([]);
  });
});

describe("seats access control", () => {
  test("chart/seatDetail/mySeatAssignments all reject a fully signed-out caller", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    await expect(t.query(api.seats.chart, {})).rejects.toThrow(ConvexError);
    await expect(
      t.query(api.seats.mySeatAssignments, {}),
    ).rejects.toThrow(ConvexError);

    const anyDef = await run(t, (ctx) =>
      ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", "treasurer")).unique(),
    );
    await expect(
      t.query(api.seats.seatDetail, { defId: anyDef!._id, scope: "central" }),
    ).rejects.toThrow(ConvexError);
  });

  test("chart/seatDetail/mySeatAssignments all reject a signed-in-but-unapproved caller", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const { as } = await signInAs(t, "not-approved@gmail.com");

    await expect(as.query(api.seats.chart, {})).rejects.toThrow(ConvexError);
    await expect(
      as.query(api.seats.mySeatAssignments, {}),
    ).rejects.toThrow(ConvexError);

    const anyDef = await run(t, (ctx) =>
      ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", "treasurer")).unique(),
    );
    await expect(
      as.query(api.seats.seatDetail, { defId: anyDef!._id, scope: "central" }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("seats.chart NOT_FOUND / seats.seatDetail INVALID_SCOPE", () => {
  test("chart({scope}) throws NOT_FOUND for a chapter that no longer exists", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const staleChapterId = await run(t, async (ctx) => {
      const id = await ctx.db.insert("chapters", {
        name: "Deleted Chapter",
        isActive: true,
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    await expect(
      s.as.query(api.seats.chart, { scope: staleChapterId }),
    ).rejects.toThrow(ConvexError);
  });

  test("seatDetail returns null for an unknown defId", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const staleDefId = await run(t, async (ctx) => {
      const def = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique();
      if (!def) throw new Error("treasurer not seeded");
      await ctx.db.delete(def._id);
      return def._id;
    });

    const result = await s.as.query(api.seats.seatDetail, {
      defId: staleDefId,
      scope: s.chapterId,
    });
    expect(result).toBeNull();
  });

  test("seatDetail throws INVALID_SCOPE passing a chapter id for a central-chart seat", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const centralDef = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "executive_director"))
        .unique(),
    );

    await expect(
      s.as.query(api.seats.seatDetail, {
        defId: centralDef!._id,
        scope: s.chapterId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("seatDetail throws INVALID_SCOPE passing 'central' for a chapter-chart seat", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const chapterDef = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique(),
    );

    await expect(
      s.as.query(api.seats.seatDetail, {
        defId: chapterDef!._id,
        scope: "central",
      }),
    ).rejects.toThrow(ConvexError);
  });
});

/**
 * `seats.assignSeat` / `seats.unassignSeat` — the write layer.
 *
 * Covers: super-admin gating, structural validation (derived seat, chart/scope
 * mismatch, nonexistent seat/chapter/person, placeholder person), maxHolders
 * semantics (single-holder replace-incumbent, multi-holder cap, idempotent
 * no-ops), scope-local SoD across the approve/record seat groups, and — the
 * centerpiece — write-through PARITY with `specializedRoles.assignSpecializedRole`
 * for every seat carrying a `legacyTitle`.
 */

// Guards the shape `seats.ts`'s module-load assertion depends on — if this
// ever fails, the assertion itself should be throwing on import too (see
// APPROVE_SEAT_SLUGS/RECORD_SEAT_SLUGS in seats.ts).
test("exactly 2 seats map to each SoD group (approve/record) via legacyTitle + titleKind", () => {
  const kindOf = (id: (typeof SEAT_IDS)[number]) => {
    const legacy = SEAT_DEFS[id].legacyTitle;
    return legacy === undefined ? undefined : titleKind(legacy);
  };
  expect(SEAT_IDS.filter((id) => kindOf(id) === "leadership")).toHaveLength(2);
  expect(SEAT_IDS.filter((id) => kindOf(id) === "finance")).toHaveLength(2);
});

describe("seats.assignSeat — validation", () => {
  test("a non-superuser is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "leader@publicworship.life" });
    const def = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "P");
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: def._id,
        scope: s.chapterId,
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a derived seat", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "chapter_directors");
    const p = await makePerson(s, s.chapterId, "P");
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: def._id,
        scope: "central",
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a central seat assigned at a chapter scope", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "executive_director");
    const p = await makePerson(s, s.chapterId, "P");
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: def._id,
        scope: s.chapterId,
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a chapter seat assigned at central scope", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "treasurer");
    const p = await makePerson(s, s.chapterId, "P");
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: def._id,
        scope: "central",
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a nonexistent chapter scope", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "treasurer");
    const p = await makePerson(s, s.chapterId, "P");
    const fakeChapterId = s.chapterId; // valid id shape
    await run(s.t, (ctx) => ctx.db.delete(fakeChapterId));
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: def._id,
        scope: fakeChapterId,
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a nonexistent person", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "Ghost");
    await run(s.t, (ctx) => ctx.db.delete(p));
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: def._id,
        scope: s.chapterId,
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a placeholder person", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const p = await makePlaceholderPerson(s, s.chapterId, "Placeholder");
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: def._id,
        scope: s.chapterId,
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("seats.assignSeat — write-through parity", () => {
  test("assigning treasurer creates the same specializedRoles row + financeRoles grant assignSpecializedRole would", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const p = await makePerson(s, s.chapterId, "Treasurer");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: p,
    });

    const roleRow = await specializedRoleRow(s, s.chapterId, "finance_manager");
    expect(roleRow?.personId).toBe(p);
    expect(roleRow?.roleKind).toBe("finance");

    const grant = await financeGrant(s, s.chapterId, p);
    expect(grant?.role).toBe("manager");
    expect(grant?.scope).toBe("chapter");
  });

  test("assigning financial_manager@central bridges to a central financeRoles grant", async () => {
    const s = await superuserSetup();
    const fmDef = await defBySlug(s, "financial_manager");
    const p = await makePerson(s, s.chapterId, "CentralFM");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: fmDef._id,
      scope: "central",
      personId: p,
    });

    const roleRow = await specializedRoleRow(s, "central", "finance_manager");
    expect(roleRow?.personId).toBe(p);
    const grant = await financeGrant(s, "central", p);
    expect(grant?.role).toBe("manager");
    expect(grant?.scope).toBe("central");
  });

  test("assigning executive_director creates the ED specializedRoles row, with NO finance bridge", async () => {
    const s = await superuserSetup();
    const edDef = await defBySlug(s, "executive_director");
    const p = await makePerson(s, s.chapterId, "ED");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: edDef._id,
      scope: "central",
      personId: p,
    });

    const roleRow = await specializedRoleRow(s, "central", "executive_director");
    expect(roleRow?.personId).toBe(p);
    expect(roleRow?.roleKind).toBe("leadership");
    expect(await financeGrant(s, "central", p)).toBeNull();
  });

  test("assigning chapter_director creates the president specializedRoles row (WP-1.1 label bridge)", async () => {
    const s = await superuserSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const p = await makePerson(s, s.chapterId, "CD");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: cdDef._id,
      scope: s.chapterId,
      personId: p,
    });

    const roleRow = await specializedRoleRow(s, s.chapterId, "president");
    expect(roleRow?.personId).toBe(p);
    expect(roleRow?.roleKind).toBe("leadership");
  });

  test("assigning a seat with no legacyTitle writes nothing to specializedRoles", async () => {
    const s = await superuserSetup();
    const musicLeadDef = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "MusicLead");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      personId: p,
    });

    const mine = await s.as.query(api.specializedRoles.personSpecializedRoles, {
      personId: p,
    });
    expect(mine).toEqual([]);
  });

  test("write-through result is identical whether reached via seats.assignSeat or specializedRoles.assignSpecializedRole directly", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const viaSeat = await makePerson(s, s.chapterId, "ViaSeat");
    const viaDirect = await makePerson(s, s.chapterId, "ViaDirect");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: viaSeat,
    });
    // Direct call targets a different chapter to avoid slot contention with
    // the seat-path assignment above (one holder per (scope, title) slot).
    const chapterB = await makeChapter(s, "Boston");
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: viaDirect,
      scope: chapterB,
      title: "finance_manager",
    });

    const viaSeatGrant = await financeGrant(s, s.chapterId, viaSeat);
    const viaDirectGrant = await financeGrant(s, chapterB, viaDirect);
    expect(viaSeatGrant?.role).toBe(viaDirectGrant?.role);
    expect(viaSeatGrant?.scope).toBe(viaDirectGrant?.scope);
  });
});

describe("seats.assignSeat — maxHolders semantics", () => {
  test("maxHolders===1: assigning a 2nd person replaces the 1st (chart shows only the new holder)", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const first = await makePerson(s, s.chapterId, "First");
    const second = await makePerson(s, s.chapterId, "Second");

    const firstAssignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: first,
    });
    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: second,
    });

    expect(await run(s.t, (ctx) => ctx.db.get(firstAssignmentId))).toBeNull();
    const detail = await s.as.query(api.seats.seatDetail, {
      defId: def._id,
      scope: s.chapterId,
    });
    expect(detail?.holders).toHaveLength(1);
    expect(detail?.holders[0]!.personId).toBe(second);
  });

  test("maxHolders===1 replace-incumbent reverses the outgoing holder's finance bridge", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "treasurer");
    const first = await makePerson(s, s.chapterId, "TreasA");
    const second = await makePerson(s, s.chapterId, "TreasB");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: first,
    });
    expect((await financeGrant(s, s.chapterId, first))?.role).toBe("manager");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: second,
    });

    expect(await financeGrant(s, s.chapterId, first)).toBeNull();
    expect((await financeGrant(s, s.chapterId, second))?.role).toBe("manager");
    // The outgoing holder's specializedRoles row is gone too.
    const outgoing = await s.as.query(api.specializedRoles.personSpecializedRoles, {
      personId: first,
    });
    expect(outgoing).toEqual([]);
  });

  test("assigning the same person to a single-holder seat again is an idempotent no-op", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "Same");

    const firstId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });
    const secondId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });
    expect(secondId).toBe(firstId);

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("seatAssignments")
        .withIndex("by_scope_and_seat", (q) =>
          q.eq("scope", s.chapterId).eq("seatDefId", def._id),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("re-affirming an idempotent finance seat re-creates a previously-revoked bridge", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "treasurer");
    const p = await makePerson(s, s.chapterId, "ReAffirm");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });
    // Simulate an out-of-band revoke of the bridge (bridge dropped, seat + role
    // rows untouched) — mirrors the idempotent re-affirm path's own test in
    // `specializedRoles.test.ts`.
    const grant = await financeGrant(s, s.chapterId, p);
    if (grant) await run(s.t, (ctx) => ctx.db.delete(grant._id));
    expect(await financeGrant(s, s.chapterId, p)).toBeNull();

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });
    expect((await financeGrant(s, s.chapterId, p))?.role).toBe("manager");
  });

  test("multi-holder seat: accepts holders up to the cap, rejects the next, no-ops on a repeat", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "event_organizers");
    expect(def.maxHolders).toBe(MULTI_HOLDER_CAP);

    // Fill the seat to its cap directly (bypassing the mutation for speed).
    const fillerIds: Id<"people">[] = [];
    for (let i = 0; i < MULTI_HOLDER_CAP; i++) {
      const pid = await makePerson(s, s.chapterId, `Filler${i}`);
      fillerIds.push(pid);
      await run(s.t, (ctx) =>
        ctx.db.insert("seatAssignments", {
          seatDefId: def._id,
          scope: s.chapterId,
          personId: pid,
          createdAt: Date.now(),
        }),
      );
    }

    const overflow = await makePerson(s, s.chapterId, "Overflow");
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: def._id,
        scope: s.chapterId,
        personId: overflow,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Re-assigning an existing holder is still a no-op, even at the cap.
    const repeatId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: fillerIds[0]!,
    });
    expect(repeatId).toBeDefined();
  });
});

describe("seats.assignSeat — scope-local separation of duties", () => {
  test("chapter_director then treasurer @ same chapter is rejected (approve then record)", async () => {
    const s = await superuserSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const treasurerDef = await defBySlug(s, "treasurer");
    const p = await makePerson(s, s.chapterId, "Dual");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: cdDef._id,
      scope: s.chapterId,
      personId: p,
    });
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: treasurerDef._id,
        scope: s.chapterId,
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("treasurer then chapter_director @ same chapter is rejected (record then approve, other order)", async () => {
    const s = await superuserSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const treasurerDef = await defBySlug(s, "treasurer");
    const p = await makePerson(s, s.chapterId, "Dual2");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: p,
    });
    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: cdDef._id,
        scope: s.chapterId,
        personId: p,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("central financial_manager + chapter treasurer in DIFFERENT scopes stays legal", async () => {
    const s = await superuserSetup();
    const fmDef = await defBySlug(s, "financial_manager");
    const treasurerDef = await defBySlug(s, "treasurer");
    const chapterB = await makeChapter(s, "Boston");
    const p = await makePerson(s, s.chapterId, "CrossScope");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: fmDef._id,
      scope: "central",
      personId: p,
    });
    const treasurerAssignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: chapterB,
      personId: p,
    });
    expect(treasurerAssignmentId).toBeDefined();
  });

  test("chapter_director@A and executive_director@central is allowed (same group, different scope)", async () => {
    const s = await superuserSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const edDef = await defBySlug(s, "executive_director");
    const p = await makePerson(s, s.chapterId, "SameGroup");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: cdDef._id,
      scope: s.chapterId,
      personId: p,
    });
    const edAssignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: edDef._id,
      scope: "central",
      personId: p,
    });
    expect(edAssignmentId).toBeDefined();
  });

  test("seats with no legacyTitle carry no SoD constraint", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "NoSod");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: p,
    });
    const musicLeadAssignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      personId: p,
    });
    expect(musicLeadAssignmentId).toBeDefined();
  });
});

describe("seats.unassignSeat", () => {
  test("a non-superuser is rejected", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "P");
    const assignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });

    const outsider = await setupChapter(s.t, { email: "leader@publicworship.life" });
    await expect(
      outsider.as.mutation(api.seats.unassignSeat, { assignmentId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a nonexistent assignment", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "P");
    const assignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });
    await s.as.mutation(api.seats.unassignSeat, { assignmentId });
    await expect(
      s.as.mutation(api.seats.unassignSeat, { assignmentId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("deletes the assignment for a seat with no legacyTitle", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "P");
    const assignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });

    await s.as.mutation(api.seats.unassignSeat, { assignmentId });
    expect(await run(s.t, (ctx) => ctx.db.get(assignmentId))).toBeNull();
  });

  test("reverses the write-through: deletes the specializedRoles row + revokes the finance bridge", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "treasurer");
    const p = await makePerson(s, s.chapterId, "Treasurer");
    const assignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });
    expect((await financeGrant(s, s.chapterId, p))?.role).toBe("manager");

    await s.as.mutation(api.seats.unassignSeat, { assignmentId });

    expect(await specializedRoleRow(s, s.chapterId, "finance_manager")).toBeNull();
    expect(await financeGrant(s, s.chapterId, p)).toBeNull();
  });

  test("unassigning frees the seat for the SoD group it belonged to", async () => {
    const s = await superuserSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const treasurerDef = await defBySlug(s, "treasurer");
    const p = await makePerson(s, s.chapterId, "FreedUp");

    const cdAssignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: cdDef._id,
      scope: s.chapterId,
      personId: p,
    });
    await s.as.mutation(api.seats.unassignSeat, { assignmentId: cdAssignmentId });

    // Now assigning the record-side seat to the same person/scope succeeds.
    const treasurerAssignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: p,
    });
    expect(treasurerAssignmentId).toBeDefined();
  });

  test("does NOT remove a legacy role row a different person now holds (already-diverged slot)", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "treasurer");
    const first = await makePerson(s, s.chapterId, "First");
    const second = await makePerson(s, s.chapterId, "Second");

    const firstAssignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: first,
    });
    // Directly reassign the legacy slot to a different person, bypassing the
    // seat layer (simulates a pre-existing divergence).
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: second,
      scope: s.chapterId,
      title: "finance_manager",
    });
    expect((await specializedRoleRow(s, s.chapterId, "finance_manager"))?.personId).toBe(
      second,
    );

    // The (now-stale) seat assignment row for `first` still exists — unassign it.
    await s.as.mutation(api.seats.unassignSeat, { assignmentId: firstAssignmentId });

    // `second`'s legacy role + bridge must survive untouched.
    expect((await specializedRoleRow(s, s.chapterId, "finance_manager"))?.personId).toBe(
      second,
    );
    expect((await financeGrant(s, s.chapterId, second))?.role).toBe("manager");
  });
});

/**
 * `seatDetail`'s `assignmentId` exposure — gated to a superuser caller only
 * (mirrors `unassignSeat`'s own gate, the one mutation this id is for). A
 * non-superuser must never see an id they can't act on.
 */
describe("seats.seatDetail — assignmentId exposure", () => {
  test("a superuser caller sees assignmentId on a holder row", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "Holder");
    const assignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });

    const detail = await s.as.query(api.seats.seatDetail, {
      defId: def._id,
      scope: s.chapterId,
    });
    expect(detail?.holders).toHaveLength(1);
    expect(detail?.holders[0]!.assignmentId).toBe(assignmentId);
  });

  test("a non-superuser caller never sees assignmentId, even on their own seat", async () => {
    const s = await superuserSetup();
    const def = await defBySlug(s, "music_lead");
    const p = await makePerson(s, s.chapterId, "Holder");
    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: def._id,
      scope: s.chapterId,
      personId: p,
    });

    const nonSuper = await setupChapter(s.t, { email: "leader@publicworship.life" });
    const detail = await nonSuper.as.query(api.seats.seatDetail, {
      defId: def._id,
      scope: s.chapterId,
    });
    expect(detail?.holders).toHaveLength(1);
    expect(detail?.holders[0]!.assignmentId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(detail?.holders[0], "assignmentId")).toBe(
      false,
    );
  });

  test("a superuser caller also sees assignmentId on a DERIVED seat's rolled-up holder", async () => {
    const s = await superuserSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const p = await makePerson(s, s.chapterId, "CD");
    const assignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: cdDef._id,
      scope: s.chapterId,
      personId: p,
    });

    const derivedDef = await defBySlug(s, "chapter_directors");
    const detail = await s.as.query(api.seats.seatDetail, {
      defId: derivedDef._id,
      scope: "central",
    });
    expect(detail?.holders).toHaveLength(1);
    // The derived rollup holder's assignmentId is the REAL underlying
    // chapter-level assignment row (there is no separate "derived seat"
    // assignment) — the id `unassignSeat` would need to remove the chapter's
    // own chapter_director.
    expect(detail?.holders[0]!.assignmentId).toBe(assignmentId);
  });
});

/**
 * `seats.assignablePeople` — the scope-aware roster read powering the
 * propose/direct-assign pickers, replacing the caller-chapter-scoped
 * `people.list`.
 */
describe("seats.assignablePeople", () => {
  test("a chapter scope returns only that chapter's non-placeholder, non-sample people", async () => {
    const s = await superuserSetup();
    const inChapter = await makePerson(s, s.chapterId, "In Chapter");
    await makePlaceholderPerson(s, s.chapterId, "Placeholder");
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Sample",
        isSamplePerson: true,
        createdAt: Date.now(),
      }),
    );
    const otherChapterId = await makeChapter(s, "Boston");
    await makePerson(s, otherChapterId, "In Other Chapter");

    const people = await s.as.query(api.seats.assignablePeople, {
      scope: s.chapterId,
    });
    expect(people.map((p) => p.personId)).toEqual([inChapter]);
  });

  test("central scope returns people org-wide, across every chapter", async () => {
    const s = await superuserSetup({ chapterName: "New York" });
    const nyPerson = await makePerson(s, s.chapterId, "NY Person");
    const bostonId = await makeChapter(s, "Boston");
    const bostonPerson = await makePerson(s, bostonId, "Boston Person");
    await makePlaceholderPerson(s, bostonId, "Boston Placeholder");

    const people = await s.as.query(api.seats.assignablePeople, {
      scope: "central",
    });
    expect(new Set(people.map((p) => p.personId))).toEqual(
      new Set([nyPerson, bostonPerson]),
    );
  });

  test("throws NOT_FOUND for a chapter that doesn't exist", async () => {
    const s = await superuserSetup();
    const staleChapterId = await run(s.t, async (ctx) => {
      const id = await ctx.db.insert("chapters", {
        name: "Deleted",
        isActive: true,
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    await expect(
      s.as.query(api.seats.assignablePeople, { scope: staleChapterId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a fully signed-out caller (requireAccess gate, not superuser-only)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await expect(
      t.query(api.seats.assignablePeople, { scope: s.chapterId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a non-superuser, signed-in-and-allowed caller can still read it (powers the propose flow anyone can use)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "leader@publicworship.life" });
    const p = await makePerson(s, s.chapterId, "Someone");

    const people = await s.as.query(api.seats.assignablePeople, {
      scope: s.chapterId,
    });
    expect(people.map((pp) => pp.personId)).toEqual([p]);
  });
});
