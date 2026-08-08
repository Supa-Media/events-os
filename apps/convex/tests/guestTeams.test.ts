import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Guest teams: the door splitting arriving guests into even teams.
 *
 * The balancing rule itself is unit-tested in
 * `packages/shared/src/guestTeams.test.ts`; these tests cover what only the
 * database can answer — that the assignment actually persists, survives a
 * re-scan unchanged, keeps the denormalized counter honest across resizes and
 * manual moves, and stays off for every event that never opted in.
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Field Day",
      slug: "field-day",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Field Day in the Park",
      eventDate: now + 7 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Door check-in access via the "assigned to this event" path. */
async function grantCheckInAccess(
  s: ChapterSetup,
  eventId: Id<"events">,
): Promise<void> {
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Door Volunteer",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const roleId = await ctx.db.insert("eventRoles", {
      eventId,
      key: "door",
      label: "Door",
      order: 0,
    });
    await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId: s.chapterId,
      roleId,
      personId,
      createdAt: Date.now(),
    });
  });
}

/** A published, ticket-selling page with one roomy free tier. */
async function setupTickets(s: ChapterSetup, eventId: Id<"events">) {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true, ticketsEnabled: true },
  });
  const freeId = (await s.as.mutation(api.ticketing.createTicketType, {
    eventId,
    name: "General Admission",
    priceCents: 0,
    capacity: 200,
  })) as Id<"ticketTypes">;
  return { pageId, slug: admin.page!.slug, freeId };
}

/** Buy `quantity` admissions on ONE order and return their codes. */
async function buyTickets(
  s: ChapterSetup,
  eventId: Id<"events">,
  slug: string,
  freeId: Id<"ticketTypes">,
  buyer: string,
  quantity = 1,
): Promise<string[]> {
  const prepared = await s.t.mutation(internal.ticketing.prepareOrder, {
    slug,
    name: buyer,
    email: `${buyer.toLowerCase().replace(/\W+/g, ".")}@example.com`,
    phone: "5551234567",
    items: [{ ticketTypeId: freeId, quantity }],
  });
  await s.t.mutation(internal.ticketing.fulfillOrder, {
    orderId: prepared.orderId,
  });
  const all = await s.as.query(api.ticketing.listTicketsAdmin, { eventId });
  return all
    .filter((t) => t.orderId === prepared.orderId)
    .map((t) => t.code);
}

/** Full setup: event, page, ticket tier, door access. */
async function seedDoor(s: ChapterSetup) {
  const eventId = await seedEvent(s);
  const { slug, freeId } = await setupTickets(s, eventId);
  await grantCheckInAccess(s, eventId);
  return { eventId, slug, freeId };
}

describe("configuring teams", () => {
  test("off by default — check-in assigns nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    const [code] = await buyTickets(s, eventId, slug, freeId, "Ada");

    const teams = await s.as.query(api.guestTeams.listForEvent, { eventId });
    expect(teams.enabled).toBe(false);
    expect(teams.teams).toHaveLength(0);

    const res = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code,
    });
    expect(res.result).toBe("ok");
    expect(res.result === "ok" && res.guestTeam).toBeNull();
  });

  test("switching on seeds ten color-named teams", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedDoor(s);

    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const { enabled, teams, maxTeams } = await s.as.query(
      api.guestTeams.listForEvent,
      { eventId },
    );
    expect(enabled).toBe(true);
    expect(maxTeams).toBe(20);
    expect(teams).toHaveLength(10);
    expect(teams.map((x) => x.name).slice(0, 3)).toEqual(["Red", "Blue", "Green"]);
    expect(teams.every((x) => x.isActive)).toBe(true);
    expect(teams.every((x) => x.assignedCount === 0)).toBe(true);
  });

  test("resizing caps at 20 and never renumbers a team's color", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });

    const grown = await s.as.mutation(api.guestTeams.setTeamCount, {
      eventId,
      count: 99,
    });
    expect(grown.count).toBe(20);

    const before = await s.as.query(api.guestTeams.listForEvent, { eventId });
    await s.as.mutation(api.guestTeams.setTeamCount, { eventId, count: 4 });
    const after = await s.as.query(api.guestTeams.listForEvent, { eventId });

    expect(after.teams.filter((x) => x.isActive)).toHaveLength(4);
    // Shrinking deactivates the tail; it does not delete or recolor anything.
    expect(after.teams).toHaveLength(20);
    expect(after.teams.map((x) => x.color)).toEqual(
      before.teams.map((x) => x.color),
    );
  });

  test("renaming sticks, keeps the color, and survives a shrink-and-regrow", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });

    const initial = await s.as.query(api.guestTeams.listForEvent, { eventId });
    const eighth = initial.teams[7];
    await s.as.mutation(api.guestTeams.renameTeam, {
      teamId: eighth._id,
      name: "  Dolphins  ",
    });

    await s.as.mutation(api.guestTeams.setTeamCount, { eventId, count: 4 });
    await s.as.mutation(api.guestTeams.setTeamCount, { eventId, count: 10 });

    const back = await s.as.query(api.guestTeams.listForEvent, { eventId });
    expect(back.teams[7].name).toBe("Dolphins");
    expect(back.teams[7].color).toBe(eighth.color);
    expect(back.teams.filter((x) => x.isActive)).toHaveLength(10);
  });

  test("a duplicate name is rejected — two teams can't both be 'Red' at a door", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const { teams } = await s.as.query(api.guestTeams.listForEvent, { eventId });

    await expect(
      s.as.mutation(api.guestTeams.renameTeam, {
        teamId: teams[1]._id,
        name: "  red  ", // case/whitespace-insensitive clash with team 0 "Red"
      }),
    ).rejects.toThrow();

    // Renaming a team to its OWN current name is a no-op, not a clash.
    await s.as.mutation(api.guestTeams.renameTeam, {
      teamId: teams[0]._id,
      name: "Red",
    });
  });

  test("an empty name is rejected rather than blanking the wristband", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const { teams } = await s.as.query(api.guestTeams.listForEvent, { eventId });

    await expect(
      s.as.mutation(api.guestTeams.renameTeam, {
        teamId: teams[0]._id,
        name: "   ",
      }),
    ).rejects.toThrow();
  });

  test("switching off keeps the teams and the guests already placed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const [code] = await buyTickets(s, eventId, slug, freeId, "Ada");
    await s.as.mutation(api.ticketing.checkInTicket, { eventId, code });

    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: false });
    const off = await s.as.query(api.guestTeams.listForEvent, { eventId });
    expect(off.enabled).toBe(false);
    expect(off.teams).toHaveLength(10);
    expect(off.teams.reduce((n, x) => n + x.assignedCount, 0)).toBe(1);

    // A guest admitted while it was on still reads as being on their team.
    const [attendee] = await s.as.query(api.ticketing.listCheckInAttendees, {
      eventId,
    });
    expect(attendee.teamName).not.toBeNull();
  });

  test("teams can't be configured without an RSVP page to hang them on", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await expect(
      s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true }),
    ).rejects.toThrow();
  });
});

describe("assignment at the door", () => {
  test("guests spread evenly and never differ by more than one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    await s.as.mutation(api.guestTeams.setTeamCount, { eventId, count: 5 });

    for (let i = 0; i < 23; i++) {
      const [code] = await buyTickets(s, eventId, slug, freeId, `Guest${i}`);
      await s.as.mutation(api.ticketing.checkInTicket, { eventId, code });
    }

    const { teams } = await s.as.query(api.guestTeams.listForEvent, { eventId });
    const counts = teams.filter((x) => x.isActive).map((x) => x.assignedCount);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(23);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  test("two tickets on ONE order go to different teams", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });

    const codes = await buyTickets(s, eventId, slug, freeId, "Pair Buyer", 2);
    expect(codes).toHaveLength(2);
    const first = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code: codes[0],
    });
    const second = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code: codes[1],
    });
    const a = first.result === "ok" ? first.guestTeam : null;
    const b = second.result === "ok" ? second.guestTeam : null;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.teamId).not.toBe(b!.teamId);
  });

  test("a re-scan returns the SAME team and doesn't double-count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const [code] = await buyTickets(s, eventId, slug, freeId, "Ada");

    const first = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code,
    });
    const again = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code,
    });
    expect(first.result).toBe("ok");
    expect(again.result).toBe("already");
    const assigned = first.result === "ok" ? first.guestTeam : null;
    const repeated = again.result === "already" ? again.guestTeam : null;
    expect(repeated!.teamId).toBe(assigned!.teamId);
    expect(repeated!.name).toBe(assigned!.name);

    const { teams } = await s.as.query(api.guestTeams.listForEvent, { eventId });
    expect(teams.reduce((n, x) => n + x.assignedCount, 0)).toBe(1);
  });

  test("turning teams on mid-shift places earlier arrivals on re-scan", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    const [code] = await buyTickets(s, eventId, slug, freeId, "Early Bird");

    // Admitted before anyone thought about teams.
    const before = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code,
    });
    expect(before.result === "ok" && before.guestTeam).toBeNull();

    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const rescan = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code,
    });
    expect(rescan.result).toBe("already");
    expect(rescan.result === "already" && rescan.guestTeam).not.toBeNull();
  });

  test("a voided ticket is never given a team", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const [code] = await buyTickets(s, eventId, slug, freeId, "Ada");
    const [ticket] = await s.as.query(api.ticketing.listTicketsAdmin, { eventId });
    await run(s.t, async (ctx) => {
      await ctx.db.patch(ticket._id, { status: "void" });
    });

    const res = await s.as.mutation(api.ticketing.checkInTicket, { eventId, code });
    expect(res.result).toBe("void");
    const { teams } = await s.as.query(api.guestTeams.listForEvent, { eventId });
    expect(teams.reduce((n, x) => n + x.assignedCount, 0)).toBe(0);
  });

  test("the door's guest list carries each guest's team", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const [code] = await buyTickets(s, eventId, slug, freeId, "Ada");
    const [pending] = await buyTickets(s, eventId, slug, freeId, "Bea");
    expect(pending).toBeTruthy();
    await s.as.mutation(api.ticketing.checkInTicket, { eventId, code });

    const list = await s.as.query(api.ticketing.listCheckInAttendees, { eventId });
    const ada = list.find((x) => x.attendeeName === "Ada")!;
    const bea = list.find((x) => x.attendeeName === "Bea")!;
    expect(ada.teamName).toBeTruthy();
    expect(ada.teamColor).toBeTruthy();
    // Not arrived yet — teams are handed out at the door, not sold.
    expect(bea.teamName).toBeNull();
  });
});

describe("manual override", () => {
  test("moving a guest adjusts both teams' counts", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const [code] = await buyTickets(s, eventId, slug, freeId, "Ada");
    const res = await s.as.mutation(api.ticketing.checkInTicket, { eventId, code });
    const from = res.result === "ok" ? res.guestTeam! : null;

    const { teams } = await s.as.query(api.guestTeams.listForEvent, { eventId });
    const target = teams.find((x) => x._id !== from!.teamId)!;
    const [ticket] = await s.as.query(api.ticketing.listTicketsAdmin, { eventId });

    await s.as.mutation(api.guestTeams.setTicketTeam, {
      ticketId: ticket._id,
      teamId: target._id,
    });

    const after = await s.as.query(api.guestTeams.listForEvent, { eventId });
    expect(after.teams.find((x) => x._id === from!.teamId)!.assignedCount).toBe(0);
    expect(after.teams.find((x) => x._id === target._id)!.assignedCount).toBe(1);
    expect(after.teams.reduce((n, x) => n + x.assignedCount, 0)).toBe(1);
  });

  test("clearing a guest's team frees the slot", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const [code] = await buyTickets(s, eventId, slug, freeId, "Ada");
    await s.as.mutation(api.ticketing.checkInTicket, { eventId, code });
    const [ticket] = await s.as.query(api.ticketing.listTicketsAdmin, { eventId });

    await s.as.mutation(api.guestTeams.setTicketTeam, {
      ticketId: ticket._id,
      teamId: null,
    });
    const after = await s.as.query(api.guestTeams.listForEvent, { eventId });
    expect(after.teams.reduce((n, x) => n + x.assignedCount, 0)).toBe(0);
  });

  test("a retired team is refused — nobody gets a colour the door stopped using", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, slug, freeId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });
    const before = await s.as.query(api.guestTeams.listForEvent, { eventId });
    const retired = before.teams[9];

    const [code] = await buyTickets(s, eventId, slug, freeId, "Ada");
    await s.as.mutation(api.ticketing.checkInTicket, { eventId, code });
    await s.as.mutation(api.guestTeams.setTeamCount, { eventId, count: 4 });
    const [ticket] = await s.as.query(api.ticketing.listTicketsAdmin, { eventId });

    await expect(
      s.as.mutation(api.guestTeams.setTicketTeam, {
        ticketId: ticket._id,
        teamId: retired._id,
      }),
    ).rejects.toThrow();
  });

  test("a team from another event is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const mine = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, {
      eventId: mine.eventId,
      enabled: true,
    });
    const other = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, {
      eventId: other.eventId,
      enabled: true,
    });

    const [code] = await buyTickets(s, mine.eventId, mine.slug, mine.freeId, "Ada");
    await s.as.mutation(api.ticketing.checkInTicket, {
      eventId: mine.eventId,
      code,
    });
    const [ticket] = await s.as.query(api.ticketing.listTicketsAdmin, {
      eventId: mine.eventId,
    });
    const foreign = await s.as.query(api.guestTeams.listForEvent, {
      eventId: other.eventId,
    });

    await expect(
      s.as.mutation(api.guestTeams.setTicketTeam, {
        ticketId: ticket._id,
        teamId: foreign.teams[0]._id,
      }),
    ).rejects.toThrow();
  });
});

describe("access", () => {
  test("a signed-out caller can neither read nor configure teams", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedDoor(s);
    await s.as.mutation(api.guestTeams.setEnabled, { eventId, enabled: true });

    await expect(
      t.query(api.guestTeams.listForEvent, { eventId }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.guestTeams.setTeamCount, { eventId, count: 4 }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.guestTeams.setEnabled, { eventId, enabled: false }),
    ).rejects.toThrow();
  });
});
