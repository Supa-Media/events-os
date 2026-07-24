/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { PAST_EVENT_GRACE_MS } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Events + Projects peek — central team members can view any chapter's
 * events & projects, read-only (WP-S follow-up to #167/#168's app-wide
 * context switcher).
 *
 * `events.current`/`events.past` and `projects.list`/`projects.get` now take
 * an OPTIONAL `chapterId`: absent (or the caller's own chapter) is unchanged;
 * a DIFFERENT chapter requires central (org-wide) reach — the SAME check
 * `finances.dashboardChapter`'s central drill-down and
 * `financeRoles.listChaptersForPeek` use (`lib/centralReach.ts` reuses
 * `requireFinanceCentral` as-is — no new role concept). Mirrors
 * `financeCentralDrilldown.test.ts`'s authz test shape exactly.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** A chapter-only manager (person + manager grant, scope chapter). */
async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/**
 * A genuine central-scope finance manager: a PLAIN person (not the hardcoded
 * superuser email) holding a real `scope: "central"` financeRoles grant — the
 * actual mechanism real central admins use (distinct from the superuser
 * short-circuit `requireCentralReach` also allows).
 */
async function asCentralManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

async function seedEventType(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"eventTypes">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventTypes", {
      chapterId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${now}-${Math.random()}`,
      version: 1,
      isArchived: false,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedEvent(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  eventTypeId: Id<"eventTypes">,
  opts: { name: string; eventDate: number; status?: string },
): Promise<Id<"events">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name,
      eventDate: opts.eventDate,
      status: (opts.status ?? "planning") as never,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedProject(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"projects">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId,
      name,
      status: "in_progress" as never,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

// ── Events: current/past central peek authz ─────────────────────────────────

describe("events.current / events.past: central peek authz", () => {
  test("a central admin (superuser) CAN read a different chapter's current events", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const boston = await makeChapter(s, "Boston");
    const eventTypeId = await seedEventType(s, boston, "Service");
    await seedEvent(s, boston, eventTypeId, {
      name: "Boston Sunday Service",
      eventDate: Date.now() + 7 * DAY_MS,
    });

    const events = await s.as.query(api.events.current, { chapterId: boston });
    expect(events.map((e) => e.name)).toEqual(["Boston Sunday Service"]);
  });

  test("a PLAIN person with a genuine scope:\"central\" financeRoles grant CAN read a different chapter's past events (not the superuser short-circuit)", async () => {
    const t = newT();
    const s = await setupChapter(t); // default non-superuser email
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    const eventTypeId = await seedEventType(s, boston, "Service");
    await seedEvent(s, boston, eventTypeId, {
      name: "Boston Old Service",
      eventDate: Date.now() - (PAST_EVENT_GRACE_MS + 10 * DAY_MS),
    });

    const events = await s.as.query(api.events.past, { chapterId: boston });
    expect(events.map((e) => e.name)).toEqual(["Boston Old Service"]);
  });

  test("a chapter-scoped manager CANNOT read a different chapter's current events", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");

    await expect(
      s.as.query(api.events.current, { chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a chapter-scoped manager CANNOT read a different chapter's past events", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");

    await expect(
      s.as.query(api.events.past, { chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("passing the caller's OWN chapterId is unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedEventType(s, s.chapterId, "Service");
    await seedEvent(s, s.chapterId, eventTypeId, {
      name: "Home Event",
      eventDate: Date.now() + 7 * DAY_MS,
    });

    const events = await s.as.query(api.events.current, {
      chapterId: s.chapterId,
    });
    expect(events.map((e) => e.name)).toEqual(["Home Event"]);
  });

  test("no chapterId arg still resolves the caller's own chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedEventType(s, s.chapterId, "Service");
    await seedEvent(s, s.chapterId, eventTypeId, {
      name: "Home Event",
      eventDate: Date.now() + 7 * DAY_MS,
    });

    const events = await s.as.query(api.events.current, {});
    expect(events.map((e) => e.name)).toEqual(["Home Event"]);
  });

  test("a caller with no home chapter passing a foreign chapterId gets NO_CHAPTER, not a silent fallback to the target chapter's central-ness", async () => {
    const t = newT();
    const t2 = newT();
    // A user authenticated but with no userChapters membership at all.
    const userId = await run(t2, (ctx) =>
      ctx.db.insert("users", { email: "nobody@publicworship.life" }),
    );
    const as = t2.withIdentity({ subject: `${userId}|session`, issuer: "test" });
    const boston = await run(t2, (ctx) =>
      ctx.db.insert("chapters", { name: "Boston", isActive: true, createdAt: Date.now() }),
    );

    await expect(
      as.query(api.events.current, { chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("events.list: central peek authz", () => {
  test("a central admin (superuser) CAN read a different chapter's events", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const boston = await makeChapter(s, "Boston");
    const eventTypeId = await seedEventType(s, boston, "Service");
    await seedEvent(s, boston, eventTypeId, {
      name: "Boston Sunday Service",
      eventDate: Date.now() + 7 * DAY_MS,
    });

    const events = await s.as.query(api.events.list, {
      scope: "all",
      chapterId: boston,
    });
    expect(events.map((e) => e.name)).toEqual(["Boston Sunday Service"]);
  });

  test("a PLAIN person with a genuine scope:\"central\" financeRoles grant CAN read a different chapter's events (not the superuser short-circuit)", async () => {
    const t = newT();
    const s = await setupChapter(t); // default non-superuser email
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    const eventTypeId = await seedEventType(s, boston, "Service");
    await seedEvent(s, boston, eventTypeId, {
      name: "Boston Old Service",
      eventDate: Date.now() - (PAST_EVENT_GRACE_MS + 10 * DAY_MS),
    });

    const events = await s.as.query(api.events.list, {
      scope: "all",
      chapterId: boston,
    });
    expect(events.map((e) => e.name)).toEqual(["Boston Old Service"]);
  });

  test("a chapter-scoped manager CANNOT read a different chapter's events", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");

    await expect(
      s.as.query(api.events.list, { scope: "all", chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("passing the caller's OWN chapterId is unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedEventType(s, s.chapterId, "Service");
    await seedEvent(s, s.chapterId, eventTypeId, {
      name: "Home Event",
      eventDate: Date.now() + 7 * DAY_MS,
    });

    const events = await s.as.query(api.events.list, {
      scope: "all",
      chapterId: s.chapterId,
    });
    expect(events.map((e) => e.name)).toEqual(["Home Event"]);
  });

  test("no chapterId arg still resolves the caller's own chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedEventType(s, s.chapterId, "Service");
    await seedEvent(s, s.chapterId, eventTypeId, {
      name: "Home Event",
      eventDate: Date.now() + 7 * DAY_MS,
    });

    const events = await s.as.query(api.events.list, { scope: "all" });
    expect(events.map((e) => e.name)).toEqual(["Home Event"]);
  });

  test("a caller with no home chapter passing a foreign chapterId gets NO_CHAPTER, not a silent fallback to the target chapter's central-ness", async () => {
    const t2 = newT();
    // A user authenticated but with no userChapters membership at all.
    const userId = await run(t2, (ctx) =>
      ctx.db.insert("users", { email: "nobody@publicworship.life" }),
    );
    const as = t2.withIdentity({ subject: `${userId}|session`, issuer: "test" });
    const boston = await run(t2, (ctx) =>
      ctx.db.insert("chapters", { name: "Boston", isActive: true, createdAt: Date.now() }),
    );

    await expect(
      as.query(api.events.list, { scope: "all", chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── Projects: list/get central peek authz ───────────────────────────────────

describe("projects.list: central peek authz", () => {
  test("a central admin (superuser) CAN read a different chapter's projects", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const boston = await makeChapter(s, "Boston");
    await seedProject(s, boston, "Boston Choir Retreat");

    const projects = await s.as.query(api.projects.list, { chapterId: boston });
    expect(projects.map((p) => p.name)).toEqual(["Boston Choir Retreat"]);
  });

  test("a PLAIN person with a genuine scope:\"central\" financeRoles grant CAN read a different chapter's projects (not the superuser short-circuit)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    await seedProject(s, boston, "Boston Choir Retreat");

    const projects = await s.as.query(api.projects.list, { chapterId: boston });
    expect(projects.map((p) => p.name)).toEqual(["Boston Choir Retreat"]);
  });

  test("a chapter-scoped manager CANNOT read a different chapter's projects", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");
    await seedProject(s, boston, "Boston Choir Retreat");

    await expect(
      s.as.query(api.projects.list, { chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("passing the caller's OWN chapterId is unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedProject(s, s.chapterId, "Home Project");

    const projects = await s.as.query(api.projects.list, {
      chapterId: s.chapterId,
    });
    expect(projects.map((p) => p.name)).toEqual(["Home Project"]);
  });

  test("no chapterId arg still resolves the caller's own chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedProject(s, s.chapterId, "Home Project");

    const projects = await s.as.query(api.projects.list, {});
    expect(projects.map((p) => p.name)).toEqual(["Home Project"]);
  });

  test("a caller with no home chapter passing a foreign chapterId gets NO_CHAPTER", async () => {
    const t2 = newT();
    const userId = await run(t2, (ctx) =>
      ctx.db.insert("users", { email: "nobody@publicworship.life" }),
    );
    const as = t2.withIdentity({ subject: `${userId}|session`, issuer: "test" });
    const boston = await run(t2, (ctx) =>
      ctx.db.insert("chapters", { name: "Boston", isActive: true, createdAt: Date.now() }),
    );

    await expect(
      as.query(api.projects.list, { chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("projects.get: central peek authz", () => {
  test("a central admin (superuser) CAN read a project in a different chapter via chapterId", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const boston = await makeChapter(s, "Boston");
    const projectId = await seedProject(s, boston, "Boston Choir Retreat");

    const project = await s.as.query(api.projects.get, {
      projectId,
      chapterId: boston,
    });
    expect(project?.name).toBe("Boston Choir Retreat");
  });

  test("a PLAIN central-scope manager CAN read a project in a different chapter via chapterId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    const projectId = await seedProject(s, boston, "Boston Choir Retreat");

    const project = await s.as.query(api.projects.get, {
      projectId,
      chapterId: boston,
    });
    expect(project?.name).toBe("Boston Choir Retreat");
  });

  test("a chapter-scoped manager CANNOT read a project in a different chapter, even by passing its chapterId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");
    const projectId = await seedProject(s, boston, "Boston Choir Retreat");

    await expect(
      s.as.query(api.projects.get, { projectId, chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("omitting chapterId for a foreign project still quietly hides it (unchanged not-found behavior)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s); // central reach, but no chapterId arg passed
    const boston = await makeChapter(s, "Boston");
    const projectId = await seedProject(s, boston, "Boston Choir Retreat");

    const project = await s.as.query(api.projects.get, { projectId });
    expect(project).toBeNull();
  });

  test("the caller's OWN project (no chapterId arg) is unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, s.chapterId, "Home Project");

    const project = await s.as.query(api.projects.get, { projectId });
    expect(project?.name).toBe("Home Project");
  });
});
