/**
 * Manager hierarchy + projects: the org tree stays acyclic, removals close
 * ranks instead of stranding subtrees/work, projects nest without cycles, and
 * `org.workload` rolls a manager's whole subtree (people, projects via
 * ownership, owned events) into one view.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/** Seed a 3-deep chain: alice ← bob ← cara (cara reports to bob, etc.). */
async function seedChain(s: ChapterSetup) {
  const alice = (await s.as.mutation(api.people.create, {
    name: "Alice",
    isTeamMember: true,
  })) as Id<"people">;
  const bob = (await s.as.mutation(api.people.create, {
    name: "Bob",
    isTeamMember: true,
    managerId: alice,
  })) as Id<"people">;
  const cara = (await s.as.mutation(api.people.create, {
    name: "Cara",
    isTeamMember: true,
    managerId: bob,
  })) as Id<"people">;
  return { alice, bob, cara };
}

describe("manager hierarchy", () => {
  test("create + update wire managerId; clearing works", async () => {
    const s = await setupChapter(newT());
    const { alice, bob } = await seedChain(s);

    const bobDoc = await s.as.query(api.people.get, { personId: bob });
    expect(bobDoc.managerId).toBe(alice);

    await s.as.mutation(api.people.update, { personId: bob, managerId: null });
    const cleared = await s.as.query(api.people.get, { personId: bob });
    expect(cleared.managerId).toBeUndefined();
  });

  test("rejects self-management and cycles through the chain", async () => {
    const s = await setupChapter(newT());
    const { alice, cara } = await seedChain(s);

    await expect(
      s.as.mutation(api.people.update, { personId: alice, managerId: alice }),
    ).rejects.toThrow(ConvexError);

    // alice ← bob ← cara, so making cara alice's manager closes a loop.
    await expect(
      s.as.mutation(api.people.update, { personId: alice, managerId: cara }),
    ).rejects.toThrow(ConvexError);
  });

  test("removing a manager re-points reports and orphans their projects", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    await s.as.mutation(api.projects.create, {
      name: "Bob's project",
      ownerPersonId: bob,
    });

    await s.as.mutation(api.people.remove, { personId: bob });

    // Cara now reports straight to Alice; the project survives unowned.
    const caraDoc = await s.as.query(api.people.get, { personId: cara });
    expect(caraDoc.managerId).toBe(alice);
    const projects = await s.as.query(api.projects.list);
    expect(projects).toHaveLength(1);
    expect(projects[0].ownerPersonId).toBeUndefined();
  });
});

describe("projects", () => {
  test("create defaults, update patches, null clears", async () => {
    const s = await setupChapter(newT());
    const id = (await s.as.mutation(api.projects.create, {
      name: "Music recording",
    })) as Id<"projects">;

    let [p] = await s.as.query(api.projects.list);
    expect(p.status).toBe("not_started");

    await s.as.mutation(api.projects.update, {
      projectId: id,
      status: "in_progress",
      statusNote: "Tracking week 2",
      deadline: 1770000000000,
      blocker: "Studio availability",
    });
    [p] = await s.as.query(api.projects.list);
    expect(p.status).toBe("in_progress");
    expect(p.statusNote).toBe("Tracking week 2");
    expect(p.blocker).toBe("Studio availability");

    await s.as.mutation(api.projects.update, {
      projectId: id,
      blocker: null,
    });
    [p] = await s.as.query(api.projects.list);
    expect(p.blocker).toBeUndefined();
    expect(p.statusNote).toBe("Tracking week 2"); // undefined = untouched
  });

  test("sub-projects nest but never cycle", async () => {
    const s = await setupChapter(newT());
    const parent = (await s.as.mutation(api.projects.create, {
      name: "Music recording",
    })) as Id<"projects">;
    const child = (await s.as.mutation(api.projects.create, {
      name: "Pitch to artists",
      parentProjectId: parent,
    })) as Id<"projects">;

    await expect(
      s.as.mutation(api.projects.update, {
        projectId: parent,
        parentProjectId: child,
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.projects.update, {
        projectId: parent,
        parentProjectId: parent,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("removing a project re-parents its children onto the grandparent", async () => {
    const s = await setupChapter(newT());
    const grand = (await s.as.mutation(api.projects.create, {
      name: "Grand",
    })) as Id<"projects">;
    const mid = (await s.as.mutation(api.projects.create, {
      name: "Mid",
      parentProjectId: grand,
    })) as Id<"projects">;
    const leaf = (await s.as.mutation(api.projects.create, {
      name: "Leaf",
      parentProjectId: mid,
    })) as Id<"projects">;

    await s.as.mutation(api.projects.remove, { projectId: mid });
    const projects = await s.as.query(api.projects.list);
    const leafDoc = projects.find((p) => p._id === leaf)!;
    expect(leafDoc.parentProjectId).toBe(grand);
    expect(projects).toHaveLength(2);
  });
});

describe("org.workload", () => {
  test("rolls up the whole subtree with owned events", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);

    // Bob owns an event (inserted directly — template plumbing is irrelevant here).
    await run(s.t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Eden",
        slug: "eden",
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Eden June",
        eventDate: 1770000000000,
        status: "planning",
        ownerPersonId: bob,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const workload = await s.as.query(api.org.workload, { personId: alice });
    expect(workload).not.toBeNull();
    expect(workload!.person.name).toBe("Alice");
    expect(workload!.manager).toBeNull();
    expect(workload!.reports.map((r) => r.name)).toEqual(["Bob"]);
    expect(workload!.reports[0].reportCount).toBe(1);

    const byName = new Map(workload!.members.map((m) => [m.name, m]));
    expect(workload!.members).toHaveLength(3);
    expect(byName.get("Alice")!.depth).toBe(0);
    expect(byName.get("Bob")!.depth).toBe(1);
    expect(byName.get("Cara")!.depth).toBe(2);
    expect(byName.get("Bob")!.events.map((e) => e.name)).toEqual(["Eden June"]);
    expect(byName.get("Cara")!.events).toHaveLength(0);

    // Mid-chain view: Bob's workload knows his manager and only his subtree.
    const bobView = await s.as.query(api.org.workload, { personId: bob });
    expect(bobView!.manager!.name).toBe("Alice");
    expect(bobView!.members.map((m) => m.name).sort()).toEqual(["Bob", "Cara"]);
  });

  test("returns null for people outside the caller's chapter", async () => {
    const t = newT();
    const s1 = await setupChapter(t);
    const s2 = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Austin",
    });
    const outsider = (await s2.as.mutation(api.people.create, {
      name: "Outsider",
    })) as Id<"people">;

    const workload = await s1.as.query(api.org.workload, {
      personId: outsider,
    });
    expect(workload).toBeNull();
  });
});
