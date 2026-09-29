/**
 * `org.seats.edit` ("Fill seats") — the power behind changing a seat's holders
 * directly, which used to be superuser-only (`seats.assignSeat`'s old
 * `requireSuperuser`). See `lib/seatAssignAccess.ts`.
 *
 * Also covers `seats.powersDirectory`, the whole-chart powers read the org
 * chart's picker and Powers directory share.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

async function seatSetup(email = "leader@publicworship.life"): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, { email });
}

async function defBySlug(s: ChapterSetup, slug: string) {
  const def = await run(s.t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

async function makePerson(
  s: ChapterSetup,
  name: string,
  userId?: Id<"users">,
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      createdAt: Date.now(),
      ...(userId ? { userId } : {}),
    }),
  );
}

/** Seat the CALLER in `slug` by writing the row directly (no gate involved). */
async function seatCaller(s: ChapterSetup, slug: string, scope: Id<"chapters"> | "central") {
  const me = await makePerson(s, "Caller", s.userId);
  const def = await defBySlug(s, slug);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId: me,
      createdAt: Date.now(),
    }),
  );
}

describe("org.seats.edit — filling seats without a proposal", () => {
  test("the Executive Director can assign and unassign directly without being a superuser", async () => {
    const s = await seatSetup();
    await seatCaller(s, "executive_director", "central");
    const lead = await defBySlug(s, "music_lead");
    const p = await makePerson(s, "New Lead");

    const assignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: lead._id,
      scope: s.chapterId,
      personId: p,
    });

    const detail = await s.as.query(api.seats.seatDetail, {
      defId: lead._id,
      scope: s.chapterId,
    });
    expect(detail?.canFillSeats).toBe(true);
    expect(detail?.holders[0]!.assignmentId).toBe(assignmentId);

    await s.as.mutation(api.seats.unassignSeat, { assignmentId });
    expect(await run(s.t, (ctx) => ctx.db.get(assignmentId))).toBeNull();
  });

  test("a seat granted only Fill seats can staff the chart but not reshape it", async () => {
    const s = await seatSetup();
    const lead = await defBySlug(s, "music_lead");
    await run(s.t, (ctx) => ctx.db.patch(lead._id, { capabilities: ["org.seats.edit"] }));
    await seatCaller(s, "music_lead", s.chapterId);
    const vocal = await defBySlug(s, "vocal_lead");
    const p = await makePerson(s, "Singer");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: vocal._id,
      scope: s.chapterId,
      personId: p,
    });

    await expect(
      s.as.mutation(api.seatStructure.renameSeat, { slug: "vocal_lead", title: "Choir Lead" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a caller without the power is refused and never sees assignment ids", async () => {
    const s = await seatSetup();
    await seatCaller(s, "music_lead", s.chapterId);
    const vocal = await defBySlug(s, "vocal_lead");
    const p = await makePerson(s, "Singer");

    await expect(
      s.as.mutation(api.seats.assignSeat, {
        seatDefId: vocal._id,
        scope: s.chapterId,
        personId: p,
      }),
    ).rejects.toThrow(/Fill seats/);

    const detail = await s.as.query(api.seats.seatDetail, {
      defId: vocal._id,
      scope: s.chapterId,
    });
    expect(detail?.canFillSeats).toBe(false);
  });
});

describe("seats.powersDirectory", () => {
  test("returns every non-derived seat with its stored powers", async () => {
    const s = await seatSetup();
    const rows = await s.as.query(api.seats.powersDirectory, {});

    const ed = rows.find((r) => r.slug === "executive_director");
    expect(ed?.chart).toBe("central");
    expect(ed?.capabilities).toContain("org.chart.edit");
    expect(rows.some((r) => r.slug === "treasurer" && r.chart === "chapter")).toBe(true);
    expect(rows.some((r) => r.slug === "chapter_directors")).toBe(false);
  });
});
