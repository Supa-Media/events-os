/**
 * Phase 2 lobbies — the derived tier on `org.nav`, the volunteer `myBriefing`,
 * and the personal `work.myOpenWork`. Tier is short-circuit ordered
 * (admin → lead → member → volunteer); the two personal queries return an empty
 * shape / null for an unlinked caller and are scoped to just that person.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
} from "./setup.helpers";

const DAY = 24 * 60 * 60 * 1000;

/** Add a signed-in NON-admin user, optionally linked to a roster person. */
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
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    userId,
  };
}

/** Insert a roster person directly. */
async function addPerson(
  s: ChapterSetup,
  name: string,
  opts: {
    userId?: Id<"users">;
    isTeamMember?: boolean;
    role?: string;
    managerId?: Id<"people">;
  } = {},
) {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: opts.userId,
      isTeamMember: opts.isTeamMember,
      role: opts.role,
      managerId: opts.managerId,
      createdAt: Date.now(),
    }),
  );
}

/** Insert an event, returning its id. */
async function addEvent(
  s: ChapterSetup,
  opts: {
    name?: string;
    eventDate?: number;
    status?: "planning" | "ready" | "completed" | "cancelled";
    ownerPersonId?: Id<"people">;
    isTraining?: boolean;
  } = {},
) {
  const now = Date.now();
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Eden",
      slug: "eden",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "Eden July",
      eventDate: opts.eventDate ?? now + 10 * DAY,
      status: opts.status ?? "planning",
      ownerPersonId: opts.ownerPersonId,
      isTraining: opts.isTraining,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function addEngagement(
  s: ChapterSetup,
  eventId: Id<"events">,
  personId: Id<"people">,
  opts: { teams?: string[]; callTime?: string } = {},
) {
  return await run(s.t, (ctx) =>
    ctx.db.insert("engagements", {
      chapterId: s.chapterId,
      eventId,
      personId,
      type: "volunteer",
      status: "confirmed",
      teams: opts.teams,
      callTime: opts.callTime,
      createdAt: Date.now(),
    }),
  );
}

async function addRoleAssignment(
  s: ChapterSetup,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  return await run(s.t, async (ctx) => {
    const roleId = await ctx.db.insert("eventRoles", {
      eventId,
      key: "comms_lead",
      label: "Comms Lead",
      order: 0,
    });
    await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId: s.chapterId,
      roleId,
      personId,
      createdAt: Date.now(),
    });
    return roleId;
  });
}

async function addDuty(
  s: ChapterSetup,
  opts: { assigneePersonIds?: Id<"people">[]; assigneeRoles?: string[]; title?: string } = {},
) {
  return await run(s.t, (ctx) =>
    ctx.db.insert("responsibilities", {
      chapterId: s.chapterId,
      title: opts.title ?? "Set up chairs",
      cadence: "weekly",
      assigneePersonIds: opts.assigneePersonIds,
      assigneeRoles: opts.assigneeRoles,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("org.nav tier derivation", () => {
  test("chapter admin → admin", async () => {
    const s = await setupChapter(newT());
    const nav = await s.as.query(api.org.nav, {});
    expect(nav.tier).toBe("admin");
    expect(nav.tierReasons.length).toBeGreaterThan(0);
  });

  test("has direct reports → lead", async () => {
    const s = await setupChapter(newT());
    const boss = await addPerson(s, "Boss", { isTeamMember: true });
    await addPerson(s, "Report", { isTeamMember: true, managerId: boss });
    const { as } = await addUser(s, "boss@publicworship.life", {
      personId: boss,
    });
    const nav = await as.query(api.org.nav, {});
    expect(nav.tier).toBe("lead");
  });

  test("owns a duty (no reports) → lead", async () => {
    const s = await setupChapter(newT());
    const person = await addPerson(s, "Duty Owner", { isTeamMember: true });
    await addDuty(s, { assigneePersonIds: [person], title: "Lock the doors" });
    const { as } = await addUser(s, "duty@publicworship.life", {
      personId: person,
    });
    const nav = await as.query(api.org.nav, {});
    expect(nav.tier).toBe("lead");
    expect(nav.tierReasons[0]).toContain("Lock the doors");
  });

  test("core team member (no duty, no reports) → member", async () => {
    const s = await setupChapter(newT());
    const person = await addPerson(s, "Teammate", { isTeamMember: true });
    const { as } = await addUser(s, "team@publicworship.life", {
      personId: person,
    });
    const nav = await as.query(api.org.nav, {});
    expect(nav.tier).toBe("member");
  });

  test("holds an event role (not team member) → member", async () => {
    const s = await setupChapter(newT());
    const person = await addPerson(s, "Role Holder");
    const eventId = await addEvent(s);
    await addRoleAssignment(s, eventId, person);
    const { as } = await addUser(s, "role@publicworship.life", {
      personId: person,
    });
    const nav = await as.query(api.org.nav, {});
    expect(nav.tier).toBe("member");
  });

  test("only an engagement → volunteer", async () => {
    const s = await setupChapter(newT());
    const person = await addPerson(s, "Volunteer");
    const eventId = await addEvent(s);
    await addEngagement(s, eventId, person);
    const { as } = await addUser(s, "vol@publicworship.life", {
      personId: person,
    });
    const nav = await as.query(api.org.nav, {});
    expect(nav.tier).toBe("volunteer");
  });

  test("linked person with nothing → member (fallback)", async () => {
    const s = await setupChapter(newT());
    const person = await addPerson(s, "Blank");
    const { as } = await addUser(s, "blank@publicworship.life", {
      personId: person,
    });
    const nav = await as.query(api.org.nav, {});
    expect(nav.tier).toBe("member");
    expect(nav.tierReasons[0]).toContain("Default");
  });
});

describe("events.myBriefing", () => {
  test("unlinked caller → empty", async () => {
    const s = await setupChapter(newT());
    const { as } = await addUser(s, "nobody@publicworship.life");
    expect(await as.query(api.events.myBriefing, {})).toEqual({ events: [] });
  });

  test("returns upcoming operational events the caller is engaged on", async () => {
    const s = await setupChapter(newT());
    const person = await addPerson(s, "Vee");
    const upcoming = await addEvent(s, { name: "Sunday Service" });
    await addEngagement(s, upcoming, person, {
      teams: ["ushering"],
      callTime: "8:00 AM",
    });
    // Excluded: a past event, a cancelled event, a training sandbox.
    const past = await addEvent(s, {
      name: "Old",
      eventDate: Date.now() - 30 * DAY,
    });
    await addEngagement(s, past, person);
    const cancelled = await addEvent(s, { name: "Called off", status: "cancelled" });
    await addEngagement(s, cancelled, person);
    const training = await addEvent(s, { name: "Practice", isTraining: true });
    await addEngagement(s, training, person);

    const { as } = await addUser(s, "vee@publicworship.life", {
      personId: person,
    });
    const res = await as.query(api.events.myBriefing, {});
    expect(res.events.map((e) => e.name)).toEqual(["Sunday Service"]);
    expect(res.events[0]).toMatchObject({
      myTeams: ["ushering"],
      myCallTime: "8:00 AM",
      myStatus: "confirmed",
    });
    // Sanitized crew shape rides along.
    expect(res.events[0].crew.name).toBe("Sunday Service");
    expect(Array.isArray(res.events[0].crew.teams)).toBe(true);
  });
});

describe("work.myOpenWork", () => {
  test("unlinked caller → null", async () => {
    const s = await setupChapter(newT());
    const { as } = await addUser(s, "nobody2@publicworship.life");
    expect(await as.query(api.work.myOpenWork, {})).toBeNull();
  });

  test("scopes open work + events to the caller only", async () => {
    const s = await setupChapter(newT());
    const me = await addPerson(s, "Me", { isTeamMember: true });
    const other = await addPerson(s, "Other", { isTeamMember: true });
    const now = Date.now();

    // My overdue project, and someone else's due-this-week project.
    await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "My overdue",
        status: "in_progress",
        ownerPersonId: me,
        deadline: now - 3 * DAY,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Their work",
        status: "in_progress",
        ownerPersonId: other,
        deadline: now + 2 * DAY,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );

    // An event I own and an event I only hold a role on — both are "my events".
    const owned = await addEvent(s, { name: "Owned event", ownerPersonId: me });
    const roleEvent = await addEvent(s, { name: "Role event" });
    await addRoleAssignment(s, roleEvent, me);
    // An event owned by someone else that I have nothing to do with.
    await addEvent(s, { name: "Not mine", ownerPersonId: other });

    const { as } = await addUser(s, "me@publicworship.life", { personId: me });
    const res = await as.query(api.work.myOpenWork, {});
    expect(res).not.toBeNull();
    expect(res!.overdue.map((e) => e.name)).toEqual(["My overdue"]);
    expect(res!.dueThisWeek).toHaveLength(0);
    expect(res!.myEvents.map((e) => e.name).sort()).toEqual([
      "Owned event",
      "Role event",
    ]);
    void owned;
  });
});
