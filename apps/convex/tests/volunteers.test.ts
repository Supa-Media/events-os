/**
 * The volunteer pipeline: the public hand-raise, the light triage, and the one
 * act with real consequences — putting someone on the roster.
 *
 * The rules worth pinning are the ones that keep the two pipelines honest:
 * a signup never touches the roster on its own, "on the roster" can only
 * become true by actually creating the person, and the service tags we write
 * are the ones the volunteer claimed rather than everything underneath them.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { VOLUNTEER_STAGES } from "@events-os/shared";
import { VOLUNTEER_SIGNUP_STAGES } from "../schema/volunteers";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

function signupArgs(overrides: Record<string, unknown> = {}) {
  return {
    name: "Dee Okafor",
    email: "Dee@Example.com",
    phone: "555-0142",
    location: "Harlem, NY",
    areas: ["setup", "welcome"],
    availability: "Weekends, and most weekday evenings",
    ...overrides,
  };
}

/** Put the caller on a central seat carrying the People desk's powers. */
async function seedPeopleSeat(
  s: ChapterSetup,
  capabilities: string[] = ["hiring.edit"],
): Promise<void> {
  const now = Date.now();
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Desk Holder",
      email: "desk@publicworship.life",
      userId: s.userId,
      createdAt: now,
    });
    const seatDefId = await ctx.db.insert("seatDefs", {
      slug: "test_people_seat",
      title: "Test People Seat",
      chart: "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: "central",
      personId,
      createdAt: now,
    });
  });
}

async function submit(
  t: ReturnType<typeof newT>,
  overrides: Record<string, unknown> = {},
): Promise<Id<"volunteerSignups">> {
  await t.mutation(api.volunteers.submitSignup, signupArgs(overrides));
  const rows = await run(t, (ctx) => ctx.db.query("volunteerSignups").collect());
  return rows[rows.length - 1]._id;
}

describe("volunteers — vocabulary", () => {
  test("the schema's inlined stages match the shared list", () => {
    expect([...VOLUNTEER_SIGNUP_STAGES]).toEqual([...VOLUNTEER_STAGES]);
  });
});

describe("volunteers — the hand-raise", () => {
  test("a signup lands as `new`, lowercased, and touches nothing else", async () => {
    const t = newT();
    const id = await submit(t);
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.stage).toBe("new");
    expect(row?.email).toBe("dee@example.com");
    expect(row?.personId).toBeUndefined();

    // The roster is untouched: a hand raised is not yet a volunteer.
    const people = await run(t, (ctx) => ctx.db.query("people").collect());
    expect(people).toHaveLength(0);
  });

  test("picking nothing is refused — but \"wherever you need me\" counts", async () => {
    const t = newT();
    await expect(
      t.mutation(api.volunteers.submitSignup, signupArgs({ areas: [] })),
    ).rejects.toThrow(/at least one thing/i);

    await t.mutation(api.volunteers.submitSignup, signupArgs({ areas: ["anywhere"] }));
    const rows = await run(t, (ctx) => ctx.db.query("volunteerSignups").collect());
    expect(rows).toHaveLength(1);
  });

  test("an unknown area is refused rather than stored", async () => {
    const t = newT();
    await expect(
      t.mutation(api.volunteers.submitSignup, signupArgs({ areas: ["pyrotechnics"] })),
    ).rejects.toThrow(/pyrotechnics/);
  });

  test("an address we can't reply to is refused", async () => {
    const t = newT();
    await expect(
      t.mutation(api.volunteers.submitSignup, signupArgs({ email: "nope" })),
    ).rejects.toThrow(/reply to/);
  });

  test("signing up twice updates the open row instead of opening a second", async () => {
    const t = newT();
    await submit(t);
    await submit(t, { areas: ["music"], availability: "Actually, Saturdays only" });
    const rows = await run(t, (ctx) => ctx.db.query("volunteerSignups").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].areas).toEqual(["music"]);
    expect(rows[0].availability).toBe("Actually, Saturdays only");
  });
});

describe("volunteers — the desk", () => {
  test("no People-desk power means no inbox", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await submit(t);
    await expect(s.as.query(api.volunteers.listSignups, {})).rejects.toThrow(
      /hiring desk/,
    );
  });

  test("\"on the roster\" can't be set by hand — it has to be made true", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPeopleSeat(s);
    const id = await submit(t);
    await expect(
      s.as.mutation(api.volunteers.setStage, { signupId: id, stage: "rostered" }),
    ).rejects.toThrow(/Add to roster/i);

    await s.as.mutation(api.volunteers.setStage, { signupId: id, stage: "contacted" });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.stage).toBe("contacted");
  });

  test("adding to the roster makes a real volunteer, tagged with what they claimed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPeopleSeat(s);
    const id = await submit(t, { areas: ["music"] });

    const personId = await s.as.mutation(api.volunteers.addToRoster, {
      signupId: id,
    });
    const person = await run(t, (ctx) => ctx.db.get(personId));
    expect(person?.isVolunteer).toBe(true);
    expect(person?.vettingStatus).toBe("unvetted");
    expect(person?.name).toBe("Dee Okafor");

    // Music & worship implies three PARENT services — and none of their
    // children. We know they ticked a box, not that they sing tenor.
    const services = await run(t, async (ctx) => {
      const rows = [];
      for (const sid of person?.serviceIds ?? []) rows.push(await ctx.db.get(sid));
      return rows.map((r) => r?.name).sort();
    });
    expect(services).toEqual(["Instruments", "Vocals", "Worship Leading"]);
    expect(
      await run(t, async (ctx) => {
        const all = await ctx.db.query("serviceOptions").collect();
        const ids = new Set((person?.serviceIds ?? []).map(String));
        return all.filter((o) => o.parentId && ids.has(String(o._id))).length;
      }),
    ).toBe(0);

    const signup = await run(t, (ctx) => ctx.db.get(id));
    expect(signup?.stage).toBe("rostered");
    expect(signup?.personId).toBe(personId);
  });

  test("someone already in the CRM is reused, not duplicated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPeopleSeat(s);
    const existingId = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Dee Okafor",
        email: "dee@example.com",
        // A guest row from an earlier event — the most common real case.
        isContactOnly: true,
        createdAt: Date.now(),
      }),
    );
    const id = await submit(t);
    const personId = await s.as.mutation(api.volunteers.addToRoster, {
      signupId: id,
    });
    expect(personId).toBe(existingId);

    const person = await run(t, (ctx) => ctx.db.get(existingId));
    expect(person?.isVolunteer).toBe(true);
    // No longer contact-only, or they'd stay invisible to the desk.
    expect(person?.isContactOnly).toBe(false);

    const named = await run(t, (ctx) =>
      ctx.db
        .query("people")
        .filter((q) => q.eq(q.field("email"), "dee@example.com"))
        .collect(),
    );
    expect(named).toHaveLength(1);
  });

  test("rostering the same signup twice is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPeopleSeat(s);
    const id = await submit(t);
    await s.as.mutation(api.volunteers.addToRoster, { signupId: id });
    await expect(
      s.as.mutation(api.volunteers.addToRoster, { signupId: id }),
    ).rejects.toThrow(/already on the roster/i);
  });

  test("the summary counts what nobody has answered", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPeopleSeat(s);
    const fresh = await submit(t);
    const stale = await submit(t, { email: "old@example.com" });
    await run(t, (ctx) =>
      ctx.db.patch(stale, { createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000 }),
    );

    const summary = await s.as.query(api.volunteers.signupSummary, {});
    expect(summary.open).toBe(2);
    expect(summary.unanswered).toBe(2);
    expect(summary.pastPromise).toBe(1);

    await s.as.mutation(api.volunteers.addToRoster, { signupId: fresh });
    const after = await s.as.query(api.volunteers.signupSummary, {});
    expect(after.open).toBe(1);
    expect(after.rostered).toBe(1);
  });
});
