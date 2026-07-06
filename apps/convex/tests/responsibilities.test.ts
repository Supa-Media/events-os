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

  test("the list is the managers' catalog — members only receive their own duties", async () => {
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

    // Admins and managers (Bob has a report) read the whole catalog…
    expect((await s.as.query(api.responsibilities.list)).length).toBe(3);
    expect((await asBob.query(api.responsibilities.list)).length).toBe(3);
    // …Cara (no reports) receives ONLY what lands on her — not the org's
    // whole duty database…
    const caras = await asCara.query(api.responsibilities.list);
    expect(caras.map((r) => r.title)).toEqual(["Create event flyers"]);
    // …and a signed-in member with no roster row receives nothing.
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
      howTo: "Fill the template, post in #reports",
    });
    [r] = await s.as.query(api.responsibilities.list);
    expect(r.cadence).toBe("weekly");
    expect(r.howTo).toBe("Fill the template, post in #reports");

    await s.as.mutation(api.responsibilities.update, {
      responsibilityId: id,
      howTo: null,
    });
    [r] = await s.as.query(api.responsibilities.list);
    expect(r.howTo).toBeUndefined();
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

    // A responsibility id from ANOTHER chapter must not be storable.
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
});
