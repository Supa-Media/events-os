/**
 * Reminders + email actions: the weekly-digest / due-soon collection pass
 * (who gets emailed about what, including the manager rollup of directs'
 * overdue work), the pure windowing helpers, the cadence gate that keeps
 * quarterly duties out of weekly 1:1s, project email-action tokens (mint /
 * reuse / act / expire), and the comment→owner notification scheduling.
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { responsibilityDueForReview } from "@events-os/shared";
import {
  partitionForDigest,
  partitionForDueSoon,
  type RecipientWork,
} from "../reminders";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

const DAY = 24 * 60 * 60 * 1000;

/** Insert a roster person directly (email optional). */
async function addPerson(
  s: ChapterSetup,
  name: string,
  opts: {
    email?: string;
    managerId?: Id<"people">;
    status?: "active" | "inactive";
    userId?: Id<"users">;
  } = {},
) {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      pwEmail: opts.email,
      managerId: opts.managerId,
      status: opts.status,
      userId: opts.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** Insert a project directly with the fields the collection pass reads. */
async function addProject(
  s: ChapterSetup,
  name: string,
  opts: {
    ownerPersonId?: Id<"people">;
    deadline?: number;
    status?: "not_started" | "in_progress" | "blocked" | "on_hold" | "done";
    parentProjectId?: Id<"projects">;
    purpose?: string;
    blocker?: string;
  } = {},
) {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name,
      status: opts.status ?? "in_progress",
      ownerPersonId: opts.ownerPersonId,
      parentProjectId: opts.parentProjectId,
      deadline: opts.deadline,
      purpose: opts.purpose,
      blocker: opts.blocker,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("responsibilityDueForReview", () => {
  const NOW = 1_800_000_000_000;
  test("never-reviewed and ad_hoc duties are always due", () => {
    expect(responsibilityDueForReview("quarterly", null, NOW)).toBe(true);
    expect(responsibilityDueForReview("weekly", undefined, NOW)).toBe(true);
    expect(responsibilityDueForReview("ad_hoc", NOW - DAY, NOW)).toBe(true);
  });
  test("recently reviewed slow-cadence duties are NOT due", () => {
    // Quarterly duty reviewed 3 weeks ago — the meeting-transcript case.
    expect(
      responsibilityDueForReview("quarterly", NOW - 21 * DAY, NOW),
    ).toBe(false);
    expect(responsibilityDueForReview("monthly", NOW - 10 * DAY, NOW)).toBe(
      false,
    );
  });
  test("due again once (most of) the cycle has passed", () => {
    expect(responsibilityDueForReview("weekly", NOW - 6 * DAY, NOW)).toBe(true);
    expect(responsibilityDueForReview("monthly", NOW - 29 * DAY, NOW)).toBe(
      true,
    );
    // Weekly reviewed 2 days ago: not yet.
    expect(responsibilityDueForReview("weekly", NOW - 2 * DAY, NOW)).toBe(
      false,
    );
  });
});

describe("window partitions", () => {
  const now = Date.UTC(2026, 6, 5, 18, 0); // Sun Jul 5 2026, 2pm ET
  const entry = (dueDate: number, name = "x") => ({
    kind: "project" as const,
    name,
    context: null,
    dueDate,
  });

  test("digest splits overdue vs due-this-week and sorts by date", () => {
    const { overdue, dueThisWeek } = partitionForDigest(
      [
        entry(now + 6 * DAY, "later"),
        entry(now - 2 * DAY, "late"),
        entry(now + 2 * DAY, "soon"),
        entry(now + 30 * DAY, "far-future"),
      ],
      now,
    );
    expect(overdue.map((e) => e.name)).toEqual(["late"]);
    expect(dueThisWeek.map((e) => e.name)).toEqual(["soon", "later"]);
  });

  test("due-soon buckets today vs tomorrow only", () => {
    const { dueToday, dueTomorrow } = partitionForDueSoon(
      [
        entry(now + 2 * 60 * 60 * 1000, "today"),
        entry(now + DAY, "tomorrow"),
        entry(now + 3 * DAY, "later"),
        entry(now - DAY, "yesterday"),
      ],
      now,
    );
    expect(dueToday.map((e) => e.name)).toEqual(["today"]);
    expect(dueTomorrow.map((e) => e.name)).toEqual(["tomorrow"]);
  });
});

describe("openWorkByRecipient", () => {
  test("collects open deadlined projects with detail, per owner", async () => {
    const s = await setupChapter(newT());
    const now = Date.now();
    const alice = await addPerson(s, "Alice", { email: "alice@pw.life" });
    await addProject(s, "Donor campaign", {
      ownerPersonId: alice,
      deadline: now + 2 * DAY,
      status: "in_progress",
      purpose: "Ask donors why they give",
      blocker: "Waiting on copy",
    });
    // Excluded: done, undated, and out-the-window projects.
    await addProject(s, "Finished", {
      ownerPersonId: alice,
      deadline: now + DAY,
      status: "done",
    });
    await addProject(s, "No deadline", { ownerPersonId: alice });
    await addProject(s, "Next quarter", {
      ownerPersonId: alice,
      deadline: now + 90 * DAY,
    });

    const recipients: RecipientWork[] = await s.t.query(
      internal.reminders.openWorkByRecipient,
      { now },
    );
    const r = recipients.find((x) => x.personId === alice);
    expect(r).toBeDefined();
    expect(r!.email).toBe("alice@pw.life");
    expect(r!.entries.map((e) => e.name)).toEqual(["Donor campaign"]);
    expect(r!.entries[0]).toMatchObject({
      kind: "project",
      status: "in_progress",
      purpose: "Ask donors why they give",
      blocker: "Waiting on copy",
    });
  });

  test("sub-projects charge their effective owner; manager sees directs' work", async () => {
    const s = await setupChapter(newT());
    const now = Date.now();
    const manager = await addPerson(s, "AJ", { email: "aj@pw.life" });
    const direct = await addPerson(s, "Kayla", {
      email: "kayla@pw.life",
      managerId: manager,
    });
    const parent = await addProject(s, "Newsletter", {
      ownerPersonId: direct,
      deadline: now - 3 * DAY, // overdue
    });
    // Unowned sub-project inherits the direct as effective owner.
    await addProject(s, "Write copy", {
      parentProjectId: parent,
      deadline: now + DAY,
    });

    const recipients: RecipientWork[] = await s.t.query(
      internal.reminders.openWorkByRecipient,
      { now },
    );
    const kayla = recipients.find((x) => x.personId === direct);
    expect(kayla!.entries.map((e) => e.name).sort()).toEqual([
      "Newsletter",
      "Write copy",
    ]);
    // The sub-project's card names its parent.
    expect(
      kayla!.entries.find((e) => e.name === "Write copy")!.context,
    ).toBe("Newsletter");

    // AJ has no own work but appears as a recipient because a direct does.
    const aj = recipients.find((x) => x.personId === manager);
    expect(aj).toBeDefined();
    expect(aj!.entries).toEqual([]);
    expect(aj!.directs).toHaveLength(1);
    expect(aj!.directs[0].name).toBe("Kayla");
    const overdue = partitionForDigest(aj!.directs[0].entries, now).overdue;
    expect(overdue.map((e) => e.name)).toEqual(["Newsletter"]);
  });

  test("skips people without email and inactive people", async () => {
    const s = await setupChapter(newT());
    const now = Date.now();
    const noEmail = await addPerson(s, "Ghost");
    const inactive = await addPerson(s, "Gone", {
      email: "gone@pw.life",
      status: "inactive",
    });
    for (const owner of [noEmail, inactive]) {
      await addProject(s, "Work", {
        ownerPersonId: owner,
        deadline: now + DAY,
      });
    }
    const recipients: RecipientWork[] = await s.t.query(
      internal.reminders.openWorkByRecipient,
      { now },
    );
    expect(recipients).toHaveLength(0);
  });
});

describe("project email-action tokens", () => {
  async function seed(s: ChapterSetup) {
    const alice = await addPerson(s, "Alice", { email: "alice@pw.life" });
    const project = await addProject(s, "Donor campaign", {
      ownerPersonId: alice,
      deadline: Date.now() + 2 * DAY,
      status: "in_progress",
    });
    return { alice, project };
  }

  test("mint → page data → act; the change lands and is logged", async () => {
    const s = await setupChapter(newT());
    const { alice, project } = await seed(s);
    const tokens: Record<string, string> = await s.t.mutation(
      internal.projectActions.mintProjectTokens,
      { personId: alice, projectIds: [project] },
    );
    const token = tokens[project];
    expect(token).toHaveLength(32);

    const page = await s.t.query(internal.projectActions.pageData, { token });
    expect(page!.project.name).toBe("Donor campaign");
    expect(page!.project.status).toBe("in_progress");
    expect(page!.personName).toBe("Alice");

    const result = await s.t.mutation(
      internal.projectActions.setStatusFromToken,
      { token, status: "done" },
    );
    expect(result).toMatchObject({ projectName: "Donor campaign", status: "done" });

    const updated = await run(s.t, (ctx) => ctx.db.get(project));
    expect(updated!.status).toBe("done");
    // The change is logged on the thread, attributed to the token's person.
    const comments = await run(s.t, (ctx) =>
      ctx.db
        .query("projectComments")
        .withIndex("by_project", (q) => q.eq("projectId", project))
        .collect(),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].authorPersonId).toBe(alice);
    expect(comments[0].body).toContain("Done");
  });

  test("re-minting reuses a still-fresh token", async () => {
    const s = await setupChapter(newT());
    const { alice, project } = await seed(s);
    const first: Record<string, string> = await s.t.mutation(
      internal.projectActions.mintProjectTokens,
      { personId: alice, projectIds: [project] },
    );
    const second: Record<string, string> = await s.t.mutation(
      internal.projectActions.mintProjectTokens,
      { personId: alice, projectIds: [project] },
    );
    expect(second[project]).toBe(first[project]);
  });

  test("expired tokens read as gone and cannot act", async () => {
    const s = await setupChapter(newT());
    const { alice, project } = await seed(s);
    const tokens: Record<string, string> = await s.t.mutation(
      internal.projectActions.mintProjectTokens,
      { personId: alice, projectIds: [project] },
    );
    const token = tokens[project];
    await run(s.t, async (ctx) => {
      const row = await ctx.db
        .query("projectEmailTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    expect(
      await s.t.query(internal.projectActions.pageData, { token }),
    ).toBeNull();
    expect(
      await s.t.mutation(internal.projectActions.setStatusFromToken, {
        token,
        status: "done",
      }),
    ).toBeNull();
    // The daily sweep removes the row.
    const purged: number = await s.t.mutation(
      internal.projectActions.purgeExpiredTokens,
      {},
    );
    expect(purged).toBe(1);
  });
});

describe("comment → owner notification", () => {
  test("commenting on someone else's project schedules an email to the owner", async () => {
    const s = await setupChapter(newT());
    // The signed-in admin's roster row (the comment author)…
    await addPerson(s, "AJ", { email: "aj@pw.life", userId: s.userId });
    // …and the project's owner, a different person with an email.
    const owner = await addPerson(s, "Kayla", { email: "kayla@pw.life" });
    const project = await addProject(s, "Donor campaign", {
      ownerPersonId: owner,
      deadline: Date.now() + DAY,
    });

    await s.as.mutation(api.projects.addComment, {
      projectId: project,
      body: "Please add an update",
    });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args[0]).toMatchObject({
      to: "kayla@pw.life",
      recipientName: "Kayla",
      projectName: "Donor campaign",
      authorName: "AJ",
      body: "Please add an update",
    });
  });

  test("commenting on your own project schedules nothing", async () => {
    const s = await setupChapter(newT());
    const self = await addPerson(s, "AJ", {
      email: "aj@pw.life",
      userId: s.userId,
    });
    const project = await addProject(s, "My project", {
      ownerPersonId: self,
      deadline: Date.now() + DAY,
    });
    await s.as.mutation(api.projects.addComment, {
      projectId: project,
      body: "note to self",
    });
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });
});
