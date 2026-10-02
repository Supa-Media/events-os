import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * Goals (goals.ts, goalsEdit.ts, goalTeams.ts, goalsImport.ts,
 * projectGoals.ts):
 *  - the One Pager imports once into ordinary rows, matching chapters by name,
 *  - plan content is gated on the plan-edit resolver while updates are open
 *    to every member (lib/goalsAccess.ts),
 *  - automatic measures read the real record (a filled seat completes its
 *    key result with no update posted),
 *  - deleting a key result unlinks the projects that pointed at it.
 */

const ED = "seyi@publicworship.life"; // superuser: may edit plans and teams
const MEMBER = "member@publicworship.life";

async function signInAs(s: ChapterSetup, email: string) {
  const userId = await run(s.t, async (ctx) => {
    const id = await ctx.db.insert("users", { email });
    await ctx.db.insert("userChapters", {
      userId: id,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    });
    await ctx.db.insert("people", { chapterId: s.chapterId, name: "A Member", userId: id, createdAt: Date.now() });
    return id;
  });
  return s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

async function importedPlan() {
  const t = newT();
  const s = await setupChapter(t, { email: ED, chapterName: "New York" });
  const planId = await s.as.mutation(api.goalsImport.importOnePager, {});
  const plan = await s.as.query(api.goals.plan, { planId });
  if (!plan) throw new Error("plan missing");
  return { s, planId, plan };
}

describe("importing the 2027 One Pager", () => {
  test("creates the plan, its 5 objectives and 47 key results", async () => {
    const { plan } = await importedPlan();
    expect(plan.plan.year).toBe(2027);
    expect(plan.plan.status).toBe("active");
    expect(plan.objectives).toHaveLength(5);
    expect(plan.objectives.flatMap((o) => o.keyResults)).toHaveLength(47);
    expect(plan.objectives[1].keyResults[3].code).toBe("2.4");
    const funding = plan.targets.find((tg) => tg.unit === "usd");
    expect(funding?.children.map((c) => c.target)).toEqual([12000, 9000, 5000, 4000]);
  });

  test("creates the teams once and matches NYC to its chapter", async () => {
    const { s } = await importedPlan();
    const { teams } = await s.as.query(api.goals.teams, {});
    expect(teams).toHaveLength(10);
    const nyc = teams.find((tm) => tm.name === "NYC chapter");
    expect(nyc?.chapterId).toBe(s.chapterId);
    const fellowship = teams.find((tm) => tm.name === "Public Fellowship");
    expect(fellowship?.parentName).toBe("Central Events");
  });

  test("refuses a second import rather than overwrite edits", async () => {
    const { s } = await importedPlan();
    await expect(s.as.mutation(api.goalsImport.importOnePager, {})).rejects.toThrow(/already a 2027 plan/);
  });
});

describe("who may change what", () => {
  test("a member reads the plan and posts updates but can't edit content", async () => {
    const { s, planId, plan } = await importedPlan();
    const member = await signInAs(s, MEMBER);
    const overview = await member.query(api.goals.overview, {});
    expect(overview?.canEdit).toBe(false);
    expect(overview?.canUpdate).toBe(true);
    expect(await member.query(api.goals.plan, { planId })).not.toBeNull();

    const kr = plan.objectives[0].keyResults[2];
    await expect(
      member.mutation(api.goalsEdit.updateKeyResult, { keyResultId: kr._id, title: "Changed" }),
    ).rejects.toThrow(/Executive Director/);
    await expect(member.mutation(api.goalTeams.createTeam, { name: "Mine" })).rejects.toThrow();

    await member.mutation(api.goalsEdit.postUpdate, {
      keyResultId: kr._id,
      status: "at_risk",
      current: 1,
      note: "One lead found",
    });
    const after = await member.query(api.goals.plan, { planId });
    const row = after!.objectives[0].keyResults[2];
    expect(row.status).toBe("at_risk");
    expect(row.progress.current).toBe(1);
    const detail = await member.query(api.goals.keyResult, { keyResultId: kr._id });
    expect(detail?.updates[0].note).toBe("One lead found");
  });

  test("the plan editor can change anything, including moving and renumbering", async () => {
    const { s, planId, plan } = await importedPlan();
    const [first, second] = plan.objectives[0].keyResults;
    await s.as.mutation(api.goalsEdit.updateKeyResult, {
      keyResultId: first._id,
      title: "Recruit two recruiting associates.",
      target: 2,
      timing: null,
    });
    await s.as.mutation(api.goalsEdit.moveKeyResult, { keyResultId: second._id, direction: "up" });
    const after = await s.as.query(api.goals.plan, { planId });
    const krs = after!.objectives[0].keyResults;
    expect(krs[0]._id).toBe(second._id);
    expect(krs[1]).toMatchObject({ code: "1.2", title: "Recruit two recruiting associates.", target: 2 });
    expect(krs[1].timing).toBeUndefined();
  });
});

describe("progress from the real record", () => {
  test("filling the watched seat completes a seat key result", async () => {
    const { s, planId, plan } = await importedPlan();
    await run(s.t, (ctx) => runSeedSeatDefs(ctx));
    const kr = plan.objectives[0].keyResults[0]; // Recruit a recruiting associate.
    expect(kr.measureKind).toBe("seat_filled");

    await run(s.t, async (ctx) => {
      const def = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "recruiting_associate"))
        .unique();
      const personId = await ctx.db.insert("people", { chapterId: s.chapterId, name: "New hire", createdAt: Date.now() });
      await ctx.db.insert("seatAssignments", { seatDefId: def!._id, scope: "central", personId, createdAt: Date.now() });
    });
    const after = await s.as.query(api.goals.plan, { planId });
    const row = after!.objectives[0].keyResults[0];
    expect(row.status).toBe("not_started");
    expect(row.progress.displayStatus).toBe("done");
  });
});

describe("projects and key results", () => {
  test("a project links to one key result, and deleting the key result unlinks it", async () => {
    const { s, plan } = await importedPlan();
    const kr = plan.objectives[2].keyResults[0];
    const projectId: Id<"projects"> = await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Record the EP",
        status: "in_progress",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await s.as.mutation(api.projectGoals.setKeyResult, { projectId, keyResultId: kr._id });
    const detail = await s.as.query(api.goals.keyResult, { keyResultId: kr._id });
    expect(detail?.projects.map((p) => p.name)).toEqual(["Record the EP"]);

    await s.as.mutation(api.goalsEdit.deleteKeyResult, { keyResultId: kr._id });
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.keyResultId).toBeUndefined();
  });
});
