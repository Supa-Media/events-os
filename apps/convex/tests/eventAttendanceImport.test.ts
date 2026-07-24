import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Event attendance import (PR A): the guest-list bulk importer that only ever
 * writes `rsvps` rows for one event — never donors or gifts. Covers the
 * disposition matrix, the email→phone→name matching cascade (incl.
 * digits-normalized phone + name-only rows), distinct same-name inserts +
 * nameCollision reporting, idempotent re-runs, batched counter correctness,
 * the update path (counter shift + token/emailVerified preservation + note
 * merge), NO_PAGE gating, >100-row self-reschedule, that imported rows never
 * get a verification code, and that email-less imports are excluded from
 * email blasts without crashing.
 *
 * Person-centric audiences Phase 1: a NEW insert here also best-effort links
 * `rsvps.personId` via `lib/rsvpPeople.ts#linkRsvpToPerson` (see
 * `rsvpPeople.test.ts` for the helper's own match-order/gating coverage) —
 * an email/phone-bearing row gets matched or spawns a contact-only `people`
 * row; a name-only row (legal for THIS importer only) stays unlinked.
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Night",
      slug: "night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Import Night",
      eventDate: now + 7 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function setupPage() {
  const t = newT();
  const s = await setupChapter(t);
  const eventId = await seedEvent(s);
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  return { t, s, eventId, pageId };
}

function page(s: ChapterSetup, eventId: Id<"events">): Promise<Doc<"eventPages"> | null> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique(),
  );
}

function rsvps(s: ChapterSetup, eventId: Id<"events">): Promise<Doc<"rsvps">[]> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect(),
  );
}

// ── Preview dispositions ─────────────────────────────────────────────────────

describe("previewAttendanceImport", () => {
  test("disposition matrix: new / update / duplicate / invalid", async () => {
    const { s, eventId } = await setupPage();
    // Seed an existing going guest with an email + a phone.
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Ada Existing",
        email: "ada@example.com",
        phone: "5551234567",
        status: "going",
        token: "tok-ada",
        source: "rsvp",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const preview = await s.as.query(api.eventAttendanceImport.previewAttendanceImport, {
      eventId,
      rows: [
        { name: "Brand New", email: "new@example.com", status: "going" }, // new
        { name: "Ada Existing", email: "ada@example.com", status: "going" }, // duplicate (already going)
        { name: "Ada Existing", email: "ada@example.com", status: "maybe" }, // update (email match)
        { name: "", status: "going" }, // invalid
      ],
    });

    expect(preview.rows[0]).toMatchObject({ disposition: "new" });
    expect(preview.rows[1]).toMatchObject({ disposition: "duplicate", matchedBy: "email" });
    expect(preview.rows[2]).toMatchObject({ disposition: "update", matchedBy: "email" });
    expect(preview.rows[3]).toMatchObject({ disposition: "invalid" });
    expect(preview.summary).toMatchObject({
      newCount: 1,
      duplicateCount: 1,
      updateCount: 1,
      invalidCount: 1,
    });
  });

  test("cascade: phone (digits-normalized) matches, then name-only", async () => {
    const { s, eventId } = await setupPage();
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Phone Person",
        phone: "5551234567",
        status: "going",
        token: "tok-phone",
        source: "rsvp",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Named Guest",
        status: "going",
        token: "tok-name",
        source: "rsvp",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const preview = await s.as.query(api.eventAttendanceImport.previewAttendanceImport, {
      eventId,
      rows: [
        { name: "Totally Different", phone: "(555) 123-4567", status: "maybe" }, // phone match
        { name: "named guest", status: "maybe" }, // name match (normalized)
      ],
    });
    expect(preview.rows[0]).toMatchObject({ disposition: "update", matchedBy: "phone" });
    expect(preview.rows[1]).toMatchObject({ disposition: "update", matchedBy: "name" });
  });

  test("distinct same-name rows both insert; nameCollision reported", async () => {
    const { s, eventId } = await setupPage();
    const preview = await s.as.query(api.eventAttendanceImport.previewAttendanceImport, {
      eventId,
      rows: [
        { name: "John Smith", status: "going" },
        { name: "John Smith", status: "going" },
      ],
    });
    expect(preview.rows[0]).toMatchObject({ disposition: "new" });
    expect(preview.rows[1]).toMatchObject({ disposition: "new" });
    expect(preview.summary.newCount).toBe(2);
    expect(preview.summary.nameCollisions).toContain("john smith");
  });

  test("emaillessCount + NO_PAGE gating", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    // No page created yet → NO_PAGE.
    await expect(
      s.as.query(api.eventAttendanceImport.previewAttendanceImport, {
        eventId,
        rows: [{ name: "X" }],
      }),
    ).rejects.toThrow(ConvexError);

    await s.as.mutation(api.ticketing.createPage, { eventId });
    const preview = await s.as.query(api.eventAttendanceImport.previewAttendanceImport, {
      eventId,
      rows: [
        { name: "No Email One" },
        { name: "No Email Two", phone: "5550001111" },
        { name: "Has Email", email: "e@example.com" },
      ],
    });
    expect(preview.summary.emaillessCount).toBe(2);
  });
});

// ── Commit ───────────────────────────────────────────────────────────────────

describe("commitAttendanceImport", () => {
  test("inserts create rsvps with correct source/emailVerified/note; never donors", async () => {
    const { s, eventId } = await setupPage();
    const res = await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
      eventId,
      rows: [
        { name: "Ticket Buyer", email: "tb@example.com", wasTicketHolder: true, status: "going" },
        { name: "Plain Guest", status: "maybe" },
        { name: "Plus One", plusOneOf: "Ticket Buyer", status: "going" },
      ],
    });
    expect(res).toMatchObject({ inserted: 3, updated: 0, skippedDuplicates: 0 });

    const all = await rsvps(s, eventId);
    const tb = all.find((r) => r.name === "Ticket Buyer")!;
    expect(tb.source).toBe("ticket");
    expect(tb.emailVerified).toBe(true); // email present → trusted confirmed
    const plain = all.find((r) => r.name === "Plain Guest")!;
    expect(plain.source).toBe("rsvp");
    expect(plain.emailVerified).toBeUndefined(); // name-only → legacy
    expect(plain.email).toBeUndefined();
    const plus = all.find((r) => r.name === "Plus One")!;
    expect(plus.note).toContain("+1 of Ticket Buyer");

    // Never creates donors. Person-centric audiences Phase 1: an email/phone
    // row DOES best-effort link/create a contact-only `people` row now — only
    // "Ticket Buyer" qualifies (the other two rows are name-only, no
    // identifier to match or create from — see `hasPersonIdentifier`).
    const people = await run(s.t, (ctx) => ctx.db.query("people").collect());
    const donors = await run(s.t, (ctx) => ctx.db.query("donors").collect());
    expect(people).toHaveLength(1);
    expect(people[0].name).toBe("Ticket Buyer");
    expect(people[0].isContactOnly).toBe(true);
    expect(tb.personId).toBe(people[0]._id);
    expect(plain.personId).toBeUndefined();
    expect(plus.personId).toBeUndefined();
    expect(donors).toHaveLength(0);
  });

  test("counters batch correctly vs per-row expectation", async () => {
    const { s, eventId } = await setupPage();
    await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
      eventId,
      rows: [
        { name: "G1", status: "going" },
        { name: "G2", status: "going" },
        { name: "M1", status: "maybe" },
        { name: "N1", status: "not_going" },
      ],
    });
    const p = await page(s, eventId);
    expect(p).toMatchObject({ goingCount: 2, maybeCount: 1, notGoingCount: 1 });
  });

  test("update path shifts counters, preserves token + emailVerified, merges note", async () => {
    const { s, eventId } = await setupPage();
    const rsvpId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Verified Guest",
        email: "vg@example.com",
        status: "going",
        token: "tok-keepme",
        source: "rsvp",
        emailVerified: true,
        note: "original",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    // Seed the page's going counter to reflect the existing guest.
    await run(s.t, async (ctx) => {
      const p = await ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .unique();
      await ctx.db.patch(p!._id, { goingCount: 1 });
    });

    await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
      eventId,
      rows: [{ name: "Verified Guest", email: "vg@example.com", status: "maybe", note: "extra" }],
    });

    const row = await run(s.t, (ctx) => ctx.db.get(rsvpId));
    expect(row!.status).toBe("maybe");
    expect(row!.token).toBe("tok-keepme"); // never touched
    expect(row!.emailVerified).toBe(true); // never downgraded
    expect(row!.note).toContain("original");
    expect(row!.note).toContain("extra");
    const p = await page(s, eventId);
    expect(p).toMatchObject({ goingCount: 0, maybeCount: 1 });
  });

  test("full re-run is idempotent (zero deltas the second time)", async () => {
    const { s, eventId } = await setupPage();
    const rows = [
      { name: "Alice", email: "alice@example.com", status: "going" as const },
      { name: "Bob", phone: "5559990000", status: "maybe" as const },
      { name: "Carol", status: "going" as const },
    ];
    const first = await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
      eventId,
      rows,
    });
    expect(first.inserted).toBe(3);
    const p1 = await page(s, eventId);

    const second = await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
      eventId,
      rows,
    });
    expect(second).toMatchObject({ inserted: 0, updated: 0, skippedDuplicates: 3 });
    const p2 = await page(s, eventId);
    expect(p2).toMatchObject({
      goingCount: p1!.goingCount,
      maybeCount: p1!.maybeCount,
      notGoingCount: p1!.notGoingCount,
    });
    expect(await rsvps(s, eventId)).toHaveLength(3);
  });

  test("imported rows never get a verification code", async () => {
    const { s, eventId } = await setupPage();
    await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
      eventId,
      rows: [{ name: "Coded?", email: "coded@example.com", status: "going" }],
    });
    const codes = await run(s.t, (ctx) => ctx.db.query("rsvpEmailCodes").collect());
    expect(codes).toHaveLength(0);
  });

  test(">100 rows schedules the remainder", async () => {
    vi.useFakeTimers();
    try {
      const { t, s, eventId } = await setupPage();
      const rows = Array.from({ length: 150 }, (_v, i) => ({
        name: `Guest ${i}`,
        status: "going" as const,
      }));
      const res = await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
        eventId,
        rows,
      });
      expect(res.inserted).toBe(100);
      expect(res.scheduledRemaining).toBe(50);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await rsvps(s, eventId)).toHaveLength(150);
      const p = await page(s, eventId);
      expect(p!.goingCount).toBe(150);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Downstream: admin/public projections + blasts ────────────────────────────

describe("email-less imports downstream", () => {
  test("admin + public projections tolerate null email", async () => {
    const { t, s, eventId, pageId } = await setupPage();
    await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
      eventId,
      rows: [{ name: "No Email Guest", phone: "5551112222", status: "going" }],
    });
    const admin = await s.as.query(api.ticketing.listRsvpsAdmin, { eventId });
    expect(admin[0]).toMatchObject({ name: "No Email Guest", email: null, phone: "5551112222" });

    await s.as.mutation(api.ticketing.updatePage, { pageId, patch: { published: true } });
    const p = await page(s, eventId);
    const pub = await t.query(api.ticketing.getPublicPage, { slug: p!.slug });
    expect(pub?.counts.going).toBe(1);
    expect(pub?.guests[0]).toMatchObject({ name: "No Email Guest", status: "going" });
  });

  test("ticket_holders blast includes wasTicketHolder imports; email-less excluded without crashing", async () => {
    const { s, eventId } = await setupPage();
    await s.as.mutation(api.eventAttendanceImport.commitAttendanceImport, {
      eventId,
      rows: [
        { name: "Buyer", email: "buyer@example.com", wasTicketHolder: true, status: "going" },
        { name: "No Email Buyer", wasTicketHolder: true, phone: "5553334444", status: "going" },
      ],
    });
    const blastId = await run(s.t, (ctx) =>
      ctx.db.insert("blasts", {
        eventId,
        chapterId: s.chapterId,
        channel: "email",
        body: "hi",
        audience: "ticket_holders",
        status: "sending",
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );
    const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
    // Both imported as source:"ticket"; only the one with an email is reachable.
    expect(payload?.emails).toEqual(["buyer@example.com"]);
  });
});
