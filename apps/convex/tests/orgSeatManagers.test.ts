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

// `org.overview`'s `people[].effectiveManagerIds` is what the Work tab's
// client-side tree (`team.tsx`) builds its List/Chart hierarchy from, instead
// of raw `managerId` — see that file's header comment. These tests exercise
// the field directly, mirroring the `workload.managers` assertions above.
describe("overview.people[].effectiveManagerIds (Work tab tree source)", () => {
  test("a seat-only report's effectiveManagerIds is seat-derived; managerId stays the raw stored value (unset)", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    const mia = await makePerson(s, "Mia"); // no stored managerId
    await assign(s, "chapter_director", s.chapterId, dana);
    await assign(s, "music_lead", s.chapterId, mia);

    const overview = await s.as.query(api.org.overview);
    const miaRow = overview.people.find((p) => p._id === mia)!;
    expect(miaRow.effectiveManagerIds).toEqual([dana]);
    expect(miaRow.managerId).toBeNull();
  });

  test("a seatless person's effectiveManagerIds falls back to their stored managerId", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    const vic = await makePerson(s, "Vic", { managerId: dana }); // no seat at all

    const overview = await s.as.query(api.org.overview);
    const vicRow = overview.people.find((p) => p._id === vic)!;
    expect(vicRow.effectiveManagerIds).toEqual([dana]);
  });

  test("the executive director (top of the org) has an empty effectiveManagerIds — not a fallback signal", async () => {
    const s = await seatSetup();
    const eli = await makePerson(s, "Eli");
    await assign(s, "executive_director", "central", eli);

    const overview = await s.as.query(api.org.overview);
    const eliRow = overview.people.find((p) => p._id === eli)!;
    expect(eliRow.effectiveManagerIds).toEqual([]);
  });

  test("a multi-holder parent seat puts ALL holders in effectiveManagerIds — no stored primary", async () => {
    const s = await seatSetup();
    const dana = await makePerson(s, "Dana");
    const mo = await makePerson(s, "Mo");
    const val = await makePerson(s, "Val");
    await assign(s, "music_lead", s.chapterId, dana);
    await assign(s, "music_lead", s.chapterId, mo);
    await assign(s, "vocal_lead", s.chapterId, val);

    const overview = await s.as.query(api.org.overview);
    const valRow = overview.people.find((p) => p._id === val)!;
    expect([...valRow.effectiveManagerIds].sort()).toEqual([dana, mo].sort());
  });

  test("a seat-derived manager who isn't on this chapter's roster (cross-chapter central seat) is excluded from effectiveManagerIds", async () => {
    const s = await seatSetup();
    const mia = await makePerson(s, "Mia");
    // chapter_director left vacant — Mia's manager rolls up to the central
    // expansion_director, held by someone in a DIFFERENT chapter.
    await assign(s, "music_lead", s.chapterId, mia);
    const otherChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Other Chapter", isActive: true }),
    );
    const erin = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: otherChapterId,
        name: "Erin",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await assign(s, "expansion_director", "central", erin);

    // The person-keyed answer (workload.managers) still resolves Erin by id,
    // even though she's out of Mia's chapter roster.
    const workload = await s.as.query(api.org.workload, { personId: mia });
    expect(workload!.managers.map((m) => m.name)).toEqual(["Erin"]);

    // But the roster-local tree field has nothing to hang her under.
    const overview = await s.as.query(api.org.overview);
    const miaRow = overview.people.find((p) => p._id === mia)!;
    expect(miaRow.effectiveManagerIds).toEqual([]);
  });
});

// PR #205 regression: production's "Work tab List view renders exactly ONE
// row" bug. Real prod data has MULTIPLE people who hold a central-chart seat
// AND a chapter seat, and those two seats can roll up into EACH OTHER:
// Seyi (executive_director@central + chapter_director@NY) and Jesulayomi
// (expansion_director@central + event_lead@NY) each independently derive the
// other as a candidate manager (Seyi's chapter_director rolls up to
// expansion_director; Jesulayomi's expansion_director reports to
// executive_director). Pre-fix, `deriveSeatManagerIds` returned BOTH edges,
// so the Work tab's client tree (`effectiveManagerIds[0]` decides "am I a
// root") excluded both people — and everything hanging off Jesulayomi's
// seats (most of the chapter) vanished from the tree, leaving only the truly
// seatless Julie visible. See `@events-os/shared`'s `seatManagers.ts` module
// header ("MUTUAL-SEAT CYCLE TIE-BREAK") for the fix and its rationale.
describe("prod-shaped multi-seat mutual pair (PR #205 regression)", () => {
  test("every seat-holder resolves to the ED as their (possibly indirect) manager; the ED itself has none", async () => {
    const s = await seatSetup(); // chapter name defaults to "New York"

    const seyi = await makePerson(s, "Seyi");
    const kansi = await makePerson(s, "Kansi");
    const austin = await makePerson(s, "Austin");
    const jesulayomi = await makePerson(s, "Jesulayomi");
    const charisma = await makePerson(s, "Charisma");
    const aj = await makePerson(s, "AJ");
    const michaela = await makePerson(s, "Michaela");
    const carolyn = await makePerson(s, "Carolyn");
    const kaylamarie = await makePerson(s, "Kaylamarie");
    const michael = await makePerson(s, "Michael");
    const zay = await makePerson(s, "Zay");
    const org1 = await makePerson(s, "Organizer One");
    const org2 = await makePerson(s, "Organizer Two");
    const org3 = await makePerson(s, "Organizer Three");
    // Seatless roster members with only a legacy title text — the only rows
    // that survived pre-fix (Julie was the ONE row prod actually rendered).
    const julie = await makePerson(s, "Julie");
    const peter = await makePerson(s, "Peter");
    const grace = await makePerson(s, "Grace");

    // Multi-seat holders — one central seat, one chapter seat each.
    await assign(s, "executive_director", "central", seyi);
    await assign(s, "chapter_director", s.chapterId, seyi);
    await assign(s, "financial_manager", "central", kansi);
    await assign(s, "treasurer", s.chapterId, kansi);
    await assign(s, "music_director", "central", austin);
    await assign(s, "music_lead", s.chapterId, austin);
    await assign(s, "expansion_director", "central", jesulayomi);
    await assign(s, "event_lead", s.chapterId, jesulayomi);
    await assign(s, "marketing_director", "central", charisma);
    await assign(s, "marketing_lead", s.chapterId, charisma);

    // Single-seat holders.
    await assign(s, "development_director", "central", aj);
    await assign(s, "graphic_designer", "central", michaela);
    await assign(s, "marketing_associate", "central", carolyn);
    await assign(s, "fundraising_associate", "central", kaylamarie);
    await assign(s, "musicians", "central", michael);
    await assign(s, "production_coordinator", s.chapterId, zay);
    // Multi-holder chapter seat, all three co-holders.
    await assign(s, "event_organizers", s.chapterId, org1);
    await assign(s, "event_organizers", s.chapterId, org2);
    await assign(s, "event_organizers", s.chapterId, org3);

    const overview = await s.as.query(api.org.overview);
    const rowFor = (id: Id<"people">) => overview.people.find((p) => p._id === id)!;

    // The full roster round-trips — nothing missing from the query itself
    // (the bug was client-side tree-building, not a server-side omission).
    expect(overview.people).toHaveLength(17);

    // The ED is a root DESPITE also holding chapter_director, which rolls up
    // to expansion_director (Jesulayomi) — the mutual edge is broken in the
    // ED's favor (strictly more senior overall: depth 0 vs Jesulayomi's 1).
    expect(rowFor(seyi).effectiveManagerIds).toEqual([]);

    // Jesulayomi reports to the ED — never the reverse.
    expect(rowFor(jesulayomi).effectiveManagerIds).toEqual([seyi]);

    // Every other multi-seat holder also resolves cleanly to the ED — their
    // chapter seat's rollup and their central seat's direct report both point
    // at Seyi, deduped to one entry.
    expect(rowFor(kansi).effectiveManagerIds).toEqual([seyi]);
    expect(rowFor(austin).effectiveManagerIds).toEqual([seyi]);
    expect(rowFor(charisma).effectiveManagerIds).toEqual([seyi]);

    // Single-seat holders resolve to their direct seat parent, undisturbed.
    expect(rowFor(aj).effectiveManagerIds).toEqual([seyi]);
    expect(rowFor(michaela).effectiveManagerIds).toEqual([charisma]);
    expect(rowFor(carolyn).effectiveManagerIds).toEqual([charisma]);
    expect(rowFor(kaylamarie).effectiveManagerIds).toEqual([aj]);
    expect(rowFor(michael).effectiveManagerIds).toEqual([austin]);
    expect(rowFor(zay).effectiveManagerIds).toEqual([jesulayomi]);
    expect(rowFor(org1).effectiveManagerIds).toEqual([jesulayomi]);
    expect(rowFor(org2).effectiveManagerIds).toEqual([jesulayomi]);
    expect(rowFor(org3).effectiveManagerIds).toEqual([jesulayomi]);

    // Seatless legacy-title people are unaffected — still their own roots
    // (no stored managerId either), same as they were pre-fix.
    expect(rowFor(julie).effectiveManagerIds).toEqual([]);
    expect(rowFor(peter).effectiveManagerIds).toEqual([]);
    expect(rowFor(grace).effectiveManagerIds).toEqual([]);

    // No subtree got orphaned: every non-root, non-seatless person's chosen
    // parent (`effectiveManagerIds[0]`) IS present in the roster the client
    // renders from — the exact condition `team.tsx`'s root filter checks.
    const rosterIds = new Set(overview.people.map((p) => p._id));
    for (const p of overview.people) {
      const managerId = p.effectiveManagerIds[0];
      if (managerId) expect(rosterIds.has(managerId)).toBe(true);
    }
  });
});

// Adversarial review finding (2026-07-17): an earlier version of the cycle
// fix used a BLANKET seniority filter — keep a candidate manager only if
// they're senior to the person's single most-senior seat, checked against
// EVERY candidate, not just ones inside an actual cycle. That silently
// dropped legitimate, non-cyclic manager edges: a central Development
// Director who also volunteers on a chapter's multi-holder `event_organizers`
// seat lost their real, non-cyclic `event_lead` manager for that seat, purely
// because their UNRELATED central seat outranked the event lead overall.
// Since `buildEffectiveChildrenOf` is what `manageablePersonIds` /
// `hasEffectiveReports` walk, that silently stripped the event lead's WRITE
// authority (`checkIns.log`, `responsibilities.*`) over that volunteer — a
// real authorization regression, not just a display bug. The fix must be
// CYCLE-SCOPED (only touch edges that are actually part of a cycle), so this
// non-cyclic edge survives untouched. Pinned here at the GATE level (not just
// the `effectiveManagerIds` field) since that's what actually broke.
describe("cycle-scoped tie-break preserves non-cyclic write authority (adversarial review fix)", () => {
  test("a person's unrelated senior central seat does not strip their real chapter manager's write authority", async () => {
    const s = await seatSetup();
    const ed = await makePerson(s, "ED");
    // X: central Development Director (senior) who ALSO volunteers as an NY
    // event_organizers co-holder (junior) — two entirely unrelated seats.
    const x = await makePerson(s, "X");
    // Y: the NY Event Lead — X's REAL, non-cyclic manager for the
    // event_organizers seat. Y never points back at X or ED, so this is not
    // a cycle at all.
    const y = await makePerson(s, "Y");
    await assign(s, "executive_director", "central", ed);
    await assign(s, "development_director", "central", x);
    await assign(s, "event_organizers", s.chapterId, x);
    await assign(s, "event_lead", s.chapterId, y);
    const asY = await addUser(s, "y-write@publicworship.life", y);

    // READ: overview.people[].effectiveManagerIds keeps BOTH managers — the
    // ED (via development_director) AND Y (via event_organizers). Neither is
    // senior to the other in a way that creates a cycle, so both survive.
    const overview = await s.as.query(api.org.overview);
    const xRow = overview.people.find((p) => p._id === x)!;
    expect([...xRow.effectiveManagerIds].sort()).toEqual([ed, y].sort());

    // WRITE: the event lead (Y) — not an admin, not the ED — must still be
    // able to log a check-in for X. This is the actual regression: a blanket
    // seniority filter silently 403s this exact call.
    await expect(
      asY.mutation(api.checkIns.log, { personId: x, type: "skip" }),
    ).resolves.not.toThrow();

    // And Y genuinely has reports (canManage), not just a read-side artifact.
    expect(await asY.query(api.org.nav)).toMatchObject({
      isAdmin: false,
      canManage: true,
    });
  });
});
