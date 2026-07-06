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
    expect(bobView).toHaveLength(1);
    expect(bobView![0].type).toBe("skip");
    expect(bobView![0].managerName).toBe("Bob");
    // …the admin sees it from the top…
    const adminView = await s.as.query(api.checkIns.listForSubtree, {
      personId: alice,
    });
    expect(adminView).toHaveLength(1);
    // …but Cara can't read up or across the chain.
    expect(
      await asCara.query(api.checkIns.listForSubtree, { personId: bob }),
    ).toBeNull();
    // Her own subtree (herself) shows her own history.
    const caraView = await asCara.query(api.checkIns.listForSubtree, {
      personId: cara,
    });
    expect(caraView).toHaveLength(1);
  });
});
