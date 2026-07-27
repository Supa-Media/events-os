/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * People-CRM overhaul (2026-07-27) — `people.ts#listPaginated` (server-side
 * search/filter/sort, paginated) and `people.ts#counts` (the header's
 * persona-ladder counts, computed without the client holding the roster).
 *
 * `people.list` itself is UNCHANGED — see `peoplePersona.test.ts` /
 * `peopleContacts.test.ts` for its own safe-default regression coverage,
 * which this PR does not touch.
 */

async function seedPerson(
  s: ChapterSetup,
  fields: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

/** Insert a top-level service option (optionally a child of `parentId`). */
async function seedService(
  s: ChapterSetup,
  name: string,
  parentId?: Id<"serviceOptions">,
): Promise<Id<"serviceOptions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("serviceOptions", {
      name,
      parentId,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

/** First page, default sort/size — the common case most assertions need. */
async function firstPage(
  s: ChapterSetup,
  args: Partial<{
    search: string;
    persona: "team" | "vendor" | "volunteer" | "guest" | "contact";
    serviceIds: Id<"serviceOptions">[];
    status: Doc<"people">["status"];
    giversOnly: boolean;
    sortBy: "name" | "lastName" | "status";
    sortDir: "asc" | "desc";
  }> = {},
  numItems = 50,
) {
  return s.as.query(api.people.listPaginated, {
    paginationOpts: { numItems, cursor: null },
    ...args,
  });
}

describe("people.listPaginated — search", () => {
  test("matches name, email, and phone (digits-only)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const alice = await seedPerson(s, {
      name: "Alice Ontario",
      email: "alice@example.com",
      phone: "(212) 555-1234",
    });
    await seedPerson(s, { name: "Bob Someone", email: "bob@example.com" });

    const byName = await firstPage(s, { search: "ontario" });
    expect(byName.page.map((p) => p._id)).toEqual([alice]);

    const byEmail = await firstPage(s, { search: "alice@" });
    expect(byEmail.page.map((p) => p._id)).toEqual([alice]);

    const byPhone = await firstPage(s, { search: "2125551234" });
    expect(byPhone.page.map((p) => p._id)).toEqual([alice]);

    const noMatch = await firstPage(s, { search: "nobody-matches-this" });
    expect(noMatch.page).toHaveLength(0);
    expect(noMatch.isDone).toBe(true);
  });

  test("excludes placeholders and sample people", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Real Person" });
    await seedPerson(s, { name: "Stand-in", isPlaceholder: true });
    await seedPerson(s, { name: "Maya Sample", isSamplePerson: true });

    const page = await firstPage(s);
    expect(page.page.map((p) => p.name)).toEqual(["Real Person"]);
  });
});

describe("people.listPaginated — persona (per-page derivation)", () => {
  test("narrows to exactly the requested rung, using per-person signals", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Teammate", isTeamMember: true });
    await seedPerson(s, { name: "Paid Vendor", usualRateUsd: 150 });
    await seedPerson(s, { name: "Marked Volunteer", isVolunteer: true });
    await seedPerson(s, { name: "Bare Contact" });

    const team = await firstPage(s, { persona: "team" });
    expect(team.page.map((p) => p.name)).toEqual(["Teammate"]);

    const vendor = await firstPage(s, { persona: "vendor" });
    expect(vendor.page.map((p) => p.name)).toEqual(["Paid Vendor"]);

    const volunteer = await firstPage(s, { persona: "volunteer" });
    expect(volunteer.page.map((p) => p.name)).toEqual(["Marked Volunteer"]);

    const contact = await firstPage(s, { persona: "contact" });
    expect(contact.page.map((p) => p.name)).toEqual(["Bare Contact"]);

    // No `persona` arg at all — this query's own default is EVERYONE
    // (contacts included), unlike `people.list`'s conservative default.
    const everyone = await firstPage(s);
    expect(everyone.page).toHaveLength(4);
    for (const row of everyone.page) expect(row.persona).not.toBeNull();
  });

  test("a role assignment counts as a volunteer signal, read per-person (not a whole-chapter scan)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const eventTypeId = await run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Worship Night",
        slug: `worship-night-${now}`,
        version: 1,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const eventId = await run(s.t, (ctx) =>
      ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Event",
        eventDate: now + 1000,
        status: "planning",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const personId = await seedPerson(s, { name: "Role Holder" });
    const roleId = await run(s.t, (ctx) =>
      ctx.db.insert("eventRoles", {
        eventId,
        key: "usher",
        label: "Usher",
        order: 0,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("roleAssignments", {
        chapterId: s.chapterId,
        eventId,
        roleId,
        personId,
        createdAt: now,
      }),
    );

    const volunteers = await firstPage(s, { persona: "volunteer" });
    expect(volunteers.page.map((p) => p._id)).toEqual([personId]);
  });
});

describe("people.listPaginated — services (multi-select OR, parent includes children)", () => {
  test("selecting a parent matches everyone tagged with it OR any child", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const vocals = await seedService(s, "Vocals");
    const tenor = await seedService(s, "Tenor", vocals);
    const videography = await seedService(s, "Videography");

    const bareParent = await seedPerson(s, { name: "Bare Vocals", serviceIds: [vocals] });
    const childOnly = await seedPerson(s, { name: "Tenor Only", serviceIds: [tenor] });
    const unrelated = await seedPerson(s, { name: "Videographer", serviceIds: [videography] });
    await seedPerson(s, { name: "No Services" });

    const page = await firstPage(s, { serviceIds: [vocals] });
    expect(new Set(page.page.map((p) => p._id))).toEqual(new Set([bareParent, childOnly]));
    expect(page.page.map((p) => p._id)).not.toContain(unrelated);
  });

  test("multiple selected ids are OR'd together", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const keyboard = await seedService(s, "Keyboard");
    const videography = await seedService(s, "Videography");
    const drums = await seedService(s, "Drums");

    const keyboardist = await seedPerson(s, { name: "Keyboardist", serviceIds: [keyboard] });
    const videographer = await seedPerson(s, { name: "Videographer", serviceIds: [videography] });
    await seedPerson(s, { name: "Drummer", serviceIds: [drums] });

    const page = await firstPage(s, { serviceIds: [keyboard, videography] });
    expect(new Set(page.page.map((p) => p._id))).toEqual(new Set([keyboardist, videographer]));
  });
});

describe("people.listPaginated — status", () => {
  test("narrows to exactly the requested status", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Active One", status: "active" });
    await seedPerson(s, { name: "Inactive One", status: "inactive" });

    const page = await firstPage(s, { status: "active" });
    expect(page.page.map((p) => p.name)).toEqual(["Active One"]);
  });
});

describe("people.listPaginated — sort", () => {
  test("sorts by name asc/desc", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Charlie" });
    await seedPerson(s, { name: "Alice" });
    await seedPerson(s, { name: "Bob" });

    const asc = await firstPage(s, { sortBy: "name", sortDir: "asc" });
    expect(asc.page.map((p) => p.name)).toEqual(["Alice", "Bob", "Charlie"]);

    const desc = await firstPage(s, { sortBy: "name", sortDir: "desc" });
    expect(desc.page.map((p) => p.name)).toEqual(["Charlie", "Bob", "Alice"]);
  });

  test("sorts by status", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "P1", status: "unavailable" });
    await seedPerson(s, { name: "P2", status: "active" });

    const asc = await firstPage(s, { sortBy: "status", sortDir: "asc" });
    // "active" < "unavailable" lexicographically.
    expect(asc.page.map((p) => p.name)).toEqual(["P2", "P1"]);
  });
});

/** One `listPaginated` call, sorted by name asc — extracted to a plain named
 *  function (rather than inline in a `while` loop) so TS resolves the
 *  query's return type once per call instead of trying to unify it with a
 *  mutating loop variable. */
async function pageByName(s: ChapterSetup, cursor: string | null, numItems: number) {
  return s.as.query(api.people.listPaginated, {
    paginationOpts: { numItems, cursor },
    sortBy: "name",
    sortDir: "asc",
  });
}

describe("people.listPaginated — pagination correctness", () => {
  test("walking every page visits each person exactly once (no drops, no duplicates)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const names = Array.from({ length: 23 }, (_, i) => `Person ${String(i).padStart(2, "0")}`);
    for (const name of names) await seedPerson(s, { name });

    const seen: string[] = [];
    let cursor: string | null = null;
    let isDone = false;
    let loops = 0;
    while (!isDone && loops < 20) {
      const res = await pageByName(s, cursor, 5);
      for (const p of res.page) seen.push(p.name);
      isDone = res.isDone;
      cursor = res.continueCursor;
      loops++;
    }
    expect(seen).toHaveLength(names.length);
    expect(new Set(seen).size).toBe(names.length);
    expect(seen).toEqual([...names].sort());
  });

  test("a page shrunk by a filter still advances the cursor without dropping later matches", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Interleave matching/non-matching so a small raw batch is mostly filtered
    // away — exercises `listPaginated`'s internal re-walk loop.
    for (let i = 0; i < 12; i++) {
      await seedPerson(s, {
        name: `Person ${String(i).padStart(2, "0")}`,
        status: i % 4 === 0 ? "active" : "inactive",
      });
    }
    // numItems=3: a raw index batch of 3 people yields exactly ONE active
    // match (every 4th), so filling a 3-item page requires the internal
    // re-walk loop to pull three separate raw batches, not just the first.
    const page = await firstPage(s, { status: "active", sortBy: "name", sortDir: "asc" }, 3);
    expect(page.page).toHaveLength(3);
    expect(page.page.every((p) => p.status === "active")).toBe(true);
  });
});

describe("people.listPaginated — givers filter", () => {
  test("giversOnly narrows to linked donors who have actually given", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    // Seat the caller as development director (central giving.manage) so
    // `requireGivingView` passes — mirrors `donorPeople.test.ts`'s helper.
    await run(s.t, async (ctx) => {
      const seatPersonId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Seated Caller",
        userId: s.userId,
        createdAt: Date.now(),
      });
      const def = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "development_director"))
        .unique();
      if (!def) throw new Error("development_director not seeded");
      await ctx.db.insert("seatAssignments", {
        seatDefId: def._id,
        scope: "central",
        personId: seatPersonId,
        createdAt: Date.now(),
      });
    });

    const giverId = await seedPerson(s, { name: "Giver", email: "giver@example.com" });
    await seedPerson(s, { name: "Never Gave", email: "never@example.com" });

    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Giver",
      email: "giver@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 5000,
      method: "cash",
    });

    const page = await firstPage(s, { giversOnly: true });
    // "Seated Caller" (the dev-director seat person, no gift) must not appear.
    expect(page.page.map((p) => p._id)).toEqual([giverId]);
  });

  test("degrades to an empty result for a caller with no giving access, never throws", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Someone" });
    const page = await firstPage(s, { giversOnly: true });
    expect(page.page).toHaveLength(0);
  });
});

describe("people.counts", () => {
  test("agrees with a manual tally and never depends on `listPaginated`'s page size", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Teammate", isTeamMember: true });
    await seedPerson(s, { name: "Vendor", usualRateUsd: 100 });
    await seedPerson(s, { name: "Volunteer", isVolunteer: true });
    await seedPerson(s, { name: "Contact A" });
    await seedPerson(s, { name: "Contact B" });
    // Excluded from every count, same as `listPaginated`.
    await seedPerson(s, { name: "Placeholder", isPlaceholder: true });

    // `seedPerson` raw-inserts (bypasses the trigger-wrapped `people.create`
    // mutation), so the `peopleByPersona` Aggregate never learns about these
    // rows on its own — exactly the "direct DB write" drift scenario
    // `repairPersonaAggregate` (Guard 1, `people.ts`) exists to fix. Calling
    // it here is the realistic way to sync fixtures seeded like this, not a
    // workaround.
    await t.mutation(internal.people.repairPersonaAggregate, {});

    const counts = await s.as.query(api.people.counts, {});
    expect(counts).toEqual({
      all: 5,
      team: 1,
      vendor: 1,
      volunteer: 1,
      guest: 0,
      contact: 2,
    });

    // Cross-check against a full, unfiltered walk of `listPaginated`.
    const page = await firstPage(s, {}, 100);
    expect(page.page).toHaveLength(counts.all);
  });

  test("an approved caller with no chapter membership returns all-zero counts, not an error", async () => {
    const t = newT();
    // An access-approved (publicworship.life) user with no `userChapters` row
    // — `getChapterIdOrNull` degrades to null for this caller specifically;
    // a fully anonymous caller fails `requireAccess` before that check even
    // runs, which isn't the case this test is after.
    const userId = await run(t, (ctx) => ctx.db.insert("users", { email: "nochapter@publicworship.life" }));
    const as = t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
    const counts = await as.query(api.people.counts, {});
    expect(counts).toEqual({ all: 0, team: 0, vendor: 0, volunteer: 0, guest: 0, contact: 0 });
  });
});

describe("people.namesByChapter", () => {
  test("resolves a name for a person regardless of pagination — real people only", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerId = await seedPerson(s, { name: "The Manager" });
    await seedPerson(s, { name: "Placeholder", isPlaceholder: true });

    const names = await s.as.query(api.people.namesByChapter, {});
    expect(names).toEqual([{ _id: managerId, name: "The Manager" }]);
  });
});
