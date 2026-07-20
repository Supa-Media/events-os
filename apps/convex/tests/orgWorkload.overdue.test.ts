/**
 * `api.org.workload`'s per-member `overdueTasks` — the person Work page's
 * "slacking on X for event Y" rows. Reuses the digest's own attribution
 * (owner cell → role holders → event-owner fallback) and overdue cut
 * (`reminders.ts#collectOverdueEventTasksByChapter`), so these scenarios
 * mirror `reminders.test.ts`'s event-item attribution cases but assert the
 * `workload` shape instead of the digest's recipient list.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { EventStatus } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Insert a roster person directly, with an email by default. The overdue
 * attribution's candidate fallback (owner/role-holder → event owner) is the
 * digest's own `reachable` rule reused as-is — an unreachable candidate
 * (no email, inactive, placeholder) routes the task to the event owner
 * instead, exactly like the digest. Seeding every test person with an
 * address keeps that fallback out of these scenarios' way; it's covered by
 * `reminders.test.ts` directly.
 */
async function addPerson(
  s: ChapterSetup,
  name: string,
  opts: { managerId?: Id<"people">; email?: string | null } = {},
) {
  const email =
    opts.email === null
      ? undefined
      : (opts.email ?? `${name.toLowerCase()}@pw.life`);
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      pwEmail: email,
      managerId: opts.managerId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** Insert an operational event directly (template plumbing is irrelevant here). */
async function addEvent(
  s: ChapterSetup,
  name: string,
  opts: {
    ownerPersonId?: Id<"people">;
    eventDate?: number;
    status?: EventStatus;
  } = {},
) {
  return await run(s.t, async (ctx) => {
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
      name,
      eventDate: opts.eventDate ?? Date.now() + 10 * DAY,
      status: opts.status ?? "planning",
      ownerPersonId: opts.ownerPersonId,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function addRole(s: ChapterSetup, eventId: Id<"events">, label: string) {
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventRoles", {
      eventId,
      key: label.toLowerCase().replace(/\s+/g, "_"),
      label,
      order: 0,
    }),
  );
}

async function assignRole(
  s: ChapterSetup,
  eventId: Id<"events">,
  roleId: Id<"eventRoles">,
  personId: Id<"people">,
) {
  await run(s.t, (ctx) =>
    ctx.db.insert("roleAssignments", {
      eventId,
      chapterId: s.chapterId,
      roleId,
      personId,
      createdAt: Date.now(),
    }),
  );
}

async function addItem(
  s: ChapterSetup,
  eventId: Id<"events">,
  title: string,
  opts: {
    ownerPersonId?: Id<"people">;
    roleId?: Id<"eventRoles">;
    module?: string;
    status?: string;
    dueDate?: number;
  } = {},
) {
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventItems", {
      eventId,
      chapterId: s.chapterId,
      module: opts.module ?? "comms",
      title,
      order: 0,
      status: opts.status,
      ownerPersonId: opts.ownerPersonId,
      roleId: opts.roleId,
      dueDate: opts.dueDate,
    }),
  );
}

/** A status column whose one "done"-like option is flagged `isComplete`. */
async function addStatusColumn(
  s: ChapterSetup,
  eventId: Id<"events">,
  module: string,
) {
  await run(s.t, (ctx) =>
    ctx.db.insert("eventColumns", {
      eventId,
      module,
      key: "status",
      label: "Status",
      kind: "system",
      type: "status",
      order: 0,
      options: [
        { value: "todo", label: "To do" },
        { value: "done", label: "Done", isComplete: true },
      ],
      isVisible: true,
    }),
  );
}

describe("org.workload overdue tasks", () => {
  test("owner-attributed overdue item lands on that member's events row", async () => {
    const s = await setupChapter(newT());
    const now = Date.now();
    const owner = await addPerson(s, "Owner");
    const eventId = await addEvent(s, "Eden July", { ownerPersonId: owner });
    const itemId = await addItem(s, eventId, "Post recap", {
      ownerPersonId: owner,
      dueDate: now - 2 * DAY,
    });

    const workload = await s.as.query(api.org.workload, { personId: owner });
    const member = workload!.members.find((m) => m._id === owner)!;
    expect(member.events).toHaveLength(1);
    expect(member.events[0].overdueTasks).toEqual([
      { itemId, title: "Post recap", module: "comms", dueDate: now - 2 * DAY },
    ]);
    // The role side stays empty — nobody holds a role here.
    expect(member.roles).toHaveLength(0);
  });

  test("role-attributed item (no owner cell) lands on the role holder's roles row", async () => {
    const s = await setupChapter(newT());
    const now = Date.now();
    const eventOwner = await addPerson(s, "Dami");
    const commsLead = await addPerson(s, "Charisma");
    const eventId = await addEvent(s, "Eden July", {
      ownerPersonId: eventOwner,
    });
    const roleId = await addRole(s, eventId, "Comms Lead");
    await assignRole(s, eventId, roleId, commsLead);
    const itemId = await addItem(s, eventId, "Post announcement", {
      roleId,
      dueDate: now - 2 * DAY,
    });

    const workload = await s.as.query(api.org.workload, {
      personId: commsLead,
    });
    const member = workload!.members.find((m) => m._id === commsLead)!;
    // Charisma doesn't own the event, so it's not in her `events` list.
    expect(member.events).toHaveLength(0);
    expect(member.roles).toHaveLength(1);
    expect(member.roles[0].overdueTasks).toEqual([
      {
        itemId,
        title: "Post announcement",
        module: "comms",
        dueDate: now - 2 * DAY,
      },
    ]);
  });

  test("complete-status and future-dated items are excluded", async () => {
    const s = await setupChapter(newT());
    const now = Date.now();
    const owner = await addPerson(s, "Owner");
    const eventId = await addEvent(s, "Eden July", { ownerPersonId: owner });
    await addStatusColumn(s, eventId, "comms");
    // Complete: status matches the column's isComplete option.
    await addItem(s, eventId, "Done already", {
      ownerPersonId: owner,
      status: "done",
      dueDate: now - 2 * DAY,
    });
    // Not yet due: dated in the future.
    await addItem(s, eventId, "Not due yet", {
      ownerPersonId: owner,
      status: "todo",
      dueDate: now + 5 * DAY,
    });
    // The control case: incomplete + overdue, so it SHOULD show up.
    const openItemId = await addItem(s, eventId, "Still open", {
      ownerPersonId: owner,
      status: "todo",
      dueDate: now - 2 * DAY,
    });

    const workload = await s.as.query(api.org.workload, { personId: owner });
    const member = workload!.members.find((m) => m._id === owner)!;
    expect(member.events[0].overdueTasks).toEqual([
      {
        itemId: openItemId,
        title: "Still open",
        module: "comms",
        dueDate: now - 2 * DAY,
      },
    ]);
  });

  test("dedupe: a member who both owns the event and holds a role on it never double-counts", async () => {
    const s = await setupChapter(newT());
    const now = Date.now();
    const owner = await addPerson(s, "Owner");
    const eventId = await addEvent(s, "Eden July", { ownerPersonId: owner });
    const roleId = await addRole(s, eventId, "Event Lead");
    await assignRole(s, eventId, roleId, owner);
    const itemId = await addItem(s, eventId, "Post recap", {
      ownerPersonId: owner,
      dueDate: now - 2 * DAY,
    });

    const workload = await s.as.query(api.org.workload, { personId: owner });
    const member = workload!.members.find((m) => m._id === owner)!;
    expect(member.events).toHaveLength(1);
    expect(member.events[0].overdueTasks.map((t) => t.itemId)).toEqual([
      itemId,
    ]);
    // The role row for the SAME event never repeats the task.
    expect(member.roles).toHaveLength(1);
    expect(member.roles[0].eventId).toBe(eventId);
    expect(member.roles[0].overdueTasks).toEqual([]);
  });

  test("untitled items render with a fallback title", async () => {
    const s = await setupChapter(newT());
    const now = Date.now();
    const owner = await addPerson(s, "Owner");
    const eventId = await addEvent(s, "Eden July", { ownerPersonId: owner });
    await addItem(s, eventId, "", {
      ownerPersonId: owner,
      dueDate: now - 2 * DAY,
    });

    const workload = await s.as.query(api.org.workload, { personId: owner });
    const member = workload!.members.find((m) => m._id === owner)!;
    expect(member.events[0].overdueTasks[0].title).toBe("(untitled)");
  });
});
