/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { linkDonorToPerson } from "../lib/givingDonors";
import { linkRsvpToPerson } from "../lib/rsvpPeople";
import { recordPersonEmail, resolveSendAddress } from "../lib/personEmails";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Person-centric audiences Phase 2 (specs/person-centric-audiences.md Phase 2
 * items 1/2) — `personEmails` write-through (`lib/personEmails.ts#recordPersonEmail`,
 * wired into `people.ts`'s create/update, `linkDonorToPerson`, and
 * `linkRsvpToPerson`), `setPrimaryEmail`, and the pure `resolveSendAddress`
 * precedence helper.
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: `worship-night-${now}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: `Event ${now}`,
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function personEmailsFor(s: ChapterSetup, personId: Id<"people">): Promise<Doc<"personEmails">[]> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect(),
  );
}

// ── write-through: people.create / people.update ────────────────────────────

describe("personEmails write-through — people.create/update", () => {
  test("create seeds roster + pw rows; update adds/upgrades", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const personId = (await s.as.mutation(api.people.create, {
      name: "Amy Roster",
      email: "Amy@Example.com",
      pwEmail: "amy@publicworship.life",
    })) as Id<"people">;

    let rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(2);
    const roster = rows.find((r) => r.source === "roster");
    const pw = rows.find((r) => r.source === "pw");
    expect(roster).toMatchObject({ email: "amy@example.com", verified: true });
    expect(pw).toMatchObject({ email: "amy@publicworship.life", verified: true });

    // Updating to a NEW email adds a second roster row alongside the first —
    // the ledger accrues, it never overwrites/drops a previously known address.
    await s.as.mutation(api.people.update, {
      personId,
      email: "amy2@example.com",
    });
    rows = await personEmailsFor(s, personId);
    expect(rows.filter((r) => r.source === "roster").map((r) => r.email).sort()).toEqual([
      "amy2@example.com",
      "amy@example.com",
    ]);

    // Re-saving the SAME email is a no-op on the ledger (no duplicate row).
    await s.as.mutation(api.people.update, { personId, email: "amy2@example.com" });
    rows = await personEmailsFor(s, personId);
    expect(rows.filter((r) => r.source === "roster")).toHaveLength(2);
  });
});

// ── write-through: linkDonorToPerson ────────────────────────────────────────

describe("personEmails write-through — linkDonorToPerson", () => {
  test("a fresh donor link records a 'donor' source row, verified", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Dana Donor",
        email: "Dana@Example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    const donor = (await run(s.t, (ctx) => ctx.db.get(donorId)))!;
    const personId = await run(s.t, (ctx) => linkDonorToPerson(ctx, donor));
    expect(personId).toBeTruthy();

    const rows = await personEmailsFor(s, personId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "dana@example.com", source: "donor", verified: true });
  });

  test("matching an EXISTING roster person still records the donor's email", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Ray Roster",
        email: "ray@example.com",
        createdAt: Date.now(),
      }),
    );
    // A donor with a DIFFERENT email than the roster row's, matched by name.
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Ray Roster",
        email: "ray-donor-inbox@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    const donor = (await run(s.t, (ctx) => ctx.db.get(donorId)))!;
    const linkedId = await run(s.t, (ctx) => linkDonorToPerson(ctx, donor));
    expect(linkedId).toBe(personId);

    const rows = await personEmailsFor(s, personId);
    expect(rows.map((r) => r.email).sort()).toEqual(["ray-donor-inbox@example.com"]);
  });
});

// ── write-through: linkRsvpToPerson ─────────────────────────────────────────

describe("personEmails write-through — linkRsvpToPerson", () => {
  test("a verified rsvp records a verified 'rsvp' source row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const rsvpId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Gia Guest",
        email: "gia@example.com",
        status: "going",
        token: "tok-verified",
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const personId = await run(s.t, (ctx) =>
      linkRsvpToPerson(ctx, { rsvpId, chapterId: s.chapterId, name: "Gia Guest", email: "gia@example.com" }),
    );
    const rows = await personEmailsFor(s, personId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "gia@example.com", source: "rsvp", verified: true });
  });

  test("emailVerified: false records an UNVERIFIED 'rsvp' row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const rsvpId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Pending Guest",
        email: "pending@example.com",
        status: "going",
        token: "tok-pending",
        emailVerified: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const personId = await run(s.t, (ctx) =>
      linkRsvpToPerson(ctx, { rsvpId, chapterId: s.chapterId, name: "Pending Guest", email: "pending@example.com" }),
    );
    const rows = await personEmailsFor(s, personId!);
    expect(rows[0]).toMatchObject({ verified: false });
  });

  test("emailVerified: undefined (legacy/imported) reads as verified", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const rsvpId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Imported Guest",
        email: "imported@example.com",
        status: "going",
        token: "tok-imported",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const personId = await run(s.t, (ctx) =>
      linkRsvpToPerson(ctx, { rsvpId, chapterId: s.chapterId, name: "Imported Guest", email: "imported@example.com" }),
    );
    const rows = await personEmailsFor(s, personId!);
    expect(rows[0]).toMatchObject({ verified: true });
  });
});

// ── recordPersonEmail: upgrade-only ─────────────────────────────────────────

describe("recordPersonEmail — upgrade-only write-through", () => {
  test("a later verified observation upgrades an unverified row in place", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Upgrade Test", createdAt: Date.now() }),
    );
    await run(s.t, (ctx) =>
      recordPersonEmail(ctx, { personId, email: "x@example.com", source: "rsvp", verified: false }),
    );
    await run(s.t, (ctx) =>
      recordPersonEmail(ctx, { personId, email: "x@example.com", source: "rsvp", verified: true }),
    );
    const rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].verified).toBe(true);
  });

  test("a higher-trust source relabels an existing row; a lower-trust one does NOT downgrade it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Trust Test", createdAt: Date.now() }),
    );
    await run(s.t, (ctx) =>
      recordPersonEmail(ctx, { personId, email: "shared@example.com", source: "rsvp", verified: true }),
    );
    await run(s.t, (ctx) =>
      recordPersonEmail(ctx, { personId, email: "shared@example.com", source: "roster", verified: true }),
    );
    let rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("roster"); // roster (3) > rsvp (1)

    // A later donor observation (rank 2) must NOT downgrade the roster (3) label.
    await run(s.t, (ctx) =>
      recordPersonEmail(ctx, { personId, email: "shared@example.com", source: "donor", verified: true }),
    );
    rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("roster");
  });

  test("no-op on a blank/absent email", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Blank Test", createdAt: Date.now() }),
    );
    await run(s.t, (ctx) => recordPersonEmail(ctx, { personId, email: undefined, source: "roster", verified: true }));
    await run(s.t, (ctx) => recordPersonEmail(ctx, { personId, email: "  ", source: "roster", verified: true }));
    expect(await personEmailsFor(s, personId)).toHaveLength(0);
  });
});

// ── setPrimaryEmail ──────────────────────────────────────────────────────────

describe("personEmails.setPrimaryEmail", () => {
  test("marks one row primary, clearing any prior primary for the same person", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = (await s.as.mutation(api.people.create, {
      name: "Prima Ry",
      email: "prima@example.com",
      pwEmail: "prima@publicworship.life",
    })) as Id<"people">;
    const rows = await personEmailsFor(s, personId);
    const roster = rows.find((r) => r.source === "roster")!;
    const pw = rows.find((r) => r.source === "pw")!;

    await s.as.mutation(api.personEmails.setPrimaryEmail, { personEmailId: roster._id });
    let after = await personEmailsFor(s, personId);
    expect(after.find((r) => r._id === roster._id)?.isPrimary).toBe(true);
    expect(after.find((r) => r._id === pw._id)?.isPrimary).toBeUndefined();

    await s.as.mutation(api.personEmails.setPrimaryEmail, { personEmailId: pw._id });
    after = await personEmailsFor(s, personId);
    expect(after.find((r) => r._id === roster._id)?.isPrimary).toBeUndefined();
    expect(after.find((r) => r._id === pw._id)?.isPrimary).toBe(true);
  });

  test("gated like people.update — a caller outside the chapter is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = (await s.as.mutation(api.people.create, {
      name: "Outsider Target",
      email: "outsider-target@example.com",
    })) as Id<"people">;
    const rows = await personEmailsFor(s, personId);

    const other = await setupChapter(t, { email: "other@publicworship.life" });
    await expect(
      other.as.mutation(api.personEmails.setPrimaryEmail, { personEmailId: rows[0]._id }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── resolveSendAddress precedence matrix ────────────────────────────────────

describe("resolveSendAddress", () => {
  const person = (
    fields: Partial<Pick<Doc<"people">, "email" | "pwEmail">> = {},
  ): Pick<Doc<"people">, "email" | "pwEmail"> => ({
    email: undefined,
    pwEmail: undefined,
    ...fields,
  });

  const emailRow = (fields: Partial<Doc<"personEmails">>): Doc<"personEmails"> =>
    ({
      _id: "row" as Id<"personEmails">,
      _creationTime: 0,
      personId: "p" as Id<"people">,
      email: "row@example.com",
      source: "rsvp",
      verified: true,
      addedAt: 0,
      ...fields,
    }) as Doc<"personEmails">;

  test("explicit isPrimary wins over everything, including pwEmail", () => {
    const p = person({ pwEmail: "pw@publicworship.life", email: "roster@example.com" });
    const rows = [emailRow({ email: "primary@example.com", isPrimary: true })];
    expect(resolveSendAddress(p, rows)).toBe("primary@example.com");
  });

  test("pwEmail wins over email and any verified personEmails row", () => {
    const p = person({ pwEmail: "pw@publicworship.life", email: "roster@example.com" });
    const rows = [emailRow({ email: "verified@example.com", verified: true, addedAt: 999 })];
    expect(resolveSendAddress(p, rows)).toBe("pw@publicworship.life");
  });

  test("email wins when there's no pwEmail/isPrimary", () => {
    const p = person({ email: "roster@example.com" });
    const rows = [emailRow({ email: "verified@example.com", verified: true, addedAt: 999 })];
    expect(resolveSendAddress(p, rows)).toBe("roster@example.com");
  });

  test("most-recently-added VERIFIED row wins with no pwEmail/email/isPrimary", () => {
    const p = person();
    const rows = [
      emailRow({ email: "older@example.com", verified: true, addedAt: 100 }),
      emailRow({ email: "newer@example.com", verified: true, addedAt: 200 }),
      emailRow({ email: "unverified@example.com", verified: false, addedAt: 300 }),
    ];
    expect(resolveSendAddress(p, rows)).toBe("newer@example.com");
  });

  test("null when there is nothing usable", () => {
    expect(resolveSendAddress(person(), [])).toBeNull();
    expect(resolveSendAddress(person(), [emailRow({ verified: false })])).toBeNull();
  });
});
