/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import type { AudienceTargeting } from "../lib/audienceTargeting";

/**
 * Targeting v2 (specs/audience-targeting-v2.md) — the group/condition model
 * (`audiences.targeting`): OR across include groups, AND within a group,
 * per-condition negation, exclude groups, per-group preview counts, and the
 * unchanged consent invariants — evaluated by `lib/audienceTargeting.ts` via
 * the `resolveAudienceRecipients` targeting branch, exposed through
 * `audiences.ts`'s `previewAudience`/`createAudience`/`updateAudience`.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

async function seedPerson(
  s: ChapterSetup,
  opts: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      status: "active",
      createdAt: Date.now(),
      ...opts,
    }),
  );
}

async function seedDonorForPerson(
  s: ChapterSetup,
  personId: Id<"people"> | undefined,
  opts: {
    email: string;
    status: "prospect" | "active" | "lapsed";
    lifetimeCents?: number;
    giftCount?: number;
    lastGiftAt?: number;
    scope?: Id<"chapters"> | "central";
  },
): Promise<Id<"donors">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("donors", {
      scope: opts.scope ?? s.chapterId,
      kind: "individual",
      name: `Donor ${opts.email}`,
      email: opts.email,
      status: opts.status,
      lifetimeCents: opts.lifetimeCents ?? 0,
      giftCount: opts.giftCount ?? 0,
      lastGiftAt: opts.lastGiftAt,
      personId,
      createdAt: Date.now(),
    }),
  );
}

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Night",
      slug: `night-${now}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Night",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedRsvpForPerson(
  s: ChapterSetup,
  personId: Id<"people">,
  eventId: Id<"events">,
  opts: { status?: "going" | "maybe" | "not_going"; createdAt?: number } = {},
): Promise<Id<"rsvps">> {
  const now = opts.createdAt ?? Date.now();
  return run(s.t, (ctx) =>
    ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: "Guest",
      email: `guest-${personId}@example.com`,
      status: opts.status ?? "going",
      token: `tok-${personId}-${eventId}-${Math.random()}`,
      personId,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedSeatFor(
  s: ChapterSetup,
  personId: Id<"people">,
  slug = "test_seat",
): Promise<Id<"seatDefs">> {
  const seatDefId = await run(s.t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug: `${slug}_${personId}`,
      title: "Test Seat",
      chart: "chapter",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities: [],
      sortOrder: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: s.chapterId,
      personId,
      createdAt: Date.now(),
    }),
  );
  return seatDefId;
}

async function previewTargeting(
  s: ChapterSetup,
  targeting: AudienceTargeting,
  args: {
    scope?: Id<"chapters"> | "central";
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
  } = {},
) {
  return s.as.query(api.audiences.previewAudience, {
    scope: args.scope ?? s.chapterId,
    source: "person_filters",
    filters: {},
    targeting,
    includePersonIds: args.includePersonIds,
    excludePersonIds: args.excludePersonIds,
  });
}

async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof ConvexError) return (e.data as { code?: string }).code;
    throw e;
  }
}

// ── OR / AND semantics ─────────────────────────────────────────────────────

describe("targeting — group semantics", () => {
  test("OR across groups: a person matching ANY group is in; per-group counts and sample tags are exact", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await seedEvent(s);

    const donorOnly = await seedPerson(s, { name: "Donor Only", email: "donor@example.com" });
    await seedDonorForPerson(s, donorOnly, { email: "donor@example.com", status: "active" });
    const attendeeOnly = await seedPerson(s, { name: "Attendee", email: "attendee@example.com" });
    await seedRsvpForPerson(s, attendeeOnly, eventId);
    await seedPerson(s, { name: "Neither", email: "neither@example.com" });

    const preview = await previewTargeting(s, {
      groups: [
        { conditions: [{ field: "donor_status", op: "is", status: "any" }] },
        { conditions: [{ field: "attended_event", op: "has", eventId }] },
      ],
    });
    expect(preview.count).toBe(2);
    expect(preview.perGroupCounts).toEqual([1, 1]);
    const byEmail = new Map(preview.sample.map((r) => [r.email, r.groups]));
    expect(byEmail.get("donor@example.com")).toEqual([0]);
    expect(byEmail.get("attendee@example.com")).toEqual([1]);
  });

  test("AND within a group: every condition must hold", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await seedEvent(s);

    const both = await seedPerson(s, { name: "Both", email: "both@example.com" });
    await seedDonorForPerson(s, both, { email: "both@example.com", status: "active" });
    await seedRsvpForPerson(s, both, eventId);
    const donorOnly = await seedPerson(s, { name: "Donor Only", email: "donor@example.com" });
    await seedDonorForPerson(s, donorOnly, { email: "donor@example.com", status: "active" });

    const preview = await previewTargeting(s, {
      groups: [
        {
          conditions: [
            { field: "donor_status", op: "is", status: "any" },
            { field: "attended_event", op: "has", eventId },
          ],
        },
      ],
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["both@example.com"]);
  });

  test("the founder's case: donors who have never attended ANY event", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await seedEvent(s);

    const quietDonor = await seedPerson(s, { name: "Quiet", email: "quiet@example.com" });
    await seedDonorForPerson(s, quietDonor, { email: "quiet@example.com", status: "active" });
    const showedUp = await seedPerson(s, { name: "Showed Up", email: "showed@example.com" });
    await seedDonorForPerson(s, showedUp, { email: "showed@example.com", status: "active" });
    await seedRsvpForPerson(s, showedUp, eventId);
    await seedPerson(s, { name: "Not A Donor", email: "notdonor@example.com" });

    const preview = await previewTargeting(s, {
      groups: [
        {
          conditions: [
            { field: "donor_status", op: "is", status: "any" },
            { field: "attended_any", op: "has_not" },
          ],
        },
      ],
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["quiet@example.com"]);
  });

  test("an empty include group means everyone in scope (roster + contacts; never placeholder/inactive)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedPerson(s, { name: "Roster", email: "roster@example.com" });
    await seedPerson(s, { name: "Contact", email: "contact@example.com", isContactOnly: true });
    await seedPerson(s, { name: "Placeholder", email: "ph@example.com", isPlaceholder: true });
    await seedPerson(s, { name: "Inactive", email: "inactive@example.com", status: "inactive" });

    const preview = await previewTargeting(s, { groups: [{ conditions: [] }] });
    expect(preview.sample.map((r) => r.email).sort()).toEqual([
      "contact@example.com",
      "roster@example.com",
    ]);
  });
});

// ── Per-condition negation ─────────────────────────────────────────────────

describe("targeting — negation as an operator", () => {
  test("donor_status is_not any = non-donors only; is_not active spares other statuses", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const active = await seedPerson(s, { name: "Active", email: "active@example.com" });
    await seedDonorForPerson(s, active, { email: "active@example.com", status: "active" });
    const lapsed = await seedPerson(s, { name: "Lapsed", email: "lapsed@example.com" });
    await seedDonorForPerson(s, lapsed, { email: "lapsed@example.com", status: "lapsed" });
    await seedPerson(s, { name: "Civilian", email: "civilian@example.com" });

    const nonDonors = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "donor_status", op: "is_not", status: "any" }] }],
    });
    expect(nonDonors.sample.map((r) => r.email)).toEqual(["civilian@example.com"]);

    const notActive = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "donor_status", op: "is_not", status: "active" }] }],
    });
    expect(notActive.sample.map((r) => r.email).sort()).toEqual([
      "civilian@example.com",
      "lapsed@example.com",
    ]);
  });

  test("last_gift within/not_within a rolling window (non-donors count as 'hasn't given')", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const now = Date.now();
    const recent = await seedPerson(s, { name: "Recent", email: "recent@example.com" });
    await seedDonorForPerson(s, recent, {
      email: "recent@example.com",
      status: "active",
      lastGiftAt: now - 5 * 24 * 60 * 60 * 1000,
    });
    const stale = await seedPerson(s, { name: "Stale", email: "stale@example.com" });
    await seedDonorForPerson(s, stale, {
      email: "stale@example.com",
      status: "active",
      lastGiftAt: now - 120 * 24 * 60 * 60 * 1000,
    });
    await seedPerson(s, { name: "Never", email: "never@example.com" });

    const within = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "last_gift", op: "within_days", days: 30 }] }],
    });
    expect(within.sample.map((r) => r.email)).toEqual(["recent@example.com"]);

    const notWithin = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "last_gift", op: "not_within_days", days: 30 }] }],
    });
    expect(notWithin.sample.map((r) => r.email).sort()).toEqual([
      "never@example.com",
      "stale@example.com",
    ]);
  });

  test("attended_event has_not a specific event; positives still need a donor row for giving thresholds", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await seedEvent(s);
    const went = await seedPerson(s, { name: "Went", email: "went@example.com" });
    await seedRsvpForPerson(s, went, eventId);
    await seedPerson(s, { name: "Skipped", email: "skipped@example.com" });

    const preview = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "attended_event", op: "has_not", eventId }] }],
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["skipped@example.com"]);

    // `giving_lifetime lte` is a POSITIVE op: it requires BEING a donor (some
    // row ≤ the bound) — a non-donor never matches it (pair with
    // `donor_status is_not any` to say "not a donor").
    const lte = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "giving_lifetime", op: "lte", cents: 10_000 }] }],
    });
    expect(lte.count).toBe(0);
  });

  test("attendance qualifiers are joint on ONE rsvp row (status + event must hold together)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventA = await seedEvent(s);
    const eventB = await seedEvent(s);
    // Went to A as "maybe", to B as "going" — a condition asking for A+going
    // must NOT match by mixing rows.
    const mixer = await seedPerson(s, { name: "Mixer", email: "mixer@example.com" });
    await seedRsvpForPerson(s, mixer, eventA, { status: "maybe" });
    await seedRsvpForPerson(s, mixer, eventB, { status: "going" });
    const clean = await seedPerson(s, { name: "Clean", email: "clean@example.com" });
    await seedRsvpForPerson(s, clean, eventA, { status: "going" });

    const preview = await previewTargeting(s, {
      groups: [
        { conditions: [{ field: "attended_event", op: "has", eventId: eventA, rsvpStatus: "going" }] },
      ],
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["clean@example.com"]);
  });

  test("seat holds / not_holds; kind is contact", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const seated = await seedPerson(s, { name: "Seated", email: "seated@example.com" });
    const seatId = await seedSeatFor(s, seated);
    await seedPerson(s, { name: "Unseated", email: "unseated@example.com" });
    await seedPerson(s, { name: "Contact", email: "contact@example.com", isContactOnly: true });

    const holds = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "seat", op: "holds", seatId }] }],
    });
    expect(holds.sample.map((r) => r.email)).toEqual(["seated@example.com"]);

    const notHolds = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "seat", op: "not_holds", seatId }] }],
    });
    expect(notHolds.sample.map((r) => r.email).sort()).toEqual([
      "contact@example.com",
      "unseated@example.com",
    ]);

    const contacts = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "kind", op: "is", kind: "contact" }] }],
    });
    expect(contacts.sample.map((r) => r.email)).toEqual(["contact@example.com"]);
  });

  test("has_service: case-insensitive exact match, has_not, and no-services-array behavior", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedPerson(s, {
      name: "Audio Volunteer",
      email: "audio@example.com",
      services: ["Audio", "Lighting"],
    });
    await seedPerson(s, {
      name: "Worship Volunteer",
      email: "worship@example.com",
      services: ["worship"],
    });
    await seedPerson(s, { name: "No Services", email: "none@example.com" });

    // Case-insensitive exact match: "  AUDIO  " (mixed case + whitespace)
    // matches a stored "Audio" entry.
    const has = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "has_service", op: "has", service: "  AUDIO  " }] }],
    });
    expect(has.sample.map((r) => r.email)).toEqual(["audio@example.com"]);

    // Non-matching service: nobody has "video".
    const nonMatching = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "has_service", op: "has", service: "video" }] }],
    });
    expect(nonMatching.count).toBe(0);

    // has_not: everyone WITHOUT "audio" — including the person with no
    // `services` array at all (missing data reads as "doesn't have it").
    const hasNot = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "has_service", op: "has_not", service: "audio" }] }],
    });
    expect(hasNot.sample.map((r) => r.email).sort()).toEqual([
      "none@example.com",
      "worship@example.com",
    ]);
  });
});

// ── Exclude groups + hand-picks + consent ──────────────────────────────────

describe("targeting — exclude groups, hand-picks, consent", () => {
  test("an exclude group removes matches AND hand-picked includes; counts surface it", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const donor = await seedPerson(s, { name: "Donor", email: "donor@example.com" });
    await seedDonorForPerson(s, donor, { email: "donor@example.com", status: "active" });
    const staffDonor = await seedPerson(s, { name: "Staff Donor", email: "staff@example.com" });
    await seedDonorForPerson(s, staffDonor, { email: "staff@example.com", status: "active" });
    const seatId = await seedSeatFor(s, staffDonor);
    const handPickedStaff = await seedPerson(s, { name: "Picked Staff", email: "picked@example.com" });
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: seatId,
        scope: s.chapterId,
        personId: handPickedStaff,
        createdAt: Date.now(),
      }),
    );

    const preview = await previewTargeting(
      s,
      {
        groups: [{ conditions: [{ field: "donor_status", op: "is", status: "any" }] }],
        excludeGroups: [{ conditions: [{ field: "seat", op: "holds", seatId }] }],
      },
      { includePersonIds: [handPickedStaff] },
    );
    expect(preview.sample.map((r) => r.email)).toEqual(["donor@example.com"]);
    expect(preview.excludedByFilters).toBe(2);
    expect(preview.handPickedExcludedByFilters).toBe(1);
    expect(preview.perExcludeGroupCounts).toEqual([2]);
  });

  test("has_service inside an exclude group removes matching skip-list members", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const auditor = await seedPerson(s, {
      name: "Vetted Audio",
      email: "vetted-audio@example.com",
      services: ["audio"],
    });
    await seedDonorForPerson(s, auditor, { email: "vetted-audio@example.com", status: "active" });
    const otherDonor = await seedPerson(s, { name: "Other Donor", email: "other@example.com" });
    await seedDonorForPerson(s, otherDonor, { email: "other@example.com", status: "active" });

    const preview = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "donor_status", op: "is", status: "any" }] }],
      excludeGroups: [{ conditions: [{ field: "has_service", op: "has", service: "AUDIO" }] }],
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["other@example.com"]);
    expect(preview.excludedByFilters).toBe(1);
  });

  test("excludePersonIds still beats a group match; opt-out and suppression always win", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const a = await seedPerson(s, { name: "A", email: "a@example.com" });
    await seedDonorForPerson(s, a, { email: "a@example.com", status: "active" });
    const optedOut = await seedPerson(s, {
      name: "Opted Out",
      email: "opted@example.com",
      marketingOptOut: true,
    });
    await seedDonorForPerson(s, optedOut, { email: "opted@example.com", status: "active" });
    const suppressed = await seedPerson(s, { name: "Suppressed", email: "supp@example.com" });
    await seedDonorForPerson(s, suppressed, { email: "supp@example.com", status: "active" });
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "supp@example.com",
        reason: "unsubscribe",
        createdAt: Date.now(),
      }),
    );
    const excluded = await seedPerson(s, { name: "Excluded", email: "x@example.com" });
    await seedDonorForPerson(s, excluded, { email: "x@example.com", status: "active" });

    const preview = await previewTargeting(
      s,
      { groups: [{ conditions: [{ field: "donor_status", op: "is", status: "any" }] }] },
      // Hand-picking the opted-out person must NOT override consent.
      { includePersonIds: [optedOut], excludePersonIds: [excluded] },
    );
    expect(preview.sample.map((r) => r.email)).toEqual(["a@example.com"]);
    expect(preview.excludedOptOut).toBe(1);
    expect(preview.excludedSuppressed).toBe(1);
  });
});

// ── Structural validation ──────────────────────────────────────────────────

describe("targeting — write-time validation", () => {
  test("zero include groups, an empty exclude group, and email_verified in an exclude group are all rejected", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    expect(await errorCode(previewTargeting(s, { groups: [] }))).toBe("EMPTY_TARGETING");
    expect(
      await errorCode(
        previewTargeting(s, {
          groups: [{ conditions: [] }],
          excludeGroups: [{ conditions: [] }],
        }),
      ),
    ).toBe("EMPTY_EXCLUDE_GROUP");
    expect(
      await errorCode(
        previewTargeting(s, {
          groups: [{ conditions: [] }],
          excludeGroups: [{ conditions: [{ field: "email_verified", op: "is" }] }],
        }),
      ),
    ).toBe("INVALID_EXCLUDE_CONDITION");
  });

  test("createAudience validates + normalizes (empty excludeGroups stored as undefined); resolution uses targeting over legacy filters", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const person = await seedPerson(s, { name: "P", email: "p@example.com" });
    await seedDonorForPerson(s, person, { email: "p@example.com", status: "active" });

    const audienceId = await s.as.mutation(api.audiences.createAudience, {
      scope: s.chapterId,
      name: "Donors v2",
      source: "person_filters",
      // Legacy filters say "nobody" (a status no donor here has) — targeting
      // must win.
      filters: { donorStatus: "prospect" },
      targeting: {
        groups: [{ conditions: [{ field: "donor_status", op: "is", status: "any" }] }],
        excludeGroups: [],
      },
    });
    const stored = await s.as.query(api.audiences.getAudience, { audienceId });
    expect(stored.targeting).toEqual({
      groups: [{ conditions: [{ field: "donor_status", op: "is", status: "any" }] }],
    });

    const recipientEmails = await run(s.t, async (ctx) => {
      const { resolveAudienceRecipients } = await import("../lib/audienceResolve");
      const audience = (await ctx.db.get(audienceId))!;
      const resolution = await resolveAudienceRecipients(ctx, audience);
      return resolution.recipients.map((r) => r.email);
    });
    expect(recipientEmails).toEqual(["p@example.com"]);
  });
});

// ── email_verified ─────────────────────────────────────────────────────────

describe("targeting — email_verified", () => {
  test("matches only when the RESOLVED send address itself is verified", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const verified = await seedPerson(s, { name: "Verified", email: "v@example.com" });
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: verified,
        email: "v@example.com",
        verified: true,
        source: "manual",
        addedAt: Date.now(),
      }),
    );
    await seedPerson(s, { name: "Unverified", email: "u@example.com" });

    const preview = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "email_verified", op: "is" }] }],
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["v@example.com"]);
  });
});

// ── explainAudiencePerson ("check a person") ───────────────────────────────

describe("targeting — explainAudiencePerson", () => {
  test("per-condition verdicts + final decision chain match the real resolution", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await seedEvent(s);

    // Ruth: donor, never attended → recipient via group 0.
    const ruth = await seedPerson(s, { name: "Ruth", email: "ruth@example.com" });
    await seedDonorForPerson(s, ruth, { email: "ruth@example.com", status: "active" });
    // Marcus: donor who attended, holds the staff seat → excluded.
    const marcus = await seedPerson(s, { name: "Marcus", email: "marcus@example.com" });
    await seedDonorForPerson(s, marcus, { email: "marcus@example.com", status: "active" });
    await seedRsvpForPerson(s, marcus, eventId);
    const seatId = await seedSeatFor(s, marcus);
    // Dana: matches but opted out → consent wins.
    const dana = await seedPerson(s, {
      name: "Dana",
      email: "dana@example.com",
      marketingOptOut: true,
    });
    await seedDonorForPerson(s, dana, { email: "dana@example.com", status: "lapsed" });

    const targeting: AudienceTargeting = {
      groups: [
        {
          conditions: [
            { field: "donor_status", op: "is", status: "any" },
            { field: "attended_any", op: "has_not" },
          ],
        },
      ],
      excludeGroups: [{ conditions: [{ field: "seat", op: "holds", seatId }] }],
    };
    const explain = (personId: Id<"people">) =>
      s.as.query(api.audiences.explainAudiencePerson, {
        scope: s.chapterId,
        targeting,
        personId,
      });

    const ruthOut = await explain(ruth);
    expect(ruthOut.verdict).toBe("recipient");
    expect(ruthOut.groups[0].matched).toBe(true);
    expect(ruthOut.groups[0].conditions.map((c) => c.pass)).toEqual([true, true]);
    expect(ruthOut.excludeGroups[0].matched).toBe(false);

    const marcusOut = await explain(marcus);
    // Fails group 0 on the attendance negation, but the staff exclude group
    // is what the verdict chain reports once nothing includes him — with a
    // hand-pick he'd be excluded: verify precedence via includePersonIds.
    expect(marcusOut.verdict).toBe("no_match");
    expect(marcusOut.groups[0].conditions.map((c) => c.pass)).toEqual([true, false]);
    const marcusPicked = await s.as.query(api.audiences.explainAudiencePerson, {
      scope: s.chapterId,
      targeting,
      includePersonIds: [marcus],
      personId: marcus,
    });
    expect(marcusPicked.verdict).toBe("excluded");
    expect(marcusPicked.handPicked).toBe(true);
    expect(marcusPicked.excludeGroups[0].matched).toBe(true);

    const danaOut = await explain(dana);
    expect(danaOut.verdict).toBe("opted_out");
    expect(danaOut.groups[0].matched).toBe(true);
  });
});

// ── Central-donor fallback (spec §3.4 / #424 finding A) ────────────────────

describe("targeting — central-donor fallback", () => {
  test("an unlinked central donor is admitted only by a group with a donor-derived condition; person-linked negations read as true; excludes reach it", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedDonorForPerson(s, undefined, {
      email: "central@example.com",
      status: "active",
      lifetimeCents: 500_000,
      scope: "central",
    });

    // Group with a donor condition (+ a person-linked negation, true for the
    // fallback row) admits it.
    const admitted = await previewTargeting(
      s,
      {
        groups: [
          {
            conditions: [
              { field: "donor_status", op: "is", status: "any" },
              { field: "attended_any", op: "has_not" },
            ],
          },
        ],
      },
      { scope: "central" },
    );
    expect(admitted.sample.map((r) => r.email)).toEqual(["central@example.com"]);
    expect(admitted.unlinkedCentralDonors).toBe(1);

    // A donor condition the row fails keeps it out.
    const tooRich = await previewTargeting(
      s,
      { groups: [{ conditions: [{ field: "giving_lifetime", op: "gte", cents: 1_000_000 }] }] },
      { scope: "central" },
    );
    expect(tooRich.count).toBe(0);

    // "Everyone" / negation-only groups do NOT sweep the central donor file in.
    const everyone = await previewTargeting(
      s,
      { groups: [{ conditions: [] }] },
      { scope: "central" },
    );
    expect(everyone.count).toBe(0);
    const negationOnly = await previewTargeting(
      s,
      { groups: [{ conditions: [{ field: "attended_any", op: "has_not" }] }] },
      { scope: "central" },
    );
    expect(negationOnly.count).toBe(0);

    // An exclude group reaches the fallback row — including via a
    // person-linked negation ("never attended" IS true of it).
    const excluded = await previewTargeting(
      s,
      {
        groups: [{ conditions: [{ field: "donor_status", op: "is", status: "any" }] }],
        excludeGroups: [{ conditions: [{ field: "attended_any", op: "has_not" }] }],
      },
      { scope: "central" },
    );
    expect(excluded.count).toBe(0);
    expect(excluded.excludedByFilters).toBe(1);
  });

  test("has_service against a central-donor fallback row: never admits (not donor-derived), 'has' always false, 'has_not' always true — same reading as attended_*", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedDonorForPerson(s, undefined, {
      email: "central-service@example.com",
      status: "active",
      scope: "central",
    });

    // A group carrying ONLY has_service has no donor-derived condition, so it
    // can never admit an unlinked donor row — even `has_not`, which reads
    // TRUE for it (the "everyone"/negation-only-group gate, same rule as
    // attended_any has_not above).
    const serviceOnly = await previewTargeting(
      s,
      { groups: [{ conditions: [{ field: "has_service", op: "has_not", service: "audio" }] }] },
      { scope: "central" },
    );
    expect(serviceOnly.count).toBe(0);

    // Paired with a donor-derived condition in the SAME group, has_service
    // "has" is false for the row (donor rows have no `services`) so it keeps
    // the row out even though the donor condition alone would admit it.
    const hasBlocksIt = await previewTargeting(
      s,
      {
        groups: [
          {
            conditions: [
              { field: "donor_status", op: "is", status: "any" },
              { field: "has_service", op: "has", service: "audio" },
            ],
          },
        ],
      },
      { scope: "central" },
    );
    expect(hasBlocksIt.count).toBe(0);

    // ...while has_not is true for it, so the group still admits the row.
    const hasNotAdmits = await previewTargeting(
      s,
      {
        groups: [
          {
            conditions: [
              { field: "donor_status", op: "is", status: "any" },
              { field: "has_service", op: "has_not", service: "audio" },
            ],
          },
        ],
      },
      { scope: "central" },
    );
    expect(hasNotAdmits.sample.map((r) => r.email)).toEqual(["central-service@example.com"]);

    // An exclude group reaches the fallback row via the same has_not-is-true
    // reading (uniform include/exclude rule, no conservative-stay case).
    const excluded = await previewTargeting(
      s,
      {
        groups: [{ conditions: [{ field: "donor_status", op: "is", status: "any" }] }],
        excludeGroups: [{ conditions: [{ field: "has_service", op: "has_not", service: "audio" }] }],
      },
      { scope: "central" },
    );
    expect(excluded.count).toBe(0);
    expect(excluded.excludedByFilters).toBe(1);
  });
});
