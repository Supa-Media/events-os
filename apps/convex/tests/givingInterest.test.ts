import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Interest capture + suggest-a-space (`schema/givingInterest.ts` +
 * `givingInterest.ts`) — the `/give` redesign's lead-capture inbox:
 *  - `submitInterest` (public, no auth) rejects an all-empty submission, an
 *    empty `kinds` array, and an unknown kind; accepts a valid multi-kind
 *    submission (wave 2, F4 — `kinds` is an array, not a single `kind`);
 *    rejects an incomplete `join_team` submission and accepts a complete one
 *    (F7 — name/phone/email/roles all required for `join_team`); round-trips
 *    the founding-team fields (`roles`/`skills`/`church`);
 *  - `publicInterestStats` counts correctly (including a `want_in_city`
 *    among several kinds on one row) and returns no PII;
 *  - `listInterest` requires central `giving.view` and returns full rows for a
 *    seated dev director;
 *  - `setInterestStatus` updates status + stamps the actor, and requires
 *    central `giving.manage`.
 */

/** Copied from `territories.test.ts`'s convention: link a `people` row to the
 *  caller's user + seat them (requires seeded seatDefs). */
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
 *  `giving.manage`/`giving.view` over central) — copied from
 *  `territories.test.ts`. */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

// ── submitInterest ───────────────────────────────────────────────────────────

describe("submitInterest", () => {
  test("rejects an all-empty submission", async () => {
    const t = newT();
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: ["want_in_city"],
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Whitespace-only fields count as empty too.
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: ["volunteer"],
        name: "   ",
        email: "  ",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an empty kinds array", async () => {
    const t = newT();
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: [],
        email: "fan@example.com",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an unknown kind", async () => {
    const t = newT();
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        // Not one of `GIVING_INTEREST_KINDS` — the args validator is
        // deliberately loose (`v.array(v.string())`) so the handler can
        // reject this with a friendly `ConvexError` rather than a generic
        // Convex argument-validation failure.
        kinds: ["not_a_real_kind"],
        email: "fan@example.com",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("accepts a valid submission with just one field set", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["want_in_city"],
      email: "fan@example.com",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.kinds).toEqual(["want_in_city"]);
    expect(row?.email).toBe("fan@example.com");
    expect(row?.status).toBe("new");
    expect(typeof row?.createdAt).toBe("number");
    expect(row?.name).toBeUndefined();
  });

  test("multi-select: accepts several kinds on one submission and dedupes", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["want_in_city", "volunteer", "want_in_city", "fund"],
      email: "multi@example.com",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.kinds).toEqual(["want_in_city", "volunteer", "fund"]);
  });

  test("accepts every kind, trims fields, and caps message/location length", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["suggest_space"],
      name: "  Jamie  ",
      location: "  Queens, NY  ",
      message: "  We have a backyard that fits 40  ",
      territorySlug: "queens-ny",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.name).toBe("Jamie");
    expect(row?.location).toBe("Queens, NY");
    expect(row?.message).toBe("We have a backyard that fits 40");
    expect(row?.territorySlug).toBe("queens-ny");

    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: ["fund"],
        message: "x".repeat(2001),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: ["join_team"],
        name: "Full Person",
        phone: "555-0100",
        email: "full@example.com",
        roles: ["Music Lead"],
        location: "x".repeat(201),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("round-trips the founding-team fields (roles/skills/church) plus phone/socialHandle", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["join_team"],
      name: "  Jamie Founder  ",
      email: "jamie@example.com",
      phone: "  555-0199  ",
      socialHandle: "  @jamiefounder  ",
      roles: ["  Chapter Director  ", "Music Lead", "Chapter Director"],
      skills: "  Worship leading, event production  ",
      church: "  Grace Community Church  ",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.name).toBe("Jamie Founder");
    expect(row?.phone).toBe("555-0199");
    expect(row?.socialHandle).toBe("@jamiefounder");
    expect(row?.roles).toEqual(["Chapter Director", "Music Lead", "Chapter Director"]);
    expect(row?.skills).toBe("Worship leading, event production");
    expect(row?.church).toBe("Grace Community Church");
  });

  test("join_team requires name, phone, email, and at least one role", async () => {
    const t = newT();
    // Missing phone.
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: ["join_team"],
        name: "No Phone",
        email: "nophone@example.com",
        roles: ["Marketing Lead"],
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Missing roles.
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: ["join_team"],
        name: "No Roles",
        phone: "555-0111",
        email: "noroles@example.com",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Missing name.
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: ["join_team"],
        phone: "555-0111",
        email: "noname@example.com",
        roles: ["Treasurer"],
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Missing email.
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kinds: ["join_team"],
        name: "No Email",
        phone: "555-0111",
        roles: ["Treasurer"],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a complete join_team submission (name+phone+email+roles) succeeds", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["join_team"],
      name: "Complete Person",
      phone: "555-0123",
      email: "complete@example.com",
      roles: ["Wherever I'm needed"],
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.name).toBe("Complete Person");
    expect(row?.phone).toBe("555-0123");
    expect(row?.email).toBe("complete@example.com");
    expect(row?.roles).toEqual(["Wherever I'm needed"]);
    expect(row?.kinds).toEqual(["join_team"]);
  });

  test("a non-join_team submission still works with just a location", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["suggest_space"],
      location: "Queens, NY",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.location).toBe("Queens, NY");
    expect(row?.name).toBeUndefined();
    expect(row?.phone).toBeUndefined();
  });
});

// ── publicInterestStats ──────────────────────────────────────────────────────

describe("publicInterestStats", () => {
  test("counts correctly and returns no PII", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["want_in_city"],
      email: "a@example.com",
    });
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["want_in_city"],
      email: "b@example.com",
    });
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["volunteer"],
      name: "Volunteer Vera",
    });

    const stats = await t.query(api.givingInterest.publicInterestStats, {});
    expect(stats).toEqual({ total: 3, wantInCity: 2 });
    expect(Object.keys(stats).sort()).toEqual(["total", "wantInCity"].sort());
  });

  test("counts a want_in_city row even when it carries other kinds too", async () => {
    const t = newT();
    // Multi-select (wave 2, F4): this row is BOTH "volunteer" and
    // "want_in_city" — it must still count toward `wantInCity`.
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["volunteer", "want_in_city", "fund"],
      email: "multi@example.com",
    });
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["join_team"],
      name: "Team Hopeful",
      phone: "555-0199",
      email: "notinterested@example.com",
      roles: ["Treasurer"],
    });

    const stats = await t.query(api.givingInterest.publicInterestStats, {});
    expect(stats).toEqual({ total: 2, wantInCity: 1 });
  });

  test("returns zeros with no submissions", async () => {
    const t = newT();
    expect(await t.query(api.givingInterest.publicInterestStats, {})).toEqual({
      total: 0,
      wantInCity: 0,
    });
  });
});

// ── listInterest ─────────────────────────────────────────────────────────────

describe("listInterest", () => {
  test("an un-seated caller is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await expect(
      s.as.query(api.givingInterest.listInterest, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a chapter-scope giving seat isn't enough — central only", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "chapter_director", s.chapterId);
    await expect(
      s.as.query(api.givingInterest.listInterest, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a seated dev director sees full rows, newest first, with the kinds array", async () => {
    const s = await devDirectorSetup();
    await s.t.mutation(api.givingInterest.submitInterest, {
      kinds: ["want_in_city"],
      email: "first@example.com",
    });
    await s.t.mutation(api.givingInterest.submitInterest, {
      kinds: ["suggest_space", "volunteer"],
      name: "Second Person",
      location: "Columbus, OH",
      message: "We have a hall",
    });

    const rows = await s.as.query(api.givingInterest.listInterest, {});
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0].name).toBe("Second Person");
    expect(rows[0].location).toBe("Columbus, OH");
    expect(rows[0].message).toBe("We have a hall");
    expect(rows[0].status).toBe("new");
    expect(rows[0].kinds).toEqual(["suggest_space", "volunteer"]);
    expect(rows[1].email).toBe("first@example.com");
    expect(rows[1].kinds).toEqual(["want_in_city"]);
  });

  test("a seated dev director sees the founding-team fields", async () => {
    const s = await devDirectorSetup();
    await s.t.mutation(api.givingInterest.submitInterest, {
      kinds: ["join_team"],
      name: "Founder Person",
      phone: "555-0177",
      email: "founder@example.com",
      socialHandle: "@founderperson",
      roles: ["Chapter Director", "Music Lead"],
      skills: "Worship leading",
      church: "Grace Community Church",
    });

    const rows = await s.as.query(api.givingInterest.listInterest, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe("555-0177");
    expect(rows[0].socialHandle).toBe("@founderperson");
    expect(rows[0].roles).toEqual(["Chapter Director", "Music Lead"]);
    expect(rows[0].skills).toBe("Worship leading");
    expect(rows[0].church).toBe("Grace Community Church");
  });
});

// ── setInterestStatus ────────────────────────────────────────────────────────

describe("setInterestStatus", () => {
  test("updates status + stamps handledAt/handledBy; requires giving.manage", async () => {
    const s = await devDirectorSetup();
    await s.t.mutation(api.givingInterest.submitInterest, {
      kinds: ["volunteer"],
      email: "vol@example.com",
    });
    const row = await run(s.t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.status).toBe("new");

    await s.as.mutation(api.givingInterest.setInterestStatus, {
      id: row!._id,
      status: "contacted",
    });
    const updated = await run(s.t, (ctx) => ctx.db.get(row!._id));
    expect(updated?.status).toBe("contacted");
    expect(typeof updated?.handledAt).toBe("number");
    expect(updated?.handledBy).toBe(s.userId);

    await s.as.mutation(api.givingInterest.setInterestStatus, {
      id: row!._id,
      status: "archived",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(row!._id)))?.status).toBe(
      "archived",
    );
  });

  test("a view-only (non-manage) caller is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await t.mutation(api.givingInterest.submitInterest, {
      kinds: ["fund"],
      email: "f@example.com",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    await expect(
      s.as.mutation(api.givingInterest.setInterestStatus, {
        id: row!._id,
        status: "contacted",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});
