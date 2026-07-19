import { afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { SEAT_ROOT, MULTI_HOLDER_CAP } from "@events-os/shared";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import {
  __setSafetyScanLimitForTests,
  __resetSafetyScanLimitForTests,
} from "../seatStructure";

// Every SAFETY-scan test below shrinks the fail-closed scan bound so it's
// hittable without a multi-thousand-row fixture. Always reset — a leaked
// override would silently make every OTHER test's safety scans fail-closed
// at a tiny bound too.
afterEach(() => {
  __resetSafetyScanLimitForTests();
});

/**
 * Org chart STRUCTURE editor (`seatStructure.ts`) — the `org.editChart`
 * permission gate, every structural invariant, the SELF-LOCKOUT guard, the
 * audit log, and the shared-def "one edit, every chapter sees it" property.
 */

// ── Setup helpers ────────────────────────────────────────────────────────────

/** Insert a bare `users` row and return a client authenticated as them
 *  (mirrors `seats.test.ts`'s `signInAs`). */
async function signInAs(t: ReturnType<typeof newT>, email: string) {
  const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
  const as = t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId: userId as Id<"users"> };
}

/** The seatDef row seeded for a template `slug`, throwing if it's missing. */
async function defBySlug(s: ChapterSetup, slug: string): Promise<Doc<"seatDefs">> {
  const def = await run(s.t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

/** `defBySlug`, but `null` instead of throwing — for asserting a slug is GONE. */
async function tryDefBySlug(s: ChapterSetup, slug: string): Promise<Doc<"seatDefs"> | null> {
  return run(s.t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
}

/** Insert a second chapter and return its id. */
async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

/** Directly assign `personId` to `slug` at `scope`, bypassing `seats.assignSeat`
 *  (this suite tests `seatStructure.ts`, not the assignment layer — a direct
 *  insert keeps setup minimal and SoD-rule-free). */
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

/** Seed seat defs + a chapter + an authenticated caller whose OWN roster
 *  person holds `executive_director@central` — the org.editChart seat. NOT a
 *  superuser, so every test built on this exercises the seat-capability gate,
 *  not the superuser backstop. */
async function edSetup(opts?: {
  email?: string;
  chapterName?: string;
}): Promise<ChapterSetup & { personId: Id<"people"> }> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t, {
    email: opts?.email ?? "ed@publicworship.life",
    chapterName: opts?.chapterName,
  });
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Executive Director",
      userId: s.userId,
      createdAt: Date.now(),
    }),
  );
  await directlyAssign(s, "executive_director", "central", personId);
  return { ...s, personId };
}

const addSeatArgs = {
  chart: "chapter" as const,
  parentSlug: "chapter_director",
  title: "New Seat",
  maxHolders: 1,
  duties: [] as string[],
  capabilities: [] as never[],
};

// ── Gate ─────────────────────────────────────────────────────────────────────

describe("seatStructure — org.editChart gate", () => {
  test("an executive_director seat holder is allowed", async () => {
    const s = await edSetup();
    const seatDefId = await s.as.mutation(api.seatStructure.addSeat, addSeatArgs);
    expect(seatDefId).toBeDefined();
  });

  test("a seat holder WITHOUT org.editChart (treasurer) is rejected", async () => {
    const s = await edSetup();
    const { as: treasurerAs, userId } = await signInAs(s.t, "treasurer@publicworship.life");
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Treasurer",
        userId,
        createdAt: Date.now(),
      }),
    );
    await directlyAssign(s, "treasurer", s.chapterId, personId);

    await expect(
      treasurerAs.mutation(api.seatStructure.addSeat, addSeatArgs),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a superuser with no seat at all is allowed (backstop)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const seatDefId = await s.as.mutation(api.seatStructure.addSeat, addSeatArgs);
    expect(seatDefId).toBeDefined();
  });

  test("a fully signed-out caller is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    await expect(t.mutation(api.seatStructure.addSeat, addSeatArgs)).rejects.toThrow(ConvexError);
    await expect(t.query(api.seatStructure.structureLog, {})).rejects.toThrow(ConvexError);
  });

  test("a signed-in-but-unapproved caller is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const { as } = await signInAs(t, "not-approved@gmail.com");
    await expect(as.mutation(api.seatStructure.addSeat, addSeatArgs)).rejects.toThrow(ConvexError);
  });
});

// ── addSeat ──────────────────────────────────────────────────────────────────

describe("seatStructure.addSeat", () => {
  test("adds a seat under an existing parent, appends sortOrder, never derived/legacyTitle", async () => {
    const s = await edSetup();
    const existingChapterDefs = await run(s.t, (ctx) =>
      ctx.db.query("seatDefs").withIndex("by_chart", (q) => q.eq("chart", "chapter")).collect(),
    );
    const maxSortOrder = Math.max(...existingChapterDefs.map((d) => d.sortOrder));

    const seatDefId = await s.as.mutation(api.seatStructure.addSeat, {
      chart: "chapter",
      parentSlug: "chapter_director",
      title: "Hospitality Lead",
      maxHolders: 1,
      duties: ["Welcome guests"],
      capabilities: [],
    });

    const def = await run(s.t, (ctx) => ctx.db.get(seatDefId));
    expect(def?.slug).toBe("hospitality_lead");
    expect(def?.chart).toBe("chapter");
    expect(def?.parentSlug).toBe("chapter_director");
    expect(def?.sortOrder).toBe(maxSortOrder + 1);
    expect(def?.derived).toBe(false);
    expect(def?.legacyTitle).toBeUndefined();
  });

  test("generates a unique slug when two seats share a title", async () => {
    const s = await edSetup();
    const first = await s.as.mutation(api.seatStructure.addSeat, {
      ...addSeatArgs,
      title: "Volunteer Coordinator",
    });
    const second = await s.as.mutation(api.seatStructure.addSeat, {
      ...addSeatArgs,
      title: "Volunteer Coordinator",
    });
    const firstDef = await run(s.t, (ctx) => ctx.db.get(first));
    const secondDef = await run(s.t, (ctx) => ctx.db.get(second));
    expect(firstDef?.slug).toBe("volunteer_coordinator");
    expect(secondDef?.slug).toBe("volunteer_coordinator_2");
  });

  test("rejects parentSlug === SEAT_ROOT (can't create a second root)", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.addSeat, { ...addSeatArgs, parentSlug: SEAT_ROOT }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a cross-chart parent", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.addSeat, {
        ...addSeatArgs,
        chart: "central",
        parentSlug: "chapter_director", // chapter-chart seat, chart: central
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a nonexistent parent", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.addSeat, { ...addSeatArgs, parentSlug: "does_not_exist" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an empty title", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.addSeat, { ...addSeatArgs, title: "   " }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test.each([0, -1, 1.5, MULTI_HOLDER_CAP + 1])(
    "rejects an invalid maxHolders (%s)",
    async (maxHolders) => {
      const s = await edSetup();
      await expect(
        s.as.mutation(api.seatStructure.addSeat, { ...addSeatArgs, maxHolders }),
      ).rejects.toBeInstanceOf(ConvexError);
    },
  );

  test("writes an audit log row with the editor's personId and an `after` snapshot", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.addSeat, { ...addSeatArgs, title: "Logged Seat" });

    const log = await s.as.query(api.seatStructure.structureLog, {});
    const row = log.find((r) => r.slug === "logged_seat");
    expect(row?.mutation).toBe("addSeat");
    expect(row?.editorPersonId).toBe(s.personId);
    expect(row?.before).toBeUndefined();
    expect((row?.after as { title?: string } | undefined)?.title).toBe("Logged Seat");
  });
});

// ── renameSeat ───────────────────────────────────────────────────────────────

describe("seatStructure.renameSeat", () => {
  test("renames a seat", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.renameSeat, { slug: "treasurer", title: "Money Lead" });
    const def = await defBySlug(s, "treasurer");
    expect(def.title).toBe("Money Lead");
  });

  test("the ED can rename their OWN seat — allowed (title never changes what a seat grants)", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.renameSeat, {
      slug: "executive_director",
      title: "Chief Executive",
    });
    const def = await defBySlug(s, "executive_director");
    expect(def.title).toBe("Chief Executive");
  });

  test("rejects an empty title", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.renameSeat, { slug: "treasurer", title: "" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an unknown slug", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.renameSeat, { slug: "ghost", title: "X" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a same-title rename is a no-op and writes no audit row", async () => {
    const s = await edSetup();
    const before = await defBySlug(s, "treasurer");
    await s.as.mutation(api.seatStructure.renameSeat, { slug: "treasurer", title: before.title });
    const log = await s.as.query(api.seatStructure.structureLog, {});
    expect(log.find((r) => r.slug === "treasurer" && r.mutation === "renameSeat")).toBeUndefined();
  });
});

// ── updateSeat ───────────────────────────────────────────────────────────────

describe("seatStructure.updateSeat", () => {
  test("updates duties, capabilities, and maxHolders independently", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "music_lead",
      duties: ["New duty"],
    });
    expect((await defBySlug(s, "music_lead")).duties).toEqual(["New duty"]);

    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "music_lead",
      capabilities: ["nav.finances"],
    });
    expect((await defBySlug(s, "music_lead")).capabilities).toEqual(["nav.finances"]);

    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "event_organizers",
      maxHolders: 10,
    });
    expect((await defBySlug(s, "event_organizers")).maxHolders).toBe(10);
  });

  test("rejects a capability outside SEAT_CAPABILITIES", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.updateSeat, {
        slug: "music_lead",
        capabilities: ["not.a.real.capability"],
      } as never),
    ).rejects.toThrow();
  });

  test("rejects a legacyTitle smuggled in as an extra argument (not editable here)", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.updateSeat, {
        slug: "treasurer",
        legacyTitle: "president",
      } as never),
    ).rejects.toThrow();
  });

  test("maxHolders floor: rejects dropping below the current max holder-count in ANY scope", async () => {
    const s = await edSetup();
    const chicagoId = await makeChapter(s, "Chicago");
    const def = await defBySlug(s, "event_organizers");
    expect(def.maxHolders).toBe(MULTI_HOLDER_CAP);

    // 3 holders in New York, 5 in Chicago.
    for (let i = 0; i < 3; i++) {
      const p = await run(s.t, (ctx) =>
        ctx.db.insert("people", { chapterId: s.chapterId, name: `NY${i}`, createdAt: Date.now() }),
      );
      await directlyAssign(s, "event_organizers", s.chapterId, p);
    }
    for (let i = 0; i < 5; i++) {
      const p = await run(s.t, (ctx) =>
        ctx.db.insert("people", { chapterId: chicagoId, name: `Chi${i}`, createdAt: Date.now() }),
      );
      await directlyAssign(s, "event_organizers", chicagoId, p);
    }

    await expect(
      s.as.mutation(api.seatStructure.updateSeat, { slug: "event_organizers", maxHolders: 4 }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Exactly the current max is fine (not BELOW current).
    await s.as.mutation(api.seatStructure.updateSeat, { slug: "event_organizers", maxHolders: 5 });
    expect((await defBySlug(s, "event_organizers")).maxHolders).toBe(5);
  });

  test("writes an audit log row with before/after snapshots (duties SUMMARIZED, not the raw array)", async () => {
    const s = await edSetup();
    const before = await defBySlug(s, "music_lead");
    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "music_lead",
      duties: ["Duty A"],
    });
    const log = await s.as.query(api.seatStructure.structureLog, {});
    const row = log.find((r) => r.slug === "music_lead" && r.mutation === "updateSeat")!;
    expect((row.before as { duties?: { count: number; preview: string[] } }).duties).toEqual({
      count: before.duties.length,
      preview: before.duties,
    });
    expect((row.after as { duties?: { count: number; preview: string[] } }).duties).toEqual({
      count: 1,
      preview: ["Duty A"],
    });
  });

  test("rejects updating a derived seat (mirrors reparentSeat/removeSeat's guard)", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.updateSeat, {
        slug: "chapter_directors",
        capabilities: ["nav.finances"],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.seatStructure.updateSeat, {
        slug: "chapter_directors",
        maxHolders: 10,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.seatStructure.updateSeat, {
        slug: "chapter_directors",
        duties: ["x"],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("audit snapshot caps a long duties array (count + truncated preview, not the raw list)", async () => {
    const s = await edSetup();
    const manyDuties = Array.from({ length: 20 }, (_, i) => `Duty number ${i}`.repeat(5));
    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "music_lead",
      duties: manyDuties,
    });
    const log = await s.as.query(api.seatStructure.structureLog, {});
    const row = log.find((r) => r.slug === "music_lead" && r.mutation === "updateSeat")!;
    const after = row.after as { duties?: { count: number; preview: string[] } };
    expect(after.duties?.count).toBe(20);
    expect(after.duties?.preview.length).toBeLessThan(20);
    for (const p of after.duties?.preview ?? []) {
      expect(p.length).toBeLessThanOrEqual(81); // AUDIT_DUTY_CHARS + the ellipsis char
    }
  });
});

// ── Self-lockout guard ───────────────────────────────────────────────────────

describe("seatStructure — SELF-LOCKOUT guard", () => {
  test("ED removing org.editChart from their OWN held seat is rejected", async () => {
    const s = await edSetup();
    const edDef = await defBySlug(s, "executive_director");
    const withoutEditChart = edDef.capabilities.filter((c) => c !== "org.editChart");

    await expect(
      s.as.mutation(api.seatStructure.updateSeat, {
        slug: "executive_director",
        capabilities: withoutEditChart,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Nothing committed.
    expect((await defBySlug(s, "executive_director")).capabilities).toContain("org.editChart");
  });

  test("self-lockout is capability-GENERAL: losing a non-editChart capability the caller holds is also rejected", async () => {
    const s = await edSetup();
    const edDef = await defBySlug(s, "executive_director");
    // Drop `finance.approve` only — org.editChart survives, but a DIFFERENT
    // currently-held capability would be lost. Still rejected.
    const withoutFinanceApprove = edDef.capabilities.filter((c) => c !== "finance.approve");
    expect(withoutFinanceApprove).toContain("org.editChart");

    await expect(
      s.as.mutation(api.seatStructure.updateSeat, {
        slug: "executive_director",
        capabilities: withoutFinanceApprove,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("ED can freely remove a capability from a seat they DON'T hold", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "financial_manager",
      capabilities: [],
    });
    expect((await defBySlug(s, "financial_manager")).capabilities).toEqual([]);
  });

  test("removing a seat that would orphan the editor's OWN power is rejected (not the generic occupied-seat error)", async () => {
    const s = await edSetup();
    // A fresh, non-root seat carrying org.editChart, held ONLY by a second
    // caller (not the ED) — isolates the self-lockout path from the
    // chart-root restriction (executive_director itself can't be removed
    // at all, root or not, which would mask this check).
    const newSeatId = await s.as.mutation(api.seatStructure.addSeat, {
      chart: "central",
      parentSlug: "executive_director",
      title: "Assistant Director",
      maxHolders: 1,
      duties: [],
      capabilities: ["org.editChart"],
    });
    const newSeatDef = await run(s.t, (ctx) => ctx.db.get(newSeatId));
    const { as: assistantAs, userId } = await signInAs(s.t, "assistant@publicworship.life");
    const assistantPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Assistant",
        userId,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: newSeatId,
        scope: "central",
        personId: assistantPersonId,
        createdAt: Date.now(),
      }),
    );

    // The assistant holds ONLY this seat — removing it would orphan their
    // entire editChart power (a DIFFERENT failure than "still occupied").
    await expect(
      assistantAs.mutation(api.seatStructure.removeSeat, { slug: newSeatDef!.slug }),
    ).rejects.toBeInstanceOf(ConvexError);

    // The seat still exists — nothing committed.
    expect(await run(s.t, (ctx) => ctx.db.get(newSeatId))).not.toBeNull();
  });

  test("does NOT block an edit that only affects someone ELSE's powers", async () => {
    const s = await edSetup();
    const treasurerPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Treasurer",
        createdAt: Date.now(),
      }),
    );
    await directlyAssign(s, "treasurer", s.chapterId, treasurerPersonId);

    // ED (who doesn't hold treasurer) strips treasurer's finance.manager cap.
    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "treasurer",
      capabilities: [],
    });
    expect((await defBySlug(s, "treasurer")).capabilities).toEqual([]);
  });
});

// ── reparentSeat ─────────────────────────────────────────────────────────────

describe("seatStructure.reparentSeat", () => {
  test("moves a seat to a new (valid) parent in the same chart", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.reparentSeat, {
      slug: "production_coordinator",
      newParentSlug: "marketing_lead",
    });
    expect((await defBySlug(s, "production_coordinator")).parentSlug).toBe("marketing_lead");
  });

  test("rejects reparenting a derived seat", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.reparentSeat, {
        slug: "chapter_directors",
        newParentSlug: "recruiting_associate",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects reparenting a chart's root seat", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.reparentSeat, {
        slug: "chapter_director",
        newParentSlug: "treasurer",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects moving a seat to become a second root", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.reparentSeat, {
        slug: "treasurer",
        newParentSlug: SEAT_ROOT,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a self-parent", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.reparentSeat, {
        slug: "treasurer",
        newParentSlug: "treasurer",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a cross-chart parent", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.reparentSeat, {
        slug: "treasurer",
        newParentSlug: "music_director", // central-chart seat
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a move that would create a cycle", async () => {
    const s = await edSetup();
    // music_lead → vocal_lead today; moving music_lead UNDER its own child
    // vocal_lead would create a cycle.
    await expect(
      s.as.mutation(api.seatStructure.reparentSeat, {
        slug: "music_lead",
        newParentSlug: "vocal_lead",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("writes an audit log row with the old/new parentSlug", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.reparentSeat, {
      slug: "production_coordinator",
      newParentSlug: "marketing_lead",
    });
    const log = await s.as.query(api.seatStructure.structureLog, {});
    const row = log.find((r) => r.slug === "production_coordinator" && r.mutation === "reparentSeat")!;
    expect((row.before as { parentSlug?: string }).parentSlug).toBe("event_lead");
    expect((row.after as { parentSlug?: string }).parentSlug).toBe("marketing_lead");
  });
});

// ── removeSeat ───────────────────────────────────────────────────────────────

describe("seatStructure.removeSeat", () => {
  test("removes an unoccupied, childless, non-root, non-derived seat", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.removeSeat, { slug: "production_coordinator" });
    expect(await tryDefBySlug(s, "production_coordinator")).toBeNull();
  });

  test("rejects removing a derived seat", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.removeSeat, { slug: "chapter_directors" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects removing a chart's root seat", async () => {
    const s = await edSetup();
    await expect(
      s.as.mutation(api.seatStructure.removeSeat, { slug: "executive_director" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects removing a seat with ANY current assignment", async () => {
    const s = await edSetup();
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Lead", createdAt: Date.now() }),
    );
    await directlyAssign(s, "music_lead", s.chapterId, personId);

    await expect(
      s.as.mutation(api.seatStructure.removeSeat, { slug: "music_lead" }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await tryDefBySlug(s, "music_lead")).not.toBeNull();
  });

  test("rejects removing a seat that still has children", async () => {
    const s = await edSetup();
    // music_lead is unoccupied but is the parent of vocal_lead/band_lead.
    await expect(
      s.as.mutation(api.seatStructure.removeSeat, { slug: "music_lead" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects removing a seat with a duty still mapped to it (#188 assigneeSeatIds)", async () => {
    const s = await edSetup();
    const def = await defBySlug(s, "production_coordinator");
    await run(s.t, (ctx) =>
      ctx.db.insert("responsibilities", {
        chapterId: s.chapterId,
        title: "Run the projector",
        cadence: "weekly",
        assigneeSeatIds: [def._id],
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await expect(
      s.as.mutation(api.seatStructure.removeSeat, { slug: "production_coordinator" }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await tryDefBySlug(s, "production_coordinator")).not.toBeNull();
  });

  test("removes cleanly once the duty is unmapped", async () => {
    const s = await edSetup();
    const def = await defBySlug(s, "production_coordinator");
    const respId = await run(s.t, (ctx) =>
      ctx.db.insert("responsibilities", {
        chapterId: s.chapterId,
        title: "Run the projector",
        cadence: "weekly",
        assigneeSeatIds: [def._id],
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) => ctx.db.patch(respId, { assigneeSeatIds: [] }));

    await s.as.mutation(api.seatStructure.removeSeat, { slug: "production_coordinator" });
    expect(await tryDefBySlug(s, "production_coordinator")).toBeNull();
  });

  test("writes an audit log row with a `before` snapshot and no `after`", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.removeSeat, { slug: "production_coordinator" });
    const log = await s.as.query(api.seatStructure.structureLog, {});
    const row = log.find((r) => r.slug === "production_coordinator" && r.mutation === "removeSeat")!;
    expect(row.after).toBeUndefined();
    expect((row.before as { title?: string }).title).toBe("Production Coordinator");
  });
});

// ── Fail-closed SAFETY scans ─────────────────────────────────────────────────

describe("seatStructure — fail-closed SAFETY scans", () => {
  test("occupied-seat check REJECTS (fail-closed) once the scan would be truncated, instead of proceeding as if unoccupied", async () => {
    const s = await edSetup();
    // A holder on a TOTALLY UNRELATED seat pushes the total seatAssignments
    // row count to the (shrunk) bound — the scan can no longer prove
    // "production_coordinator has zero holders" is complete, so it must
    // reject rather than silently answer "unoccupied".
    const otherPerson = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Other", createdAt: Date.now() }),
    );
    await directlyAssign(s, "event_organizers", s.chapterId, otherPerson);

    // 2 total seatAssignments rows exist now (ED + this one). Shrink the
    // bound to exactly 2 so the scan comes back AT the limit.
    __setSafetyScanLimitForTests(2);

    await expect(
      s.as.mutation(api.seatStructure.removeSeat, { slug: "production_coordinator" }),
    ).rejects.toBeInstanceOf(ConvexError);
    // Definitely NOT deleted — the fail-closed path never reaches the delete.
    expect(await tryDefBySlug(s, "production_coordinator")).not.toBeNull();
  });

  test("maxHolders-floor check REJECTS (fail-closed) once the scan would be truncated, instead of proceeding with an undercount", async () => {
    const s = await edSetup();
    const otherPerson = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Other", createdAt: Date.now() }),
    );
    await directlyAssign(s, "event_organizers", s.chapterId, otherPerson);

    __setSafetyScanLimitForTests(2); // ED assignment + the one above = 2

    await expect(
      s.as.mutation(api.seatStructure.updateSeat, { slug: "event_organizers", maxHolders: 3 }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("duty-reference check REJECTS (fail-closed) once the scan would be truncated", async () => {
    const s = await edSetup();
    await run(s.t, (ctx) =>
      ctx.db.insert("responsibilities", {
        chapterId: s.chapterId,
        title: "Unrelated duty",
        cadence: "weekly",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    __setSafetyScanLimitForTests(1); // exactly 1 responsibilities row exists

    await expect(
      s.as.mutation(api.seatStructure.removeSeat, { slug: "production_coordinator" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a scan comfortably UNDER the bound still resolves normally (fail-closed only trips AT the limit)", async () => {
    const s = await edSetup();
    __setSafetyScanLimitForTests(50); // ED's 1 assignment is nowhere near 50
    await s.as.mutation(api.seatStructure.removeSeat, { slug: "production_coordinator" });
    expect(await tryDefBySlug(s, "production_coordinator")).toBeNull();
  });
});

// ── Global org.editChart lockout guard ──────────────────────────────────────

describe("seatStructure — global org.editChart lockout guard", () => {
  // NOTE on reachability: for a NON-superuser, the gate (`requireChartEditor`)
  // already REQUIRES the caller to currently hold `org.editChart` via SOME
  // seat. If the def being edited is a DIFFERENT seat than the one granting
  // the caller their own power, that other seat is untouched by the edit and
  // remains a live witness — the global check can never fire in that shape,
  // by construction (see the two "safely allowed" tests below). The global
  // check is therefore reachable for a non-superuser ONLY on the overlapping
  // case — stripping their OWN sole qualifying seat, where self-lockout is
  // ALSO independently true — and unconditionally for a superuser (who holds
  // no qualifying seat at all, so self-lockout's early-return never applies
  // to them). Both are covered below, plus a dedicated test proving
  // self-lockout fires on its own when the ORG still has another active
  // editor but the CALLER personally doesn't.

  test("a non-superuser CAN strip org.editChart from someone ELSE's OCCUPIED seat, as long as their own seat still grants it", async () => {
    const s = await edSetup(); // ED's own executive_director seat is occupied + carries org.editChart
    const deputySeatId = await s.as.mutation(api.seatStructure.addSeat, {
      chart: "central",
      parentSlug: "executive_director",
      title: "Deputy Director",
      maxHolders: 1,
      duties: [],
      capabilities: ["org.editChart"],
    });
    const deputyDef = await run(s.t, (ctx) => ctx.db.get(deputySeatId));
    const deputyPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Deputy", createdAt: Date.now() }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: deputySeatId,
        scope: "central",
        personId: deputyPersonId,
        createdAt: Date.now(),
      }),
    );

    // The ED's OWN seat still carries org.editChart with an active holder
    // (the ED, untouched by this edit) — the org retains an editor
    // throughout, so this is safely allowed.
    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: deputyDef!.slug,
      capabilities: [],
    });
    expect((await defBySlug(s, deputyDef!.slug)).capabilities).toEqual([]);
  });

  test("a non-superuser CAN strip org.editChart from an UNOCCUPIED seat, same reason", async () => {
    const s = await edSetup(); // ED seat is occupied and carries org.editChart
    const unoccupiedSeatId = await s.as.mutation(api.seatStructure.addSeat, {
      chart: "central",
      parentSlug: "executive_director",
      title: "Vacant Deputy",
      maxHolders: 1,
      duties: [],
      capabilities: ["org.editChart"],
    });
    const unoccupiedDef = await run(s.t, (ctx) => ctx.db.get(unoccupiedSeatId));

    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: unoccupiedDef!.slug,
      capabilities: [],
    });
    expect((await defBySlug(s, unoccupiedDef!.slug)).capabilities).toEqual([]);
  });

  test("a non-superuser stripping their OWN sole qualifying seat is rejected (overlap with self-lockout — GLOBAL_EDITCHART_LOCKOUT fires, the more accurate message since there's no OTHER editor to ask)", async () => {
    const s = await edSetup(); // executive_director is the ONLY seat anywhere carrying org.editChart
    let caught: unknown;
    try {
      await s.as.mutation(api.seatStructure.updateSeat, {
        slug: "executive_director",
        capabilities: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "GLOBAL_EDITCHART_LOCKOUT",
    );
    expect((await defBySlug(s, "executive_director")).capabilities).toContain("org.editChart");
  });

  test("SELF-lockout fires on its own when the ORG retains another active editor but the CALLER personally would lose their power", async () => {
    const s = await edSetup();
    // A SEPARATE person holds a SEPARATE org.editChart seat — the org
    // retains an editor no matter what the ED does to their OWN seat, so the
    // GLOBAL check can never fire here; only SELF-lockout is at stake.
    const deputySeatId = await s.as.mutation(api.seatStructure.addSeat, {
      chart: "central",
      parentSlug: "executive_director",
      title: "Deputy Director",
      maxHolders: 1,
      duties: [],
      capabilities: ["org.editChart"],
    });
    const deputyPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Deputy", createdAt: Date.now() }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: deputySeatId,
        scope: "central",
        personId: deputyPersonId,
        createdAt: Date.now(),
      }),
    );

    let caught: unknown;
    try {
      await s.as.mutation(api.seatStructure.updateSeat, {
        slug: "executive_director", // the ED's OWN, sole personal source of org.editChart
        capabilities: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("SELF_LOCKOUT");
  });

  test("a superuser MAY strip the last active org.editChart seat (backstop) — allowed, not silent", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "seyi@publicworship.life" }); // superuser, no seat at all

    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "executive_director",
      capabilities: [],
    });
    expect((await defBySlug(s, "executive_director")).capabilities).toEqual([]);
  });
});

// ── structureLog ─────────────────────────────────────────────────────────────

describe("seatStructure.structureLog", () => {
  test("is gated the same as every write (rejects a non-editor)", async () => {
    const s = await edSetup();
    const { as: outsiderAs } = await signInAs(s.t, "outsider@publicworship.life");
    await expect(outsiderAs.query(api.seatStructure.structureLog, {})).rejects.toBeInstanceOf(
      ConvexError,
    );
  });

  test("returns rows newest-first, respecting `limit`", async () => {
    const s = await edSetup();
    await s.as.mutation(api.seatStructure.renameSeat, { slug: "treasurer", title: "T1" });
    await s.as.mutation(api.seatStructure.renameSeat, { slug: "treasurer", title: "T2" });
    await s.as.mutation(api.seatStructure.renameSeat, { slug: "treasurer", title: "T3" });

    const log = await s.as.query(api.seatStructure.structureLog, { limit: 2 });
    expect(log).toHaveLength(2);
    expect((log[0]!.after as { title?: string }).title).toBe("T3");
    expect((log[1]!.after as { title?: string }).title).toBe("T2");
  });
});

// ── Shared def: a chapter-chart edit applies to every chapter at once ───────

describe("seatStructure — chapter-chart edits are shared across every chapter", () => {
  test("an updateSeat on a chapter-chart seat is visible to two different chapters immediately", async () => {
    const s = await edSetup({ chapterName: "New York" });
    const chicagoId = await makeChapter(s, "Chicago");
    const treasurerDef = await defBySlug(s, "treasurer");

    await s.as.mutation(api.seatStructure.updateSeat, {
      slug: "treasurer",
      duties: ["Reconcile weekly", "Chase every receipt"],
    });

    const ny = await s.as.query(api.seats.chartQueries.seatDetail, {
      defId: treasurerDef._id,
      scope: s.chapterId,
    });
    const chicago = await s.as.query(api.seats.chartQueries.seatDetail, {
      defId: treasurerDef._id,
      scope: chicagoId,
    });
    expect(ny?.duties).toEqual(["Reconcile weekly", "Chase every receipt"]);
    expect(chicago?.duties).toEqual(["Reconcile weekly", "Chase every receipt"]);
  });
});
