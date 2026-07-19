import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runAddGivingPowerDefaults } from "../migrations/0033_add_giving_power_defaults";

/**
 * `seats.setSeatGivingPower` — the assignable per-role GIVING power (owner
 * decision 2026-07-19), its gate, its giving-only capability transitions, the
 * end-to-end enforcement effect (a seated person's `requireGivingView` outcome
 * flips with the power), and the `0033` backfill's idempotence.
 */

// ── Setup helpers ────────────────────────────────────────────────────────────

async function seatSetup(
  opts: { email?: string } = {},
): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

async function defBySlug(s: ChapterSetup, slug: string): Promise<Doc<"seatDefs">> {
  const def = await run(s.t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

/** A non-placeholder roster person OWNED by the caller's user — the shape
 *  `resolveGivingAccess` / `requireChartEditor` both walk (user → people). */
async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      createdAt: Date.now(),
    }),
  );
}

/** Direct `seatAssignments` insert (bypasses `assignSeat`'s SoD/write-through
 *  — this suite tests the power editor + giving enforcement, not assignment). */
async function directlyAssign(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
): Promise<void> {
  const def = await defBySlug(s, slug);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

/** Seat the caller's own person as the central Executive Director — the
 *  `org.editChart` (and giving.manage) holder, NOT a superuser. */
async function makeCallerEd(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s, "Executive Director");
  await directlyAssign(s, "executive_director", "central", personId);
  return personId;
}

async function capsOf(s: ChapterSetup, slug: string): Promise<string[]> {
  return (await defBySlug(s, slug)).capabilities;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

describe("setSeatGivingPower — gate", () => {
  test("a non-ED, non-superuser caller is rejected", async () => {
    const s = await seatSetup(); // leader@ — not superuser
    await seedSelfPerson(s); // holds no org.editChart seat
    const treasurer = await defBySlug(s, "treasurer");
    await expect(
      s.as.mutation(api.seats.setSeatGivingPower, {
        seatDefId: treasurer._id,
        power: "manage",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("an executive_director seat holder is allowed", async () => {
    const s = await seatSetup();
    await makeCallerEd(s);
    const treasurer = await defBySlug(s, "treasurer");
    const result = await s.as.mutation(api.seats.setSeatGivingPower, {
      seatDefId: treasurer._id,
      power: "manage",
    });
    expect(result).toContain("giving.manage");
  });

  test("a superuser is allowed", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const treasurer = await defBySlug(s, "treasurer");
    const result = await s.as.mutation(api.seats.setSeatGivingPower, {
      seatDefId: treasurer._id,
      power: "none",
    });
    expect(result).not.toContain("giving.view");
    expect(result).not.toContain("nav.giving");
  });

  test("rejects a derived seat", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const derived = await defBySlug(s, "chapter_directors");
    await expect(
      s.as.mutation(api.seats.setSeatGivingPower, {
        seatDefId: derived._id,
        power: "view",
      }),
    ).rejects.toThrow(/computed automatically/);
  });
});

// ── Transitions touch ONLY the giving trio ───────────────────────────────────

describe("setSeatGivingPower — capability transitions", () => {
  const FINANCE_CAPS = [
    "finance.manager",
    "finance.central",
    "finance.accounts",
    "finance.record",
    "nav.finances",
  ];

  test("manage → view → none rewrites only giving caps, never finance caps", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const fm = await defBySlug(s, "financial_manager");

    // manage: all three giving caps present, every finance cap preserved.
    const afterManage = await s.as.mutation(api.seats.setSeatGivingPower, {
      seatDefId: fm._id,
      power: "manage",
    });
    for (const c of FINANCE_CAPS) expect(afterManage).toContain(c);
    expect(afterManage).toContain("giving.manage");
    expect(afterManage).toContain("giving.view");
    expect(afterManage).toContain("nav.giving");

    // view: manage dropped, view + nav kept; finance untouched.
    const afterView = await s.as.mutation(api.seats.setSeatGivingPower, {
      seatDefId: fm._id,
      power: "view",
    });
    for (const c of FINANCE_CAPS) expect(afterView).toContain(c);
    expect(afterView).not.toContain("giving.manage");
    expect(afterView).toContain("giving.view");
    expect(afterView).toContain("nav.giving");

    // none: all giving stripped; every finance cap still present & intact.
    const afterNone = await s.as.mutation(api.seats.setSeatGivingPower, {
      seatDefId: fm._id,
      power: "none",
    });
    expect(afterNone.filter((c) => c.startsWith("giving.") || c === "nav.giving")).toEqual([]);
    expect(afterNone).toEqual(FINANCE_CAPS);

    // Persisted, not just returned.
    expect(await capsOf(s, "financial_manager")).toEqual(FINANCE_CAPS);
  });

  test("an ED cannot strip giving off their OWN seat (self-lockout)", async () => {
    const s = await seatSetup();
    await makeCallerEd(s); // caller holds executive_director (giving.manage)
    const ed = await defBySlug(s, "executive_director");
    await expect(
      s.as.mutation(api.seats.setSeatGivingPower, {
        seatDefId: ed._id,
        power: "none",
      }),
    ).rejects.toThrow(/remove your own/i);
  });
});

// ── End-to-end enforcement (requireGivingView flips with the power) ──────────

describe("setSeatGivingPower — giving enforcement effect", () => {
  test("expansion_director default (post-seed) can view; set to none loses access", async () => {
    // A separate viewer identity seated as expansion_director@central.
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const viewer = await setupChapter(t, { email: "expansion@publicworship.life" });
    const viewerPerson = await seedSelfPerson(viewer, "Expansion Director");
    await directlyAssign(viewer, "expansion_director", "central", viewerPerson);

    // Post-seed the template default already carries giving.view → central
    // reach sees every scope, so a chapter-scoped read passes.
    await expect(
      viewer.as.query(api.givingPlatform.listDonors, { scope: viewer.chapterId }),
    ).resolves.toEqual([]);

    // A DIFFERENT user (the ED) strips expansion_director to none — so the
    // self-lockout guard is irrelevant (the ED doesn't hold that seat).
    const edUser = await run(viewer.t, (ctx) =>
      ctx.db.insert("users", { email: "ed@publicworship.life" }),
    );
    const edPerson = await run(viewer.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: viewer.chapterId,
        name: "ED",
        userId: edUser,
        createdAt: Date.now(),
      }),
    );
    await directlyAssign(viewer, "executive_director", "central", edPerson);
    const expDef = await defBySlug(viewer, "expansion_director");
    const edAs = viewer.t.withIdentity({ subject: `${edUser}|session`, issuer: "test" });
    await edAs.mutation(api.seats.setSeatGivingPower, {
      seatDefId: expDef._id,
      power: "none",
    });

    // The viewer now has no giving reach → the same read is FORBIDDEN.
    await expect(
      viewer.as.query(api.givingPlatform.listDonors, { scope: viewer.chapterId }),
    ).rejects.toThrow(ConvexError);
  });

  test("financial_manager default (post-seed) can view central donors", async () => {
    const s = await seatSetup({ email: "fm@publicworship.life" });
    const fmPerson = await seedSelfPerson(s, "Financial Manager");
    await directlyAssign(s, "financial_manager", "central", fmPerson);
    await expect(
      s.as.query(api.givingPlatform.listDonors, { scope: "central" }),
    ).resolves.toEqual([]);
  });
});

// ── Migration 0033 — additive backfill, idempotent ──────────────────────────

describe("0033_add_giving_power_defaults", () => {
  test("adds the default giving.view + nav.giving to the two seats; second run is a no-op", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    // Simulate a PRE-migration deployment: strip the two seats back to their
    // old giving-less capability sets so the backfill has real work to do.
    for (const slug of ["expansion_director", "financial_manager"] as const) {
      await run(t, async (ctx) => {
        const def = await ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
        if (!def) throw new Error(`${slug} missing`);
        await ctx.db.patch(def._id, {
          capabilities: def.capabilities.filter(
            (c) => c !== "giving.view" && c !== "nav.giving",
          ),
        });
      });
    }

    const first = await run(t, (ctx) => runAddGivingPowerDefaults(ctx));
    expect(first.patched).toBe(2);
    expect(first.skipped).toBe(0);

    for (const slug of ["expansion_director", "financial_manager"] as const) {
      const def = await run(t, (ctx) =>
        ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
      );
      expect(def!.capabilities).toContain("giving.view");
      expect(def!.capabilities).toContain("nav.giving");
    }

    // Idempotent: a second run touches nothing.
    const second = await run(t, (ctx) => runAddGivingPowerDefaults(ctx));
    expect(second.patched).toBe(0);
    expect(second.skipped).toBe(2);
  });

  test("does not clobber a runtime 'manage' promotion (additive-only)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    // Simulate the ED having promoted expansion_director to manage at runtime.
    await run(t, async (ctx) => {
      const def = await ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", "expansion_director")).unique();
      await ctx.db.patch(def!._id, {
        capabilities: ["giving.manage", "giving.view", "nav.giving"],
      });
    });
    const res = await run(t, (ctx) => runAddGivingPowerDefaults(ctx));
    // Already carries giving.view → skipped, manage preserved.
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const def = await run(t, (ctx) =>
      ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", "expansion_director")).unique(),
    );
    expect(def!.capabilities).toContain("giving.manage");
  });
});
