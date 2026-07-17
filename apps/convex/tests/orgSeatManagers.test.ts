/**
 * Seat-derived manager relationships — the Convex wiring around
 * `@events-os/shared`'s pure `seatManagers.ts` algorithm (unit-tested
 * exhaustively over synthetic data in `packages/shared/src/seatManagers.test.ts`).
 * These tests exercise the REAL taxonomy end-to-end through `org.workload` /
 * `org.nav` / `org.overview`: seed the real `seatDefs` template, assign a few
 * real seats, and check the manager/report relationships those queries derive.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/** A seat-seeded chapter, with an admin caller. */
async function seatSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t);
}

/** Insert a bare roster person. */
async function makePerson(
  s: ChapterSetup,
  name: string,
  opts: { managerId?: Id<"people"> } = {},
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      createdAt: Date.now(),
      ...(opts.managerId ? { managerId: opts.managerId } : {}),
    }),
  );
}

/** The seatDef row seeded for a template `slug` (mirrors `seats.test.ts`'s
 *  own private helper — duplicated here rather than exported cross-file,
 *  since it's a two-line query and this file owns its own test fixtures). */
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

/** Assign a seat directly (bypassing `seats.assignSeat`'s superuser gate and
 *  `maxHolders`/write-through side effects — irrelevant to manager
 *  derivation, which reads raw `seatAssignments` rows regardless). */
async function assign(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
) {
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

/** Add a second signed-in user linked to a roster person (mirrors
 *  `orgProjects.test.ts`'s `addUser`), so a non-admin caller can be tested. */
async function addUser(s: ChapterSetup, email: string, personId: Id<"people">) {
  const userId = await run(s.t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    });
    await ctx.db.patch(personId, { userId });
    return userId;
  });
  return s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

describe("seat-derived managers (org.workload)", () => {
  test("a chapter music_lead reports to the chapter_director", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    const mia = await makePerson(s, "Mia");
    await assign(s, "chapter_director", s.chapterId, dana);
    await assign(s, "music_lead", s.chapterId, mia);

    const workload = await s.as.query(api.org.workload, { personId: mia });
    expect(workload!.managers.map((m) => m.name)).toEqual(["Dana"]);
  });

  test("a vacant chapter_director rolls up to the central expansion_director's holders", async () => {
    const s = await seatSetup();
    const mia = await makePerson(s, "Mia");
    const erin = await makePerson(s, "Erin");
    // chapter_director is left vacant — no assignment for it.
    await assign(s, "music_lead", s.chapterId, mia);
    await assign(s, "expansion_director", "central", erin);

    const workload = await s.as.query(api.org.workload, { personId: mia });
    expect(workload!.managers.map((m) => m.name)).toEqual(["Erin"]);
  });

  test("the executive director (top of the org) has no managers — not a fallback signal", async () => {
    const s = await seatSetup();
    const eli = await makePerson(s, "Eli");
    await assign(s, "executive_director", "central", eli);

    const workload = await s.as.query(api.org.workload, { personId: eli });
    expect(workload!.managers).toEqual([]);
  });

  test("a multi-holder parent seat's managers are ALL of its holders — no stored primary", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    const mo = await makePerson(s, "Mo");
    const val = await makePerson(s, "Val");
    // Two holders sharing music_lead (synthetic — bypasses the template's
    // maxHolders:1 cap, irrelevant to the raw-row-driven algorithm).
    await assign(s, "music_lead", s.chapterId, dana);
    await assign(s, "music_lead", s.chapterId, mo);
    await assign(s, "vocal_lead", s.chapterId, val);

    const workload = await s.as.query(api.org.workload, { personId: val });
    expect(workload!.managers.map((m) => m.name).sort()).toEqual(["Dana", "Mo"]);
  });

  test("an ancestor seat held by the person themself is skipped", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    const erin = await makePerson(s, "Erin");
    // Dana holds BOTH music_lead and its ancestor chapter_director — the walk
    // must skip the self-held chapter_director and keep climbing to the real
    // manager (the central expansion_director's holder).
    await assign(s, "music_lead", s.chapterId, dana);
    await assign(s, "chapter_director", s.chapterId, dana);
    await assign(s, "expansion_director", "central", erin);

    const workload = await s.as.query(api.org.workload, { personId: dana });
    expect(workload!.managers.map((m) => m.name)).toEqual(["Erin"]);
  });

  test("a seatless person falls back to their stored managerId", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    // Vic holds no seat at all but has a legacy stored manager link.
    const vic = await makePerson(s, "Vic", { managerId: dana });

    const workload = await s.as.query(api.org.workload, { personId: vic });
    expect(workload!.managers.map((m) => m.name)).toEqual(["Dana"]);
  });

  test("a seat-holder's stale stored managerId is ignored once seat truth applies", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    const staleBoss = await makePerson(s, "Stale Boss");
    const mia = await makePerson(s, "Mia", { managerId: staleBoss });
    await assign(s, "chapter_director", s.chapterId, dana);
    await assign(s, "music_lead", s.chapterId, mia);

    const workload = await s.as.query(api.org.workload, { personId: mia });
    expect(workload!.managers.map((m) => m.name)).toEqual(["Dana"]);
  });
});

describe("seat-derived reports flip canManage (org.nav / org.overview / org.workload)", () => {
  test("canManage is true for a seat-holder with seat-derived reports, even though the managerId graph shows none", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana"); // no stored managerId reports point at Dana
    const mia = await makePerson(s, "Mia");
    await assign(s, "chapter_director", s.chapterId, dana);
    await assign(s, "music_lead", s.chapterId, mia);
    const asDana = await addUser(s, "dana@publicworship.life", dana);

    expect(await asDana.query(api.org.nav)).toMatchObject({
      isAdmin: false,
      canManage: true,
      selfPersonId: dana,
    });

    const overview = await asDana.query(api.org.overview);
    expect(overview.canManage).toBe(true);

    const workload = await asDana.query(api.org.workload, { personId: dana });
    expect(workload!.caller.canManage).toBe(true);
    expect(workload!.reports.map((r) => r.name)).toEqual(["Mia"]);
  });

  test("a plain seatless member with no reports of either kind stays canManage: false", async () => {
    const s = await seatSetup();
    const vic = await makePerson(s, "Vic");
    const asVic = await addUser(s, "vic@publicworship.life", vic);

    expect(await asVic.query(api.org.nav)).toMatchObject({
      isAdmin: false,
      canManage: false,
    });
    expect((await asVic.query(api.org.overview)).canManage).toBe(false);
  });
});

// The read surfaces above (`nav`/`overview`/`workload`) and the WRITE gates
// below (`checkIns.log` via `manageablePersonIds`, `responsibilities.create`
// via `requireManagerOrAdmin`) must agree exactly — both are built on the
// SAME `buildEffectiveChildrenOf`/`hasEffectiveReports` derivation in
// `lib/org.ts`, so a seat-only manager is never shown an affordance
// (canManage: true, a visible "Log 1:1" / "Add duty" button) that then 403s.
describe("seat-derived write gates agree with reads (manageablePersonIds / requireManagerOrAdmin)", () => {
  test("a seat-only chapter_director can log a check-in for, and create a responsibility affecting, a seat-derived report", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana"); // no stored managerId reports point at Dana
    const mia = await makePerson(s, "Mia"); // seat-derived report only, no managerId set
    await assign(s, "chapter_director", s.chapterId, dana);
    await assign(s, "music_lead", s.chapterId, mia);
    const asDana = await addUser(s, "dana-write@publicworship.life", dana);

    // WRITE: checkIns.log (gated by `manageablePersonIds`).
    await expect(
      asDana.mutation(api.checkIns.log, { personId: mia, type: "skip" }),
    ).resolves.not.toThrow();

    // WRITE: responsibilities.create (gated by `requireManagerOrAdmin`).
    await expect(
      asDana.mutation(api.responsibilities.create, {
        title: "Book the rehearsal space",
      }),
    ).resolves.not.toThrow();
  });

  test("a non-manager remains FORBIDDEN from both write gates", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    const vic = await makePerson(s, "Vic"); // no seat, no reports of either kind
    await assign(s, "chapter_director", s.chapterId, dana);
    const asVic = await addUser(s, "vic-write@publicworship.life", vic);

    await expect(
      asVic.mutation(api.checkIns.log, { personId: dana, type: "skip" }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asVic.mutation(api.responsibilities.create, { title: "Not allowed" }),
    ).rejects.toThrow(ConvexError);
  });

  test("a stored-managerId manager (no seats involved at all) is unchanged", async () => {
    const s = await seatSetup();
    const bob = await makePerson(s, "Bob");
    const cara = await makePerson(s, "Cara", { managerId: bob });
    const asBob = await addUser(s, "bob-write@publicworship.life", bob);

    await expect(
      asBob.mutation(api.checkIns.log, { personId: cara, type: "skip" }),
    ).resolves.not.toThrow();
    await expect(
      asBob.mutation(api.responsibilities.create, { title: "Legacy-managed duty" }),
    ).resolves.not.toThrow();
  });
});
