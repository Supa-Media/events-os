import { describe, expect, test } from "vitest";
import { newT, run } from "./setup.helpers";
import { runPeopleAssociateAndOperationsTeam } from "../migrations/0096_people_associate_and_operations_team";

/**
 * 0096 — the Recruiting Associate seat becomes the People Associate, and the
 * People and Finance teams go under a new Operations team. Only old values are
 * replaced, so in-app edits survive.
 */
const now = Date.now();

async function seedSeat(t: ReturnType<typeof newT>, over: Record<string, unknown> = {}) {
  return await run(t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug: "recruiting_associate",
      title: "Recruiting Associate",
      chart: "central",
      parentSlug: "expansion_director",
      maxHolders: 50,
      duties: [],
      capabilities: ["hiring.edit"],
      sortOrder: 17,
      createdAt: now,
      updatedAt: now,
      ...over,
    } as never),
  );
}

async function seedTeam(t: ReturnType<typeof newT>, name: string, over: Record<string, unknown> = {}) {
  return await run(t, (ctx) =>
    ctx.db.insert("orgTeams", {
      name,
      seatSlugs: [],
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      ...over,
    } as never),
  );
}

describe("0096_people_associate_and_operations_team", () => {
  test("renames the seat and fills its duties, without moving it", async () => {
    const t = newT();
    const id = await seedSeat(t);

    await run(t, (ctx) => runPeopleAssociateAndOperationsTeam(ctx));

    const row = (await run(t, (ctx) => ctx.db.get(id as never))) as {
      title: string;
      duties: string[];
      parentSlug: string;
    };
    expect(row.title).toBe("People Associate");
    expect(row.parentSlug).toBe("expansion_director");
    expect(row.duties.join(" ")).toMatch(/monthly all-team meeting/);
    expect(row.duties.join(" ")).toMatch(/team hangs/);
  });

  test("leaves a seat an editor already changed alone", async () => {
    const t = newT();
    const id = await seedSeat(t, {
      title: "People & Culture Associate",
      duties: ["Their own duty"],
      parentSlug: "chapter_directors",
    });

    const res = await run(t, (ctx) => runPeopleAssociateAndOperationsTeam(ctx));

    expect(res.seatRows).toBe(0);
    const row = (await run(t, (ctx) => ctx.db.get(id as never))) as {
      title: string;
      duties: string[];
      parentSlug: string;
    };
    expect(row).toMatchObject({
      title: "People & Culture Associate",
      duties: ["Their own duty"],
      parentSlug: "chapter_directors",
    });
  });

  test("puts the People and Finance teams under a new Operations team, once", async () => {
    const t = newT();
    await seedSeat(t, { slug: "seat_ops_1", title: "Operations Director", parentSlug: "executive_director", maxHolders: 1, duties: [], capabilities: [] });
    const people = await seedTeam(t, "People team");
    const finance = await seedTeam(t, "Finance team", { sortOrder: 1 });

    await run(t, (ctx) => runPeopleAssociateAndOperationsTeam(ctx));
    const second = await run(t, (ctx) => runPeopleAssociateAndOperationsTeam(ctx));

    const teams = (await run(t, (ctx) => ctx.db.query("orgTeams").collect())) as {
      _id: string;
      name: string;
      parentTeamId?: string;
      leadSeatSlug?: string;
      description?: string;
    }[];
    const ops = teams.filter((x) => x.name === "Operations team");
    expect(ops).toHaveLength(1);
    expect(ops[0].leadSeatSlug).toBe("seat_ops_1");
    expect(ops[0].description).toMatch(/email/);
    expect(teams.find((x) => x._id === people)?.parentTeamId).toBe(ops[0]._id);
    expect(teams.find((x) => x._id === finance)?.parentTeamId).toBe(ops[0]._id);
    expect(teams.find((x) => x._id === people)?.description).toMatch(/team hangs/);
    expect(second.teamsChanged).toBe(0);
  });

  test("creates no teams on an org that never imported the plan", async () => {
    const t = newT();
    const res = await run(t, (ctx) => runPeopleAssociateAndOperationsTeam(ctx));
    expect(res.teamsChanged).toBe(0);
    expect(await run(t, (ctx) => ctx.db.query("orgTeams").collect())).toHaveLength(0);
  });
});
