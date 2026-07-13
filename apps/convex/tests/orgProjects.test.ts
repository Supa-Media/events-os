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

/**
 * Add another signed-in user to the chapter (default role "member" — NOT an
 * admin) and optionally link them to a roster person, returning their client.
 */
async function addUser(
  s: ChapterSetup,
  email: string,
  opts: { role?: string; personId?: Id<"people"> } = {},
) {
  const userId = await run(s.t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: opts.role ?? "member",
      isActive: true,
      joinedAt: Date.now(),
    });
    if (opts.personId) await ctx.db.patch(opts.personId, { userId });
    return userId;
  });
  return s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

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

  test("removing a manager re-points reports and rolls projects up to their manager", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    await s.as.mutation(api.projects.create, {
      name: "Bob's project",
      ownerPersonId: bob,
    });

    await s.as.mutation(api.people.remove, { personId: bob });

    // Cara now reports straight to Alice; Bob's work rolls up to Alice so it
    // stays visible in her Team view instead of vanishing into admin triage.
    const caraDoc = await s.as.query(api.people.get, { personId: cara });
    expect(caraDoc.managerId).toBe(alice);
    const projects = await s.as.query(api.projects.list);
    expect(projects).toHaveLength(1);
    expect(projects[0].ownerPersonId).toBe(alice);
  });

  test("removing someone WITH reports is admin-only (it rewires the tree)", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob2@publicworship.life", { personId: bob });

    // Bob (non-admin) can't delete a manager — that re-points reports…
    await expect(
      asBob.mutation(api.people.remove, { personId: bob }),
    ).rejects.toThrow(ConvexError);
    // …but removing a leaf (no reports) stays open to everyone.
    await asBob.mutation(api.people.remove, { personId: cara });
  });
});

describe("projects", () => {
  test("create defaults, update patches, null clears", async () => {
    const s = await setupChapter(newT());
    // Link a roster person to the caller so status-note folding can author a
    // comment (see below).
    await run(s.t, async (ctx) => {
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        userId: s.userId,
        name: "Me",
        status: "active",
        isTeamMember: true,
        createdAt: Date.now(),
      });
    });
    const id = (await s.as.mutation(api.projects.create, {
      name: "Music recording",
    })) as Id<"projects">;

    let [p] = await s.as.query(api.projects.list);
    expect(p.status).toBe("not_started");

    await s.as.mutation(api.projects.update, {
      projectId: id,
      status: "in_progress",
      // Legacy one-slot `statusNote` is never stored on the project anymore —
      // it folds into the comment thread.
      statusNote: "Tracking week 2",
      deadline: 1770000000000,
      blocker: "Studio availability",
    });
    [p] = await s.as.query(api.projects.list);
    expect(p.status).toBe("in_progress");
    expect(p.statusNote).toBeUndefined();
    expect(p.lastComment?.body).toBe("Tracking week 2");
    expect(p.blocker).toBe("Studio availability");

    await s.as.mutation(api.projects.update, {
      projectId: id,
      blocker: null,
    });
    [p] = await s.as.query(api.projects.list);
    expect(p.blocker).toBeUndefined();
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

  test("is scoped to the caller's subtree (admins see anyone)", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    // Bob (manager, not admin): his subtree yes, his own manager no.
    expect(
      await asBob.query(api.org.workload, { personId: cara }),
    ).not.toBeNull();
    expect(await asBob.query(api.org.workload, { personId: alice })).toBeNull();

    // Cara (no reports): herself only.
    expect(
      await asCara.query(api.org.workload, { personId: cara }),
    ).not.toBeNull();
    expect(await asCara.query(api.org.workload, { personId: bob })).toBeNull();

    // The admin session sees anyone.
    expect(
      await s.as.query(api.org.workload, { personId: alice }),
    ).not.toBeNull();
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

describe("access control", () => {
  test("only admins may rewire the manager tree", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });

    await expect(
      asBob.mutation(api.people.update, { personId: cara, managerId: alice }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asBob.mutation(api.people.update, { personId: cara, managerId: null }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asBob.mutation(api.people.create, { name: "New hire", managerId: bob }),
    ).rejects.toThrow(ConvexError);

    // Non-manager fields stay editable by everyone.
    await asBob.mutation(api.people.update, { personId: cara, role: "Designer" });
    const caraDoc = await asBob.query(api.people.get, { personId: cara });
    expect(caraDoc.role).toBe("Designer");
    expect(caraDoc.managerId).toBe(bob);
  });

  test("overview: admins see the chapter, managers their subtree, others nothing", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    const adminView = await s.as.query(api.org.overview);
    expect(adminView.isAdmin).toBe(true);
    expect(adminView.canManage).toBe(true);
    expect(adminView.people).toHaveLength(3);

    const bobView = await asBob.query(api.org.overview);
    expect(bobView.isAdmin).toBe(false);
    expect(bobView.canManage).toBe(true);
    expect(bobView.selfPersonId).toBe(bob);
    expect(bobView.people.map((p) => p.name).sort()).toEqual(["Bob", "Cara"]);

    const caraView = await asCara.query(api.org.overview);
    expect(caraView.isAdmin).toBe(false);
    expect(caraView.canManage).toBe(false);
    expect(caraView.people).toHaveLength(0);
  });

  test("projects: visibility and mutations follow the subtree", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    const pAlice = (await s.as.mutation(api.projects.create, {
      name: "Alice's project",
      ownerPersonId: alice,
    })) as Id<"projects">;
    const pBob = (await s.as.mutation(api.projects.create, {
      name: "Bob's project",
      ownerPersonId: bob,
    })) as Id<"projects">;
    await s.as.mutation(api.projects.create, {
      name: "Cara's project",
      ownerPersonId: cara,
    });
    await s.as.mutation(api.projects.create, { name: "Unowned" });
    // An unowned sub-project inherits Bob's scope through its parent.
    const pSub = (await s.as.mutation(api.projects.create, {
      name: "Bob's sub",
      parentProjectId: pBob,
    })) as Id<"projects">;

    const names = async (client: typeof asBob) =>
      (await client.query(api.projects.list)).map((p) => p.name).sort();
    expect(await names(s.as as never)).toHaveLength(5); // admin: everything
    expect(await names(asBob)).toEqual([
      "Bob's project",
      "Bob's sub",
      "Cara's project",
    ]);
    expect(await names(asCara)).toEqual(["Cara's project"]);

    // Bob manages his subtree's work (incl. the unowned sub under his project)…
    await asBob.mutation(api.projects.update, {
      projectId: pSub,
      statusNote: "On track",
    });
    // …but not work outside it, and he can't hand work out of his subtree.
    await expect(
      asBob.mutation(api.projects.update, {
        projectId: pAlice,
        statusNote: "Nope",
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asBob.mutation(api.projects.create, {
        name: "For Alice",
        ownerPersonId: alice,
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asBob.mutation(api.projects.update, {
        projectId: pBob,
        ownerPersonId: alice,
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asBob.mutation(api.projects.remove, { projectId: pAlice }),
    ).rejects.toThrow(ConvexError);

    // Cara (no reports) still manages her own work.
    const caraProjects = await asCara.query(api.projects.list);
    await asCara.mutation(api.projects.update, {
      projectId: caraProjects[0]._id,
      status: "in_progress",
    });
  });
});

describe("review-cycle regressions", () => {
  test("non-admins can't graft projects into another team's tree", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    // Alice is Bob's MANAGER, i.e. above him — outside his manageable subtree.
    const pAlice = (await s.as.mutation(api.projects.create, {
      name: "Alice's project",
      ownerPersonId: alice,
    })) as Id<"projects">;
    const pBob = (await s.as.mutation(api.projects.create, {
      name: "Bob's project",
      ownerPersonId: bob,
    })) as Id<"projects">;

    // create: in-scope owner but foreign parent → rejected.
    await expect(
      asBob.mutation(api.projects.create, {
        name: "Injected",
        ownerPersonId: cara,
        parentProjectId: pAlice,
      }),
    ).rejects.toThrow(ConvexError);
    // update: re-parenting own project under a foreign tree → rejected.
    await expect(
      asBob.mutation(api.projects.update, {
        projectId: pBob,
        parentProjectId: pAlice,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("non-admins can't strand a root project by clearing its owner", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const root = (await s.as.mutation(api.projects.create, {
      name: "Root",
      ownerPersonId: bob,
    })) as Id<"projects">;
    const sub = (await s.as.mutation(api.projects.create, {
      name: "Sub",
      ownerPersonId: cara,
      parentProjectId: root,
    })) as Id<"projects">;

    // Clearing a ROOT's owner would push it into admin-only unowned land.
    await expect(
      asBob.mutation(api.projects.update, { projectId: root, ownerPersonId: null }),
    ).rejects.toThrow(ConvexError);
    // Clearing a SUB's owner is fine — it inherits Bob's scope via the parent.
    await asBob.mutation(api.projects.update, {
      projectId: sub,
      ownerPersonId: null,
    });
    // Admins can still make anything unowned.
    await s.as.mutation(api.projects.update, {
      projectId: root,
      ownerPersonId: null,
    });
  });

  test("deleting a project gives its unowned children an explicit owner", async () => {
    const s = await setupChapter(newT());
    const { bob } = await seedChain(s);
    const root = (await s.as.mutation(api.projects.create, {
      name: "Root",
      ownerPersonId: bob,
    })) as Id<"projects">;
    const sub = (await s.as.mutation(api.projects.create, {
      name: "Sub",
      parentProjectId: root, // no owner — inherits Bob through the parent
    })) as Id<"projects">;

    await s.as.mutation(api.projects.remove, { projectId: root });
    const projects = await s.as.query(api.projects.list);
    const subDoc = projects.find((p) => p._id === sub)!;
    // "Sub-projects are kept" — including their effective owner.
    expect(subDoc.ownerPersonId).toBe(bob);
    expect(subDoc.parentProjectId).toBeUndefined();
  });

  test("deleting an event unlinks projects that pointed at it", async () => {
    const s = await setupChapter(newT());
    const eventId = await run(s.t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Eden",
        slug: "eden",
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Eden June",
        eventDate: 1770000000000,
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Eden prep",
      eventId,
    })) as Id<"projects">;

    await s.as.mutation(api.events.remove, { eventId });
    const projects = await s.as.query(api.projects.list);
    const doc = projects.find((p) => p._id === projectId)!;
    expect(doc.eventId).toBeUndefined();
  });

  test("org.nav reports manage rights without a roster payload", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "cara@publicworship.life", {
      personId: cara,
    });

    expect(await s.as.query(api.org.nav)).toMatchObject({
      isAdmin: true,
      canManage: true,
    });
    expect(await asBob.query(api.org.nav)).toMatchObject({
      isAdmin: false,
      canManage: true,
      selfPersonId: bob,
    });
    expect(await asCara.query(api.org.nav)).toMatchObject({
      isAdmin: false,
      canManage: false,
    });
  });

  test("workload flags whether the caller may open the manager's page", async () => {
    const s = await setupChapter(newT());
    const { bob } = await seedChain(s);
    const asBob = await addUser(s, "bob@publicworship.life", { personId: bob });

    // Bob viewing himself: his boss exists but is out of his reach.
    const bobView = await asBob.query(api.org.workload, { personId: bob });
    expect(bobView!.manager!.name).toBe("Alice");
    expect(bobView!.manager!.viewable).toBe(false);
    // The admin can hop anywhere.
    const adminView = await s.as.query(api.org.workload, { personId: bob });
    expect(adminView!.manager!.viewable).toBe(true);
  });
});

describe("project comments", () => {
  test("the thread is the history: post, list, preview join, author-only delete", async () => {
    const s = await setupChapter(newT());
    const { bob, cara } = await seedChain(s);
    const asBob = await addUser(s, "bobc@publicworship.life", { personId: bob });
    const asCara = await addUser(s, "carac@publicworship.life", {
      personId: cara,
    });
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Music recording",
      ownerPersonId: cara,
    })) as Id<"projects">;

    // Cara (the owner) and Bob (her manager) both post updates.
    await asCara.mutation(api.projects.addComment, {
      projectId,
      body: "Tracking day 1 done",
    });
    const bobsComment = (await asBob.mutation(api.projects.addComment, {
      projectId,
      body: "Great — booking mixing next",
    })) as Id<"projectComments">;

    const thread = await asBob.query(api.projects.comments, { projectId });
    expect(thread!.map((c) => c.body)).toEqual([
      "Tracking day 1 done",
      "Great — booking mixing next",
    ]);
    expect(thread![0].authorName).toBe("Cara");

    // The list join surfaces the LATEST comment as the collapsed preview.
    const projects = await asBob.query(api.projects.list);
    const doc = projects.find((p) => p._id === projectId)!;
    expect(doc.lastComment?.body).toBe("Great — booking mixing next");
    expect(doc.lastComment?.authorName).toBe("Bob");

    // Cara can't delete Bob's comment; Bob (author) can. Empty posts rejected.
    await expect(
      asCara.mutation(api.projects.removeComment, { commentId: bobsComment }),
    ).rejects.toThrow(ConvexError);
    await asBob.mutation(api.projects.removeComment, { commentId: bobsComment });
    await expect(
      asCara.mutation(api.projects.addComment, { projectId, body: "   " }),
    ).rejects.toThrow(ConvexError);
  });

  test("commenting follows project scope; the thread dies with the project", async () => {
    const s = await setupChapter(newT());
    const { alice, bob, cara } = await seedChain(s);
    const asCara = await addUser(s, "carac@publicworship.life", {
      personId: cara,
    });
    const alicesProject = (await s.as.mutation(api.projects.create, {
      name: "Alice's project",
      ownerPersonId: alice,
    })) as Id<"projects">;

    // Cara can't comment on (or read) work outside her subtree — denial is
    // null, never mistakable for an empty thread.
    await expect(
      asCara.mutation(api.projects.addComment, {
        projectId: alicesProject,
        body: "drive-by",
      }),
    ).rejects.toThrow(ConvexError);
    expect(
      await asCara.query(api.projects.comments, { projectId: alicesProject }),
    ).toBeNull();

    // Deleting a project deletes its thread (no orphaned comments).
    const doomed = (await s.as.mutation(api.projects.create, {
      name: "Doomed",
      ownerPersonId: bob,
    })) as Id<"projects">;
    // The admin session has no roster row — commenting requires one.
    await expect(
      s.as.mutation(api.projects.addComment, { projectId: doomed, body: "x" }),
    ).rejects.toThrow(ConvexError);
    const asBob = await addUser(s, "bobc@publicworship.life", { personId: bob });
    await asBob.mutation(api.projects.addComment, {
      projectId: doomed,
      body: "final words",
    });
    await s.as.mutation(api.projects.remove, { projectId: doomed });
    const orphans = await run(s.t, (ctx) =>
      ctx.db
        .query("projectComments")
        .withIndex("by_project", (q) => q.eq("projectId", doomed))
        .collect(),
    );
    expect(orphans).toHaveLength(0);
  });
});
