/**
 * Responsibilities + 1:1 check-ins: definitions fan out by role (one row →
 * many people), check-ins are manager-only and never on yourself, and the
 * history is readable exactly as far as the caller's manager reach.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { responsibilityAppliesTo } from "@events-os/shared";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/** Another signed-in chapter member (role "member" — NOT admin), optionally
 *  linked to a roster person. */
async function addUser(
  s: ChapterSetup,
  email: string,
  opts: { personId?: Id<"people"> } = {},
) {
  const userId = await run(s.t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    });
    if (opts.personId) await ctx.db.patch(opts.personId, { userId });
    return userId;
  });
  return s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

/** alice ← bob ← cara, with job titles for role fan-out. */
async function seedChain(s: ChapterSetup) {
  const alice = (await s.as.mutation(api.people.create, {
    name: "Alice",
    role: "Director",
    isTeamMember: true,
  })) as Id<"people">;
  const bob = (await s.as.mutation(api.people.create, {
    name: "Bob",
    role: "Director",
    isTeamMember: true,
    managerId: alice,
  })) as Id<"people">;
  const cara = (await s.as.mutation(api.people.create, {
    name: "Cara",
    role: "Designer",
    isTeamMember: true,
    managerId: bob,
  })) as Id<"people">;
  return { alice, bob, cara };
}

describe("responsibilities", () => {
  test("one row fans out by role (case-insensitively) and by direct assignment", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);

    await s.as.mutation(api.responsibilities.create, {
      title: "Meet with directs",
      cadence: "biweekly",
      assigneeRoles: ["director"],
    });
    await s.as.mutation(api.responsibilities.create, {
      title: "Create event flyers",
      cadence: "ad_hoc",
      assigneePersonIds: [cara],
    });

    const rows = await s.as.query(api.responsibilities.list);
    const meet = rows.find((r) => r.title === "Meet with directs")!;
    const flyers = rows.find((r) => r.title === "Create event flyers")!;
    const person = (id: Id<"people">, role: string) => ({ _id: id, role });

    // "director" matches both Directors despite the case difference…
    expect(responsibilityAppliesTo(meet, person(alice, "Director"))).toBe(true);
    expect(responsibilityAppliesTo(meet, person(bob, "Director"))).toBe(true);
    expect(responsibilityAppliesTo(meet, person(cara, "Designer"))).toBe(false);
    // …and the direct assignment reaches Cara regardless of role.
    expect(responsibilityAppliesTo(flyers, person(cara, "Designer"))).toBe(true);
    expect(responsibilityAppliesTo(flyers, person(bob, "Director"))).toBe(false);
  });

  test("the catalog is transparent — every roster member reads it, but not visitors", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });
    const asVisitor = await addUser(s, "visitor@publicworship.life");

    await s.as.mutation(api.responsibilities.create, {
      title: "Meet with directs",
      assigneeRoles: ["director"],
    });
    await s.as.mutation(api.responsibilities.create, {
      title: "Create event flyers",
      assigneePersonIds: [cara],
    });
    await s.as.mutation(api.responsibilities.create, {
      title: "Approve budgets",
      assigneeRoles: ["treasurer"],
    });

    // Read is transparent: admins, managers, AND plain members (Cara, no
    // reports) all read the whole catalog — a person's workload page shows the
    // duties they carry, part of seeing the work everyone has…
    expect((await s.as.query(api.responsibilities.list)).length).toBe(3);
    expect((await asBob.query(api.responsibilities.list)).length).toBe(3);
    expect((await asCara.query(api.responsibilities.list)).length).toBe(3);
    // …but a signed-in account with no roster row still receives nothing.
    expect(await asVisitor.query(api.responsibilities.list)).toEqual([]);
  });

  test("editing is for managers and admins only", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    // Cara (no reports) can't touch the definitions she's held to…
    await expect(
      asCara.mutation(api.responsibilities.create, { title: "X" }),
    ).rejects.toThrow(ConvexError);
    const id = (await asBob.mutation(api.responsibilities.create, {
      title: "Weekly setlist",
      assigneePersonIds: [cara],
    })) as Id<"responsibilities">;
    await expect(
      asCara.mutation(api.responsibilities.update, {
        responsibilityId: id,
        assigneePersonIds: null,
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asCara.mutation(api.responsibilities.remove, { responsibilityId: id }),
    ).rejects.toThrow(ConvexError);
    // …while her manager and admins can.
    await asBob.mutation(api.responsibilities.update, {
      responsibilityId: id,
      cadence: "weekly",
    });
    await s.as.mutation(api.responsibilities.remove, { responsibilityId: id });
  });

  test("addAssignee / removeAssignee edit one membership, race-safely", async () => {
    const s = await setupChapter(newT());
    const { alice, cara } = await seedChain(s);
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    const id = (await s.as.mutation(api.responsibilities.create, {
      title: "Storage upkeep",
      assigneeRoles: ["director"],
      assigneePersonIds: [alice],
    })) as Id<"responsibilities">;
    const row = async () =>
      (await s.as.query(api.responsibilities.list)).find((r) => r._id === id)!;

    // Targeted add appends without rewriting the array; re-adding is a no-op.
    await s.as.mutation(api.responsibilities.addAssignee, {
      responsibilityId: id,
      personId: cara,
    });
    await s.as.mutation(api.responsibilities.addAssignee, {
      responsibilityId: id,
      personId: cara,
    });
    expect((await row()).assigneePersonIds).toEqual([alice, cara]);

    // Targeted remove drops only the named person; role fan-out is untouched.
    await s.as.mutation(api.responsibilities.removeAssignee, {
      responsibilityId: id,
      personId: alice,
    });
    expect((await row()).assigneePersonIds).toEqual([cara]);
    expect((await row()).assigneeRoles).toEqual(["director"]);

    // Removing the last direct assignee clears the field entirely (the same
    // shape update's null-clear leaves) rather than storing [].
    await s.as.mutation(api.responsibilities.removeAssignee, {
      responsibilityId: id,
      personId: cara,
    });
    expect((await row()).assigneePersonIds).toBeUndefined();

    // Both are manager/admin-gated like every other assignment edit.
    await expect(
      asCara.mutation(api.responsibilities.addAssignee, {
        responsibilityId: id,
        personId: cara,
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asCara.mutation(api.responsibilities.removeAssignee, {
        responsibilityId: id,
        personId: cara,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a duty's How-To doc is manager-gated like the row itself", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    // Bob (manager) documents a duty with a markdown runbook.
    const { _id: docId } = await asBob.mutation(api.docs.create, {
      kind: "markdown",
      title: "Setlist runbook",
      body: "1. Pick songs 2. Share by Thursday",
      scope: "template",
    });
    const dutyId = (await asBob.mutation(api.responsibilities.create, {
      title: "Weekly setlist",
      assigneePersonIds: [cara],
    })) as Id<"responsibilities">;
    await asBob.mutation(api.responsibilities.update, {
      responsibilityId: dutyId,
      howToDocId: docId as Id<"docs">,
    });

    // Cara (held to the duty, no reports) can't rewrite the runbook…
    await expect(
      asCara.mutation(api.docs.update, {
        docId: docId as Id<"docs">,
        body: "just wing it",
      }),
    ).rejects.toThrow(ConvexError);
    // …but Bob still can, and Cara can still edit an UNLINKED doc of her own.
    await asBob.mutation(api.docs.update, {
      docId: docId as Id<"docs">,
      body: "1. Pick songs 2. Share by Wednesday",
    });
    const { _id: caraDoc } = await asCara.mutation(api.docs.create, {
      kind: "note",
      title: "My notes",
    });
    await asCara.mutation(api.docs.update, {
      docId: caraDoc as Id<"docs">,
      body: "mine",
    });
  });

  test("removing a person strips their direct assignments and 1:1 record", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const id = (await s.as.mutation(api.responsibilities.create, {
      title: "Flyers",
      assigneePersonIds: [cara],
    })) as Id<"responsibilities">;
    await asBob.mutation(api.checkIns.log, { personId: cara, type: "checkin" });

    await s.as.mutation(api.people.remove, { personId: cara });

    const [row] = await s.as.query(api.responsibilities.list);
    expect(row._id).toBe(id);
    expect(row.assigneePersonIds).toBeUndefined();
    const history = await asBob.query(api.checkIns.listForSubtree, {
      personId: bob,
    });
    expect(history!.entries).toHaveLength(0);
  });

  test("update patches and null clears; defaults apply", async () => {
    const s = await setupChapter(newT());
    const id = (await s.as.mutation(api.responsibilities.create, {
      title: "Weekly report",
    })) as Id<"responsibilities">;

    let [r] = await s.as.query(api.responsibilities.list);
    expect(r.cadence).toBe("ad_hoc"); // default

    await s.as.mutation(api.responsibilities.update, {
      responsibilityId: id,
      cadence: "weekly",
      // Legacy `howTo` text is accepted but never written to the row anymore.
      howTo: "Fill the template, post in #reports",
    });
    [r] = await s.as.query(api.responsibilities.list);
    expect(r.cadence).toBe("weekly");
    // `howTo` was dropped from the schema in Deploy C, so it's no longer a field
    // on the responsibilities return shape (the arg is still accepted + ignored).

    // Pointing at a How-To doc still works (the canonical path).
    const docId = await run(s.t, async (ctx) => {
      const person = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Doc author",
        status: "active",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("docs", {
        chapterId: s.chapterId,
        kind: "note",
        title: "Runbook",
        body: "Steps",
        shareId: `sh-${Date.now()}`,
        createdBy: person,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await s.as.mutation(api.responsibilities.update, {
      responsibilityId: id,
      howToDocId: docId,
    });
    [r] = await s.as.query(api.responsibilities.list);
    expect(r.howToDoc?.kind).toBe("note");
    expect(r.howToDoc?.body).toBe("Steps");
  });
});

/** Insert a bare-bones `seatDefs` row directly (the seat-mutations PR that
 *  would add a `create` mutation isn't in this branch's stack yet — seat defs
 *  are a global table, not chapter-scoped, so this doesn't need `s`'s chapter
 *  at all beyond reusing its `t`). */
async function insertSeat(
  s: ChapterSetup,
  opts: {
    slug: string;
    title: string;
    chart: "central" | "chapter";
    parentSlug?: string;
    maxHolders?: number;
    derived?: boolean;
  },
): Promise<Id<"seatDefs">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug: opts.slug,
      title: opts.title,
      chart: opts.chart,
      parentSlug: opts.parentSlug ?? "root",
      maxHolders: opts.maxHolders ?? 1,
      duties: [],
      capabilities: [],
      sortOrder: 0,
      ...(opts.derived !== undefined ? { derived: opts.derived } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** Insert a `seatAssignments` row directly (same reasoning as `insertSeat` —
 *  the assignment-mutations PR isn't in this branch's stack). */
async function insertSeatAssignment(
  s: ChapterSetup,
  seatDefId: Id<"seatDefs">,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
): Promise<Id<"seatAssignments">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

describe("responsibilities × seats", () => {
  test("appliesTo: chapter-chart seat resolves per-chapter, central-chart seat resolves at central scope", async () => {
    const s = await setupChapter(newT(), { chapterName: "New York" });
    const s2 = await setupChapter(s.t, {
      email: "leader2@publicworship.life",
      chapterName: "Austin",
    });

    const treasurerId = await insertSeat(s, {
      slug: "treasurer",
      title: "Treasurer",
      chart: "chapter",
    });
    const chairId = await insertSeat(s, {
      slug: "board_chair",
      title: "Board Chair",
      chart: "central",
    });

    const alice = (await s.as.mutation(api.people.create, {
      name: "Alice",
    })) as Id<"people">;
    const dave = (await s2.as.mutation(api.people.create, {
      name: "Dave",
    })) as Id<"people">;
    const bob = (await s.as.mutation(api.people.create, {
      name: "Bob",
    })) as Id<"people">;

    // Alice holds "treasurer" in NY, Dave holds the SAME seat def in Austin —
    // different scope rows for the shared chart shape. Bob holds the central
    // seat (scope "central").
    await insertSeatAssignment(s, treasurerId, s.chapterId, alice);
    await insertSeatAssignment(s, treasurerId, s2.chapterId, dave);
    await insertSeatAssignment(s, chairId, "central", bob);

    function seatsByPerson(
      rows: { personId: Id<"people">; seatDefId: Id<"seatDefs"> }[],
    ) {
      const map = new Map<Id<"people">, Id<"seatDefs">[]>();
      for (const r of rows) {
        map.set(r.personId, [...(map.get(r.personId) ?? []), r.seatDefId]);
      }
      return map;
    }

    // NY's own view: Alice's NY-scope treasurer + Bob's central seat resolve;
    // Dave's Austin-scope holding of the SAME seat def does NOT.
    const nySeats = seatsByPerson(
      await s.as.query(api.responsibilities.chapterSeatHoldings),
    );
    expect(nySeats.get(alice)).toEqual([treasurerId]);
    expect(nySeats.get(bob)).toEqual([chairId]);
    expect(nySeats.has(dave)).toBe(false);

    // Austin's own view: Dave's Austin-scope treasurer + the SAME Bob central
    // seat resolve; Alice's NY-scope holding does NOT.
    const austinSeats = seatsByPerson(
      await s2.as.query(api.responsibilities.chapterSeatHoldings),
    );
    expect(austinSeats.get(dave)).toEqual([treasurerId]);
    expect(austinSeats.get(bob)).toEqual([chairId]);
    expect(austinSeats.has(alice)).toBe(false);

    // The pure matching rule, fed each chapter's own resolved seatIds.
    const treasurerDuty = { assigneeSeatIds: [treasurerId] };
    expect(
      responsibilityAppliesTo(treasurerDuty, {
        _id: alice,
        seatIds: nySeats.get(alice),
      }),
    ).toBe(true);
    expect(
      responsibilityAppliesTo(treasurerDuty, {
        _id: dave,
        seatIds: nySeats.get(dave) ?? [],
      }),
    ).toBe(false); // Dave doesn't resolve in NY's holdings

    const chairDuty = { assigneeSeatIds: [chairId] };
    expect(
      responsibilityAppliesTo(chairDuty, {
        _id: bob,
        seatIds: austinSeats.get(bob),
      }),
    ).toBe(true); // central seat resolves the same from either chapter's view
  });

  test("legacy role fallback applies only until a duty is mapped to seats, and mapping clears the legacy strings", async () => {
    const s = await setupChapter(newT());
    const { alice } = await seedChain(s); // alice's role is "Director"

    const seatId = await insertSeat(s, {
      slug: "director_seat",
      title: "Director Seat",
      chart: "chapter",
    });

    const dutyId = (await s.as.mutation(api.responsibilities.create, {
      title: "Meet with directs",
      assigneeRoles: ["director"],
    })) as Id<"responsibilities">;

    let [row] = await s.as.query(api.responsibilities.list);
    // Before mapping: the legacy role string still fans out to Alice.
    expect(
      responsibilityAppliesTo(row, { _id: alice, role: "Director" }),
    ).toBe(true);

    // Map the duty to a seat — even one Alice doesn't (yet) hold.
    await s.as.mutation(api.responsibilities.update, {
      responsibilityId: dutyId,
      assigneeSeatIds: [seatId],
    });
    [row] = await s.as.query(api.responsibilities.list);
    expect(row.assigneeSeatIds).toEqual([seatId]);
    // The mapping mutation cleared the legacy strings…
    expect(row.assigneeRoles).toBeUndefined();
    // …so the (still-true) role match no longer applies: seats are
    // authoritative from here on, regardless of `person.role`.
    expect(
      responsibilityAppliesTo(row, { _id: alice, role: "Director", seatIds: [] }),
    ).toBe(false);

    // Once Alice actually holds the mapped seat, she fans out via the seat.
    await insertSeatAssignment(s, seatId, s.chapterId, alice);
    const holdings = await s.as.query(api.responsibilities.chapterSeatHoldings);
    const aliceSeatIds = holdings
      .filter((h) => h.personId === alice)
      .map((h) => h.seatDefId);
    expect(
      responsibilityAppliesTo(row, {
        _id: alice,
        role: "Director",
        seatIds: aliceSeatIds,
      }),
    ).toBe(true);
  });

  test("create drops legacy roles when seats are given from the start", async () => {
    const s = await setupChapter(newT());
    const seatId = await insertSeat(s, {
      slug: "x",
      title: "X",
      chart: "chapter",
    });

    await s.as.mutation(api.responsibilities.create, {
      title: "Fresh duty",
      assigneeSeatIds: [seatId],
      assigneeRoles: ["director"], // ignored — seats win from the start
    });
    const [row] = await s.as.query(api.responsibilities.list);
    expect(row.assigneeSeatIds).toEqual([seatId]);
    expect(row.assigneeRoles).toBeUndefined();
  });

  test("direct person assignment applies regardless of seats — untouched by the seats transition", async () => {
    const s = await setupChapter(newT());
    const cara = (await s.as.mutation(api.people.create, {
      name: "Cara",
    })) as Id<"people">;
    const seatId = await insertSeat(s, {
      slug: "some_seat",
      title: "Some Seat",
      chart: "chapter",
    });

    const dutyId = (await s.as.mutation(api.responsibilities.create, {
      title: "Special task",
      assigneeSeatIds: [seatId],
      assigneePersonIds: [cara],
    })) as Id<"responsibilities">;
    const [row] = await s.as.query(api.responsibilities.list);
    // Cara holds no seat, but the direct assignment still applies.
    expect(responsibilityAppliesTo(row, { _id: cara, seatIds: [] })).toBe(
      true,
    );

    // Targeted removeAssignee still only touches the direct assignment.
    await s.as.mutation(api.responsibilities.removeAssignee, {
      responsibilityId: dutyId,
      personId: cara,
    });
    const [row2] = await s.as.query(api.responsibilities.list);
    expect(row2.assigneePersonIds).toBeUndefined();
    expect(row2.assigneeSeatIds).toEqual([seatId]);
  });

  test("dutiesForSeat reaches ACROSS chapters for a CHAPTER-chart seat too — org-wide expectations, not scoped to the authoring chapter", async () => {
    const s = await setupChapter(newT());
    const s2 = await setupChapter(s.t, {
      email: "leader2@publicworship.life",
      chapterName: "Austin",
    });
    const seatId = await insertSeat(s, {
      slug: "y",
      title: "Y Seat",
      chart: "chapter",
    });

    // NY authors a duty mapped to a CHAPTER-chart seat def (Austin never
    // touches this duty at all — same shared seatDefId, different chapter).
    const dutyId = (await s.as.mutation(api.responsibilities.create, {
      title: "Do the thing",
      cadence: "weekly",
      assigneeSeatIds: [seatId],
    })) as Id<"responsibilities">;
    await s.as.mutation(api.responsibilities.create, {
      title: "Unrelated duty",
    });

    const result = await s.as.query(api.responsibilities.dutiesForSeat, {
      seatDefId: seatId,
    });
    expect(result).toEqual([
      { id: dutyId, title: "Do the thing", cadence: "weekly" },
    ]);

    // Owner decision: "the expectation... at one place is gonna be the same
    // for the expectation somewhere else." Austin never mapped anything to
    // this seat itself, but browsing the SAME (shared, global) seat def from
    // Austin's own chart still surfaces NY's duty — a seat-mapped duty is an
    // ORG-WIDE expectation, not scoped to whichever chapter authored it.
    expect(
      await s2.as.query(api.responsibilities.dutiesForSeat, {
        seatDefId: seatId,
      }),
    ).toEqual(result);
  });

  test("dutiesForSeat reaches ACROSS chapters for a CENTRAL seat — a chapter-A duty is visible browsing from chapter B", async () => {
    const s = await setupChapter(newT(), { chapterName: "New York" });
    const s2 = await setupChapter(s.t, {
      email: "leader2@publicworship.life",
      chapterName: "Austin",
    });
    const centralSeatId = await insertSeat(s, {
      slug: "board_chair",
      title: "Board Chair",
      chart: "central",
    });

    // Chapter A (NY) authors a duty mapped to the shared central seat.
    const dutyId = (await s.as.mutation(api.responsibilities.create, {
      title: "Chair the board meeting",
      cadence: "monthly",
      assigneeSeatIds: [centralSeatId],
    })) as Id<"responsibilities">;

    // Chapter B (Austin) never authored anything for this seat, but browsing
    // the SAME central seat from Austin's own chart still surfaces NY's duty
    // — central occupancy (and its duties) is chapter-independent.
    const fromAustin = await s2.as.query(api.responsibilities.dutiesForSeat, {
      seatDefId: centralSeatId,
    });
    expect(fromAustin).toEqual([
      { id: dutyId, title: "Chair the board meeting", cadence: "monthly" },
    ]);
    // …and it still resolves from NY's own view too.
    const fromNY = await s.as.query(api.responsibilities.dutiesForSeat, {
      seatDefId: centralSeatId,
    });
    expect(fromNY).toEqual(fromAustin);

    // This behavior is unchanged by the org-wide fix (central occupancy was
    // always chapter-independent) — a CHAPTER-chart seat now behaves the SAME
    // way, per the test above this one, rather than staying chapter-scoped.
  });

  test("addSeat / removeSeat edit one seat membership, race-safely — mirrors addAssignee/removeAssignee", async () => {
    const s = await setupChapter(newT());
    const seatA = await insertSeat(s, {
      slug: "seat-a",
      title: "Seat A",
      chart: "chapter",
    });
    const seatB = await insertSeat(s, {
      slug: "seat-b",
      title: "Seat B",
      chart: "chapter",
    });

    const id = (await s.as.mutation(api.responsibilities.create, {
      title: "Storage upkeep",
      assigneeRoles: ["director"], // legacy — should be cleared by addSeat
    })) as Id<"responsibilities">;
    const row = async () =>
      (await s.as.query(api.responsibilities.list)).find((r) => r._id === id)!;

    // Adding the FIRST seat is the mapping flow: clears legacy roles.
    await s.as.mutation(api.responsibilities.addSeat, {
      responsibilityId: id,
      seatDefId: seatA,
    });
    expect((await row()).assigneeSeatIds).toEqual([seatA]);
    expect((await row()).assigneeRoles).toBeUndefined();

    // Targeted add appends without rewriting the array; re-adding is a no-op.
    await s.as.mutation(api.responsibilities.addSeat, {
      responsibilityId: id,
      seatDefId: seatB,
    });
    await s.as.mutation(api.responsibilities.addSeat, {
      responsibilityId: id,
      seatDefId: seatB,
    });
    expect((await row()).assigneeSeatIds).toEqual([seatA, seatB]);

    // Targeted remove drops only the named seat.
    await s.as.mutation(api.responsibilities.removeSeat, {
      responsibilityId: id,
      seatDefId: seatA,
    });
    expect((await row()).assigneeSeatIds).toEqual([seatB]);

    // Removing the last seat clears the field entirely (not `[]`), and does
    // NOT resurrect the legacy roles — they're gone for good once mapped.
    await s.as.mutation(api.responsibilities.removeSeat, {
      responsibilityId: id,
      seatDefId: seatB,
    });
    expect((await row()).assigneeSeatIds).toBeUndefined();
    expect((await row()).assigneeRoles).toBeUndefined();

    // Both are manager/admin-gated like addAssignee/removeAssignee.
    const { cara } = await seedChain(s);
    const asCara = await addUser(s, "cara-seats@publicworship.life", {
      personId: cara,
    });
    await expect(
      asCara.mutation(api.responsibilities.addSeat, {
        responsibilityId: id,
        seatDefId: seatA,
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asCara.mutation(api.responsibilities.removeSeat, {
        responsibilityId: id,
        seatDefId: seatA,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("seatOptions lists every seat def, org-transparently", async () => {
    const s = await setupChapter(newT());
    const asVisitor = await addUser(s, "visitor@publicworship.life");
    const centralId = await insertSeat(s, {
      slug: "c1",
      title: "Central One",
      chart: "central",
    });
    const chapterId2 = await insertSeat(s, {
      slug: "ch1",
      title: "Chapter One",
      chart: "chapter",
    });

    const options = await s.as.query(api.responsibilities.seatOptions);
    expect(options).toEqual(
      expect.arrayContaining([
        { seatDefId: centralId, title: "Central One", chart: "central" },
        { seatDefId: chapterId2, title: "Chapter One", chart: "chapter" },
      ]),
    );
    // A signed-in account with no roster row gets nothing — same
    // read-transparency gate as `list`.
    expect(await asVisitor.query(api.responsibilities.seatOptions)).toEqual(
      [],
    );
  });

  test("seatOptions excludes DERIVED seats — a computed mirror can never be a duty target", async () => {
    const s = await setupChapter(newT());
    const realId = await insertSeat(s, {
      slug: "chapter_director",
      title: "Chapter Director",
      chart: "chapter",
    });
    const derivedId = await insertSeat(s, {
      slug: "chapter_directors",
      title: "Chapter Directors",
      chart: "central",
      derived: true,
    });

    const options = await s.as.query(api.responsibilities.seatOptions);
    expect(options.map((o) => o.seatDefId)).toContain(realId);
    expect(options.map((o) => o.seatDefId)).not.toContain(derivedId);

    // dutiesForSeat is guarded the same way — even a stale mapping to the
    // derived seat's id (pre-migration data) never surfaces there.
    await run(s.t, (ctx) =>
      ctx.db.insert("responsibilities", {
        chapterId: s.chapterId,
        title: "Stale derived-seat duty",
        cadence: "ad_hoc",
        assigneeSeatIds: [derivedId],
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(
      await s.as.query(api.responsibilities.dutiesForSeat, {
        seatDefId: derivedId,
      }),
    ).toEqual([]);
  });

  test("create/update/addSeat reject a DERIVED seat with a clear ConvexError", async () => {
    const s = await setupChapter(newT());
    const derivedId = await insertSeat(s, {
      slug: "chapter_directors",
      title: "Chapter Directors",
      chart: "central",
      derived: true,
    });

    await expect(
      s.as.mutation(api.responsibilities.create, {
        title: "Meet with directors",
        assigneeSeatIds: [derivedId],
      }),
    ).rejects.toThrow(ConvexError);

    const id = (await s.as.mutation(api.responsibilities.create, {
      title: "Meet with directors",
    })) as Id<"responsibilities">;
    await expect(
      s.as.mutation(api.responsibilities.update, {
        responsibilityId: id,
        assigneeSeatIds: [derivedId],
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.responsibilities.addSeat, {
        responsibilityId: id,
        seatDefId: derivedId,
      }),
    ).rejects.toThrow(ConvexError);

    // The row is untouched by the rejected attempts.
    const [row] = await s.as.query(api.responsibilities.list);
    expect(row.assigneeSeatIds).toBeUndefined();
  });

  test("a duty authored in chapter A mapped to chapter_director is visible via list/dutiesForSeat from chapter B AND applies to chapter B's director in their real workload data", async () => {
    const s = await setupChapter(newT(), { chapterName: "New York" });
    const s2 = await setupChapter(s.t, {
      email: "leader2@publicworship.life",
      chapterName: "Austin",
    });

    // One GLOBAL seatDefs row for "chapter_director" — same shape shared by
    // every chapter's chart, exactly like production seeding (0022).
    const chapterDirectorId = await insertSeat(s, {
      slug: "chapter_director",
      title: "Chapter Director",
      chart: "chapter",
    });

    const nyDirector = (await s.as.mutation(api.people.create, {
      name: "NY Director",
    })) as Id<"people">;
    const austinDirector = (await s2.as.mutation(api.people.create, {
      name: "Austin Director",
    })) as Id<"people">;
    const austinOther = (await s2.as.mutation(api.people.create, {
      name: "Austin Someone Else",
    })) as Id<"people">;

    await insertSeatAssignment(s, chapterDirectorId, s.chapterId, nyDirector);
    await insertSeatAssignment(
      s,
      chapterDirectorId,
      s2.chapterId,
      austinDirector,
    );

    // NY (chapter A) authors ONE duty mapped to the real (shared) seat def —
    // Austin (chapter B) never touches it.
    const dutyId = (await s.as.mutation(api.responsibilities.create, {
      title: "Run the chapter day-to-day",
      assigneeSeatIds: [chapterDirectorId],
    })) as Id<"responsibilities">;

    // REAL PATH #1 — dutiesForSeat: browsing the seat from EITHER chapter
    // surfaces NY's duty (two-chapter matrix, both directions).
    const nyDutiesForSeat = await s.as.query(api.responsibilities.dutiesForSeat, {
      seatDefId: chapterDirectorId,
    });
    const austinDutiesForSeat = await s2.as.query(
      api.responsibilities.dutiesForSeat,
      { seatDefId: chapterDirectorId },
    );
    expect(nyDutiesForSeat).toEqual([
      { id: dutyId, title: "Run the chapter day-to-day", cadence: "ad_hoc" },
    ]);
    expect(austinDutiesForSeat).toEqual(nyDutiesForSeat);

    // REAL PATH #2 — list: Austin's OWN duty catalog includes NY's
    // seat-mapped duty (owner decision: one role, same expectations
    // everywhere — the row's chapterId is authorship metadata, not a filter).
    const austinList = await s2.as.query(api.responsibilities.list);
    const austinRow = austinList.find((r) => r._id === dutyId)!;
    expect(austinRow).toBeDefined();
    expect(austinRow.chapterId).toBe(s.chapterId); // authorship stays NY's
    // `authoredByChapterName` is the Duties grid's read-only signal — set
    // (to the authoring chapter's name) from Austin's view, null from NY's.
    expect(austinRow.authoredByChapterName).toBe("New York");
    // …and it's still in NY's own list too (the matrix's other direction),
    // where it's the caller's OWN row — no provenance label needed.
    const nyList = await s.as.query(api.responsibilities.list);
    const nyRow = nyList.find((r) => r._id === dutyId);
    expect(nyRow).toBeDefined();
    expect(nyRow!.authoredByChapterName).toBeNull();

    // REAL PATH #3 — "applies in their workload data": the EXACT combination
    // WorkloadView does client-side (list + chapterSeatHoldings, fed through
    // the shared pure `responsibilityAppliesTo`), read from AUSTIN's own
    // queries only — no manually-constructed seat maps.
    const austinHoldings = await s2.as.query(
      api.responsibilities.chapterSeatHoldings,
    );
    const seatIdsFor = (personId: Id<"people">) =>
      austinHoldings.filter((h) => h.personId === personId).map((h) => h.seatDefId);
    expect(
      responsibilityAppliesTo(austinRow, {
        _id: austinDirector,
        seatIds: seatIdsFor(austinDirector),
      }),
    ).toBe(true);
    // Someone else in Austin who does NOT hold the seat is correctly excluded.
    expect(
      responsibilityAppliesTo(austinRow, {
        _id: austinOther,
        seatIds: seatIdsFor(austinOther),
      }),
    ).toBe(false);

    // Central-def behavior is UNCHANGED by this fix — already pinned by
    // "dutiesForSeat reaches ACROSS chapters for a CENTRAL seat" above,
    // which continues to pass unmodified (central occupancy was already
    // chapter-independent; only the chapter-chart case changed here).
  });
});

describe("check-ins", () => {
  test("managers log for their subtree; never on themselves or outside it", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });

    // Bob logs a full 1:1 about Cara (his report).
    await asBob.mutation(api.checkIns.log, {
      personId: cara,
      type: "checkin",
      responsibilities: [
        { title: "Create event flyers", fulfilling: true },
        {
          title: "Weekly setlist",
          fulfilling: false,
          action: "transfer_responsibility",
          note: "Moving to Austin next month",
        },
      ],
      personalUpdate: "New apartment — pray for the move",
      workloadScore: 8,
      workloadNote: "Two events in one week",
      interestScore: 9,
    });

    // Not on his boss, not on himself, and never without a 1-10 score.
    await expect(
      asBob.mutation(api.checkIns.log, { personId: alice, type: "checkin" }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asBob.mutation(api.checkIns.log, { personId: bob, type: "checkin" }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asBob.mutation(api.checkIns.log, {
        personId: cara,
        type: "checkin",
        workloadScore: 11,
      }),
    ).rejects.toThrow(ConvexError);

    // A user with no roster row can't log at all (admin included).
    await expect(
      s.as.mutation(api.checkIns.log, { personId: cara, type: "skip" }),
    ).rejects.toThrow(ConvexError);
  });

  test("history is readable exactly as far as the caller's reach", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    await asBob.mutation(api.checkIns.log, {
      personId: cara,
      type: "skip",
      notes: "Cara was at the retreat",
    });

    // Bob (the manager) sees it under his own subtree…
    const bobView = await asBob.query(api.checkIns.listForSubtree, {
      personId: bob,
    });
    expect(bobView!.entries).toHaveLength(1);
    expect(bobView!.entries[0].type).toBe("skip");
    expect(bobView!.entries[0].managerName).toBe("Bob");
    // …the admin sees it from the top…
    const adminView = await s.as.query(api.checkIns.listForSubtree, {
      personId: alice,
    });
    expect(adminView!.entries).toHaveLength(1);
    // …but Cara can't read up or across the chain…
    expect(
      await asCara.query(api.checkIns.listForSubtree, { personId: bob }),
    ).toBeNull();
    // …and the record ABOUT her is a managerial record: her own view of her
    // own subtree deliberately excludes it.
    const caraView = await asCara.query(api.checkIns.listForSubtree, {
      personId: cara,
    });
    expect(caraView!.entries).toHaveLength(0);
  });

  test("captures the project check and feedback alongside the duties", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bobp@publicworship.life", { personId: bob });
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "EP release",
      ownerPersonId: cara,
    })) as Id<"projects">;

    await asBob.mutation(api.checkIns.log, {
      personId: cara,
      type: "checkin",
      projects: [
        {
          projectId,
          name: "EP release",
          onTrack: false,
          note: "Mixing slipped a week",
        },
      ],
      feedbackWell: "Great artist communication",
      feedbackImprove: "Flag slips earlier",
      feedbackAboveBeyond: "Covered Sunday setup unasked",
    });

    const view = await asBob.query(api.checkIns.listForSubtree, {
      personId: bob,
    });
    const entry = view!.entries[0];
    expect(entry.projects![0]).toMatchObject({
      name: "EP release",
      onTrack: false,
      note: "Mixing slipped a week",
    });
    expect(entry.feedbackWell).toBe("Great artist communication");
    expect(entry.feedbackImprove).toBe("Flag slips earlier");
    expect(entry.feedbackAboveBeyond).toBe("Covered Sunday setup unasked");

    // Cross-chapter project references are rejected like responsibilities'.
    const s2 = await setupChapter(s.t, {
      email: "other2@publicworship.life",
      chapterName: "Austin",
    });
    const foreign = (await s2.as.mutation(api.projects.create, {
      name: "Foreign project",
    })) as Id<"projects">;
    await expect(
      asBob.mutation(api.checkIns.log, {
        personId: cara,
        type: "checkin",
        projects: [{ projectId: foreign, name: "Foreign", onTrack: true }],
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("historyForPerson returns the complete record to the chain above only", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    const asAliceUser = await addUser(s, "aliceh@publicworship.life", {
      personId: alice,
    });
    const asBob = await addUser(s, "bobh@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "carah@publicworship.life", {
      personId: cara,
    });

    // 12 entries — beyond the rollup's per-member cap of 10.
    for (let i = 0; i < 12; i++) {
      await asBob.mutation(api.checkIns.log, {
        personId: cara,
        type: i % 3 === 0 ? "skip" : "checkin",
        notes: `entry ${i}`,
      });
    }

    // The rollup stays capped…
    const rollup = await asBob.query(api.checkIns.listForSubtree, {
      personId: bob,
    });
    expect(rollup!.entries).toHaveLength(10);
    // …the history view returns everything, newest first.
    const full = await asBob.query(api.checkIns.historyForPerson, {
      personId: cara,
    });
    expect(full!.entries).toHaveLength(12);
    expect(full!.entries[0].notes).toBe("entry 11");
    // Alice (Bob's manager) reads it too — the whole chain above Cara.
    expect(
      (await asAliceUser.query(api.checkIns.historyForPerson, {
        personId: cara,
      }))!.entries,
    ).toHaveLength(12);
    // Cara never reads her own record; nor can she read up the chain.
    expect(
      await asCara.query(api.checkIns.historyForPerson, { personId: cara }),
    ).toBeNull();
    expect(
      await asCara.query(api.checkIns.historyForPerson, { personId: bob }),
    ).toBeNull();
    // The admin session reads anyone.
    expect(
      (await s.as.query(api.checkIns.historyForPerson, { personId: cara }))!
        .entries,
    ).toHaveLength(12);
  });

  test("only the author (or an admin) can delete a mis-logged entry", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    const checkInId = (await asBob.mutation(api.checkIns.log, {
      personId: cara,
      type: "checkin",
      personalUpdate: "Logged on the wrong person",
    })) as Id<"checkIns">;

    await expect(
      asCara.mutation(api.checkIns.remove, { checkInId }),
    ).rejects.toThrow(ConvexError);
    await asBob.mutation(api.checkIns.remove, { checkInId });
    const after = await asBob.query(api.checkIns.listForSubtree, {
      personId: bob,
    });
    expect(after!.entries).toHaveLength(0);
  });

  test("rejects garbage scores and cross-chapter responsibility references", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });

    for (const workloadScore of [Number.NaN, 7.5, 0, 11]) {
      await expect(
        asBob.mutation(api.checkIns.log, {
          personId: cara,
          type: "checkin",
          workloadScore,
        }),
      ).rejects.toThrow(ConvexError);
    }

    // A PERSON/ROLE-scoped responsibility id from ANOTHER chapter (no seats
    // — never travels) must not be storable.
    const s2 = await setupChapter(s.t, {
      email: "other@publicworship.life",
      chapterName: "Austin",
    });
    const foreign = (await s2.as.mutation(api.responsibilities.create, {
      title: "Foreign duty",
    })) as Id<"responsibilities">;
    await expect(
      asBob.mutation(api.checkIns.log, {
        personId: cara,
        type: "checkin",
        responsibilities: [
          { responsibilityId: foreign, title: "Foreign duty", fulfilling: true },
        ],
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a SEAT-MAPPED responsibility from ANOTHER chapter IS storable in a 1:1 — org-wide duties travel", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob-orgwide@publicworship.life", {
      personId: bob,
    });
    const s2 = await setupChapter(s.t, {
      email: "other-orgwide@publicworship.life",
      chapterName: "Austin",
    });
    const seatId = await insertSeat(s, {
      slug: "z",
      title: "Z Seat",
      chart: "chapter",
    });
    // Austin authors a duty mapped to a seat — this is the exact case
    // `responsibilities.list` now surfaces to Bob's chapter too.
    const orgWideDuty = (await s2.as.mutation(api.responsibilities.create, {
      title: "Org-wide duty",
      assigneeSeatIds: [seatId],
    })) as Id<"responsibilities">;

    const checkInId = await asBob.mutation(api.checkIns.log, {
      personId: cara,
      type: "checkin",
      responsibilities: [
        { responsibilityId: orgWideDuty, title: "Org-wide duty", fulfilling: true },
      ],
    });
    expect(checkInId).toBeDefined();

    // A responsibility id that doesn't exist at all is still rejected.
    await s2.as.mutation(api.responsibilities.remove, {
      responsibilityId: orgWideDuty,
    });
    await expect(
      asBob.mutation(api.checkIns.log, {
        personId: cara,
        type: "checkin",
        responsibilities: [
          {
            responsibilityId: orgWideDuty,
            title: "Org-wide duty",
            fulfilling: true,
          },
        ],
      }),
    ).rejects.toThrow(ConvexError);
  });
});
